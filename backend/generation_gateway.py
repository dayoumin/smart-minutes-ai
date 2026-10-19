"""Shared Ollama generation gateway and user-safe failure contract."""

from __future__ import annotations

import json
import logging
import socket
import subprocess
import time
import urllib.error
import urllib.request
from contextlib import contextmanager
from contextvars import ContextVar
from dataclasses import dataclass

from ollama_utils import (
    ensure_ollama_server_running,
    find_ollama_executable,
    get_ollama_base_url,
    ollama_executable_available,
    ollama_subprocess_env,
)
from process_utils import run_hidden


GENERATION_ERROR_MESSAGES = {
    "runtime_missing": "요약 프로그램을 찾지 못했습니다. 설정에서 요약 프로그램을 준비한 뒤 다시 시도해 주세요.",
    "server_unreachable": "요약 프로그램에 연결하지 못했습니다. 프로그램을 다시 실행한 뒤 다시 시도해 주세요.",
    "runtime_preparing": "요약 프로그램을 준비하고 있습니다. 잠시 후 다시 시도해 주세요.",
    "model_missing": "사용할 요약 모델을 찾지 못했습니다. 설정에서 모델을 준비한 뒤 다시 시도해 주세요.",
    "request_timeout": "정리 시간이 초과되었습니다. 기존 대화록과 정리 결과는 보존되었습니다. 잠시 후 다시 시도해 주세요.",
    "invalid_model_response": "정리 결과 형식을 확인하지 못했습니다. 기존 결과는 보존되었습니다. 다시 시도해 주세요.",
    "generation_cancelled": "정리를 취소했습니다. 기존 결과는 보존되었습니다.",
    "generation_disabled": "정리 기능이 꺼져 있습니다. 설정에서 정리 기능을 켠 뒤 다시 시도해 주세요.",
    "generation_internal_error": "정리 중 내부 오류가 발생했습니다. 기존 대화록과 정리 결과는 보존되었습니다. 다시 시도해 주세요.",
}


@dataclass
class GenerationFailure(RuntimeError):
    code: str
    retryable: bool
    user_action: str

    @property
    def user_message(self) -> str:
        return GENERATION_ERROR_MESSAGES[self.code]

    @property
    def http_status(self) -> int:
        return {
            "runtime_missing": 503,
            "server_unreachable": 503,
            "runtime_preparing": 503,
            "model_missing": 409,
            "request_timeout": 504,
            "invalid_model_response": 502,
            "generation_cancelled": 409,
            "generation_disabled": 409,
            "generation_internal_error": 500,
        }.get(self.code, 500)

    def as_detail(self, generation_kind: str) -> dict:
        return {
            "code": self.code,
            "message": self.user_message,
            "retryable": self.retryable,
            "user_action": self.user_action,
            "generation_kind": generation_kind,
        }


def failure_for_code(code: str) -> GenerationFailure:
    if code == "runtime_missing":
        return GenerationFailure(code, False, "open_settings")
    if code == "model_missing":
        return GenerationFailure(code, False, "open_settings")
    if code == "generation_disabled":
        return GenerationFailure(code, False, "open_settings")
    if code in {"server_unreachable", "runtime_preparing", "request_timeout", "invalid_model_response"}:
        return GenerationFailure(code, True, "retry")
    if code == "generation_cancelled":
        return GenerationFailure(code, True, "retry")
    return GenerationFailure("generation_internal_error", True, "retry")


def classify_generation_exception(error: BaseException) -> GenerationFailure:
    if isinstance(error, GenerationFailure):
        return error
    if isinstance(error, FileNotFoundError):
        return failure_for_code("runtime_missing")
    if isinstance(error, json.JSONDecodeError):
        return failure_for_code("invalid_model_response")
    if isinstance(error, (TimeoutError, socket.timeout, subprocess.TimeoutExpired)):
        return failure_for_code("request_timeout")
    if isinstance(error, urllib.error.HTTPError):
        if error.code == 404:
            return failure_for_code("model_missing")
        if error.code in {408, 504}:
            return failure_for_code("request_timeout")
        if error.code in {502, 503}:
            return failure_for_code("server_unreachable")
        return failure_for_code("generation_internal_error")
    if isinstance(error, (urllib.error.URLError, ConnectionError)):
        reason = getattr(error, "reason", None)
        if isinstance(reason, (TimeoutError, socket.timeout)):
            return failure_for_code("request_timeout")
        return failure_for_code("server_unreachable")
    if isinstance(error, subprocess.CalledProcessError):
        output = f"{error.stdout or ''}\n{error.stderr or ''}".lower()
        if "model" in output and ("not found" in output or "missing" in output):
            return failure_for_code("model_missing")
        if "ollama" in output and ("not found" in output or "cannot find" in output):
            return failure_for_code("runtime_missing")
        if any(marker in output for marker in ("connection refused", "could not connect", "cannot connect")):
            return failure_for_code("server_unreachable")
    return failure_for_code("generation_internal_error")


_PREPARED_OLLAMA_MODEL: ContextVar[str] = ContextVar("prepared_ollama_model", default="")
_GENERATION_HTTP_TRANSPORT: ContextVar[object | None] = ContextVar("generation_http_transport", default=None)
_GENERATION_RESPONSE_SCHEMA: ContextVar[dict | None] = ContextVar("generation_response_schema", default=None)


@contextmanager
def generation_response_schema(schema: dict):
    """Constrain only this structured extraction, preserving ordinary requests."""
    token = _GENERATION_RESPONSE_SCHEMA.set(schema)
    try:
        yield
    finally:
        _GENERATION_RESPONSE_SCHEMA.reset(token)


@contextmanager
def generation_http_transport(open_request):
    """Scope an explicit transport to a diagnostic operation, never the app globally."""
    token = _GENERATION_HTTP_TRANSPORT.set(open_request)
    try:
        yield
    finally:
        _GENERATION_HTTP_TRANSPORT.reset(token)


@contextmanager
def prepared_ollama_runtime(model_name: str):
    """Reuse this operation's preparation without changing other requests or models."""
    token = _PREPARED_OLLAMA_MODEL.set(model_name)
    try:
        yield
    finally:
        _PREPARED_OLLAMA_MODEL.reset(token)


def _ensure_runtime(model_name: str = "") -> None:
    if model_name and _PREPARED_OLLAMA_MODEL.get() == model_name:
        return
    if not ollama_executable_available():
        raise failure_for_code("runtime_missing")
    if not ensure_ollama_server_running(timeout_seconds=15):
        raise failure_for_code("server_unreachable")


def _generate_with_http(model_name: str, prompt: str) -> str:
    _ensure_runtime(model_name)
    payload = json.dumps({
        "model": model_name,
        "prompt": prompt,
        "stream": False,
        "format": _GENERATION_RESPONSE_SCHEMA.get() or "json",
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{get_ollama_base_url()}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    started = time.monotonic()
    logging.info("Ollama generation request begin")
    try:
        open_request = _GENERATION_HTTP_TRANSPORT.get() or urllib.request.urlopen
        with open_request(request, timeout=600) as response:
            data = json.loads(response.read().decode("utf-8"))
        result = data.get("response", "") if isinstance(data, dict) else ""
        if not isinstance(result, str) or not result.strip():
            raise failure_for_code("invalid_model_response")
    except Exception as error:
        logging.info(
            "Ollama generation request end status=failed code=%s elapsed_seconds=%.3f",
            classify_generation_exception(error).code,
            time.monotonic() - started,
        )
        raise
    durations = {
        key: value if type(value) is int and value >= 0 else None
        for key in ("load_duration", "prompt_eval_duration", "eval_duration")
        for value in (data.get(key),)
    }
    logging.info(
        "Ollama generation request end status=completed elapsed_seconds=%.3f "
        "load_duration_ns=%s prompt_eval_duration_ns=%s eval_duration_ns=%s",
        time.monotonic() - started,
        durations["load_duration"], durations["prompt_eval_duration"], durations["eval_duration"],
    )
    return result


def _is_connection_refused(error: urllib.error.URLError) -> bool:
    reason = getattr(error, "reason", None)
    return isinstance(reason, ConnectionRefusedError) or getattr(reason, "errno", None) in {61, 10061}


def _generate_with_cli(model_name: str, prompt: str) -> str:
    _ensure_runtime(model_name)
    executable = find_ollama_executable()
    if not executable:
        raise failure_for_code("runtime_missing")
    response = run_hidden(
        [executable, "run", model_name],
        input=prompt,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        env=ollama_subprocess_env(),
        timeout=600,
    )
    if not response.stdout.strip():
        raise failure_for_code("invalid_model_response")
    return response.stdout


def generate_ollama_text(model_name: str, prompt: str) -> str:
    """Generate once, using CLI only when HTTP was definitely connection-refused."""
    try:
        try:
            result_text = _generate_with_http(model_name, prompt)
        except urllib.error.URLError as error:
            if not _is_connection_refused(error) or _PREPARED_OLLAMA_MODEL.get() == model_name:
                raise
            result_text = _generate_with_cli(model_name, prompt)
        return result_text
    except Exception as error:
        raise classify_generation_exception(error) from error
