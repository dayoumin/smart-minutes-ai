import atexit
import hashlib
import logging
import os
import subprocess
import shutil
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from process_utils import hidden_subprocess_kwargs
from windows_process_job import WindowsProcessJob, start_owned_process

_EMBEDDED_OLLAMA_PROCESS: subprocess.Popen | None = None
_EMBEDDED_OLLAMA_JOB: WindowsProcessJob | None = None
_EMBEDDED_OLLAMA_STARTED_AT: float | None = None
_EMBEDDED_OLLAMA_READY_AT: float | None = None
_EMBEDDED_OLLAMA_API_READY = False
_EMBEDDED_OLLAMA_START_ERROR: str | None = None
_EMBEDDED_OLLAMA_EXIT_REPORTED = False
_EMBEDDED_OLLAMA_LOCK = threading.RLock()
_EMBEDDED_OLLAMA_BASE_PORT = 11435
_EMBEDDED_OLLAMA_PORT_RANGE = 2000
_LOGGER = logging.getLogger(__name__)


def _backend_dir() -> Path:
    configured = os.environ.get("MEETING_AI_BACKEND_DIR")
    if configured:
        return Path(configured)
    return Path(__file__).resolve().parent


def _portable_root() -> Path:
    backend_dir = _backend_dir().resolve()
    if backend_dir.name.lower() == "backend":
        return backend_dir.parent
    return backend_dir


def _local_app_data_root() -> Path:
    configured = os.environ.get("LOCALAPPDATA")
    if configured:
        return Path(configured)
    return Path.home() / "AppData" / "Local"


def get_portable_ollama_runtime_dir() -> Path:
    return _portable_root() / "runtime" / "ollama"


def get_local_ollama_runtime_dir() -> Path:
    configured = os.environ.get("LMO_LOCAL_OLLAMA_RUNTIME_DIR")
    if configured:
        return Path(configured)
    return _local_app_data_root() / "LMO_audio" / "runtime" / "ollama"


def get_local_ollama_models_dir() -> Path:
    configured = os.environ.get("LMO_LOCAL_OLLAMA_MODELS_DIR")
    if configured:
        return Path(configured)
    return _local_app_data_root() / "LMO_audio" / "models" / "ollama"


def _embedded_ollama_candidates() -> list[Path]:
    configured_dir = os.environ.get("LMO_EMBEDDED_OLLAMA_DIR")
    portable_root = _portable_root()
    candidates: list[Path] = []
    if configured_dir:
        candidates.append(Path(configured_dir) / "ollama.exe")
    candidates.extend([
        get_portable_ollama_runtime_dir() / "ollama.exe",
        portable_root / "ollama" / "ollama.exe",
        get_local_ollama_runtime_dir() / "ollama.exe",
        Path(__file__).resolve().parent / "runtime" / "ollama" / "ollama.exe",
    ])
    return candidates


def find_embedded_ollama_executable() -> str:
    for candidate in _embedded_ollama_candidates():
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue
    return ""


def embedded_ollama_available() -> bool:
    return bool(find_embedded_ollama_executable())


def find_ollama_executable() -> str:
    embedded = find_embedded_ollama_executable()
    if embedded:
        return embedded

    configured = os.environ.get("OLLAMA_EXE")
    if configured and os.path.isfile(configured):
        return configured

    found = shutil.which("ollama")
    if found:
        return found

    candidates = [
        Path.home() / "AppData" / "Local" / "Programs" / "Ollama" / "ollama.exe",
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Ollama" / "ollama.exe",
    ]
    for candidate in candidates:
        try:
            if candidate.is_file():
                return str(candidate)
        except OSError:
            continue

    return "ollama"


def ollama_executable_available() -> bool:
    executable = find_ollama_executable()
    if executable == "ollama":
        return shutil.which("ollama") is not None
    return os.path.isfile(executable)


def using_embedded_ollama() -> bool:
    embedded = find_embedded_ollama_executable()
    return bool(embedded and os.path.normcase(find_ollama_executable()) == os.path.normcase(embedded))


def get_ollama_models_dir() -> str:
    if using_embedded_ollama():
        configured = os.environ.get("LMO_EMBEDDED_OLLAMA_MODELS")
        if configured:
            return configured
        embedded = find_embedded_ollama_executable()
        if embedded:
            try:
                embedded_parent = Path(embedded).resolve().parent
                local_runtime = get_local_ollama_runtime_dir().resolve()
                if str(embedded_parent).lower().startswith(str(local_runtime).lower()):
                    return str(get_local_ollama_models_dir())
            except OSError:
                pass
        return str(_portable_root() / "models" / "ollama")

    configured = os.environ.get("OLLAMA_MODELS")
    if configured:
        return configured
    return str(_portable_root() / "models" / "ollama")


def get_ollama_host() -> str:
    if using_embedded_ollama():
        configured = os.environ.get("LMO_EMBEDDED_OLLAMA_HOST")
        if configured:
            return configured.removeprefix("http://").removeprefix("https://")
        digest = hashlib.sha256(str(_portable_root()).lower().encode("utf-8")).hexdigest()
        port = _EMBEDDED_OLLAMA_BASE_PORT + (int(digest[:8], 16) % _EMBEDDED_OLLAMA_PORT_RANGE)
        return f"127.0.0.1:{port}"

    configured = os.environ.get("OLLAMA_HOST")
    if configured:
        return configured.removeprefix("http://").removeprefix("https://")
    return "127.0.0.1:11434"


def get_ollama_base_url() -> str:
    return f"http://{get_ollama_host()}"


def ollama_subprocess_env() -> dict[str, str]:
    env = os.environ.copy()
    if using_embedded_ollama():
        env["OLLAMA_HOST"] = get_ollama_host()
        models_dir = get_ollama_models_dir()
        Path(models_dir).mkdir(parents=True, exist_ok=True)
        env["OLLAMA_MODELS"] = models_dir
    return env


def _ollama_api_ready(timeout_seconds: int = 2) -> bool:
    try:
        with urllib.request.urlopen(
            f"{get_ollama_base_url()}/api/tags",
            timeout=max(timeout_seconds, 1),
        ) as response:
            return 200 <= response.status < 500
    except Exception:
        return False


def probe_ollama_server(timeout_seconds: int = 2) -> bool:
    """Return whether the Ollama API is reachable without starting a runtime."""
    return _ollama_api_ready(timeout_seconds)


def is_embedded_ollama_running() -> bool:
    """Inspect only our retained process; never probe or start a runtime."""
    with _EMBEDDED_OLLAMA_LOCK:
        return _EMBEDDED_OLLAMA_PROCESS is not None and _EMBEDDED_OLLAMA_PROCESS.poll() is None


def get_embedded_ollama_status() -> dict:
    """Return the last readiness observation without HTTP or process creation."""
    with _EMBEDDED_OLLAMA_LOCK:
        process = _EMBEDDED_OLLAMA_PROCESS
        exit_code = process.poll() if process is not None else None
        running = process is not None and exit_code is None
        if running:
            state = "ready" if _EMBEDDED_OLLAMA_API_READY else "starting"
        else:
            state = "failed" if process is not None or _EMBEDDED_OLLAMA_START_ERROR else "stopped"
        return {
            "state": state,
            "running": running,
            "elapsed_seconds": (
                max(time.monotonic() - _EMBEDDED_OLLAMA_STARTED_AT, 0.0)
                if _EMBEDDED_OLLAMA_STARTED_AT is not None else None
            ),
            "exit_code": exit_code,
        }


def _record_ollama_ready(process: subprocess.Popen | None) -> None:
    global _EMBEDDED_OLLAMA_READY_AT, _EMBEDDED_OLLAMA_API_READY
    with _EMBEDDED_OLLAMA_LOCK:
        if process is None or process is not _EMBEDDED_OLLAMA_PROCESS or process.poll() is not None:
            return
        _EMBEDDED_OLLAMA_API_READY = True
        if _EMBEDDED_OLLAMA_READY_AT is None:
            _EMBEDDED_OLLAMA_READY_AT = time.monotonic()
            elapsed = (
                _EMBEDDED_OLLAMA_READY_AT - _EMBEDDED_OLLAMA_STARTED_AT
                if _EMBEDDED_OLLAMA_STARTED_AT is not None else 0.0
            )
            _LOGGER.info("Managed Ollama API ready (pid=%s, startup_elapsed_seconds=%.3f)", getattr(process, "pid", None), elapsed)


def _owned_ollama_exited(process: subprocess.Popen) -> bool:
    global _EMBEDDED_OLLAMA_EXIT_REPORTED
    exit_code = process.poll()
    if exit_code is None:
        return False
    with _EMBEDDED_OLLAMA_LOCK:
        if process is _EMBEDDED_OLLAMA_PROCESS and not _EMBEDDED_OLLAMA_EXIT_REPORTED:
            _EMBEDDED_OLLAMA_EXIT_REPORTED = True
            elapsed = (
                time.monotonic() - _EMBEDDED_OLLAMA_STARTED_AT
                if _EMBEDDED_OLLAMA_STARTED_AT is not None else 0.0
            )
            _LOGGER.warning("Managed Ollama exited (pid=%s, exit_code=%s, elapsed_seconds=%.3f)", getattr(process, "pid", None), exit_code, elapsed)
    return True


def _wait_for_ollama_server(timeout_seconds: float) -> bool:
    global _EMBEDDED_OLLAMA_PROCESS, _EMBEDDED_OLLAMA_JOB
    global _EMBEDDED_OLLAMA_STARTED_AT, _EMBEDDED_OLLAMA_API_READY
    global _EMBEDDED_OLLAMA_START_ERROR

    if not using_embedded_ollama():
        return _ollama_api_ready()

    # Count the first probe and process creation in the same wait budget. A
    # probe already in progress can finish up to its two-second socket timeout
    # after this deadline; native process creation is synchronous as before.
    deadline = time.monotonic() + max(float(timeout_seconds), 1.0)
    with _EMBEDDED_OLLAMA_LOCK:
        if _ollama_api_ready():
            _record_ollama_ready(_EMBEDDED_OLLAMA_PROCESS)
            return True
        _EMBEDDED_OLLAMA_API_READY = False

        if _EMBEDDED_OLLAMA_PROCESS is None or _EMBEDDED_OLLAMA_PROCESS.poll() is not None:
            stop_embedded_ollama_server()
            _EMBEDDED_OLLAMA_STARTED_AT = time.monotonic()
            try:
                _EMBEDDED_OLLAMA_PROCESS, _EMBEDDED_OLLAMA_JOB = start_owned_process(
                    [find_ollama_executable(), "serve"],
                    stdout=subprocess.DEVNULL,
                    stderr=subprocess.DEVNULL,
                    stdin=subprocess.DEVNULL,
                    env=ollama_subprocess_env(),
                    **hidden_subprocess_kwargs(),
                )
            except Exception as error:
                _EMBEDDED_OLLAMA_START_ERROR = type(error).__name__
                _LOGGER.warning("Managed Ollama failed to start (error_type=%s, elapsed_seconds=%.3f)", _EMBEDDED_OLLAMA_START_ERROR, time.monotonic() - _EMBEDDED_OLLAMA_STARTED_AT)
                raise
            _LOGGER.info("Managed Ollama started (pid=%s)", getattr(_EMBEDDED_OLLAMA_PROCESS, "pid", None))
        process = _EMBEDDED_OLLAMA_PROCESS

    while time.monotonic() < deadline:
        if _owned_ollama_exited(process):
            return False
        if _ollama_api_ready():
            _record_ollama_ready(process)
            return True
        if _owned_ollama_exited(process):
            return False
        remaining = deadline - time.monotonic()
        if remaining > 0:
            time.sleep(min(0.25, remaining))
    _owned_ollama_exited(process)
    return False


def ensure_ollama_server_running(timeout_seconds: int = 15) -> bool:
    """Keep the short readiness check used by ordinary runtime operations."""
    return _wait_for_ollama_server(timeout_seconds)


def wait_for_ollama_preparation(timeout_seconds: float = 300) -> bool:
    """Wait for an explicit model action, reusing a live owned startup."""
    return _wait_for_ollama_server(timeout_seconds)


def stop_embedded_ollama_server(timeout_seconds: int = 5) -> None:
    global _EMBEDDED_OLLAMA_PROCESS, _EMBEDDED_OLLAMA_JOB
    global _EMBEDDED_OLLAMA_STARTED_AT, _EMBEDDED_OLLAMA_READY_AT
    global _EMBEDDED_OLLAMA_API_READY, _EMBEDDED_OLLAMA_START_ERROR
    global _EMBEDDED_OLLAMA_EXIT_REPORTED

    with _EMBEDDED_OLLAMA_LOCK:
        process = _EMBEDDED_OLLAMA_PROCESS
        job = _EMBEDDED_OLLAMA_JOB
        _EMBEDDED_OLLAMA_PROCESS = None
        _EMBEDDED_OLLAMA_JOB = None
        _EMBEDDED_OLLAMA_STARTED_AT = None
        _EMBEDDED_OLLAMA_READY_AT = None
        _EMBEDDED_OLLAMA_API_READY = False
        _EMBEDDED_OLLAMA_START_ERROR = None
        _EMBEDDED_OLLAMA_EXIT_REPORTED = False
        try:
            if process is not None and process.poll() is None:
                try:
                    process.terminate()
                    process.wait(timeout=max(timeout_seconds, 1))
                except Exception:
                    try:
                        process.kill()
                    except Exception:
                        pass
        finally:
            if job is not None:
                try:
                    job.terminate_and_wait(timeout_seconds=max(timeout_seconds, 1))
                finally:
                    job.close()


atexit.register(stop_embedded_ollama_server)
