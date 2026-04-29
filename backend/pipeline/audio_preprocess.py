import os
import re
import shutil
import subprocess
from typing import Mapping


def _probe_mean_volume(input_path: str, ffmpeg_path: str) -> float | None:
    null_sink = "NUL" if os.name == "nt" else "/dev/null"
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-i",
        input_path,
        "-af",
        "volumedetect",
        "-f",
        "null",
        null_sink,
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    output = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
    match = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", output)
    if not match:
        return None
    return float(match.group(1))


def _resolve_normalization_filter(mode: str, input_path: str, ffmpeg_path: str) -> str | None:
    loudnorm_filter = "loudnorm=I=-16:LRA=11:TP=-1.5"

    if mode == "loudnorm":
        return loudnorm_filter
    if mode == "dynaudnorm":
        return "dynaudnorm"
    if mode != "auto":
        raise ValueError(f"Unsupported normalization_mode: {mode}")

    mean_volume = _probe_mean_volume(input_path, ffmpeg_path)
    if mean_volume is None:
        print("[Preprocess] mean_volume probe failed; falling back to loudnorm.")
        return loudnorm_filter

    if mean_volume <= -18.0:
        print(f"[Preprocess] mean_volume={mean_volume:.1f} dB -> using loudnorm")
        return loudnorm_filter

    print(f"[Preprocess] mean_volume={mean_volume:.1f} dB -> skipping normalization")
    return None


def _build_audio_filters(
    input_path: str,
    ffmpeg_path: str,
    preprocessing: Mapping | None,
) -> str | None:
    if not preprocessing or not preprocessing.get("enabled", True):
        return None

    filters: list[str] = []

    if preprocessing.get("normalize_audio", False):
        mode = str(preprocessing.get("normalization_mode", "loudnorm")).lower()
        normalization_filter = _resolve_normalization_filter(mode, input_path, ffmpeg_path)
        if normalization_filter:
            filters.append(normalization_filter)

    return ",".join(filters) if filters else None


def convert_to_wav(
    input_path: str,
    output_path: str,
    ffmpeg_path: str = "ffmpeg",
    preprocessing: Mapping | None = None,
) -> str:
    import ffmpeg
    """
    입력 음성/영상 파일을 16kHz mono wav로 변환한다.
    """
    if not os.path.exists(input_path):
        raise FileNotFoundError(f"Input file not found: {input_path}")
        
    # ffmpeg 실행 가능 여부 사전 점검
    if not shutil.which(ffmpeg_path) and not os.path.exists(ffmpeg_path):
        raise FileNotFoundError(
            f"ffmpeg를 찾을 수 없습니다. (경로: {ffmpeg_path})\n"
            "시스템 PATH에 등록되어 있거나, config.json에 정확한 exe 경로가 지정되어야 합니다."
        )
    
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    try:
        # ffmpeg 명령어: -y (덮어쓰기), -ac 1 (mono), -ar 16000 (16kHz)
        stream = ffmpeg.input(input_path)
        output_kwargs = {"ac": 1, "ar": 16000}
        audio_filters = _build_audio_filters(input_path, ffmpeg_path, preprocessing)
        if audio_filters:
            output_kwargs["af"] = audio_filters
        stream = ffmpeg.output(stream, output_path, **output_kwargs)
        
        # ffmpeg_path를 지정하여 실행 가능 (기본값은 환경 변수의 ffmpeg)
        ffmpeg.run(stream, cmd=ffmpeg_path, overwrite_output=True, capture_stdout=True, capture_stderr=True)
        return output_path
    except ffmpeg.Error as e:
        error_message = e.stderr.decode('utf-8', errors='replace') if e.stderr else "Unknown error"
        raise RuntimeError(f"ffmpeg conversion failed: {error_message}")
