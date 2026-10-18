import logging
import threading
import unittest
from contextlib import ExitStack
from unittest.mock import Mock, patch

import ollama_utils


class FakeClock:
    def __init__(self):
        self.now = 0.0

    def monotonic(self):
        return self.now

    def sleep(self, seconds):
        self.now += seconds


class FakeProcess:
    pid = 321

    def __init__(self, clock, *, exit_at=None, exit_code=17):
        self.clock = clock
        self.exit_at = exit_at
        self.exit_code = exit_code

    def poll(self):
        if self.exit_at is not None and self.clock.now >= self.exit_at:
            return self.exit_code
        return None


class OllamaReadinessTest(unittest.TestCase):
    def setUp(self):
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.clock = FakeClock()
        self.process = FakeProcess(self.clock)
        self.job = Mock()
        for name, value in {
            "_EMBEDDED_OLLAMA_PROCESS": None,
            "_EMBEDDED_OLLAMA_JOB": None,
            "_EMBEDDED_OLLAMA_STARTED_AT": None,
            "_EMBEDDED_OLLAMA_READY_AT": None,
            "_EMBEDDED_OLLAMA_API_READY": False,
            "_EMBEDDED_OLLAMA_START_ERROR": None,
            "_EMBEDDED_OLLAMA_EXIT_REPORTED": False,
        }.items():
            self.stack.enter_context(patch.object(ollama_utils, name, value, create=True))
        self.stack.enter_context(patch.object(ollama_utils.time, "monotonic", self.clock.monotonic))
        self.stack.enter_context(patch.object(ollama_utils.time, "sleep", self.clock.sleep))
        self.stack.enter_context(patch.object(ollama_utils, "using_embedded_ollama", return_value=True))
        self.stack.enter_context(patch.object(ollama_utils, "find_ollama_executable", return_value="owned-runtime"))
        self.stack.enter_context(patch.object(ollama_utils, "ollama_subprocess_env", return_value={"TEST": "only"}))
        self.launch = self.stack.enter_context(patch.object(
            ollama_utils, "start_owned_process", return_value=(self.process, self.job),
        ))

    def test_passive_status_does_not_probe_or_start(self):
        with patch.object(ollama_utils, "_ollama_api_ready") as probe:
            self.assertFalse(ollama_utils.is_embedded_ollama_running())
            self.assertEqual(ollama_utils.get_embedded_ollama_status()["state"], "stopped")
            ollama_utils._EMBEDDED_OLLAMA_PROCESS = self.process
            ollama_utils._EMBEDDED_OLLAMA_STARTED_AT = 0.0
            self.clock.now = 7.0
            self.assertTrue(ollama_utils.is_embedded_ollama_running())
            status = ollama_utils.get_embedded_ollama_status()
        self.assertEqual(status["state"], "starting")
        self.assertEqual(status["elapsed_seconds"], 7.0)
        self.assertIsNone(status["exit_code"])
        probe.assert_not_called()
        self.launch.assert_not_called()

    def test_explicit_preparation_reuses_slow_start_and_accepts_late_ready(self):
        # Keep the no-argument probe contract used by existing runtime tests.
        def fake_ready():
            return self.clock.now >= 20.0

        with patch.object(ollama_utils, "_ollama_api_ready", side_effect=fake_ready):
            self.assertFalse(ollama_utils.ensure_ollama_server_running(timeout_seconds=1))
            self.assertEqual(ollama_utils.get_embedded_ollama_status()["state"], "starting")
            self.assertTrue(ollama_utils.wait_for_ollama_preparation(timeout_seconds=30))
            self.assertTrue(ollama_utils.ensure_ollama_server_running(timeout_seconds=1))
        self.assertEqual(self.launch.call_count, 1)
        self.assertEqual(self.clock.now, 20.0)
        self.assertEqual(ollama_utils.get_embedded_ollama_status()["state"], "ready")

    def test_early_owned_exit_returns_without_waiting_or_restarting(self):
        self.process.exit_at = 0.5
        with patch.object(ollama_utils, "_ollama_api_ready", return_value=False):
            self.assertFalse(ollama_utils.wait_for_ollama_preparation(timeout_seconds=300))
        self.assertEqual(self.clock.now, 0.5)
        self.assertEqual(self.launch.call_count, 1)
        status = ollama_utils.get_embedded_ollama_status()
        self.assertEqual(status["state"], "failed")
        self.assertFalse(status["running"])
        self.assertEqual(status["exit_code"], 17)

    def test_failed_preparation_preserves_live_owned_process_for_next_attempt(self):
        with patch.object(ollama_utils, "_ollama_api_ready", return_value=False):
            self.assertFalse(ollama_utils.wait_for_ollama_preparation(timeout_seconds=2))
            self.assertFalse(ollama_utils.wait_for_ollama_preparation(timeout_seconds=2))
        self.assertEqual(self.clock.now, 4.0)
        self.launch.assert_called_once()
        self.job.terminate_and_wait.assert_not_called()
        self.assertTrue(ollama_utils.is_embedded_ollama_running())

    def test_concurrent_preparation_creates_only_one_owned_process(self):
        launch_entered = threading.Event()
        release_launch = threading.Event()
        second_entered = threading.Event()
        results = []
        errors = []

        def launch(*args, **kwargs):
            launch_entered.set()
            if not release_launch.wait(timeout=2):
                raise AssertionError("Test did not release the controlled launch")
            return self.process, self.job

        def wait(second=False):
            if second:
                second_entered.set()
            try:
                results.append(ollama_utils.wait_for_ollama_preparation(timeout_seconds=1))
            except Exception as error:
                errors.append(error)

        self.launch.side_effect = launch
        first = threading.Thread(target=wait)
        second = threading.Thread(target=wait, args=(True,))
        with patch.object(ollama_utils, "_ollama_api_ready", return_value=False):
            first.start()
            try:
                self.assertTrue(launch_entered.wait(timeout=2))
                second.start()
                self.assertTrue(second_entered.wait(timeout=2))
            finally:
                release_launch.set()
                first.join(timeout=2)
                if second.ident is not None:
                    second.join(timeout=2)
        self.assertFalse(first.is_alive())
        self.assertFalse(second.is_alive())
        self.assertEqual(errors, [])
        self.assertEqual(results, [False, False])
        self.launch.assert_called_once()

    def test_deadline_includes_probe_and_launch_without_a_final_extra_probe(self):
        def slow_probe():
            self.clock.now += 0.4
            return False

        def slow_launch(*args, **kwargs):
            self.clock.now += 1.0
            return self.process, self.job

        self.launch.side_effect = slow_launch
        with patch.object(ollama_utils, "_ollama_api_ready", side_effect=slow_probe) as probe:
            self.assertFalse(ollama_utils.ensure_ollama_server_running(timeout_seconds=1))
        self.assertEqual(probe.call_count, 1)
        self.assertAlmostEqual(self.clock.now, 1.4)

    def test_existing_api_is_reused_without_creating_owned_process(self):
        with patch.object(ollama_utils, "_ollama_api_ready", return_value=True):
            self.assertTrue(ollama_utils.wait_for_ollama_preparation())
        self.launch.assert_not_called()
        self.assertFalse(ollama_utils.is_embedded_ollama_running())

    def test_external_runtime_remains_probe_only(self):
        with (
            patch.object(ollama_utils, "using_embedded_ollama", return_value=False),
            patch.object(ollama_utils, "_ollama_api_ready", return_value=False) as probe,
        ):
            self.assertFalse(ollama_utils.wait_for_ollama_preparation(timeout_seconds=300))
        self.assertEqual(self.clock.now, 0.0)
        probe.assert_called_once_with()
        self.launch.assert_not_called()

    def test_start_failure_records_safe_type_without_raw_message(self):
        self.launch.side_effect = OSError("private token and prompt")
        with (
            patch.object(ollama_utils, "_ollama_api_ready", return_value=False),
            self.assertLogs(ollama_utils.__name__, level=logging.INFO) as captured,
        ):
            with self.assertRaises(OSError):
                ollama_utils.wait_for_ollama_preparation()
        status = ollama_utils.get_embedded_ollama_status()
        self.assertEqual(status["state"], "failed")
        self.assertFalse(status["running"])
        self.assertNotIn("private token", " ".join(captured.output))
        self.assertNotIn("private token", repr(status))

    def test_ready_log_records_elapsed_once_without_environment_or_command(self):
        with (
            patch.object(ollama_utils, "_ollama_api_ready", side_effect=lambda: self.clock.now >= 0.5),
            self.assertLogs(ollama_utils.__name__, level=logging.INFO) as captured,
        ):
            self.assertTrue(ollama_utils.wait_for_ollama_preparation(timeout_seconds=2))
            self.assertTrue(ollama_utils.ensure_ollama_server_running(timeout_seconds=1))
        ready_logs = [line for line in captured.output if "API ready" in line]
        self.assertEqual(len(ready_logs), 1)
        self.assertIn("0.500", ready_logs[0])
        self.assertNotIn("TEST", " ".join(captured.output))
        self.assertNotIn("owned-runtime", " ".join(captured.output))


if __name__ == "__main__":
    unittest.main()
