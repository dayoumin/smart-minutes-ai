import copy
import json
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

import generation_gateway
import main
import model_manager


class SummaryPreparationTest(unittest.TestCase):
    def setUp(self):
        self.config = main.normalize_app_config({"summary": {"enabled": True, "model": "gemma4:e2b"}})

    def test_explicit_preparation_selects_fallback_from_one_inventory(self):
        with (
            patch.object(main, "ollama_executable_available", return_value=True),
            patch.object(main, "wait_for_ollama_preparation", return_value=True) as prepare,
            patch.object(main, "read_ollama_model_inventory", return_value=model_manager.OllamaModelInventory(True, ("gemma4:e4b",))) as inventory,
            patch.object(main, "list_ollama_models") as repeat_lookup,
        ):
            readiness = main._summary_model_readiness(self.config, preparation_timeout_seconds=300)
        self.assertTrue(readiness["ready"])
        self.assertEqual(readiness["model"], "gemma4:e4b")
        self.assertTrue(readiness["runtime_prepared"])
        prepare.assert_called_once_with(timeout_seconds=300)
        inventory.assert_called_once_with(server_prepared=True)
        repeat_lookup.assert_not_called()

    def test_preparation_timeout_while_process_is_alive_is_retryable_preparing(self):
        with (
            patch.object(main, "ollama_executable_available", return_value=True),
            patch.object(main, "wait_for_ollama_preparation", return_value=False),
            patch.object(main, "is_embedded_ollama_running", return_value=True),
            patch.object(main, "read_ollama_model_inventory") as inventory,
        ):
            readiness = main._summary_model_readiness(self.config, preparation_timeout_seconds=300)
        self.assertEqual(readiness["reason"], "runtime_preparing")
        inventory.assert_not_called()

    def test_failed_inventory_is_not_confirmed_model_absence(self):
        for inventory, expected in (
            (model_manager.OllamaModelInventory(False), "runtime_preparing"),
            (model_manager.OllamaModelInventory(True), "model_missing"),
        ):
            with (
                self.subTest(complete=inventory.complete),
                patch.object(main, "ollama_executable_available", return_value=True),
                patch.object(main, "wait_for_ollama_preparation", return_value=True),
                patch.object(main, "read_ollama_model_inventory", return_value=inventory),
            ):
                readiness = main._summary_model_readiness(self.config)
            self.assertFalse(readiness["ready"])
            self.assertEqual(readiness["reason"], expected)

    def test_passive_status_keeps_starting_and_unverified_inventory_retryable(self):
        for connection, inventory_checked in (("managed_starting", True), ("managed_ready", False), ("system_ready", False)):
            with self.subTest(connection=connection):
                readiness = main._summary_model_readiness_from_status(
                    self.config,
                    {"models": [{"key": "llm", "installed": False, "inventory_checked": inventory_checked}]},
                    {"status": connection},
                )
                self.assertEqual(readiness["reason"], "runtime_preparing")

    def test_connection_status_observes_starting_without_launching(self):
        with (
            patch.object(main, "ollama_executable_available", return_value=True),
            patch.object(main, "find_embedded_ollama_executable", return_value="managed.exe"),
            patch.object(main, "find_ollama_executable", return_value="managed.exe"),
            patch.object(main, "using_embedded_ollama", return_value=True),
            patch.object(main, "probe_ollama_server", return_value=False),
            patch.object(main, "is_embedded_ollama_running", return_value=True),
            patch.object(main, "ensure_ollama_server_running") as start,
            patch.object(main, "wait_for_ollama_preparation") as prepare,
        ):
            status = main._ollama_connection_status()
        self.assertEqual(status["status"], "managed_starting")
        self.assertFalse(status["server_ready"])
        self.assertTrue(status["can_auto_start"])
        start.assert_not_called()
        prepare.assert_not_called()

    def _saved_result(self, job_id):
        return {
            "job_id": job_id,
            "segments": [{"start": 0, "end": 2, "speaker": "SPEAKER_00", "text": "Budget discussed."}],
            "display_segments": [{"start": 0, "end": 2, "speaker": "SPEAKER_00", "text": "Budget discussed.", "review_flags": ["speaker_uncertain"]}],
            "speaker_labels": {"SPEAKER_00": "사용자 지정 이름"},
            "summary": {
                "overview": "기존 요약", "topics": ["기존 주제"],
                "topic_sections": [{"topic": "예산", "summary": "기존 정리"}],
                "speaker_context_summaries": [{"speaker": "SPEAKER_00", "summary": "기존 발언 정리"}],
                "generation_status": {"summary": "completed", "topic_sections": "completed", "speaker_context_summaries": "completed"},
            },
        }

    def test_preparation_failure_preserves_transcript_labels_and_existing_results(self):
        job_id = "unit_preparation_preserves_record"
        before = self._saved_result(job_id)
        with tempfile.TemporaryDirectory() as output_dir:
            result_path = Path(output_dir, f"{job_id}_result.json")
            result_path.write_text(json.dumps(before, ensure_ascii=False), encoding="utf-8")
            with (
                patch.object(main, "_get_output_dir", return_value=output_dir),
                patch.object(main, "load_config", return_value=self.config),
                patch.object(main, "ollama_executable_available", return_value=True),
                patch.object(main, "wait_for_ollama_preparation", return_value=False),
                patch.object(main, "is_embedded_ollama_running", return_value=True),
                patch("pipeline.summarize.summarize_meeting") as generate,
            ):
                response = TestClient(main.app).post(f"/api/outputs/{job_id}/generate-summary")
            self.assertEqual(response.status_code, 503, response.text)
            self.assertEqual(response.json()["detail"]["code"], "runtime_preparing")
            self.assertTrue(response.json()["detail"]["retryable"])
            after = json.loads(result_path.read_text(encoding="utf-8"))
        for key in ("segments", "display_segments", "speaker_labels"):
            self.assertEqual(after[key], before[key])
        for key in ("overview", "topics", "topic_sections", "speaker_context_summaries", "generation_status"):
            self.assertEqual(after["summary"][key], before["summary"][key])
        self.assertEqual(after["summary"]["generation_error_detail"], "runtime_preparing")
        generate.assert_not_called()

    def test_summary_uses_prepared_fallback_without_restarting_or_reading_inventory_again(self):
        job_id = "unit_preparation_single_request"
        before = self._saved_result(job_id)
        generated = copy.deepcopy(before["summary"])
        generated["overview"] = "새 요약"

        def generate(segments, model_name, **kwargs):
            self.assertEqual(model_name, "gemma4:e4b")
            generation_gateway._ensure_runtime(model_name)
            return generated

        with tempfile.TemporaryDirectory() as output_dir:
            result_path = Path(output_dir, f"{job_id}_result.json")
            result_path.write_text(json.dumps(before, ensure_ascii=False), encoding="utf-8")
            with (
                patch.object(main, "_get_output_dir", return_value=output_dir),
                patch.object(main, "load_config", return_value=self.config),
                patch.object(main, "ollama_executable_available", return_value=True),
                patch.object(main, "wait_for_ollama_preparation", return_value=True) as prepare,
                patch.object(model_manager.urllib.request, "urlopen", return_value=BytesIO(b'{"models":[{"name":"gemma4:e4b"}]}')) as inventory_request,
                patch.object(model_manager, "ensure_ollama_server_running") as repeat_start,
                patch.object(model_manager, "probe_ollama_server") as repeat_probe,
                patch.object(generation_gateway, "ensure_ollama_server_running") as gateway_start,
                patch("pipeline.summarize.summarize_meeting", side_effect=generate) as summarize,
                patch.object(main, "_refresh_transcript_and_summary_exports", return_value={}),
            ):
                response = TestClient(main.app).post(f"/api/outputs/{job_id}/generate-summary")
            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["summary"], "새 요약")
            self.assertEqual(json.loads(result_path.read_text(encoding="utf-8"))["speaker_labels"], before["speaker_labels"])
        prepare.assert_called_once_with(timeout_seconds=300)
        self.assertEqual(inventory_request.call_count, 1)
        self.assertEqual(summarize.call_count, 1)
        repeat_start.assert_not_called()
        repeat_probe.assert_not_called()
        gateway_start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
