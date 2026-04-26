import json
import os
import sys
import unittest

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

from main import app

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


if __name__ == "__main__":
    unittest.main()
