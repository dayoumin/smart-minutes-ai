import json
import os
import sys
import unittest

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

from main import app
from pipeline.audio_preprocess import resolve_preprocessing_plan

BACKEND_DIR = os.path.dirname(__file__)
TEST_AUDIO_PATH = os.path.join(BACKEND_DIR, "test_audio.wav")


class AnalyzeApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_health_check(self) -> None:
        response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ok"], True)

    def test_settings_and_model_status(self) -> None:
        settings_response = self.client.get("/api/settings")
        models_response = self.client.get("/api/models/status")

        self.assertEqual(settings_response.status_code, 200)
        self.assertEqual(models_response.status_code, 200)
        self.assertIn("processing", settings_response.json())
        self.assertIn("models", models_response.json())
        self.assertIsInstance(models_response.json()["models"], list)
        model_keys = {model["key"] for model in models_response.json()["models"]}
        self.assertIn("stt_primary", model_keys)
        self.assertIn("llm", model_keys)

    def test_analyze_streams_progress_and_result(self) -> None:
        with open(TEST_AUDIO_PATH, "rb") as audio_file:
            with self.client.stream(
                "POST",
                "/api/analyze",
                data={
                    "title": "테스트 회의",
                    "date": "2026-04-26T17:00",
                    "participants": "홍길동, 김철수",
                    "mode": "mock",
                },
                files={"file": ("test_audio.wav", audio_file, "audio/wav")},
                headers={"Accept": "text/event-stream"},
            ) as response:
                self.assertEqual(response.status_code, 200)
                self.assertIn("text/event-stream", response.headers["content-type"])
                body = "\n".join(response.iter_lines())

        data_events = [
            line.removeprefix("data: ").strip()
            for line in body.splitlines()
            if line.startswith("data: ")
        ]
        json_events = [json.loads(event) for event in data_events if event != "[DONE]"]

        self.assertGreaterEqual(len(json_events), 2)
        self.assertTrue(any(event.get("type") == "progress" for event in json_events))

        result = next(event for event in json_events if event.get("type") == "result")
        self.assertEqual(result["mode"], "mock")
        self.assertEqual(result["status"], "completed")
        self.assertEqual(result["progress"], 100)
        self.assertIn("테스트 회의", result["summary"])
        self.assertGreater(len(result["segments"]), 0)
        self.assertEqual(data_events[-1], "[DONE]")

    def test_analyze_rejects_unknown_mode(self) -> None:
        with open(TEST_AUDIO_PATH, "rb") as audio_file:
            response = self.client.post(
                "/api/analyze",
                data={
                    "title": "테스트 회의",
                    "date": "2026-04-26T17:00",
                    "participants": "홍길동, 김철수",
                    "mode": "unknown",
                },
                files={"file": ("test_audio.wav", audio_file, "audio/wav")},
            )

        self.assertEqual(response.status_code, 400)

    def test_speechnorm_preprocessing_plan(self) -> None:
        plan = resolve_preprocessing_plan(
            input_path="unused.wav",
            ffmpeg_path="ffmpeg",
            preprocessing={
                "enabled": True,
                "normalize_audio": True,
                "normalization_mode": "speechnorm",
            },
        )

        self.assertEqual(plan["resolved_mode"], "speechnorm")
        self.assertEqual(plan["audio_filter"], "speechnorm")

    def test_delete_outputs_removes_job_artifacts(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        temp_dir = os.path.join(BACKEND_DIR, "temp")
        os.makedirs(output_dir, exist_ok=True)
        os.makedirs(temp_dir, exist_ok=True)
        job_id = "unit_delete_outputs"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")
        temp_path = os.path.join(temp_dir, f"{job_id}.wav")
        chunk_dir = os.path.join(temp_dir, f"{job_id}_chunks")
        os.makedirs(chunk_dir, exist_ok=True)

        with open(output_path, "w", encoding="utf-8") as f:
            json.dump({"ok": True}, f)
        with open(temp_path, "w", encoding="utf-8") as f:
            f.write("temp")
        with open(os.path.join(chunk_dir, "chunk.wav"), "w", encoding="utf-8") as f:
            f.write("chunk")

        response = self.client.delete(f"/api/outputs/{job_id}")

        self.assertEqual(response.status_code, 200)
        self.assertFalse(os.path.exists(output_path))
        self.assertFalse(os.path.exists(temp_path))
        self.assertFalse(os.path.exists(chunk_dir))


if __name__ == "__main__":
    unittest.main()
