import os
from pathlib import Path
from typing import Dict, List


_COHERE_PROCESSOR = None
_COHERE_MODEL = None
_COHERE_MODEL_PATH = None


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


def _load_cohere_model(model_path: str):
    global _COHERE_PROCESSOR, _COHERE_MODEL, _COHERE_MODEL_PATH

    if _COHERE_MODEL_PATH == model_path and _COHERE_PROCESSOR is not None and _COHERE_MODEL is not None:
        return _COHERE_PROCESSOR, _COHERE_MODEL

    _ensure_hf_module_cache()

    import torch
    from transformers import AutoProcessor, CohereAsrForConditionalGeneration

    print(f"[STT] Loading Cohere Transcribe model: {model_path}")
    _COHERE_PROCESSOR = AutoProcessor.from_pretrained(model_path, trust_remote_code=True)
    _COHERE_MODEL = CohereAsrForConditionalGeneration.from_pretrained(
        model_path,
        trust_remote_code=True,
    )
    if torch.cuda.is_available():
        _COHERE_MODEL = _COHERE_MODEL.to("cuda")
    _COHERE_MODEL.eval()
    _COHERE_MODEL_PATH = model_path
    return _COHERE_PROCESSOR, _COHERE_MODEL


def _audio_duration_seconds(wav_path: str) -> float:
    try:
        import soundfile as sf

        info = sf.info(wav_path)
        return float(info.frames) / float(info.samplerate)
    except Exception:
        return 0.0


def transcribe_audio_cohere(
    wav_path: str,
    model_path: str,
    language: str = "ko",
) -> List[Dict]:
    _ensure_hf_module_cache()
    import librosa

    processor, model = _load_cohere_model(model_path)

    print(f"[STT] Transcribing {wav_path} with Cohere Transcribe...")
    audio, _sample_rate = librosa.load(wav_path, sr=16000, mono=True)
    inputs = processor(audio, sampling_rate=16000, return_tensors="pt", language=language)
    audio_chunk_index = inputs.get("audio_chunk_index")
    if "input_features" in inputs and inputs["input_features"].ndim == 3 and inputs["input_features"].shape[1] == 128:
        inputs["input_features"] = inputs["input_features"].transpose(1, 2)
    inputs.to(model.device, dtype=model.dtype)

    generation_inputs = {
        key: value
        for key, value in inputs.items()
        if key not in {"audio_chunk_index", "length"}
    }
    outputs = model.generate(**generation_inputs, max_new_tokens=256)
    decoded = processor.decode(
        outputs,
        skip_special_tokens=True,
        audio_chunk_index=audio_chunk_index,
        language=language,
    )
    text = decoded[0] if isinstance(decoded, list) else decoded

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
) -> List[Dict]:
    if "faster-whisper" in model_path.lower() or "large-v3" in model_path.lower():
        print(f"[STT] Defaulting to faster-whisper ({model_path}).")
        return transcribe_audio_fallback_whisper(wav_path, model_path, language, device)

    try:
        return transcribe_audio_cohere(wav_path, model_path, language)
    except Exception as exc:
        print(f"[STT] Failed to load or run Cohere model ({model_path}): {exc}")
        print("[STT] Falling back to faster-whisper (large-v3)...")
        return transcribe_audio_fallback_whisper(wav_path, "large-v3", language, device)
