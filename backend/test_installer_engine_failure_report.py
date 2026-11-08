import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

import engine_startup_log
import installer_engine_failure_report as report


def _fake_runner(outputs):
    def run(command, **_kwargs):
        return subprocess.CompletedProcess(command, 0, stdout=outputs.get(command[0], ""), stderr="")
    return run


EVENTS = """Event[0]:
  Log Name: Application
  Source: Application Error
  Event ID: 1000
  Description:
Faulting application name: barorok-local-engine-abc.exe, version: 0.0.0.0
Faulting module name: VCRUNTIME140.dll
Exception code: 0xc0000135
Event[1]:
  Log Name: Application
  Source: Application Error
  Event ID: 1000
  Description:
Faulting application name: other.exe
"""


class InstallerEngineFailureReportTest(unittest.TestCase):
    def test_paths_match_the_engine_startup_log(self):
        environ = {"LOCALAPPDATA": "C:\\L", "TEMP": "C:\\T"}
        self.assertEqual(report.STARTUP_LOG_NAME, engine_startup_log.STARTUP_LOG_NAME)
        self.assertEqual(report.FALLBACK_LOG_NAME, engine_startup_log.FALLBACK_LOG_NAME)
        primary, fallback = report.startup_log_paths(environ)
        self.assertEqual(fallback, engine_startup_log.fallback_log_path(environ))
        self.assertEqual(primary.parts[-4:], (report.PRODUCT_DIR_NAME, report.ENGINE_DIR_NAME, "logs", report.STARTUP_LOG_NAME))

    def test_report_collects_startup_traceback_dialog_events_and_environment(self):
        with tempfile.TemporaryDirectory() as root:
            local = Path(root) / "local"
            log = local / report.PRODUCT_DIR_NAME / report.ENGINE_DIR_NAME / "logs" / report.STARTUP_LOG_NAME
            log.parent.mkdir(parents=True)
            log.write_text("start mode=serve\n" + "\n".join(f"line {n}" for n in range(60)) + "\nFAILED stage=import\nImportError: DLL load failed\n", encoding="utf-8")
            environ = {"LOCALAPPDATA": str(local), "TEMP": str(Path(root) / "temp")}
            lines = report.build_report(
                "ENGINE_START_NOT_READY",
                str(Path(root) / "engine" / "barorok-local-engine-abc.exe"),
                environ,
                window_reader=lambda name: [f"[엔진 창] pid=1 class=#32770 title=Fatal error image={name}", "  | 내용: Failed to load Python DLL"],
                runner=_fake_runner({"wevtutil": EVENTS, "tasklist": '"barorok-local-engine-abc.exe","42","Console","1","10,000 K"\n'}),
            )
        text = "\n".join(lines)
        self.assertTrue(lines[0].startswith("[엔진 보고서 시작] stage=ENGINE_START_NOT_READY"))
        self.assertEqual(lines[-1], "[엔진 보고서 끝]")
        self.assertIn("ImportError: DLL load failed", text)
        self.assertNotIn("| line 0", text, "only the tail of a long startup log is copied")
        self.assertIn("Failed to load Python DLL", text)
        self.assertIn("[엔진 프로세스] 실행 중 1개", text)
        self.assertIn("Exception code: 0xc0000135", text)
        self.assertNotIn("other.exe", text)
        self.assertIn("data-root=writable", text)
        self.assertIn("없음 path=", text, "a missing fallback log is reported, not skipped")

    def test_a_failing_section_does_not_stop_the_report(self):
        def broken_reader(_name):
            raise OSError("access denied")
        def broken_runner(*_args, **_kwargs):
            raise subprocess.TimeoutExpired("wevtutil", 20)
        lines = report.build_report("ENGINE_STOP_FAILED", "C:\\e\\engine.exe", {}, window_reader=broken_reader, runner=broken_runner)
        text = "\n".join(lines)
        self.assertIn("[엔진 창] 수집 실패 (OSError", text)
        self.assertIn("[Windows 오류 기록] 조회 실패 (TimeoutExpired)", text)
        self.assertEqual(lines[-1], "[엔진 보고서 끝]")

    def test_main_always_exits_zero_and_writes_utf16le_without_bom(self):
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "engine-report.txt"
            env = dict(os.environ, LOCALAPPDATA=str(Path(root) / "local"), TEMP=root)
            result = subprocess.run(
                [sys.executable, "-B", str(Path(report.__file__)), "--stage", "테스트", "--engine-exe", str(Path(root) / "missing.exe"), "--output", str(output)],
                env=env, capture_output=True, timeout=120,
            )
            raw = output.read_bytes()
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertFalse(raw.startswith(b"\xff\xfe"))
            text = raw.decode("utf-16-le")
            self.assertTrue(text.startswith("[엔진 보고서 시작] stage=테스트"))
            self.assertTrue(text.endswith("[엔진 보고서 끝]\r\n"))
            self.assertEqual(report.main(["--stage"]), 0, "bad arguments never fail the installer")

    def test_watch_stop_reads_the_dialog_while_it_is_open_and_returns_the_exit_code(self):
        polls = iter([None, None, 0xC0000135])
        process = type("Process", (), {"poll": lambda self: next(polls)})()
        dialog = ["[엔진 창] pid=9 class=#32770 title=Fatal error image=x", "  | 내용: Failed to start embedded python interpreter!"]
        reads = []
        def reader(name):
            reads.append(name)
            return dialog if len(reads) >= 2 else []
        code, lines = report.watch_engine(
            ["C:\\e\\barorok-local-engine-x.exe", "--stop"], wait_until_exit=True,
            window_reader=reader, popen=lambda *a, **k: process, sleep=lambda _s: None,
        )
        self.assertEqual(code, 0xC0000135)
        self.assertEqual(reads[0], "barorok-local-engine-x.exe")
        self.assertEqual(lines.count(dialog[1]), 1, "a dialog seen on several polls is recorded once")
        self.assertIn("exited code=3221225781 (0xC0000135) windows=1", lines[-1])
        self.assertEqual(report._signed_exit(0xC0000135) & 0xFFFFFFFF, 0xC0000135)
        self.assertEqual(report._signed_exit(3), 3)

    def test_watch_start_returns_when_the_engine_answers_or_after_the_limit(self):
        process = type("Process", (), {"poll": lambda self: None})()
        ready = iter([False, True])
        code, lines = report.watch_engine(
            ["C:\\e\\engine.exe"], wait_until_exit=False, window_reader=lambda _n: [],
            popen=lambda *a, **k: process, port_ready=lambda: next(ready), sleep=lambda _s: None,
        )
        self.assertIsNone(code)
        self.assertIn("결과 ready after", lines[-1])
        now = iter([0.0, 5.0, 25.0])
        code, lines = report.watch_engine(
            ["C:\\e\\engine.exe"], wait_until_exit=False, window_reader=lambda _n: [],
            popen=lambda *a, **k: process, port_ready=lambda: False, clock=lambda: next(now), sleep=lambda _s: None,
        )
        self.assertIn("still starting after 20s", lines[-1])

    def test_a_port_already_answering_does_not_end_the_start_watch(self):
        process = type("Process", (), {"poll": lambda self: None})()
        now = iter([0.0, 1.0, 21.0])
        code, lines = report.watch_engine(
            ["C:\\e\\engine.exe"], wait_until_exit=False, window_reader=lambda _n: [],
            popen=lambda *a, **k: process, port_ready=lambda: True, clock=lambda: next(now), sleep=lambda _s: None,
        )
        self.assertIn("시작 전부터 17863 포트가 응답함", "\n".join(lines))
        self.assertIn("still starting after 20s", lines[-1])

    def test_real_command_line_argument_errors_never_report_a_successful_stop(self):
        with patch.object(sys, "argv", ["barorok-installer-diagnostic-report.exe", "--watch", "stop"]):
            self.assertEqual(report.main(), report.WATCH_LAUNCH_FAILED_EXIT)
        with patch.object(sys, "argv", ["barorok-installer-diagnostic-report.exe", "--stage"]):
            self.assertEqual(report.main(), 0)

    def test_watch_launch_failure_is_reported(self):
        def popen(*_a, **_k):
            raise FileNotFoundError("missing engine")
        code, lines = report.watch_engine(["C:\\missing.exe", "--stop"], wait_until_exit=True, popen=popen)
        self.assertIsNone(code)
        self.assertIn("실행 실패 (FileNotFoundError", lines[-1])

    def test_watch_stop_main_passes_the_real_exit_code_through(self):
        # python.exe rejects --stop with exit code 2; the watcher must return it unchanged.
        with tempfile.TemporaryDirectory() as root:
            output = Path(root) / "watch.txt"
            code = report.main(["--watch", "stop", "--stage", "engine.stop", "--engine-exe", sys.executable, "--output", str(output)])
            text = output.read_bytes().decode("utf-16-le")
        self.assertEqual(code, 2)
        self.assertTrue(text.startswith("[엔진 실행 관찰 시작] stage=engine.stop"))
        self.assertIn("exited code=2 (0x00000002)", text)
        self.assertEqual(report.main(["--watch", "stop"]), report.WATCH_LAUNCH_FAILED_EXIT, "a stop that never ran is not a success")

    def test_long_window_text_is_split_below_the_nsis_line_limit(self):
        lines = report._wrapped("  | 내용: ", "가" * 1500)
        self.assertEqual(len(lines), 4)
        self.assertTrue(all(len(line) < 450 for line in lines))
        self.assertEqual("".join(line.split(": ", 1)[-1].replace("  | (계속) ", "") for line in lines).count("가"), 1500)

    @unittest.skipUnless(os.name == "nt", "Windows window enumeration")
    def test_window_reader_runs_on_windows(self):
        self.assertEqual(report.engine_window_texts("no-such-engine-process.exe"), [])


if __name__ == "__main__":
    unittest.main()
