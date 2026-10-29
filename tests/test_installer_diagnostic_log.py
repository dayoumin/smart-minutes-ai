"""Execute only isolated NSIS logger fixtures, never the real installer."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[1]
COMPILER = Path(os.environ.get("LMO_MAKENSIS", str(
    Path(os.environ.get("LOCALAPPDATA", "")) / "tauri/NSIS/makensis.exe"
)))


@unittest.skipUnless(os.name == "nt" and COMPILER.is_file(), "Windows NSIS compiler required")
class InstallerDiagnosticLogTest(unittest.TestCase):
    def _compile(self, folder, *, enabled=True, blocked=False, init_abort=False):
        log_dir = folder / "다운로드 진단"
        if blocked:
            log_dir.write_bytes(b"user sentinel")
        source = folder / "logger.nsi"
        binary = folder / "logger.exe"
        defines = (f'!define INSTALLER_DIAGNOSTICS\n'
                   f'!define INSTALLER_DIAGNOSTIC_TEST_DIR "{log_dir}"\n') if enabled else ""
        initialization = ""
        if init_abort:
            # Reuse a real early-failure branch. Only its visible MessageBox is omitted;
            # no actual installer .onInit, program files, registry, or helper is executed.
            installer = (ROOT / "installer/web-local-engine.nsi").read_text(encoding="utf-8")
            branch = installer.split("running_engine_missing:\n", 1)[1].split("preflight_ready:", 1)[0]
            branch = "\n".join(line for line in branch.splitlines() if not line.strip().startswith("MessageBox "))
            initialization = "Function .onInit\n  Call InitInstallerDiagnostic\n" + branch + "\nFunctionEnd\n"
        source.write_text('''Unicode True
RequestExecutionLevel user
SilentInstall silent
AutoCloseWindow true
Name "Isolated installer logger regression"
OutFile "''' + str(binary) + '''"
!include "LogicLib.nsh"
!define ENGINE_VERSION "diagnostic-fixture"
''' + defines + f'!include "{ROOT / "installer/diagnostic-log.nsh"}"\n' + initialization + '''
Section
  StrCpy $0 "register-zero"
  StrCpy $1 "register-one"
  StrCpy $R0 "register-r-zero"
!ifdef INSTALLER_DIAGNOSTICS
  Call InitInstallerDiagnostic
!endif
  StrCmp $0 "register-zero" 0 failed
  StrCmp $1 "register-one" 0 failed
  StrCmp $R0 "register-r-zero" 0 failed
  Push "caller-stack-sentinel"
  SetErrors
  !insertmacro InstallerDiagnostic "before child launch exit=$0"
  IfErrors +2
  Goto failed
  SetErrors
  !insertmacro InstallerDiagnosticError "PYTHON_START_FAILED" "첫 시작 실패 exit=1"
  IfErrors +2
  Goto failed
  ClearErrors
  !insertmacro InstallerDiagnosticError "CLEANUP_STOP_FAILED" "후속 정리 실패 exit=2"
  IfErrors failed
  SetErrors
  !insertmacro InstallerDiagnosticFile "$EXEPATH"
  IfErrors +2
  Goto failed
  ClearErrors
  !insertmacro InstallerDiagnosticFile "$EXEDIR\\missing-python-library.zip"
  IfErrors failed
  !insertmacro InstallerDiagnostic "after two independent errors"
  IfErrors failed
  StrCmp $0 "register-zero" 0 failed
  StrCmp $1 "register-one" 0 failed
  StrCmp $R0 "register-r-zero" 0 failed
  Pop $2
  StrCmp $2 "caller-stack-sentinel" 0 failed
  SetErrorLevel 0
  Goto done
failed:
  SetErrorLevel 91
done:
SectionEnd
''', encoding="utf-8")
        compile_result = subprocess.run(
            [str(COMPILER), "/V2", "/INPUTCHARSET", "UTF8", str(source)],
            cwd=ROOT, capture_output=True, encoding="utf-8", errors="replace", timeout=30,
        )
        self.assertEqual(compile_result.returncode, 0, compile_result.stdout + compile_result.stderr)
        return binary, log_dir

    def _run(self, binary, expected_code=0):
        result = subprocess.run([str(binary)], cwd=binary.parent, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, expected_code, result.stderr)

    def test_multiple_errors_append_in_one_unicode_log_and_preserve_installer_state(self):
        with tempfile.TemporaryDirectory(prefix="nsis-log-", dir=ROOT / ".tmp") as value:
            binary, folder = self._compile(Path(value))
            self._run(binary)
            log = folder / "LMO-install-diagnostic.log"
            first = log.read_bytes()
            text = first.decode("utf-16")
            self.assertIn("[오류 #1] PYTHON_START_FAILED", text)
            self.assertIn("[오류 #2] CLEANUP_STOP_FAILED", text)
            self.assertLess(text.index("PYTHON_START_FAILED"), text.index("CLEANUP_STOP_FAILED"))
            self.assertIn("errors=2 first-error=PYTHON_START_FAILED", text)
            self.assertIn("after two independent errors", text)
            self.assertIn("[실행 파일 확인] path=", text)
            self.assertIn("없거나 읽을 수 없음", text)
            self._run(binary)
            appended = log.read_bytes()
            self.assertTrue(appended.startswith(first), "another attempt must not truncate earlier evidence")
            self.assertEqual(appended.count(b"\xff\xfe"), 1, "one UTF-16 BOM for the entire file")
            self.assertEqual(appended.decode("utf-16").count("=== 실행 시도 시작"), 2)

    def test_disabled_build_has_no_downloads_log_or_logging_side_effects(self):
        with tempfile.TemporaryDirectory(prefix="nsis-no-log-", dir=ROOT / ".tmp") as value:
            binary, folder = self._compile(Path(value), enabled=False)
            self._run(binary)
            self.assertFalse(folder.exists())

    def test_unwritable_log_does_not_change_error_flags_registers_or_stack(self):
        with tempfile.TemporaryDirectory(prefix="nsis-blocked-log-", dir=ROOT / ".tmp") as value:
            binary, folder = self._compile(Path(value), blocked=True)
            self._run(binary)
            self.assertEqual(folder.read_bytes(), b"user sentinel")

    def test_abort_before_installer_screen_records_the_failure_and_final_result(self):
        with tempfile.TemporaryDirectory(prefix="nsis-init-abort-", dir=ROOT / ".tmp") as value:
            binary, folder = self._compile(Path(value), init_abort=True)
            self._run(binary, expected_code=30)
            text = (folder / "LMO-install-diagnostic.log").read_text(encoding="utf-16")
            self.assertIn("[오류 #1] ENGINE_FILE_MISSING", text)
            self.assertIn("[최종 결과]", text)
            self.assertIn("exit=30 errors=1 first-error=ENGINE_FILE_MISSING", text)

    def test_real_installer_compiles_with_and_without_diagnostics_using_inert_payload(self):
        with tempfile.TemporaryDirectory(prefix="nsis-ui-compile-", dir=ROOT / ".tmp") as value:
            folder = Path(value)
            artifact = folder / "artifact"
            (artifact / "engine").mkdir(parents=True)
            (artifact / "engine/fixture.exe").write_bytes(b"MZ inert fixture, never executed")
            (artifact / "poc-manifest.json").write_text("{}", encoding="utf-8")
            helper = folder / "helper.exe"
            helper.write_bytes(b"MZ inert helper, never executed")
            for enabled in (False, True):
                with self.subTest(enabled=enabled):
                    arguments = [str(COMPILER), "/V2", "/INPUTCHARSET", "UTF8",
                                 f"/DARTIFACT_DIR={artifact}", f"/DHELPER_PATH={helper}",
                                 f"/DOUTPUT_FILE={folder / ('diagnostic.exe' if enabled else 'normal.exe')}",
                                 "/DENGINE_EXE_NAME=fixture.exe", "/DENGINE_VERSION=fixture",
                                 f"/DICON_PATH={ROOT / 'desktop-app/src-tauri/icons/icon.ico'}", "/DBRAND_NAME=LMO"]
                    if enabled:
                        arguments.append("/DINSTALLER_DIAGNOSTICS")
                    arguments.append(str(ROOT / "installer/web-local-engine.nsi"))
                    result = subprocess.run(arguments, cwd=ROOT, capture_output=True, timeout=30)
                    self.assertEqual(result.returncode, 0, result.stderr.decode("utf-8", "replace"))


if __name__ == "__main__":
    unittest.main()
