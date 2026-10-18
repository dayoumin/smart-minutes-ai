import ctypes
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from ctypes import wintypes
from pathlib import Path
from unittest.mock import patch

import ollama_utils
import windows_process_job


FIXTURE = """
import json, os, subprocess, sys, time
from pathlib import Path
role, directory = sys.argv[1:]
root = Path(directory)
if role != 'grandchild':
    next_role = 'child' if role == 'parent' else 'grandchild'
    subprocess.Popen([sys.executable, __file__, next_role, directory], creationflags=0x08000000)
temporary = root / (role + '.tmp')
temporary.write_text(json.dumps({'pid': os.getpid()}))
temporary.replace(root / (role + '.json'))
while True:
    time.sleep(0.1)
"""


@unittest.skipUnless(os.name == "nt", "Windows owned process tree")
class WindowsProcessJobTest(unittest.TestCase):
    def setUp(self) -> None:
        self.kernel = ctypes.WinDLL("kernel32", use_last_error=True)
        self.kernel.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
        self.kernel.OpenProcess.restype = wintypes.HANDLE
        self.kernel.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
        self.kernel.WaitForSingleObject.restype = wintypes.DWORD
        self.kernel.TerminateProcess.argtypes = [wintypes.HANDLE, wintypes.UINT]
        self.kernel.TerminateProcess.restype = wintypes.BOOL
        self.kernel.CloseHandle.argtypes = [wintypes.HANDLE]
        self.kernel.CloseHandle.restype = wintypes.BOOL

    def _alive(self, handle) -> bool:
        return self.kernel.WaitForSingleObject(handle, 0) == 258

    def _fixture(self, *, exit_parent_first: bool) -> None:
        python = sys._base_executable
        real_popen = subprocess.Popen
        handles = []
        parent = None
        foreign = real_popen([python, "-c", "import time; time.sleep(60)"], creationflags=0x08000000)
        try:
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                script = root / "owned_fixture.py"
                script.write_text(FIXTURE, encoding="utf-8")

                def launch(_command, **kwargs):
                    return real_popen([python, str(script), "parent", directory], **kwargs)

                with (
                    patch.object(ollama_utils, "using_embedded_ollama", return_value=True),
                    patch.object(ollama_utils, "_ollama_api_ready", side_effect=[False, True]),
                    patch.object(ollama_utils, "ollama_subprocess_env", return_value=os.environ.copy()),
                    patch.object(ollama_utils, "find_ollama_executable", return_value=python),
                    patch.object(ollama_utils.subprocess, "Popen", side_effect=launch),
                ):
                    self.assertTrue(ollama_utils.ensure_ollama_server_running(timeout_seconds=1))
                parent = ollama_utils._EMBEDDED_OLLAMA_PROCESS
                deadline = time.monotonic() + 5
                while not (root / "grandchild.json").exists() and time.monotonic() < deadline:
                    time.sleep(0.01)
                self.assertTrue((root / "grandchild.json").exists())
                for role in ("parent", "child", "grandchild"):
                    pid = json.loads((root / f"{role}.json").read_text())["pid"]
                    handle = self.kernel.OpenProcess(0x00100001, False, pid)
                    self.assertTrue(handle)
                    handles.append(handle)
                self.assertTrue(all(self._alive(handle) for handle in handles))
                self.assertIsNotNone(ollama_utils._EMBEDDED_OLLAMA_JOB)
                self.assertGreaterEqual(ollama_utils._EMBEDDED_OLLAMA_JOB.active_processes(), 3)
                if exit_parent_first:
                    parent.terminate()
                    parent.wait(timeout=3)
                ollama_utils.stop_embedded_ollama_server(timeout_seconds=2)
                for handle in handles:
                    self.kernel.WaitForSingleObject(handle, 2000)
                remaining = [index for index, handle in enumerate(handles) if self._alive(handle)]
                self.assertEqual(remaining, [], "Owned child/grandchild survived the stop helper")
                self.assertIsNone(foreign.poll(), "An unrelated process must survive")
        finally:
            ollama_utils.stop_embedded_ollama_server(timeout_seconds=1)
            if parent is not None and parent.poll() is None:
                parent.kill()
                parent.wait(timeout=3)
            for handle in handles:
                if self._alive(handle):
                    self.kernel.TerminateProcess(handle, 1)
                    self.kernel.WaitForSingleObject(handle, 3000)
                self.kernel.CloseHandle(handle)
            foreign.terminate()
            foreign.wait(timeout=3)

    def test_owned_parent_child_grandchild_stop_preserves_foreign_process(self) -> None:
        self._fixture(exit_parent_first=False)

    def test_job_cleans_children_even_if_owned_parent_already_exited(self) -> None:
        self._fixture(exit_parent_first=True)

    def test_startup_failure_kills_only_the_suspended_owned_process(self) -> None:
        python = sys._base_executable
        real_popen = subprocess.Popen
        for failure in ("assign", "ambiguous_primary_thread"):
            with self.subTest(failure=failure), tempfile.TemporaryDirectory() as directory:
                marker = Path(directory) / "must-not-run.txt"
                launched = []

                def launch(command, **kwargs):
                    process = real_popen(command, **kwargs)
                    launched.append(process)
                    return process

                failure_patch = (
                    patch.object(windows_process_job.WindowsProcessJob, "assign", side_effect=OSError("assignment denied"))
                    if failure == "assign"
                    else patch.object(windows_process_job, "_thread_ids", return_value=[1, 2])
                )
                try:
                    with (
                        patch.object(windows_process_job.subprocess, "Popen", side_effect=launch),
                        failure_patch,
                    ):
                        with self.assertRaises((OSError, RuntimeError)):
                            windows_process_job.start_owned_process(
                                [python, "-c", "import pathlib,sys; pathlib.Path(sys.argv[1]).write_text('ran')", str(marker)],
                                creationflags=0x08000000,
                            )
                    self.assertEqual(len(launched), 1)
                    self.assertIsNotNone(launched[0].poll())
                    self.assertFalse(marker.exists())
                finally:
                    for process in launched:
                        if process.poll() is None:
                            process.kill()
                            process.wait(timeout=3)

    def test_job_close_is_idempotent(self) -> None:
        job = windows_process_job.WindowsProcessJob()
        job.close()
        job.close()
        self.assertEqual(job.active_processes(), 0)


class OwnedProcessCompatibilityTest(unittest.TestCase):
    def test_non_windows_keeps_the_original_popen_contract(self) -> None:
        with (
            patch.object(windows_process_job, "_IS_WINDOWS", False),
            patch.object(windows_process_job.subprocess, "Popen") as popen,
            patch.object(windows_process_job, "WindowsProcessJob") as job_type,
        ):
            process, job = windows_process_job.start_owned_process(["runtime", "serve"], env={"TEST": "value"})
        self.assertIs(process, popen.return_value)
        self.assertIsNone(job)
        popen.assert_called_once_with(["runtime", "serve"], env={"TEST": "value"})
        job_type.assert_not_called()

    def test_reusing_an_external_api_never_creates_an_owned_job(self) -> None:
        with (
            patch.object(ollama_utils, "using_embedded_ollama", return_value=False),
            patch.object(ollama_utils, "_ollama_api_ready", return_value=True),
            patch.object(ollama_utils, "start_owned_process") as start,
        ):
            self.assertTrue(ollama_utils.ensure_ollama_server_running())
        start.assert_not_called()


if __name__ == "__main__":
    unittest.main()
