from __future__ import annotations

from copy import deepcopy
from typing import Any


SUPPORTED_STT_MODELS = {"faster-whisper-large-v3"}
DEFAULT_STT_MODEL = "faster-whisper-large-v3"
DEFAULT_STT_MODEL_PATH = "../models/faster-whisper-large-v3"
DEFAULT_STT_DEVICE = "cpu"
DEFAULT_LONG_AUDIO_CHUNK_SECONDS = 30
DEFAULT_STT_CHUNK_SECONDS = 30
DEFAULT_DIARIZATION_MAX_DURATION_SECONDS = 150 * 60
DEFAULT_DIARIZATION_MAX_WAVEFORM_MB = 512
MIN_LONG_AUDIO_CHUNK_SECONDS = 10
MAX_LONG_AUDIO_CHUNK_SECONDS = 3600


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_app_config(config: dict) -> dict:
    """Return a normalized app config without mutating the caller's object."""
    normalized = deepcopy(config)
    paths = normalized.setdefault("paths", {})
    stt = normalized.setdefault("stt", {})
    processing = normalized.setdefault("processing", {})
    diarization = normalized.setdefault("diarization", {})
    privacy = normalized.setdefault("privacy", {})

    selected_model = stt.get("selected_model")
    stt_model_path = str(paths.get("stt_model", ""))
    if selected_model not in SUPPORTED_STT_MODELS:
        stt["selected_model"] = DEFAULT_STT_MODEL
    selected_model = stt.get("selected_model", DEFAULT_STT_MODEL)

    legacy_stt_path = stt_model_path.lower()
    if "cohere" in legacy_stt_path or "qwen" in legacy_stt_path:
        paths["stt_model"] = DEFAULT_STT_MODEL_PATH
        stt["selected_model"] = DEFAULT_STT_MODEL

    stt.setdefault("default_model", DEFAULT_STT_MODEL)
    if stt.get("default_model") not in SUPPORTED_STT_MODELS:
        stt["default_model"] = DEFAULT_STT_MODEL

    device = str(stt.get("device", DEFAULT_STT_DEVICE)).lower()
    if device == "auto":
        device = DEFAULT_STT_DEVICE
    if device not in {"cpu", "cuda"}:
        device = DEFAULT_STT_DEVICE
    stt["device"] = device

    normalized_stt_path = str(paths.get("stt_model", "")).replace("\\", "/").rstrip("/").lower()
    if (
        not paths.get("stt_model")
        or any(marker in str(paths.get("stt_model", "")).lower() for marker in ("cohere", "qwen"))
        or normalized_stt_path in {"../models", "./models", "models"}
    ):
        paths["stt_model"] = DEFAULT_STT_MODEL_PATH

    stt["chunk_seconds"] = max(1, _safe_int(stt.get("chunk_seconds"), DEFAULT_STT_CHUNK_SECONDS))
    diarization["enabled"] = bool(diarization.get("enabled", False))
    diarization["generate_during_analysis"] = bool(diarization.get("generate_during_analysis", False))
    diarization["auto_skip_long_audio"] = bool(diarization.get("auto_skip_long_audio", True))
    diarization["max_duration_seconds"] = max(
        60,
        _safe_int(diarization.get("max_duration_seconds"), DEFAULT_DIARIZATION_MAX_DURATION_SECONDS),
    )
    diarization["max_waveform_mb"] = max(
        32,
        _safe_int(diarization.get("max_waveform_mb"), DEFAULT_DIARIZATION_MAX_WAVEFORM_MB),
    )
    diarization.setdefault("min_speakers", None)
    diarization.setdefault("max_speakers", None)
    privacy["preserve_extracted_audio"] = bool(privacy.get("preserve_extracted_audio", True))
    privacy["auto_save_hwpx_copy"] = bool(privacy.get("auto_save_hwpx_copy", False))
    privacy["auto_save_audio_copy"] = bool(privacy.get("auto_save_audio_copy", False))
    processing.setdefault("enable_long_audio_chunking", True)
    processing["long_audio_chunk_seconds"] = min(
        MAX_LONG_AUDIO_CHUNK_SECONDS,
        max(
            MIN_LONG_AUDIO_CHUNK_SECONDS,
            _safe_int(processing.get("long_audio_chunk_seconds"), DEFAULT_LONG_AUDIO_CHUNK_SECONDS),
        ),
    )
    return normalized
