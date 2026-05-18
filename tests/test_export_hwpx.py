import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from xml.etree import ElementTree


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from pipeline.export_hwpx import export_hwpx  # noqa: E402


class ExportHwpxTest(unittest.TestCase):
    def test_export_includes_hwpx_package_metadata_and_preview(self) -> None:
        result = {
            "source_file": "상반기 & 회의 <원본>.mp4",
            "created_at": "2026-05-18 14:44",
            "meeting_purpose": "LMO 심사",
            "summary": {
                "title": "상반기 회의 & 검토 <초안>",
                "overview": "대화록 생성이 완료되었습니다.",
                "topics": ["심사 자료"],
                "topic_sections": [
                    {
                        "topic": "위해성 평가",
                        "summary": "자료 보완이 필요합니다.",
                        "evidence": ["독성 평가 자료 부족"],
                        "actions": ["보완 요청"],
                    }
                ],
                "participant_summaries": [
                    {
                        "participant": "김철수",
                        "summary": "심사 기준을 설명했습니다.",
                        "key_points": ["자료 기준"],
                        "actions": ["검토 의견 전달"],
                    }
                ],
                "decisions": ["추가 검토"],
                "actions": ["자료 재확인"],
                "needs_check": ["근거 문서"],
            },
            "display_segments": [
                {
                    "start": 0,
                    "end": 5,
                    "speaker_name": "김&철수",
                    "text": '검토 <의견> & "확인"입니다.',
                }
            ],
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "meeting.hwpx"

            export_hwpx(result, str(output_path))

            with zipfile.ZipFile(output_path) as archive:
                names = archive.namelist()
                required_entries = {
                    "mimetype",
                    "META-INF/container.xml",
                    "META-INF/manifest.xml",
                    "version.xml",
                    "Contents/content.hpf",
                    "Contents/header.xml",
                    "Contents/section0.xml",
                    "settings.xml",
                    "Preview/PrvText.txt",
                }
                self.assertTrue(required_entries.issubset(set(names)))
                self.assertEqual(names[0], "mimetype")
                self.assertEqual(archive.getinfo("mimetype").compress_type, zipfile.ZIP_STORED)
                self.assertEqual(archive.read("mimetype").decode("ascii"), "application/hwp+zip")

                for name in required_entries - {"mimetype", "Preview/PrvText.txt"}:
                    ElementTree.fromstring(archive.read(name))

                content_hpf_bytes = archive.read("Contents/content.hpf")
                content_hpf = content_hpf_bytes.decode("utf-8")
                self.assertIn("Contents/header.xml", content_hpf)
                self.assertIn("Contents/section0.xml", content_hpf)
                self.assertIn("settings.xml", content_hpf)
                self.assertIn("상반기 회의 &amp; 검토 &lt;초안&gt;", content_hpf)
                content_root = ElementTree.fromstring(content_hpf_bytes)
                opf_ns = {"opf": "http://www.idpf.org/2007/opf/"}
                spine_refs = [
                    item.attrib["idref"]
                    for item in content_root.findall("./opf:spine/opf:itemref", opf_ns)
                ]
                self.assertEqual(spine_refs, ["header", "section0"])
                self.assertEqual(
                    [
                        item.attrib.get("linear")
                        for item in content_root.findall("./opf:spine/opf:itemref", opf_ns)
                    ],
                    ["yes", "yes"],
                )

                manifest_root = ElementTree.fromstring(archive.read("META-INF/manifest.xml"))
                manifest_ns = {"manifest": "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"}
                media_types = {
                    entry.attrib["{urn:oasis:names:tc:opendocument:xmlns:manifest:1.0}full-path"]: entry.attrib[
                        "{urn:oasis:names:tc:opendocument:xmlns:manifest:1.0}media-type"
                    ]
                    for entry in manifest_root.findall("./manifest:file-entry", manifest_ns)
                }
                self.assertEqual(media_types["Contents/content.hpf"], "application/hwpml-package+xml")
                self.assertEqual(media_types["Preview/PrvText.txt"], "text/plain")

                preview = archive.read("Preview/PrvText.txt").decode("utf-8")
                self.assertIn("상반기 회의 & 검토 <초안>", preview)
                self.assertIn("상반기 & 회의 <원본>.mp4", preview)
                self.assertIn('김&철수: 검토 <의견> & "확인"입니다.', preview)
                self.assertNotIn("<hp:", preview)

                section_xml = archive.read("Contents/section0.xml").decode("utf-8")
                self.assertIn("상반기 회의 &amp; 검토 &lt;초안&gt;", section_xml)
                self.assertIn("김&amp;철수", section_xml)
                self.assertIn("검토 &lt;의견&gt; &amp; &quot;확인&quot;입니다.", section_xml)


if __name__ == "__main__":
    unittest.main()
