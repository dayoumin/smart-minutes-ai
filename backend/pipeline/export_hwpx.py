import html
import os
import zipfile


def _paragraph(text: str) -> str:
    escaped = html.escape(text or "")
    return f"<hp:p><hp:run><hp:t>{escaped}</hp:t></hp:run></hp:p>"


def _line_items(title: str, items: list[str]) -> list[str]:
    paragraphs = [_paragraph(title)]
    if items:
        paragraphs.extend(_paragraph(f"- {item}") for item in items)
    else:
        paragraphs.append(_paragraph("- 없음"))
    return paragraphs


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
        *_line_items("3. 결정 사항", summary.get("decisions", []) or []),
        *_line_items("4. 할 일", summary.get("actions", []) or []),
        *_line_items("5. 확인 필요 사항", summary.get("needs_check", []) or []),
        _paragraph("6. 화자별 발화 스크립트"),
    ]

    if segments:
        for segment in segments:
            start = float(segment.get("start", 0.0) or 0.0)
            end = float(segment.get("end", 0.0) or 0.0)
            speaker = segment.get("speaker_name") or segment.get("speaker") or "Speaker"
            text = segment.get("text", "")
            timing = " 시간 추정" if segment.get("timing_approximate") else ""
            paragraphs.append(_paragraph(f"[{start:0.1f}-{end:0.1f}{timing}] {speaker}: {text}"))
    else:
        paragraphs.append(_paragraph("발화 스크립트 데이터가 없습니다."))

    section_xml = f'''<?xml version="1.0" encoding="UTF-8"?>
<hs:sec xmlns:hs="http://www.hancom.co.kr/hwpml/2011/section"
        xmlns:hp="http://www.hancom.co.kr/hwpml/2011/paragraph">
{''.join(paragraphs)}
</hs:sec>
'''
    version_xml = '''<?xml version="1.0" encoding="UTF-8"?>
<version app="Smart Minutes AI" version="1.0"/>
'''
    content_hpf = '''<?xml version="1.0" encoding="UTF-8"?>
<opf:package xmlns:opf="http://www.idpf.org/2007/opf" unique-identifier="uid">
  <opf:metadata><opf:title>Smart Minutes AI Meeting Minutes</opf:title></opf:metadata>
  <opf:manifest><opf:item id="section0" href="Contents/section0.xml" media-type="application/xml"/></opf:manifest>
  <opf:spine><opf:itemref idref="section0"/></opf:spine>
</opf:package>
'''

    with zipfile.ZipFile(output_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
        archive.writestr("mimetype", "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
        archive.writestr("version.xml", version_xml)
        archive.writestr("Contents/content.hpf", content_hpf)
        archive.writestr("Contents/section0.xml", section_xml)

    return output_path
