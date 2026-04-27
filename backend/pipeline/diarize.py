from typing import Dict, List, Optional


def diarize_audio(
    wav_path: str,
    diarization_model_path: str,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
) -> List[Dict]:
    import soundfile as sf
    import torch
    from pyannote.audio import Pipeline

    """
    Run pyannote Community-1 speaker diarization from a local model folder.
    The desktop app is offline-first, so remote Hugging Face fallback is not used here.
    """
    print(f"[Diarization] Loading model from {diarization_model_path}")
    try:
        pipeline = Pipeline.from_pretrained(diarization_model_path)
    except Exception as exc:
        raise RuntimeError(
            "화자 분리 모델을 로컬에서 불러오지 못했습니다.\n"
            f"모델 경로를 확인하세요: {diarization_model_path}\n"
            "포터블/오프라인 앱은 Hugging Face 원격 모델을 자동으로 불러오지 않습니다.\n"
            f"상세 오류: {exc}"
        ) from exc

    device = torch.device("cuda" if torch.cuda.is_available() else "cpu")
    pipeline.to(device)

    print(f"[Diarization] Processing {wav_path} ...")
    kwargs = {}
    if min_speakers is not None:
        kwargs["min_speakers"] = min_speakers
    if max_speakers is not None:
        kwargs["max_speakers"] = max_speakers

    waveform, sample_rate = sf.read(wav_path, dtype="float32", always_2d=True)
    waveform_tensor = torch.from_numpy(waveform.T)
    diarization = pipeline({"waveform": waveform_tensor, "sample_rate": sample_rate}, **kwargs)

    if hasattr(diarization, "exclusive_speaker_diarization"):
        diarization = diarization.exclusive_speaker_diarization

    results = []
    for turn, _, speaker in diarization.itertracks(yield_label=True):
        results.append({
            "start": turn.start,
            "end": turn.end,
            "speaker": speaker,
        })

    return results
