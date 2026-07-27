import io
import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from urllib.parse import quote
from xml.etree import ElementTree
from unittest.mock import patch

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402


def legacy_meeting_payload(**overrides):
    payload = {
        "id": "2026-05-05 01:55:hjhjhjhjh",
        "title": "회의록: 기존/기록 테스트",
        "date": "2026-05-05 01:55",
        "participants": "hj",
        "sourceFile": "[특집대담] 대선 주자 TV 스탠딩 토론회.mp4",
        "summary": "기존 IndexedDB 기록에서 내려받기를 다시 생성합니다.",
        "topics": ["안보", "인권"],
        "actions": ["후속 검토"],
        "segments": [
            {
                "start": "00:00:03",
                "end": "00:00:29",
                "speaker": "화자03",
                "text": "테스트 발화입니다.",
                "timingApproximate": True,
            }
        ],
    }
    payload.update(overrides)
    return payload


class ExportRecordTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.work_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.work_dir.cleanup)
        self.config = {
            "paths": {
                "output_dir": self.temp_dir.name,
                "temp_dir": self.work_dir.name,
            }
        }
        self.config_patch = patch.object(main, "load_config", return_value=self.config)
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)
        self.client = TestClient(main.app)

    def test_exports_legacy_record_with_windows_invalid_id(self):
        payload = legacy_meeting_payload()

        for kind in ("md", "hwpx", "docx", "txt"):
            with self.subTest(kind=kind):
                response = self.client.post(f"/api/export-record/{kind}", json=payload)

                self.assertEqual(response.status_code, 200, response.text)
                self.assertGreater(len(response.content), 0)
                disposition = response.headers.get("content-disposition", "")
                self.assertIn(f".{kind}", disposition)

        generated = os.listdir(self.temp_dir.name)
        self.assertTrue(generated)
        self.assertTrue(all(":" not in filename for filename in generated))

    def test_exports_record_with_path_like_id_without_leaving_output_dir(self):
        payload = legacy_meeting_payload(id="../outside\\bad:id", title="")

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        generated = [Path(self.temp_dir.name) / name for name in os.listdir(self.temp_dir.name)]
        self.assertTrue(generated)
        self.assertTrue(all(path.parent == Path(self.temp_dir.name) for path in generated))
        self.assertTrue(all(".." not in path.name and "\\" not in path.name and "/" not in path.name for path in generated))

    def test_delete_outputs_removes_sanitized_export_for_legacy_job_id(self):
        job_id = "old:meeting?1"
        payload = legacy_meeting_payload(id=job_id, jobId=job_id)

        response = self.client.post("/api/export-record/md", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(os.listdir(self.temp_dir.name))

        delete_response = self.client.delete(f"/api/outputs/{quote(job_id, safe='')}")

        self.assertEqual(delete_response.status_code, 200, delete_response.text)
        self.assertEqual(os.listdir(self.temp_dir.name), [])

    def test_exports_record_without_segments(self):
        payload = legacy_meeting_payload(segments=[], topics=[], actions=[])

        response = self.client.post("/api/export-record/hwpx", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertGreater(len(response.content), 0)

    def test_report_scope_exports_generated_meeting_report(self):
        payload = legacy_meeting_payload(
            exportScope="report",
            title="보고서 범위 회의",
            reportTemplate={
                "id": "current-report",
                "name": "현재 선택 보고 양식",
                "sections": ["현재 양식"],
            },
            meetingReport={
                "templateId": "custom-report",
                "templateName": "생성 당시 보고 양식",
                "templateSnapshot": {
                    "id": "custom-report",
                    "name": "생성 당시 보고 양식",
                    "sections": ["검토 배경", "후속 조치"],
                },
                "generatedAt": "2026-06-16T10:00:00",
                "content": "보고서 전체 본문입니다.",
                "sections": [
                    {"title": "검토 배경", "content": "보고서 전용 배경입니다."},
                    {"title": "후속 조치", "content": "보고서 전용 조치입니다."},
                ],
            },
        )

        md_response = self.client.post("/api/export-record/md", json=payload)
        self.assertEqual(md_response.status_code, 200, md_response.text)
        md_text = md_response.content.decode("utf-8")
        self.assertIn("회의록 보고서", md_text)
        self.assertIn("보고 양식", md_text)
        self.assertIn("생성 당시 보고 양식", md_text)
        self.assertNotIn("현재 선택 보고 양식", md_text)
        self.assertIn("보고서 개요", md_text)
        self.assertIn("보고서 전체 본문입니다.", md_text)
        self.assertIn("검토 배경", md_text)
        self.assertIn("보고서 전용 조치입니다.", md_text)
        self.assertNotIn("테스트 발화입니다.", md_text)

        hwpx_response = self.client.post("/api/export-record/hwpx", json=payload)
        self.assertEqual(hwpx_response.status_code, 200, hwpx_response.text)
        with zipfile.ZipFile(io.BytesIO(hwpx_response.content)) as archive:
            section_xml = archive.read("Contents/section0.xml").decode("utf-8")
            preview_text = archive.read("Preview/PrvText.txt").decode("utf-8")
        self.assertIn("[문서 정보]", preview_text)
        self.assertIn("보고 양식  생성 당시 보고 양식", preview_text)
        self.assertNotIn("현재 선택 보고 양식", preview_text)
        self.assertIn("보고서 개요", preview_text)
        self.assertIn("보고서 전체 본문입니다.", preview_text)
        self.assertIn("1.1 검토 배경", preview_text)
        self.assertIn("1.2 후속 조치", preview_text)
        self.assertIn("보고서 전용 배경입니다.", section_xml)
        self.assertIn("보고서 전용 조치입니다.", preview_text)
        self.assertNotIn("테스트 발화입니다.", section_xml)

        docx_response = self.client.post("/api/export-record/docx", json=payload)
        self.assertEqual(docx_response.status_code, 200, docx_response.text)
        with zipfile.ZipFile(io.BytesIO(docx_response.content)) as archive:
            document_xml = archive.read("word/document.xml").decode("utf-8")
        self.assertIn("<w:tbl>", document_xml)
        self.assertIn("생성 당시 보고 양식", document_xml)
        self.assertNotIn("현재 선택 보고 양식", document_xml)
        self.assertIn("보고서 개요", document_xml)
        self.assertIn("보고서 전체 본문입니다.", document_xml)
        self.assertIn('w:eastAsia="맑은 고딕"', document_xml)
        self.assertIn("1.1 검토 배경", document_xml)
        self.assertIn("1.2 후속 조치", document_xml)
        self.assertIn("보고서 전용 조치입니다.", document_xml)
        self.assertNotIn("테스트 발화입니다.", document_xml)

    def test_report_scope_uses_content_when_sections_are_blank(self):
        payload = legacy_meeting_payload(
            exportScope="report",
            meetingReport={
                "content": "빈 섹션 대신 살아야 하는 보고서 본문입니다.",
                "sections": [{}, {"title": "   ", "content": "   "}],
            },
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        md_text = response.content.decode("utf-8")
        self.assertIn("빈 섹션 대신 살아야 하는 보고서 본문입니다.", md_text)
        self.assertNotIn("내용 없음", md_text)

    def test_full_scope_exports_meeting_report_and_transcript(self):
        payload = legacy_meeting_payload(
            exportScope="full",
            meetingReport={
                "content": "전체 저장에 포함될 보고서 본문입니다.",
                "sections": [{"title": "보고서 결론", "content": "전체 저장 보고서 결론입니다."}],
            },
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("회의록 보고서", content)
        self.assertIn("전체 저장 보고서 결론입니다.", content)
        self.assertIn("대화록", content)
        self.assertIn("테스트 발화입니다.", content)

    def test_report_scope_save_copy_uses_report_suffix_and_content(self):
        payload = legacy_meeting_payload(
            exportScope="report",
            title="보고서 범위 회의",
            meetingReport={
                "content": "저장 복사 보고서 본문입니다.",
                "sections": [{"title": "저장 복사", "content": "저장 복사 보고서 내용입니다."}],
            },
        )
        saved_paths: list[Path] = []

        def fake_download_path(filename: str) -> Path:
            path = Path(self.work_dir.name) / filename
            saved_paths.append(path)
            return path

        with patch.object(main, "_unique_download_path", side_effect=fake_download_path):
            response = self.client.post(
                "/api/export-record/md/save-copy",
                json=payload,
                headers={"origin": "http://127.0.0.1:5173"},
            )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(saved_paths)
        saved_path = saved_paths[0]
        self.assertTrue(saved_path.name.endswith("_보고서.md"))
        saved_text = saved_path.read_text(encoding="utf-8")
        self.assertIn("저장 복사 보고서 내용입니다.", saved_text)
        self.assertNotIn("테스트 발화입니다.", saved_text)
        self.assertEqual(response.json()["saved_path"], str(saved_path))

    def test_generate_report_uses_selected_report_template_and_persists_template_id(self):
        job_id = "report-template-job"
        report_template = {
            "id": "custom-report-api",
            "name": "API 검증 보고 양식",
            "purpose": "보고서 생성 요청에 선택 양식이 유지되는지 확인한다.",
            "instructions": "보고 문체로 정리한다.",
            "sections": ["검토 배경", "결론 및 조치"],
        }
        payload = legacy_meeting_payload(
            id=job_id,
            jobId=job_id,
            selectedReportTemplateId="custom-report-api",
            reportTemplate=report_template,
            generationStatus={
                "summary": "completed",
                "topicSections": "completed",
                "speakerContextSummaries": "completed",
                "meetingReport": "not_started",
            },
            topicSections=[{"topic": "보고서", "summary": "보고서 생성 요청 검증"}],
            speakerContextSummaries=[],
            participantSummaries=[],
        )

        with (
            patch.object(main, "_summary_model_readiness", return_value={"ready": True}),
            patch.object(main, "_resolve_summary_model", return_value="gemma-test"),
            patch.object(main, "_refresh_summary_exports", return_value={}),
            patch(
                "pipeline.summarize.generate_meeting_report",
                return_value={
                    "content": "API 검증 보고서 본문",
                    "sections": [{"title": "검토 배경", "content": "API 검증 보고서 본문"}],
                },
            ) as generate_report,
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-report", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        response_payload = response.json()
        self.assertEqual(response_payload["meeting_report"]["templateId"], "custom-report-api")
        self.assertEqual(response_payload["meeting_report"]["templateName"], "API 검증 보고 양식")
        self.assertEqual(response_payload["meeting_report"]["templateSnapshot"], report_template)
        self.assertEqual(response_payload["meeting_report"]["content"], "API 검증 보고서 본문")

        generate_args = generate_report.call_args.args
        self.assertEqual(generate_args[4], report_template)
        self.assertEqual(generate_report.call_args.kwargs["meeting_context"]["report_template"], report_template)

        result_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        saved_result = json.loads(result_path.read_text(encoding="utf-8"))
        self.assertEqual(saved_result["selected_report_template_id"], "custom-report-api")
        self.assertEqual(saved_result["report_template"], report_template)
        self.assertEqual(saved_result["meeting_report"]["templateId"], "custom-report-api")
        self.assertEqual(saved_result["meeting_report"]["templateName"], "API 검증 보고 양식")
        self.assertEqual(saved_result["meeting_report"]["templateSnapshot"], report_template)
        self.assertEqual(saved_result["summary"]["generation_status"]["meeting_report"], "completed")

    def test_generate_report_uses_payload_organized_record_over_saved_result(self):
        job_id = "report-payload-current-job"
        result_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        result_path.write_text(
            json.dumps(
                {
                    "job_id": job_id,
                    "source_file": "stale.mp4",
                    "created_at": "2026-06-16 09:00",
                    "meeting_purpose": "이전 목적",
                    "selected_report_template_id": "standard-minutes",
                    "report_template": {"id": "standard-minutes", "name": "기본 보고서", "sections": ["회의 개요"]},
                    "segments": [
                        {"start": 0, "end": 5, "speaker": "SPEAKER_00", "text": "현재 화면에서 정리한 내용을 보고서로 만듭니다."}
                    ],
                    "summary": {
                        "title": "이전 제목",
                        "overview": "저장된 이전 요약",
                        "topics": ["이전 주제"],
                        "topic_sections": [{"topic": "이전", "summary": "이전 주제 정리"}],
                        "speaker_context_summaries": [{"speaker": "SPEAKER_00", "summary": "이전 참석자 정리"}],
                        "participant_summaries": [{"participant": "SPEAKER_00", "summary": "이전 참석자 요약"}],
                        "generation_status": {
                            "summary": "completed",
                            "topic_sections": "completed",
                            "speaker_context_summaries": "completed",
                            "meeting_report": "not_started",
                        },
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        report_template = {
            "id": "fresh-report-api",
            "name": "현재 보고 양식",
            "purpose": "현재 화면 기준으로 보고서를 생성한다.",
            "sections": ["현재 개요", "현재 조치"],
        }
        payload = legacy_meeting_payload(
            id=job_id,
            jobId=job_id,
            title="현재 화면 제목",
            summary="현재 화면 요약",
            topics=["현재 주제"],
            topicSections=[{"topic": "현재", "summary": "현재 주제 정리"}],
            speakerContextSummaries=[{"speaker": "SPEAKER_00", "summary": "현재 참석자 정리"}],
            participantSummaries=[{"participant": "SPEAKER_00", "summary": "현재 참석자 요약"}],
            selectedReportTemplateId="fresh-report-api",
            reportTemplate=report_template,
        )

        with (
            patch.object(main, "_summary_model_readiness", return_value={"ready": True}),
            patch.object(main, "_resolve_summary_model", return_value="gemma-test"),
            patch.object(main, "_refresh_summary_exports", return_value={}),
            patch(
                "pipeline.summarize.generate_meeting_report",
                return_value={
                    "content": "현재 화면 기준 보고서 본문",
                    "sections": [{"title": "현재 개요", "content": "현재 화면 기준 보고서 본문"}],
                },
            ) as generate_report,
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-report", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        generate_args = generate_report.call_args.args
        self.assertEqual(generate_args[1]["overview"], "현재 화면 요약")
        self.assertEqual(generate_args[2], [{"topic": "현재", "summary": "현재 주제 정리"}])
        self.assertEqual(generate_args[3], [{"speaker": "SPEAKER_00", "summary": "현재 참석자 정리"}])
        self.assertEqual(generate_args[4], report_template)

        saved_result = json.loads(result_path.read_text(encoding="utf-8"))
        self.assertEqual(saved_result["summary"]["overview"], "현재 화면 요약")
        self.assertEqual(saved_result["summary"]["topic_sections"][0]["topic"], "현재")
        self.assertEqual(saved_result["meeting_report"]["templateId"], "fresh-report-api")

    def test_download_output_regenerates_legacy_minimal_hwpx(self):
        job_id = "legacy_hwpx"
        result_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        result_path.write_text(
            json.dumps(
                {
                    "source_file": "상반기 & 회의.mp4",
                    "created_at": "2026-05-18 14:44",
                    "summary": {
                        "title": "상반기 회의",
                        "overview": "기존 HWPX를 재생성합니다.",
                    },
                    "segments": [
                        {
                            "start": 0,
                            "end": 5,
                            "speaker_name": "김철수",
                            "text": "검토 의견입니다.",
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        hwpx_path = Path(self.temp_dir.name) / f"{job_id}_report.hwpx"
        with zipfile.ZipFile(hwpx_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("mimetype", "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
            archive.writestr("META-INF/container.xml", "<container/>")
            archive.writestr("version.xml", "<version/>")
            archive.writestr("Contents/content.hpf", "<package/>")
            archive.writestr("Contents/section0.xml", "<section/>")

        response = self.client.get(f"/api/outputs/{job_id}/hwpx")

        self.assertEqual(response.status_code, 200, response.text)
        with zipfile.ZipFile(hwpx_path) as archive:
            names = set(archive.namelist())
            self.assertTrue(
                {
                    "META-INF/manifest.xml",
                    "Contents/header.xml",
                    "settings.xml",
                    "Preview/PrvText.txt",
                }.issubset(names)
            )
            content_root = ElementTree.fromstring(archive.read("Contents/content.hpf"))
            opf_ns = {"opf": "http://www.idpf.org/2007/opf/"}
            spine_refs = [
                item.attrib.get("idref")
                for item in content_root.findall("./opf:spine/opf:itemref", opf_ns)
            ]
            self.assertEqual(spine_refs, ["header", "section0"])
            preview = archive.read("Preview/PrvText.txt").decode("utf-8")
            self.assertIn("기존 HWPX를 재생성합니다.", preview)

    def test_download_output_keeps_existing_hwpx_when_refresh_fails(self):
        job_id = "legacy_hwpx_refresh_failure"
        result_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        result_path.write_text(
            json.dumps(
                {
                    "summary": {
                        "title": "상반기 회의",
                        "overview": "재생성 실패 시 기존 파일을 유지합니다.",
                    },
                    "segments": [],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        hwpx_path = Path(self.temp_dir.name) / f"{job_id}_report.hwpx"
        with zipfile.ZipFile(hwpx_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("mimetype", "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
            archive.writestr("META-INF/container.xml", "<container/>")
            archive.writestr("version.xml", "<version/>")
            archive.writestr("Contents/content.hpf", "<package/>")
            archive.writestr("Contents/section0.xml", "<section/>")
        before = hwpx_path.read_bytes()

        with (
            patch("main.logging.exception") as log_exception,
            patch("pipeline.export_hwpx.export_hwpx", side_effect=RuntimeError("boom")),
        ):
            response = self.client.get(f"/api/outputs/{job_id}/hwpx")

        self.assertEqual(response.status_code, 200, response.text)
        log_exception.assert_called_once()
        self.assertEqual(hwpx_path.read_bytes(), before)
        self.assertFalse(list(Path(self.temp_dir.name).glob(f"{job_id}_report.hwpx.*.tmp")))

    def test_export_record_prefers_display_segments_and_speaker_labels(self):
        payload = legacy_meeting_payload(
            speakerLabels={"화자000": "김철수"},
            segments=[
                {
                    "start": "00:00:00",
                    "end": "00:00:05",
                    "speaker": "화자000",
                    "text": "원본 조각입니다.",
                }
            ],
            displaySegments=[
                {
                    "start": "00:00:00",
                    "end": "00:00:10",
                    "speaker": "화자000",
                    "text": "읽기 좋은 표시용 문장입니다.",
                }
            ],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("읽기 좋은 표시용 문장입니다.", content)
        self.assertNotIn("원본 조각입니다.", content)
        self.assertIn("김철수", content)

    def test_exports_speaker_context_without_participant_summaries(self):
        payload = legacy_meeting_payload(
            participantSummaries=[],
            speakerContextSummaries=[
                {
                    "speaker": "SPEAKER_00",
                    "display_name": "화자01",
                    "summary": "참석자별 맥락 정리만 있는 기록입니다.",
                    "key_points": ["핵심 발언"],
                    "actions": ["후속 확인"],
                }
            ],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("참석자별 맥락 정리만 있는 기록입니다.", content)
        self.assertIn("참석자01", content)

    def test_export_record_applies_speaker_labels_to_speaker_context_summaries(self):
        payload = legacy_meeting_payload(
            speakerLabels={"SPEAKER_00": "김철수"},
            participantSummaries=[
                {
                    "participant": "화자1",
                    "summary": "화자1은 예산을 설명했습니다.",
                }
            ],
            speakerContextSummaries=[
                {
                    "speaker": "SPEAKER_00",
                    "display_name": "화자1",
                    "summary": "화자1은 참석자별 맥락을 정리했습니다.",
                    "key_points": ["화자1 핵심 발언"],
                    "actions": ["화자1 후속 확인"],
                }
            ],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("### 김철수", content)
        self.assertNotIn("화자1", content)

    def test_export_record_empty_speaker_labels_clear_stale_names(self):
        payload = legacy_meeting_payload(
            speakerLabels={},
            speaker_labels={"SPEAKER_00": "김철수"},
            segments=[
                {
                    "start": "00:00:00",
                    "end": "00:00:05",
                    "speaker": "SPEAKER_00",
                    "text": "발언 내용입니다.",
                }
            ],
            participantSummaries=[
                {
                    "participant": "김철수",
                    "summary": "김철수는 이전 이름으로 저장된 참석자별 정리입니다.",
                }
            ],
            speakerContextSummaries=[
                {
                    "speaker": "SPEAKER_00",
                    "display_name": "김철수",
                    "summary": "김철수는 참석자별 맥락을 정리했습니다.",
                    "key_points": ["김철수 핵심 발언"],
                    "actions": ["김철수 후속 확인"],
                }
            ],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("### 참석자01", content)
        self.assertNotIn("김철수", content)

    def test_export_record_normalizes_legacy_zero_based_speaker_labels(self):
        payload = legacy_meeting_payload(
            speakerLabels={},
            participantSummaries=[],
            speakerContextSummaries=[
                {"speaker": "SPEAKER_00", "display_name": "화자00", "summary": "첫 번째 참석자입니다."},
                {"speaker": "SPEAKER_01", "display_name": "화자01", "summary": "두 번째 참석자입니다."},
            ],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("### 참석자01", content)
        self.assertIn("### 참석자02", content)
        self.assertNotIn("### 화자00", content)
        self.assertNotIn("### 화자01", content)

    def test_export_record_normalizes_legacy_labels_in_summary_fields(self):
        payload = legacy_meeting_payload(
            summary="화자1이 발화자 구분 결과를 확인했습니다.",
            topics=["화자별 확인"],
            actions=["화자1: 후속 확인"],
            decisions=["발언자별 정리는 참석자 기준으로 표시"],
            needsCheck=["화자 라벨 확인"],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("참석자01이 참석자 구분 결과를 확인했습니다.", content)
        self.assertIn("참석자별 확인", content)
        self.assertIn("참석자01: 후속 확인", content)
        self.assertIn("참석자별 정리는 참석자 기준으로 표시", content)
        self.assertIn("자동 참석자 라벨 확인", content)

    def test_topic_generation_stays_completed_when_export_refresh_fails(self):
        job_id = "unit_topic_export_refresh_failure"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {
                        "generation_status": {"topic_sections": "not_started"},
                        "generation_error_detail": "topic_generation_empty",
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with (
            patch("pipeline.summarize.generate_topic_sections", return_value=[{"topic": "예산", "summary": "예산 논의"}]),
            patch.object(main, "_refresh_summary_exports", side_effect=RuntimeError("export failed")),
            patch.object(main.logging, "exception"),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections")

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["generation_status"]["topic_sections"], "completed")
        self.assertEqual(data["export_error"], "정리는 완료됐지만 다운로드 파일 갱신은 실패했습니다.")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["summary"]["generation_status"]["topic_sections"], "completed")
        self.assertNotIn("generation_error_detail", result_data["summary"])

    def test_topic_generation_clears_stale_speaker_context(self):
        job_id = "unit_topic_generation_clears_speaker_context"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {
                        "topic_sections": [{"topic": "Old", "summary": "Old topic"}],
                        "speaker_context_summaries": [
                            {"speaker": "SPEAKER_00", "display_name": "Speaker 00", "summary": "Old speaker context"}
                        ],
                        "participant_summaries": [
                            {"participant": "Speaker 00", "summary": "Old participant summary"}
                        ],
                        "generation_status": {
                            "summary": "completed",
                            "topic_sections": "completed",
                            "speaker_context_summaries": "completed",
                        },
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with (
            patch("pipeline.summarize.generate_topic_sections", return_value=[{"topic": "Budget", "summary": "Budget discussion"}]),
            patch.object(main, "_refresh_summary_exports", return_value=main._result_outputs(job_id)),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections")

        self.assertEqual(response.status_code, 200, response.text)
        response_data = response.json()
        self.assertEqual(response_data["speaker_context_summaries"], [])
        self.assertEqual(response_data["participant_summaries"], [])
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        summary = result_data["summary"]
        self.assertEqual(summary["generation_status"]["topic_sections"], "completed")
        self.assertEqual(summary["generation_status"]["speaker_context_summaries"], "not_started")
        self.assertEqual(summary["speaker_context_summaries"], [])
        self.assertEqual(summary["participant_summaries"], [])

    def test_topic_generation_empty_result_is_not_marked_completed(self):
        job_id = "unit_topic_generation_empty"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {"generation_status": {"summary": "completed", "topic_sections": "not_started"}},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with patch("pipeline.summarize.generate_topic_sections", return_value=[]):
            response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections")

        self.assertEqual(response.status_code, 502, response.text)
        self.assertEqual(response.json()["detail"], "topic_generation_empty")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["summary"]["generation_status"]["topic_sections"], "failed")
        self.assertEqual(result_data["summary"]["generation_error_detail"], "topic_generation_empty")

    def test_speaker_context_empty_result_is_not_marked_completed(self):
        job_id = "unit_speaker_context_empty"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {
                        "topic_sections": [{"topic": "Budget", "summary": "Budget discussion"}],
                        "generation_status": {
                            "summary": "completed",
                            "topic_sections": "completed",
                            "speaker_context_summaries": "not_started",
                        },
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with patch("pipeline.summarize.generate_speaker_context_summaries", return_value=[]):
            response = self.client.post(f"/api/outputs/{job_id}/generate-speaker-context")

        self.assertEqual(response.status_code, 502, response.text)
        self.assertEqual(response.json()["detail"], "speaker_context_generation_empty")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["summary"]["generation_status"]["speaker_context_summaries"], "failed")
        self.assertEqual(result_data["summary"]["generation_error_detail"], "speaker_context_generation_empty")

    def test_speaker_context_success_clears_previous_generation_error(self):
        job_id = "unit_speaker_context_clears_error"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {
                        "topic_sections": [{"topic": "Budget", "summary": "Budget discussion"}],
                        "generation_error_detail": "speaker_context_generation_empty",
                        "generation_status": {
                            "summary": "completed",
                            "topic_sections": "completed",
                            "speaker_context_summaries": "not_started",
                        },
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        speaker_summary = [{"speaker": "SPEAKER_00", "display_name": "Speaker 00", "summary": "Discussed budget."}]
        with (
            patch("pipeline.summarize.generate_speaker_context_summaries", return_value=speaker_summary),
            patch.object(main, "_refresh_summary_exports", return_value=main._result_outputs(job_id)),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-speaker-context")

        self.assertEqual(response.status_code, 200, response.text)
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["summary"]["generation_status"]["speaker_context_summaries"], "completed")
        self.assertNotIn("generation_error_detail", result_data["summary"])

    def test_diarization_runtime_error_is_persisted_with_detail(self):
        job_id = "unit_diarization_runtime_error"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"start": 0.0, "end": 1.0, "speaker": "SPEAKER_00", "text": "Hello."}],
                    "settings": {"diarization": False},
                    "summary": {"generation_status": {"summary": "completed"}},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        wav_path = Path(self.work_dir.name) / "source.wav"
        wav_path.write_bytes(b"RIFF0000WAVE")

        with (
            patch.object(main, "_resolve_job_audio_path", return_value=str(wav_path)),
            patch("pipeline.chunk_audio.get_wav_duration_seconds", return_value=10.0),
            patch.object(main, "model_exists", return_value=True),
            patch.object(main, "resolve_model_path", return_value=self.work_dir.name),
            patch("pipeline.diarize.diarize_audio", side_effect=RuntimeError("pyannote failed")),
            patch.object(main.logging, "exception"),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-diarization")

        self.assertEqual(response.status_code, 500, response.text)
        self.assertEqual(response.json()["detail"], "diarization_runtime_error")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["settings"]["diarization_generation_status"], "failed")
        self.assertEqual(result_data["settings"]["diarization_error_detail"], "diarization_runtime_error")
        self.assertIn("pyannote failed", result_data["settings"]["diarization_error_message"])

    def test_completed_diarization_conflict_does_not_persist_failure(self):
        job_id = "unit_diarization_already_completed"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"start": 0.0, "end": 1.0, "speaker": "SPEAKER_00", "text": "Hello."}],
                    "settings": {
                        "diarization": True,
                        "diarization_generation_status": "completed",
                    },
                    "summary": {"generation_status": {"summary": "completed"}},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        response = self.client.post(f"/api/outputs/{job_id}/generate-diarization")

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"], "diarization_already_completed")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["settings"]["diarization_generation_status"], "completed")
        self.assertNotIn("diarization_error_detail", result_data["settings"])
        self.assertNotIn("diarization_error_message", result_data["settings"])

    def test_rejects_duplicate_topic_generation_while_generating(self):
        job_id = "unit_topic_generation_duplicate"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {"generation_status": {"topic_sections": "generating"}},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections")

        self.assertEqual(response.status_code, 409)

    def test_topic_generation_rebuilds_missing_result_from_record_payload(self):
        job_id = "unit_rebuild_topic_generation"
        payload = legacy_meeting_payload(id=job_id, jobId=job_id)
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"

        with (
            patch("pipeline.summarize.generate_topic_sections", return_value=[{"topic": "budget", "summary": "Budget discussion"}]),
            patch.object(main, "_refresh_summary_exports", return_value=main._result_outputs(job_id)),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(output_path.exists())
        data = response.json()
        self.assertEqual(data["generation_status"]["topic_sections"], "completed")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["job_id"], job_id)
        self.assertTrue(result_data["segments"])

    def test_txt_export_without_segments_has_placeholder(self):
        payload = legacy_meeting_payload(segments=[])

        response = self.client.post("/api/export-record/txt", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("발화 스크립트 데이터가 없습니다.", response.content.decode("utf-8"))

    def test_rejects_unknown_export_kind(self):
        response = self.client.post("/api/export-record/pdf", json=legacy_meeting_payload())

        self.assertEqual(response.status_code, 404)

    def test_model_download_endpoint_rejects_legacy_payload(self):
        response = self.client.post("/api/models/download", json={"models": ["stt_primary"]})

        self.assertEqual(response.status_code, 400)

    def test_model_status_returns_degraded_payload_on_internal_error(self):
        with (
            patch.object(main, "get_model_status", side_effect=RuntimeError("scan failed")),
            patch.object(main.logging, "exception"),
        ):
            response = self.client.get("/api/models/status")

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertFalse(payload["ready"])
        self.assertEqual(payload["models"], [])
        self.assertIn("모델 상태를 확인하지 못했습니다.", payload["errors"][0])

    def test_ollama_pull_returns_failed_when_ollama_is_missing(self):
        with (
            patch.object(main, "find_ollama_executable", return_value="ollama"),
            patch.object(main, "_ollama_executable_available", return_value=False),
        ):
            response = self.client.post("/api/models/ollama/pull", json={"model": "gemma4:e2b"})

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertFalse(payload["active"])
        self.assertEqual(payload["status"], "failed")
        self.assertIn("요약 프로그램(Ollama)을 찾지 못했습니다", payload["message"])


if __name__ == "__main__":
    unittest.main()
