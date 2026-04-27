import re
from typing import List, Dict


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

def align_segments_with_speakers(
    transcript_segments: List[Dict],
    speaker_segments: List[Dict]
) -> List[Dict]:
    """
    STT 문장 구간과 화자 구간의 overlap을 계산하여
    각 STT 문장에 화자 정보를 매칭한다.
    """
    aligned_segments = []
    
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
        if t_seg.get("timing_approximate") and len(meaningful) > 1 and t_duration > 0:
            text_chunks = _split_text_by_weights(t_seg.get("text", ""), [item[0] for item in meaningful])
            for item, text_chunk in zip(meaningful, text_chunks):
                _overlap, start, end, speaker = item
                aligned_seg = t_seg.copy()
                aligned_seg["start"] = start
                aligned_seg["end"] = end
                aligned_seg["text"] = text_chunk
                aligned_seg["speaker"] = speaker
                aligned_seg["speaker_name"] = speaker.replace("SPEAKER_", "화자")
                aligned_segments.append(aligned_seg)
            continue

        _overlap, _start, _end, best_speaker = max(overlaps, key=lambda item: item[0])
        aligned_seg = t_seg.copy()
        aligned_seg["speaker"] = best_speaker
        aligned_seg["speaker_name"] = best_speaker.replace("SPEAKER_", "화자")
        aligned_segments.append(aligned_seg)
        
    return aligned_segments
