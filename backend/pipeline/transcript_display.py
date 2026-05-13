import copy
import re
from typing import Any


SENTENCE_END_RE = re.compile(
    r"(?:[.!?。！？…]|다|요|죠|니다|습니다|습니까|까요|거든요|겁니다|됩니다|합니다|했습니다|해요|예요|이에요|네요|군요|잖아요)$"
)
INCOMPLETE_END_RE = re.compile(
    r"(?:은|는|이|가|을|를|에|에서|에게|께|으로|로|와|과|하고|랑|이나|거나|까지|부터|보다|처럼|만|도|의|좀|그런|어떤|왜냐면|때문에|위해서|하면서|하면|보니까|하는지를|하는지|가지고|들고)$"
)
PUNCTUATED_SENTENCE_SPLIT_RE = re.compile(r"(?<=[.!?。！？…])\s+")


def _to_seconds(value: Any) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return 0.0
    parts = value.strip().split(":")
    try:
        if len(parts) == 3:
            return int(parts[0]) * 3600 + int(parts[1]) * 60 + float(parts[2])
        if len(parts) == 2:
            return int(parts[0]) * 60 + float(parts[1])
        return float(value)
    except ValueError:
        return 0.0


def _segment_speaker(segment: dict) -> str:
    return str(segment.get("speaker") or segment.get("speaker_name") or "").strip()


def _segment_text(segment: dict) -> str:
    return str(segment.get("text") or "").strip()


def looks_sentence_complete(text: str) -> bool:
    trimmed = text.strip()
    return bool(trimmed and SENTENCE_END_RE.search(trimmed))


def looks_incomplete_sentence_end(text: str) -> bool:
    trimmed = text.strip()
    if not trimmed:
        return True
    if looks_sentence_complete(trimmed):
        return False
    return bool(INCOMPLETE_END_RE.search(trimmed))


def _copy_segment(segment: dict) -> dict:
    copied = copy.deepcopy(segment)
    speaker = _segment_speaker(copied)
    if speaker:
        copied.setdefault("speaker", speaker)
        copied.setdefault("speaker_name", speaker)
    copied["text"] = _segment_text(copied)
    copied["start"] = _to_seconds(copied.get("start", 0.0))
    copied["end"] = _to_seconds(copied.get("end", copied.get("start", 0.0)))
    return copied


def _split_punctuated_segment(segment: dict, *, min_chars: int = 40) -> list[dict]:
    text = _segment_text(segment)
    parts = [part.strip() for part in PUNCTUATED_SENTENCE_SPLIT_RE.split(text) if part.strip()]
    if len(parts) <= 1 or any(len(part) < min_chars for part in parts):
        return [segment]

    start = _to_seconds(segment.get("start", 0.0))
    end = _to_seconds(segment.get("end", start))
    duration = max(0.0, end - start)
    total_chars = sum(len(part) for part in parts) or 1
    cursor = start
    split_segments: list[dict] = []
    for index, part in enumerate(parts):
        next_cursor = end if index == len(parts) - 1 else cursor + duration * (len(part) / total_chars)
        item = copy.deepcopy(segment)
        item["start"] = cursor
        item["end"] = next_cursor
        item["text"] = part
        item["timing_approximate"] = True
        item["display_only"] = True
        split_segments.append(item)
        cursor = next_cursor
    return split_segments


def build_display_segments(
    segments: list[dict],
    *,
    target_minimum_seconds: float = 25.0,
    soft_maximum_seconds: float = 60.0,
    hard_maximum_chars: int = 700,
    max_gap_seconds: float = 3.0,
) -> list[dict]:
    display_segments: list[dict] = []
    normalized_segments: list[dict] = []
    for segment in segments or []:
        normalized_segments.extend(_split_punctuated_segment(_copy_segment(segment)))

    for segment in normalized_segments:
        if not _segment_text(segment):
            continue

        previous = display_segments[-1] if display_segments else None
        if not previous:
            display_segments.append(segment)
            continue

        previous_start = _to_seconds(previous.get("start", 0.0))
        previous_end = _to_seconds(previous.get("end", previous_start))
        current_start = _to_seconds(segment.get("start", 0.0))
        current_end = _to_seconds(segment.get("end", current_start))
        gap_seconds = current_start - previous_end
        combined_duration = current_end - previous_start
        previous_duration = previous_end - previous_start
        combined_text = f"{_segment_text(previous)} {_segment_text(segment)}".strip()
        previous_needs_continuation = (
            not looks_sentence_complete(_segment_text(previous))
            or looks_incomplete_sentence_end(_segment_text(previous))
        )
        current_is_short_tail = len(_segment_text(segment)) <= 35
        previous_is_short = previous_duration < target_minimum_seconds
        can_merge = (
            _segment_speaker(previous) == _segment_speaker(segment)
            and bool(previous.get("timing_approximate")) == bool(segment.get("timing_approximate"))
            and -max_gap_seconds <= gap_seconds <= max_gap_seconds
            and (previous_needs_continuation or previous_is_short or current_is_short_tail)
            and combined_duration <= soft_maximum_seconds
            and len(combined_text) <= hard_maximum_chars
        )

        if can_merge:
            previous["end"] = current_end
            previous["text"] = combined_text
            previous["display_only"] = True
            previous["source_segment_count"] = int(previous.get("source_segment_count", 1)) + int(segment.get("source_segment_count", 1))
            previous["timing_approximate"] = bool(previous.get("timing_approximate")) or bool(segment.get("timing_approximate"))
            continue

        display_segments.append(segment)

    for segment in display_segments:
        segment["display_only"] = True
    return display_segments


def get_transcript_segments(result: dict | None) -> list[dict]:
    if not result:
        return []
    for key in ("display_segments", "sentence_segments", "segments"):
        value = result.get(key)
        if isinstance(value, list) and value:
            return value
    return []
