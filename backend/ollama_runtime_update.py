"""Replace only a validated app-owned runtime bundle; user data lives elsewhere."""
from __future__ import annotations

import logging
import os
import shutil
import stat
from pathlib import Path
from typing import Callable
from uuid import uuid4


class RuntimeOwnershipError(RuntimeError):
    """The app does not own the listener, so it must not stop or restart it."""


def checked_runtime_path(path: Path, allowed_targets: list[Path]) -> Path:
    absolute = Path(os.path.abspath(path))
    if absolute not in [Path(os.path.abspath(item)) for item in allowed_targets]:
        raise RuntimeError("Runtime update target is not an app-managed directory.")
    # Reject junctions/symlinks in ancestors and the bundle, including broken ones.
    for candidate in (absolute, *absolute.parents):
        if candidate.exists() or candidate.is_symlink():
            info = candidate.lstat()
            if candidate.is_symlink() or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise RuntimeError("Runtime update target contains a redirected path.")
    if absolute.exists():
        for candidate in absolute.rglob("*"):
            info = candidate.lstat()
            if candidate.is_symlink() or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT:
                raise RuntimeError("Runtime bundle contains a redirected path.")
        # These are never part of an Ollama program bundle. Preserve and refuse.
        if any((absolute / name).exists() for name in ("models", "config.json", "outputs", "temp", "database")):
            raise RuntimeError("Runtime directory contains user data; update was not applied.")
    return absolute


def replace_runtime_bundle(
    source: Path, target: Path, *, allowed_targets: list[Path],
    stop: Callable[[], None], start_and_verify: Callable[[], None],
    restart_original: Callable[[], None],
    cancelled: Callable[[], bool],
) -> str:
    """Atomic directory renames only. A failed replacement restores the full old bundle."""
    target = checked_runtime_path(target, allowed_targets)
    if not (source / "ollama.exe").is_file() or not (source / "lib" / "ollama").is_dir():
        raise RuntimeError("Downloaded archive does not contain a complete Ollama runtime bundle.")
    backup = target.with_name(f".{target.name}-backup-{uuid4().hex}")
    checked_runtime_path(backup, [backup])
    had_original = target.exists()
    moved_original = False
    installed = False
    stopped = False
    try:
        if cancelled():
            raise InterruptedError("cancelled")
        try:
            stop()
        except RuntimeOwnershipError:
            raise
        except Exception:
            # A partial stop still needs the original server restored.
            stopped = True
            raise
        stopped = True
        if cancelled():
            raise InterruptedError("cancelled")
        if had_original:
            target.rename(backup)
            moved_original = True
        # No copy fallback: a denied rename must never create a mixed version.
        source.rename(target)
        installed = True
        if cancelled():
            raise InterruptedError("cancelled")
        start_and_verify()
        if cancelled():
            raise InterruptedError("cancelled")
    except BaseException as original_error:
        try:
            if installed:
                stop()
                # Keep failed files isolated until the original is back in place.
                target.rename(source)
            if moved_original:
                backup.rename(target)
            if stopped and had_original:
                restart_original()
        except Exception as recovery_error:
            raise RuntimeError(f"Runtime update failed; automatic recovery failed. Original bundle: {backup}") from recovery_error
        raise original_error
    if moved_original:
        try:
            checked_runtime_path(backup, [backup])
            shutil.rmtree(backup)
        except OSError:
            # Loaded DLLs can keep the old bundle locked. Never remove unrelated files.
            logging.warning("Updated runtime ready; old bundle retained at %s", backup)
    return str(target / "ollama.exe")
