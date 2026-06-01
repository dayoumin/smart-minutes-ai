import os
import json
from typing import List, Dict, Any

def save_result_json(result_data: Dict[str, Any], output_path: str) -> str:
    """Save the full intermediate result as JSON."""
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    with open(output_path, "w", encoding="utf-8") as f:
        json.dump(result_data, f, ensure_ascii=False, indent=2)
    return output_path


def _format_time(value) -> str:
    if isinstance(value, str):
        return value

    try:
        seconds = float(value)
    except (TypeError, ValueError):
        seconds = 0.0

    start_min = int(seconds // 60)
    start_sec = int(seconds % 60)
    start_hour = int(start_min // 60)
    start_min = start_min % 60
    return f"{start_hour:02d}:{start_min:02d}:{start_sec:02d}"


def export_txt(segments: List[Dict], output_path: str) -> str:
    """
    STT 결과를 단순 TXT 파일로 저장한다. 참석자 정보가 있으면 포함한다.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    with open(output_path, "w", encoding="utf-8") as f:
        if not segments:
            f.write("발화 스크립트 데이터가 없습니다.\n")
            return output_path

        for seg in segments:
            text = seg.get("text", "")
            speaker = seg.get("speaker_name") or seg.get("speaker") or ""
            
            # 포맷: [00:00:00] 참석자: 텍스트
            time_str = f"[{_format_time(seg.get('start', 0.0))}]"
            
            if speaker:
                f.write(f"{time_str} {speaker}: {text}\n")
            else:
                f.write(f"{time_str} {text}\n")
            
    return output_path
