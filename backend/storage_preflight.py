import logging
import os
import shutil

ANALYSIS_WAV_SAMPLE_RATE = 16000
ANALYSIS_WAV_CHANNELS = 1
ANALYSIS_WAV_BYTES_PER_SAMPLE = 2
ANALYSIS_STORAGE_SAFETY_BYTES = 1024 * 1024 * 1024


def format_storage_bytes(size_bytes: int | float | None) -> str:
    if not isinstance(size_bytes, (int, float)):
        return "-"
    size = max(0.0, float(size_bytes))
    units = ["B", "KB", "MB", "GB", "TB"]
    unit_index = 0
    while size >= 1024 and unit_index < len(units) - 1:
        size /= 1024
        unit_index += 1
    if unit_index == 0:
        return f"{int(size)} {units[unit_index]}"
    return f"{size:.1f} {units[unit_index]}"


def estimate_analysis_wav_size_bytes(duration_seconds: float | int | None) -> int:
    try:
        duration = float(duration_seconds or 0)
    except (TypeError, ValueError):
        duration = 0
    if duration <= 0:
        return 0
    return int(duration * ANALYSIS_WAV_SAMPLE_RATE * ANALYSIS_WAV_CHANNELS * ANALYSIS_WAV_BYTES_PER_SAMPLE)


def estimate_analysis_required_storage_bytes(file_size_bytes: int | float | None, duration_seconds: float | int | None) -> int:
    try:
        source_size = int(file_size_bytes or 0)
    except (TypeError, ValueError):
        source_size = 0
    source_size = max(0, source_size)
    estimated_wav_size = estimate_analysis_wav_size_bytes(duration_seconds)
    return source_size + (estimated_wav_size * 2) + ANALYSIS_STORAGE_SAFETY_BYTES


def build_analysis_storage_preflight(
    temp_dir: str,
    file_size_bytes: int | float | None,
    duration_seconds: float | int | None,
    *,
    disk_usage=shutil.disk_usage,
    ensure_dir=os.makedirs,
) -> dict:
    target_dir = os.path.abspath(temp_dir)
    required_bytes = estimate_analysis_required_storage_bytes(file_size_bytes, duration_seconds)

    try:
        ensure_dir(target_dir, exist_ok=True)
    except Exception:
        logging.exception("Failed to prepare analysis temp directory")
        return {
            "ok": False,
            "level": "error",
            "reason": "temp_dir_unavailable",
            "target_dir": target_dir,
            "required_bytes": required_bytes,
            "available_bytes": None,
            "message": "임시 저장 폴더를 준비하지 못했습니다. 폴더 권한과 남은 저장 공간을 확인한 뒤 다시 시도해 주세요.",
        }

    try:
        _, _, available_bytes = disk_usage(target_dir)
    except Exception:
        logging.exception("Failed to check analysis storage space")
        return {
            "ok": True,
            "level": "warning",
            "reason": "storage_check_unavailable",
            "target_dir": target_dir,
            "required_bytes": required_bytes,
            "available_bytes": None,
            "message": "저장 공간을 확인하지 못했습니다. 파일이 길다면 충분한 여유 공간을 확보한 뒤 진행해 주세요.",
        }

    ok = available_bytes >= required_bytes
    return {
        "ok": ok,
        "level": "ok" if ok else "error",
        "reason": "enough_storage" if ok else "not_enough_storage",
        "target_dir": target_dir,
        "required_bytes": required_bytes,
        "available_bytes": available_bytes,
        "message": (
            "저장 공간을 확인했습니다."
            if ok
            else (
                "저장 공간이 부족합니다. 다운로드 폴더나 임시 파일을 정리한 뒤 다시 시도해 주세요. "
                f"필요한 여유 공간: {format_storage_bytes(required_bytes)}, "
                f"현재 여유 공간: {format_storage_bytes(available_bytes)}."
            )
        ),
    }
