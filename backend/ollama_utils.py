import atexit
import hashlib
import os
import subprocess
import shutil
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path

from process_utils import hidden_subprocess_kwargs

_EMBEDDED_OLLAMA_PROCESS: subprocess.Popen | None = None
_EMBEDDED_OLLAMA_LOCK = threading.RLock()
_EMBEDDED_OLLAMA_BASE_PORT = 11435
_EMBEDDED_OLLAMA_PORT_RANGE = 2000


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
    return _local_app_data_root() / "LMO_audio" / "runtime" / "ollama"


def get_local_ollama_models_dir() -> Path:
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


def _ollama_api_ready() -> bool:
    try:
        with urllib.request.urlopen(f"{get_ollama_base_url()}/api/tags", timeout=2) as response:
            return 200 <= response.status < 500
    except Exception:
        return False


def ensure_ollama_server_running(timeout_seconds: int = 15) -> bool:
    global _EMBEDDED_OLLAMA_PROCESS

    if not using_embedded_ollama():
        return _ollama_api_ready()

    with _EMBEDDED_OLLAMA_LOCK:
        if _ollama_api_ready():
            return True

        if _EMBEDDED_OLLAMA_PROCESS is None or _EMBEDDED_OLLAMA_PROCESS.poll() is not None:
            _EMBEDDED_OLLAMA_PROCESS = subprocess.Popen(
                [find_ollama_executable(), "serve"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                stdin=subprocess.DEVNULL,
                env=ollama_subprocess_env(),
                **hidden_subprocess_kwargs(),
            )

    deadline = time.monotonic() + max(timeout_seconds, 1)
    while time.monotonic() < deadline:
        if _ollama_api_ready():
            return True
        time.sleep(0.25)
    return _ollama_api_ready()


def stop_embedded_ollama_server(timeout_seconds: int = 5) -> None:
    global _EMBEDDED_OLLAMA_PROCESS

    with _EMBEDDED_OLLAMA_LOCK:
        process = _EMBEDDED_OLLAMA_PROCESS
        _EMBEDDED_OLLAMA_PROCESS = None

    if process is None or process.poll() is not None:
        return

    try:
        process.terminate()
        process.wait(timeout=max(timeout_seconds, 1))
    except Exception:
        try:
            process.kill()
        except Exception:
            pass


atexit.register(stop_embedded_ollama_server)
