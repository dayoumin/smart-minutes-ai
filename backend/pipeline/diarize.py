import torch
from pyannote.audio import Pipeline
from typing import List, Dict, Optional

def diarize_audio(
    wav_path: str,
    diarization_model_path: str,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None
) -> List[Dict]:
    """
    pyannote/speaker-diarization-3.1 파이프라인으로 화자 분리 수행.
    오프라인 환경을 위해 diarization_model_path는 로컬 폴더(또는 config.yaml) 경로여야 합니다.
    """
    print(f"[Diarization] Loading model from {diarization_model_path}")
    try:
        pipeline = Pipeline.from_pretrained(diarization_model_path)
    except Exception as e:
        print(f"[Diarization] Could not load local model from {diarization_model_path}. "
              "For MVP, loading from huggingface hub requires auth token if not cached.")
        # Fallback to huggingface hub for MVP testing if local path fails
        try:
            pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")
        except Exception as inner_e:
            raise RuntimeError(
                f"화자 분리 모델을 불러오는 데 실패했습니다.\n"
                f"1. 로컬 경로({diarization_model_path})에 모델이 다운로드되어 있는지 확인하세요.\n"
                f"2. 온라인 다운로드가 필요하다면 HF_TOKEN 환경변수가 설정되어 있어야 합니다.\n"
                f"상세 오류: {inner_e}"
            )
            
    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    pipeline.to(device)

    print(f"[Diarization] Processing {wav_path} ...")
    diarization = pipeline(wav_path, min_speakers=min_speakers, max_speakers=max_speakers)
    
    results = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        results.append({
            "start": turn.start,
            "end": turn.end,
            "speaker": speaker
        })
        
    return results
