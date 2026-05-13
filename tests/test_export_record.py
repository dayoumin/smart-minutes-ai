import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from urllib.parse import quote
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
                    "display_name": "화자1",
                    "summary": "발언자별 맥락 정리만 있는 기록입니다.",
                    "key_points": ["핵심 발언"],
                    "actions": ["후속 확인"],
                }
            ],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("발언자별 맥락 정리만 있는 기록입니다.", content)
        self.assertIn("화자1", content)

    def test_topic_generation_stays_completed_when_export_refresh_fails(self):
        job_id = "unit_topic_export_refresh_failure"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {"generation_status": {"topic_sections": "not_started"}},
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

    def test_user_model_download_endpoint_is_not_exposed(self):
        response = self.client.post("/api/models/download", json={"models": ["stt_primary"]})

        self.assertEqual(response.status_code, 404)

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


if __name__ == "__main__":
    unittest.main()
