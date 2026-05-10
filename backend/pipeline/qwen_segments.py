from __future__ import annotations

import re
from typing import Any


DEFAULT_SENTENCE_ENDINGS = (".", "?", "!", "\u3002", "\uff1f", "\uff01")
NO_SPACE_BEFORE = set(".,?!:;)]}\u3002\uff1f\uff01\u3001")
NO_SPACE_AFTER = set("([{")


def _segment_text(segment: dict[str, Any]) -> str:
    return str(segment.get("text", "") or "").strip()


def _segment_start(segment: dict[str, Any]) -> float:
    return float(segment.get("start", 0.0) or 0.0)


def _segment_end(segment: dict[str, Any]) -> float:
    return float(segment.get("end", 0.0) or 0.0)


def _append_text(current: str, text: str) -> str:
    if not current:
        return text
    if not text:
        return current
    if text[0] in NO_SPACE_BEFORE or current[-1] in NO_SPACE_AFTER:
        return f"{current}{text}"
    return f"{current} {text}"


def _ends_sentence(text: str, sentence_endings: tuple[str, ...]) -> bool:
    stripped = text.rstrip()
    return bool(stripped) and stripped.endswith(sentence_endings)


def _build_timing_groups(
    segments: list[dict[str, Any]],
    *,
    max_chars: int,
    max_seconds: float,
    gap_seconds: float,
    min_chars: int,
    sentence_endings: tuple[str, ...],
) -> list[dict[str, Any]]:
    cleaned = [
        {
            "start": _segment_start(segment),
            "end": _segment_end(segment),
            "text": _segment_text(segment),
        }
        for segment in segments
        if _segment_text(segment)
    ]
    if not cleaned:
        return []

    utterances: list[dict[str, Any]] = []
    current_text = ""
    current_start = cleaned[0]["start"]
    current_end = cleaned[0]["end"]

    def flush() -> None:
        nonlocal current_text, current_start, current_end
        text = current_text.strip()
        if not text:
            return
        utterances.append({
            "start": current_start,
            "end": current_end,
            "text": text,
            "timing_approximate": False,
            "split_on_speaker_change": True,
        })
        current_text = ""

    for segment in cleaned:
        text = segment["text"]
        start = segment["start"]
        end = segment["end"]

        if not current_text:
            current_text = text
            current_start = start
            current_end = end
            continue

        gap = max(0.0, start - current_end)
        duration_if_added = max(0.0, end - current_start)
        text_if_added = _append_text(current_text, text)
        should_split_before = (
            (gap >= gap_seconds and len(current_text) >= min_chars)
            or len(text_if_added) > max_chars
            or duration_if_added > max_seconds
        )
        if should_split_before:
            flush()
            current_text = text
            current_start = start
            current_end = end
            continue

        current_text = text_if_added
        current_end = end

        if _ends_sentence(current_text, sentence_endings) and len(current_text) >= min_chars:
            flush()

    flush()
    return utterances


def _split_sentences(text: str) -> list[str]:
    normalized = " ".join(str(text or "").split())
    if not normalized:
        return []
    return [
        item.strip()
        for item in re.split(r"(?<=[.!?\u3002\uff1f\uff01])\s+", normalized)
        if item.strip()
    ]


def _normalize_for_repeat_check(text: str) -> str:
    return re.sub(r"[\W_]+", "", str(text or "").lower(), flags=re.UNICODE)


def remove_repeated_sentences(text: str) -> str:
    """Remove conservative Qwen transcript repetitions.

    Qwen can occasionally repeat an adjacent sentence or loop back to an early
    sentence at the end of a clip. Keep this conservative so intentional meeting
    repetition is not aggressively removed.
    """

    sentences = _split_sentences(text)
    if len(sentences) < 2:
        return " ".join(str(text or "").split())

    cleaned: list[str] = []
    normalized_seen: list[str] = []
    for index, sentence in enumerate(sentences):
        normalized = _normalize_for_repeat_check(sentence)
        if not normalized:
            continue
        previous = normalized_seen[-1] if normalized_seen else ""
        is_adjacent_repeat = previous == normalized
        is_trailing_loop = (
            index == len(sentences) - 1
            and len(normalized) >= 8
            and normalized in normalized_seen[:-1]
        )
        if is_adjacent_repeat or is_trailing_loop:
            continue
        cleaned.append(sentence)
        normalized_seen.append(normalized)

    return " ".join(cleaned)


def _split_text_at_space(text: str, split_at: int) -> tuple[str, str]:
    split_at = max(1, min(len(text) - 1, split_at))
    candidates = [
        text.rfind(" ", 0, split_at + 1),
        text.find(" ", split_at),
    ]
    candidates = [candidate for candidate in candidates if candidate > 0]
    if candidates:
        split_at = min(candidates, key=lambda candidate: abs(candidate - split_at))
    return text[:split_at].strip(), text[split_at:].strip()


def _split_text_by_weights(text: str, weights: list[float]) -> list[str]:
    normalized = " ".join(str(text or "").split())
    if not normalized or not weights:
        return []

    weights = [max(0.01, float(weight or 0.0)) for weight in weights]
    sentences = _split_sentences(normalized)
    if len(sentences) >= len(weights):
        total_weight = sum(weights)
        chunks: list[str] = []
        cursor = 0
        for index, weight in enumerate(weights):
            remaining_groups = len(weights) - index
            remaining_sentences = len(sentences) - cursor
            if remaining_groups <= 1:
                take = remaining_sentences
            else:
                take = max(1, round(len(sentences) * (weight / total_weight)))
                take = min(take, remaining_sentences - remaining_groups + 1)
            chunks.append(" ".join(sentences[cursor:cursor + take]).strip())
            cursor += take
        return chunks

    chunks = []
    remaining = normalized
    remaining_weights = list(weights)
    while remaining_weights:
        if len(remaining_weights) == 1:
            chunks.append(remaining.strip())
            break
        total_weight = sum(remaining_weights)
        target = round(len(remaining) * (remaining_weights[0] / total_weight))
        chunk, remaining = _split_text_at_space(remaining, target)
        chunks.append(chunk)
        remaining_weights.pop(0)
    return chunks


def _replace_group_texts_from_transcript(
    groups: list[dict[str, Any]],
    transcript_text: str | None,
) -> list[dict[str, Any]]:
    if not groups or not str(transcript_text or "").strip():
        return groups
    transcript_text = remove_repeated_sentences(str(transcript_text))
    weights = [
        max(0.01, float(group.get("end", 0.0) or 0.0) - float(group.get("start", 0.0) or 0.0))
        for group in groups
    ]
    chunks = _split_text_by_weights(str(transcript_text), weights)
    if len(chunks) != len(groups):
        return groups
    replaced = []
    for group, chunk in zip(groups, chunks):
        item = dict(group)
        item["text"] = chunk
        item["text_source"] = "transcript"
        replaced.append(item)
    return replaced


def build_display_segments_from_transcript(
    transcript_text: str,
    timing_segments: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    """Build sentence-like display segments from transcript text.

    These segments are for UI readability. Their timing is approximate, derived
    from the full aligned time span and sentence character weights. Speaker
    alignment should use the shorter timing segments instead.
    """

    sentences = _split_sentences(remove_repeated_sentences(transcript_text))
    if not sentences:
        return []
    timed = [
        segment
        for segment in timing_segments
        if _segment_end(segment) > _segment_start(segment)
    ]
    if not timed:
        return [{"start": 0.0, "end": 0.0, "text": sentence, "timing_approximate": True} for sentence in sentences]

    start = min(_segment_start(segment) for segment in timed)
    end = max(_segment_end(segment) for segment in timed)
    duration = max(0.0, end - start)
    total_chars = max(1, sum(len(sentence) for sentence in sentences))
    cursor = start
    display_segments: list[dict[str, Any]] = []
    for index, sentence in enumerate(sentences):
        if index == len(sentences) - 1:
            sentence_end = end
        else:
            sentence_duration = duration * (len(sentence) / total_chars)
            sentence_end = min(end, cursor + sentence_duration)
        display_segments.append({
            "start": cursor,
            "end": sentence_end,
            "text": sentence,
            "timing_approximate": True,
            "display_only": True,
        })
        cursor = sentence_end
    return display_segments


def _merge_short_tail_groups(
    groups: list[dict[str, Any]],
    *,
    gap_seconds: float,
    min_chars: int,
) -> list[dict[str, Any]]:
    merged: list[dict[str, Any]] = []
    for utterance in groups:
        if (
            merged
            and len(str(utterance.get("text", ""))) < min_chars
            and float(utterance.get("start", 0.0)) - float(merged[-1].get("end", 0.0)) < gap_seconds
        ):
            merged[-1]["text"] = _append_text(str(merged[-1].get("text", "")), str(utterance.get("text", "")))
            merged[-1]["end"] = utterance["end"]
        else:
            merged.append(utterance)
    return merged


def merge_aligner_segments_to_utterances(
    segments: list[dict[str, Any]],
    *,
    transcript_text: str | None = None,
    max_chars: int = 60,
    max_seconds: float = 5.0,
    gap_seconds: float = 0.8,
    min_chars: int = 12,
    sentence_endings: tuple[str, ...] = DEFAULT_SENTENCE_ENDINGS,
) -> list[dict[str, Any]]:
    """Merge Qwen ForcedAligner word/short segments into readable utterances.

    Qwen3-ASR returns one transcript segment by default. With ForcedAligner it can
    return word-level timestamps, which are too granular for speaker alignment
    and meeting minutes. When the full transcript is supplied, the aligner output
    is used for timing groups and the final text is restored from the transcript.
    """

    groups = _build_timing_groups(
        segments,
        max_chars=max_chars,
        max_seconds=max_seconds,
        gap_seconds=gap_seconds,
        min_chars=min_chars,
        sentence_endings=sentence_endings,
    )
    groups = _merge_short_tail_groups(groups, gap_seconds=gap_seconds, min_chars=min_chars)
    return _replace_group_texts_from_transcript(groups, transcript_text)
