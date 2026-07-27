"""Shared Ollama generation gateway and user-safe failure contract."""

from __future__ import annotations

import json
import socket
import subprocess
import urllib.error
import urllib.request
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
    "model_missing": "사용할 요약 모델을 찾지 못했습니다. 설정에서 모델을 준비한 뒤 다시 시도해 주세요.",
    "request_timeout": "정리 시간이 초과되었습니다. 기존 대화록과 정리 결과는 보존되었습니다. 잠시 후 다시 시도해 주세요.",
    "invalid_model_response": "정리 결과 형식을 확인하지 못했습니다. 기존 결과는 보존되었습니다. 다시 시도해 주세요.",
    "generation_cancelled": "정리를 취소했습니다. 기존 결과는 보존되었습니다.",
    "generation_disabled": "정리 기능이 꺼져 있습니다. 설정에서 정리 기능을 켠 뒤 다시 시도해 주세요.",
    "generation_internal_error": "정리 중 내부 오류가 발생했습니다. 기존 대화록과 정리 결과는 보존되었습니다. 다시 시도해 주세요.",
}


@dataclass(frozen=True)
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
    if code in {"server_unreachable", "request_timeout", "invalid_model_response"}:
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


def _ensure_runtime() -> None:
    if not ollama_executable_available():
        raise failure_for_code("runtime_missing")
    if not ensure_ollama_server_running(timeout_seconds=15):
        raise failure_for_code("server_unreachable")


def _generate_with_http(model_name: str, prompt: str) -> str:
    _ensure_runtime()
    payload = json.dumps({
        "model": model_name,
        "prompt": prompt,
        "stream": False,
        "format": "json",
    }).encode("utf-8")
    request = urllib.request.Request(
        f"{get_ollama_base_url()}/api/generate",
        data=payload,
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=600) as response:
        data = json.loads(response.read().decode("utf-8"))
    result = data.get("response", "")
    if not isinstance(result, str) or not result.strip():
        raise failure_for_code("invalid_model_response")
    return result


def _is_connection_refused(error: urllib.error.URLError) -> bool:
    reason = getattr(error, "reason", None)
    return isinstance(reason, ConnectionRefusedError) or getattr(reason, "errno", None) in {61, 10061}


def _generate_with_cli(model_name: str, prompt: str) -> str:
    _ensure_runtime()
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
            if not _is_connection_refused(error):
                raise
            result_text = _generate_with_cli(model_name, prompt)
        return result_text
    except Exception as error:
        raise classify_generation_exception(error) from error
