import html
import os
import re
import zipfile
from typing import Any

from pipeline.transcript_display import get_transcript_segments


XML_NAMESPACES = '''xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph"
        xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"
        xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"
        xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"
        xmlns:hpf="http://www.hancom.co.kr/schema/2011/hpf"
        xmlns:dc="http://purl.org/dc/elements/1.1/"
        xmlns:opf="http://www.idpf.org/2007/opf/"
        xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0"'''


def _paragraph(text: str) -> str:
    escaped = html.escape(text or "")
    return f'<hp:p><hp:run><hp:t xml:space="preserve">{escaped}</hp:t></hp:run></hp:p>'


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


def _meeting_report_text_items(title: str, result: dict, *, include_empty: bool = False) -> list[str]:
    sections = _meeting_report_sections(result, include_empty=include_empty)
    if not sections:
        return []

    lines = [title]
    intro = _meeting_report_intro(result, sections)
    if intro:
        lines.append("")
        lines.append("보고서 개요")
        lines.extend(_report_text_lines(intro))
    section_prefix = _section_number_prefix(title)
    for index, section in enumerate(sections, start=1):
        lines.append("")
        lines.append(f"{section_prefix}.{index} {section.get('title') or '보고서'}")
        lines.extend(_report_text_lines(section.get("content") or "내용 없음"))
    return lines


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


def _report_text_lines(text: str) -> list[str]:
    lines: list[str] = []
    for raw_line in str(text or "").replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        line = raw_line.strip()
        if not line:
            continue
        bullet_match = re.match(r"^[-*•]\s+(.+)$", line)
        if bullet_match:
            lines.append(f"· {bullet_match.group(1).strip()}")
            continue
        numbered_match = re.match(r"^(\d+[.)])\s+(.+)$", line)
        if numbered_match:
            lines.append(f"{numbered_match.group(1)} {numbered_match.group(2).strip()}")
            continue
        lines.append(line)
    return lines or ["내용 없음"]


def _section_number_prefix(title: str) -> str:
    match = re.match(r"^\s*(\d+)", title or "")
    return match.group(1) if match else "1"


def _metadata_lines(result: dict) -> list[str]:
    lines = [
        "[문서 정보]",
        f"원본 파일  {result.get('source_file', '') or '-'}",
        f"처리 일시  {result.get('created_at', '') or '-'}",
    ]
    if result.get("meeting_purpose"):
        lines.append(f"회의 목적  {result.get('meeting_purpose', '')}")
    return lines


def _report_lines(result: dict) -> list[str]:
    summary = result.get("summary", {}) or {}
    export_scope = result.get("export_scope") or "full"
    title = summary.get("title") or "회의록"
    segments = get_transcript_segments(result)

    lines = [
        title,
        "",
        *_metadata_lines(result),
    ]
    if export_scope == "report":
        lines.extend(["", *_meeting_report_text_items("1. 회의록 보고서", result, include_empty=True)])
        return lines
    lines.extend(
        [
            "",
            "1. 회의 요약",
            summary.get("overview") or "내용 없음",
        ]
    )
    lines.extend(_line_text_items("2. 주요 주제", summary.get("topics", []) or []))
    lines.extend(_topic_section_text_items(summary.get("topic_sections", []) or []))
    lines.extend(_participant_summary_text_items(summary.get("participant_summaries", []) or []))
    lines.extend(_line_text_items("5. 결정 사항", summary.get("decisions", []) or []))
    lines.extend(_line_text_items("6. 할 일", summary.get("actions", []) or []))
    lines.extend(_line_text_items("7. 확인 필요 사항", summary.get("needs_check", []) or []))
    transcript_title = "8. 대화록"
    if export_scope == "full":
        report_lines = _meeting_report_text_items("8. 회의록 보고서", result)
        if report_lines:
            lines.extend(report_lines)
            transcript_title = "9. 대화록"
    if export_scope != "organized":
        lines.append(transcript_title)

        if segments:
            for segment in segments:
                start = _format_time(segment.get("start", 0.0))
                end = _format_time(segment.get("end", 0.0))
                speaker = segment.get("speaker_name") or segment.get("speaker") or "Speaker"
                text = segment.get("text", "")
                timing = " 시간 추정" if segment.get("timing_approximate") else ""
                lines.append(f"[{start}-{end}{timing}] {speaker}: {text}")
        else:
            lines.append("대화록 데이터가 없습니다.")

    return lines


def _line_text_items(title: str, items: list[str]) -> list[str]:
    lines = [title]
    if items:
        lines.extend(f"- {item}" for item in items)
    else:
        lines.append("- 없음")
    return lines


def _topic_section_text_items(sections: list[dict]) -> list[str]:
    lines = ["3. 주제별 내용"]
    if not sections:
        lines.append("- 없음")
        return lines

    for section in sections:
        lines.append(f"- {section.get('topic') or '주제'}")
        if section.get("summary"):
            lines.append(f"  {section.get('summary')}")
        for evidence in section.get("evidence", []) or []:
            lines.append(f"  근거: {evidence}")
        for action in section.get("actions", []) or []:
            lines.append(f"  할 일: {action}")
    return lines


def _participant_summary_text_items(items: list[dict]) -> list[str]:
    lines = ["4. 참석자별 요약 AI 초안"]
    if not items:
        lines.append("- 없음")
        return lines

    for item in items:
        lines.append(f"- {item.get('participant') or '참석자'}")
        if item.get("summary"):
            lines.append(f"  {item.get('summary')}")
        for point in item.get("key_points", []) or []:
            lines.append(f"  핵심: {point}")
        for action in item.get("actions", []) or []:
            lines.append(f"  할 일: {action}")
    return lines


def export_hwpx(result: dict, output_path: str) -> str:
    os.makedirs(os.path.dirname(output_path), exist_ok=True)

    lines = _report_lines(result)
    paragraphs = [_paragraph(line) for line in lines]
    title = lines[0] if lines else "회의록"
    escaped_title = html.escape(title, quote=True)
    preview_text = "\n".join(lines).strip() + "\n"

    section_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
{''.join(paragraphs)}
</hs:sec>
'''
    version_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<version app="NFIS 스마트 회의시스템" version="1.0"/>
'''
    content_hpf = f'''<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf/" unique-identifier="uid">
  <opf:metadata>
    <opf:title>{escaped_title}</opf:title>
    <opf:language>ko</opf:language>
    <opf:meta name="creator" content="text">LMO Audio</opf:meta>
  </opf:metadata>
  <opf:manifest>
    <opf:item id="header" href="Contents/header.xml" media-type="application/xml"/>
    <opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/>
    <opf:item id="settings" href="settings.xml" media-type="application/xml"/>
  </opf:manifest>
  <opf:spine>
    <opf:itemref idref="header" linear="yes"/>
    <opf:itemref idref="section0" linear="yes"/>
  </opf:spine>
</opf:package>
'''
    container_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="Contents/content.hpf" media-type="application/hwpml-package+xml"/>
  </rootfiles>
</container>
'''
    header_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<hh:head {XML_NAMESPACES}
        version="1.31" secCnt="1">
  <hh:beginNum page="1" footnote="1" endnote="1" pic="1" tbl="1" equation="1"/>
  <hh:refList/>
  <hh:compatibleDocument targetProgram="HWP201X"/>
  <hh:layoutCompatibility char="0" paragraph="0" section="0" object="0" field="0"/>
</hh:head>
'''
    settings_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<ha:HWPApplicationSetting xmlns:ha="http://www.hancom.co.kr/hwpml/2011/app"
        xmlns:config="urn:oasis:names:tc:opendocument:xmlns:config:1.0">
  <ha:CaretPosition listIDRef="0" paraIDRef="0" pos="0"/>
  <config:config-item-set name="PrintInfo">
    <config:config-item name="PrintAutoFootNote" type="boolean">false</config:config-item>
    <config:config-item name="PrintAutoHeadNote" type="boolean">false</config:config-item>
    <config:config-item name="PrintMethod" type="short">0</config:config-item>
    <config:config-item name="ZoomX" type="short">100</config:config-item>
    <config:config-item name="ZoomY" type="short">100</config:config-item>
  </config:config-item-set>
</ha:HWPApplicationSetting>
'''
    manifest_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0">
  <manifest:file-entry manifest:full-path="/" manifest:media-type="application/hwp+zip"/>
  <manifest:file-entry manifest:full-path="Contents/content.hpf" manifest:media-type="application/hwpml-package+xml"/>
  <manifest:file-entry manifest:full-path="Contents/header.xml" manifest:media-type="application/xml"/>
  <manifest:file-entry manifest:full-path="Contents/section0.xml" manifest:media-type="application/xml"/>
  <manifest:file-entry manifest:full-path="settings.xml" manifest:media-type="application/xml"/>
  <manifest:file-entry manifest:full-path="Preview/PrvText.txt" manifest:media-type="text/plain"/>
</manifest:manifest>
'''

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
        archive.writestr("META-INF/container.xml", container_xml)
        archive.writestr("META-INF/manifest.xml", manifest_xml)
        archive.writestr("version.xml", version_xml)
        archive.writestr("Contents/content.hpf", content_hpf)
        archive.writestr("Contents/header.xml", header_xml)
        archive.writestr("Contents/section0.xml", section_xml)
        archive.writestr("settings.xml", settings_xml)
        archive.writestr("Preview/PrvText.txt", preview_text)

    return output_path
