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


def resolve_preprocessing_plan(
    input_path: str,
    ffmpeg_path: str,
    preprocessing: Mapping | None,
) -> dict:
    plan = {
        "enabled": bool(preprocessing.get("enabled", True)) if preprocessing else True,
        "normalize_audio": bool(preprocessing.get("normalize_audio", False)) if preprocessing else False,
        "requested_mode": str(preprocessing.get("normalization_mode", "loudnorm")).lower() if preprocessing else "loudnorm",
        "resolved_mode": "off",
        "mean_volume_db": None,
        "audio_filter": None,
    }
    if not preprocessing or not preprocessing.get("enabled", True):
        return plan
    if not preprocessing.get("normalize_audio", False):
        return plan

    loudnorm_filter = "loudnorm=I=-16:LRA=11:TP=-1.5"
    requested_mode = plan["requested_mode"]

    if requested_mode == "loudnorm":
        plan["resolved_mode"] = "loudnorm"
        plan["audio_filter"] = loudnorm_filter
        return plan
    if requested_mode == "dynaudnorm":
        plan["resolved_mode"] = "dynaudnorm"
        plan["audio_filter"] = "dynaudnorm"
        return plan
    if requested_mode != "auto":
        raise ValueError(f"Unsupported normalization_mode: {requested_mode}")

    mean_volume = _probe_mean_volume(input_path, ffmpeg_path)
    plan["mean_volume_db"] = mean_volume
    if mean_volume is None:
        print("[Preprocess] mean_volume probe failed; falling back to loudnorm.")
        plan["resolved_mode"] = "loudnorm"
        plan["audio_filter"] = loudnorm_filter
        return plan

    if mean_volume <= -18.0:
        print(f"[Preprocess] mean_volume={mean_volume:.1f} dB -> using loudnorm")
        plan["resolved_mode"] = "loudnorm"
        plan["audio_filter"] = loudnorm_filter
        return plan

    print(f"[Preprocess] mean_volume={mean_volume:.1f} dB -> skipping normalization")
    return plan


def _build_audio_filters(
    input_path: str,
    ffmpeg_path: str,
    preprocessing: Mapping | None,
) -> tuple[str | None, dict]:
    plan = resolve_preprocessing_plan(input_path, ffmpeg_path, preprocessing)
    audio_filter = plan.get("audio_filter")
    return (audio_filter if audio_filter else None, plan)


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
        audio_filters, preprocessing_plan = _build_audio_filters(input_path, ffmpeg_path, preprocessing)
        if audio_filters:
            output_kwargs["af"] = audio_filters
        stream = ffmpeg.output(stream, output_path, **output_kwargs)
        
        # ffmpeg_path를 지정하여 실행 가능 (기본값은 환경 변수의 ffmpeg)
        ffmpeg.run(stream, cmd=ffmpeg_path, overwrite_output=True, capture_stdout=True, capture_stderr=True)
        return {
            "path": output_path,
            "preprocessing": preprocessing_plan,
        }
    except ffmpeg.Error as e:
        error_message = e.stderr.decode('utf-8', errors='replace') if e.stderr else "Unknown error"
        raise RuntimeError(f"ffmpeg conversion failed: {error_message}")
