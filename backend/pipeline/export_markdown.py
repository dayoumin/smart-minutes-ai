import os

from pipeline.transcript_display import get_transcript_segments


def _format_time(value) -> str:
    if isinstance(value, str):
        return value

    try:
        seconds = float(value)
    except (TypeError, ValueError):
        seconds = 0.0

    minutes = int(seconds // 60)
    sec = int(seconds % 60)
    return f"{minutes:02d}:{sec:02d}"


def export_markdown(result: dict, output_path: str) -> str:
    """
    result.json 기반으로 Markdown 파일을 생성한다.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    summary = result.get("summary", {})
    section_no = 1
    
    md_content = f"# {summary.get('title', '회의록')}\n\n"
    md_content += f"**파일명:** {result.get('source_file', '')}\n"
    md_content += f"**처리일시:** {result.get('created_at', '')}\n\n"
    if result.get("meeting_purpose"):
        md_content += f"**회의 목적:** {result.get('meeting_purpose', '')}\n\n"
    
    md_content += f"## {section_no}. 회의 요약\n\n"
    section_no += 1
    md_content += f"{summary.get('overview', '내용 없음')}\n\n"
    
    md_content += f"## {section_no}. 주요 주제\n\n"
    section_no += 1
    for topic in summary.get("topics", []):
        md_content += f"- {topic}\n"
    md_content += "\n"

    topic_sections = summary.get("topic_sections", []) or []
    if topic_sections:
        md_content += f"## {section_no}. 주제별 내용\n\n"
        section_no += 1
        for section in topic_sections:
            md_content += f"### {section.get('topic', '주제')}\n\n"
            if section.get("summary"):
                md_content += f"{section.get('summary')}\n\n"
            for evidence in section.get("evidence", []) or []:
                md_content += f"- 근거: {evidence}\n"
            for action in section.get("actions", []) or []:
                md_content += f"- 할 일: {action}\n"
            md_content += "\n"

    participant_summaries = summary.get("participant_summaries", []) or []
    if participant_summaries:
        md_content += f"## {section_no}. 발언자별 요약 AI 초안\n\n"
        section_no += 1
        for participant in participant_summaries:
            md_content += f"### {participant.get('participant', '발언자')}\n\n"
            if participant.get("summary"):
                md_content += f"{participant.get('summary')}\n\n"
            for point in participant.get("key_points", []) or []:
                md_content += f"- 핵심: {point}\n"
            for action in participant.get("actions", []) or []:
                md_content += f"- 할 일: {action}\n"
            md_content += "\n"
        
    md_content += f"## {section_no}. 결정사항\n\n"
    section_no += 1
    for dec in summary.get("decisions", []):
        md_content += f"- {dec}\n"
    md_content += "\n"
        
    md_content += f"## {section_no}. 할 일\n\n"
    section_no += 1
    for act in summary.get("actions", []):
        md_content += f"- {act}\n"
    md_content += "\n"
        
    md_content += f"## {section_no}. 확인 필요 사항\n\n"
    section_no += 1
    for chk in summary.get("needs_check", []):
        md_content += f"- {chk}\n"
    md_content += "\n"
        
    md_content += f"## {section_no}. 대화록\n\n"
    for seg in get_transcript_segments(result):
        time_str = f"[{_format_time(seg.get('start', 0.0))}]"
        speaker = seg.get("speaker_name") or seg.get("speaker") or ""
        text = seg.get("text", "")
        
        if speaker:
            md_content += f"**{time_str} {speaker}:** {text}\n\n"
        else:
            md_content += f"**{time_str}:** {text}\n\n"
            
    with open(output_path, "w", encoding="utf-8") as f:
        f.write(md_content)
        
    return output_path
