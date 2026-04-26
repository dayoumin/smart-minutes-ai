from typing import List, Dict, Optional

def diarize_audio(
    wav_path: str,
    diarization_model_path: str,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None
) -> List[Dict]:
    import torch
    from pyannote.audio import Pipeline
    """
    pyannote Community-1 파이프라인으로 화자 분리 수행.
    오프라인 환경을 위해 diarization_model_path는 로컬 폴더(또는 config.yaml) 경로여야 합니다.
    """
    print(f"[Diarization] Loading model from {diarization_model_path}")
    try:
        pipeline = Pipeline.from_pretrained(diarization_model_path)
    except Exception as e:
        print(f"[Diarization] Could not load local model from {diarization_model_path}. "
              "Loading from Hugging Face requires accepted terms and an auth token if not cached.")
        # Fallback to huggingface hub for MVP testing if local path fails
        try:
            pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-community-1")
        except Exception as inner_e:
            raise RuntimeError(
                f"화자 분리 모델을 불러오는 데 실패했습니다.\n"
                f"1. 로컬 경로({diarization_model_path})에 모델이 다운로드되어 있는지 확인하세요.\n"
                f"2. Hugging Face에서 pyannote/speaker-diarization-community-1 조건을 수락했는지 확인하세요.\n"
                f"3. 온라인 다운로드가 필요하다면 HF_TOKEN 환경변수가 설정되어 있어야 합니다.\n"
                f"상세 오류: {inner_e}"
            )
            
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    pipeline.to(device)

    print(f"[Diarization] Processing {wav_path} ...")
    kwargs = {}
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers
    diarization = pipeline(wav_path, **kwargs)

    if hasattr(diarization, "exclusive_speaker_diarization"):
        diarization = diarization.exclusive_speaker_diarization
    
    results = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        results.append({
            "start": turn.start,
            "end": turn.end,
            "speaker": speaker
        })
        
    return results
