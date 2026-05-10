import asyncio
import json
import os
import sys
import types
import unittest
from io import BytesIO
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile

sys.path.insert(0, os.path.dirname(__file__))

import main
from analysis_jobs import AnalysisCancelledError, AnalysisJobRegistry
from main import app, make_analysis_heartbeat, normalize_stt_config, process_audio_pipeline, stream_real_analysis
from model_manager import normalize_windows_path, resolve_backend_path
from pipeline.audio_preprocess import resolve_preprocessing_plan
import pipeline.transcribe as transcribe_module
from pipeline.transcribe import transcribe_audio_fallback_whisper

BACKEND_DIR = os.path.dirname(__file__)
TEST_AUDIO_PATH = os.path.join(BACKEND_DIR, "test_audio.wav")


class AnalyzeApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def test_health_check(self) -> None:
        response = self.client.get("/api/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json()["ok"], True)
        self.assertIn("backend_dir", response.json())
        self.assertIn("python_executable", response.json())

    def test_settings_and_model_status(self) -> None:
        settings_response = self.client.get("/api/settings")
        models_response = self.client.get("/api/models/status")

        self.assertEqual(settings_response.status_code, 200)
        self.assertEqual(models_response.status_code, 200)
        self.assertIn("processing", settings_response.json())
        self.assertIn("models", models_response.json())
        self.assertIsInstance(models_response.json()["models"], list)
        model_keys = {model["key"] for model in models_response.json()["models"]}
        self.assertIn("stt_faster_whisper", model_keys)
        self.assertIn("llm", model_keys)
        self.assertNotIn("stt_primary", model_keys)
        self.assertEqual(settings_response.json()["stt"]["device"], "cpu")
        self.assertIn("stt_device_status", models_response.json())

    def test_qwen_model_status_requires_qwen_without_faster_whisper(self) -> None:
        fake_status = {
            "models": [
                {"key": "stt_faster_whisper", "installed": False, "required": True},
                {"key": "stt_qwen", "installed": True, "required": False},
                {"key": "stt_qwen_aligner", "installed": True, "required": False},
                {"key": "diarization", "installed": True, "required": True},
            ]
        }

        with (
            patch("main.get_model_status", return_value=fake_status),
            patch("main.load_config", return_value={"stt": {"selected_model": "qwen3-asr"}, "diarization": {"enabled": False}}),
            patch("main.get_stt_device_status", return_value={"gpu_usable": False, "gpu_reason": "GPU unavailable", "recommended_device": "cpu", "selected_device_allowed": ["cpu"]}),
        ):
            response = self.client.get("/api/models/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        required_by_key = {model["key"]: model["required"] for model in payload["models"]}
        self.assertFalse(required_by_key["stt_faster_whisper"])
        self.assertTrue(required_by_key["stt_qwen"])
        self.assertTrue(required_by_key["stt_qwen_aligner"])
        self.assertFalse(required_by_key["diarization"])
        self.assertFalse(payload["diarization_enabled"])
        self.assertTrue(payload["ready"])

    def test_model_status_requires_diarization_only_when_enabled(self) -> None:
        fake_status = {
            "models": [
                {"key": "stt_faster_whisper", "installed": True, "required": True},
                {"key": "diarization", "installed": False, "required": True},
            ]
        }

        with (
            patch("main.get_model_status", return_value=fake_status),
            patch("main.load_config", return_value={"stt": {"selected_model": "faster-whisper-large-v3"}, "diarization": {"enabled": True}}),
            patch("main.get_stt_device_status", return_value={"gpu_usable": False, "gpu_reason": "GPU unavailable", "recommended_device": "cpu", "selected_device_allowed": ["cpu"]}),
        ):
            response = self.client.get("/api/models/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        required_by_key = {model["key"]: model["required"] for model in payload["models"]}
        self.assertTrue(required_by_key["diarization"])
        self.assertTrue(payload["diarization_enabled"])
        self.assertFalse(payload["ready"])

    def test_model_status_blocks_cuda_when_gpu_is_not_ready(self) -> None:
        fake_status = {
            "models": [
                {"key": "stt_faster_whisper", "installed": True, "required": True},
            ]
        }

        with (
            patch("main.get_model_status", return_value=fake_status),
            patch("main.load_config", return_value={"stt": {"selected_model": "faster-whisper-large-v3", "device": "cuda"}, "diarization": {"enabled": False}}),
            patch("main.get_stt_device_status", return_value={"gpu_usable": False, "gpu_reason": "CUDA 런타임 DLL이 준비되지 않았습니다.", "recommended_device": "cpu", "selected_device_allowed": ["cpu"]}),
        ):
            response = self.client.get("/api/models/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        self.assertEqual(payload["selected_stt_device"], "cuda")
        self.assertFalse(payload["ready"])
        self.assertIn("CUDA 런타임 DLL이 준비되지 않았습니다.", payload["errors"][0])

    def test_legacy_cohere_stt_config_migrates_to_faster_whisper(self) -> None:
        config = {
            "paths": {"stt_model": "./models/stt/cohere-transcribe-03-2026"},
            "stt": {"selected_model": "cohere-transcribe-03-2026", "default_model": "cohere-transcribe-03-2026"},
        }

        migrated = normalize_stt_config(config)

        self.assertEqual(migrated["paths"]["stt_model"], "../models/faster-whisper-large-v3")
        self.assertEqual(migrated["stt"]["selected_model"], "faster-whisper-large-v3")
        self.assertEqual(migrated["stt"]["default_model"], "faster-whisper-large-v3")

    def test_config_normalization_adds_chunk_defaults(self) -> None:
        normalized = normalize_stt_config({
            "paths": {"stt_model": "../models/faster-whisper-large-v3"},
            "stt": {"selected_model": "faster-whisper-large-v3"},
            "processing": {},
        })

        self.assertEqual(normalized["stt"]["chunk_seconds"], 30)
        self.assertEqual(normalized["stt"]["device"], "cpu")
        self.assertEqual(normalized["processing"]["long_audio_chunk_seconds"], 30)
        self.assertFalse(normalized["diarization"]["enabled"])

    def test_generic_models_path_migrates_to_selected_model_path(self) -> None:
        normalized = normalize_stt_config({
            "paths": {"stt_model": "../models"},
            "stt": {"selected_model": "qwen3-asr"},
        })

        self.assertEqual(normalized["paths"]["stt_model"], "../models/Qwen3-ASR-1.7B")

    def test_settings_patch_rejects_auto_device(self) -> None:
        response = self.client.patch("/api/settings", json={"stt": {"device": "auto"}})

        self.assertEqual(response.status_code, 400)
        self.assertIn("cpu or cuda", response.json()["detail"])

    def test_model_path_resolution_removes_windows_extended_prefix(self) -> None:
        resolved = resolve_backend_path(
            "\\\\?\\D:\\Projects\\audio\\lmo_audio\\backend",
            "../models/faster-whisper-large-v3",
        )

        self.assertEqual(
            resolved,
            "D:\\Projects\\audio\\lmo_audio\\models\\faster-whisper-large-v3",
        )
        self.assertEqual(
            normalize_windows_path("\\\\?\\UNC\\server\\share\\models"),
            "\\\\server\\share\\models",
        )

    def test_analysis_job_registry_cancel_lifecycle(self) -> None:
        registry = AnalysisJobRegistry()
        cancel_event = registry.create("unit_job")

        self.assertFalse(cancel_event.is_set())
        self.assertTrue(registry.cancel("unit_job"))
        self.assertTrue(cancel_event.is_set())
        registry.remove("unit_job")
        self.assertFalse(registry.cancel("unit_job"))

    def test_analysis_job_registry_rejects_duplicate_job_id(self) -> None:
        registry = AnalysisJobRegistry()
        first_event = registry.create("unit_job")

        with self.assertRaises(ValueError):
            registry.create("unit_job")

        self.assertTrue(registry.cancel("unit_job"))
        self.assertTrue(first_event.is_set())
        registry.remove("unit_job")

    def test_analysis_job_registry_remove_does_not_delete_newer_event(self) -> None:
        registry = AnalysisJobRegistry()
        stale_event = registry.create("unit_job")
        registry.remove("unit_job")
        current_event = registry.create("unit_job")

        registry.remove("unit_job", stale_event)

        self.assertTrue(registry.cancel("unit_job"))
        self.assertTrue(current_event.is_set())
        registry.remove("unit_job", current_event)
        self.assertFalse(registry.cancel("unit_job"))

    def test_analysis_heartbeat_marks_progress_without_changing_percent(self) -> None:
        heartbeat = make_analysis_heartbeat({
            "type": "progress",
            "mode": "real",
            "progress": 30,
            "message": "음성 인식 중입니다.",
            "status": "processing",
        })

        self.assertEqual(heartbeat["type"], "progress")
        self.assertEqual(heartbeat["mode"], "real")
        self.assertEqual(heartbeat["progress"], 30)
        self.assertTrue(heartbeat["heartbeat"])
        self.assertIn("취소 후 다시 시도", heartbeat["message"])

    def test_real_analysis_stream_sends_heartbeat_during_long_worker_gap(self) -> None:
        fake_config = {
            "paths": {
                "temp_dir": "./temp",
                "stt_model": "../models/faster-whisper-large-v3",
                "qwen_aligner_model": "../models/Qwen3-ForcedAligner-0.6B",
            },
            "stt": {"selected_model": "faster-whisper-large-v3"},
            "diarization": {"enabled": False},
            "privacy": {"save_original_audio_copy": False},
        }

        def fake_process_audio_pipeline(upload_path, job_id, config, progress_callback, cancel_event=None):
            import time

            time.sleep(0.05)
            return {
                "job_id": job_id,
                "result_data": {
                    "summary": {
                        "overview": "테스트 회의 요약",
                        "topics": [],
                        "actions": [],
                    },
                    "segments": [],
                },
            }

        async def collect_events() -> list[str]:
            upload = UploadFile(filename="test_audio.wav", file=BytesIO(b"audio"))
            events = []
            async for event in stream_real_analysis(
                "테스트 회의",
                "2026-05-08T10:00",
                "홍길동",
                upload,
                "unit_heartbeat_stream",
            ):
                events.append(event)
                if "event: done" in event:
                    break
            return events

        with (
            patch("main.ANALYSIS_HEARTBEAT_SECONDS", 0.01),
            patch("main.load_config", return_value=fake_config),
            patch("main.model_exists", return_value=True),
            patch("main.resolve_model_path", return_value="mock-model-path"),
            patch("main.process_audio_pipeline", side_effect=fake_process_audio_pipeline),
        ):
            events = asyncio.run(collect_events())

        body = "\n".join(events)
        self.assertIn('"heartbeat": true', body)
        self.assertIn("event: result", body)
        self.assertIn("event: done", body)

    def test_real_analysis_stream_errors_after_stall_timeout(self) -> None:
        fake_config = {
            "paths": {
                "temp_dir": "./temp",
                "stt_model": "../models/faster-whisper-large-v3",
                "qwen_aligner_model": "../models/Qwen3-ForcedAligner-0.6B",
            },
            "stt": {"selected_model": "faster-whisper-large-v3"},
            "diarization": {"enabled": False},
            "privacy": {"save_original_audio_copy": False},
        }

        def fake_process_audio_pipeline(upload_path, job_id, config, progress_callback, cancel_event=None):
            import time

            progress_callback("Transcribing chunk 1/10...", 30)
            time.sleep(0.2)
            return {
                "job_id": job_id,
                "result_data": {"summary": {}, "segments": []},
            }

        async def collect_events() -> list[str]:
            upload = UploadFile(filename="test_audio.wav", file=BytesIO(b"audio"))
            events = []
            async for event in stream_real_analysis(
                "stall test",
                "2026-05-08T10:00",
                "tester",
                upload,
                "unit_stall_timeout",
            ):
                events.append(event)
                if "event: done" in event:
                    break
            return events

        with (
            patch("main.ANALYSIS_HEARTBEAT_SECONDS", 0.01),
            patch("main.ANALYSIS_STALL_ERROR_SECONDS", 0.02),
            patch("main.ANALYSIS_STALL_ERROR_SECONDS_TRANSCRIBE", 0.02),
            patch("main.load_config", return_value=fake_config),
            patch("main.model_exists", return_value=True),
            patch("main.resolve_model_path", return_value="mock-model-path"),
            patch("main.process_audio_pipeline", side_effect=fake_process_audio_pipeline),
        ):
            events = asyncio.run(collect_events())

        body = "\n".join(events)
        self.assertIn("event: error", body)
        self.assertIn("너무 오래", body)
        self.assertIn("event: done", body)

    def test_real_analysis_stream_rejects_duplicate_job_id_without_overwriting_registry(self) -> None:
        async def collect_events() -> list[str]:
            upload = UploadFile(filename="test_audio.wav", file=BytesIO(b"audio"))
            events = []
            async for event in stream_real_analysis(
                "테스트 회의",
                "2026-05-08T10:00",
                "홍길동",
                upload,
                "unit_duplicate_job",
            ):
                events.append(event)
                if "event: done" in event:
                    break
            return events

        cancel_event = main.ANALYSIS_JOBS.create("unit_duplicate_job")
        try:
            events = asyncio.run(collect_events())
        finally:
            main.ANALYSIS_JOBS.remove("unit_duplicate_job", cancel_event)

        body = "\n".join(events)
        self.assertIn("event: error", body)
        self.assertIn("already exists", body)
        self.assertFalse(cancel_event.is_set())

    def test_real_analysis_stream_emits_cancelled_even_when_cleanup_fails(self) -> None:
        fake_config = {
            "paths": {
                "temp_dir": "./temp",
                "stt_model": "../models/faster-whisper-large-v3",
                "qwen_aligner_model": "../models/Qwen3-ForcedAligner-0.6B",
            },
            "stt": {"selected_model": "faster-whisper-large-v3"},
            "diarization": {"enabled": False},
            "privacy": {"save_original_audio_copy": False},
        }

        def fake_process_audio_pipeline(upload_path, job_id, config, progress_callback, cancel_event):
            raise AnalysisCancelledError("분석이 취소되었습니다.")

        async def collect_events() -> list[str]:
            upload = UploadFile(filename="test_audio.wav", file=BytesIO(b"audio"))
            events = []
            async for event in stream_real_analysis(
                "테스트 회의",
                "2026-05-08T10:00",
                "홍길동",
                upload,
                "unit_cancel_cleanup",
            ):
                events.append(event)
                if "event: done" in event:
                    break
            return events

        with (
            patch("main.load_config", return_value=fake_config),
            patch("main.model_exists", return_value=True),
            patch("main.resolve_model_path", return_value="mock-model-path"),
            patch("main.process_audio_pipeline", side_effect=fake_process_audio_pipeline),
            patch("main._delete_job_artifacts", side_effect=RuntimeError("cleanup failed")),
            patch("main.logging.exception"),
        ):
            events = asyncio.run(collect_events())

        body = "\n".join(events)
        self.assertIn("event: cancelled", body)
        self.assertIn("event: done", body)
        self.assertFalse(main.ANALYSIS_JOBS.cancel("unit_cancel_cleanup"))

    def test_pipeline_uses_configured_outer_chunk_seconds(self) -> None:
        seen = {}

        def fake_split(wav_path, chunk_dir, chunk_seconds, ffmpeg_path):
            seen["chunk_seconds"] = chunk_seconds
            return [{"path": wav_path, "offset": 0.0, "duration": 1.0, "index": 0}]

        config = {
            "paths": {
                "ffmpeg": "ffmpeg",
                "stt_model": "faster-whisper-large-v3",
                "diarization_model": "",
                "output_dir": "./outputs",
                "temp_dir": "./temp",
                "llm_model": "",
            },
            "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
            "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
            "preprocessing": {"enabled": False},
            "diarization": {"enabled": False},
            "summary": {"enabled": False},
            "privacy": {"auto_delete_temp_audio": True},
        }

        with (
            patch("pipeline.audio_preprocess.convert_to_wav", return_value={"preprocessing": {}}),
            patch("pipeline.chunk_audio.split_wav_by_duration", side_effect=fake_split),
            patch("pipeline.transcribe.transcribe_audio", return_value=[{"start": 0.0, "end": 1.0, "text": "hello"}]),
            patch("pipeline.export_txt.export_txt"),
        ):
            process_audio_pipeline(TEST_AUDIO_PATH, "unit_chunk_seconds", config)

        self.assertEqual(seen["chunk_seconds"], 30)

    def test_pipeline_normalizes_missing_chunk_defaults(self) -> None:
        seen = {}

        def fake_split(wav_path, chunk_dir, chunk_seconds, ffmpeg_path):
            seen["outer_chunk_seconds"] = chunk_seconds
            return [{"path": wav_path, "offset": 0.0, "duration": 1.0, "index": 0}]

        def fake_transcribe(wav_path, model_path, language, device, chunk_seconds, fallback_model_path, qwen_aligner_model_path):
            seen["stt_chunk_seconds"] = chunk_seconds
            return [{"start": 0.0, "end": 1.0, "text": "hello"}]

        config = {
            "paths": {
                "ffmpeg": "ffmpeg",
                "stt_model": "faster-whisper-large-v3",
                "diarization_model": "",
                "output_dir": "./outputs",
                "temp_dir": "./temp",
                "llm_model": "",
            },
            "stt": {"language": "ko", "device": "cpu"},
            "processing": {"enable_long_audio_chunking": True},
            "preprocessing": {"enabled": False},
            "diarization": {"enabled": False},
            "summary": {"enabled": False},
            "privacy": {"auto_delete_temp_audio": True},
        }

        with (
            patch("pipeline.audio_preprocess.convert_to_wav", return_value={"preprocessing": {}}),
            patch("pipeline.chunk_audio.split_wav_by_duration", side_effect=fake_split),
            patch("pipeline.transcribe.transcribe_audio", side_effect=fake_transcribe),
            patch("pipeline.export_txt.export_txt"),
        ):
            process_audio_pipeline(TEST_AUDIO_PATH, "unit_default_chunk_seconds", config)

        self.assertEqual(seen["outer_chunk_seconds"], 30)
        self.assertEqual(seen["stt_chunk_seconds"], 30)

    def test_pipeline_skips_diarization_and_summary_when_transcript_is_empty(self) -> None:
        config = {
            "paths": {
                "ffmpeg": "ffmpeg",
                "stt_model": "faster-whisper-large-v3",
                "diarization_model": "pyannote-model",
                "output_dir": "./outputs",
                "temp_dir": "./temp",
                "llm_model": "",
            },
            "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
            "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
            "preprocessing": {"enabled": False},
            "diarization": {"enabled": True},
            "summary": {"enabled": True},
            "privacy": {"auto_delete_temp_audio": True},
        }

        with (
            patch("main.get_model_spec"),
            patch("main.model_exists", return_value=False),
            patch("pipeline.audio_preprocess.convert_to_wav", return_value={"preprocessing": {}}),
            patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[{"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 1.0, "index": 0}]),
            patch("pipeline.transcribe.transcribe_audio", return_value=[]),
            patch("pipeline.diarize.diarize_audio") as diarize_mock,
            patch("pipeline.summarize.summarize_meeting") as summarize_mock,
            patch("pipeline.export_txt.export_txt"),
        ):
            result = process_audio_pipeline(TEST_AUDIO_PATH, "unit_empty_transcript", config)

        self.assertEqual(result["result_data"]["segments"], [])
        self.assertEqual(
            result["result_data"]["summary"]["overview"],
            "음성 인식 결과가 없어 회의 요약을 만들지 못했습니다.",
        )
        diarize_mock.assert_not_called()
        summarize_mock.assert_not_called()

    def test_pipeline_does_not_retry_same_model_as_fallback(self) -> None:
        config = {
            "paths": {
                "ffmpeg": "ffmpeg",
                "stt_model": "same-model-path",
                "diarization_model": "",
                "output_dir": "./outputs",
                "temp_dir": "./temp",
                "llm_model": "",
            },
            "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
            "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
            "preprocessing": {"enabled": False},
            "diarization": {"enabled": False},
            "summary": {"enabled": False},
            "privacy": {"auto_delete_temp_audio": True},
        }

        with (
            patch("main.get_model_spec"),
            patch("main.model_exists", return_value=True),
            patch("main.resolve_model_path", return_value="same-model-path"),
            patch("pipeline.audio_preprocess.convert_to_wav", return_value={"preprocessing": {}}),
            patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[{"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 1.0, "index": 0}]),
            patch("pipeline.transcribe.transcribe_audio", side_effect=RuntimeError("stt failed")) as transcribe_mock,
            patch("pipeline.export_txt.export_txt"),
        ):
            with self.assertRaises(RuntimeError):
                process_audio_pipeline(TEST_AUDIO_PATH, "unit_same_fallback", config)

        self.assertEqual(transcribe_mock.call_count, 1)

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

    def test_faster_whisper_auto_retries_on_cpu_when_cuda_runtime_breaks_during_transcribe(self) -> None:
        class FailingCudaModel:
            def transcribe(self, *args, **kwargs):
                raise RuntimeError("Library cublas64_12.dll is not found or cannot be loaded")

        class CpuModel:
            def transcribe(self, *args, **kwargs):
                segment = types.SimpleNamespace(start=0.0, end=1.0, text="안녕하세요")
                return iter([segment]), {}

        calls: list[str] = []

        def fake_whisper_model(model_path, device, compute_type, **kwargs):
            calls.append(device)
            if device == "auto":
                return FailingCudaModel()
            return CpuModel()

        fake_faster_whisper = types.SimpleNamespace(WhisperModel=fake_whisper_model)
        fake_torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
        )

        with (
            patch.dict(sys.modules, {"faster_whisper": fake_faster_whisper, "torch": fake_torch}),
            patch("pipeline.transcribe._windows_cuda_runtime_is_usable", return_value=True),
        ):
            segments = transcribe_audio_fallback_whisper("dummy.wav", "dummy-model", device="auto")

        self.assertEqual(calls, ["auto", "cpu"])
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], "안녕하세요")

    def test_faster_whisper_auto_skips_gpu_when_windows_cuda_dlls_are_missing(self) -> None:
        class CpuModel:
            def transcribe(self, *args, **kwargs):
                segment = types.SimpleNamespace(start=0.0, end=1.0, text="테스트")
                return iter([segment]), {}

        calls: list[str] = []

        def fake_whisper_model(model_path, device, compute_type, **kwargs):
            calls.append(device)
            return CpuModel()

        fake_faster_whisper = types.SimpleNamespace(WhisperModel=fake_whisper_model)
        fake_torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=lambda: True, empty_cache=lambda: None)
        )

        with (
            patch.dict(sys.modules, {"faster_whisper": fake_faster_whisper, "torch": fake_torch}),
            patch("pipeline.transcribe.sys.platform", "win32"),
            patch("pipeline.transcribe.ctypes.WinDLL", side_effect=OSError("missing cuda dll")),
        ):
            segments = transcribe_audio_fallback_whisper("dummy.wav", "dummy-model", device="auto")

        self.assertEqual(calls, ["cpu"])
        self.assertEqual(len(segments), 1)
        self.assertEqual(segments[0]["text"], "테스트")

    def test_faster_whisper_reuses_cached_model_between_calls(self) -> None:
        class FakeModel:
            def __init__(self):
                self.transcribe_calls = 0

            def transcribe(self, *args, **kwargs):
                self.transcribe_calls += 1
                segment = types.SimpleNamespace(start=0.0, end=1.0, text=f"segment-{self.transcribe_calls}")
                return iter([segment]), {}

        load_calls: list[tuple[str, str]] = []
        fake_model = FakeModel()

        def fake_whisper_model(model_path, device, compute_type, **kwargs):
            load_calls.append((device, compute_type))
            return fake_model

        fake_faster_whisper = types.SimpleNamespace(WhisperModel=fake_whisper_model)
        fake_torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
        )

        transcribe_module._clear_faster_whisper_model_cache()
        with patch.dict(sys.modules, {"faster_whisper": fake_faster_whisper, "torch": fake_torch}):
            first = transcribe_audio_fallback_whisper("dummy.wav", "dummy-model", device="cpu")
            second = transcribe_audio_fallback_whisper("dummy.wav", "dummy-model", device="cpu")
        transcribe_module._clear_faster_whisper_model_cache()

        self.assertEqual(load_calls, [("cpu", "int8")])
        self.assertEqual(first[0]["text"], "segment-1")
        self.assertEqual(second[0]["text"], "segment-2")

    def test_faster_whisper_cache_resets_when_runtime_changes(self) -> None:
        class FakeModel:
            def __init__(self, label: str):
                self.label = label

            def transcribe(self, *args, **kwargs):
                segment = types.SimpleNamespace(start=0.0, end=1.0, text=self.label)
                return iter([segment]), {}

        load_calls: list[tuple[str, str]] = []

        def fake_whisper_model(model_path, device, compute_type, **kwargs):
            load_calls.append((device, compute_type))
            return FakeModel(f"{device}:{compute_type}")

        fake_faster_whisper = types.SimpleNamespace(WhisperModel=fake_whisper_model)
        fake_torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=lambda: False, empty_cache=lambda: None)
        )

        transcribe_module._clear_faster_whisper_model_cache()
        with patch.dict(sys.modules, {"faster_whisper": fake_faster_whisper, "torch": fake_torch}):
            cpu_segments = transcribe_audio_fallback_whisper("dummy.wav", "dummy-model", device="cpu")
            cuda_segments = transcribe_audio_fallback_whisper("dummy.wav", "dummy-model", device="cuda")
        transcribe_module._clear_faster_whisper_model_cache()

        self.assertEqual(load_calls, [("cpu", "int8"), ("cuda", "float16")])
        self.assertEqual(cpu_segments[0]["text"], "cpu:int8")
        self.assertEqual(cuda_segments[0]["text"], "cuda:float16")

    def test_qwen_cuda_requires_windows_cuda_runtime_dlls(self) -> None:
        fake_torch = types.SimpleNamespace(
            cuda=types.SimpleNamespace(is_available=lambda: True, empty_cache=lambda: None),
            bfloat16="bf16",
            float32="fp32",
        )

        with (
            patch.dict(sys.modules, {"torch": fake_torch}),
            patch("pipeline.transcribe._windows_cuda_runtime_is_usable", return_value=False),
        ):
            with self.assertRaises(RuntimeError):
                from pipeline.transcribe import _qwen_device_and_dtype

                _qwen_device_and_dtype("cuda")

    def test_delete_outputs_removes_job_artifacts(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        temp_dir = os.path.join(BACKEND_DIR, "temp")
        os.makedirs(output_dir, exist_ok=True)
        os.makedirs(temp_dir, exist_ok=True)
        job_id = "unit_delete_outputs"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")
        export_path = os.path.join(output_dir, f"{job_id}_export_20260505_current.txt")
        collision_output_path = os.path.join(output_dir, f"{job_id}_other_result.json")
        temp_path = os.path.join(temp_dir, f"{job_id}.wav")
        chunk_dir = os.path.join(temp_dir, f"{job_id}_chunks")
        collision_temp_path = os.path.join(temp_dir, f"{job_id}_other.wav")
        os.makedirs(chunk_dir, exist_ok=True)

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump({"ok": True}, f)
            with open(export_path, "w", encoding="utf-8") as f:
                f.write("export")
            with open(collision_output_path, "w", encoding="utf-8") as f:
                json.dump({"keep": True}, f)
            with open(temp_path, "w", encoding="utf-8") as f:
                f.write("temp")
            with open(os.path.join(chunk_dir, "chunk.wav"), "w", encoding="utf-8") as f:
                f.write("chunk")
            with open(collision_temp_path, "w", encoding="utf-8") as f:
                f.write("keep")

            response = self.client.delete(f"/api/outputs/{job_id}")

            self.assertEqual(response.status_code, 200)
            self.assertFalse(os.path.exists(output_path))
            self.assertFalse(os.path.exists(export_path))
            self.assertFalse(os.path.exists(temp_path))
            self.assertFalse(os.path.exists(chunk_dir))
            self.assertTrue(os.path.exists(collision_output_path))
            self.assertTrue(os.path.exists(collision_temp_path))
        finally:
            for path in [output_path, export_path, collision_output_path, temp_path, collision_temp_path]:
                if os.path.exists(path):
                    os.remove(path)
            if os.path.isdir(chunk_dir):
                import shutil

                shutil.rmtree(chunk_dir)

    def test_delete_outputs_rejects_invalid_job_id(self) -> None:
        response = self.client.delete("/api/outputs/bad..job")

        self.assertEqual(response.status_code, 400)

    def test_speaker_context_requires_topic_sections_first(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_speaker_context_requires_topics"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                        "summary": {
                            "generation_status": {
                                "topic_sections": "not_started",
                                "speaker_context_summaries": "not_started",
                            }
                        },
                    },
                    f,
                )

            response = self.client.post(f"/api/outputs/{job_id}/generate-speaker-context")

            self.assertEqual(response.status_code, 409)
            with open(output_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)
            self.assertEqual(
                result_data["summary"]["generation_status"]["speaker_context_summaries"],
                "not_started",
            )
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)


if __name__ == "__main__":
    unittest.main()
