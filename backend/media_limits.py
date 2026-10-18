"""Server-owned duration policy for actual uploaded and decoded media."""

import math
import wave
from pathlib import Path

MAX_MEDIA_DURATION_SECONDS = 7200

MESSAGES = {
    "duration_limit_exceeded": "2시간 이하의 음성·영상 파일을 선택해 주세요.",
    "media_duration_unavailable": "파일 길이를 확인하지 못했습니다. 재생 가능한 음성·영상 파일을 선택해 주세요.",
}


class MediaDurationError(ValueError):
    def __init__(self, code: str, duration_seconds: float | None = None):
        self.code = code
        self.duration_seconds = duration_seconds
        super().__init__(MESSAGES[code])

    @property
    def http_status(self) -> int:
        return 413 if self.code == "duration_limit_exceeded" else 422

    def as_detail(self) -> dict:
        detail = {"code": self.code, "message": str(self), "max_duration_seconds": MAX_MEDIA_DURATION_SECONDS}
        if self.duration_seconds is not None:
            detail["duration_seconds"] = self.duration_seconds
        return detail


def enforce_media_duration(duration_seconds: object) -> float:
    try:
        if isinstance(duration_seconds, bool):
            raise ValueError("boolean is not a duration")
        duration = float(duration_seconds)
    except (TypeError, ValueError, OverflowError):
        raise MediaDurationError("media_duration_unavailable") from None
    if not math.isfinite(duration) or duration <= 0:
        raise MediaDurationError("media_duration_unavailable")
    if duration > MAX_MEDIA_DURATION_SECONDS:
        raise MediaDurationError("duration_limit_exceeded", duration)
    return duration


def _probe_container_duration(path: str) -> float:
    # PyAV is already bundled for faster-whisper. Inspect media without decoding
    # or requiring a separately installed ffprobe executable.
    import av

    candidates = []
    with av.open(path, mode="r", timeout=(10, 10), metadata_errors="ignore", options={"protocol_whitelist": "file,pipe"}) as container:
        if not container.streams.audio:
            raise MediaDurationError("media_duration_unavailable")
        if container.duration is not None:
            candidates.append(float(container.duration / av.time_base))
        for stream in container.streams:
            if stream.type in {"audio", "video"} and stream.duration is not None and stream.time_base is not None:
                candidates.append(float(stream.duration * stream.time_base))
    if not candidates or any(not math.isfinite(value) for value in candidates):
        raise MediaDurationError("media_duration_unavailable")
    positive_durations = [value for value in candidates if value > 0]
    if not positive_durations:
        raise MediaDurationError("media_duration_unavailable")
    return max(positive_durations)


def validate_media_duration(path: str | Path) -> float:
    try:
        try:
            with wave.open(str(path), "rb") as wav_file:
                duration = wav_file.getnframes() / wav_file.getframerate()
        except (wave.Error, EOFError):
            duration = _probe_container_duration(str(path))
        return enforce_media_duration(duration)
    except MediaDurationError:
        raise
    except Exception:
        # Never surface decoder internals, private paths, or an unchecked length.
        raise MediaDurationError("media_duration_unavailable") from None
