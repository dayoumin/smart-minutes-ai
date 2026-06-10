import re
from typing import List, Dict


SHORT_SPEAKER_TURN_SECONDS = 1.2
SPEAKER_TURN_BRIDGE_GAP_SECONDS = 0.8
SPEAKER_TURN_OVERLAP_TOLERANCE_SECONDS = 0.15


def _display_speaker_name(speaker: str) -> str:
    match = re.match(r"^SPEAKER[_\s-]?(\d+)$", str(speaker or ""), re.IGNORECASE)
    if match:
        return f"참석자{int(match.group(1)) + 1:02d}"
    return str(speaker or "참석자").strip() or "참석자"


def _split_text_by_weights(text: str, weights: List[float]) -> List[str]:
    if not text.strip() or not weights:
        return [text]

    sentences = [item.strip() for item in re.split(r"(?<=[.!?。！？])\s+", text) if item.strip()]
    if len(sentences) >= len(weights):
        total_weight = sum(weights) or float(len(weights))
        chunks: List[str] = []
        cursor = 0
        for index, weight in enumerate(weights):
            remaining_groups = len(weights) - index
            remaining_sentences = len(sentences) - cursor
            take = max(1, round(len(sentences) * (weight / total_weight)))
            take = min(take, remaining_sentences - remaining_groups + 1)
            chunks.append(" ".join(sentences[cursor:cursor + take]).strip())
            cursor += take
        if cursor < len(sentences):
            chunks[-1] = f"{chunks[-1]} {' '.join(sentences[cursor:])}".strip()
        return chunks

    total_chars = len(text)
    total_weight = sum(weights) or float(len(weights))
    chunks = []
    cursor = 0
    for index, weight in enumerate(weights):
        if index == len(weights) - 1:
            chunks.append(text[cursor:].strip())
            break
        take = max(1, round(total_chars * (weight / total_weight)))
        split_at = min(total_chars, cursor + take)
        space_at = text.rfind(" ", cursor, split_at)
        if space_at > cursor:
            split_at = space_at
        chunks.append(text[cursor:split_at].strip())
        cursor = split_at
    return chunks


def smooth_short_speaker_turns(
    speaker_segments: List[Dict],
    *,
    max_short_turn_seconds: float = SHORT_SPEAKER_TURN_SECONDS,
    max_bridge_gap_seconds: float = SPEAKER_TURN_BRIDGE_GAP_SECONDS,
    max_overlap_tolerance_seconds: float = SPEAKER_TURN_OVERLAP_TOLERANCE_SECONDS,
) -> List[Dict]:
    """
    Relabel very short speaker flips when the same speaker continues on both sides.
    This reduces diarization flicker without changing durable speaker changes.
    """
    normalized: List[Dict] = []
    for segment in speaker_segments or []:
        try:
            start = float(segment.get("start", 0.0))
            end = float(segment.get("end", start))
        except (TypeError, ValueError):
            continue
        speaker = str(segment.get("speaker") or "").strip()
        if not speaker or end <= start:
            continue
        normalized.append({**segment, "start": start, "end": end, "speaker": speaker})

    normalized.sort(key=lambda item: (item["start"], item["end"]))
    if len(normalized) < 3:
        return normalized

    smoothed = [item.copy() for item in normalized]
    for index in range(1, len(smoothed) - 1):
        previous = smoothed[index - 1]
        current = smoothed[index]
        next_item = smoothed[index + 1]
        duration = current["end"] - current["start"]
        previous_gap = current["start"] - previous["end"]
        next_gap = next_item["start"] - current["end"]
        if (
            duration <= max_short_turn_seconds
            and previous["speaker"] == next_item["speaker"]
            and current["speaker"] != previous["speaker"]
            and -max_overlap_tolerance_seconds <= previous_gap <= max_bridge_gap_seconds
            and -max_overlap_tolerance_seconds <= next_gap <= max_bridge_gap_seconds
        ):
            current["speaker"] = previous["speaker"]
            current["speaker_name"] = _display_speaker_name(previous["speaker"])
            current["speaker_smoothed"] = True

    merged: List[Dict] = []
    for segment in smoothed:
        previous = merged[-1] if merged else None
        if (
            previous
            and previous.get("speaker") == segment.get("speaker")
            and segment["start"] - previous["end"] <= max_bridge_gap_seconds
        ):
            previous["end"] = max(previous["end"], segment["end"])
            previous["speaker_smoothed"] = bool(previous.get("speaker_smoothed")) or bool(segment.get("speaker_smoothed"))
            continue
        merged.append(segment)
    return merged


def _should_split_for_speaker_change(t_seg: Dict, meaningful: List[tuple], t_duration: float) -> bool:
    if len(meaningful) <= 1 or t_duration <= 0:
        return False
    if t_seg.get("timing_approximate") or t_seg.get("split_on_speaker_change"):
        return True
    if t_duration < 8.0:
        return False

    ordered_by_overlap = sorted(meaningful, key=lambda item: item[0], reverse=True)
    best_overlap = ordered_by_overlap[0][0]
    second_overlap = ordered_by_overlap[1][0]
    return second_overlap >= 2.0 and best_overlap / t_duration < 0.8


def _split_time_ranges_preserving_transcript_bounds(
    meaningful: List[tuple],
    transcript_start: float,
    transcript_end: float,
) -> tuple[List[tuple[float, float]], bool, bool]:
    ranges: List[tuple[float, float]] = []
    has_gap = False
    has_overlap = False
    if not meaningful:
        return ranges, False, False

    boundaries: List[float] = []
    for index in range(len(meaningful) - 1):
        current_end = meaningful[index][2]
        next_start = meaningful[index + 1][1]
        if next_start > current_end:
            has_gap = True
        elif next_start < current_end:
            has_overlap = True
        boundary = current_end + ((next_start - current_end) / 2.0)
        boundaries.append(min(max(boundary, transcript_start), transcript_end))

    for index, item in enumerate(meaningful):
        _overlap, _overlap_start, _overlap_end, _speaker = item
        start = transcript_start if index == 0 else boundaries[index - 1]
        end = transcript_end if index == len(meaningful) - 1 else boundaries[index]
        ranges.append((start, max(start, end)))

    if ranges and (ranges[0][0] > transcript_start or ranges[-1][1] < transcript_end):
        has_gap = True
    return ranges, has_gap, has_overlap


def align_segments_with_speakers(
    transcript_segments: List[Dict],
    speaker_segments: List[Dict]
) -> List[Dict]:
    """
    STT 문장 구간과 참석자 구간의 overlap을 계산하여
    각 STT 문장에 참석자 정보를 매칭한다.
    """
    aligned_segments = []
    speaker_segments = smooth_short_speaker_turns(speaker_segments)
    
    for t_seg in transcript_segments:
        t_start = t_seg["start"]
        t_end = t_seg["end"]
        t_duration = t_end - t_start
        
        overlaps = []
        
        for s_seg in speaker_segments:
            s_start = s_seg["start"]
            s_end = s_seg["end"]
            
            # 겹치는 구간 계산
            overlap_start = max(t_start, s_start)
            overlap_end = min(t_end, s_end)
            overlap = max(0.0, overlap_end - overlap_start)
            
            if overlap > 0:
                overlaps.append((overlap, overlap_start, overlap_end, s_seg["speaker"]))

        if not overlaps:
            aligned_seg = t_seg.copy()
            aligned_seg["speaker"] = "UNKNOWN"
            aligned_seg["speaker_name"] = "UNKNOWN"
            aligned_segments.append(aligned_seg)
            continue

        overlaps.sort(key=lambda item: item[1])
        meaningful = [item for item in overlaps if item[0] >= 1.0]
        has_short_speaker_overlap = any(item[0] < 1.0 for item in overlaps)
        if _should_split_for_speaker_change(t_seg, meaningful, t_duration):
            text_chunks = _split_text_by_weights(t_seg.get("text", ""), [item[0] for item in meaningful])
            time_ranges, has_coverage_gap, has_coverage_overlap = _split_time_ranges_preserving_transcript_bounds(meaningful, t_start, t_end)
            for item, text_chunk, (start, end) in zip(meaningful, text_chunks, time_ranges):
                _overlap, _overlap_start, _overlap_end, speaker = item
                aligned_seg = t_seg.copy()
                aligned_seg["start"] = start
                aligned_seg["end"] = end
                aligned_seg["text"] = text_chunk
                aligned_seg["speaker"] = speaker
                aligned_seg["speaker_name"] = _display_speaker_name(speaker)
                aligned_seg["mixed_speaker_split"] = True
                if has_coverage_gap or has_coverage_overlap or has_short_speaker_overlap:
                    aligned_seg["speaker_needs_review"] = True
                if has_coverage_gap:
                    aligned_seg["speaker_split_coverage_gap"] = True
                if has_coverage_overlap:
                    aligned_seg["speaker_split_coverage_overlap"] = True
                if has_short_speaker_overlap:
                    aligned_seg["short_speaker_overlap"] = True
                aligned_segments.append(aligned_seg)
            continue

        _overlap, _start, _end, best_speaker = max(overlaps, key=lambda item: item[0])
        aligned_seg = t_seg.copy()
        aligned_seg["speaker"] = best_speaker
        aligned_seg["speaker_name"] = _display_speaker_name(best_speaker)
        if has_short_speaker_overlap and len({item[3] for item in overlaps}) > 1:
            aligned_seg["speaker_needs_review"] = True
            aligned_seg["short_speaker_overlap"] = True
        aligned_segments.append(aligned_seg)
        
    return aligned_segments
