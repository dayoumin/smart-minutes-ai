"""Measured sizes of what the web local engine downloads after install.

This module has no imports on purpose: the frozen installer helper imports it,
and pulling in analysis modules would bundle media libraries into that helper.
web_local_engine_storage_requirements.py builds the manifest values from these.
"""

# backend/main.py MODEL_DOWNLOAD_EXPECTED_BYTES["stt_faster_whisper"].
STT_MODEL_BYTES = 3_090_839_274
# 11-file speaker-diarization-community-1 package
# (docs/model-download-distribution-evaluation.md).
DIARIZATION_MODEL_BYTES = 33_695_880
# gemma4:e2b (DEFAULT_SUMMARY_MODEL), Q4_K_M, pulled with Ollama 0.34.2 on
# 2026-10-19 (docs/audio-performance-improvement-log.md).
SUMMARY_MODEL_BYTES = 4_587_156_505
# backend/main.py OLLAMA_RUNTIME_EXPECTED_BYTES default. The pinned v0.30.6
# ollama-windows-amd64.zip is 1,456,569,673 bytes, so this stays an upper bound.
SUMMARY_RUNTIME_ARCHIVE_BYTES = 1_600_000_000
# Installed Ollama for Windows folder with its GPU libraries, measured on the
# development PC on 2026-10-20. Used as the unpacked summary-program size.
SUMMARY_RUNTIME_INSTALLED_BYTES = 3_474_297_879
# backend/main.py MODEL_DOWNLOAD_FREE_SPACE_BUFFER_BYTES and
# OLLAMA_RUNTIME_FREE_SPACE_BUFFER_BYTES.
DOWNLOAD_FREE_SPACE_BUFFER_BYTES = 512 * 1024 * 1024
