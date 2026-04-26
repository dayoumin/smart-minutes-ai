import os
import json
from typing import List, Dict, Any

def save_result_json(result_data: Dict[str, Any], output_path: str) -> str:
    """Save the full intermediate result as JSON."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result_data, f, ensure_ascii=False, indent=2)
    return output_path

def export_txt(segments: List[Dict], output_path: str) -> str:
    """
    STT 결과를 단순 TXT 파일로 저장한다. 화자 정보가 있으면 포함한다.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    with open(output_path, "w", encoding="utf-8") as f:
        for seg in segments:
            start = seg.get("start", 0.0)
            end = seg.get("end", 0.0)
            text = seg.get("text", "")
            speaker = seg.get("speaker_name", "")
            
            # 포맷: [00:00:00] 화자: 텍스트
            start_min = int(start // 60)
            start_sec = int(start % 60)
            start_hour = int(start_min // 60)
            start_min = start_min % 60
            
            time_str = f"[{start_hour:02d}:{start_min:02d}:{start_sec:02d}]"
            
            if speaker:
                f.write(f"{time_str} {speaker}: {text}\n")
            else:
                f.write(f"{time_str} {text}\n")
            
    return output_path
