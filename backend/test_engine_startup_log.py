import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import engine_startup_log
import web_local_engine_runtime


BACKEND_DIR = Path(__file__).resolve().parent


class EngineStartupLogTest(unittest.TestCase):
    def test_constants_match_the_engine_layout(self):
        self.assertEqual(engine_startup_log.PRODUCT_DIR_NAME, web_local_engine_runtime.PRODUCT_DIR_NAME)
        self.assertEqual(engine_startup_log.ENGINE_DIR_NAME, web_local_engine_runtime.ENGINE_DIR_NAME)
        layout = web_local_engine_runtime.resolve_web_local_engine_layout(local_app_data="C:\\Users\\Someone\\AppData\\Local")
        with patch.object(sys, "frozen", True, create=True):
            path = engine_startup_log.startup_log_path({"LOCALAPPDATA": "C:\\Users\\Someone\\AppData\\Local"})
        self.assertEqual(path, layout.logs_dir / engine_startup_log.STARTUP_LOG_NAME)

    def test_unfrozen_process_without_override_writes_nothing(self):
        with patch.object(sys, "frozen", False, create=True):
            self.assertIsNone(engine_startup_log.startup_log_path({"LOCALAPPDATA": "C:\\x"}))
            self.assertFalse(engine_startup_log.begin(["--stop"], {"LOCALAPPDATA": "C:\\x"}).active)

    def test_records_mode_failure_and_exit_without_command_line_paths(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "logs" / "engine-startup.log"
            path.parent.mkdir()
            log = engine_startup_log.begin(["--stop", "C:\\private\\meeting.wav"], {engine_startup_log.OVERRIDE_ENV: str(path)})
            try:
                raise ImportError("DLL load failed while importing _ssl")
            except ImportError:
                log.record_exception("import")
            log.finish(3)
            text = path.read_text(encoding="utf-8")
        self.assertIn("start mode=stop", text)
        self.assertIn("FAILED stage=import", text)
        self.assertIn("DLL load failed while importing _ssl", text)
        self.assertIn("exit code=3", text)
        self.assertNotIn("meeting.wav", text)

    def test_system_exit_is_recorded_as_an_exit_code(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "engine-startup.log"
            log = engine_startup_log.begin([], {engine_startup_log.OVERRIDE_ENV: str(path)})
            try:
                raise SystemExit(2)
            except SystemExit:
                log.record_exception("main")
            text = path.read_text(encoding="utf-8")
        self.assertIn("start mode=serve", text)
        self.assertIn("exit code=2", text)
        self.assertNotIn("FAILED", text)

    def test_unwritable_data_folder_falls_back_to_temp(self):
        with tempfile.TemporaryDirectory() as root:
            blocker = Path(root) / "blocked"
            blocker.write_text("a file where the log folder should be", encoding="utf-8")
            environ = {
                engine_startup_log.OVERRIDE_ENV: str(blocker / "logs" / "engine-startup.log"),
                "TEMP": root,
            }
            log = engine_startup_log.begin([], environ)
            log.finish(0)
            fallback = Path(root) / engine_startup_log.FALLBACK_LOG_NAME
            text = fallback.read_text(encoding="utf-8")
        self.assertEqual(log.path, fallback)
        self.assertIn("data log folder unwritable", text)
        self.assertIn("start mode=serve", text)

    def test_check_modes_never_create_user_data(self):
        # Installer and payload checks require that check commands leave no engine data behind.
        for argv in (["--preflight-json", "out.json"], ["--installer-target-preflight-json", "a", "b"]):
            with self.subTest(argv=argv[0]), tempfile.TemporaryDirectory() as root:
                data_root = Path(root) / "Barorok" / "LocalEngine"
                environ = {engine_startup_log.OVERRIDE_ENV: str(data_root / "logs" / "engine-startup.log"), "TEMP": str(Path(root) / "temp")}
                log = engine_startup_log.begin(argv, environ)
                log.finish(0)
                self.assertFalse(log.active)
                self.assertFalse(data_root.exists())
                self.assertFalse((Path(root) / "temp").exists())

    def test_check_mode_logs_when_engine_data_already_exists(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "logs" / "engine-startup.log"
            path.parent.mkdir()
            engine_startup_log.begin(["--preflight-json", "out.json"], {engine_startup_log.OVERRIDE_ENV: str(path)}).finish(0)
            self.assertIn("start mode=preflight-json", path.read_text(encoding="utf-8"))

    def test_stop_without_engine_data_uses_temp_and_creates_no_data_folder(self):
        with tempfile.TemporaryDirectory() as root:
            data_root = Path(root) / "Barorok" / "LocalEngine"
            environ = {engine_startup_log.OVERRIDE_ENV: str(data_root / "logs" / "engine-startup.log"), "TEMP": root}
            log = engine_startup_log.begin(["--stop"], environ)
            log.finish(3)
            self.assertFalse(data_root.exists())
            text = (Path(root) / engine_startup_log.FALLBACK_LOG_NAME).read_text(encoding="utf-8")
        self.assertIn("start mode=stop", text)
        self.assertIn("exit code=3", text)
        self.assertNotIn("unwritable", text)

    def test_locked_log_skips_rotation_without_claiming_an_unwritable_folder(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "engine-startup.log"
            path.write_text("x" * (engine_startup_log.MAX_LOG_BYTES + 1), encoding="utf-8")
            with patch.object(Path, "replace", side_effect=PermissionError("in use")):
                log = engine_startup_log.begin([], {engine_startup_log.OVERRIDE_ENV: str(path)})
            log.finish(0)
            text = path.read_text(encoding="utf-8")
        self.assertEqual(log.path, path)
        self.assertIn("log rotation skipped (PermissionError)", text)
        self.assertNotIn("unwritable", text)

    def test_large_log_is_rotated_once(self):
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "engine-startup.log"
            path.write_text("x" * (engine_startup_log.MAX_LOG_BYTES + 1), encoding="utf-8")
            engine_startup_log.begin([], {engine_startup_log.OVERRIDE_ENV: str(path)}).finish(0)
            self.assertTrue(path.with_name(path.name + ".1").exists())
            self.assertLess(path.stat().st_size, 1024)

    def test_engine_import_failure_leaves_a_traceback(self):
        # A real import failure inside web_local_engine_server must reach the startup log.
        with tempfile.TemporaryDirectory() as root:
            path = Path(root) / "engine-startup.log"
            env = dict(os.environ)
            env[engine_startup_log.OVERRIDE_ENV] = str(path)
            env["PYTHONPATH"] = str(BACKEND_DIR)
            result = subprocess.run(
                [sys.executable, "-B", "-c", "import sys; sys.modules['uvicorn'] = None; import web_local_engine_server"],
                cwd=root, env=env, capture_output=True, text=True, timeout=120,
            )
            text = path.read_text(encoding="utf-8")
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("FAILED stage=import", text)
        self.assertIn("uvicorn", text)


if __name__ == "__main__":
    unittest.main()
