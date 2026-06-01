import asyncio
import copy
import json
import os
import sys
import types
import tempfile
import unittest
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile

sys.path.insert(0, os.path.dirname(__file__))

import main
from analysis_jobs import AnalysisCancelledError, AnalysisJobRegistry
from job_checkpoints import atomic_write_json, build_job_checkpoint_paths, load_json_checkpoint
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

    def test_generation_progress_reports_active_generation(self) -> None:
        generation_key = ("unit_progress_job", "diarization")
        with main.GENERATION_STATUS_LOCK:
            main.ACTIVE_GENERATIONS.discard(generation_key)
            main.GENERATION_PROGRESS.pop(generation_key, None)
            main.GENERATION_STOP_REQUESTS.pop(generation_key, None)
            key = main._begin_generation(*generation_key)
            main._set_generation_progress(key, 42, "참석자 음성 구간 분석 중")

        try:
            response = self.client.get("/api/outputs/unit_progress_job/generation-progress/diarization")
            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertTrue(payload["active"])
            self.assertEqual(payload["progress"], 42)
            self.assertEqual(payload["message"], "참석자 음성 구간 분석 중")
        finally:
            with main.GENERATION_STATUS_LOCK:
                main._end_generation(generation_key)
                main.GENERATION_PROGRESS.pop(generation_key, None)
                main.GENERATION_STOP_REQUESTS.pop(generation_key, None)

    def test_generation_stop_defers_active_diarization(self) -> None:
        with tempfile.TemporaryDirectory() as output_dir:
            job_id = "unit_stop_job"
            generation_key = (job_id, "diarization")
            result_path = Path(output_dir) / f"{job_id}_result.json"
            result_path.write_text(json.dumps({
                "job_id": job_id,
                "raw_stt_segments": [{"start": 0.0, "end": 1.0, "text": "raw hello", "speaker": "SPEAKER_00"}],
                "segments": [{"start": 0.0, "end": 1.0, "text": "diarized hello", "speaker": "SPEAKER_01"}],
                "summary": {
                    "speaker_context_summaries": [{"speaker": "SPEAKER_01", "summary": "old speaker summary"}],
                    "participant_summaries": [{"participant": "참석자02", "summary": "old participant summary"}],
                    "generation_status": {"speaker_context_summaries": "completed"},
                },
                "settings": {"diarization": False, "diarization_generation_status": "generating"},
            }, ensure_ascii=False), encoding="utf-8")

            with main.GENERATION_STATUS_LOCK:
                main.ACTIVE_GENERATIONS.discard(generation_key)
                main.GENERATION_PROGRESS.pop(generation_key, None)
                main.GENERATION_STOP_REQUESTS.pop(generation_key, None)
                key = main._begin_generation(*generation_key)
                main._set_generation_progress(key, 30, "참석자 음성 구간 분석 중")

            try:
                with (
                    patch.object(main, "_get_output_dir", return_value=output_dir),
                    patch.object(main, "_refresh_summary_exports", return_value={"job_id": job_id}),
                ):
                    response = self.client.post(
                        f"/api/outputs/{job_id}/generation-stop/diarization",
                        json={"action": "defer"},
                    )
                    self.assertEqual(response.status_code, 200, response.text)
                    payload = response.json()
                    self.assertTrue(payload["active"])
                    self.assertTrue(payload["running"])
                    self.assertTrue(payload["accepted"])
                    self.assertEqual(payload["status"], "stopping")

                    progress_response = self.client.get(f"/api/outputs/{job_id}/generation-progress/diarization")
                    self.assertEqual(progress_response.status_code, 200)
                    progress = progress_response.json()
                    self.assertTrue(progress["active"])
                    self.assertEqual(progress["status"], "stopping")
                    self.assertIn("중지", progress["message"])
                    self.assertEqual(main.GENERATION_STOP_REQUESTS[generation_key]["action"], "defer")

                saved = json.loads(result_path.read_text(encoding="utf-8"))
                self.assertFalse(saved["settings"]["diarization"])
                self.assertTrue(saved["settings"]["diarization_requested"])
                self.assertTrue(saved["settings"]["diarization_deferred"])
                self.assertEqual(saved["settings"]["diarization_generation_status"], "deferred")
                self.assertEqual(saved["segments"][0]["text"], "raw hello")
                self.assertEqual(saved["summary"]["speaker_context_summaries"], [])
                self.assertEqual(saved["summary"]["participant_summaries"], [])
                self.assertEqual(saved["summary"]["generation_status"]["speaker_context_summaries"], "not_started")
                transcript_text = (Path(output_dir) / f"{job_id}_transcript.txt").read_text(encoding="utf-8")
                self.assertIn("raw hello", transcript_text)
                self.assertNotIn("diarized hello", transcript_text)
            finally:
                with main.GENERATION_STATUS_LOCK:
                    main._end_generation(generation_key)
                    main.GENERATION_PROGRESS.pop(generation_key, None)
                    main.GENERATION_STOP_REQUESTS.pop(generation_key, None)

    def test_generation_stop_cancel_marks_diarization_unused(self) -> None:
        with tempfile.TemporaryDirectory() as output_dir:
            job_id = "unit_cancel_diarization_job"
            generation_key = (job_id, "diarization")
            result_path = Path(output_dir) / f"{job_id}_result.json"
            result_path.write_text(json.dumps({
                "job_id": job_id,
                "raw_stt_segments": [{"start": 0.0, "end": 1.0, "text": "hello", "speaker": "Speaker"}],
                "segments": [{"start": 0.0, "end": 1.0, "text": "hello", "speaker": "Speaker"}],
                "summary": {
                    "speaker_context_summaries": [{"speaker": "Speaker", "summary": "old speaker summary"}],
                    "participant_summaries": [{"participant": "참석자", "summary": "old participant summary"}],
                    "generation_status": {"speaker_context_summaries": "completed"},
                },
                "settings": {
                    "diarization": False,
                    "diarization_requested": True,
                    "diarization_deferred": True,
                    "diarization_generation_status": "generating",
                },
            }, ensure_ascii=False), encoding="utf-8")

            with main.GENERATION_STATUS_LOCK:
                main.ACTIVE_GENERATIONS.discard(generation_key)
                main.GENERATION_PROGRESS.pop(generation_key, None)
                main.GENERATION_STOP_REQUESTS.pop(generation_key, None)
                key = main._begin_generation(*generation_key)
                main._set_generation_progress(key, 30, "참석자 음성 구간 분석 중")

            try:
                with (
                    patch.object(main, "_get_output_dir", return_value=output_dir),
                    patch.object(main, "_refresh_summary_exports", return_value={"job_id": job_id}),
                ):
                    response = self.client.post(
                        f"/api/outputs/{job_id}/generation-stop/diarization",
                        json={"action": "cancel"},
                    )
                    self.assertEqual(response.status_code, 200, response.text)
                    payload = response.json()
                    self.assertTrue(payload["active"])
                    self.assertTrue(payload["accepted"])
                    self.assertEqual(payload["status"], "stopping")
                    self.assertEqual(main.GENERATION_STOP_REQUESTS[generation_key]["action"], "cancel")

                saved = json.loads(result_path.read_text(encoding="utf-8"))
                self.assertFalse(saved["settings"]["diarization"])
                self.assertTrue(saved["settings"]["diarization_requested"])
                self.assertFalse(saved["settings"]["diarization_deferred"])
                self.assertEqual(saved["settings"]["diarization_defer_message"], "")
                self.assertEqual(saved["settings"]["diarization_generation_status"], "cancelled")
                self.assertEqual(saved["summary"]["speaker_context_summaries"], [])
                self.assertEqual(saved["summary"]["participant_summaries"], [])
                self.assertEqual(saved["summary"]["generation_status"]["speaker_context_summaries"], "not_started")
            finally:
                with main.GENERATION_STATUS_LOCK:
                    main._end_generation(generation_key)
                    main.GENERATION_PROGRESS.pop(generation_key, None)
                    main.GENERATION_STOP_REQUESTS.pop(generation_key, None)

    def test_generation_stop_noops_when_diarization_is_not_running(self) -> None:
        generation_key = ("unit_stop_idle_job", "diarization")
        with main.GENERATION_STATUS_LOCK:
            main.ACTIVE_GENERATIONS.discard(generation_key)
            main.GENERATION_PROGRESS.pop(generation_key, None)
            main.GENERATION_STOP_REQUESTS.pop(generation_key, None)

        response = self.client.post(
            "/api/outputs/unit_stop_idle_job/generation-stop/diarization",
            json={"action": "cancel"},
        )

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertFalse(payload["running"])
        self.assertFalse(payload["active"])
        self.assertFalse(payload["accepted"])
        self.assertNotIn(generation_key, main.GENERATION_STOP_REQUESTS)

    def test_generation_progress_is_limited_to_diarization(self) -> None:
        response = self.client.get("/api/outputs/unit_progress_job/generation-progress/summary")

        self.assertEqual(response.status_code, 404)

    def test_diarization_restore_uses_preserved_upload_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            job_id = "unit_restore_upload"
            config = {
                "paths": {"temp_dir": tmpdir, "ffmpeg": "ffmpeg.exe"},
                "preprocessing": {"enabled": True},
                "privacy": {"preserve_extracted_audio": True},
            }
            paths = build_job_checkpoint_paths(tmpdir, job_id)
            Path(paths.upload_dir).mkdir(parents=True, exist_ok=True)
            upload_path = Path(paths.upload_dir) / "source.mp4"
            upload_path.write_bytes(b"video")

            resolved = main._resolve_recoverable_source_path(
                config,
                job_id,
                {"sourceFile": "meeting.mp4"},
                {},
            )

        self.assertEqual(resolved, str(upload_path))

    def test_diarization_restore_requires_upload_source_filename(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            job_id = "unit_restore_upload_without_filename"
            config = {
                "paths": {"temp_dir": tmpdir, "ffmpeg": "ffmpeg.exe"},
                "preprocessing": {"enabled": True},
                "privacy": {"preserve_extracted_audio": True},
            }
            paths = build_job_checkpoint_paths(tmpdir, job_id)
            Path(paths.upload_dir).mkdir(parents=True, exist_ok=True)
            (Path(paths.upload_dir) / "source.mp4").write_bytes(b"video")

            resolved = main._resolve_recoverable_source_path(config, job_id, {}, {})

        self.assertIsNone(resolved)

    def test_diarization_restore_ignores_upload_with_mismatched_extension(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            job_id = "unit_restore_upload_mismatch"
            config = {
                "paths": {"temp_dir": tmpdir, "ffmpeg": "ffmpeg.exe"},
                "preprocessing": {"enabled": True},
                "privacy": {"preserve_extracted_audio": True},
            }
            paths = build_job_checkpoint_paths(tmpdir, job_id)
            Path(paths.upload_dir).mkdir(parents=True, exist_ok=True)
            (Path(paths.upload_dir) / "source.mp4").write_bytes(b"video")

            resolved = main._resolve_recoverable_source_path(
                config,
                job_id,
                {"sourceFile": "meeting.wav"},
                {},
            )

        self.assertIsNone(resolved)

    def test_diarization_restore_converts_known_sample_source(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            known_root = Path(tmpdir) / "samples"
            known_root.mkdir()
            source_path = known_root / "unit sample source.mp4"
            source_path.write_bytes(b"video")
            with patch.object(main, "_known_source_roots", return_value=[str(known_root)]):
                job_id = "unit_restore_known_source"
                config = {
                    "paths": {"temp_dir": tmpdir, "ffmpeg": "ffmpeg.exe"},
                    "preprocessing": {"enabled": True},
                    "privacy": {"preserve_extracted_audio": True},
                }
                paths = build_job_checkpoint_paths(tmpdir, job_id)

                def fake_convert(input_path, output_path, ffmpeg_path, preprocessing):
                    self.assertEqual(input_path, str(source_path))
                    self.assertEqual(ffmpeg_path, os.path.join(BACKEND_DIR, "ffmpeg.exe"))
                    self.assertTrue(preprocessing["enabled"])
                    Path(output_path).parent.mkdir(parents=True, exist_ok=True)
                    Path(output_path).write_bytes(b"wav")
                    return {"preprocessing": {"enabled": True}}

                recoverable_source = main._resolve_recoverable_source_path(
                    config,
                    job_id,
                    {"sourceFile": "unit_sample_source.mp4"},
                    {},
                )
                self.assertEqual(recoverable_source, str(source_path))

                with patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert):
                    restored_path = main._restore_job_audio_path_for_diarization(
                        config,
                        job_id,
                        recoverable_source,
                    )

                self.assertEqual(restored_path, paths.source_wav_path)
                self.assertEqual(Path(restored_path).read_bytes(), b"wav")
                state = load_json_checkpoint(paths.state_path)
                self.assertTrue(state["source_wav_restored"])
                self.assertEqual(state["source_filename"], source_path.name)

    def test_diarization_restore_uses_original_preprocessing_config(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            source_path = Path(tmpdir) / "meeting.mp4"
            source_path.write_bytes(b"video")
            job_id = "unit_restore_original_preprocessing"
            config = {
                "paths": {"temp_dir": tmpdir, "ffmpeg": "ffmpeg.exe"},
                "preprocessing": {"enabled": True, "normalize_audio": True},
                "privacy": {"preserve_extracted_audio": True},
            }
            paths = build_job_checkpoint_paths(tmpdir, job_id)
            atomic_write_json(paths.state_path, {
                "preprocessing_config": {"enabled": False, "normalize_audio": False},
            })

            def fake_convert(_input_path, output_path, _ffmpeg_path, preprocessing):
                self.assertEqual(preprocessing, {"enabled": False, "normalize_audio": False})
                Path(output_path).parent.mkdir(parents=True, exist_ok=True)
                Path(output_path).write_bytes(b"wav")
                return {"preprocessing": preprocessing}

            with patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert):
                restored_path = main._restore_job_audio_path_for_diarization(
                    config,
                    job_id,
                    str(source_path),
                )

            self.assertEqual(restored_path, paths.source_wav_path)
            state = load_json_checkpoint(paths.state_path)
            self.assertEqual(state["preprocessing_config"], {"enabled": False, "normalize_audio": False})
            self.assertEqual(state["preprocessing_applied"], {"enabled": False, "normalize_audio": False})

    def test_known_source_roots_do_not_include_project_root(self) -> None:
        project_root = os.path.abspath(os.path.dirname(BACKEND_DIR))

        self.assertNotIn(project_root, main._known_source_roots())

    def test_diarization_restore_ignores_non_media_sources(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            known_root = Path(tmpdir) / "samples"
            known_root.mkdir()
            (known_root / "meeting.txt").write_text("not media", encoding="utf-8")
            config = {
                "paths": {"temp_dir": tmpdir, "ffmpeg": "ffmpeg.exe"},
                "preprocessing": {"enabled": True},
                "privacy": {"preserve_extracted_audio": True},
            }

            with patch.object(main, "_known_source_roots", return_value=[str(known_root)]):
                resolved = main._resolve_recoverable_source_path(
                    config,
                    "unit_restore_non_media",
                    {"sourceFile": "meeting.txt"},
                    {},
                )

        self.assertIsNone(resolved)

    def test_diarization_generation_omits_audio_output_when_restored_wav_is_deleted(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            job_id = "unit_diarization_restore_delete"
            output_dir = os.path.join(tmpdir, "outputs")
            temp_dir = os.path.join(tmpdir, "temp")
            os.makedirs(output_dir, exist_ok=True)
            config = {
                "paths": {
                    "temp_dir": temp_dir,
                    "output_dir": output_dir,
                    "ffmpeg": "ffmpeg.exe",
                    "diarization_model": "model",
                },
                "preprocessing": {"enabled": True},
                "privacy": {
                    "preserve_extracted_audio": False,
                    "save_original_audio_copy": True,
                },
                "diarization": {"enabled": True},
            }
            paths = build_job_checkpoint_paths(temp_dir, job_id)
            Path(paths.upload_dir).mkdir(parents=True, exist_ok=True)
            (Path(paths.upload_dir) / "source.mp4").write_bytes(b"video")
            result_path = Path(output_dir) / f"{job_id}_result.json"
            result_path.write_text(json.dumps({
                "job_id": job_id,
                "source_file": "meeting.mp4",
                "raw_stt_segments": [{"start": 0.0, "end": 5.0, "text": "hello", "speaker": "Speaker"}],
                "segments": [{"start": 0.0, "end": 5.0, "text": "hello", "speaker": "Speaker"}],
                "summary": {"generation_status": {}},
                "settings": {"diarization": False},
            }, ensure_ascii=False), encoding="utf-8")

            def fake_convert(_input_path, output_path, _ffmpeg_path, preprocessing=None):
                Path(output_path).parent.mkdir(parents=True, exist_ok=True)
                Path(output_path).write_bytes(b"wav")
                return {"preprocessing": {}}

            with (
                patch.object(main, "load_config", return_value=config),
                patch.object(main, "model_exists", return_value=True),
                patch.object(main, "resolve_model_path", return_value=TEST_AUDIO_PATH),
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert),
                patch("pipeline.chunk_audio.get_wav_duration_seconds", return_value=5.0),
                patch("pipeline.diarize.diarize_audio", return_value=[{"start": 0.0, "end": 5.0, "speaker": "화자000"}]),
                patch("pipeline.align_speakers.align_segments_with_speakers", return_value=[
                    {"start": 0.0, "end": 5.0, "text": "hello", "speaker": "화자000"},
                ]),
                patch("pipeline.export_txt.export_txt"),
                patch.object(main, "_refresh_summary_exports", side_effect=lambda _job_id, _result_data: main._result_outputs(_job_id)),
            ):
                response = self.client.post(
                    f"/api/outputs/{job_id}/generate-diarization",
                    json={"sourceFile": "meeting.mp4"},
                )

            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertNotIn("audio", payload["outputs"])
            self.assertFalse(Path(paths.source_wav_path).exists())
            state = load_json_checkpoint(paths.state_path)
            self.assertTrue(state["source_wav_deleted"])

    def test_diarization_stop_during_export_is_not_marked_completed(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            job_id = "unit_diarization_stop_during_export"
            output_dir = os.path.join(tmpdir, "outputs")
            temp_dir = os.path.join(tmpdir, "temp")
            os.makedirs(output_dir, exist_ok=True)
            config = {
                "paths": {
                    "temp_dir": temp_dir,
                    "output_dir": output_dir,
                    "ffmpeg": "ffmpeg.exe",
                    "diarization_model": "model",
                },
                "preprocessing": {"enabled": True},
                "privacy": {"preserve_extracted_audio": True},
                "diarization": {"enabled": True},
            }
            result_path = Path(output_dir) / f"{job_id}_result.json"
            result_path.write_text(json.dumps({
                "job_id": job_id,
                "source_file": "meeting.wav",
                "raw_stt_segments": [{"start": 0.0, "end": 5.0, "text": "raw hello", "speaker": "SPEAKER_00"}],
                "segments": [{"start": 0.0, "end": 5.0, "text": "raw hello", "speaker": "SPEAKER_00"}],
                "summary": {
                    "speaker_context_summaries": [{"speaker": "SPEAKER_00", "summary": "old speaker summary"}],
                    "participant_summaries": [{"participant": "참석자01", "summary": "old participant summary"}],
                    "generation_status": {"speaker_context_summaries": "completed"},
                },
                "settings": {"diarization": False},
            }, ensure_ascii=False), encoding="utf-8")

            with (
                patch.object(main, "load_config", return_value=config),
                patch.object(main, "_resolve_job_audio_path", return_value=TEST_AUDIO_PATH),
                patch.object(main, "model_exists", return_value=True),
                patch.object(main, "resolve_model_path", return_value=TEST_AUDIO_PATH),
                patch("pipeline.chunk_audio.get_wav_duration_seconds", return_value=5.0),
                patch("pipeline.diarize.diarize_audio", return_value=[{"start": 0.0, "end": 5.0, "speaker": "SPEAKER_01"}]),
                patch("pipeline.align_speakers.align_segments_with_speakers", return_value=[
                    {"start": 0.0, "end": 5.0, "text": "diarized hello", "speaker": "SPEAKER_01"},
                ]),
                patch.object(
                    main,
                    "_refresh_transcript_and_summary_exports",
                    side_effect=main.HTTPException(status_code=409, detail=main.DETAIL_DIARIZATION_CANCELLED),
                ),
                patch.object(main.logging, "exception"),
            ):
                response = self.client.post(f"/api/outputs/{job_id}/generate-diarization")

            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"], main.DETAIL_DIARIZATION_CANCELLED)
            result_data = json.loads(result_path.read_text(encoding="utf-8"))
            self.assertFalse(result_data["settings"]["diarization"])
            self.assertFalse(result_data["settings"]["diarization_requested"])
            self.assertEqual(result_data["settings"]["diarization_generation_status"], "cancelled")
            self.assertEqual(result_data["segments"][0]["text"], "raw hello")
            self.assertEqual(result_data["summary"]["speaker_context_summaries"], [])
            self.assertEqual(result_data["summary"]["participant_summaries"], [])
            self.assertEqual(result_data["summary"]["generation_status"]["speaker_context_summaries"], "not_started")

    def test_generation_progress_prunes_inactive_entries(self) -> None:
        with main.GENERATION_STATUS_LOCK:
            original_progress = dict(main.GENERATION_PROGRESS)
            original_active = set(main.ACTIVE_GENERATIONS)
            main.GENERATION_PROGRESS.clear()
            main.ACTIVE_GENERATIONS.clear()
            try:
                for index in range(main.GENERATION_PROGRESS_MAX_ENTRIES + 5):
                    main.GENERATION_PROGRESS[(f"old_{index}", "diarization")] = {
                        "active": False,
                        "inactive_at_epoch": 0.0,
                        "updated_at_epoch": 0.0,
                    }
                main.GENERATION_PROGRESS[("active_job", "diarization")] = {
                    "active": True,
                    "updated_at_epoch": 0.0,
                }

                main._prune_generation_progress_locked(now=main.GENERATION_PROGRESS_TTL_SECONDS + 1.0)

                self.assertEqual(set(main.GENERATION_PROGRESS), {("active_job", "diarization")})
            finally:
                main.GENERATION_PROGRESS.clear()
                main.GENERATION_PROGRESS.update(original_progress)
                main.ACTIVE_GENERATIONS.clear()
                main.ACTIVE_GENERATIONS.update(original_active)

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

    def test_model_status_uses_faster_whisper_even_with_legacy_selection(self) -> None:
        fake_status = {
            "models": [
                {"key": "stt_faster_whisper", "installed": False, "required": True},
                {"key": "diarization", "installed": True, "required": True},
            ]
        }

        with (
            patch("main.get_model_status", return_value=fake_status),
            patch("main.load_config", return_value={"stt": {"selected_model": "qwen3-asr"}, "diarization": {"enabled": False}}),
            patch("main.get_stt_device_status", return_value={"gpu_usable": False, "gpu_reason": "GPU unavailable", "recommended_device": "cpu", "selected_device_allowed": ["cpu"]}),
            patch.object(main, "ollama_model_exists", return_value=False),
        ):
            response = self.client.get("/api/models/status")

        self.assertEqual(response.status_code, 200)
        payload = response.json()
        required_by_key = {model["key"]: model["required"] for model in payload["models"]}
        self.assertTrue(required_by_key["stt_faster_whisper"])
        self.assertFalse(required_by_key["diarization"])
        self.assertFalse(payload["diarization_enabled"])
        self.assertFalse(payload["ready"])
        self.assertEqual(payload["selected_stt_model"], "faster-whisper-large-v3")

    def test_summary_model_readiness_reports_missing_default_ollama_model(self) -> None:
        with patch.object(main, "ollama_model_exists", return_value=False):
            readiness = main._summary_model_readiness({"summary": {"enabled": True}, "paths": {}})

        self.assertFalse(readiness["ready"])
        self.assertEqual(readiness["status"], "skipped")
        self.assertIn("gemma-4b", readiness["message"])

    def test_summary_model_readiness_accepts_available_ollama_model(self) -> None:
        with patch.object(main, "ollama_model_exists", return_value=True):
            readiness = main._summary_model_readiness({"summary": {"enabled": True, "model": "gemma-4b"}, "paths": {}})

        self.assertTrue(readiness["ready"])
        self.assertEqual(readiness["status"], "ready")

    def test_save_copy_rejects_missing_origin(self) -> None:
        response = self.client.post("/api/export-record/txt/save-copy", json={"title": "테스트 회의"})

        self.assertEqual(response.status_code, 403)

    def test_save_copy_rejects_disallowed_origin(self) -> None:
        response = self.client.post(
            "/api/export-record/txt/save-copy",
            json={"title": "테스트 회의"},
            headers={"Origin": "https://example.invalid"},
        )

        self.assertEqual(response.status_code, 403)

    def test_save_copy_accepts_allowed_origin(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            target_path = Path(tmpdir) / "meeting.txt"

            def fake_export_record_to_download_path(kind, payload, output_path):
                output_path.write_text("ok", encoding="utf-8")
                return {"summary": {"title": payload.get("title") or "회의록"}}

            with (
                patch.object(main, "_unique_download_path", return_value=target_path),
                patch.object(main, "_export_record_to_download_path", side_effect=fake_export_record_to_download_path),
            ):
                response = self.client.post(
                    "/api/export-record/txt/save-copy",
                    json={"title": "테스트 회의"},
                    headers={"Origin": "http://localhost:5173"},
                )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.json()["kind"], "txt")

    def test_save_copy_accepts_env_configured_origin(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            target_path = Path(tmpdir) / "meeting.txt"

            def fake_export_record_to_download_path(kind, payload, output_path):
                output_path.write_text("ok", encoding="utf-8")
                return {"summary": {"title": payload.get("title") or "회의록"}}

            with (
                patch.dict(os.environ, {"MEETING_AI_SAVE_COPY_ALLOWED_ORIGINS": "http://localhost:5174"}),
                patch.object(main, "_unique_download_path", return_value=target_path),
                patch.object(main, "_export_record_to_download_path", side_effect=fake_export_record_to_download_path),
            ):
                response = self.client.post(
                    "/api/export-record/txt/save-copy",
                    json={"title": "테스트 회의"},
                    headers={"Origin": "http://localhost:5174"},
                )

        self.assertEqual(response.status_code, 200, response.text)

    def test_extract_audio_copy_rejects_missing_origin(self) -> None:
        response = self.client.post(
            "/api/tools/extract-audio/save-copy",
            files={"file": ("meeting.mp4", b"video", "video/mp4")},
        )

        self.assertEqual(response.status_code, 403)

    def test_extract_audio_copy_saves_converted_wav(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            target_path = Path(tmpdir) / "meeting.wav"
            fake_config = {
                "paths": {"temp_dir": tmpdir, "ffmpeg": "ffmpeg.exe"},
                "preprocessing": {},
            }

            def fake_convert(input_path, output_path, ffmpeg_path, preprocessing):
                self.assertTrue(input_path.endswith("source.mp4"))
                self.assertEqual(ffmpeg_path, os.path.join(BACKEND_DIR, "ffmpeg.exe"))
                self.assertEqual(preprocessing, {"enabled": False})
                Path(output_path).write_bytes(b"wav")
                return {"path": output_path, "preprocessing": {}}

            with (
                patch.object(main, "load_config", return_value=fake_config),
                patch.object(main, "_unique_download_path", return_value=target_path),
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert),
            ):
                response = self.client.post(
                    "/api/tools/extract-audio/save-copy",
                    files={"file": ("meeting.mp4", b"video", "video/mp4")},
                    headers={"Origin": "http://localhost:5173"},
                )

            self.assertEqual(response.status_code, 200, response.text)
            self.assertEqual(response.json()["kind"], "audio")
            self.assertEqual(response.json()["saved_path"], str(target_path))
            self.assertEqual(target_path.read_bytes(), b"wav")

    def test_extract_audio_copy_rejects_unsupported_extension(self) -> None:
        response = self.client.post(
            "/api/tools/extract-audio/save-copy",
            files={"file": ("meeting.txt", b"text", "text/plain")},
            headers={"Origin": "http://localhost:5173"},
        )

        self.assertEqual(response.status_code, 400)
        self.assertEqual(response.json()["detail"], "지원하지 않는 파일 형식입니다.")

    def test_audio_output_rejects_missing_origin(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = build_job_checkpoint_paths(tmpdir, "unit_audio_origin")
            os.makedirs(os.path.dirname(paths.source_wav_path), exist_ok=True)
            Path(paths.source_wav_path).write_bytes(b"wav")
            with patch.object(main, "load_config", return_value={"paths": {"temp_dir": tmpdir}}):
                response = self.client.get("/api/outputs/unit_audio_origin/audio")

        self.assertEqual(response.status_code, 403)

    def test_audio_output_accepts_allowed_origin(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            paths = build_job_checkpoint_paths(tmpdir, "unit_audio_origin_ok")
            os.makedirs(os.path.dirname(paths.source_wav_path), exist_ok=True)
            Path(paths.source_wav_path).write_bytes(b"wav")
            with patch.object(main, "load_config", return_value={"paths": {"temp_dir": tmpdir}}):
                response = self.client.get(
                    "/api/outputs/unit_audio_origin_ok/audio",
                    headers={"Origin": "http://localhost:5173"},
                )

        self.assertEqual(response.status_code, 200, response.text)
        self.assertEqual(response.content, b"wav")

    def test_auto_save_completed_outputs_copies_enabled_files(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            source_dir = Path(tmpdir) / "source"
            download_dir = Path(tmpdir) / "downloads"
            source_dir.mkdir()
            download_dir.mkdir()
            hwpx_path = source_dir / "report.hwpx"
            audio_path = source_dir / "source.wav"
            hwpx_path.write_bytes(b"hwpx")
            audio_path.write_bytes(b"wav")

            def fake_unique_download_path(filename: str) -> Path:
                return download_dir / filename

            with patch.object(main, "_unique_download_path", side_effect=fake_unique_download_path):
                saved, errors = main._auto_save_completed_outputs(
                    result_data={"summary": {"title": "회의"}},
                    title="회의",
                    hwpx_path=str(hwpx_path),
                    audio_path=str(audio_path),
                    privacy_config={
                        "auto_save_hwpx_copy": True,
                        "auto_save_audio_copy": True,
                    },
                )

        self.assertEqual(errors, {})
        self.assertIn("hwpx", saved)
        self.assertIn("audio", saved)
        self.assertTrue(saved["hwpx"].endswith(".hwpx"))
        self.assertTrue(saved["audio"].endswith(".wav"))

    def test_auto_save_completed_outputs_respects_disabled_options(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            source_path = Path(tmpdir) / "report.hwpx"
            source_path.write_bytes(b"hwpx")

            with patch.object(main, "_unique_download_path") as unique_download_path:
                saved, errors = main._auto_save_completed_outputs(
                    result_data={"summary": {"title": "회의"}},
                    title="회의",
                    hwpx_path=str(source_path),
                    audio_path=None,
                    privacy_config={
                        "auto_save_hwpx_copy": False,
                        "auto_save_audio_copy": False,
                    },
                )

        self.assertEqual(saved, {})
        self.assertEqual(errors, {})
        unique_download_path.assert_not_called()

    def test_auto_save_completed_outputs_reports_enabled_missing_artifact(self) -> None:
        saved, errors = main._auto_save_completed_outputs(
            result_data={"summary": {"title": "회의"}},
            title="회의",
            hwpx_path=None,
            audio_path=None,
            privacy_config={
                "auto_save_hwpx_copy": True,
                "auto_save_audio_copy": True,
            },
        )

        self.assertEqual(saved, {})
        self.assertIn("hwpx", errors)
        self.assertIn("audio", errors)

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

    def test_generic_models_path_migrates_to_default_model_path(self) -> None:
        normalized = normalize_stt_config({
            "paths": {"stt_model": "../models"},
            "stt": {"selected_model": "qwen3-asr"},
        })

        self.assertEqual(normalized["paths"]["stt_model"], "../models/faster-whisper-large-v3")
        self.assertEqual(normalized["stt"]["selected_model"], "faster-whisper-large-v3")

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
        self.assertEqual(registry.get_action("unit_job"), "stop")
        registry.remove("unit_job")
        self.assertFalse(registry.cancel("unit_job"))

    def test_analysis_job_registry_records_cancel_action(self) -> None:
        registry = AnalysisJobRegistry()
        cancel_event = registry.create("unit_job")

        self.assertTrue(registry.cancel("unit_job", "cancel"))
        self.assertTrue(cancel_event.is_set())
        self.assertEqual(registry.get_action("unit_job"), "cancel")
        registry.remove("unit_job")

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
        self.assertEqual(heartbeat["message"], "음성 인식 중입니다.")

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

    def test_real_analysis_stream_sends_transcript_ready_marker(self) -> None:
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
            progress_callback(
                "대화록 저장이 완료되었습니다. 후속 정리를 확인하고 있습니다.",
                66,
                {"transcript_ready": True},
            )
            return {
                "job_id": job_id,
                "result_data": {
                    "summary": {"overview": "transcript ready test", "topics": [], "actions": []},
                    "segments": [{"start": 0.0, "end": 1.0, "text": "hello"}],
                },
            }

        async def collect_events() -> list[str]:
            upload = UploadFile(filename="test_audio.wav", file=BytesIO(b"audio"))
            events = []
            async for event in stream_real_analysis(
                "transcript ready test",
                "2026-05-08T10:00",
                "tester",
                upload,
                "unit_transcript_ready_stream",
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
        ):
            events = asyncio.run(collect_events())

        body = "\n".join(events)
        self.assertIn("event: progress", body)
        self.assertIn('"transcript_ready": true', body)
        self.assertIn("event: result", body)
        self.assertIn("event: done", body)

    def test_analyze_meeting_saves_upload_before_streaming(self) -> None:
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
        seen = {}

        def fake_process_audio_pipeline(upload_path, job_id, config, progress_callback, cancel_event=None):
            seen["upload_exists"] = os.path.exists(upload_path)
            seen["upload_size"] = os.path.getsize(upload_path)
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
            upload = UploadFile(filename="test_audio.wav", file=BytesIO(b"audio bytes"))
            response = await main.analyze_meeting(
                "테스트 회의",
                "2026-05-12T10:00",
                "홍길동",
                upload,
                "real",
                "unit_saved_before_stream",
            )
            upload.file.close()
            events = []
            async for chunk in response.body_iterator:
                events.append(chunk.decode("utf-8") if isinstance(chunk, bytes) else chunk)
                if "event: done" in events[-1]:
                    break
            return events

        with (
            patch("main.load_config", return_value=fake_config),
            patch("main.model_exists", return_value=True),
            patch("main.resolve_model_path", return_value="mock-model-path"),
            patch("main.process_audio_pipeline", side_effect=fake_process_audio_pipeline),
        ):
            events = asyncio.run(collect_events())

        body = "\n".join(events)
        self.assertTrue(seen["upload_exists"])
        self.assertEqual(seen["upload_size"], len(b"audio bytes"))
        self.assertIn("event: result", body)
        self.assertIn("test_audio.wav", body)

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

    def test_real_analysis_cancel_persists_checkpoint_state(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            fake_config = {
                "paths": {
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "output_dir": os.path.join(work_dir, "outputs"),
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
                    "unit_cancel_persist",
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
            ):
                events = asyncio.run(collect_events())

            body = "\n".join(events)
            paths = build_job_checkpoint_paths(fake_config["paths"]["temp_dir"], "unit_cancel_persist")
            state = load_json_checkpoint(paths.state_path)

            self.assertIn("event: stopped", body)
            self.assertIn('"status": "stopped"', body)
            self.assertIn("분석을 중지했습니다", body)
            self.assertEqual(state["stage"], "stopped")
            self.assertTrue(state["cancelled"])
            self.assertEqual(state["cancel_action"], "stop")
            self.assertTrue(state["resume_supported"])

    def test_real_analysis_cancel_action_deletes_resume_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            fake_config = {
                "paths": {
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "stt_model": "../models/faster-whisper-large-v3",
                    "qwen_aligner_model": "../models/Qwen3-ForcedAligner-0.6B",
                },
                "stt": {"selected_model": "faster-whisper-large-v3"},
                "diarization": {"enabled": False},
                "privacy": {"save_original_audio_copy": False},
            }

            def fake_process_audio_pipeline(upload_path, job_id, config, progress_callback, cancel_event):
                main.ANALYSIS_JOBS.cancel(job_id, "cancel")
                raise AnalysisCancelledError("분석이 취소되었습니다.")

            async def collect_events() -> list[str]:
                upload = UploadFile(filename="test_audio.wav", file=BytesIO(b"audio"))
                events = []
                async for event in stream_real_analysis(
                    "테스트 회의",
                    "2026-05-08T10:00",
                    "홍길동",
                    upload,
                    "unit_cancel_delete",
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
            ):
                events = asyncio.run(collect_events())

            body = "\n".join(events)
            paths = build_job_checkpoint_paths(fake_config["paths"]["temp_dir"], "unit_cancel_delete")

            self.assertIn('"action": "cancel"', body)
            self.assertIn('"status": "cancelled"', body)
            self.assertFalse(os.path.exists(paths.state_path))

    def test_resume_candidates_returns_matching_unfinished_job(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            fake_config = {
                "paths": {
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "stt_model": "../models/faster-whisper-large-v3",
                    "diarization_model": "",
                    "llm_model": "",
                },
                "stt": {"selected_model": "faster-whisper-large-v3", "device": "cpu"},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True},
            }
            matching_paths = build_job_checkpoint_paths(fake_config["paths"]["temp_dir"], "resume_match")
            os.makedirs(os.path.dirname(matching_paths.state_path), exist_ok=True)
            atomic_write_json(matching_paths.state_path, {
                "job_id": "resume_match",
                "stage": "cancelled",
                "resume_supported": True,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "config_fingerprint": main._analysis_config_fingerprint(fake_config),
                "completed_chunk_indices": [0, 1],
                "chunk_count": 4,
                "last_progress": {
                    "message": "대화록 저장이 완료되었습니다. 후속 정리를 확인하고 있습니다.",
                    "progress": 66,
                    "status": "processing",
                    "transcript_ready": True,
                },
                "transcript_ready": True,
                "updated_at": "2026-05-13T09:30:00",
            })
            completed_paths = build_job_checkpoint_paths(fake_config["paths"]["temp_dir"], "resume_done")
            os.makedirs(os.path.dirname(completed_paths.state_path), exist_ok=True)
            atomic_write_json(completed_paths.state_path, {
                "job_id": "resume_done",
                "stage": "completed",
                "resume_supported": True,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "config_fingerprint": main._analysis_config_fingerprint(fake_config),
                "updated_at": "2026-05-13T09:40:00",
            })

            with patch("main.load_config", return_value=fake_config):
                response = self.client.post(
                    "/api/analyze/resume-candidates",
                    json={
                        "source_filename": "meeting.mp4",
                        "source_size": 1234,
                        "source_last_modified": 987654321,
                    },
                )

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["recommended_job_id"], "resume_match")
            self.assertEqual(len(payload["candidates"]), 1)
            self.assertEqual(payload["candidates"][0]["job_id"], "resume_match")
            self.assertEqual(payload["candidates"][0]["completed_chunk_count"], 2)
            self.assertTrue(payload["candidates"][0]["last_progress"]["transcript_ready"])

    def test_analysis_config_fingerprint_ignores_summary_settings(self) -> None:
        base_config = {
            "paths": {
                "stt_model": "../models/faster-whisper-large-v3",
                "diarization_model": "../models",
                "llm_model": "./models/llm/old.gguf",
            },
            "stt": {"selected_model": "faster-whisper-large-v3", "device": "cpu"},
            "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
            "preprocessing": {"enabled": True},
            "diarization": {"enabled": True},
            "summary": {"enabled": True, "model": "old-model"},
        }
        changed_summary_config = copy.deepcopy(base_config)
        changed_summary_config["summary"] = {
            "enabled": False,
            "model": "new-model",
            "generate_during_analysis": True,
        }
        changed_summary_config["paths"]["llm_model"] = "./models/llm/new.gguf"
        changed_summary_config["paths"]["stt_model"] = "D:/resolved/models/faster-whisper-large-v3"
        changed_summary_config["paths"]["diarization_model"] = "D:/resolved/models/diarization"

        self.assertEqual(
            main._analysis_config_fingerprint(base_config),
            main._analysis_config_fingerprint(changed_summary_config),
        )

    def test_resume_candidates_accepts_legacy_summary_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            fake_config = {
                "paths": {
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "stt_model": "../models/faster-whisper-large-v3",
                    "diarization_model": "",
                    "llm_model": "./models/llm/gemma.gguf",
                },
                "stt": {"selected_model": "faster-whisper-large-v3", "device": "cpu"},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": True, "model": "gemma4:e2b"},
                "privacy": {"auto_delete_temp_audio": True},
            }
            paths = build_job_checkpoint_paths(fake_config["paths"]["temp_dir"], "legacy_resume")
            os.makedirs(os.path.dirname(paths.state_path), exist_ok=True)
            atomic_write_json(paths.state_path, {
                "job_id": "legacy_resume",
                "stage": "cancelled",
                "resume_supported": True,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "config_fingerprint": main._analysis_legacy_config_fingerprint(fake_config),
                "completed_chunk_indices": [0, 1, 2],
                "chunk_count": 3,
                "last_progress": {"message": "Summarizing with Local LLM...", "progress": 85, "status": "processing"},
            })

            with patch("main.load_config", return_value=fake_config):
                response = self.client.post(
                    "/api/analyze/resume-candidates",
                    json={
                        "source_filename": "meeting.mp4",
                        "source_size": 1234,
                        "source_last_modified": 987654321,
                    },
                )

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["recommended_job_id"], "legacy_resume")

    def test_resume_candidates_accepts_prepared_legacy_model_paths(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            fake_config = {
                "paths": {
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "stt_model": "../models/faster-whisper-large-v3",
                    "diarization_model": "../models",
                    "llm_model": "./models/llm/gemma.gguf",
                },
                "stt": {"selected_model": "faster-whisper-large-v3", "device": "cpu"},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": True, "generate_during_analysis": True},
                "summary": {"enabled": True, "model": "gemma4:e2b"},
                "privacy": {"auto_delete_temp_audio": True},
            }
            prepared_config = copy.deepcopy(fake_config)
            prepared_config["paths"]["stt_model"] = os.path.join(work_dir, "models", "faster-whisper-large-v3")
            prepared_config["paths"]["diarization_model"] = os.path.join(work_dir, "models", "speaker-diarization-community-1")
            paths = build_job_checkpoint_paths(fake_config["paths"]["temp_dir"], "prepared_legacy_resume")
            os.makedirs(os.path.dirname(paths.state_path), exist_ok=True)
            atomic_write_json(paths.state_path, {
                "job_id": "prepared_legacy_resume",
                "stage": "cancelled",
                "resume_supported": True,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "config_fingerprint": main._analysis_legacy_config_fingerprint(prepared_config),
                "completed_chunk_indices": [0, 1, 2],
                "chunk_count": 3,
                "last_progress": {"message": "Summarizing with Local LLM...", "progress": 85, "status": "processing"},
            })

            with (
                patch("main.load_config", return_value=fake_config),
                patch("main.model_exists", return_value=True),
                patch("main.resolve_model_path", side_effect=[
                    prepared_config["paths"]["stt_model"],
                    prepared_config["paths"]["diarization_model"],
                ]),
            ):
                response = self.client.post(
                    "/api/analyze/resume-candidates",
                    json={
                        "source_filename": "meeting.mp4",
                        "source_size": 1234,
                        "source_last_modified": 987654321,
                    },
                )

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["recommended_job_id"], "prepared_legacy_resume")

    def test_draft_statuses_returns_backend_truth_for_active_and_completed_jobs(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            fake_config = {
                "paths": {
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "stt_model": "../models/faster-whisper-large-v3",
                    "diarization_model": "",
                    "llm_model": "",
                },
                "stt": {"selected_model": "faster-whisper-large-v3", "device": "cpu"},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True},
            }
            active_paths = build_job_checkpoint_paths(fake_config["paths"]["temp_dir"], "draft_active")
            completed_paths = build_job_checkpoint_paths(fake_config["paths"]["temp_dir"], "draft_done")
            os.makedirs(os.path.dirname(active_paths.state_path), exist_ok=True)
            os.makedirs(os.path.dirname(completed_paths.state_path), exist_ok=True)
            atomic_write_json(active_paths.state_path, {
                "job_id": "draft_active",
                "stage": "transcribing",
                "resume_supported": True,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "last_progress": {
                    "message": "대화록 저장이 완료되었습니다. 후속 정리를 확인하고 있습니다.",
                    "progress": 66,
                    "status": "processing",
                    "transcript_ready": True,
                },
                "transcript_ready": True,
                "updated_at": "2026-05-13T09:30:00",
            })
            atomic_write_json(completed_paths.state_path, {
                "job_id": "draft_done",
                "stage": "completed",
                "resume_supported": True,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "updated_at": "2026-05-13T09:40:00",
            })

            cancel_event = main.ANALYSIS_JOBS.create("draft_active")
            try:
                with patch("main.load_config", return_value=fake_config):
                    response = self.client.post(
                        "/api/analyze/draft-statuses",
                        json={"job_ids": ["draft_active", "draft_done", "missing_job"]},
                    )
            finally:
                main.ANALYSIS_JOBS.remove("draft_active", cancel_event)

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            by_job = {item["job_id"]: item for item in payload["drafts"]}
            self.assertEqual(by_job["draft_active"]["status"], "active")
            self.assertTrue(by_job["draft_active"]["active"])
            self.assertTrue(by_job["draft_active"]["last_progress"]["transcript_ready"])
            self.assertEqual(by_job["draft_done"]["status"], "completed")
            self.assertEqual(by_job["missing_job"]["status"], "missing")

    def test_analyze_rejects_active_job_before_overwriting_upload_or_state(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            fake_config = {
                "paths": {
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "stt_model": "../models/faster-whisper-large-v3",
                    "diarization_model": "",
                    "llm_model": "",
                },
                "stt": {"selected_model": "faster-whisper-large-v3", "device": "cpu"},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True},
            }
            job_id = "active_resume_job"
            checkpoint_paths = build_job_checkpoint_paths(fake_config["paths"]["temp_dir"], job_id)
            os.makedirs(checkpoint_paths.upload_dir, exist_ok=True)
            upload_path = os.path.join(checkpoint_paths.upload_dir, "source.mp4")
            with open(upload_path, "wb") as handle:
                handle.write(b"existing upload")
            atomic_write_json(checkpoint_paths.state_path, {
                "job_id": job_id,
                "stage": "transcribing",
                "resume_supported": True,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "config_fingerprint": main._analysis_config_fingerprint(fake_config),
                "completed_chunk_indices": [0],
                "chunk_count": 4,
            })

            cancel_event = main.ANALYSIS_JOBS.create(job_id)
            try:
                with patch("main.load_config", return_value=fake_config):
                    response = self.client.post(
                        "/api/analyze",
                        data={
                            "title": "중복 분석",
                            "date": "2026-05-13T10:00",
                            "participants": "홍길동",
                            "mode": "real",
                            "job_id": job_id,
                            "file_size": "1234",
                            "file_last_modified": "987654321",
                        },
                        files={"file": ("meeting.mp4", b"new upload", "video/mp4")},
                    )
            finally:
                main.ANALYSIS_JOBS.remove(job_id, cancel_event)

            self.assertEqual(response.status_code, 409)
            with open(upload_path, "rb") as handle:
                self.assertEqual(handle.read(), b"existing upload")
            state = load_json_checkpoint(checkpoint_paths.state_path)
            self.assertEqual(state["stage"], "transcribing")
            self.assertEqual(state["completed_chunk_indices"], [0])

    def test_pipeline_reset_preserves_current_upload_for_same_job_rerun(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True},
            }
            job_id = "unit_resume_reset"
            checkpoint_paths = build_job_checkpoint_paths(config["paths"]["temp_dir"], job_id)
            os.makedirs(checkpoint_paths.upload_dir, exist_ok=True)
            upload_path = os.path.join(checkpoint_paths.upload_dir, "source.wav")
            with open(upload_path, "wb") as handle:
                handle.write(b"new upload")
            atomic_write_json(checkpoint_paths.state_path, {
                "job_id": job_id,
                "input_fingerprint": "old-fingerprint",
                "config_fingerprint": "old-config",
                "source_file": "meeting.mp4",
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
            })

            seen = {}

            def fake_convert_to_wav(input_file, output_path, _ffmpeg_path, preprocessing):
                seen["input_exists_at_convert"] = os.path.exists(input_file)
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": upload_path, "offset": 0.0, "duration": 1.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", return_value=[{"start": 0.0, "end": 1.0, "text": "hello"}]),
                patch("pipeline.export_txt.export_txt"),
            ):
                process_audio_pipeline(upload_path, job_id, config)

            state = load_json_checkpoint(checkpoint_paths.state_path)
            self.assertTrue(seen["input_exists_at_convert"])
            self.assertEqual(state["source_filename"], "meeting.mp4")
            self.assertEqual(state["source_size"], 1234)

    def test_pipeline_returns_resume_reuse_metadata_when_chunk_checkpoint_exists(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True},
            }
            job_id = "unit_resume_reuse_metadata"
            checkpoint_paths = build_job_checkpoint_paths(config["paths"]["temp_dir"], job_id)
            os.makedirs(checkpoint_paths.stt_dir, exist_ok=True)
            input_fingerprint = main.hash_file_contents(TEST_AUDIO_PATH)
            config_fingerprint = main._analysis_config_fingerprint(main.normalize_app_config(config))
            execution_fingerprint = main._stt_execution_fingerprint(
                config["paths"]["stt_model"],
                config["stt"]["device"],
                config["stt"]["chunk_seconds"],
            )
            chunk_path = os.path.abspath(TEST_AUDIO_PATH)
            chunk_size = os.path.getsize(chunk_path)
            atomic_write_json(checkpoint_paths.state_path, {
                "job_id": job_id,
                "resume_requested": True,
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "pipeline_version": main.ANALYSIS_PIPELINE_VERSION,
                "checkpoint_version": main.ANALYSIS_CHECKPOINT_VERSION,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "completed_chunk_indices": [],
                "resume_supported": True,
            })
            atomic_write_json(os.path.join(checkpoint_paths.stt_dir, "chunk_001.json"), {
                "chunk_index": 0,
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "source_wav_size": 3,
                "source_wav_duration": 0.0,
                "chunk_path": chunk_path,
                "chunk_size_bytes": chunk_size,
                "offset": 0.0,
                "duration": 1.0,
                "stt_execution_fingerprint": execution_fingerprint,
                "segments": [{"start": 0.0, "end": 1.0, "text": "hello"}],
            })

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 1.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", side_effect=AssertionError("transcribe should not run")),
                patch("pipeline.export_txt.export_txt"),
            ):
                result = process_audio_pipeline(TEST_AUDIO_PATH, job_id, config)

            self.assertEqual(result["resume"]["mode"], "reused_stt")
            self.assertEqual(result["resume"]["reused_chunk_count"], 1)

    def test_pipeline_preserves_reused_chunk_progress_when_resume_is_cancelled(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "primary-model",
                    "diarization_model": "",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True},
            }
            job_id = "unit_resume_cancel_after_reuse"
            checkpoint_paths = build_job_checkpoint_paths(config["paths"]["temp_dir"], job_id)
            os.makedirs(checkpoint_paths.stt_dir, exist_ok=True)
            input_fingerprint = main.hash_file_contents(TEST_AUDIO_PATH)
            config_fingerprint = main._analysis_config_fingerprint(main.normalize_app_config(config))
            execution_fingerprint = main._stt_execution_fingerprint(
                config["paths"]["stt_model"],
                config["stt"]["device"],
                config["stt"]["chunk_seconds"],
            )
            chunk_path = os.path.abspath(TEST_AUDIO_PATH)
            chunk_size = os.path.getsize(chunk_path)
            atomic_write_json(checkpoint_paths.state_path, {
                "job_id": job_id,
                "resume_requested": True,
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "pipeline_version": main.ANALYSIS_PIPELINE_VERSION,
                "checkpoint_version": main.ANALYSIS_CHECKPOINT_VERSION,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "completed_chunk_indices": [],
                "resume_supported": True,
            })
            atomic_write_json(os.path.join(checkpoint_paths.stt_dir, "chunk_001.json"), {
                "chunk_index": 0,
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "source_wav_size": 3,
                "source_wav_duration": 0.0,
                "chunk_path": chunk_path,
                "chunk_size_bytes": chunk_size,
                "offset": 0.0,
                "duration": 1.0,
                "stt_execution_fingerprint": execution_fingerprint,
                "segments": [{"start": 0.0, "end": 1.0, "text": "hello"}],
            })

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 1.0, "index": 0},
                    {"path": TEST_AUDIO_PATH, "offset": 1.0, "duration": 1.0, "index": 1},
                ]),
                patch("pipeline.transcribe.transcribe_audio", side_effect=AnalysisCancelledError("stop")),
                patch("pipeline.export_txt.export_txt"),
                patch("main.model_exists", return_value=True),
                patch("main.resolve_model_path", return_value=os.path.join(work_dir, "fallback-model")),
            ):
                with self.assertRaises(AnalysisCancelledError):
                    process_audio_pipeline(TEST_AUDIO_PATH, job_id, config)

            state = load_json_checkpoint(checkpoint_paths.state_path)
            self.assertEqual(state["completed_chunk_indices"], [0])
            self.assertTrue(state["resume_supported"])

    def test_pipeline_reuses_diarization_checkpoints_when_available(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "pyannote-model",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": True, "generate_during_analysis": True},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True},
            }
            job_id = "unit_resume_diarization_reuse"
            checkpoint_paths = build_job_checkpoint_paths(config["paths"]["temp_dir"], job_id)
            os.makedirs(checkpoint_paths.stt_dir, exist_ok=True)
            input_fingerprint = main.hash_file_contents(TEST_AUDIO_PATH)
            config_fingerprint = main._analysis_config_fingerprint(main.normalize_app_config(config))
            base_segments = [{"start": 0.0, "end": 1.0, "text": "hello"}]
            segments_fingerprint = main._segment_fingerprint(base_segments)
            execution_fingerprint = main._stt_execution_fingerprint(
                config["paths"]["stt_model"],
                config["stt"]["device"],
                config["stt"]["chunk_seconds"],
            )
            chunk_path = os.path.abspath(TEST_AUDIO_PATH)
            chunk_size = os.path.getsize(chunk_path)
            atomic_write_json(checkpoint_paths.state_path, {
                "job_id": job_id,
                "resume_requested": True,
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "pipeline_version": main.ANALYSIS_PIPELINE_VERSION,
                "checkpoint_version": main.ANALYSIS_CHECKPOINT_VERSION,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "completed_chunk_indices": [0],
                "resume_supported": True,
                "diarization_completed": True,
            })
            atomic_write_json(os.path.join(checkpoint_paths.stt_dir, "chunk_001.json"), {
                "chunk_index": 0,
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "source_wav_size": 3,
                "source_wav_duration": 0.0,
                "chunk_path": chunk_path,
                "chunk_size_bytes": chunk_size,
                "offset": 0.0,
                "duration": 1.0,
                "stt_execution_fingerprint": execution_fingerprint,
                "segments": base_segments,
            })
            atomic_write_json(checkpoint_paths.diarization_segments_path, {
                "speaker_segments": [{"speaker": "SPEAKER_00", "start": 0.0, "end": 1.0}],
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "segments_fingerprint": segments_fingerprint,
            })
            atomic_write_json(checkpoint_paths.aligned_segments_path, {
                "segments": [{"start": 0.0, "end": 1.0, "speaker": "화자000", "text": "hello"}],
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "segments_fingerprint": segments_fingerprint,
            })
            atomic_write_json(checkpoint_paths.display_segments_path, {
                "segments": [{"start": 0.0, "end": 1.0, "speaker": "화자000", "speaker_name": "화자000", "text": "hello"}],
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "segments_fingerprint": segments_fingerprint,
            })

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 1.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", side_effect=AssertionError("transcribe should not run")),
                patch("pipeline.diarize.diarize_audio", side_effect=AssertionError("diarization should not run")),
                patch("pipeline.align_speakers.align_segments_with_speakers", side_effect=AssertionError("alignment should not run")),
                patch("pipeline.export_txt.export_txt"),
            ):
                result = process_audio_pipeline(TEST_AUDIO_PATH, job_id, config)

            self.assertEqual(result["resume"]["mode"], "reused_stt_and_diarization")
            self.assertEqual(result["result_data"]["segments"][0]["speaker"], "화자000")
            self.assertEqual(result["result_data"]["display_segments"][0]["speaker_name"], "화자000")

    def test_pipeline_returns_resume_fallback_metadata_on_fingerprint_mismatch(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True},
            }
            job_id = "unit_resume_fallback_metadata"
            checkpoint_paths = build_job_checkpoint_paths(config["paths"]["temp_dir"], job_id)
            os.makedirs(checkpoint_paths.root_dir, exist_ok=True)
            atomic_write_json(checkpoint_paths.state_path, {
                "job_id": job_id,
                "resume_requested": True,
                "input_fingerprint": "mismatch",
                "config_fingerprint": "mismatch",
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "completed_chunk_indices": [0],
                "resume_supported": True,
            })

            progress_messages: list[str] = []

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 1.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", return_value=[{"start": 0.0, "end": 1.0, "text": "hello"}]),
                patch("pipeline.export_txt.export_txt"),
            ):
                result = process_audio_pipeline(
                    TEST_AUDIO_PATH,
                    job_id,
                    config,
                    progress_callback=lambda message, _progress: progress_messages.append(message),
                )

            self.assertEqual(result["resume"]["mode"], "fallback_fresh_start")
            self.assertEqual(result["resume"]["fallback_reason"], "fingerprint_mismatch")
            self.assertIn("이전 분석 기록과 일치하지 않아 처음부터 다시 분석합니다.", progress_messages)

    def test_pipeline_does_not_reuse_stt_chunk_from_different_execution_fingerprint(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True},
            }
            job_id = "unit_resume_execution_fingerprint"
            checkpoint_paths = build_job_checkpoint_paths(config["paths"]["temp_dir"], job_id)
            os.makedirs(checkpoint_paths.stt_dir, exist_ok=True)
            input_fingerprint = main.hash_file_contents(TEST_AUDIO_PATH)
            config_fingerprint = main._analysis_config_fingerprint(main.normalize_app_config(config))
            atomic_write_json(checkpoint_paths.state_path, {
                "job_id": job_id,
                "resume_requested": True,
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "source_filename": "meeting.mp4",
                "source_size": 1234,
                "source_last_modified": 987654321,
                "completed_chunk_indices": [0],
                "resume_supported": True,
            })
            atomic_write_json(os.path.join(checkpoint_paths.stt_dir, "chunk_001.json"), {
                "chunk_index": 0,
                "offset": 0.0,
                "duration": 1.0,
                "stt_execution_fingerprint": "different-execution",
                "segments": [{"start": 0.0, "end": 1.0, "text": "old"}],
            })

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            transcribe_calls: list[str] = []

            def fake_transcribe(*_args, **_kwargs):
                transcribe_calls.append("called")
                return [{"start": 0.0, "end": 1.0, "text": "new"}]

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 1.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", side_effect=fake_transcribe),
                patch("pipeline.export_txt.export_txt"),
            ):
                result = process_audio_pipeline(TEST_AUDIO_PATH, job_id, config)

            self.assertEqual(len(transcribe_calls), 1)
            self.assertEqual(result["resume"]["mode"], "fresh_start")
            self.assertEqual(result["result_data"]["segments"][0]["text"], "new")

    def test_pipeline_uses_configured_outer_chunk_seconds(self) -> None:
        seen = {}

        def fake_split(wav_path, chunk_dir, chunk_seconds, ffmpeg_path):
            seen["chunk_seconds"] = chunk_seconds
            return [{"path": wav_path, "offset": 0.0, "duration": 1.0, "index": 0}]

        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
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

        def fake_transcribe(wav_path, model_path, language, device, chunk_seconds, fallback_model_path):
            seen["stt_chunk_seconds"] = chunk_seconds
            return [{"start": 0.0, "end": 1.0, "text": "hello"}]

        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
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
            "diarization": {"enabled": True, "generate_during_analysis": True},
            "summary": {"enabled": True, "generate_during_analysis": True},
            "privacy": {"auto_delete_temp_audio": True},
        }

        with (
            patch("main.resolve_model_path", return_value="resolved-model"),
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

    def test_pipeline_auto_skips_diarization_for_long_audio(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "pyannote-model",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {
                    "enabled": True,
                    "generate_during_analysis": True,
                    "auto_skip_long_audio": True,
                    "max_duration_seconds": 60,
                    "max_waveform_mb": 256,
                },
                "summary": {"enabled": True},
                "privacy": {"auto_delete_temp_audio": True},
            }

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.get_wav_duration_seconds", return_value=61.0),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 61.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", return_value=[{"start": 0.0, "end": 61.0, "text": "hello"}]),
                patch("pipeline.diarize.diarize_audio") as diarize_mock,
                patch("pipeline.summarize.summarize_meeting", return_value={"overview": "요약"}),
                patch("pipeline.export_txt.export_txt"),
                patch("pipeline.export_markdown.export_markdown"),
                patch("pipeline.export_docx.export_docx"),
                patch("pipeline.export_hwpx.export_hwpx"),
            ):
                result = process_audio_pipeline(TEST_AUDIO_PATH, "unit_long_audio_skip_diarization", config)

            settings = result["result_data"]["settings"]
            self.assertTrue(settings["diarization_requested"])
            self.assertTrue(settings["diarization_skipped"])
            self.assertFalse(settings["diarization"])
            self.assertEqual(settings["diarization_skip_reason"], "duration_limit")
            diarize_mock.assert_not_called()

    def test_pipeline_marks_summary_skipped_when_summary_model_is_not_ready(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "pyannote-model",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": True, "generate_during_analysis": True, "model": "missing-model"},
                "privacy": {"auto_delete_temp_audio": True},
            }

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.get_wav_duration_seconds", return_value=5.0),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 5.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", return_value=[{"start": 0.0, "end": 5.0, "text": "hello"}]),
                patch("pipeline.summarize.summarize_meeting") as summarize_mock,
                patch.object(main, "_summary_model_readiness", return_value={
                    "ready": False,
                    "status": "skipped",
                    "message": "요약 AI가 준비되지 않아 대화록만 생성했습니다.",
                }),
                patch("pipeline.export_txt.export_txt"),
                patch("pipeline.export_markdown.export_markdown"),
                patch("pipeline.export_docx.export_docx"),
                patch("pipeline.export_hwpx.export_hwpx"),
            ):
                result = process_audio_pipeline(TEST_AUDIO_PATH, "unit_summary_model_skip", config)

            summarize_mock.assert_not_called()
            summary = result["result_data"]["summary"]
            self.assertEqual(summary["generation_status"]["summary"], "skipped")
            self.assertIn("요약 AI", summary["overview"])
            checkpoint_paths = build_job_checkpoint_paths(config["paths"]["temp_dir"], "unit_summary_model_skip")
            with open(checkpoint_paths.state_path, "r", encoding="utf-8") as handle:
                state = json.load(handle)
            self.assertFalse(state["summary_completed"])
            self.assertTrue(state["summary_skipped"])

    def test_pipeline_defers_summary_by_default_after_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "pyannote-model",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": True},
                "privacy": {"auto_delete_temp_audio": True},
            }

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.get_wav_duration_seconds", return_value=5.0),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 5.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", return_value=[{"start": 0.0, "end": 5.0, "text": "hello"}]),
                patch("pipeline.summarize.summarize_meeting") as summarize_mock,
                patch.object(main, "_summary_model_readiness") as readiness_mock,
                patch("pipeline.export_txt.export_txt"),
                patch("pipeline.export_markdown.export_markdown"),
                patch("pipeline.export_docx.export_docx"),
                patch("pipeline.export_hwpx.export_hwpx"),
            ):
                result = process_audio_pipeline(TEST_AUDIO_PATH, "unit_summary_deferred_default", config)

            summarize_mock.assert_not_called()
            readiness_mock.assert_not_called()
            summary = result["result_data"]["summary"]
            self.assertEqual(summary["generation_status"]["summary"], "skipped")
            self.assertIn("정리는 회의 기록에서 별도로 실행", summary["overview"])
            checkpoint_paths = build_job_checkpoint_paths(config["paths"]["temp_dir"], "unit_summary_deferred_default")
            with open(checkpoint_paths.state_path, "r", encoding="utf-8") as handle:
                state = json.load(handle)
            self.assertTrue(state["summary_skipped"])

    def test_pipeline_defers_diarization_when_source_audio_is_preserved_after_transcript(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "pyannote-model",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": True},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True, "preserve_extracted_audio": True},
            }

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.get_wav_duration_seconds", return_value=5.0),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 5.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", return_value=[{"start": 0.0, "end": 5.0, "text": "hello"}]),
                patch("pipeline.diarize.diarize_audio") as diarize_mock,
                patch("pipeline.export_txt.export_txt"),
            ):
                result = process_audio_pipeline(TEST_AUDIO_PATH, "unit_diarization_deferred_default", config)

            settings = result["result_data"]["settings"]
            self.assertTrue(settings["diarization_requested"])
            self.assertTrue(settings["diarization_deferred"])
            self.assertFalse(settings["diarization"])
            self.assertFalse(settings["diarization_skipped"])
            self.assertIn("별도로 실행", settings["diarization_defer_message"])
            diarize_mock.assert_not_called()

    def test_pipeline_does_not_defer_diarization_when_source_audio_is_not_preserved(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "pyannote-model",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": True},
                "summary": {"enabled": False},
                "privacy": {
                    "auto_delete_temp_audio": True,
                    "preserve_extracted_audio": False,
                    "save_original_audio_copy": False,
                },
            }
            job_id = "unit_diarization_not_deferred_without_source"

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.get_wav_duration_seconds", return_value=5.0),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 5.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", return_value=[{"start": 0.0, "end": 5.0, "text": "hello"}]),
                patch("pipeline.diarize.diarize_audio") as diarize_mock,
                patch("pipeline.export_txt.export_txt"),
            ):
                result = process_audio_pipeline(TEST_AUDIO_PATH, job_id, config)

            settings = result["result_data"]["settings"]
            self.assertTrue(settings["diarization_requested"])
            self.assertFalse(settings["diarization_deferred"])
            self.assertTrue(settings["diarization_skipped"])
            self.assertEqual(settings["diarization_skip_reason"], "source_not_preserved")
            self.assertIn("음성 파일 보존 설정", settings["diarization_skip_message"])
            diarize_mock.assert_not_called()

            checkpoint_paths = build_job_checkpoint_paths(config["paths"]["temp_dir"], job_id)
            state = load_json_checkpoint(checkpoint_paths.state_path)
            self.assertTrue(state["source_wav_deleted"])
            self.assertFalse(state["resume_supported"])

    def test_pipeline_reports_post_transcription_progress_before_later_steps(self) -> None:
        progress_events = []
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
            "diarization": {"enabled": True, "generate_during_analysis": True},
            "summary": {"enabled": True, "generate_during_analysis": True},
            "privacy": {"auto_delete_temp_audio": True},
        }

        def report(step, progress):
            progress_events.append((step, progress))

        with (
            patch("main.resolve_model_path", return_value="resolved-model"),
            patch("main.model_exists", return_value=False),
            patch("pipeline.audio_preprocess.convert_to_wav", return_value={"preprocessing": {}}),
            patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 1.0, "index": 0},
                {"path": TEST_AUDIO_PATH, "offset": 1.0, "duration": 1.0, "index": 1},
            ]),
            patch("pipeline.transcribe.transcribe_audio", return_value=[{"start": 0.0, "end": 1.0, "text": "hello"}]),
            patch("pipeline.diarize.diarize_audio", return_value=[]),
            patch("pipeline.align_speakers.align_segments_with_speakers", side_effect=lambda segments, speakers: segments),
            patch("pipeline.summarize.summarize_meeting", return_value={"overview": "요약"}),
            patch.object(main, "_summary_model_readiness", return_value={"ready": True, "status": "ready", "message": ""}),
            patch("pipeline.export_txt.export_txt"),
            patch("pipeline.export_markdown.export_markdown"),
            patch("pipeline.export_docx.export_docx"),
            patch("pipeline.export_hwpx.export_hwpx"),
        ):
            result = process_audio_pipeline(TEST_AUDIO_PATH, "unit_post_transcription_progress", config, progress_callback=report)

        self.assertIn(("음성 인식이 완료되었습니다. 후처리를 준비하고 있습니다.", 65), progress_events)
        self.assertIn(("Speaker Diarization & Alignment...", 70), progress_events)
        self.assertIn(("Summarizing with Local LLM...", 85), progress_events)
        self.assertIn(("Saving results...", 95), progress_events)
        self.assertEqual(len(result["result_data"]["raw_stt_segments"]), 2)
        self.assertEqual(len(result["result_data"]["aligned_segments"]), 2)
        self.assertIn("display_segments", result["result_data"])

    def test_pipeline_writes_job_state_and_stt_checkpoints(self) -> None:
        with tempfile.TemporaryDirectory() as work_dir:
            config = {
                "paths": {
                    "ffmpeg": "ffmpeg",
                    "stt_model": "faster-whisper-large-v3",
                    "diarization_model": "",
                    "output_dir": os.path.join(work_dir, "outputs"),
                    "temp_dir": os.path.join(work_dir, "temp"),
                    "llm_model": "",
                },
                "stt": {"language": "ko", "device": "cpu", "chunk_seconds": 30},
                "processing": {"enable_long_audio_chunking": True, "long_audio_chunk_seconds": 30},
                "preprocessing": {"enabled": False},
                "diarization": {"enabled": False},
                "summary": {"enabled": False},
                "privacy": {"auto_delete_temp_audio": True},
            }

            def fake_convert_to_wav(_input_file, output_path, _ffmpeg_path, preprocessing):
                with open(output_path, "wb") as handle:
                    handle.write(b"wav")
                return {"preprocessing": preprocessing or {}}

            with (
                patch("pipeline.audio_preprocess.convert_to_wav", side_effect=fake_convert_to_wav),
                patch("pipeline.chunk_audio.split_wav_by_duration", return_value=[
                    {"path": TEST_AUDIO_PATH, "offset": 0.0, "duration": 1.0, "index": 0},
                ]),
                patch("pipeline.transcribe.transcribe_audio", return_value=[{"start": 0.0, "end": 1.0, "text": "hello"}]),
                patch("pipeline.export_txt.export_txt"),
            ):
                process_audio_pipeline(TEST_AUDIO_PATH, "unit_job_checkpoints", config)

            paths = build_job_checkpoint_paths(config["paths"]["temp_dir"], "unit_job_checkpoints")
            state = load_json_checkpoint(paths.state_path)
            chunk_payload = load_json_checkpoint(os.path.join(paths.stt_dir, "chunk_001.json"))
            merged_payload = load_json_checkpoint(paths.stt_merged_path)

            self.assertEqual(state["stage"], "completed")
            self.assertTrue(state["stt_completed"])
            self.assertEqual(state["completed_chunk_indices"], [0])
            self.assertTrue(os.path.exists(paths.source_wav_path))
            self.assertEqual(chunk_payload["segments"][0]["text"], "hello")
            self.assertEqual(merged_payload["segments"][0]["text"], "hello")

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

        transcribe_module._clear_faster_whisper_model_cache()
        with (
            patch.dict(sys.modules, {"faster_whisper": fake_faster_whisper, "torch": fake_torch}),
            patch("pipeline.transcribe.sys.platform", "win32"),
            patch("pipeline.transcribe.ctypes.WinDLL", side_effect=OSError("missing cuda dll")),
        ):
            segments = transcribe_audio_fallback_whisper("dummy.wav", "dummy-model", device="auto")
        transcribe_module._clear_faster_whisper_model_cache()

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

    def test_delete_outputs_rejects_active_analysis_job(self) -> None:
        with patch.object(main.ANALYSIS_JOBS, "has", return_value=True):
            response = self.client.delete("/api/outputs/unit_active_delete")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "analysis_job_active")

    def test_delete_analysis_draft_removes_resume_artifacts_without_outputs(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        temp_dir = os.path.join(BACKEND_DIR, "temp")
        os.makedirs(output_dir, exist_ok=True)
        os.makedirs(temp_dir, exist_ok=True)
        job_id = "unit_delete_resume_artifacts"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")
        partial_result_path = os.path.join(output_dir, f"{job_id}_partial_result.json")
        partial_transcript_path = os.path.join(output_dir, f"{job_id}_partial_transcript.txt")
        temp_path = os.path.join(temp_dir, f"{job_id}.wav")
        chunk_dir = os.path.join(temp_dir, f"{job_id}_chunks")
        checkpoint_root = os.path.join(temp_dir, "jobs", job_id)
        os.makedirs(chunk_dir, exist_ok=True)
        os.makedirs(checkpoint_root, exist_ok=True)

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump({"keep": True}, f)
            with open(partial_result_path, "w", encoding="utf-8") as f:
                json.dump({"partial": True}, f)
            with open(partial_transcript_path, "w", encoding="utf-8") as f:
                f.write("partial")
            with open(temp_path, "w", encoding="utf-8") as f:
                f.write("temp")
            with open(os.path.join(chunk_dir, "chunk.wav"), "w", encoding="utf-8") as f:
                f.write("chunk")
            with open(os.path.join(checkpoint_root, "job_state.json"), "w", encoding="utf-8") as f:
                json.dump({"job_id": job_id}, f)

            response = self.client.delete(f"/api/analyze/drafts/{job_id}")

            self.assertEqual(response.status_code, 200)
            self.assertTrue(os.path.exists(output_path))
            self.assertFalse(os.path.exists(partial_result_path))
            self.assertFalse(os.path.exists(partial_transcript_path))
            self.assertFalse(os.path.exists(temp_path))
            self.assertFalse(os.path.exists(chunk_dir))
            self.assertFalse(os.path.exists(checkpoint_root))
        finally:
            for path in [output_path, partial_result_path, partial_transcript_path, temp_path]:
                if os.path.exists(path):
                    os.remove(path)
            for path in [chunk_dir, checkpoint_root]:
                if os.path.isdir(path):
                    import shutil

                    shutil.rmtree(path, ignore_errors=True)

    def test_delete_analysis_draft_rejects_active_analysis_job(self) -> None:
        with patch.object(main.ANALYSIS_JOBS, "has", return_value=True):
            response = self.client.delete("/api/analyze/drafts/unit_active_draft_delete")

        self.assertEqual(response.status_code, 409)
        self.assertEqual(response.json()["detail"], "analysis_job_active")

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

    def test_generate_summary_resets_downstream_sections(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_generate_summary_reset"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"speaker": "SPEAKER_00", "speaker_name": "화자00", "text": "Discuss budget."}],
                        "display_segments": [{"speaker": "SPEAKER_00", "speaker_name": "화자00", "text": "Discuss budget."}],
                        "summary": {
                            "overview": "old overview",
                            "topics": ["old topic"],
                            "topic_sections": [{"topic": "예산", "summary": "old section"}],
                            "speaker_context_summaries": [{"speaker": "SPEAKER_00", "summary": "old speaker"}],
                            "participant_summaries": [{"participant": "화자00", "summary": "old participant"}],
                            "generation_status": {
                                "summary": "completed",
                                "topic_sections": "completed",
                                "speaker_context_summaries": "completed",
                            },
                        },
                    },
                    f,
                )

            with patch(
                "pipeline.summarize.summarize_meeting",
                return_value={
                    "overview": "new overview",
                    "topics": ["new topic"],
                    "decisions": ["new decision"],
                    "actions": ["new action"],
                    "needs_check": ["new check"],
                },
            ), patch.object(main, "_summary_model_readiness", return_value={"ready": True, "status": "ready", "message": ""}):
                response = self.client.post(f"/api/outputs/{job_id}/generate-summary")

            self.assertEqual(response.status_code, 200)
            payload = response.json()
            self.assertEqual(payload["summary"], "new overview")
            self.assertEqual(payload["generation_status"]["summary"], "completed")
            self.assertEqual(payload["generation_status"]["topic_sections"], "not_started")
            self.assertEqual(payload["generation_status"]["speaker_context_summaries"], "not_started")
            self.assertEqual(payload["topic_sections"], [])
            self.assertEqual(payload["speaker_context_summaries"], [])
            self.assertTrue(payload["cleared_topic_sections"])
            self.assertTrue(payload["cleared_speaker_context_summaries"])

            with open(output_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)
            self.assertEqual(result_data["summary"]["overview"], "new overview")
            self.assertEqual(result_data["summary"]["topic_sections"], [])
            self.assertEqual(result_data["summary"]["speaker_context_summaries"], [])
            self.assertEqual(result_data["summary"]["participant_summaries"], [])
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

    def test_generate_summary_marks_skipped_when_summary_model_is_not_ready(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_generate_summary_model_skip"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"speaker": "SPEAKER_00", "speaker_name": "화자00", "text": "Discuss budget."}],
                        "display_segments": [{"speaker": "SPEAKER_00", "speaker_name": "화자00", "text": "Discuss budget."}],
                        "summary": {
                            "overview": "",
                            "generation_status": {"summary": "not_started"},
                        },
                    },
                    f,
                    ensure_ascii=False,
                )

            with (
                patch.object(main, "_summary_model_readiness", return_value={
                    "ready": False,
                    "status": "skipped",
                    "message": "요약 AI가 준비되지 않아 대화록만 생성했습니다.",
                }),
                patch("pipeline.summarize.summarize_meeting") as summarize_mock,
                patch.object(main, "_refresh_summary_exports", return_value=main._result_outputs(job_id)),
            ):
                response = self.client.post(f"/api/outputs/{job_id}/generate-summary")

            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertEqual(payload["generation_status"]["summary"], "skipped")
            self.assertEqual(payload["generation_status"]["topic_sections"], "skipped")
            self.assertIn("요약 AI", payload["summary"])
            summarize_mock.assert_not_called()
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

    def test_generate_summary_preserves_existing_summary_when_summary_model_is_not_ready(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_generate_summary_model_skip_preserve"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"speaker": "SPEAKER_00", "speaker_name": "화자00", "text": "Discuss budget."}],
                        "display_segments": [{"speaker": "SPEAKER_00", "speaker_name": "화자00", "text": "Discuss budget."}],
                        "summary": {
                            "overview": "기존 요약",
                            "topic_sections": [{"topic": "예산", "summary": "기존 주제 정리"}],
                            "speaker_context_summaries": [{"speaker": "SPEAKER_00", "summary": "기존 참석자 정리"}],
                            "participant_summaries": [{"participant": "화자00", "summary": "기존 참석자 정리"}],
                            "generation_status": {
                                "summary": "completed",
                                "topic_sections": "completed",
                                "speaker_context_summaries": "completed",
                            },
                        },
                    },
                    f,
                    ensure_ascii=False,
                )

            with (
                patch.object(main, "_summary_model_readiness", return_value={
                    "ready": False,
                    "status": "skipped",
                    "message": "요약 AI가 준비되지 않아 대화록만 생성했습니다.",
                }),
                patch("pipeline.summarize.summarize_meeting") as summarize_mock,
            ):
                response = self.client.post(f"/api/outputs/{job_id}/generate-summary")

            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"], "summary_model_not_ready")
            summarize_mock.assert_not_called()
            with open(output_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)
            self.assertEqual(result_data["summary"]["overview"], "기존 요약")
            self.assertEqual(result_data["summary"]["topic_sections"][0]["summary"], "기존 주제 정리")
            self.assertEqual(result_data["summary"]["generation_status"]["summary"], "completed")
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

    def test_sync_record_clears_speaker_labels_and_reverts_display_segments(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_sync_record_clear_labels"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "김철수", "text": "원본 조각"}],
                        "display_segments": [{"start": 0.0, "end": 8.0, "speaker": "화자000", "speaker_name": "김철수", "text": "이전 수정본"}],
                        "speaker_labels": {"화자000": "김철수"},
                        "summary": {
                            "overview": "기존 요약",
                            "speaker_context_summaries": [
                                {
                                    "speaker": "화자000",
                                    "display_name": "김철수",
                                    "summary": "이전 참석자 정리",
                                    "key_points": ["이전 발언"],
                                    "actions": [],
                                }
                            ],
                            "participant_summaries": [{"participant": "김철수", "summary": "이전 참석자 정리"}],
                            "generation_status": {},
                        },
                    },
                    f,
                    ensure_ascii=False,
                )

            payload = {
                "id": job_id,
                "jobId": job_id,
                "title": "새 회의 제목",
                "date": "2026-05-13 10:00",
                "participants": "새 참석자",
                "segments": [{"start": "00:00:00", "end": "00:00:05", "speaker": "화자000", "text": "원본 조각"}],
                "displaySegments": [{"start": "00:00:00", "end": "00:00:05", "speaker": "화자000", "text": "기본 표시본"}],
                "editedDisplaySegments": [],
                "speakerLabels": {},
                "speaker_labels": {"화자000": "김철수"},
            }

            with patch.object(main, "_refresh_summary_exports", return_value=main._result_outputs(job_id)):
                response = self.client.post(f"/api/outputs/{job_id}/sync-record", json=payload)

            self.assertEqual(response.status_code, 200, response.text)
            with open(output_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)

            self.assertEqual(result_data["speaker_labels"], {})
            self.assertEqual(result_data["segments"][0]["speaker_name"], "화자000")
            self.assertEqual(result_data["display_segments"][0]["speaker_name"], "화자000")
            self.assertEqual(result_data["display_segments"][0]["text"], "기본 표시본")
            self.assertEqual(result_data["summary"]["title"], "새 회의 제목")
            self.assertEqual(result_data["participants"], "새 참석자")
            self.assertEqual(result_data["created_at"], "2026-05-13 10:00")
            self.assertEqual(result_data["summary"]["speaker_context_summaries"][0]["display_name"], "화자000")
            self.assertEqual(result_data["summary"]["participant_summaries"][0]["participant"], "화자000")
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

    def test_sync_record_updates_speaker_summary_labels(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_sync_record_summary_labels"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "이전 이름", "text": "원본 조각"}],
                        "display_segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "이전 이름", "text": "원본 조각"}],
                        "speaker_labels": {"화자000": "이전 이름"},
                        "summary": {
                            "overview": "기존 요약",
                            "speaker_context_summaries": [
                                {
                                    "speaker": "화자000",
                                    "display_name": "이전 이름",
                                    "summary": "참석자 발언 정리",
                                    "key_points": ["예산을 언급함"],
                                    "actions": [],
                                }
                            ],
                            "participant_summaries": [{"participant": "이전 이름", "summary": "참석자 발언 정리"}],
                            "generation_status": {"speaker_context_summaries": "completed"},
                        },
                    },
                    f,
                    ensure_ascii=False,
                )

            payload = {
                "id": job_id,
                "jobId": job_id,
                "title": "새 회의 제목",
                "date": "2026-05-13 10:00",
                "participants": "새 참석자",
                "segments": [{"start": "00:00:00", "end": "00:00:05", "speaker": "화자000", "text": "원본 조각"}],
                "displaySegments": [{"start": "00:00:00", "end": "00:00:05", "speaker": "화자000", "text": "원본 조각"}],
                "editedDisplaySegments": [],
                "speakerLabels": {"화자000": "김철수"},
            }

            with patch.object(main, "_refresh_summary_exports", return_value=main._result_outputs(job_id)):
                response = self.client.post(f"/api/outputs/{job_id}/sync-record", json=payload)

            self.assertEqual(response.status_code, 200, response.text)
            with open(output_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)

            self.assertEqual(result_data["speaker_labels"], {"화자000": "김철수"})
            self.assertEqual(result_data["segments"][0]["speaker_name"], "김철수")
            self.assertEqual(result_data["display_segments"][0]["speaker_name"], "김철수")
            self.assertEqual(result_data["summary"]["speaker_context_summaries"][0]["display_name"], "김철수")
            self.assertEqual(result_data["summary"]["participant_summaries"][0]["participant"], "김철수")
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

    def test_generate_summary_keeps_newer_speaker_labels(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_generate_summary_latest_labels"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "이전 이름", "text": "Discuss budget."}],
                        "display_segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "이전 이름", "text": "Discuss budget."}],
                        "speaker_labels": {"화자000": "이전 이름"},
                        "summary": {"overview": "old overview", "generation_status": {"summary": "not_started"}},
                    },
                    f,
                    ensure_ascii=False,
                )

            def summarize_side_effect(*_args, **_kwargs):
                with open(output_path, "r", encoding="utf-8") as f:
                    concurrent_result = json.load(f)
                concurrent_result["speaker_labels"] = {"화자000": "최신 이름"}
                with open(output_path, "w", encoding="utf-8") as f:
                    json.dump(concurrent_result, f, ensure_ascii=False, indent=2)
                return {
                    "overview": "new overview",
                    "topics": ["new topic"],
                    "actions": [],
                    "decisions": [],
                    "needs_check": [],
                }

            payload = {
                "id": job_id,
                "jobId": job_id,
                "title": "테스트 회의",
                "date": "2026-05-13 10:00",
                "participants": "참석자",
                "speakerLabels": {"화자000": "이전 이름"},
                "displaySegments": [{"start": "00:00:00", "end": "00:00:05", "speaker": "화자000", "text": "Discuss budget."}],
            }

            with (
                patch("pipeline.summarize.summarize_meeting", side_effect=summarize_side_effect),
                patch.object(main, "_refresh_summary_exports", return_value=main._result_outputs(job_id)),
                patch.object(main, "_summary_model_readiness", return_value={"ready": True, "status": "ready", "message": ""}),
            ):
                response = self.client.post(f"/api/outputs/{job_id}/generate-summary", json=payload)

            self.assertEqual(response.status_code, 200, response.text)
            with open(output_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)

            self.assertEqual(result_data["speaker_labels"], {"화자000": "최신 이름"})
            self.assertEqual(result_data["summary"]["overview"], "new overview")
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

    def test_generate_summary_rejects_meeting_purpose_change(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_generate_summary_purpose_stale"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "created_at": "2026-05-13 10:00",
                        "meeting_purpose": "기존 목적",
                        "segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "Discuss budget."}],
                        "display_segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "Discuss budget."}],
                        "summary": {
                            "title": "테스트 회의",
                            "overview": "old overview",
                            "generation_status": {"summary": "not_started"},
                        },
                    },
                    f,
                    ensure_ascii=False,
                )

            def summarize_side_effect(*_args, **_kwargs):
                with open(output_path, "r", encoding="utf-8") as f:
                    concurrent_result = json.load(f)
                concurrent_result["meeting_purpose"] = "변경된 목적"
                with open(output_path, "w", encoding="utf-8") as f:
                    json.dump(concurrent_result, f, ensure_ascii=False, indent=2)
                return {
                    "overview": "new overview",
                    "topics": [],
                    "actions": [],
                    "decisions": [],
                    "needs_check": [],
                }

            with (
                patch("pipeline.summarize.summarize_meeting", side_effect=summarize_side_effect),
                patch.object(main, "_summary_model_readiness", return_value={"ready": True, "status": "ready", "message": ""}),
            ):
                response = self.client.post(f"/api/outputs/{job_id}/generate-summary")

            self.assertEqual(response.status_code, 409, response.text)
            self.assertEqual(response.json()["detail"], main.DETAIL_SUMMARY_INPUT_CHANGED)
            with open(output_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)
            self.assertEqual(result_data["summary"]["overview"], "old overview")
            self.assertEqual(result_data["summary"]["generation_status"]["summary"], "not_started")
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

    def test_generate_summary_does_not_persist_rebuilt_result_when_generation_fails(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_generate_summary_rebuild_failure"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        payload = {
            "id": job_id,
            "jobId": job_id,
            "title": "테스트 회의",
            "date": "2026-05-13 10:00",
            "participants": "참석자",
            "displaySegments": [{"start": "00:00:00", "end": "00:00:05", "speaker": "화자000", "text": "Discuss budget."}],
        }

        with (
            patch("pipeline.summarize.summarize_meeting", side_effect=RuntimeError("boom")),
            patch.object(main, "_summary_model_readiness", return_value={"ready": True, "status": "ready", "message": ""}),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-summary", json=payload)

        self.assertEqual(response.status_code, 500)
        self.assertFalse(os.path.exists(output_path))

    def test_generate_topic_sections_rejects_stale_input_change(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_generate_topic_sections_stale"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "Discuss budget."}],
                        "display_segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "Discuss budget."}],
                        "summary": {
                            "overview": "old overview",
                            "topics": ["old topic"],
                            "generation_status": {"topic_sections": "not_started"},
                        },
                    },
                    f,
                    ensure_ascii=False,
                )

            def side_effect(*_args, **_kwargs):
                with open(output_path, "r", encoding="utf-8") as f:
                    concurrent_result = json.load(f)
                concurrent_result["summary"]["overview"] = "newer overview"
                with open(output_path, "w", encoding="utf-8") as f:
                    json.dump(concurrent_result, f, ensure_ascii=False, indent=2)
                return [
                    {"topic": "예산", "summary": "예산 논의"},
                    {"topic": "일정", "summary": "일정 논의"},
                ]

            with patch("pipeline.summarize.generate_topic_sections", side_effect=side_effect):
                response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections")

            self.assertEqual(response.status_code, 409, response.text)
            with open(output_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)
            self.assertEqual(result_data["summary"]["generation_status"]["topic_sections"], "not_started")
            self.assertEqual(result_data["summary"].get("topic_sections", []), [])
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

    def test_generate_topic_sections_rejects_single_broad_topic(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_generate_topic_sections_single_topic"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "Discuss budget."}],
                        "display_segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "Discuss budget."}],
                        "summary": {
                            "overview": "old overview",
                            "topics": ["old topic"],
                            "generation_status": {"summary": "completed", "topic_sections": "not_started"},
                        },
                    },
                    f,
                    ensure_ascii=False,
                )

            with patch(
                "pipeline.summarize.generate_topic_sections",
                return_value=[{"topic": "핵심 주제", "summary": "전체 대화 요약", "evidence": [], "actions": []}],
            ):
                response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections")

            self.assertEqual(response.status_code, 502, response.text)
            self.assertEqual(response.json()["detail"], main.DETAIL_TOPIC_EMPTY_RESULT)
            with open(output_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)
            self.assertEqual(result_data["summary"]["generation_status"]["topic_sections"], "failed")
            self.assertEqual(result_data["summary"]["generation_error_detail"], main.DETAIL_TOPIC_EMPTY_RESULT)
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

    def test_generate_single_topic_section_completes_topic_sections(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_generate_single_topic_section"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "Discuss budget."}],
                        "display_segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "Discuss budget."}],
                        "summary": {
                            "overview": "old overview",
                            "topics": [],
                            "generation_status": {"summary": "completed", "topic_sections": "not_started"},
                        },
                    },
                    f,
                    ensure_ascii=False,
                )

            with (
                patch.object(main, "_summary_model_readiness", return_value={"ready": True, "status": "ready", "message": ""}),
                patch(
                    "pipeline.summarize.generate_topic_section_for_title",
                    return_value={"topic": "예산", "summary": "예산 논의", "evidence": [], "actions": []},
                ),
            ):
                response = self.client.post(
                    f"/api/outputs/{job_id}/generate-topic-section",
                    json={"topicTitle": "예산"},
                )

            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertEqual(payload["generation_status"]["topic_sections"], "completed")
            self.assertEqual(len(payload["topic_sections"]), 1)
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)

    def test_generate_single_topic_section_failure_preserves_completed_topic_sections(self) -> None:
        output_dir = os.path.join(BACKEND_DIR, "outputs")
        os.makedirs(output_dir, exist_ok=True)
        job_id = "unit_generate_single_topic_section_failure_preserve"
        output_path = os.path.join(output_dir, f"{job_id}_result.json")

        try:
            with open(output_path, "w", encoding="utf-8") as f:
                json.dump(
                    {
                        "segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "Discuss budget."}],
                        "display_segments": [{"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "Discuss budget."}],
                        "summary": {
                            "overview": "old overview",
                            "topics": ["예산", "일정"],
                            "topic_sections": [
                                {"topic": "예산", "summary": "예산 논의"},
                                {"topic": "일정", "summary": "일정 논의"},
                            ],
                            "generation_status": {"summary": "completed", "topic_sections": "completed"},
                        },
                    },
                    f,
                    ensure_ascii=False,
                )

            with (
                patch.object(main, "_summary_model_readiness", return_value={"ready": True, "status": "ready", "message": ""}),
                patch("pipeline.summarize.generate_topic_section_for_title", return_value={}),
            ):
                response = self.client.post(
                    f"/api/outputs/{job_id}/generate-topic-section",
                    json={"topicTitle": "추가 검토"},
                )

            self.assertEqual(response.status_code, 502, response.text)
            with open(output_path, "r", encoding="utf-8") as f:
                result_data = json.load(f)
            self.assertEqual(result_data["summary"]["generation_status"]["topic_sections"], "completed")
            self.assertEqual(len(result_data["summary"]["topic_sections"]), 2)
            self.assertNotIn("generation_error_detail", result_data["summary"])
        finally:
            if os.path.exists(output_path):
                os.remove(output_path)


if __name__ == "__main__":
    unittest.main()
