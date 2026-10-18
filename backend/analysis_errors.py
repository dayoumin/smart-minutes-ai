"""Stable codes for analysis failures, so the UI can offer the next step that matches the cause."""

from __future__ import annotations

import errno

INSUFFICIENT_MEMORY = "insufficient_memory"
INSUFFICIENT_STORAGE = "insufficient_storage"
UNSUPPORTED_MEDIA = "unsupported_media"

_MEMORY_MARKERS = (
    "out of memory",  # CUDA / ctranslate2 / torch
    "cannot allocate memory",
    "bad_alloc",
    "not enough memory",
)
_STORAGE_MARKERS = (
    "no space left on device",
    "not enough space on the disk",
)
# Final ffmpeg errors that mean the file itself cannot be decoded, not that ffmpeg is missing or broken. The wrapped
# stderr also carries warnings (e.g. "Could not find codec parameters") for files that decode fine, so those are left out.
_UNSUPPORTED_MEDIA_MARKERS = (
    "invalid data found when processing input",
    "does not contain any stream",
    "moov atom not found",
)
_WINDOWS_DISK_FULL_ERRORS = {39, 112}  # ERROR_HANDLE_DISK_FULL, ERROR_DISK_FULL


def classify_analysis_failure(exc: BaseException) -> str | None:
    """Returns a cause code for a failed analysis, or None when the cause is not one the user can act on."""
    if isinstance(exc, MemoryError):
        return INSUFFICIENT_MEMORY
    if isinstance(exc, OSError) and (
        exc.errno == errno.ENOSPC or getattr(exc, "winerror", None) in _WINDOWS_DISK_FULL_ERRORS
    ):
        return INSUFFICIENT_STORAGE
    text = str(exc).lower()
    if any(marker in text for marker in _MEMORY_MARKERS):
        return INSUFFICIENT_MEMORY
    if any(marker in text for marker in _STORAGE_MARKERS):
        return INSUFFICIENT_STORAGE
    if any(marker in text for marker in _UNSUPPORTED_MEDIA_MARKERS):
        return UNSUPPORTED_MEDIA
    return None
