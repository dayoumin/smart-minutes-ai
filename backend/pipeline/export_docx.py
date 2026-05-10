import os
from docx import Document
from docx.shared import Pt, Inches


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


def export_docx(
    result: dict,
    output_path: str,
    template_path: str = None
) -> str:
    """
    result.json 기반으로 DOCX 파일을 생성한다.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    if template_path and os.path.exists(template_path):
        doc = Document(template_path)
    else:
        doc = Document()
        
    summary = result.get("summary", {})
    title = summary.get("title", "회의록")
    section_no = 1
    
    # 제목
    doc.add_heading(title, 0)
    
    # 메타 정보
    doc.add_paragraph(f"파일명: {result.get('source_file', '')}")
    doc.add_paragraph(f"처리일시: {result.get('created_at', '')}")
    
    # 회의 요약
    doc.add_heading(f"{section_no}. 회의 요약", level=1)
    section_no += 1
    doc.add_paragraph(summary.get("overview", "내용 없음"))
    
    # 주요 주제
    doc.add_heading(f"{section_no}. 주요 주제", level=1)
    section_no += 1
    for topic in summary.get("topics", []):
        doc.add_paragraph(topic, style='List Bullet')

    topic_sections = summary.get("topic_sections", []) or []
    if topic_sections:
        doc.add_heading(f"{section_no}. 주제별 내용", level=1)
        section_no += 1
        for section in topic_sections:
            doc.add_heading(section.get("topic", "주제"), level=2)
            if section.get("summary"):
                doc.add_paragraph(section.get("summary"))
            for evidence in section.get("evidence", []) or []:
                doc.add_paragraph(f"근거: {evidence}", style='List Bullet')
            for action in section.get("actions", []) or []:
                doc.add_paragraph(f"할 일: {action}", style='List Bullet')

    participant_summaries = summary.get("participant_summaries", []) or []
    if participant_summaries:
        doc.add_heading(f"{section_no}. 발언자별 요약 AI 초안", level=1)
        section_no += 1
        for participant in participant_summaries:
            doc.add_heading(participant.get("participant", "발언자"), level=2)
            if participant.get("summary"):
                doc.add_paragraph(participant.get("summary"))
            for point in participant.get("key_points", []) or []:
                doc.add_paragraph(f"핵심: {point}", style='List Bullet')
            for action in participant.get("actions", []) or []:
                doc.add_paragraph(f"할 일: {action}", style='List Bullet')
        
    # 결정사항
    doc.add_heading(f"{section_no}. 결정사항", level=1)
    section_no += 1
    for dec in summary.get("decisions", []):
        doc.add_paragraph(dec, style='List Bullet')
        
    # 할 일
    doc.add_heading(f"{section_no}. 할 일", level=1)
    section_no += 1
    for act in summary.get("actions", []):
        doc.add_paragraph(act, style='List Bullet')
        
    # 확인 필요 사항
    doc.add_heading(f"{section_no}. 확인 필요 사항", level=1)
    section_no += 1
    for chk in summary.get("needs_check", []):
        doc.add_paragraph(chk, style='List Bullet')
        
    # 대화록
    doc.add_heading(f"{section_no}. 대화록", level=1)
    segments = result.get("segments", [])
    for seg in segments:
        time_str = f"[{_format_time(seg.get('start', 0.0))}]"
        speaker = seg.get("speaker_name") or seg.get("speaker") or ""
        text = seg.get("text", "")
        
        p = doc.add_paragraph()
        if speaker:
            p.add_run(f"{time_str} {speaker}: ").bold = True
        else:
            p.add_run(f"{time_str} ").bold = True
        p.add_run(text)
        
    doc.save(output_path)
    return output_path
