import os
import re

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


def _meeting_report_sections(result: dict, *, include_empty: bool = False) -> list[dict]:
    report = result.get("meeting_report") or {}
    if not isinstance(report, dict):
        report = {}

    sections = []
    for item in report.get("sections") or []:
        if not isinstance(item, dict):
            continue
        raw_title = str(item.get("title") or "").strip()
        content = str(item.get("content") or "").strip()
        if raw_title or content:
            sections.append({"title": raw_title or "보고서", "content": content})

    content = str(report.get("content") or "").strip()
    if not sections and content:
        sections.append({"title": "회의록 보고서", "content": content})
    if not sections and include_empty:
        sections.append({"title": "회의록 보고서", "content": "보고서 내용이 없습니다."})
    return sections


def _normalized_report_text(value: str) -> str:
    return re.sub(r"\s+", "", value or "")


def _meeting_report_intro(result: dict, sections: list[dict]) -> str:
    report = result.get("meeting_report") or {}
    if not isinstance(report, dict):
        return ""

    content = str(report.get("content") or "").strip()
    if not content or not sections:
        return ""

    section_content = "\n".join(str(section.get("content") or "") for section in sections)
    section_with_titles = "\n".join(
        f"{section.get('title') or '보고서'}\n{section.get('content') or ''}"
        for section in sections
    )
    content_key = _normalized_report_text(content)
    if content_key in {
        _normalized_report_text(section_content),
        _normalized_report_text(section_with_titles),
    }:
        return ""
    return content


def _render_meeting_report(result: dict, section_no: int, *, include_empty: bool = False) -> tuple[str, int]:
    sections = _meeting_report_sections(result, include_empty=include_empty)
    if not sections:
        return "", section_no

    content = f"## {section_no}. 회의록 보고서\n\n"
    section_no += 1
    intro = _meeting_report_intro(result, sections)
    if intro:
        content += f"### 보고서 개요\n\n{intro}\n\n"
    for section in sections:
        content += f"### {section.get('title') or '보고서'}\n\n"
        content += f"{section.get('content') or '내용 없음'}\n\n"
    return content, section_no


def export_markdown(result: dict, output_path: str) -> str:
    """
    result.json 기반으로 Markdown 파일을 생성한다.
    """
    os.makedirs(os.path.dirname(output_path), exist_ok=True)
    
    summary = result.get("summary", {})
    export_scope = result.get("export_scope") or "full"
    section_no = 1
    
    md_content = f"# {summary.get('title', '회의록')}\n\n"
    md_content += f"**파일명:** {result.get('source_file', '')}\n"
    md_content += f"**처리일시:** {result.get('created_at', '')}\n\n"
    if result.get("meeting_purpose"):
        md_content += f"**회의 목적:** {result.get('meeting_purpose', '')}\n\n"

    if export_scope == "report":
        report_content, section_no = _render_meeting_report(result, section_no, include_empty=True)
        md_content += report_content
        with open(output_path, "w", encoding="utf-8") as f:
            f.write(md_content)
        return output_path

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
        md_content += f"## {section_no}. 참석자별 요약 AI 초안\n\n"
        section_no += 1
        for participant in participant_summaries:
            md_content += f"### {participant.get('participant', '참석자')}\n\n"
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

    if export_scope == "full":
        report_content, section_no = _render_meeting_report(result, section_no)
        md_content += report_content

    if export_scope != "organized":
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
