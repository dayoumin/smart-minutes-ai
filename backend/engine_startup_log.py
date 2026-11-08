"""Early startup record for the installed local engine.

engine.log starts only after the engine has imported its modules and prepared
its data folder. A failure before that point (a missing DLL, a broken import,
an unwritable data folder) used to leave nothing behind but a dialog. This
module uses the standard library only, so it can open before any other import.

It records the start mode, Python start-up failures with their traceback,
native crashes (faulthandler) and the exit code. It never records command-line
paths, meeting content or settings.
"""

from __future__ import annotations

import datetime
import faulthandler
import os
import sys
import tempfile
import traceback
from pathlib import Path
from typing import IO, Mapping, Sequence

# Must match web_local_engine_runtime; that module is not imported here because
# it pulls in project modules that may be the very thing failing to import.
PRODUCT_DIR_NAME = "Barorok"
ENGINE_DIR_NAME = "LocalEngine"
STARTUP_LOG_NAME = "engine-startup.log"
FALLBACK_LOG_NAME = "Barorok-engine-startup.log"
# Tests (and manual diagnosis of an unfrozen engine) can point the log elsewhere.
OVERRIDE_ENV = "BAROROK_ENGINE_STARTUP_LOG"
MAX_LOG_BYTES = 256 * 1024
_KNOWN_MODES = (
    "--stop",
    "--download-model",
    "--preflight-json",
    "--installer-target-preflight-json",
    "--pair",
)


def startup_log_path(environ: Mapping[str, str] | None = None) -> Path | None:
    """Return the startup log path, or None when this process should not log."""
    env = os.environ if environ is None else environ
    override = env.get(OVERRIDE_ENV)
    if override:
        return Path(override)
    if not getattr(sys, "frozen", False):
        return None
    local_app_data = env.get("LOCALAPPDATA")
    if not local_app_data:
        return None
    return Path(local_app_data) / PRODUCT_DIR_NAME / ENGINE_DIR_NAME / "logs" / STARTUP_LOG_NAME


def fallback_log_path(environ: Mapping[str, str] | None = None) -> Path:
    """Where the log goes when the data folder itself cannot be written."""
    env = os.environ if environ is None else environ
    temp = env.get("TEMP") or env.get("TMP") or tempfile.gettempdir()
    return Path(temp) / FALLBACK_LOG_NAME


def start_mode(argv: Sequence[str]) -> str:
    for argument in argv:
        if argument in _KNOWN_MODES:
            return argument.lstrip("-")
    return "serve"


def _timestamp() -> str:
    return datetime.datetime.now().astimezone().isoformat(timespec="milliseconds")


# Only these modes may create the data folder; the engine creates it there anyway.
# Check and stop commands must not create user data (installer and payload checks rely on it).
_FOLDER_CREATING_MODES = frozenset({"serve", "pair", "download-model"})


def _rotate(path: Path) -> str:
    """Rotate an oversized log; a failure (another engine holds the file) is not fatal."""
    try:
        if path.stat().st_size > MAX_LOG_BYTES:
            path.replace(path.with_name(path.name + ".1"))
    except FileNotFoundError:
        pass
    except OSError as error:
        return f"log rotation skipped ({type(error).__name__})"
    return ""


class EngineStartupLog:
    def __init__(self, path: Path | None) -> None:
        self.path = path
        self._fault_file: IO[str] | None = None

    @property
    def active(self) -> bool:
        return self.path is not None

    def write(self, message: str) -> None:
        if self.path is None:
            return
        try:
            with self.path.open("a", encoding="utf-8", errors="replace") as handle:
                for line in str(message).splitlines() or [""]:
                    handle.write(f"{_timestamp()} pid={os.getpid()} {line}\n")
        except OSError:
            # Logging must never be the reason the engine fails to start.
            pass

    def _enable_faulthandler(self) -> None:
        if self.path is None:
            return
        try:
            self._fault_file = self.path.open("a", encoding="utf-8", errors="replace")
            faulthandler.enable(file=self._fault_file, all_threads=True)
        except (OSError, RuntimeError, ValueError):
            self._close_faulthandler()

    def _close_faulthandler(self) -> None:
        if self._fault_file is None:
            return
        try:
            faulthandler.disable()
        finally:
            try:
                self._fault_file.close()
            except OSError:
                pass
            self._fault_file = None

    def record_exception(self, stage: str) -> None:
        error = sys.exc_info()[1]
        if isinstance(error, SystemExit):
            self.finish(error.code)
            return
        self.write(f"FAILED stage={stage}")
        self.write("".join(traceback.format_exc()).rstrip())

    def ready(self, detail: str = "") -> None:
        """The regular engine.log has taken over; stop holding the startup log open."""
        self.write(("ready " + detail).rstrip())
        self._close_faulthandler()

    def finish(self, code: object) -> None:
        self.write(f"exit code={code}")
        self._close_faulthandler()


def begin(argv: Sequence[str], environ: Mapping[str, str] | None = None) -> EngineStartupLog:
    """Open the startup log before any non-standard import and record this start."""
    path = startup_log_path(environ)
    if path is None:
        return EngineStartupLog(None)
    mode = start_mode(argv)
    notes: list[str] = []
    if mode in _FOLDER_CREATING_MODES:
        try:
            path.parent.mkdir(parents=True, exist_ok=True)
        except OSError as error:
            notes.append(f"data log folder unwritable: {path.parent} ({type(error).__name__}: {error})")
            path = fallback_log_path(environ)
    elif not path.parent.is_dir():
        if mode != "stop":
            # Check commands leave no trace on a PC without engine data.
            return EngineStartupLog(None)
        # A stop command on a PC without engine data must not create it.
        path = fallback_log_path(environ)
    notes.append(_rotate(path))
    log = EngineStartupLog(path)
    for note in notes:
        if note:
            log.write(note)
    log.write(
        f"start mode={mode} frozen={bool(getattr(sys, 'frozen', False))} "
        f"python={sys.version.split()[0]} exe={sys.executable}"
    )
    log._enable_faulthandler()
    return log
