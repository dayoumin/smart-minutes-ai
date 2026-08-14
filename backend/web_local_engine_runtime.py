from __future__ import annotations

import ctypes
import hashlib
import json
import logging
import os
import threading
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, MutableMapping

from local_engine_security import parse_exact_origins


PRODUCT_DIR_NAME = "Barorok"
ENGINE_DIR_NAME = "LocalEngine"
PAIRING_ARM_TTL_SECONDS = 2 * 60
PAIRING_ARM_FORMAT = 1
ENGINE_SETTINGS_FORMAT = 1
WINDOWS_MUTEX_ALREADY_EXISTS = 183
WINDOWS_ERROR_FILE_NOT_FOUND = 2
WINDOWS_EVENT_MODIFY_STATE = 0x0002
WINDOWS_WAIT_OBJECT_0 = 0
WINDOWS_WAIT_TIMEOUT = 258
WINDOWS_INFINITE = 0xFFFFFFFF


@dataclass(frozen=True)
class WebLocalEngineLayout:
    install_root: Path
    data_root: Path
    engine_dir: Path
    defaults_dir: Path
    config_dir: Path
    config_path: Path
    models_dir: Path
    database_dir: Path
    results_dir: Path
    temp_dir: Path
    logs_dir: Path
    runtime_dir: Path
    pairing_arm_path: Path


def _resolved_path(value: str | os.PathLike[str]) -> Path:
    return Path(value).expanduser().resolve()


def _is_same_or_child(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def resolve_web_local_engine_layout(
    *,
    local_app_data: str | os.PathLike[str] | None = None,
    install_root: str | os.PathLike[str] | None = None,
    data_root: str | os.PathLike[str] | None = None,
) -> WebLocalEngineLayout:
    local_root_value = local_app_data or os.environ.get("LOCALAPPDATA")
    if not local_root_value:
        raise RuntimeError("LOCALAPPDATA is required for the Windows local engine")
    local_root = _resolved_path(local_root_value)

    resolved_install_root = _resolved_path(
        install_root
        or local_root / "Programs" / PRODUCT_DIR_NAME / ENGINE_DIR_NAME
    )
    resolved_data_root = _resolved_path(
        data_root
        or local_root / PRODUCT_DIR_NAME / ENGINE_DIR_NAME
    )
    if (
        resolved_install_root == resolved_data_root
        or _is_same_or_child(resolved_install_root, resolved_data_root)
        or _is_same_or_child(resolved_data_root, resolved_install_root)
    ):
        raise ValueError("Program files and user data must use separate directory trees")

    config_dir = resolved_data_root / "config"
    runtime_dir = resolved_data_root / "runtime"
    return WebLocalEngineLayout(
        install_root=resolved_install_root,
        data_root=resolved_data_root,
        engine_dir=resolved_install_root / "engine",
        defaults_dir=resolved_install_root / "defaults",
        config_dir=config_dir,
        config_path=config_dir / "config.json",
        models_dir=resolved_data_root / "models",
        database_dir=resolved_data_root / "database",
        results_dir=resolved_data_root / "results",
        temp_dir=resolved_data_root / "temp",
        logs_dir=resolved_data_root / "logs",
        runtime_dir=runtime_dir,
        pairing_arm_path=runtime_dir / "pairing-arm.json",
    )


def _write_json_atomic(path: Path, payload: Mapping[str, object]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary_path = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        temporary_path.write_text(
            json.dumps(payload, ensure_ascii=False, indent=2) + "\n",
            encoding="utf-8",
        )
        os.replace(temporary_path, path)
    finally:
        temporary_path.unlink(missing_ok=True)


def _read_config(path: Path) -> dict:
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except FileNotFoundError as exc:
        raise RuntimeError(f"Default local-engine config is missing: {path}") from exc
    except json.JSONDecodeError as exc:
        raise RuntimeError(f"Local-engine config is not valid JSON: {path}") from exc
    if not isinstance(payload, dict):
        raise RuntimeError(f"Local-engine config must be a JSON object: {path}")
    return payload


def _initial_user_config(default_config: dict, layout: WebLocalEngineLayout) -> dict:
    config = json.loads(json.dumps(default_config))
    paths = config.setdefault("paths", {})
    paths.update({
        "ffmpeg": str(layout.engine_dir / "ffmpeg.exe"),
        "stt_model": str(layout.models_dir / "faster-whisper-large-v3"),
        "diarization_model": str(layout.models_dir),
        "llm_model": str(layout.models_dir / "llm" / "gemma.gguf"),
        "output_dir": str(layout.results_dir),
        "temp_dir": str(layout.temp_dir),
        "log_dir": str(layout.logs_dir),
    })
    export_templates = config.setdefault("export_templates", {})
    export_templates.update({
        "hwpx_template_path": str(layout.engine_dir / "templates" / "default_meeting.hwpx"),
        "docx_template_path": str(layout.engine_dir / "templates" / "default_meeting.docx"),
    })
    return config


def prepare_web_local_engine_data(
    layout: WebLocalEngineLayout,
    *,
    default_config_path: str | os.PathLike[str] | None = None,
) -> bool:
    for directory in (
        layout.config_dir,
        layout.models_dir,
        layout.database_dir,
        layout.results_dir,
        layout.temp_dir,
        layout.logs_dir,
        layout.runtime_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)

    if layout.config_path.exists():
        _read_config(layout.config_path)
        return False

    source_path = _resolved_path(default_config_path or layout.defaults_dir / "config.json")
    default_config = _read_config(source_path)
    _write_json_atomic(layout.config_path, _initial_user_config(default_config, layout))
    return True


def validate_production_web_origin(origin: str) -> str:
    normalized = parse_exact_origins(origin, include_development_defaults=False)
    if (
        len(normalized) != 1
        or not normalized[0].startswith("https://")
        or "*" in normalized[0]
    ):
        raise ValueError("The standalone web local engine requires one exact HTTPS origin")
    return normalized[0]


def build_web_local_engine_environment(
    layout: WebLocalEngineLayout,
    *,
    origin: str,
    engine_version: str,
) -> dict[str, str]:
    normalized_origin = validate_production_web_origin(origin)
    normalized_version = engine_version.strip()
    if not normalized_version:
        raise ValueError("Engine version is required")
    return {
        "MEETING_AI_BACKEND_DIR": str(layout.config_dir),
        "ANALYSIS_MODE": "real",
        "LMO_RUNTIME_PROFILE": "production",
        "LMO_API_AUTH_ENFORCEMENT": "enabled",
        "LMO_WEB_ALLOWED_ORIGINS": normalized_origin,
        "LMO_ENGINE_VERSION": normalized_version,
        "LMO_LOCAL_OLLAMA_RUNTIME_DIR": str(layout.runtime_dir / "ollama"),
        "LMO_LOCAL_OLLAMA_MODELS_DIR": str(layout.models_dir / "ollama"),
        "LMO_EMBEDDED_OLLAMA_DIR": str(layout.runtime_dir / "ollama"),
        "LMO_EMBEDDED_OLLAMA_MODELS": str(layout.models_dir / "ollama"),
        "OLLAMA_MODELS": str(layout.models_dir / "ollama"),
    }


def apply_web_local_engine_environment(
    environment: Mapping[str, str],
    *,
    target: MutableMapping[str, str] = os.environ,
) -> None:
    target.pop("LMO_DESKTOP_ACTION_TOKEN", None)
    target.update(environment)


def load_web_local_engine_settings(
    layout: WebLocalEngineLayout,
    *,
    settings_path: str | os.PathLike[str] | None = None,
) -> tuple[str, str]:
    path = _resolved_path(settings_path or layout.defaults_dir / "engine-settings.json")
    payload = _read_config(path)
    if payload.get("format") != ENGINE_SETTINGS_FORMAT:
        raise RuntimeError("Unsupported local-engine settings format")
    origin = validate_production_web_origin(str(payload.get("allowed_origin") or ""))
    engine_version = str(payload.get("engine_version") or "").strip()
    if not engine_version:
        raise RuntimeError("Local-engine settings must include engine_version")
    return origin, engine_version


def pairing_mutex_name(layout: WebLocalEngineLayout) -> str:
    identity = str(layout.data_root).casefold().encode("utf-8")
    suffix = hashlib.sha256(identity).hexdigest()[:16]
    return f"Local\\BarorokLocalEngine-{suffix}"


def engine_stop_event_name(layout: WebLocalEngineLayout) -> str:
    identity = str(layout.data_root).casefold().encode("utf-8")
    suffix = hashlib.sha256(identity).hexdigest()[:16]
    return f"Local\\BarorokLocalEngineStop-{suffix}"


class WindowsNamedMutex:
    def __init__(self, name: str) -> None:
        self.name = name
        self._handle: int | None = None

    def acquire(self) -> bool:
        if os.name != "nt":
            raise RuntimeError("The standalone local engine is supported on Windows only")
        if self._handle is not None:
            return True
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateMutexW.argtypes = [ctypes.c_void_p, ctypes.c_bool, ctypes.c_wchar_p]
        kernel32.CreateMutexW.restype = ctypes.c_void_p
        handle = kernel32.CreateMutexW(None, True, self.name)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        if ctypes.get_last_error() == WINDOWS_MUTEX_ALREADY_EXISTS:
            kernel32.CloseHandle(handle)
            return False
        self._handle = int(handle)
        return True

    def release(self) -> None:
        if self._handle is None:
            return
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.ReleaseMutex(ctypes.c_void_p(self._handle))
        kernel32.CloseHandle(ctypes.c_void_p(self._handle))
        self._handle = None

    def __enter__(self) -> "WindowsNamedMutex":
        if not self.acquire():
            raise RuntimeError("The local engine is already running for this user")
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.release()


def windows_named_mutex_exists(name: str) -> bool:
    if os.name != "nt":
        raise RuntimeError("The standalone local engine is supported on Windows only")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenMutexW.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.OpenMutexW.restype = ctypes.c_void_p
    handle = kernel32.OpenMutexW(0x00100000, False, name)
    if handle:
        kernel32.CloseHandle(handle)
        return True
    error = ctypes.get_last_error()
    if error == WINDOWS_ERROR_FILE_NOT_FOUND:
        return False
    raise ctypes.WinError(error)


class WindowsNamedEvent:
    def __init__(self, name: str) -> None:
        self.name = name
        self._handle: int | None = None

    def create(self) -> None:
        if os.name != "nt":
            raise RuntimeError("The standalone local engine is supported on Windows only")
        if self._handle is not None:
            return
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CreateEventW.argtypes = [
            ctypes.c_void_p,
            ctypes.c_bool,
            ctypes.c_bool,
            ctypes.c_wchar_p,
        ]
        kernel32.CreateEventW.restype = ctypes.c_void_p
        handle = kernel32.CreateEventW(None, True, False, self.name)
        if not handle:
            raise ctypes.WinError(ctypes.get_last_error())
        self._handle = int(handle)

    def wait(self, timeout_seconds: float | None = None) -> bool:
        if self._handle is None:
            raise RuntimeError("The local-engine stop event has not been created")
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
        kernel32.WaitForSingleObject.restype = ctypes.c_uint32
        timeout_ms = (
            WINDOWS_INFINITE
            if timeout_seconds is None
            else max(0, min(int(timeout_seconds * 1000), WINDOWS_INFINITE - 1))
        )
        result = kernel32.WaitForSingleObject(
            ctypes.c_void_p(self._handle),
            timeout_ms,
        )
        if result == WINDOWS_WAIT_OBJECT_0:
            return True
        if result == WINDOWS_WAIT_TIMEOUT:
            return False
        raise ctypes.WinError(ctypes.get_last_error())

    def signal(self) -> None:
        if self._handle is None:
            return
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        if not kernel32.SetEvent(ctypes.c_void_p(self._handle)):
            raise ctypes.WinError(ctypes.get_last_error())

    def close(self) -> None:
        if self._handle is None:
            return
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.CloseHandle(ctypes.c_void_p(self._handle))
        self._handle = None

    def __enter__(self) -> "WindowsNamedEvent":
        self.create()
        return self

    def __exit__(self, _exc_type, _exc, _traceback) -> None:
        self.close()


def signal_windows_named_event(name: str) -> bool:
    if os.name != "nt":
        raise RuntimeError("The standalone local engine is supported on Windows only")
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenEventW.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.OpenEventW.restype = ctypes.c_void_p
    handle = kernel32.OpenEventW(WINDOWS_EVENT_MODIFY_STATE, False, name)
    if not handle:
        error = ctypes.get_last_error()
        if error == WINDOWS_ERROR_FILE_NOT_FOUND:
            return False
        raise ctypes.WinError(error)
    try:
        if not kernel32.SetEvent(ctypes.c_void_p(handle)):
            raise ctypes.WinError(ctypes.get_last_error())
        return True
    finally:
        kernel32.CloseHandle(ctypes.c_void_p(handle))


def signal_engine_stop(
    layout: WebLocalEngineLayout,
    *,
    timeout_seconds: float = 5,
    poll_interval_seconds: float = 0.05,
) -> bool:
    deadline = time.monotonic() + max(0, timeout_seconds)
    event_name = engine_stop_event_name(layout)
    while True:
        if signal_windows_named_event(event_name):
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(max(0.01, poll_interval_seconds))


def arm_pairing_helper(
    layout: WebLocalEngineLayout,
    *,
    origin: str,
    now: float | None = None,
    ttl_seconds: int = PAIRING_ARM_TTL_SECONDS,
) -> float:
    if ttl_seconds <= 0 or ttl_seconds > PAIRING_ARM_TTL_SECONDS:
        raise ValueError("Pairing helper TTL is outside the allowed range")
    normalized_origin = validate_production_web_origin(origin)
    armed_at = time.time() if now is None else now
    expires_at = armed_at + ttl_seconds
    _write_json_atomic(layout.pairing_arm_path, {
        "format": PAIRING_ARM_FORMAT,
        "origin": normalized_origin,
        "expires_at": expires_at,
    })
    return expires_at


def consume_pairing_helper_arm(
    layout: WebLocalEngineLayout,
    *,
    origin: str,
    now: float | None = None,
) -> bool:
    normalized_origin = validate_production_web_origin(origin)
    consumed_at = time.time() if now is None else now
    claim_path = layout.runtime_dir / f"pairing-arm.{os.getpid()}.{time.time_ns()}.claim"
    try:
        os.replace(layout.pairing_arm_path, claim_path)
    except FileNotFoundError:
        return False

    try:
        payload = json.loads(claim_path.read_text(encoding="utf-8"))
        return (
            isinstance(payload, dict)
            and payload.get("format") == PAIRING_ARM_FORMAT
            and payload.get("origin") == normalized_origin
            and isinstance(payload.get("expires_at"), (int, float))
            and float(payload["expires_at"]) > consumed_at
        )
    except (OSError, json.JSONDecodeError, TypeError, ValueError):
        return False
    finally:
        claim_path.unlink(missing_ok=True)


def pairing_helper_is_armed(
    layout: WebLocalEngineLayout,
    *,
    origin: str,
    now: float | None = None,
) -> bool:
    normalized_origin = validate_production_web_origin(origin)
    checked_at = time.time() if now is None else now
    try:
        payload = json.loads(layout.pairing_arm_path.read_text(encoding="utf-8"))
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return False
    return (
        isinstance(payload, dict)
        and payload.get("format") == PAIRING_ARM_FORMAT
        and payload.get("origin") == normalized_origin
        and isinstance(payload.get("expires_at"), (int, float))
        and float(payload["expires_at"]) > checked_at
    )


def show_windows_message(title: str, message: str) -> bool:
    if os.name != "nt":
        raise RuntimeError("The pairing helper is supported on Windows only")
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    result = user32.MessageBoxW(None, message, title, 0x00000040)
    return result != 0


def dispatch_windows_message(title: str, message: str) -> bool:
    def show() -> None:
        try:
            if not show_windows_message(title, message):
                logging.error("The pairing code dialog could not be displayed")
        except Exception:
            logging.error("The pairing code dialog failed")

    try:
        thread = threading.Thread(
            target=show,
            name="barorok-pairing-message",
            daemon=True,
        )
        thread.start()
        return True
    except RuntimeError:
        return False


def make_pairing_code_presenter(
    layout: WebLocalEngineLayout,
    *,
    origin: str,
    dispatch_message: Callable[[str, str], bool] = dispatch_windows_message,
    clock: Callable[[], float] = time.time,
) -> Callable[[str, str, float], bool]:
    normalized_origin = validate_production_web_origin(origin)

    def present(_pairing_id: str, code: str, expires_at: float) -> bool:
        now = clock()
        if not consume_pairing_helper_arm(layout, origin=normalized_origin, now=now):
            return False
        remaining_seconds = max(1, int(expires_at - now))
        return dispatch_message(
            "바로록 연결 코드",
            "다음 웹사이트의 연결 요청입니다.\n\n"
            f"{normalized_origin}\n\n"
            f"연결 코드: {code}\n"
            f"유효 시간: 약 {remaining_seconds}초\n\n"
            "요청한 사이트가 맞을 때만 웹 화면에 코드를 입력하세요.",
        )

    return present
