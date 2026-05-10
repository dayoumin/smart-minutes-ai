from __future__ import annotations

from copy import deepcopy
from typing import Any


SUPPORTED_STT_MODELS = {"faster-whisper-large-v3", "qwen3-asr"}
DEFAULT_STT_MODEL = "faster-whisper-large-v3"
DEFAULT_STT_MODEL_PATH = "../models/faster-whisper-large-v3"
DEFAULT_QWEN_MODEL_PATH = "../models/Qwen3-ASR-1.7B"
DEFAULT_QWEN_ALIGNER_MODEL_PATH = "../models/Qwen3-ForcedAligner-0.6B"
DEFAULT_STT_DEVICE = "cpu"
DEFAULT_LONG_AUDIO_CHUNK_SECONDS = 30
DEFAULT_STT_CHUNK_SECONDS = 30
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

    selected_model = stt.get("selected_model")
    stt_model_path = str(paths.get("stt_model", ""))
    if selected_model not in SUPPORTED_STT_MODELS:
        stt["selected_model"] = DEFAULT_STT_MODEL
    selected_model = stt.get("selected_model", DEFAULT_STT_MODEL)

    if "cohere" in stt_model_path.lower():
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
        or "cohere" in str(paths.get("stt_model", "")).lower()
        or normalized_stt_path in {"../models", "./models", "models"}
    ):
        paths["stt_model"] = DEFAULT_QWEN_MODEL_PATH if selected_model == "qwen3-asr" else DEFAULT_STT_MODEL_PATH
    paths.setdefault("qwen_aligner_model", DEFAULT_QWEN_ALIGNER_MODEL_PATH)

    stt["chunk_seconds"] = max(1, _safe_int(stt.get("chunk_seconds"), DEFAULT_STT_CHUNK_SECONDS))
    diarization["enabled"] = bool(diarization.get("enabled", False))
    diarization.setdefault("min_speakers", None)
    diarization.setdefault("max_speakers", None)
    processing.setdefault("enable_long_audio_chunking", True)
    processing["long_audio_chunk_seconds"] = min(
        MAX_LONG_AUDIO_CHUNK_SECONDS,
        max(
            MIN_LONG_AUDIO_CHUNK_SECONDS,
            _safe_int(processing.get("long_audio_chunk_seconds"), DEFAULT_LONG_AUDIO_CHUNK_SECONDS),
        ),
    )
    return normalized
