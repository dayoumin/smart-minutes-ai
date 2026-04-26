import os
from typing import List, Dict

def transcribe_audio_fallback_whisper(
    wav_path: str,
    model_path: str = "large-v3", # Local path or repo ID
    language: str = "ko",
    device: str = "auto"
) -> List[Dict]:
    """
    Cohere Transcribe가 실패하거나 미설치인 경우 faster-whisper로 대체한다.
    """
    from faster_whisper import WhisperModel
    
    print(f"[STT] Loading faster-whisper model: {model_path} on {device}")
    model = WhisperModel(model_path, device=device, compute_type="default")
    
    try:
        print(f"[STT] Transcribing {wav_path} ...")
        # vad_filter=True: 긴 무음 구간을 제거하여 환각(Hallucination) 및 메모리 부족(OOM) 방지
        segments, info = model.transcribe(
            wav_path, 
            language=language, 
            vad_filter=True,
            vad_parameters=dict(min_silence_duration_ms=500)
        )
        
        results = []
        for segment in segments:
            results.append({
                "start": segment.start,
                "end": segment.end,
                "text": segment.text.strip()
            })
        return results
    except Exception as e:
        print(f"[STT] Transcription failed: {e}")
        raise RuntimeError(f"STT 처리 중 오류가 발생했습니다: {e}")

def transcribe_audio(
    wav_path: str,
    model_path: str,
    language: str = "ko",
    device: str = "auto",
    chunk_seconds: int = 30
) -> List[Dict]:
    """
    Cohere Transcribe 모델로 STT 수행.
    오류가 발생하거나 파일이 없으면 faster-whisper로 Fallback.
    """
    if "faster-whisper" in model_path.lower() or "large-v3" in model_path.lower():
        print(f"[STT] Defaulting to faster-whisper ({model_path}).")
        return transcribe_audio_fallback_whisper(wav_path, model_path, language, device)

    print(f"[STT] Attempting to load transformers ASR pipeline for {model_path}...")
    try:
        from transformers import pipeline
        import torch
        
        torch_device = 0 if torch.cuda.is_available() else -1
        
        asr_pipeline = pipeline(
            "automatic-speech-recognition",
            model=model_path,
            device=torch_device,
            chunk_length_s=chunk_seconds,
        )
        
        print(f"[STT] Transcribing {wav_path} with {model_path}...")
        # return_timestamps=True is required to get start/end times per chunk
        result = asr_pipeline(wav_path, return_timestamps=True)
        
        segments = []
        if "chunks" in result:
            for chunk in result["chunks"]:
                segments.append({
                    "start": chunk["timestamp"][0],
                    "end": chunk["timestamp"][1] if chunk["timestamp"][1] is not None else chunk["timestamp"][0] + 5.0,
                    "text": chunk["text"].strip()
                })
        else:
            # Fallback if the model doesn't support chunk timestamps
            segments.append({
                "start": 0.0,
                "end": 0.0,
                "text": result.get("text", "").strip()
            })
            
        return segments
        
    except Exception as e:
        print(f"[STT] Failed to load or run Cohere model ({model_path}): {e}")
        print("[STT] Falling back to faster-whisper (large-v3)...")
        return transcribe_audio_fallback_whisper(wav_path, "large-v3", language, device)

