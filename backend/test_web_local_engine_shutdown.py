import asyncio
import json
import tempfile
import threading
import unittest
from io import BytesIO
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from web_local_engine_server import _create_server


async def _unused_app(_scope, _receive, _send):
    raise AssertionError("These shutdown tests must not start a network server")


class WebLocalEngineShutdownTest(unittest.IsolatedAsyncioTestCase):
    def _server(self):
        server = _create_server(_unused_app)
        self.assertEqual(server.config.timeout_graceful_shutdown, 5)
        server.config.timeout_graceful_shutdown = 0.02
        server.servers = []
        server.lifespan = SimpleNamespace(shutdown=AsyncMock())
        return server

    async def test_shutdown_bounds_listener_wait_closed_and_runs_lifespan(self) -> None:
        server = self._server()
        wait_cancelled = asyncio.Event()

        async def never_closed():
            try:
                await asyncio.Event().wait()
            finally:
                wait_cancelled.set()

        listener = SimpleNamespace(close=Mock(), wait_closed=AsyncMock(side_effect=never_closed))
        server.servers = [listener]
        with self.assertLogs("uvicorn.error", level="ERROR") as logs:
            await asyncio.wait_for(server.shutdown(), timeout=1)

        listener.close.assert_called_once_with()
        listener.wait_closed.assert_awaited_once_with()
        self.assertTrue(wait_cancelled.is_set())
        server.lifespan.shutdown.assert_awaited_once_with()
        self.assertIn("timeout graceful shutdown exceeded", " ".join(logs.output))

    async def test_shutdown_request_cancellation_preserves_analysis_checkpoint_and_saved_result(self) -> None:
        from fastapi import UploadFile

        import main
        from analysis_jobs import AnalysisCancelledError
        from job_checkpoints import atomic_write_json, build_job_checkpoint_paths, load_json_checkpoint

        server = self._server()
        with tempfile.TemporaryDirectory() as work_dir:
            root = Path(work_dir)
            job_id = "unit_shutdown_checkpoint"
            config = {
                "paths": {
                    "temp_dir": str(root / "temp"),
                    "output_dir": str(root / "outputs"),
                    "stt_model": "mock-model",
                    "qwen_aligner_model": "mock-aligner",
                },
                "stt": {"selected_model": "faster-whisper-large-v3"},
                "diarization": {"enabled": False},
                "privacy": {"save_original_audio_copy": False},
            }
            saved_path = root / "outputs" / f"{job_id}_result.json"
            saved_path.parent.mkdir()
            saved_bytes = b'{"summary":{"overview":"previous completed result"}}'
            saved_path.write_bytes(saved_bytes)
            checkpoints = build_job_checkpoint_paths(config["paths"]["temp_dir"], job_id)
            worker_started = threading.Event()
            worker_cancel = threading.Event()

            def pipeline(_upload, _job, _config, _progress, cancel_event):
                atomic_write_json(checkpoints.stt_merged_path, {"segments": [{"text": "checkpoint"}]})
                worker_started.set()
                try:
                    if not cancel_event.wait(timeout=3):
                        raise TimeoutError("The shutdown did not reach the analysis cancellation boundary")
                    raise AnalysisCancelledError("stopped")
                finally:
                    worker_cancel.set()

            async def consume_stream():
                upload = UploadFile(filename="sample.wav", file=BytesIO(b"audio"))
                async for _event in main.stream_real_analysis("test", "2026-10-18", "", upload, job_id):
                    pass

            with (
                patch("main.load_config", return_value=config),
                patch("main.model_exists", return_value=True),
                patch("main.resolve_model_path", return_value="mock-model"),
                patch("main.process_audio_pipeline", side_effect=pipeline),
            ):
                request_task = asyncio.create_task(consume_stream())
                server.server_state.tasks.add(request_task)
                request_task.add_done_callback(server.server_state.tasks.discard)
                try:
                    for _ in range(200):
                        if worker_started.is_set():
                            break
                        await asyncio.sleep(0.005)
                    self.assertTrue(worker_started.is_set())
                    with self.assertLogs("uvicorn.error", level="ERROR"):
                        await asyncio.wait_for(server.shutdown(), timeout=1)
                    await asyncio.gather(request_task, return_exceptions=True)
                    state = {}
                    for _ in range(200):
                        if Path(checkpoints.state_path).exists():
                            state = load_json_checkpoint(checkpoints.state_path)
                        if state.get("stage") == "stopped":
                            break
                        await asyncio.sleep(0.005)
                finally:
                    request_task.cancel()
                    await asyncio.gather(request_task, return_exceptions=True)

            self.assertTrue(worker_cancel.is_set())
            self.assertEqual(state.get("stage"), "stopped")
            self.assertTrue(state.get("resume_supported"))
            self.assertEqual(state.get("cancel_action"), "stop")
            self.assertEqual(saved_path.read_bytes(), saved_bytes)
            self.assertEqual(
                json.loads(Path(checkpoints.stt_merged_path).read_text(encoding="utf-8")),
                {"segments": [{"text": "checkpoint"}]},
            )
            server.lifespan.shutdown.assert_awaited_once_with()


if __name__ == "__main__":
    unittest.main()
