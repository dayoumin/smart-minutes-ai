import os
import re
from pathlib import Path
from typing import Dict, List


_COHERE_PROCESSOR = None
_COHERE_MODEL = None
_COHERE_MODEL_CACHE_KEY = None


def _ensure_hf_module_cache() -> None:
    project_dir = Path(__file__).resolve().parents[2]
    cache_dir = project_dir / ".hf_modules"
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_MODULES_CACHE", str(cache_dir))


def transcribe_audio_fallback_whisper(
    wav_path: str,
    model_path: str = "large-v3",
    language: str = "ko",
    device: str = "auto",
) -> List[Dict]:
    from faster_whisper import WhisperModel

    print(f"[STT] Loading faster-whisper model: {model_path} on {device}")
    model = WhisperModel(model_path, device=device, compute_type="default")

    try:
        print(f"[STT] Transcribing {wav_path} ...")
        segments, _info = model.transcribe(
            wav_path,
            language=language,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
        )

        return [
            {
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
            }
            for segment in segments
        ]
    except Exception as exc:
        print(f"[STT] Transcription failed: {exc}")
        raise RuntimeError(f"STT processing failed: {exc}") from exc


def _resolve_torch_device(device: str):
    import torch

    if device == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested, but it is not available.")
        return torch.device("cuda")
    if device == "cpu":
        return torch.device("cpu")
    return torch.device("cuda" if torch.cuda.is_available() else "cpu")


def _load_cohere_model(model_path: str, device: str):
    global _COHERE_PROCESSOR, _COHERE_MODEL, _COHERE_MODEL_CACHE_KEY

    torch_device = _resolve_torch_device(device)
    cache_key = (model_path, str(torch_device))

    if _COHERE_MODEL_CACHE_KEY == cache_key and _COHERE_PROCESSOR is not None and _COHERE_MODEL is not None:
        return _COHERE_PROCESSOR, _COHERE_MODEL

    _ensure_hf_module_cache()

    from transformers import AutoModelForSpeechSeq2Seq, AutoProcessor

    print(f"[STT] Loading Cohere Transcribe model: {model_path} on {torch_device}")
    _COHERE_PROCESSOR = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
    _COHERE_MODEL = AutoModelForSpeechSeq2Seq.from_pretrained(
        model_path,
        trust_remote_code=True,
    )
    if getattr(_COHERE_MODEL.generation_config, "cache_implementation", None) == "static":
        _COHERE_MODEL.generation_config.cache_implementation = None
    decoder_config = getattr(_COHERE_MODEL.config, "transf_decoder", {}).get("config_dict", {})
    if not hasattr(_COHERE_MODEL.config, "hidden_size") and "hidden_size" in decoder_config:
        _COHERE_MODEL.config.hidden_size = decoder_config["hidden_size"]
    if not hasattr(_COHERE_MODEL.config, "num_attention_heads") and "num_attention_heads" in decoder_config:
        _COHERE_MODEL.config.num_attention_heads = decoder_config["num_attention_heads"]
    _COHERE_MODEL._can_compile_fullgraph = True
    _COHERE_MODEL = _COHERE_MODEL.to(torch_device)
    _COHERE_MODEL.eval()
    _COHERE_MODEL_CACHE_KEY = cache_key
    return _COHERE_PROCESSOR, _COHERE_MODEL


def _audio_duration_seconds(wav_path: str) -> float:
    try:
        import soundfile as sf

        info = sf.info(wav_path)
        return float(info.frames) / float(info.samplerate)
    except Exception:
        return 0.0


def _clean_repeated_text(text: str) -> str:
    cleaned = re.sub(r"\s+", " ", text.replace("\ufffd", "")).strip()
    if not cleaned:
        return ""

    for size in range(1, 7):
        pattern = re.compile(rf"((?:[\w가-힣%]+[,.!?]?\s+){{{size}}})(?:\1){{3,}}", re.IGNORECASE)
        cleaned = pattern.sub(r"\1", cleaned + " ").strip()

    cleaned = re.sub(r"([.?!,])\1{3,}", r"\1\1\1", cleaned)
    return cleaned


def transcribe_audio_cohere(
    wav_path: str,
    model_path: str,
    language: str = "ko",
    device: str = "auto",
) -> List[Dict]:
    _ensure_hf_module_cache()

    processor, model = _load_cohere_model(model_path, device)

    print(f"[STT] Transcribing {wav_path} with Cohere Transcribe...")
    texts = model.transcribe(
        processor=processor,
        language=language,
        audio_files=[wav_path],
        punctuation=True,
        compile=False,
        pipeline_detokenization=False,
    )
    text = _clean_repeated_text(texts[0] if texts else "")

    return [
        {
            "start": 0.0,
            "end": _audio_duration_seconds(wav_path),
            "text": text.strip(),
        }
    ]


def transcribe_audio(
    wav_path: str,
    model_path: str,
    language: str = "ko",
    device: str = "auto",
    chunk_seconds: int = 30,
    fallback_model_path: str | None = None,
) -> List[Dict]:
    if "faster-whisper" in model_path.lower() or "large-v3" in model_path.lower():
        print(f"[STT] Defaulting to faster-whisper ({model_path}).")
        return transcribe_audio_fallback_whisper(wav_path, model_path, language, device)

    try:
        return transcribe_audio_cohere(wav_path, model_path, language, device)
    except Exception as exc:
        print(f"[STT] Failed to load or run Cohere model ({model_path}): {exc}")
        if not fallback_model_path:
            raise
        print(f"[STT] Falling back to faster-whisper ({fallback_model_path})...")
        return transcribe_audio_fallback_whisper(wav_path, fallback_model_path, language, device)
