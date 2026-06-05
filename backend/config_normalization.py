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
DEFAULT_SUMMARY_MODEL = "gemma4:e2b"
SUMMARY_MODEL_ALIASES = {
    "gemma4:2b": "gemma4:e2b",
    "gemma4:4b": "gemma4:e4b",
}
DEFAULT_SUMMARY_MODEL_OPTIONS = (
    {
        "model": "gemma4:e2b",
        "label": "권장 2B",
        "description": "용량과 속도를 우선할 때 사용합니다.",
        "url": "https://ollama.com/library/gemma4%3Ae2b",
        "command": "ollama run gemma4:e2b",
        "source": "recommended",
    },
    {
        "model": "gemma4:e4b",
        "label": "선택 4B",
        "description": "PC 여유가 있으면 더 큰 모델을 사용할 수 있습니다.",
        "url": "https://ollama.com/library/gemma4%3Ae4b",
        "command": "ollama run gemma4:e4b",
        "source": "recommended",
    },
    {
        "label": "모델 목록",
        "description": "Ollama에서 Gemma 4 모델을 비교합니다.",
        "url": "https://ollama.com/library/gemma4",
        "command": "",
    },
)


def _safe_int(value: Any, default: int) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def normalize_summary_model_name(model: Any) -> str:
    model_name = str(model or "").strip()
    return SUMMARY_MODEL_ALIASES.get(model_name, model_name)


def normalize_summary_model_options(options: Any) -> list[dict[str, str]]:
    if not isinstance(options, list):
        options = list(DEFAULT_SUMMARY_MODEL_OPTIONS)

    normalized_options: list[dict[str, str]] = []
    for option in options:
        if not isinstance(option, dict):
            continue
        normalized: dict[str, str] = {}
        raw_model = str(option.get("model") or option.get("id") or "").strip()
        model = normalize_summary_model_name(raw_model)
        label = str(option.get("label") or model or "모델").strip()
        description = str(option.get("description") or "").strip()
        url = str(option.get("url") or "").strip()
        command = str(option.get("command") or "").strip()
        source = str(option.get("source") or "").strip()
        if raw_model and model != raw_model:
            if command == f"ollama run {raw_model}":
                command = f"ollama run {model}"
            url = url.replace(raw_model, model).replace(raw_model.replace(":", "%3A"), model.replace(":", "%3A"))
        if model:
            normalized["model"] = model
        if label:
            normalized["label"] = label
        if description:
            normalized["description"] = description
        if url:
            normalized["url"] = url
        if command:
            normalized["command"] = command
        if source in {"recommended", "user"}:
            normalized["source"] = source
        if normalized.get("model") or normalized.get("url") or normalized.get("command"):
            normalized_options.append(normalized)

    if not normalized_options:
        return normalize_summary_model_options(list(DEFAULT_SUMMARY_MODEL_OPTIONS))
    return normalized_options


def normalize_summary_user_models(models: Any) -> list[dict[str, Any]]:
    if not isinstance(models, list):
        return []

    normalized_models: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in models:
        if isinstance(item, str):
            model = normalize_summary_model_name(item)
            option = {}
        elif isinstance(item, dict):
            model = normalize_summary_model_name(item.get("model") or item.get("id"))
            option = item
        else:
            continue
        if not model or model in seen:
            continue
        seen.add(model)
        label = str(option.get("label") or "직접 입력").strip()
        description = str(option.get("description") or "직접 입력한 Ollama 모델입니다.").strip()
        command = str(option.get("command") or f"ollama run {model}").strip()
        normalized = {
            "model": model,
            "label": label,
            "description": description,
            "command": command,
            "source": "user",
        }
        if bool(option.get("managed_by_app")):
            normalized["managed_by_app"] = True
        url = str(option.get("url") or "").strip()
        if url:
            normalized["url"] = url
        normalized_models.append(normalized)
    return normalized_models


def get_summary_recommended_model_options(config: dict) -> list[dict[str, str]]:
    summary = config.get("summary", {}) if isinstance(config.get("summary", {}), dict) else {}
    return normalize_summary_model_options(summary.get("model_options"))


def get_summary_user_model_options(config: dict) -> list[dict[str, str]]:
    summary = config.get("summary", {}) if isinstance(config.get("summary", {}), dict) else {}
    return normalize_summary_user_models(summary.get("user_models"))


def get_summary_model_options(config: dict) -> list[dict[str, str]]:
    options = get_summary_recommended_model_options(config)
    seen_models = {option.get("model") for option in options if option.get("model")}
    for option in get_summary_user_model_options(config):
        model = option.get("model", "").strip()
        if model and model not in seen_models:
            options.append(option)
            seen_models.add(model)
    return options


def get_summary_option_models(config: dict) -> list[str]:
    models: list[str] = []
    for option in get_summary_model_options(config):
        model = option.get("model", "").strip()
        if model and model not in models:
            models.append(model)
    return models


def get_summary_recommended_option_models(config: dict) -> list[str]:
    models: list[str] = []
    for option in get_summary_recommended_model_options(config):
        model = option.get("model", "").strip()
        if model and model not in models:
            models.append(model)
    return models


def get_summary_candidate_models(config: dict) -> list[str]:
    summary = config.get("summary", {}) if isinstance(config.get("summary", {}), dict) else {}
    configured_model = normalize_summary_model_name(summary.get("model") or DEFAULT_SUMMARY_MODEL)
    option_models = get_summary_recommended_option_models(config)
    candidates: list[str] = []
    if configured_model:
        candidates.append(configured_model)
    if configured_model and configured_model not in option_models:
        return candidates
    for model in option_models:
        if model not in candidates:
            candidates.append(model)
    return candidates


def summary_model_uses_managed_options(config: dict) -> bool:
    summary = config.get("summary", {}) if isinstance(config.get("summary", {}), dict) else {}
    configured_model = normalize_summary_model_name(summary.get("model") or DEFAULT_SUMMARY_MODEL)
    return configured_model in get_summary_option_models(config)


def add_summary_user_model(config: dict, model: str, *, managed_by_app: bool = False) -> None:
    model = normalize_summary_model_name(model)
    if not model or model in get_summary_recommended_option_models(config):
        return
    summary = config.setdefault("summary", {})
    user_models = normalize_summary_user_models(summary.get("user_models"))
    for option in user_models:
        if option.get("model") == model:
            if managed_by_app and not option.get("managed_by_app"):
                option["managed_by_app"] = True
                summary["user_models"] = user_models
            else:
                summary["user_models"] = user_models
            return
    user_models.append({
        "model": model,
        "label": "직접 입력",
        "description": "직접 입력한 Ollama 모델입니다.",
        "command": f"ollama run {model}",
        "source": "user",
        **({"managed_by_app": True} if managed_by_app else {}),
    })
    summary["user_models"] = user_models


def remove_summary_user_model(config: dict, model: str) -> None:
    model = normalize_summary_model_name(model)
    summary = config.setdefault("summary", {})
    summary["user_models"] = [
        option
        for option in normalize_summary_user_models(summary.get("user_models"))
        if option.get("model") != model
    ]


def normalize_app_config(config: dict) -> dict:
    """Return a normalized app config without mutating the caller's object."""
    normalized = deepcopy(config)
    paths = normalized.setdefault("paths", {})
    stt = normalized.setdefault("stt", {})
    processing = normalized.setdefault("processing", {})
    diarization = normalized.setdefault("diarization", {})
    privacy = normalized.setdefault("privacy", {})
    summary = normalized.setdefault("summary", {})

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
    summary.setdefault("enabled", True)
    summary.setdefault("provider", "ollama")
    summary["model"] = normalize_summary_model_name(summary.get("model") or DEFAULT_SUMMARY_MODEL)
    summary["model_options"] = normalize_summary_model_options(summary.get("model_options"))
    summary["user_models"] = normalize_summary_user_models(summary.get("user_models"))
    processing.setdefault("enable_long_audio_chunking", True)
    processing["long_audio_chunk_seconds"] = min(
        MAX_LONG_AUDIO_CHUNK_SECONDS,
        max(
            MIN_LONG_AUDIO_CHUNK_SECONDS,
            _safe_int(processing.get("long_audio_chunk_seconds"), DEFAULT_LONG_AUDIO_CHUNK_SECONDS),
        ),
    )
    return normalized
