import os
from docx import Document
from docx.shared import Pt, Inches

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
    
    # 제목
    doc.add_heading(title, 0)
    
    # 메타 정보
    doc.add_paragraph(f"파일명: {result.get('source_file', '')}")
    doc.add_paragraph(f"처리일시: {result.get('created_at', '')}")
    
    # 1. 회의 요약
    doc.add_heading("1. 회의 요약", level=1)
    doc.add_paragraph(summary.get("overview", "내용 없음"))
    
    # 2. 주요 논의사항
    doc.add_heading("2. 주요 논의사항", level=1)
    for topic in summary.get("topics", []):
        doc.add_paragraph(topic, style='List Bullet')
        
    # 3. 결정사항
    doc.add_heading("3. 결정사항", level=1)
    for dec in summary.get("decisions", []):
        doc.add_paragraph(dec, style='List Bullet')
        
    # 4. 할 일
    doc.add_heading("4. 할 일", level=1)
    for act in summary.get("actions", []):
        doc.add_paragraph(act, style='List Bullet')
        
    # 5. 확인 필요 사항
    doc.add_heading("5. 확인 필요 사항", level=1)
    for chk in summary.get("needs_check", []):
        doc.add_paragraph(chk, style='List Bullet')
        
    # 6. 화자별 원문
    doc.add_heading("6. 화자별 원문", level=1)
    segments = result.get("segments", [])
    for seg in segments:
        start = seg.get("start", 0.0)
        start_min = int(start // 60)
        start_sec = int(start % 60)
        time_str = f"[{start_min:02d}:{start_sec:02d}]"
        
        speaker = seg.get("speaker_name", "")
        text = seg.get("text", "")
        
        p = doc.add_paragraph()
        if speaker:
            p.add_run(f"{time_str} {speaker}: ").bold = True
        else:
            p.add_run(f"{time_str} ").bold = True
        p.add_run(text)
        
    doc.save(output_path)
    return output_path
