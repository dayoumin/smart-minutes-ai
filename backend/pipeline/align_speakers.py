from typing import List, Dict

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
        
        max_overlap = 0.0
        best_speaker = "UNKNOWN"
        
        for s_seg in speaker_segments:
            s_start = s_seg["start"]
            s_end = s_seg["end"]
            
            # 겹치는 구간 계산
            overlap_start = max(t_start, s_start)
            overlap_end = min(t_end, s_end)
            overlap = max(0.0, overlap_end - overlap_start)
            
            if overlap > max_overlap:
                max_overlap = overlap
                best_speaker = s_seg["speaker"]
                
        # 매칭된 화자 정보 추가
        aligned_seg = t_seg.copy()
        aligned_seg["speaker"] = best_speaker
        # 초기 이름은 SPEAKER_00 와 동일하게 하거나 임의로 부여 가능
        aligned_seg["speaker_name"] = best_speaker.replace("SPEAKER_", "화자") 
        aligned_segments.append(aligned_seg)
        
    return aligned_segments
