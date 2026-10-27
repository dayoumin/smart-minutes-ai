import ctypes
import importlib.util
import logging
import os
import re
import sys
import sysconfig
import threading
from pathlib import Path
from typing import Dict, List
from .transcript_review import issue


_COHERE_PROCESSOR = None
_COHERE_MODEL = None
_COHERE_MODEL_CACHE_KEY = None
_FASTER_WHISPER_MODEL = None
_FASTER_WHISPER_MODEL_CACHE_KEY = None
_CUDA_DLL_HANDLES: dict[str, object] = {}
_CUDA_DLL_LOCK = threading.Lock()


def _ensure_hf_module_cache() -> None:
    project_dir = Path(__file__).resolve().parents[2]
    cache_dir = project_dir / ".hf_modules"
    cache_dir.mkdir(parents=True, exist_ok=True)
    os.environ.setdefault("HF_MODULES_CACHE", str(cache_dir))


def _looks_like_cuda_runtime_error(exc: Exception) -> bool:
    message = str(exc).lower()
    return any(
        token in message
        for token in (
            "cublas",
            "cudnn",
            "cuda driver",
            "cuda runtime",
            "cublas64",
            "cudart",
            "cannot be loaded",
        )
    )


def _cuda_library_directories() -> list[Path]:
    # Optional libraries in this Python environment, then an already downloaded
    # app-managed Ollama runtime. Never start Ollama or download anything here.
    site_packages = Path(sysconfig.get_path("purelib"))
    directories = [site_packages / "nvidia" / name / "bin" for name in ("cublas", "cudnn")]
    # CTranslate2's Windows wheel bundles cuDNN. Locate it without relying on
    # a previous status request having imported the engine and loaded its DLLs.
    engine_spec = importlib.util.find_spec("ctranslate2")
    if engine_spec and engine_spec.submodule_search_locations:
        directories.extend(Path(location) for location in engine_spec.submodule_search_locations)
    from ollama_utils import find_embedded_ollama_executable

    executable = find_embedded_ollama_executable()
    if executable:
        directories.append(Path(executable).parent / "lib" / "ollama" / "cuda_v12")
    return directories


def _load_cuda_library(dll_name: str) -> None:
    with _CUDA_DLL_LOCK:
        if dll_name in _CUDA_DLL_HANDLES:
            return
        try:
            library = ctypes.WinDLL(dll_name)
        except OSError as original_error:
            for directory in _cuda_library_directories():
                candidate = directory / dll_name
                if not candidate.is_file():
                    continue
                try:
                    # Absolute loading lets Windows find dependencies alongside
                    # the DLL without changing global PATH or copying libraries.
                    library = ctypes.WinDLL(str(candidate.resolve()))
                    break
                except OSError:
                    continue
            else:
                raise original_error
        _CUDA_DLL_HANDLES[dll_name] = library


def _windows_cuda_runtime_is_usable(verbose: bool = True) -> bool:
    if sys.platform != "win32":
        return True

    required_dlls = ("cublas64_12.dll", "cudnn64_9.dll")
    for dll_name in required_dlls:
        try:
            _load_cuda_library(dll_name)
        except OSError:
            if verbose:
                print(f"[STT] CUDA runtime preflight failed: {dll_name} could not be loaded.")
            return False
    return True


def get_stt_device_status() -> dict:
    status = {
        "selected_device_allowed": ["cpu"],
        "recommended_device": "cpu",
        "gpu_detected": False,
        "gpu_usable": False,
        "gpu_reason": "CPU를 기본으로 사용합니다.",
    }

    try:
        import ctranslate2
        gpu_detected = ctranslate2.get_cuda_device_count() > 0
    except Exception:
        logging.exception("Failed to inspect GPU availability")
        status["gpu_reason"] = "GPU 상태를 확인하지 못해 CPU를 사용합니다."
        return status

    status["gpu_detected"] = gpu_detected
    if not gpu_detected:
        status["gpu_reason"] = "사용 가능한 NVIDIA GPU를 찾지 못했습니다."
        return status

    try:
        compute_types = ctranslate2.get_supported_compute_types("cuda")
    except Exception:
        logging.exception("Failed to inspect STT CUDA compute support")
        status["gpu_reason"] = "GPU는 감지됐지만 가속 기능을 확인하지 못했습니다. CPU를 사용해 주세요."
        return status
    if "float16" not in compute_types:
        status["gpu_reason"] = "이 GPU는 음성 인식에 필요한 가속 방식을 지원하지 않습니다. CPU를 사용해 주세요."
        return status

    if not _windows_cuda_runtime_is_usable(verbose=False):
        status["gpu_reason"] = "GPU는 감지됐지만 실행 라이브러리가 준비되지 않았습니다. CPU를 사용해 주세요."
        return status

    status["selected_device_allowed"].append("cuda")
    status["recommended_device"] = "cuda"
    status["gpu_usable"] = True
    status["gpu_reason"] = "GPU 가속을 사용할 수 있습니다."
    return status


def _clear_faster_whisper_model_cache() -> None:
    global _FASTER_WHISPER_MODEL, _FASTER_WHISPER_MODEL_CACHE_KEY

    if _FASTER_WHISPER_MODEL is None:
        _FASTER_WHISPER_MODEL_CACHE_KEY = None
        return

    import gc

    model = _FASTER_WHISPER_MODEL
    _FASTER_WHISPER_MODEL = None
    _FASTER_WHISPER_MODEL_CACHE_KEY = None
    del model
    gc.collect()
    try:
        import torch
    except Exception:
        return
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def _get_faster_whisper_model(model_path: str, device: str, compute_type: str, model_kwargs: dict):
    global _FASTER_WHISPER_MODEL, _FASTER_WHISPER_MODEL_CACHE_KEY

    cache_key = (
        os.path.normcase(os.path.normpath(model_path)),
        device,
        compute_type,
        tuple(sorted(model_kwargs.items())),
    )
    if _FASTER_WHISPER_MODEL is not None and _FASTER_WHISPER_MODEL_CACHE_KEY == cache_key:
        return _FASTER_WHISPER_MODEL

    _clear_faster_whisper_model_cache()

    from faster_whisper import WhisperModel

    print(f"[STT] Loading faster-whisper model: {model_path} on {device}")
    model = WhisperModel(model_path, device=device, compute_type=compute_type, **model_kwargs)
    print("[STT] faster-whisper model loaded successfully.")
    _FASTER_WHISPER_MODEL = model
    _FASTER_WHISPER_MODEL_CACHE_KEY = cache_key
    return model


def transcribe_audio_fallback_whisper(
    wav_path: str,
    model_path: str = "large-v3",
    language: str = "ko",
    device: str = "auto",
) -> List[Dict]:
    import traceback

    if device in {"auto", "cuda"} and not _windows_cuda_runtime_is_usable():
        if device == "cuda":
            raise RuntimeError("CUDA runtime DLLs are not available for speech recognition. Select CPU or prepare the GPU runtime.")
        print("[STT] Required CUDA runtime DLLs are missing; using CPU instead of auto.")
        device = "cpu"

    compute_type = "int8" if device in {"auto", "cpu"} else "float16"
    model_kwargs = {}
    if device in {"auto", "cpu"}:
        # The ctranslate2 default may use too many CPU threads and stall on
        # some Windows machines. Keep this conservative for portable use.
        model_kwargs.update({"cpu_threads": 4, "num_workers": 1})

    try:
        model = _get_faster_whisper_model(model_path, device, compute_type, model_kwargs)
    except Exception as exc:
        print(f"[STT] Failed to load faster-whisper model: {exc}")
        traceback.print_exc()
        _clear_faster_whisper_model_cache()
        if device == "auto" and _looks_like_cuda_runtime_error(exc):
            print("[STT] CUDA runtime is unavailable in auto mode; retrying faster-whisper on CPU.")
            return transcribe_audio_fallback_whisper(wav_path, model_path, language, "cpu")
        raise RuntimeError(f"Failed to load faster-whisper model: {exc}") from exc

    try:
        print(f"[STT] Transcribing {wav_path} (vad_filter=True) ...")
        segments_gen, _info = model.transcribe(
            wav_path,
            language=language,
            beam_size=1,
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500),
        )

        results = []
        print("[STT] Starting segment generation iteration...")
        for i, segment in enumerate(segments_gen):
            print(f"[STT] Segment {i+1}: {segment.start:.2f}s - {segment.end:.2f}s")
            results.append({
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip(),
            })

        print(f"[STT] Completed transcription for {wav_path}, total segments: {len(results)}")
        return results
    except Exception as exc:
        print(f"[STT] Transcription failed: {exc}")
        traceback.print_exc()
        _clear_faster_whisper_model_cache()
        if device == "auto" and _looks_like_cuda_runtime_error(exc):
            print("[STT] CUDA runtime failed during transcription; retrying faster-whisper on CPU.")
            return transcribe_audio_fallback_whisper(wav_path, model_path, language, "cpu")
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


def _korean_text_quality_score(text: str) -> float:
    compact = re.sub(r"\s+", "", text)
    if not compact:
        return 0.0

    hangul_count = len(re.findall(r"[\uac00-\ud7a3]", compact))
    latin_count = len(re.findall(r"[A-Za-z]", compact))
    replacement_count = compact.count("\ufffd")
    mojibake_count = len(re.findall(r"[À-ÿ]", compact))
    return hangul_count - (latin_count * 0.35) - (replacement_count * 4) - (mojibake_count * 2)


def _needs_korean_retry(text: str, language: str) -> bool:
    if language != "ko":
        return False

    compact = re.sub(r"\s+", "", text)
    if len(compact) < 30:
        return False

    hangul_count = len(re.findall(r"[\uac00-\ud7a3]", compact))
    latin_count = len(re.findall(r"[A-Za-z]", compact))
    return latin_count > max(30, hangul_count * 1.5)


def is_cohere_model(model_path: str) -> bool:
    normalized = model_path.lower()
    if "cohere-transcribe" in normalized:
        return True
    if os.path.isdir(model_path):
        return any(
            os.path.exists(os.path.join(model_path, marker))
            for marker in (
                "configuration_cohere_asr.py",
                "modeling_cohere_asr.py",
                "processing_cohere_asr.py",
            )
        )
    return False


def _split_long_text(text: str, max_chars: int) -> List[str]:
    if len(text) <= max_chars:
        return [text]

    parts: List[str] = []
    remaining = text.strip()
    while len(remaining) > max_chars:
        split_at = remaining.rfind(" ", 0, max_chars)
        if split_at < max_chars // 2:
            split_at = max_chars
        parts.append(remaining[:split_at].strip())
        remaining = remaining[split_at:].strip()
    if remaining:
        parts.append(remaining)
    return [part for part in parts if part]


def _split_text_into_timed_segments(text: str, duration: float, target_seconds: int) -> List[Dict]:
    text = text.strip()
    if not text:
        return []

    target_seconds = max(30, int(target_seconds or 90))
    target_count = max(1, round(duration / float(target_seconds))) if duration > target_seconds else 1
    sentences = [item.strip() for item in re.split(r"(?<=[.!?。！？])\s+", text) if item.strip()]
    if not sentences:
        sentences = [text]

    total_chars = max(1, sum(len(sentence) for sentence in sentences))
    target_chars = max(1, total_chars // target_count)
    bounded_sentences: List[str] = []
    for sentence in sentences:
        bounded_sentences.extend(_split_long_text(sentence, max(200, target_chars)))

    chunks: List[str] = []
    current: List[str] = []
    current_chars = 0

    for sentence in bounded_sentences:
        current.append(sentence)
        current_chars += len(sentence)
        if current_chars >= target_chars and len(chunks) < target_count - 1:
            chunks.append(" ".join(current).strip())
            current = []
            current_chars = 0

    if current:
        chunks.append(" ".join(current).strip())

    segment_duration = duration / max(1, len(chunks)) if duration > 0 else float(target_seconds)
    segments = []
    for index, chunk in enumerate(chunks):
        start = index * segment_duration
        end = duration if index == len(chunks) - 1 and duration > 0 else (index + 1) * segment_duration
        segments.append({"start": start, "end": end, "text": chunk, "timing_approximate": True, "review_version": 1, "review_issues": [issue("timing_estimated", start, end)]})
    return segments


def transcribe_audio_cohere(
    wav_path: str,
    model_path: str,
    language: str = "ko",
    device: str = "auto",
    chunk_seconds: int = 90,
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
    if _needs_korean_retry(text, language):
        print("[STT] Korean transcription looks unstable; retrying without punctuation prompt...")
        retry_texts = model.transcribe(
            processor=processor,
            language=language,
            audio_files=[wav_path],
            punctuation=False,
            compile=False,
            pipeline_detokenization=False,
        )
        retry_text = _clean_repeated_text(retry_texts[0] if retry_texts else "")
        if _korean_text_quality_score(retry_text) > _korean_text_quality_score(text):
            text = retry_text

    if not text.strip():
        raise RuntimeError("Cohere transcription returned empty text.")
    duration = _audio_duration_seconds(wav_path)
    segments = _split_text_into_timed_segments(text, duration, chunk_seconds)
    if not segments:
        raise RuntimeError("Cohere transcription returned no usable segments.")
    return segments


def _qwen_device_and_dtype(device: str):
    import torch

    if device == "cuda":
        if not torch.cuda.is_available():
            raise RuntimeError("CUDA was requested, but it is not available.")
        if not _windows_cuda_runtime_is_usable(verbose=False):
            raise RuntimeError("CUDA runtime DLLs are not available for Qwen ASR.")
        return "cuda:0", torch.bfloat16
    if device == "cpu":
        return "cpu", torch.float32
    if torch.cuda.is_available() and _windows_cuda_runtime_is_usable(verbose=False):
        return "cuda:0", torch.bfloat16
    return "cpu", torch.float32


def transcribe_audio_qwen(
    wav_path: str,
    model_path: str,
    aligner_model_path: str | None = None,
    language: str = "Korean",
    device: str = "auto",
) -> List[Dict]:
    from qwen_asr import Qwen3ASRModel
    from pipeline.qwen_segments import (
        merge_aligner_segments_to_utterances,
        remove_repeated_sentences,
    )
    import gc
    import torch
    import traceback

    device_map, dtype = _qwen_device_and_dtype(device)
    model = None
    kwargs = {
        "dtype": dtype,
        "device_map": device_map,
        "max_inference_batch_size": 1,
        "max_new_tokens": 4096,
    }
    if aligner_model_path:
        kwargs["forced_aligner"] = aligner_model_path
        kwargs["forced_aligner_kwargs"] = {
            "dtype": dtype,
            "device_map": device_map,
        }

    try:
        print(f"[STT] Loading Qwen ASR model: {model_path} on {device_map}")
        model = Qwen3ASRModel.from_pretrained(model_path, **kwargs)
        print("[STT] Qwen ASR model loaded successfully.")
    except Exception as exc:
        print(f"[STT] Failed to load Qwen ASR model: {exc}")
        traceback.print_exc()
        raise RuntimeError(f"Failed to load Qwen ASR model: {exc}") from exc

    def _cleanup_model() -> None:
        nonlocal model
        if model is not None:
            del model
            model = None
        gc.collect()
        if device_map != "cpu":
            torch.cuda.empty_cache()

    try:
        print(f"[STT] Start Qwen transcribing for {wav_path} ...")
        results = model.transcribe(
            audio=wav_path,
            language="Korean" if language == "ko" else language,
            return_time_stamps=bool(aligner_model_path),
        )
        print(f"[STT] Finished Qwen transcribing for {wav_path}")
    except Exception as exc:
        print(f"[STT] Qwen transcription failed: {exc}")
        traceback.print_exc()
        raise RuntimeError(f"Qwen transcription failed: {exc}") from exc
    try:
        result = results[0] if isinstance(results, list) else results
        text = remove_repeated_sentences(str(getattr(result, "text", "") or "").strip())

        raw_segments: List[Dict] = []
        for stamp in getattr(result, "time_stamps", None) or []:
            raw_segments.append({
                "start": float(getattr(stamp, "start_time", 0.0) or 0.0),
                "end": float(getattr(stamp, "end_time", 0.0) or 0.0),
                "text": str(getattr(stamp, "text", "") or "").strip(),
            })

        if raw_segments:
            return merge_aligner_segments_to_utterances(
                raw_segments,
                transcript_text=text,
                max_chars=60,
                max_seconds=5.0,
                gap_seconds=0.8,
                min_chars=12,
            )

        if not text:
            raise RuntimeError("Qwen transcription returned empty text.")
        duration = _audio_duration_seconds(wav_path)
        return _split_text_into_timed_segments(text, duration, 90)
    finally:
        _cleanup_model()


def transcribe_audio(
    wav_path: str,
    model_path: str,
    language: str = "ko",
    device: str = "auto",
    chunk_seconds: int = 30,
    fallback_model_path: str | None = None,
    qwen_aligner_model_path: str | None = None,
) -> List[Dict]:
    if "faster-whisper" in model_path.lower() or "large-v3" in model_path.lower():
        print(f"[STT] Defaulting to faster-whisper ({model_path}).")
        return transcribe_audio_fallback_whisper(wav_path, model_path, language, device)

    if "qwen" in model_path.lower():
        print(f"[STT] Defaulting to Qwen ASR ({model_path}).")
        return transcribe_audio_qwen(wav_path, model_path, qwen_aligner_model_path, language, device)

    raise RuntimeError(f"Unsupported speech recognition model path: {model_path}")
