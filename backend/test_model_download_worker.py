import sys
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

import desktop_server
import main
import model_download_worker
import web_local_engine_server


class ModelDownloadWorkerTest(unittest.TestCase):
    def test_download_error_returns_failure_and_writes_diagnostic(self):
        with tempfile.TemporaryDirectory() as folder:
            error_file = Path(folder) / "error.log"
            with patch("huggingface_hub.snapshot_download", side_effect=OSError("test offline")):
                result = model_download_worker.main(["--repo", "test/model", "--target", folder, "--error-file", str(error_file)])
            self.assertEqual(result, 1)
            self.assertIn("test offline", error_file.read_text(encoding="utf-8"))

    def test_unwritable_diagnostic_still_exits_without_unhandled_error(self):
        with tempfile.TemporaryDirectory() as folder:
            with patch("huggingface_hub.snapshot_download", side_effect=OSError("offline")):
                self.assertEqual(model_download_worker.main(["--repo", "test/model", "--target", folder, "--error-file", folder]), 1)

    def test_desktop_frozen_worker_dispatch_does_not_launch_server(self):
        with patch.object(sys, "argv", ["backend.exe", "--download-model", "--repo", "test/model"]), patch.object(model_download_worker, "main", return_value=1) as worker, patch.object(desktop_server.uvicorn, "run") as serve:
            with self.assertRaises(SystemExit) as result:
                desktop_server.main()
        self.assertEqual(result.exception.code, 1)
        worker.assert_called_once_with(["--repo", "test/model"])
        serve.assert_not_called()

    def test_web_engine_worker_dispatch_does_not_launch_server(self):
        with patch.object(model_download_worker, "main", return_value=1) as worker, patch.object(web_local_engine_server, "_create_server") as serve:
            self.assertEqual(web_local_engine_server.main(["--download-model", "--repo", "test/model"]), 1)
        worker.assert_called_once_with(["--repo", "test/model"])
        serve.assert_not_called()

    def test_stop_terminates_only_owned_worker_and_preserves_partial(self):
        with tempfile.TemporaryDirectory() as folder:
            partial = Path(folder) / "model.bin.incomplete"
            partial.write_bytes(b"keep this prefix")
            process, job = Mock(), Mock()
            process.poll.return_value = None
            with patch.object(main, "start_owned_process", return_value=(process, job)) as start, patch.object(main, "_model_download_cancel_requested", return_value=True):
                with self.assertRaises(InterruptedError):
                    main._download_huggingface_snapshot("test/model", folder)
            job.terminate_and_wait.assert_called_once_with()
            job.close.assert_called_once_with()
            self.assertEqual(partial.read_bytes(), b"keep this prefix")
            self.assertIn("model_download_worker.py", " ".join(start.call_args.args[0]))

    def test_missing_model_failure_is_not_resumable(self):
        state = {"model": "missing:1b", "active": False, "status": "failed", "error_code": "model_not_found", "progress_percent": None}
        with patch.dict(main.OLLAMA_PULL_STATUS, {"missing:1b": state}, clear=True):
            self.assertFalse(main._ollama_pull_snapshot("missing:1b")["can_resume"])
            state.update(status="cancelled", error_code="", progress_percent=0)
            self.assertTrue(main._ollama_pull_snapshot("missing:1b")["can_resume"])

    def test_runtime_worker_keeps_partial_after_stop_or_network_failure(self):
        for failure in (InterruptedError("stopped"), OSError("offline")):
            with self.subTest(failure=type(failure).__name__), tempfile.TemporaryDirectory() as folder:
                target = Path(folder)
                part = target / ".download/ollama-windows-amd64.zip.part"
                def download(_target, path):
                    path.write_bytes(b"keep the pinned prefix")
                    path.with_suffix(path.suffix + ".json").write_text(json.dumps({"url": main.OLLAMA_RUNTIME_DOWNLOAD_URL, "sha256": main.OLLAMA_RUNTIME_SHA256, "expected_bytes": main.OLLAMA_RUNTIME_EXPECTED_BYTES}), encoding="utf-8")
                    raise failure
                with patch.dict(main.OLLAMA_RUNTIME_DOWNLOAD_STATUS, {}, clear=True), patch.object(main, "find_embedded_ollama_executable", return_value=""), patch.object(main, "_download_ollama_runtime_zip", side_effect=download):
                    main._run_ollama_runtime_download(target)
                    self.assertEqual(part.read_bytes(), b"keep the pinned prefix")
                    self.assertTrue(main._ollama_runtime_snapshot()["can_resume"])


if __name__ == "__main__":
    unittest.main()
