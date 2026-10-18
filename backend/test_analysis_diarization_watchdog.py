import asyncio
import tempfile
import threading
import time
import unittest
from contextlib import ExitStack
from io import BytesIO
from pathlib import Path
from unittest.mock import patch

from starlette.datastructures import UploadFile

import main
from analysis_jobs import AnalysisCancelledError, AnalysisJobRegistry
from job_checkpoints import build_job_checkpoint_paths, load_json_checkpoint


class DiarizationBudgetTest(unittest.TestCase):
    def test_budget_uses_actual_duration_and_remains_bounded(self):
        cases = [
            ({"total_audio_seconds": 1800, "eta_seconds": 1}, 5400),
            ({"total_audio_seconds": 30}, 600),
            ({"total_audio_seconds": 18000}, 7200),
            ({"eta_seconds": 2700}, 5400),
            ({"eta_seconds": float("inf")}, 600),
            ({"total_audio_seconds": float("nan"), "eta_seconds": -1}, 600),
            ({"total_audio_seconds": 1e308}, 7200),
        ]
        for metadata, expected in cases:
            with self.subTest(metadata=metadata):
                self.assertEqual(main.get_analysis_stall_timeout_seconds({"stage": "diarization", **metadata}), expected)

    def test_other_stage_limits_and_legacy_diarization_message_remain_supported(self):
        self.assertEqual(main.get_analysis_stall_timeout_seconds({"message": "Transcribing chunk 1/60...", "progress": 30}), 600)
        self.assertEqual(main.get_analysis_stall_timeout_seconds({"message": "Converting to WAV...", "progress": 10}), 600)
        self.assertEqual(main.get_analysis_stall_timeout_seconds({"message": "Preparing audio chunks...", "progress": 25}), 300)
        self.assertEqual(main.get_analysis_stall_timeout_seconds({"message": "Other work", "progress": 70}), 180)
        self.assertEqual(main.get_analysis_stall_timeout_seconds({"message": "Speaker Diarization & Alignment...", "eta_seconds": 2700}), 5400)


class DiarizationWatchdogTest(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.root = Path(self.resources.enter_context(tempfile.TemporaryDirectory(prefix="diarization-watchdog-")))
        self.config = {
            "paths": {"temp_dir": str(self.root / "temp"), "output_dir": str(self.root / "outputs")},
            "stt": {"selected_model": "faster-whisper-large-v3"},
            "diarization": {"enabled": True}, "privacy": {"save_original_audio_copy": False},
        }
        self.registry = AnalysisJobRegistry()
        self.resources.enter_context(patch.object(main, "ANALYSIS_JOBS", self.registry))
        self.resources.enter_context(patch.object(main, "load_config", return_value=self.config))
        self.resources.enter_context(patch.object(main, "model_exists", return_value=True))
        self.resources.enter_context(patch.object(main, "resolve_model_path", return_value="mock-model"))
        self.resources.enter_context(patch.object(main, "ANALYSIS_HEARTBEAT_SECONDS", .005))
        self.resources.enter_context(patch.object(main, "ANALYSIS_STALL_ERROR_SECONDS", .02))

    def stream(self, job_id):
        return main.stream_real_analysis(
            "watchdog test", "2026-10-18", "", UploadFile(filename="sample.wav", file=BytesIO(b"audio")), job_id,
        )

    async def collect(self, job_id):
        return [event async for event in self.stream(job_id)]

    def seed_saved_work(self, job_id):
        paths = build_job_checkpoint_paths(self.config["paths"]["temp_dir"], job_id)
        Path(paths.stt_dir).mkdir(parents=True, exist_ok=True)
        checkpoint = Path(paths.stt_dir) / "chunk_001.json"
        checkpoint.write_bytes(b'{"segments":[{"text":"saved"}]}')
        partial = self.root / "outputs" / f"{job_id}_partial_result.json"
        partial.parent.mkdir(exist_ok=True)
        partial.write_bytes(b'{"segments":[{"text":"saved transcript"}]}')
        main._write_job_state(paths, {"stage": "diarization", "stt_completed": True, "completed_chunk_indices": [0]})
        return paths, checkpoint, partial

    async def wait_until_released(self, job_id):
        async with asyncio.timeout(2):
            while self.registry.has(job_id):
                await asyncio.sleep(.005)

    def result(self, job_id):
        return {"job_id": job_id, "result_data": {"segments": [], "summary": {}}}

    async def test_slow_diarization_survives_general_inactivity_limit(self):
        def pipeline(upload, job_id, config, report, cancel_event):
            report("Speaker Diarization & Alignment...", 70, {"stage": "diarization", "total_audio_seconds": 1800})
            time.sleep(.07)
            self.assertFalse(cancel_event.is_set())
            return self.result(job_id)

        with (
            patch.object(main, "ANALYSIS_DIARIZATION_TIMEOUT_MIN_SECONDS", .2),
            patch.object(main, "ANALYSIS_DIARIZATION_TIMEOUT_MAX_SECONDS", .2),
            patch.object(main, "process_audio_pipeline", side_effect=pipeline),
        ):
            events = await asyncio.wait_for(self.collect("unit_long_diarization"), 2)
        body = "\n".join(events)
        self.assertIn('"heartbeat": true', body)
        self.assertIn("event: result", body)
        self.assertNotIn("event: error", body)

    async def test_timeout_preserves_work_and_retains_job_until_native_return(self):
        job_id = "unit_diarization_timeout"
        release = threading.Event()
        seen = {}
        paths, checkpoint, partial = self.seed_saved_work(job_id)
        before = checkpoint.read_bytes(), partial.read_bytes()

        def pipeline(upload, current_job, config, report, cancel_event):
            seen.update(upload=upload, cancel_event=cancel_event)
            report("Speaker Diarization & Alignment...", 70, {"stage": "diarization", "eta_seconds": 2700})
            release.wait(2)
            if cancel_event.is_set():
                raise AnalysisCancelledError("cancelled after native return")
            return self.result(current_job)

        with (
            patch.object(main, "ANALYSIS_DIARIZATION_TIMEOUT_MIN_SECONDS", .06),
            patch.object(main, "ANALYSIS_DIARIZATION_TIMEOUT_MAX_SECONDS", .06),
            patch.object(main, "process_audio_pipeline", side_effect=pipeline),
        ):
            try:
                events = await asyncio.wait_for(self.collect(job_id), 2)
                body = "\n".join(events)
                self.assertIn('"heartbeat": true', body)
                self.assertIn('"code": "analysis_stage_timeout"', body)
                self.assertNotIn("event: result", body)
                self.assertTrue(seen["cancel_event"].is_set())
                self.assertTrue(self.registry.has(job_id))
                self.assertTrue(Path(seen["upload"]).exists())
                with self.assertRaises(ValueError):
                    self.registry.create(job_id)
                state = load_json_checkpoint(paths.state_path)
                self.assertTrue(state["failed"])
                self.assertFalse(state["cancelled"])
            finally:
                release.set()
                await self.wait_until_released(job_id)
        state = load_json_checkpoint(paths.state_path)
        self.assertEqual(state["stage"], "failed")
        self.assertEqual(state["last_error_code"], "analysis_stage_timeout")
        self.assertTrue(state["resume_supported"])
        self.assertEqual((checkpoint.read_bytes(), partial.read_bytes()), before)
        self.assertFalse(Path(seen["upload"]).exists())

    async def test_repeated_same_phase_progress_cannot_extend_deadline(self):
        job_id = "unit_diarization_fixed_deadline"

        def pipeline(upload, current_job, config, report, cancel_event):
            for _ in range(80):
                report("Speaker Diarization & Alignment...", 70, {"stage": "diarization", "eta_seconds": 2700})
                time.sleep(.003)
            return self.result(current_job)

        with (
            patch.object(main, "ANALYSIS_DIARIZATION_TIMEOUT_MIN_SECONDS", .04),
            patch.object(main, "ANALYSIS_DIARIZATION_TIMEOUT_MAX_SECONDS", .04),
            patch.object(main, "process_audio_pipeline", side_effect=pipeline),
        ):
            events = await asyncio.wait_for(self.collect(job_id), 2)
            await self.wait_until_released(job_id)
        self.assertIn('"code": "analysis_stage_timeout"', "\n".join(events))
        self.assertNotIn("event: result", "\n".join(events))

    async def test_cancelled_async_waiter_keeps_native_ownership_and_preserves_saved_work(self):
        import gc

        loop = asyncio.get_running_loop()
        previous_handler = loop.get_exception_handler()
        unhandled = []
        loop.set_exception_handler(lambda _loop, context: unhandled.append(context))
        self.addCleanup(loop.set_exception_handler, previous_handler)
        job_id = "unit_native_waiter_cancel"
        paths, checkpoint, partial = self.seed_saved_work(job_id)
        release = threading.Event()
        seen = {}
        captured = []
        create_task = asyncio.create_task

        def capture_task(coro, *args, **kwargs):
            task = create_task(coro, *args, **kwargs)
            if coro.__qualname__.endswith("stream_real_analysis.<locals>.worker"):
                captured.append(task)
            return task

        def pipeline(upload, current_job, config, report, cancel_event):
            seen["upload"] = upload
            report("Speaker Diarization & Alignment...", 70, {"stage": "diarization"})
            release.wait(2)
            raise AnalysisCancelledError("native returned after cancellation")

        with patch.object(main, "process_audio_pipeline", side_effect=pipeline), patch.object(main.asyncio, "create_task", side_effect=capture_task):
            stream = self.stream(job_id)
            try:
                async for event in stream:
                    if '"stage": "diarization"' in event:
                        break
                await stream.aclose()
                self.assertEqual(len(captured), 1)
                captured[0].cancel()
                await asyncio.gather(captured[0], return_exceptions=True)
                self.assertTrue(self.registry.has(job_id))
                self.assertTrue(Path(seen["upload"]).exists())
            finally:
                release.set()
                await self.wait_until_released(job_id)
        self.assertTrue(checkpoint.exists())
        self.assertTrue(partial.exists())
        self.assertEqual(load_json_checkpoint(paths.state_path)["stage"], "stopped")
        captured.clear()
        stream = None
        await asyncio.sleep(0)
        gc.collect()
        await asyncio.sleep(0)
        self.assertEqual(unhandled, [], "Native completion errors must be retrieved after the async waiter is cancelled")


if __name__ == "__main__":
    unittest.main()
