import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class WebLocalEnginePackagingTest(unittest.TestCase):
    def test_sidecar_packager_keeps_desktop_defaults_and_accepts_web_entrypoint(self) -> None:
        script = (ROOT / "scripts" / "package_backend_sidecar.ps1").read_text(encoding="utf-8")
        self.assertIn('[string]$EntryPoint = "desktop_server.py"', script)
        self.assertIn('[string]$ExecutableBaseName = "meeting-backend"', script)
        self.assertIn('$EntryPointPath', script)
        self.assertIn('--noconsole', script)
        self.assertIn('Get-PeSubsystem $OutputPath', script)
        # backend/brand.py reads the display name from the bundled copy (sys._MEIPASS/configs).
        self.assertIn('Join-Path $RepoRoot "configs\\brand.json"', script)
        self.assertIn('--add-data "${BrandConfigPath}:configs"', script)
        self.assertIn('"_internal\\configs\\brand.json"', script)

        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(ROOT / "scripts" / "package_backend_sidecar.ps1"),
                "-EntryPoint",
                "..\\outside.py",
                "-Python",
                "missing-python.exe",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        self.assertNotEqual(completed.returncode, 0)
        self.assertIn("EntryPoint must stay inside the backend directory", completed.stdout + completed.stderr)

        unsafe_destination = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(ROOT / "scripts" / "package_backend_sidecar.ps1"),
                "-DestinationDir",
                str(ROOT),
                "-Python",
                "missing-python.exe",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        self.assertNotEqual(unsafe_destination.returncode, 0)
        self.assertIn("dedicated sidecar output directory", unsafe_destination.stdout + unsafe_destination.stderr)

        unsafe_target = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(ROOT / "scripts" / "package_backend_sidecar.ps1"),
                "-TargetTriple",
                "..\\escape",
                "-Python",
                "missing-python.exe",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        self.assertNotEqual(unsafe_target.returncode, 0)
        self.assertIn("TargetTriple contains unsupported characters", unsafe_target.stdout + unsafe_target.stderr)

    def test_web_poc_builder_is_current_user_unsigned_and_excludes_user_data(self) -> None:
        script = (ROOT / "scripts" / "build_web_local_engine_poc.ps1").read_text(encoding="utf-8")
        self.assertIn('web_local_engine_server.py', script)
        self.assertIn('barorok-local-engine', script)
        self.assertIn('installScope = "current-user"', script)
        self.assertIn('bind = "127.0.0.1:17863"', script)
        self.assertIn('signed = $false', script)
        self.assertIn('distributionReady = $false', script)
        self.assertIn('engine-settings.json', script)
        self.assertIn('UTF8Encoding($false)', script)
        self.assertIn('ffmpeg.exe is required', script)
        self.assertIn('ReadToEndAsync()', script)
        for excluded in ('"models"', '"database"', '"results"', '"temp"', '"logs"'):
            self.assertIn(excluded, script)

        invalid_origin = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(ROOT / "scripts" / "build_web_local_engine_poc.ps1"),
                "-Origin",
                "http://invalid.example",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=20,
        )
        self.assertNotEqual(invalid_origin.returncode, 0)
        combined_output = invalid_origin.stdout + invalid_origin.stderr
        self.assertIn("Origin validation failed", combined_output)
        self.assertNotIn("ModuleNotFoundError", combined_output)

        ffmpeg_preflight = script.index('if (-not (Test-Path -LiteralPath $ResolvedFfmpegPath')
        ffmpeg_version_validated = script.index('$FfmpegVersionLine = $ffmpegVersionMatch.Value.Trim()')
        ffmpeg_probe_disposed = script.index('$ffmpegProbe.Dispose()')
        storage_derived = script.index('web_local_engine_storage_requirements.py')
        output_replacement = script.index('if (Test-Path -LiteralPath $ResolvedOutputDir)')
        self.assertLess(ffmpeg_preflight, output_replacement)
        self.assertLess(ffmpeg_version_validated, output_replacement)
        self.assertLess(ffmpeg_probe_disposed, output_replacement)
        self.assertLess(storage_derived, output_replacement)
        self.assertIn('Storage requirement derivation failed.', script)
        self.assertIn('storageRequirements = $StorageRequirements', script)

    def test_web_poc_builder_embeds_storage_requirements_as_exact_integers(self) -> None:
        script = (ROOT / "scripts" / "build_web_local_engine_poc.ps1").read_text(encoding="utf-8")
        start = script.index('$storageRequirementsJson = ')
        end = script.index('if (Test-Path -LiteralPath $ResolvedOutputDir)')
        snippet = script[start:end]
        harness = (
            '$ErrorActionPreference = "Stop"\n'
            f'$PythonCommand = "{sys.executable}"\n'
            f'$BackendDir = "{ROOT / "backend"}"\n'
            + snippet
            + '[ordered]@{ storageRequirements = $StorageRequirements } | ConvertTo-Json -Depth 8\n'
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            harness_path = Path(temp_dir) / "storage-harness.ps1"
            harness_path.write_text(harness, encoding="utf-8-sig")
            completed = subprocess.run(
                ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(harness_path)],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )
        self.assertEqual(completed.returncode, 0, completed.stderr)
        storage = json.loads(completed.stdout)["storageRequirements"]
        self.assertEqual(storage["models"]["requiredBytes"], 11_185_989_538)
        self.assertEqual(storage["models"]["recommendedBytes"], 12_210_001_824)
        self.assertEqual(storage["analysisTemp"]["requiredBytes"], 1_764_941_824)
        self.assertEqual(storage["analysisTemp"]["recommendedBytes"], 2_916_941_824)
        self.assertEqual(storage["results"]["requiredBytes"], 268_435_456)
        self.assertEqual(storage["results"]["recommendedBytes"], 1_073_741_824)
        self.assertEqual(set(storage), {"models", "analysisTemp", "results"})

    def test_web_server_hard_codes_loopback_and_security_profile(self) -> None:
        server = (ROOT / "backend" / "web_local_engine_server.py").read_text(encoding="utf-8")
        runtime = (ROOT / "backend" / "web_local_engine_runtime.py").read_text(encoding="utf-8")
        self.assertIn('LOCAL_ENGINE_PORT = 17863', server)
        self.assertIn('host="127.0.0.1"', server)
        self.assertNotIn('host="0.0.0.0"', server)
        self.assertIn('"LMO_RUNTIME_PROFILE": "production"', runtime)
        self.assertIn('"LMO_API_AUTH_ENFORCEMENT": "enabled"', runtime)
        self.assertIn('if frozen:', server)
        self.assertIn('Packaged local-engine paths cannot be overridden', server)
        self.assertIn('mode.add_argument("--stop"', server)
        self.assertIn('"--installer-target-preflight-json"', server)

        verifier = (ROOT / "scripts" / "verify_web_local_engine_poc.py").read_text(encoding="utf-8")
        self.assertIn('"engine/ffmpeg.exe"', verifier)
        self.assertIn('Concurrent pairing starts were not fail-closed', verifier)
        self.assertIn('The packaged --stop command', verifier)
        self.assertIn('The --stop command lost the engine-startup race', verifier)
        self.assertIn('An expired frozen pairing code was accepted', verifier)
        self.assertIn('The frozen --preflight-json command did not create a result', verifier)
        self.assertIn('The frozen preflight command overwrote an existing result', verifier)
        self.assertIn('The frozen installer target preflight did not create a result', verifier)
        self.assertIn('own/foreign fixed-port classification', verifier)
        self.assertIn('rename_directory_with_retry(artifact, relocated)', verifier)
        self.assertIn('rename_directory_with_retry(relocated, artifact)', verifier)

    def test_web_installer_builder_is_unsigned_current_user_and_compiler_gated(self) -> None:
        builder = (ROOT / "scripts" / "build_web_local_engine_installer_poc.ps1").read_text(
            encoding="utf-8"
        )
        helper_builder = (
            ROOT / "scripts" / "build_web_local_engine_installer_helper.ps1"
        ).read_text(encoding="utf-8")
        self.assertIn('Get-Command $Makensis', builder)
        self.assertIn('"/INPUTCHARSET" "UTF8"', builder)
        self.assertIn('before the home-PC build gate', builder)
        self.assertIn('build_web_local_engine_installer_helper.ps1', builder)
        self.assertIn('installScope = "current-user"', builder)
        self.assertIn('stagingMode = "same-volume-stage-atomic-rename"', builder)
        self.assertIn('signed = $false', builder)
        self.assertIn('distributionReady = $false', builder)
        self.assertIn('--manifest-only', builder)
        self.assertIn('Join-Path $RepoRoot "configs\\brand.json"', builder)
        self.assertIn('"/DBRAND_NAME=$BrandName"', builder)
        self.assertNotIn('/DBRAND_NAME=바로록', builder)
        self.assertIn('(-join [char[]](0xBC14, 0xB85C, 0xB85D))', builder)
        self.assertTrue(builder.isascii())
        compiler_gate = builder.index('$MakensisCommand = Get-Command $Makensis')
        python_gate = builder.index('& $PythonCommand -c "import PyInstaller"')
        manifest_gate = builder.index('--manifest-only')
        output_replacement = builder.index('if (Test-Path -LiteralPath $ResolvedOutputDir)')
        self.assertLess(compiler_gate, output_replacement)
        self.assertLess(python_gate, output_replacement)
        self.assertLess(manifest_gate, output_replacement)
        self.assertLess(builder.index('BrandName must be'), output_replacement)
        pattern = builder.split("if ($BrandName -notmatch '", 1)[1].split("')", 1)[0]
        cases = {
            "바로록": True,
            "Foo Bar": True,
            "A": True,
            "a" * 40: True,
            "a" * 41: False,
            "바로록\n": False,
            " lead": False,
            "trail ": False,
            'bad"name': False,
            "a$b": False,
            "a.b": False,
        }
        checked = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-Command",
                "$cases = $env:BRAND_CASES | ConvertFrom-Json; "
                "foreach ($case in $cases) { [Console]::Out.WriteLine([string]($case -match $env:BRAND_PATTERN)) }",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
            env={**os.environ, "BRAND_CASES": json.dumps(list(cases)), "BRAND_PATTERN": pattern},
        )
        self.assertEqual(checked.returncode, 0, checked.stderr)
        self.assertEqual(
            checked.stdout.split(),
            [str(accepted) for accepted in cases.values()],
        )

        for unsafe_brand in ('bad"name', 'a$b', ' lead'):
            with self.subTest(brand=unsafe_brand):
                rejected = subprocess.run(
                    [
                        "powershell",
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        str(ROOT / "scripts" / "build_web_local_engine_installer_poc.ps1"),
                        "-Makensis",
                        "missing-makensis.exe",
                        "-BrandName",
                        unsafe_brand,
                    ],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=30,
                )
                self.assertNotEqual(rejected.returncode, 0)
                self.assertIn("BrandName must be", rejected.stdout + rejected.stderr)
                self.assertNotIn("makensis.exe is required", rejected.stdout + rejected.stderr)
        self.assertIn('--onefile', helper_builder)
        self.assertIn('--noconsole', helper_builder)
        self.assertIn('web_local_engine_installer_preflight.py', helper_builder)

    def test_web_nsis_installer_preserves_data_and_uses_preflight_rollback(self) -> None:
        installer = (ROOT / "installer" / "web-local-engine.nsi").read_text(encoding="utf-8")
        self.assertIn('RequestExecutionLevel user', installer)
        self.assertIn('!ifndef BRAND_NAME\n  !error "BRAND_NAME is required"', installer)
        self.assertNotIn('SetShellVarContext', installer.split('Function ', 1)[0])
        for callback in ('.onInit', 'un.onInit'):
            initialization = installer.split(f'Function {callback}\n', 1)[1].split('FunctionEnd', 1)[0]
            self.assertIn('SetShellVarContext current', initialization)
        self.assertIn('InstallDir "$LOCALAPPDATA\\Programs\\Barorok\\LocalEngine"', installer)
        self.assertNotIn('MUI_PAGE_DIRECTORY', installer)
        self.assertIn('barorok-installer-preflight.exe', installer)
        self.assertIn('--request-generation $RequestGeneration', installer)
        self.assertIn('$PreflightExit == 10', installer)
        self.assertIn('$PreflightExit == 20', installer)
        self.assertIn('$PreflightExit == 30', installer)
        preflight_run = installer.split('Function RunInstallerPreflight\n', 1)[1].split('FunctionEnd', 1)[0]
        self.assertLess(preflight_run.index('ClearErrors'), preflight_run.index('ExecWait'))
        self.assertIn('IfErrors 0 +3\n  StrCpy $PreflightExit "launch_failed"\n  Goto done', preflight_run)
        self.assertIn('$PreflightExit == "launch_failed"', installer)
        self.assertIn('백신 프로그램이 설치 파일을 차단했는지', installer)
        self.assertLess(
            installer.index('$PreflightExit == "launch_failed"'),
            installer.index('설치 전 점검 결과를 확인하지 못했습니다'),
        )
        installer_lines = installer.splitlines()
        helper_calls = [
            index for index, line in enumerate(installer_lines)
            if line.lstrip().startswith('ExecWait')
            and ('barorok-installer-preflight.exe"' in line or '"$InstalledHelper"' in line)
            and '--result-json' not in line
        ]
        guarded_outputs = []
        for index in helper_calls:
            call = installer_lines[index]
            indent = call[: len(call) - len(call.lstrip())]
            output_var = call.rsplit(' ', 1)[1]
            self.assertEqual(installer_lines[index - 1], f'{indent}ClearErrors', call)
            self.assertEqual(installer_lines[index + 1], f'{indent}IfErrors 0 +2', call)
            self.assertEqual(installer_lines[index + 2], f'{indent}StrCpy {output_var} "launch_failed"', call)
            guarded_outputs.append((call.split("' ", 1)[0].split('" ', 1)[1].split(' ', 1)[0], output_var))
        self.assertEqual(
            guarded_outputs,
            [
                ('--probe-stopped-engine', '$1'),
                ('--cleanup-owned-tree', '$CleanupExit'),
                ('--validate-owned-tree', '$CleanupExit'),
                ('--validate-owned-tree', '$CleanupExit'),
                ('--cleanup-uninstall-tombstone', '$CleanupExit'),
                ('--probe-running-engine', '$0'),
                ('--probe-stopped-engine', '$1'),
                ('--cleanup-owned-tree', '$0'),
            ],
        )
        self.assertNotIn('StrCpy $CleanupExit 0', installer)
        self.assertNotIn('$CleanupExit <> 0', installer)
        self.assertIn('stop_local_engine_and_retry', installer)
        self.assertIn('${INSTALLER_MUTEX}', installer)
        self.assertIn('.LocalEngine-stage', installer)
        self.assertIn('.LocalEngine-rollback', installer)
        self.assertIn('${INSTALL_MARKER}', installer)
        self.assertIn('${TRANSACTION_MARKER}', installer)
        self.assertIn('--probe-running-engine --manifest', installer)
        self.assertIn('--probe-stopped-engine', installer)
        self.assertIn('--cleanup-owned-tree', installer)
        self.assertIn('--validate-owned-tree', installer)
        self.assertIn('--require-complete-tree --require-transaction-marker', installer)
        self.assertIn('WriteUninstaller "$StageDir\\Uninstall.exe"\n  IfErrors stage_failed', installer)
        self.assertIn('--cleanup-uninstall-tombstone', installer)
        self.assertIn('${UNINSTALL_MARKER}', installer)
        self.assertIn('StrCpy $CleanupManifest "$RollbackDir\\poc-manifest.json"', installer)
        self.assertIn('StrCpy $CleanupManifest "$INSTDIR\\poc-manifest.json"', installer)
        self.assertIn('IfErrors stage_failed', installer)
        self.assertIn('rollback_cleanup_warning:', installer)
        self.assertIn('$ReadinessAttempts >= 60', installer)
        self.assertIn('Call RecoverInterruptedTransaction', installer)
        self.assertLess(
            installer.index('Call RecoverInterruptedTransaction'),
            installer.index('preflight_retry:'),
        )
        self.assertIn('Goto recovery_failed', installer[installer.index('readiness_failed:'):])
        self.assertIn('ClearErrors\n  IfFileExists "$INSTDIR\\${TRANSACTION_MARKER}"', installer)
        self.assertIn('Rename "$INSTDIR" "$RollbackDir"', installer)
        self.assertIn('Rename "$RollbackDir" "$INSTDIR"', installer)
        first_stage_validation = installer.index(
            'Call ValidateCompleteStage',
            installer.index('WriteUninstaller'),
        )
        current_rename = installer.index('Rename "$INSTDIR" "$RollbackDir"')
        second_stage_validation = installer.index(
            'Call ValidateCompleteStage',
            first_stage_validation + 1,
        )
        stage_rename = installer.index('Rename "$StageDir" "$INSTDIR"')
        self.assertLess(first_stage_validation, current_rename)
        self.assertLess(current_rename, second_stage_validation)
        self.assertLess(second_stage_validation, stage_rename)
        self.assertLess(
            installer.index('SetOutPath "$PLUGINSDIR"', installer.index('WriteUninstaller')),
            installer.index('Rename "$StageDir" "$INSTDIR"'),
        )
        self.assertIn('WriteRegStr HKCU', installer)
        self.assertIn('음성 분석 시작.lnk', installer)
        self.assertIn('${BRAND_NAME} 연결.lnk', installer)
        self.assertIn('음성 분석 종료.lnk', installer)
        self.assertIn('사용자 데이터는 보존했습니다', installer)
        self.assertNotIn('RMDir /r "$INSTDIR"', installer)
        self.assertNotIn('RMDir /r "$RollbackDir"', installer)
        self.assertNotIn('RMDir /r "$StageDir"', installer)
        self.assertNotIn('RMDir /r "$LOCALAPPDATA\\Barorok\\LocalEngine"', installer)

    def test_web_nsis_installer_uses_unbranded_name_and_keeps_upgrade_identity(self) -> None:
        installer = (ROOT / "installer" / "web-local-engine.nsi").read_text(encoding="utf-8")
        self.assertIn('!define PRODUCT_NAME "음성 분석"', installer)
        self.assertIn('!define START_MENU_DIR "음성 분석"', installer)
        self.assertIn('!ifndef BRAND_NAME\n  !error "BRAND_NAME is required"\n!endif', installer)
        self.assertIn('!define LEGACY_START_MENU_DIR "바로록 로컬 엔진"', installer)
        # Upgrade identity stays unchanged so earlier installs are found and replaced.
        self.assertIn(
            '!define PRODUCT_KEY "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\BarorokLocalEngine"',
            installer,
        )
        self.assertIn('InstallDir "$LOCALAPPDATA\\Programs\\Barorok\\LocalEngine"', installer)
        self.assertIn('StrCpy $EngineExe "$INSTDIR\\engine\\${ENGINE_EXE_NAME}"', installer)
        self.assertIn('!define INSTALLER_MUTEX "Local\\BarorokLocalEngineInstaller"', installer)

        # The brand is never hard-coded; only historical file names of old releases keep it.
        brand_lines = [line.strip() for line in installer.splitlines() if '바로록' in line]
        self.assertEqual(
            brand_lines,
            [
                '!define LEGACY_START_MENU_DIR "바로록 로컬 엔진"',
                'Delete "$SMPROGRAMS\\${LEGACY_START_MENU_DIR}\\바로록 연결.lnk"',
            ],
        )
        self.assertIn('WriteRegStr HKCU "${PRODUCT_KEY}" "Publisher" "${BRAND_NAME}"', installer)
        self.assertNotIn('"Publisher" "Barorok"', installer)

        message_lines = [line for line in installer.splitlines() if 'MessageBox' in line]
        self.assertEqual([line for line in message_lines if '엔진' in line], [])
        self.assertTrue(any('음성 분석 프로그램의 연결 포트(17863)를 이미 쓰고 있습니다' in line for line in message_lines))
        self.assertTrue(any('실행 중인 음성 분석 프로그램을 종료하지 못했습니다' in line for line in message_lines))
        self.assertTrue(any('이전 버전 백업 파일을 정리하지 못했습니다' in line for line in message_lines))
        self.assertTrue(any('이 설치 프로그램이 만들지 않은 파일' in line for line in message_lines))
        old_name_lines = [line.strip() for line in installer.splitlines() if '로컬 엔진' in line]
        self.assertEqual(
            old_name_lines,
            [
                '!define LEGACY_START_MENU_DIR "바로록 로컬 엔진"',
                'Delete "$SMPROGRAMS\\${LEGACY_START_MENU_DIR}\\로컬 엔진 시작.lnk"',
                'Delete "$SMPROGRAMS\\${LEGACY_START_MENU_DIR}\\로컬 엔진 종료.lnk"',
            ],
        )

        legacy_macro = installer.split('!macro RemoveLegacyStartMenuEntries\n', 1)[1].split('!macroend', 1)[0]
        self.assertIn('Delete "$SMPROGRAMS\\${LEGACY_START_MENU_DIR}\\제거.lnk"', legacy_macro)
        self.assertIn('RMDir "$SMPROGRAMS\\${LEGACY_START_MENU_DIR}"', legacy_macro)
        self.assertNotIn('RMDir /r', legacy_macro)

        install_shortcuts = installer.split('\nshortcuts:\n', 1)[1].split('Goto install_done', 1)[0]
        self.assertLess(
            install_shortcuts.index('!insertmacro RemoveLegacyStartMenuEntries'),
            install_shortcuts.index('CreateDirectory "$SMPROGRAMS\\${START_MENU_DIR}"'),
        )
        # The recorded connect shortcut (maybe from an earlier brand) is removed before
        # the current one is made, and the new name is recorded for the next run.
        recorded_macro = installer.split('!macro RemoveRecordedConnectShortcut\n', 1)[1].split('!macroend', 1)[0]
        self.assertIn('ReadRegStr $2 HKCU "${PRODUCT_KEY}" "ConnectShortcut"', recorded_macro)
        self.assertIn('StrCpy $3 $2 "" -7\n  ${If} $3 == " 연결.lnk"', recorded_macro)
        self.assertIn('Delete "$SMPROGRAMS\\${START_MENU_DIR}\\$2"', recorded_macro)
        self.assertNotIn('* 연결.lnk', installer)
        self.assertLess(
            install_shortcuts.index('!insertmacro RemoveRecordedConnectShortcut'),
            install_shortcuts.index('CreateShortcut "$SMPROGRAMS\\${START_MENU_DIR}\\${BRAND_NAME} 연결.lnk"'),
        )
        self.assertIn(
            'WriteRegStr HKCU "${PRODUCT_KEY}" "ConnectShortcut" "${BRAND_NAME} 연결.lnk"',
            install_shortcuts,
        )
        self.assertIn(
            'CreateShortcut "$SMPROGRAMS\\${START_MENU_DIR}\\음성 분석 시작.lnk" "$EngineExe"',
            install_shortcuts,
        )
        self.assertIn(
            'CreateShortcut "$SMPROGRAMS\\${START_MENU_DIR}\\음성 분석 종료.lnk" "$EngineExe" "--stop"',
            install_shortcuts,
        )
        self.assertIn('WriteRegStr HKCU "${PRODUCT_KEY}" "DisplayName" "${PRODUCT_NAME}"', install_shortcuts)
        uninstall = installer.split('Section "Uninstall"\n', 1)[1].split('SectionEnd', 1)[0]
        self.assertIn('Delete "$SMPROGRAMS\\${START_MENU_DIR}\\음성 분석 시작.lnk"', uninstall)
        self.assertLess(
            uninstall.index('!insertmacro RemoveRecordedConnectShortcut'),
            uninstall.index('DeleteRegKey HKCU "${PRODUCT_KEY}"'),
        )
        self.assertIn('Delete "$SMPROGRAMS\\${START_MENU_DIR}\\${BRAND_NAME} 연결.lnk"', uninstall)
        self.assertIn('Delete "$SMPROGRAMS\\${START_MENU_DIR}\\음성 분석 종료.lnk"', uninstall)
        self.assertIn('!insertmacro RemoveLegacyStartMenuEntries', uninstall)
        self.assertNotIn('${START_MENU_DIR}\\로컬 엔진', installer)

    def test_web_nsis_low_space_question_names_space_to_free(self) -> None:
        installer = (ROOT / "installer" / "web-local-engine.nsi").read_text(encoding="utf-8")
        self.assertNotIn('권장값', installer)
        preflight_run = installer.split('Function RunInstallerPreflight\n', 1)[1].split('FunctionEnd', 1)[0]
        self.assertIn(
            'ReadINIStr $PreflightFreeSpaceGb "$PreflightDecision" "preflight" "free_space_gb"',
            preflight_run,
        )
        self.assertIn(
            'ReadINIStr $PreflightFreeSpaceDrive "$PreflightDecision" "preflight" "free_space_drive"',
            preflight_run,
        )
        self.assertLess(preflight_run.index('StrCpy $PreflightFreeSpaceGb ""'), preflight_run.index('IfErrors 0 +3'))
        confirm_branch = installer.split('${ElseIf} $PreflightExit == 10\n', 1)[1].split(
            '${ElseIf} $PreflightExit == 20', 1
        )[0]
        self.assertLess(
            confirm_branch.index('IfSilent preflight_ready'),
            confirm_branch.index('${If} $PreflightAction == "free_space_and_retry"'),
        )
        self.assertIn(
            '$PreflightFreeSpaceDrive 드라이브에서 약 $PreflightFreeSpaceGb GB를 비워 주세요.',
            confirm_branch,
        )
        self.assertIn('음성 분석 프로그램이 쓸 모델과 회의 분석 작업 파일을 저장할 공간이 부족합니다', confirm_branch)
        self.assertIn('저장 공간 확인이나 임시 파일 정리 중 일부를 마치지 못했습니다', confirm_branch)
        self.assertEqual(confirm_branch.count('IDYES preflight_ready'), 3)
        self.assertIn('SetErrorLevel 10\n    Abort', confirm_branch)


if __name__ == "__main__":
    unittest.main()
