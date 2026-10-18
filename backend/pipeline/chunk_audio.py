import math
import os
import subprocess
import wave
from typing import Dict, List

from process_utils import hidden_subprocess_kwargs


MIN_TRAILING_CHUNK_SECONDS = 1.0


class ChunkTimestampError(ValueError):
    """Invalid time metadata must not trigger a model retry that clears caches."""


def _finite_seconds(value: object) -> float:
    try:
        seconds = float(value)
    except (TypeError, ValueError, OverflowError) as exc:
        raise ChunkTimestampError("대화록 시간 정보를 처리하지 못했습니다. 진행분은 보존되었습니다.") from exc
    if not math.isfinite(seconds):
        raise ChunkTimestampError("대화록 시간 정보를 처리하지 못했습니다. 진행분은 보존되었습니다.")
    return seconds


def get_wav_duration_seconds(wav_path: str) -> float:
    with wave.open(wav_path, "rb") as wav_file:
        frames = wav_file.getnframes()
        rate = wav_file.getframerate()
        return frames / float(rate)


def split_wav_by_duration(
    wav_path: str,
    output_dir: str,
    chunk_seconds: int,
    ffmpeg_path: str = "ffmpeg",
) -> List[Dict]:
    duration = get_wav_duration_seconds(wav_path)
    if duration <= chunk_seconds:
        return [{"path": wav_path, "offset": 0.0, "duration": duration, "index": 0}]

    import ffmpeg

    os.makedirs(output_dir, exist_ok=True)
    chunk_count = math.ceil(duration / chunk_seconds)
    chunks = []
    base_name = os.path.splitext(os.path.basename(wav_path))[0]

    for index in range(chunk_count):
        offset = float(index * chunk_seconds)
        chunk_duration = min(float(chunk_seconds), max(0.0, duration - offset))
        if index > 0 and chunk_duration < MIN_TRAILING_CHUNK_SECONDS:
            continue

        chunk_path = os.path.join(output_dir, f"{base_name}_chunk_{index + 1:03d}.wav")

        stream = ffmpeg.input(wav_path, ss=offset, t=chunk_duration)
        stream = ffmpeg.output(stream, chunk_path, ac=1, ar=16000)
        command = ffmpeg.compile(stream, cmd=ffmpeg_path, overwrite_output=True)
        completed = subprocess.run(
            command,
            capture_output=True,
            check=False,
            **hidden_subprocess_kwargs(),
        )
        if completed.returncode != 0:
            error_message = completed.stderr.decode("utf-8", errors="replace") if completed.stderr else "Unknown error"
            raise RuntimeError(f"ffmpeg chunking failed: {error_message}")

        chunks.append({
            "path": chunk_path,
            "offset": offset,
            "duration": chunk_duration,
            "index": index,
        })

    return chunks


def apply_time_offset(
    segments: List[Dict],
    offset_seconds: float,
    *,
    duration_seconds: float | None = None,
) -> List[Dict]:
    """Bound local model timestamps before applying the chunk's global offset.

    Cached model output stays unchanged, so old checkpoints remain reusable.
    Keep every text segment, including one wholly outside the chunk, and mark
    corrected timestamps as approximate instead of assigning speech to the next
    chunk or inventing a positive duration.
    """
    offset = _finite_seconds(offset_seconds)
    duration = None if duration_seconds is None else _finite_seconds(duration_seconds)
    if duration is not None and duration <= 0:
        raise ChunkTimestampError("대화록 시간 정보를 처리하지 못했습니다. 진행분은 보존되었습니다.")
    adjusted = []
    for segment in segments:
        item = dict(segment)
        start = _finite_seconds(item.get("start", 0.0))
        end = _finite_seconds(item.get("end", start))
        if duration is not None:
            bounded_start = min(max(start, 0.0), duration)
            bounded_end = max(bounded_start, min(max(end, 0.0), duration))
            if bounded_start != start or bounded_end != end:
                item["timing_approximate"] = True
            start, end = bounded_start, bounded_end
        item["start"] = start + offset
        item["end"] = end + offset
        adjusted.append(item)
    return adjusted
