"""Measured sizes of what the web local engine downloads after install.

This module has no imports on purpose: the frozen installer helper imports it,
and pulling in analysis modules would bundle media libraries into that helper.
web_local_engine_storage_requirements.py builds the manifest values from these.
"""

STT_MODEL_BYTES = 3_090_839_274
# 11-file speaker-diarization-community-1 package
# (docs/model-download-distribution-evaluation.md).
DIARIZATION_MODEL_BYTES = 33_695_880
# gemma4:e2b (DEFAULT_SUMMARY_MODEL), Q4_K_M, pulled with Ollama 0.34.2 on
# 2026-10-19 (docs/audio-performance-improvement-log.md).
SUMMARY_MODEL_BYTES = 4_587_156_505
# Exact pinned ollama-windows-amd64.zip length for v0.40.10. The downloader
# checks this length before checking the SHA-256 digest.
SUMMARY_RUNTIME_ARCHIVE_BYTES = 1_586_229_413
# Installed Ollama for Windows folder with its GPU libraries, measured on the
# development PC on 2026-10-20. Used as the unpacked summary-program size.
SUMMARY_RUNTIME_INSTALLED_BYTES = 3_474_297_879
DOWNLOAD_FREE_SPACE_BUFFER_BYTES = 512 * 1024 * 1024


def runtime_archive_bytes(configured: str | None) -> int:
    if configured is None:
        return SUMMARY_RUNTIME_ARCHIVE_BYTES
    try:
        size = int(configured)
    except ValueError:
        return SUMMARY_RUNTIME_ARCHIVE_BYTES
    return size if size > 0 else SUMMARY_RUNTIME_ARCHIVE_BYTES


def runtime_download_peak_bytes(archive_bytes: int) -> int:
    # The ZIP and extracted tree coexist. Publishing that tree and retaining
    # an already installed bundle for recovery are same-volume renames.
    return archive_bytes + SUMMARY_RUNTIME_INSTALLED_BYTES
