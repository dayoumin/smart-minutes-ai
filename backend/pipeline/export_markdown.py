import os

def export_markdown(result: dict, output_path: str) -> str:
    """
    result.json 기반으로 Markdown 파일을 생성한다.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    summary = result.get("summary", {})
    
    md_content = f"# {summary.get('title', '회의록')}\n\n"
    md_content += f"**파일명:** {result.get('source_file', '')}\n"
    md_content += f"**처리일시:** {result.get('created_at', '')}\n\n"
    
    md_content += "## 1. 회의 요약\n\n"
    md_content += f"{summary.get('overview', '내용 없음')}\n\n"
    
    md_content += "## 2. 주요 논의사항\n\n"
    for topic in summary.get("topics", []):
        md_content += f"- {topic}\n"
    md_content += "\n"
        
    md_content += "## 3. 결정사항\n\n"
    for dec in summary.get("decisions", []):
        md_content += f"- {dec}\n"
    md_content += "\n"
        
    md_content += "## 4. 할 일\n\n"
    for act in summary.get("actions", []):
        md_content += f"- {act}\n"
    md_content += "\n"
        
    md_content += "## 5. 확인 필요 사항\n\n"
    for chk in summary.get("needs_check", []):
        md_content += f"- {chk}\n"
    md_content += "\n"
        
    md_content += "## 6. 화자별 원문\n\n"
    for seg in result.get("segments", []):
        start = seg.get("start", 0.0)
        start_min = int(start // 60)
        start_sec = int(start % 60)
        time_str = f"[{start_min:02d}:{start_sec:02d}]"
        
        speaker = seg.get("speaker_name", "")
        text = seg.get("text", "")
        
        if speaker:
            md_content += f"**{time_str} {speaker}:** {text}\n\n"
        else:
            md_content += f"**{time_str}:** {text}\n\n"
            
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(md_content)
        
    return output_path
