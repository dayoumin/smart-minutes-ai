import asyncio
import io
import tempfile
import types
import unittest
import zipfile
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import HTTPException

import main
import ollama_utils
from analysis_jobs import AnalysisJobRegistry
from ollama_runtime_update import RuntimeOwnershipError, checked_runtime_path, replace_runtime_bundle


class RuntimeBundleUpdateTest(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.target = self.root / "runtime" / "ollama"
        self.source = self.root / "runtime" / ".staged" / "ollama"
        for directory, marker in ((self.target, "old"), (self.source, "new")):
            (directory / "lib" / "ollama").mkdir(parents=True)
            (directory / "ollama.exe").write_text(marker, encoding="utf-8")
            (directory / "lib" / "ollama" / f"{marker}.dll").write_bytes(marker.encode())
        self.stop = Mock()
        self.verify = Mock()
        self.restart = Mock()

    def apply(self, cancelled=lambda: False):
        return replace_runtime_bundle(
            self.source, self.target, allowed_targets=[self.target], stop=self.stop,
            start_and_verify=self.verify, restart_original=self.restart, cancelled=cancelled,
        )

    def assert_original(self):
        self.assertEqual((self.target / "ollama.exe").read_text(), "old")
        self.assertTrue((self.target / "lib" / "ollama" / "old.dll").is_file())
        self.assertFalse((self.target / "lib" / "ollama" / "new.dll").exists())

    def test_full_bundle_replacement_preserves_user_siblings(self):
        for name in ("models", "outputs", "config.json"):
            (self.root / name).write_bytes(b"user-owned")
        self.apply()
        self.assertEqual((self.target / "ollama.exe").read_text(), "new")
        self.assertFalse((self.target / "lib" / "ollama" / "old.dll").exists())
        self.assertTrue((self.target / "lib" / "ollama" / "new.dll").is_file())
        self.assertEqual(list(self.target.parent.glob(".ollama-backup-*")), [])
        for name in ("models", "outputs", "config.json"):
            self.assertEqual((self.root / name).read_bytes(), b"user-owned")
        self.verify.assert_called_once()
        self.restart.assert_not_called()

    def test_restart_failure_restores_full_original_and_restarts_it(self):
        self.verify.side_effect = RuntimeError("new server failed")
        with self.assertRaisesRegex(RuntimeError, "new server failed"):
            self.apply()
        self.assert_original()
        self.assertEqual(self.stop.call_count, 2)
        self.restart.assert_called_once()

    def test_denied_atomic_rename_never_copies_over_original(self):
        original_rename = Path.rename

        def guarded_rename(path, destination):
            if path == self.target:
                raise PermissionError("busy runtime")
            return original_rename(path, destination)

        with patch.object(Path, "rename", guarded_rename), self.assertRaises(PermissionError):
            self.apply()
        self.assert_original()
        self.restart.assert_called_once()

    def test_cancel_during_install_restores_original(self):
        cancelled = False

        def verify():
            nonlocal cancelled
            cancelled = True

        self.verify.side_effect = verify
        with self.assertRaises(InterruptedError):
            self.apply(lambda: cancelled)
        self.assert_original()
        self.restart.assert_called_once()

    def test_user_data_in_runtime_and_foreign_target_are_refused_before_stop(self):
        (self.target / "models").mkdir()
        with self.assertRaisesRegex(RuntimeError, "user data"):
            self.apply()
        self.stop.assert_not_called()
        with self.assertRaisesRegex(RuntimeError, "not an app-managed"):
            checked_runtime_path(self.target, [self.root / "other"])
        self.assert_original()

    def test_incomplete_archive_is_refused_before_stop(self):
        import shutil
        shutil.rmtree(self.source / "lib")
        with self.assertRaisesRegex(RuntimeError, "complete"):
            self.apply()
        self.stop.assert_not_called()
        self.assert_original()

    def test_failed_stop_keeps_files_intact_and_tries_original_server(self):
        self.stop.side_effect = TimeoutError("still running")
        with self.assertRaises(TimeoutError):
            self.apply()
        self.assert_original()
        self.verify.assert_not_called()
        self.restart.assert_called_once()

    def test_unowned_listener_never_starts_or_stops_another_server(self):
        self.stop.side_effect = RuntimeOwnershipError("foreign listener")
        with self.assertRaises(RuntimeOwnershipError):
            self.apply()
        self.assert_original()
        self.restart.assert_not_called()

    def test_real_stop_contract_timeout_preserves_reference_and_original_bundle(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = main.subprocess.TimeoutExpired("owned ollama", 10)
        self.stop = ollama_utils.stop_managed_ollama_for_update
        with (patch.object(ollama_utils, "_EMBEDDED_OLLAMA_PROCESS", process),
              patch.object(ollama_utils, "_ollama_api_ready", return_value=True),
              patch.object(ollama_utils, "stop_embedded_ollama_server") as cleanup):
            with self.assertRaises(main.subprocess.TimeoutExpired):
                self.apply()
            self.assertIs(ollama_utils._EMBEDDED_OLLAMA_PROCESS, process)
            cleanup.assert_not_called()
        self.assert_original()
        self.assertEqual(list(self.target.parent.glob(".ollama-backup-*")), [])


class RuntimeUpdateApiTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.object(main, "OLLAMA_RUNTIME_DOWNLOAD_STATUS", {}))
        self.stack.enter_context(patch.object(main, "OLLAMA_PULL_STATUS", {}))
        self.stack.enter_context(patch.object(main, "OLLAMA_PULL_PROCESSES", {}))
        self.stack.enter_context(patch.object(main, "ACTIVE_GENERATIONS", set()))
        self.stack.enter_context(patch.object(main, "ANALYSIS_JOBS", AnalysisJobRegistry()))

    def test_version_error_is_specific_and_flag_survives_cancel_and_restart(self):
        code, message = main._ollama_pull_failure("Error 412: this model requires a newer version of Ollama")
        self.assertEqual(code, "runtime_update_required")
        self.assertEqual(message, "요약 프로그램을 업데이트한 뒤 모델 받기를 다시 눌러 주세요.")
        main._mark_ollama_runtime_cancelled("fixture")
        self.assertTrue(main._ollama_runtime_snapshot()["update_required"])
        main._set_ollama_runtime_download_status(active=True, status="installing")
        self.assertTrue(main._ollama_runtime_snapshot()["update_required"])
        for text, expected in (("412 precondition failed", "model_download_failed"),
                               ("access is denied", "permission_denied"),
                               ("no space left on device", "insufficient_space"),
                               ("pull model manifest: file does not exist", "model_not_found"),
                               ("TLS handshake timeout", "network_error")):
            self.assertEqual(main._ollama_pull_failure(text)[0], expected)

    def test_failed_pull_exposes_update_code_and_success_clears_stale_requirement(self):
        for code, output in ((1, "412: requires a newer version of Ollama"), (0, "success")):
            process = Mock(stdout=io.StringIO(output))
            process.poll.return_value = code
            process.wait.return_value = code
            with (patch.object(main, "ensure_ollama_server_running", return_value=True),
                  patch.object(main, "ollama_subprocess_env", return_value={}),
                  patch.object(main, "find_ollama_executable", return_value="fixture.exe"),
                  patch.object(main.subprocess, "Popen", return_value=process)):
                main._run_ollama_pull("fixture:tag")
            status = main._ollama_pull_snapshot("fixture:tag")
            self.assertFalse(status["active"])
            if code:
                self.assertEqual(status["error_code"], "runtime_update_required")
                self.assertTrue(main._ollama_runtime_snapshot()["update_required"])
            else:
                self.assertEqual(status["status"], "completed")
                self.assertFalse(main._ollama_runtime_snapshot()["update_required"])

    def test_update_explicitly_starts_worker_even_with_installed_executable(self):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "runtime" / "ollama"
            target.mkdir(parents=True)
            (target / "ollama.exe").write_bytes(b"old")
            main._set_ollama_runtime_download_status(update_required=True)
            with (patch.object(main, "find_embedded_ollama_executable", return_value=str(target / "ollama.exe")),
                  patch.object(main, "_ollama_runtime_target_candidates", return_value=[target]),
                  patch.object(main, "_ollama_runtime_download_preflight", return_value=""),
                  patch.object(main.threading, "Thread") as thread):
                status = main._start_ollama_runtime_download(update=True)
            self.assertTrue(status["active"])
            self.assertTrue(status["update_required"])
            self.assertEqual(thread.call_args.kwargs["target"], main._run_ollama_runtime_update)

    def test_active_work_refuses_update_and_update_refuses_new_work(self):
        for kind in ("pull", "generation", "analysis"):
            if kind == "pull":
                main.OLLAMA_PULL_STATUS["fixture"] = {"active": True}
            elif kind == "generation":
                main.ACTIVE_GENERATIONS.add(("fixture", "summary"))
            else:
                main.ANALYSIS_JOBS.create("fixture")
            with self.assertRaises(HTTPException) as error:
                main._start_ollama_runtime_download(update=True)
            self.assertEqual(error.exception.status_code, 409)
            main.OLLAMA_PULL_STATUS.clear()
            main.ACTIVE_GENERATIONS.clear()
            main.ANALYSIS_JOBS.remove("fixture")
        main._set_ollama_runtime_download_status(active=True, update=True)
        with self.assertRaises(HTTPException):
            main._start_ollama_pull("fixture")
        with self.assertRaises(HTTPException):
            main._begin_generation("fixture", "summary")

    def test_system_installation_is_not_updated_or_replaced(self):
        with (patch.object(main, "find_embedded_ollama_executable", return_value=""),
              patch.object(main.threading, "Thread") as thread,
              patch.object(main, "stop_managed_ollama_for_update") as stop):
            state = main._start_ollama_runtime_download(update=True)
        self.assertEqual(state["error_code"], "system_runtime_update_required")
        self.assertFalse(state["active"])
        thread.assert_not_called()
        stop.assert_not_called()

    def test_update_endpoint_preserves_auth_and_explicit_flag(self):
        request = types.SimpleNamespace(headers={})
        with patch.object(main, "DESKTOP_ACTION_TOKEN", "secret"), patch.object(main, "_start_ollama_runtime_download") as start:
            with self.assertRaises(HTTPException):
                asyncio.run(main.start_ollama_runtime_download(request, update=True))
            start.assert_not_called()
            request.headers = {main.DESKTOP_ACTION_TOKEN_HEADER: "secret"}
            asyncio.run(main.start_ollama_runtime_download(request, update=True))
            start.assert_called_once_with(update=True)

    def test_staged_update_verifies_version_then_swaps_and_clears_requirement(self):
        self.run_worker()

    def run_worker(self, download_error=None, cancel=False):
        with tempfile.TemporaryDirectory() as tmp:
            target = Path(tmp) / "runtime" / "ollama"
            target.mkdir(parents=True)
            (target / "ollama.exe").write_text("old")
            (target / "lib" / "ollama").mkdir(parents=True)
            (target / "lib" / "ollama" / "old.dll").write_bytes(b"old")

            def download(_target, archive_path):
                if download_error:
                    if cancel:
                        main._set_ollama_runtime_download_status(cancel_requested=True)
                    raise download_error
                with zipfile.ZipFile(archive_path, "w") as archive:
                    archive.writestr("ollama.exe", "new")
                    archive.writestr("lib/ollama/new.dll", "new")

            main._set_ollama_runtime_download_status(active=True, update=True, update_required=True)
            with (patch.object(main, "find_embedded_ollama_executable", return_value=str(target / "ollama.exe")),
                  patch.object(main, "_ollama_runtime_target_candidates", return_value=[target]),
                  patch.object(main, "_download_ollama_runtime_zip", side_effect=download),
                  patch.object(main, "ollama_subprocess_env", return_value={}),
                  patch.object(main.subprocess, "run", return_value=types.SimpleNamespace(returncode=0, stdout="0.40.10", stderr="")),
                  patch.object(main, "stop_managed_ollama_for_update") as stop,
                  patch.object(main, "verify_managed_ollama_version") as verify):
                main._run_ollama_runtime_update(target)
                state = main._ollama_runtime_snapshot()
            self.assertFalse(state["active"])
            if download_error:
                self.assertEqual(state["status"], "cancelled" if cancel else "failed")
                self.assertTrue(state["update_required"])
                self.assertEqual((target / "ollama.exe").read_text(), "old")
                stop.assert_not_called()
            else:
                self.assertEqual(state["status"], "completed")
                self.assertFalse(state["update_required"])
                self.assertEqual((target / "ollama.exe").read_text(), "new")
                verify.assert_called_once_with("0.40.10")

    def test_download_permission_failure_preserves_old_bundle_and_update_requirement(self):
        self.run_worker(PermissionError("denied"))

    def test_cancel_during_blocked_network_request_remains_cancelled(self):
        self.run_worker(TimeoutError("network request timed out"), cancel=True)

    def test_owned_stop_timeout_retains_process_reference_before_any_rename(self):
        process = Mock()
        process.poll.return_value = None
        process.wait.side_effect = main.subprocess.TimeoutExpired("owned ollama", 10)
        with (patch.object(ollama_utils, "_EMBEDDED_OLLAMA_PROCESS", process),
              patch.object(ollama_utils, "_ollama_api_ready", return_value=True),
              patch.object(ollama_utils, "stop_embedded_ollama_server") as cleanup):
            with self.assertRaises(main.subprocess.TimeoutExpired):
                ollama_utils.stop_managed_ollama_for_update()
            self.assertIs(ollama_utils._EMBEDDED_OLLAMA_PROCESS, process)
            cleanup.assert_not_called()

    def test_unowned_endpoint_is_not_stopped(self):
        with (patch.object(ollama_utils, "_EMBEDDED_OLLAMA_PROCESS", None),
              patch.object(ollama_utils, "_ollama_api_ready", return_value=True),
              patch.object(ollama_utils, "stop_embedded_ollama_server") as cleanup):
            with self.assertRaises(RuntimeOwnershipError):
                ollama_utils.stop_managed_ollama_for_update()
            cleanup.assert_not_called()

    def test_owned_stop_does_not_clear_reference_while_poll_still_running(self):
        process = Mock()
        process.poll.return_value = None
        with (patch.object(ollama_utils, "_EMBEDDED_OLLAMA_PROCESS", process),
              patch.object(ollama_utils, "_ollama_api_ready", return_value=True),
              patch.object(ollama_utils, "stop_embedded_ollama_server") as cleanup):
            with self.assertRaisesRegex(RuntimeError, "did not stop"):
                ollama_utils.stop_managed_ollama_for_update()
            self.assertIs(ollama_utils._EMBEDDED_OLLAMA_PROCESS, process)
            cleanup.assert_not_called()


if __name__ == "__main__":
    unittest.main()
