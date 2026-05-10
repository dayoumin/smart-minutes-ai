import html
import os
import zipfile
from typing import Any


def _paragraph(text: str) -> str:
    escaped = html.escape(text or "")
    return f'<hp:p><hp:run><hp:t xml:space="preserve">{escaped}</hp:t></hp:run></hp:p>'


def _line_items(title: str, items: list[str]) -> list[str]:
    paragraphs = [_paragraph(title)]
    if items:
        paragraphs.extend(_paragraph(f"- {item}") for item in items)
    else:
        paragraphs.append(_paragraph("- 없음"))
    return paragraphs


def _topic_section_items(sections: list[dict]) -> list[str]:
    paragraphs = [_paragraph("3. 주제별 내용")]
    if not sections:
        paragraphs.append(_paragraph("- 없음"))
        return paragraphs

    for section in sections:
        paragraphs.append(_paragraph(f"- {section.get('topic') or '주제'}"))
        if section.get("summary"):
            paragraphs.append(_paragraph(f"  {section.get('summary')}"))
        for evidence in section.get("evidence", []) or []:
            paragraphs.append(_paragraph(f"  근거: {evidence}"))
        for action in section.get("actions", []) or []:
            paragraphs.append(_paragraph(f"  할 일: {action}"))
    return paragraphs


def _participant_summary_items(items: list[dict]) -> list[str]:
    paragraphs = [_paragraph("4. 발언자별 요약 AI 초안")]
    if not items:
        paragraphs.append(_paragraph("- 없음"))
        return paragraphs

    for item in items:
        paragraphs.append(_paragraph(f"- {item.get('participant') or '발언자'}"))
        if item.get("summary"):
            paragraphs.append(_paragraph(f"  {item.get('summary')}"))
        for point in item.get("key_points", []) or []:
            paragraphs.append(_paragraph(f"  핵심: {point}"))
        for action in item.get("actions", []) or []:
            paragraphs.append(_paragraph(f"  할 일: {action}"))
    return paragraphs


def _format_time(value: Any) -> str:
    if isinstance(value, str):
        return value
    try:
        seconds = max(0.0, float(value or 0.0))
    except (TypeError, ValueError):
        return "00:00:00"

    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    return f"{hours:02d}:{minutes:02d}:{secs:02d}"


def export_hwpx(result: dict, output_path: str) -> str:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    summary = result.get("summary", {}) or {}
    title = summary.get("title") or "회의록"
    segments = result.get("segments", []) or []

    paragraphs = [
        _paragraph(title),
        _paragraph(f"원본 파일: {result.get('source_file', '')}"),
        _paragraph(f"처리 일시: {result.get('created_at', '')}"),
        _paragraph(""),
        _paragraph("1. 회의 요약"),
        _paragraph(summary.get("overview") or "내용 없음"),
        *_line_items("2. 주요 주제", summary.get("topics", []) or []),
        *_topic_section_items(summary.get("topic_sections", []) or []),
        *_participant_summary_items(summary.get("participant_summaries", []) or []),
        *_line_items("5. 결정 사항", summary.get("decisions", []) or []),
        *_line_items("6. 할 일", summary.get("actions", []) or []),
        *_line_items("7. 확인 필요 사항", summary.get("needs_check", []) or []),
        _paragraph("8. 대화록"),
    ]

    if segments:
        for segment in segments:
            start = _format_time(segment.get("start", 0.0))
            end = _format_time(segment.get("end", 0.0))
            speaker = segment.get("speaker_name") or segment.get("speaker") or "Speaker"
            text = segment.get("text", "")
            timing = " 시간 추정" if segment.get("timing_approximate") else ""
            paragraphs.append(_paragraph(f"[{start}-{end}{timing}] {speaker}: {text}"))
    else:
        paragraphs.append(_paragraph("대화록 데이터가 없습니다."))

    section_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
{''.join(paragraphs)}
</hs:sec>
'''
    version_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<version app="NFIS 스마트 회의시스템" version="1.0"/>
'''
    content_hpf = '''<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" unique-identifier="uid">
  <opf:metadata><opf:title>NFIS 스마트 회의시스템 회의록</opf:title></opf:metadata>
  <opf:manifest><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest>
  <opf:spine><opf:itemref idref="section0"/></opf:spine>
</opf:package>
'''
    container_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
  </rootfiles>
</container>
'''

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
        archive.writestr("META-INF/container.xml", container_xml)
        archive.writestr("version.xml", version_xml)
        archive.writestr("Contents/content.hpf", content_hpf)
        archive.writestr("Contents/section0.xml", section_xml)

    return output_path
