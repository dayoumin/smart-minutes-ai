import copy
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, str(Path(__file__).resolve().parent))

import main


class SummaryEmptyPreservationTest(unittest.TestCase):
    def check_empty_summary_preserves_record(self, existing):
        job_id = "summary_empty_preservation"
        segment = {"start": 0, "end": 3, "speaker": "SPEAKER_00", "text": "PRIVATE TRANSCRIPT", "speaker_needs_review": True}
        previous = {
            "job_id": job_id,
            "segments": [segment], "raw_stt_segments": [segment],
            "aligned_segments": [segment], "display_segments": [segment],
            "speaker_labels": {"SPEAKER_00": "사용자 이름"},
            "summary": {
                "title": "기존 제목", "overview": "기존 요약" if existing else "",
                "topics": ["기존 주제"] if existing else [],
                "topic_sections": [{"topic": "주제", "summary": "기존 본문"}] if existing else [],
                "speaker_context_summaries": [{"speaker": "SPEAKER_00", "summary": "기존 발언 정리"}] if existing else [],
                "participant_summaries": [{"participant": "사용자 이름", "summary": "기존 정리"}] if existing else [],
                "actions": [], "decisions": [], "needs_check": ["기존 확인 사항"],
                "generation_status": {
                    "summary": "completed" if existing else "not_started",
                    "topic_sections": "completed" if existing else "not_started",
                    "speaker_context_summaries": "completed" if existing else "not_started",
                },
            },
        }
        with tempfile.TemporaryDirectory() as tmp:
            result_path = Path(tmp) / f"{job_id}_result.json"
            result_path.write_text(json.dumps(previous, ensure_ascii=False), encoding="utf-8")
            with patch.object(main, "_get_output_dir", return_value=tmp), \
                    patch.object(main, "load_config", return_value={"summary": {"model": "test-model"}}), \
                    patch.object(main, "_summary_model_readiness", return_value={"ready": True, "model": "test-model"}), \
                    patch("pipeline.summarize.generate_ollama_text", return_value="{}") as generate, \
                    patch.object(main, "_refresh_transcript_and_summary_exports") as exports:
                response = TestClient(main.app).post(f"/api/outputs/{job_id}/generate-summary")
            saved = json.loads(result_path.read_text(encoding="utf-8"))
        self.assertEqual(response.status_code, 502)
        detail = response.json()["detail"]
        self.assertEqual(detail["code"], "invalid_model_response")
        self.assertTrue(detail["retryable"])
        self.assertEqual(generate.call_count, 2)
        exports.assert_not_called()
        self.assertNotIn("PRIVATE TRANSCRIPT", response.text)
        expected = copy.deepcopy(previous)
        expected["summary"]["generation_status"]["summary"] = "completed" if existing else "failed"
        expected["summary"]["generation_error_detail"] = "invalid_model_response"
        expected["summary"]["generation_error"] = detail
        self.assertEqual(saved, expected)

    def test_empty_generation_keeps_existing_summary_and_all_transcript_data(self):
        self.check_empty_summary_preserves_record(existing=True)

    def test_empty_generation_marks_unstarted_summary_failed_without_fabricated_overview(self):
        self.check_empty_summary_preserves_record(existing=False)


if __name__ == "__main__":
    unittest.main()
