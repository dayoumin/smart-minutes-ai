import subprocess
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
        output_replacement = script.index('if (Test-Path -LiteralPath $ResolvedOutputDir)')
        self.assertLess(ffmpeg_preflight, output_replacement)
        self.assertLess(ffmpeg_version_validated, output_replacement)
        self.assertLess(ffmpeg_probe_disposed, output_replacement)

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

        verifier = (ROOT / "scripts" / "verify_web_local_engine_poc.py").read_text(encoding="utf-8")
        self.assertIn('"engine/ffmpeg.exe"', verifier)
        self.assertIn('Concurrent pairing starts were not fail-closed', verifier)
        self.assertIn('The packaged --stop command', verifier)
        self.assertIn('The --stop command lost the engine-startup race', verifier)
        self.assertIn('An expired frozen pairing code was accepted', verifier)
        self.assertIn('artifact.rename(relocated)', verifier)


if __name__ == "__main__":
    unittest.main()
