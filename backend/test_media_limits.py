import asyncio
import hashlib
import json
import tempfile
import threading
import types
import unittest
import wave
from contextlib import ExitStack, nullcontext
from concurrent.futures import ThreadPoolExecutor
from fractions import Fraction
from io import BytesIO
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from starlette.datastructures import UploadFile

import main
import media_limits
from analysis_jobs import AnalysisJobRegistry
from job_checkpoints import atomic_write_json, build_job_checkpoint_paths


def write_wav(path, duration, rate=2):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with wave.open(str(path), "wb") as output:
        output.setnchannels(1)
        output.setsampwidth(2)
        output.setframerate(rate)
        output.writeframes(b"\0\0" * round(duration * rate))


class MediaDurationPolicyTest(unittest.TestCase):
    def test_exact_limit_is_allowed_and_any_measured_excess_is_rejected(self):
        self.assertEqual(media_limits.enforce_media_duration(7200), 7200)
        with self.assertRaises(media_limits.MediaDurationError) as raised:
            media_limits.enforce_media_duration(7200.000001)
        self.assertEqual(raised.exception.http_status, 413)
        self.assertEqual(raised.exception.as_detail()["code"], "duration_limit_exceeded")

    def test_unknown_nonfinite_zero_and_negative_lengths_fail_closed(self):
        for value in (None, "invalid", 0, -1, float("nan"), float("inf"), True):
            with self.subTest(value=value), self.assertRaises(media_limits.MediaDurationError) as raised:
                media_limits.enforce_media_duration(value)
            self.assertEqual(raised.exception.http_status, 422)
            self.assertNotIn("duration_seconds", raised.exception.as_detail())

    def test_real_wav_frame_count_enforces_the_boundary(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder, "sample.wav")
            write_wav(path, 7200)
            self.assertEqual(media_limits.validate_media_duration(path), 7200)
            write_wav(path, 7200.5)
            with self.assertRaises(media_limits.MediaDurationError) as raised:
                media_limits.validate_media_duration(path)
        self.assertEqual(raised.exception.duration_seconds, 7200.5)

    def test_container_and_stream_durations_use_longest_known_media_length(self):
        class Streams(list):
            @property
            def audio(self):
                return [stream for stream in self if stream.type == "audio"]

        for stream_ticks, expected_code in ((7200, None), (7201, "duration_limit_exceeded"), (None, "media_duration_unavailable")):
            streams = Streams([types.SimpleNamespace(type="audio", duration=stream_ticks, time_base=Fraction(1, 1))])
            container = types.SimpleNamespace(duration=None, streams=streams)
            fake_av = types.SimpleNamespace(time_base=1000000, open=Mock(return_value=nullcontext(container)))
            with self.subTest(stream_ticks=stream_ticks), patch.dict("sys.modules", {"av": fake_av}):
                if expected_code:
                    with self.assertRaises(media_limits.MediaDurationError) as raised:
                        media_limits.enforce_media_duration(media_limits._probe_container_duration("sample.mp4"))
                    self.assertEqual(raised.exception.code, expected_code)
                else:
                    self.assertEqual(media_limits._probe_container_duration("sample.mp4"), 7200)
            self.assertEqual(fake_av.open.call_args.kwargs["timeout"], (10, 10))

    def test_decoder_failure_does_not_leak_paths_or_assume_duration(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder, "unreadable.mp4")
            path.write_bytes(b"not media")
            with patch.object(media_limits, "_probe_container_duration", side_effect=RuntimeError("PRIVATE DECODER PATH")):
                with self.assertRaises(media_limits.MediaDurationError) as raised:
                    media_limits.validate_media_duration(path)
        self.assertEqual(raised.exception.code, "media_duration_unavailable")
        self.assertNotIn("PRIVATE", str(raised.exception))


class AnalysisDurationBoundaryTest(unittest.TestCase):
    def setUp(self):
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.root = Path(self.resources.enter_context(tempfile.TemporaryDirectory(prefix="analysis-duration-")))
        self.config = main.normalize_app_config({
            "paths": {"temp_dir": str(self.root / "temp"), "output_dir": str(self.root / "outputs"), "ffmpeg": "ffmpeg"},
            "diarization": {"enabled": False}, "summary": {"enabled": False},
            "privacy": {"save_original_audio_copy": False, "auto_save_audio_copy": False, "auto_save_hwpx_copy": False},
        })
        self.registry = AnalysisJobRegistry()
        self.resources.enter_context(patch.object(main, "ANALYSIS_JOBS", self.registry))
        self.resources.enter_context(patch.object(main, "load_config", return_value=self.config))
        self.client = self.resources.enter_context(TestClient(main.app))

    def post_analysis(self, *, data, files):
        return self.client.post("/api/analyze", data={"title": "duration limit test", "date": "2026-10-18", **data}, files=files)

    def seed(self, job_id):
        paths = build_job_checkpoint_paths(self.config["paths"]["temp_dir"], job_id)
        for path in (paths.upload_dir, paths.stt_dir, paths.audio_dir):
            Path(path).mkdir(parents=True, exist_ok=True)
        upload = Path(paths.upload_dir, "source.mp4")
        upload.write_bytes(b"previous upload")
        checkpoint = Path(paths.stt_dir, "chunk_001.json")
        checkpoint.write_bytes(b'{"segments":[{"text":"saved"}]}')
        atomic_write_json(paths.state_path, {
            "stage": "stopped", "cancelled": True, "resume_supported": True,
            "completed_chunk_indices": [0], "source_wav_completed": False,
        })
        return paths, upload, checkpoint

    def test_http_rejection_preserves_stopped_state_upload_and_checkpoint(self):
        job_id = "duration_rejected_resume"
        paths, upload, checkpoint = self.seed(job_id)
        protected = [Path(paths.state_path), upload, checkpoint]
        before = [path.read_bytes() for path in protected]
        error = media_limits.MediaDurationError("duration_limit_exceeded", 7200.1)

        def inspect_staged(path):
            self.assertEqual(Path(path).read_bytes(), b"new upload")
            self.assertNotEqual(Path(path), upload)
            raise error

        with patch.object(main, "validate_media_duration", side_effect=inspect_staged), patch.object(main, "model_exists") as model, patch.object(main, "process_audio_pipeline") as pipeline:
            response = self.post_analysis(data={
                "mode": "real", "job_id": job_id, "resume_requested": "true", "file_size": "1", "file_last_modified": "1",
            }, files={"file": ("sample.mp4", b"new upload", "video/mp4")})
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual(response.json()["detail"], error.as_detail())
        self.assertEqual([path.read_bytes() for path in protected], before)
        self.assertEqual(list(Path(paths.upload_dir).glob(".incoming_*")), [])
        self.assertFalse(self.registry.has(job_id))
        model.assert_not_called()
        pipeline.assert_not_called()

    def test_http_unknown_duration_returns_recoverable_validation_error(self):
        with patch.object(main, "validate_media_duration", side_effect=media_limits.MediaDurationError("media_duration_unavailable")), patch.object(main, "process_audio_pipeline") as pipeline:
            response = self.post_analysis(data={"mode": "real", "job_id": "duration_unknown"}, files={"file": ("sample.mp4", b"bad media", "video/mp4")})
        self.assertEqual(response.status_code, 422, response.text)
        self.assertEqual(response.json()["detail"]["code"], "media_duration_unavailable")
        self.assertFalse(self.registry.has("duration_unknown"))
        pipeline.assert_not_called()

    def test_http_exact_boundary_reaches_processing_without_trusting_client_size(self):
        def process(upload, job_id, config, report, cancel_event):
            return {"job_id": job_id, "result_data": {"segments": [], "summary": {}}}

        with patch.object(main, "validate_media_duration", return_value=7200) as inspect, patch.object(main, "model_exists", return_value=True), patch.object(main, "resolve_model_path", return_value="mock-model"), patch.object(main, "process_audio_pipeline", side_effect=process) as pipeline:
            response = self.post_analysis(data={"mode": "real", "job_id": "duration_exact", "file_size": "999999999"}, files={"file": ("sample.mp4", b"small upload", "video/mp4")})
        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("event: result", response.text)
        self.assertEqual(inspect.call_count, 1)
        self.assertEqual(pipeline.call_count, 1)

    def test_http_resume_checks_cached_pcm_before_replacing_upload_or_state(self):
        job_id = "duration_cached_resume"
        paths, upload, checkpoint = self.seed(job_id)
        write_wav(paths.source_wav_path, 7200.5)
        atomic_write_json(paths.state_path, {"stage": "stopped", "resume_supported": True, "source_wav_completed": True})
        protected = [Path(paths.state_path), upload, checkpoint, Path(paths.source_wav_path)]
        before = [path.read_bytes() for path in protected]
        with patch.object(main, "validate_media_duration", return_value=10), patch.object(main, "process_audio_pipeline") as pipeline:
            response = self.post_analysis(data={"mode": "real", "job_id": job_id, "resume_requested": "true"}, files={"file": ("sample.mp4", b"new upload", "video/mp4")})
        self.assertEqual(response.status_code, 413, response.text)
        self.assertEqual([path.read_bytes() for path in protected], before)
        pipeline.assert_not_called()

    def test_pipeline_rejects_input_before_checkpoint_reset_or_conversion(self):
        paths, upload, checkpoint = self.seed("duration_direct_input")
        before = Path(paths.state_path).read_bytes(), checkpoint.read_bytes()
        with patch.object(main, "validate_media_duration", side_effect=media_limits.MediaDurationError("duration_limit_exceeded", 7300)), patch("pipeline.audio_preprocess.convert_to_wav") as convert, patch.object(main, "_reset_checkpoint_root_for_new_run") as reset:
            with self.assertRaises(media_limits.MediaDurationError):
                main.process_audio_pipeline(str(upload), "duration_direct_input", self.config)
        self.assertEqual((Path(paths.state_path).read_bytes(), checkpoint.read_bytes()), before)
        convert.assert_not_called()
        reset.assert_not_called()

    def test_decoded_pcm_limit_and_unknown_length_never_enter_stt_fallback(self):
        for invalid_pcm in (False, True):
            job_id = f"duration_decoded_{invalid_pcm}"
            upload = self.root / f"{job_id}.mp4"
            upload.write_bytes(b"video")

            def convert(source, target, *args, **kwargs):
                if invalid_pcm:
                    Path(target).write_bytes(b"broken WAV")
                else:
                    write_wav(target, 7200.5)
                return {}

            with self.subTest(invalid_pcm=invalid_pcm), patch.object(main, "validate_media_duration", return_value=10), patch("pipeline.audio_preprocess.convert_to_wav", side_effect=convert), patch("pipeline.transcribe.transcribe_audio") as transcribe, patch("pipeline.chunk_audio.split_wav_by_duration") as split:
                with self.assertRaises(media_limits.MediaDurationError) as raised:
                    main.process_audio_pipeline(str(upload), job_id, self.config)
            self.assertEqual(raised.exception.code, "media_duration_unavailable" if invalid_pcm else "duration_limit_exceeded")
            transcribe.assert_not_called()
            split.assert_not_called()

    def test_cached_pcm_rejection_preserves_existing_pipeline_checkpoint_state(self):
        job_id = "duration_direct_cached"
        paths, upload, checkpoint = self.seed(job_id)
        write_wav(paths.source_wav_path, 7200.5)
        atomic_write_json(paths.state_path, {
            "stage": "stopped", "source_wav_completed": True, "resume_requested": True,
            "input_fingerprint": hashlib.sha256(upload.read_bytes()).hexdigest(),
            "config_fingerprint": main._analysis_config_fingerprint(self.config),
        })
        before = Path(paths.state_path).read_bytes(), checkpoint.read_bytes()
        with patch.object(main, "validate_media_duration", return_value=10), patch("pipeline.audio_preprocess.convert_to_wav") as convert:
            with self.assertRaises(media_limits.MediaDurationError):
                main.process_audio_pipeline(str(upload), job_id, self.config)
        self.assertEqual((Path(paths.state_path).read_bytes(), checkpoint.read_bytes()), before)
        convert.assert_not_called()

    def test_manual_source_restore_rejects_before_conversion(self):
        paths, upload, checkpoint = self.seed("duration_manual_restore")
        before = Path(paths.state_path).read_bytes()
        with patch.object(main, "validate_media_duration", side_effect=media_limits.MediaDurationError("duration_limit_exceeded", 7300)), patch("pipeline.audio_preprocess.convert_to_wav") as convert:
            with self.assertRaises(media_limits.MediaDurationError):
                main._restore_job_audio_path_for_diarization(self.config, "duration_manual_restore", str(upload))
        convert.assert_not_called()
        self.assertEqual(Path(paths.state_path).read_bytes(), before)

    def test_cancelled_inspection_keeps_previous_upload_and_cleans_staging_after_probe_returns(self):
        job_id = "duration_cancelled_inspection"
        paths, upload, checkpoint = self.seed(job_id)
        before = upload.read_bytes(), checkpoint.read_bytes()
        started = threading.Event()
        release = threading.Event()
        seen = {}

        def inspect(path):
            seen["path"] = Path(path)
            started.set()
            release.wait(2)
            return 1

        async def exercise():
            task = asyncio.create_task(main.save_analysis_upload(
                UploadFile(filename="sample.mp4", file=BytesIO(b"new upload")), job_id, verify_duration=True,
            ))
            try:
                async with asyncio.timeout(2):
                    while not started.is_set():
                        await asyncio.sleep(.005)
                task.cancel()
                await asyncio.gather(task, return_exceptions=True)
                self.assertTrue(seen["path"].exists())
                self.assertEqual((upload.read_bytes(), checkpoint.read_bytes()), before)
            finally:
                release.set()
                async with asyncio.timeout(2):
                    while seen.get("path") and seen["path"].exists():
                        await asyncio.sleep(.005)

        with patch.object(main, "validate_media_duration", side_effect=inspect):
            asyncio.run(exercise())

    def test_registry_stop_and_cancel_during_admission_preserve_previous_work_and_emit_terminal_sse(self):
        for action in ("stop", "cancel"):
            for invalid_duration in (False, True):
                with self.subTest(action=action, invalid_duration=invalid_duration):
                    job_id = f"duration_admission_{action}_{invalid_duration}"
                    paths, upload, checkpoint = self.seed(job_id)
                    protected = [Path(paths.state_path), upload, checkpoint]
                    before = [path.read_bytes() for path in protected]
                    started = threading.Event()
                    release = threading.Event()

                    def inspect(path):
                        started.set()
                        if not release.wait(3):
                            raise RuntimeError("Test did not release media inspection")
                        if invalid_duration:
                            raise media_limits.MediaDurationError("duration_limit_exceeded", 7300)
                        return 1

                    with patch.object(main, "validate_media_duration", side_effect=inspect), patch.object(main, "model_exists") as model, patch.object(main, "process_audio_pipeline") as pipeline, ThreadPoolExecutor(max_workers=1) as pool:
                        request = pool.submit(self.post_analysis, data={
                            "mode": "real", "job_id": job_id, "resume_requested": "true",
                        }, files={"file": ("sample.mp4", b"new upload", "video/mp4")})
                        try:
                            self.assertTrue(started.wait(2))
                            cancelled = self.client.post(f"/api/analyze/{job_id}/cancel", json={"action": action})
                            self.assertEqual(cancelled.status_code, 200, cancelled.text)
                            self.assertTrue(cancelled.json()["cancel_requested"])
                            self.assertTrue(cancelled.json()["preserve_existing"])
                            self.assertTrue(self.registry.has(job_id))
                            self.assertEqual([path.read_bytes() for path in protected], before)
                        finally:
                            release.set()
                        response = request.result(timeout=3)
                    self.assertEqual(response.status_code, 200, response.text)
                    status = "stopped" if action == "stop" else "cancelled"
                    self.assertIn(f"event: {status}", response.text)
                    self.assertIn("event: done\ndata: [DONE]", response.text)
                    payloads = [json.loads(line[6:]) for line in response.text.splitlines() if line.startswith("data: {")]
                    self.assertEqual(len(payloads), 1, response.text)
                    self.assertEqual(payloads[0]["type"], status)
                    self.assertEqual(payloads[0]["status"], status)
                    self.assertEqual(payloads[0]["action"], action)
                    self.assertEqual(payloads[0]["progress"], 0)
                    self.assertIsNone(payloads[0]["eta_seconds"])
                    self.assertTrue(payloads[0]["preserve_existing"])
                    self.assertEqual([path.read_bytes() for path in protected], before)
                    self.assertEqual(list(Path(paths.upload_dir).glob(".incoming_*")), [])
                    self.assertFalse(self.registry.has(job_id))
                    model.assert_not_called()
                    pipeline.assert_not_called()

    def test_cancelled_request_retains_registry_until_native_admission_probe_finishes(self):
        job_id = "duration_cancelled_request"
        paths, upload, checkpoint = self.seed(job_id)
        protected = [Path(paths.state_path), upload, checkpoint]
        before = [path.read_bytes() for path in protected]
        started = threading.Event()
        release = threading.Event()
        seen = {}

        def inspect(path):
            seen["path"] = Path(path)
            started.set()
            if not release.wait(3):
                raise RuntimeError("Test did not release media inspection")
            raise media_limits.MediaDurationError("media_duration_unavailable")

        async def exercise():
            task = asyncio.create_task(main.analyze_meeting(
                title="duration cancellation test", date="2026-10-18", mode="real", job_id=job_id,
                file=UploadFile(filename="sample.mp4", file=BytesIO(b"new upload")),
                report_template="{}", context_template="{}", selected_term_glossary_ids="[]", term_glossaries="[]",
            ))
            try:
                async with asyncio.timeout(2):
                    while not started.is_set():
                        await asyncio.sleep(.005)
                task.cancel()
                results = await asyncio.gather(task, return_exceptions=True)
                self.assertIsInstance(results[0], asyncio.CancelledError)
                self.assertTrue(self.registry.has(job_id))
                with self.assertRaises(ValueError):
                    self.registry.create(job_id)
                self.assertTrue(seen["path"].exists())
                self.assertEqual([path.read_bytes() for path in protected], before)
            finally:
                release.set()
                async with asyncio.timeout(2):
                    while self.registry.has(job_id) or (seen.get("path") and seen["path"].exists()):
                        await asyncio.sleep(.005)
            self.assertEqual([path.read_bytes() for path in protected], before)

        with patch.object(main, "validate_media_duration", side_effect=inspect), patch.object(main, "process_audio_pipeline") as pipeline:
            asyncio.run(exercise())
        pipeline.assert_not_called()

    def test_admission_claim_and_cancel_snapshot_respect_phase_and_event_ownership(self):
        job_id = "duration_admission_ownership"
        first = self.registry.create(job_id, admission_pending=True)
        self.assertFalse(self.registry.claim_admission(job_id, threading.Event()))
        self.assertEqual(self.registry.cancel_with_admission(job_id, "stop"), (True, True))
        self.assertTrue(first.is_set())
        self.assertFalse(self.registry.claim_admission(job_id, first))
        self.registry.remove(job_id, first)

        current = self.registry.create(job_id, admission_pending=True)
        self.assertFalse(self.registry.claim_admission(job_id, first))
        self.assertTrue(self.registry.claim_admission(job_id, current))
        self.assertEqual(self.registry.cancel_with_admission(job_id, "cancel"), (True, False))
        self.assertTrue(current.is_set())
        self.assertEqual(self.registry.get_action(job_id), "cancel")
        self.registry.remove(job_id, first)
        self.assertTrue(self.registry.has(job_id))
        self.registry.remove(job_id, current)
        self.assertEqual(self.registry.cancel_with_admission(job_id), (False, False))


if __name__ == "__main__":
    unittest.main()
