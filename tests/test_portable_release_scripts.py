import hashlib
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL_LAYOUT_PATH = ROOT / "scripts" / "portable_model_layout.json"


def _run_powershell(command: str, timeout: int = 60) -> subprocess.CompletedProcess[str]:
    with tempfile.NamedTemporaryFile("w", suffix=".ps1", encoding="utf-8", delete=False) as script_file:
        script_file.write(command)
        script_path = Path(script_file.name)
    try:
        return subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", str(script_path)],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=timeout,
        )
    finally:
        script_path.unlink(missing_ok=True)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def _release_function(name: str) -> str:
    source = (ROOT / "scripts/release_portable.ps1").read_text(encoding="utf-8")
    match = re.search(
        rf"^function {re.escape(name)}\b[\s\S]+?(?=^function |^\$DeployPath =|\Z)",
        source,
        re.MULTILINE,
    )
    if match is None:
        raise AssertionError(f"Could not find release helper: {name}")
    return match.group(0)


class PortableReleaseScriptTest(unittest.TestCase):
    def test_root_build_script_targets_user_ready_portable_release(self):
        root_package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        desktop_package = json.loads((ROOT / "desktop-app" / "package.json").read_text(encoding="utf-8"))

        self.assertEqual(
            root_package["scripts"]["build"],
            "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\build_user_release.ps1",
        )
        self.assertEqual(
            root_package["scripts"]["verify:portable"],
            "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\verify_portable.ps1 -PortableDir releases\\lmo_audio",
        )
        self.assertEqual(
            root_package["scripts"]["package:handoff"],
            "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\create_handoff_package.ps1",
        )
        self.assertEqual(desktop_package["scripts"]["build"], "vite build")
        self.assertEqual(desktop_package["scripts"]["build:web"], "vite build")
        self.assertIn("..\\scripts\\build_user_release.ps1", desktop_package["scripts"]["build:portable"])

    def test_root_release_check_scripts_define_tiered_gates(self):
        root_package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        scripts = root_package["scripts"]

        self.assertEqual(
            scripts["check"],
            "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\run_release_checks.ps1 -Tier quick",
        )
        self.assertEqual(
            scripts["check:quick"],
            "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\run_release_checks.ps1 -Tier quick",
        )
        self.assertEqual(
            scripts["check:release"],
            "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\run_release_checks.ps1 -Tier release",
        )
        self.assertEqual(
            scripts["check:portable"],
            "powershell -NoProfile -ExecutionPolicy Bypass -File scripts\\run_release_checks.ps1 -Tier portable",
        )

        check_script = (ROOT / "scripts" / "run_release_checks.ps1").read_text(encoding="utf-8")
        self.assertIn('[ValidateSet("quick", "release", "portable")]', check_script)
        self.assertIn('"backend.test_api"', check_script)
        self.assertIn('"test:analysis-stop-flow"', check_script)
        self.assertIn("verify_portable.ps1", check_script)
        self.assertIn("PYTHONPATH", check_script)
        self.assertIn("IncludeModelSmoke", check_script)

    def test_project_local_release_build_skill_is_not_global(self):
        skill_path = ROOT / ".agents" / "skills" / "lmo-audio-release-build" / "SKILL.md"
        self.assertTrue(skill_path.exists())
        skill = skill_path.read_text(encoding="utf-8")
        self.assertIn("Use this skill only inside", skill)
        self.assertIn("corepack pnpm build", skill)
        self.assertIn("git -c core.excludesFile= status --short --branch --untracked-files=all", skill)
        self.assertNotIn("C:\\Users\\User\\.codex\\skills", skill)

    def test_release_wrapper_passes_named_switches(self):
        wrapper = (ROOT / "scripts" / "build_user_release.ps1").read_text(encoding="utf-8")
        self.assertIn('-Python $Python', wrapper)
        self.assertIn('-ClearWebViewCache:(!$NoClearWebViewCache)', wrapper)
        self.assertIn('-SkipSidecarBuild:$SkipSidecarBuild', wrapper)
        self.assertIn('-SkipTauriBuild:$SkipTauriBuild', wrapper)
        self.assertNotIn('@releaseArgs', wrapper)

    def test_packager_rejects_missing_required_model_markers(self):
        script = (ROOT / "scripts" / "package_desktop_portable.ps1").read_text(encoding="utf-8")
        match = re.search(
            r"function Test-RequiredMarkers[\s\S]+?(?=\r?\nforeach \(\$model)",
            script,
        )
        self.assertIsNotNone(match, "Could not find portable model helper functions")
        helpers = match.group(0)

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            model_dir = temp_path / "model"
            model_dir.mkdir()
            (model_dir / "config.json").write_text("{}", encoding="utf-8")

            command = f"""
$ErrorActionPreference = "Stop"
{helpers}
$modelDir = "{model_dir}"
try {{
    Test-RequiredMarkers $modelDir @("config.json", "missing.bin") "sample"
    throw "Expected missing marker failure"
}} catch {{
    if ($_.Exception.Message -notlike "*Missing: missing.bin*") {{
        throw
    }}
}}
Test-RequiredMarkers $modelDir @("config.json") "sample"
"""
            completed = _run_powershell(command)
            self.assertEqual(
                completed.returncode,
                0,
                completed.stdout + completed.stderr,
            )

    def test_model_marker_contract_is_defined_once(self):
        layout = json.loads(MODEL_LAYOUT_PATH.read_text(encoding="utf-8"))
        expected_paths = {
            "models\\faster-whisper-large-v3\\model.bin",
            "models\\faster-whisper-large-v3\\tokenizer.json",
            "models\\faster-whisper-large-v3\\config.json",
            "models\\speaker-diarization-community-1\\config.yaml",
            "models\\speaker-diarization-community-1\\embedding\\pytorch_model.bin",
            "models\\speaker-diarization-community-1\\segmentation\\pytorch_model.bin",
            "models\\speaker-diarization-community-1\\plda\\plda.npz",
        }
        actual_paths = {
            "\\".join(["models", model["portableDir"], marker.replace("/", "\\")])
            for model in layout["models"]
            for marker in model["requiredMarkers"]
        }
        self.assertEqual(expected_paths, actual_paths)

        for model in layout["models"]:
            self.assertTrue(model["key"])
            self.assertTrue(model["label"])
            self.assertTrue(model["source"])
            self.assertTrue(model["portableDir"])
            self.assertTrue(model["requiredMarkers"])

        release_script = (ROOT / "scripts" / "release_portable.ps1").read_text(encoding="utf-8")
        verify_script = (ROOT / "scripts" / "verify_portable.ps1").read_text(encoding="utf-8")
        package_script = (ROOT / "scripts" / "package_desktop_portable.ps1").read_text(encoding="utf-8")

        for script in (release_script, verify_script, package_script):
            self.assertIn("portable_model_layout.json", script)

    def test_handoff_package_excludes_only_default_stt_model(self):
        package_name = f"test_no_whisper_{id(self)}"
        handoff_root = ROOT / "releases" / "handoff"
        package_zip = handoff_root / f"{package_name}.zip"
        staging_root = handoff_root / ".staging" / package_name

        with tempfile.TemporaryDirectory() as temp_dir:
            portable = Path(temp_dir) / "lmo_audio"
            (portable / "backend").mkdir(parents=True)
            (portable / "binaries").mkdir()
            (portable / "runtime" / "ollama").mkdir(parents=True)
            (portable / "models" / "faster-whisper-large-v3").mkdir(parents=True)
            (portable / "models" / "speaker-diarization-community-1" / "embedding").mkdir(parents=True)
            (portable / "models" / "speaker-diarization-community-1" / "segmentation").mkdir(parents=True)
            (portable / "models" / "speaker-diarization-community-1" / "plda").mkdir(parents=True)

            (portable / "lmo_audio.exe").write_text("app", encoding="utf-8")
            (portable / "START_HERE.txt").write_text("full package", encoding="utf-8")
            (portable / "backend" / "main.py").write_text("backend", encoding="utf-8")
            (portable / "backend" / "config.json").write_text('{"private":"D:/private-meetings"}', encoding="utf-8")
            private_paths = ("personal-backup.json", "logs/private.log", "backend/database/records",
                             "backend/history.db", "backend/history.db-wal", "backend/history.sqlite3-shm",
                             "backend/outputs/result.json", "backend/temp/resume.json", "backend/logs/private.log")
            for relative in private_paths:
                private_path = portable / relative
                private_path.parent.mkdir(parents=True, exist_ok=True)
                private_path.write_text("private fixture", encoding="utf-8")
            (portable / "binaries" / "meeting-backend-x86_64-pc-windows-msvc.exe").write_text("sidecar", encoding="utf-8")
            (portable / "runtime" / "ollama" / "README.txt").write_text("placeholder", encoding="utf-8")
            (portable / "runtime" / "ollama" / "ollama.exe").write_text("large runtime", encoding="utf-8")
            (portable / "runtime" / "ollama" / "ollama.dll").write_text("large runtime dependency", encoding="utf-8")
            for marker in ("model.bin", "tokenizer.json", "config.json"):
                (portable / "models" / "faster-whisper-large-v3" / marker).write_text(marker, encoding="utf-8")
            (portable / "models" / "speaker-diarization-community-1" / "config.yaml").write_text("config", encoding="utf-8")
            (portable / "models" / "speaker-diarization-community-1" / "embedding" / "pytorch_model.bin").write_text("embedding", encoding="utf-8")
            (portable / "models" / "speaker-diarization-community-1" / "segmentation" / "pytorch_model.bin").write_text("segmentation", encoding="utf-8")
            (portable / "models" / "speaker-diarization-community-1" / "plda" / "plda.npz").write_text("plda", encoding="utf-8")

            model_markers = []
            for relative in (
                "models\\faster-whisper-large-v3\\model.bin",
                "models\\faster-whisper-large-v3\\tokenizer.json",
                "models\\faster-whisper-large-v3\\config.json",
                "models\\speaker-diarization-community-1\\config.yaml",
                "models\\speaker-diarization-community-1\\embedding\\pytorch_model.bin",
                "models\\speaker-diarization-community-1\\segmentation\\pytorch_model.bin",
                "models\\speaker-diarization-community-1\\plda\\plda.npz",
            ):
                path = portable / relative
                model_markers.append({"path": relative, "exists": True, "bytes": path.stat().st_size})

            release_manifest = {
                "app": "lmo_audio",
                "commit": "abcdef1234567890",
                "dirty": False,
                "files": {
                    "backendConfig": {
                        "path": "backend\\config.json",
                        "sha256": _sha256(portable / "backend" / "config.json"),
                    },
                    "startHere": {
                        "path": "START_HERE.txt",
                        "sha256": _sha256(portable / "START_HERE.txt"),
                    },
                },
                "modelMarkers": model_markers,
            }
            (portable / "release-manifest.json").write_text(json.dumps(release_manifest), encoding="utf-8")

            try:
                completed = subprocess.run(
                    [
                        "powershell",
                        "-NoProfile",
                        "-ExecutionPolicy",
                        "Bypass",
                        "-File",
                        str(ROOT / "scripts" / "create_handoff_package.ps1"),
                        "-PortableDir",
                        str(portable),
                        "-PackageName",
                        package_name,
                        "-AllowStale",
                        "-Force",
                    ],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=60,
                )
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertTrue(package_zip.exists())

                with zipfile.ZipFile(package_zip) as archive:
                    names = set(archive.namelist())
                    for relative in private_paths:
                        self.assertNotIn(f"lmo_audio/{relative}", names)
                    packaged_config = archive.read("lmo_audio/backend/config.json").decode("utf-8")
                    committed_config = subprocess.run(
                        ["git", "-c", "core.excludesFile=", "show", "HEAD:backend/config.json"],
                        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", check=True,
                    ).stdout
                    self.assertEqual(json.loads(packaged_config), json.loads(committed_config))
                    self.assertNotIn("private-meetings", packaged_config)
                    self.assertIn("용량과 속도를 우선할 때 사용합니다.", packaged_config)
                    self.assertIn(
                        "lmo_audio/models/speaker-diarization-community-1/config.yaml",
                        names,
                    )
                    self.assertIn(
                        "lmo_audio/models/speaker-diarization-community-1/embedding/pytorch_model.bin",
                        names,
                    )
                    self.assertNotIn(
                        "lmo_audio/models/faster-whisper-large-v3/model.bin",
                        names,
                    )
                    self.assertIn("lmo_audio/models/README.txt", names)
                    self.assertIn("lmo_audio/START_HERE.txt", names)
                    start_here = archive.read("lmo_audio/START_HERE.txt").decode("utf-8")
                    self.assertIn("대화록 작성 모델은 이 전달 파일에 포함되어 있지 않습니다.", start_here)
                    self.assertIn("요약 프로그램", start_here)
                    self.assertNotIn("Ollama", start_here)
                    models_readme_bytes = archive.read("lmo_audio/models/README.txt")
                    self.assertFalse(models_readme_bytes.startswith(b"\xef\xbb\xbf"))
                    models_readme = models_readme_bytes.decode("utf-8")
                    self.assertIn("포함되지 않은 모델은 대화록 작성에 필요합니다.", models_readme)
                    self.assertIn("lmo_audio/runtime/ollama/README.txt", names)
                    self.assertNotIn("lmo_audio/runtime/ollama/ollama.exe", names)
                    self.assertNotIn("lmo_audio/runtime/ollama/ollama.dll", names)
                    manifest = json.loads(archive.read("lmo_audio/release-manifest.json").decode("utf-8-sig"))
                    self.assertEqual(manifest["files"]["backendConfig"]["sha256"],
                                     hashlib.sha256(archive.read("lmo_audio/backend/config.json")).hexdigest())
                    self.assertEqual(manifest["handoff"]["packageFormat"], "lmo-audio-slim-handoff-v1")
                    payload_by_path = {entry["path"]: entry for entry in manifest["portablePayloadFiles"]}
                    self.assertEqual(
                        payload_by_path["START_HERE.txt"]["sha256"],
                        hashlib.sha256(archive.read("lmo_audio/START_HERE.txt")).hexdigest(),
                    )
                    marker_by_path = {marker["path"]: marker for marker in manifest["modelMarkers"]}
                    self.assertFalse(marker_by_path["models\\faster-whisper-large-v3\\model.bin"]["exists"])
                    self.assertTrue(marker_by_path["models\\faster-whisper-large-v3\\model.bin"]["excludedFromHandoff"])
                    self.assertTrue(marker_by_path["models\\speaker-diarization-community-1\\config.yaml"]["exists"])
            finally:
                package_zip.unlink(missing_ok=True)
                shutil.rmtree(staging_root, ignore_errors=True)

    def test_handoff_package_rejects_unsafe_package_name(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = Path(temp_dir) / "lmo_audio"
            (portable / "backend").mkdir(parents=True)
            (portable / "binaries").mkdir()
            (portable / "models").mkdir()
            (portable / "release-manifest.json").write_text(
                json.dumps({"app": "lmo_audio", "commit": "abcdef1", "dirty": False, "files": {}, "modelMarkers": []}),
                encoding="utf-8",
            )

            completed = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(ROOT / "scripts" / "create_handoff_package.ps1"),
                    "-PortableDir",
                    str(portable),
                    "-PackageName",
                    "..\\escape",
                    "-Force",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )

        self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("PackageName contains invalid path characters", completed.stdout + completed.stderr)

    def test_handoff_package_rejects_stale_release_manifest(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = Path(temp_dir) / "lmo_audio"
            (portable / "backend").mkdir(parents=True)
            (portable / "binaries").mkdir()
            (portable / "models").mkdir()
            (portable / "release-manifest.json").write_text(
                json.dumps({"app": "lmo_audio", "commit": "abcdef1", "dirty": False, "files": {}, "modelMarkers": []}),
                encoding="utf-8",
            )

            completed = subprocess.run(
                [
                    "powershell",
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(ROOT / "scripts" / "create_handoff_package.ps1"),
                    "-PortableDir",
                    str(portable),
                    "-PackageName",
                    f"test_stale_{id(self)}",
                    "-Force",
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=60,
            )

        self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("does not match current HEAD", completed.stdout + completed.stderr)

    def test_release_script_rejects_unsafe_deploy_paths(self):
        script = (ROOT / "scripts" / "release_portable.ps1").read_text(encoding="utf-8")
        match = re.search(
            r"function Resolve-InRepoPath[\s\S]+?(?=\r?\nfunction Stop-AppProcesses)",
            script,
        )
        self.assertIsNotNone(match, "Could not find release path helper functions")
        helpers = match.group(0)

        command = f"""
$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path "{ROOT}"
$PortableFolderName = "lmo_audio"
{helpers}
$safe = Assert-SafeDeployPath (Join-Path (Join-Path $RepoRoot "releases") "lmo_audio")
if (-not $safe.EndsWith("releases\\lmo_audio")) {{
    throw "Expected releases\\lmo_audio deploy path"
}}
$safeTrailing = Assert-SafeDeployPath ((Join-Path (Join-Path $RepoRoot "releases") "lmo_audio") + "\\")
if (-not $safeTrailing.EndsWith("releases\\lmo_audio")) {{
    throw "Expected trailing slash deploy path to normalize"
}}
foreach ($unsafe in @($RepoRoot.Path, (Join-Path $RepoRoot "lmo_audio"), (Join-Path $RepoRoot "desktop-app"), (Join-Path $RepoRoot "Wrong App"))) {{
    try {{
        Assert-SafeDeployPath $unsafe | Out-Null
        throw "Expected unsafe deploy path failure for $unsafe"
    }} catch {{
        if ($_.Exception.Message -notlike "*Unsafe DeployDir*") {{
            throw
        }}
    }}
}}
"""
        completed = _run_powershell(command)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def test_release_manifest_helpers_do_not_depend_on_global_git_or_get_file_hash(self):
        script = (ROOT / "scripts" / "release_portable.ps1").read_text(encoding="utf-8")
        self.assertIn('"backend\\.venv-desktop\\Scripts\\python.exe"', script)
        self.assertIn('"-c", "core.excludesFile="', script)
        self.assertIn("status --short --untracked-files=all", script)
        self.assertIn("Unable to read git metadata for release manifest", script)
        self.assertIn("START_HERE.txt", script)
        self.assertIn("startHere", script)
        self.assertIn("[System.Security.Cryptography.SHA256]::Create()", script)

        match = re.search(
            r"function Get-FileHashValue[\s\S]+?(?=\r?\nfunction Get-GitValue)",
            script,
        )
        self.assertIsNotNone(match, "Could not find release hash helper")
        hash_helper = match.group(0)

        with tempfile.TemporaryDirectory() as temp_dir:
            sample = Path(temp_dir) / "sample.txt"
            sample.write_text("hash me", encoding="utf-8")
            expected = hashlib.sha256(sample.read_bytes()).hexdigest().upper()
            command = f"""
$ErrorActionPreference = "Stop"
function Get-Command {{
    param([string]$Name)
    if ($Name -eq "Get-FileHash") {{
        throw "simulate missing Get-FileHash"
    }}
    Microsoft.PowerShell.Core\\Get-Command @PSBoundParameters
}}
{hash_helper}
$actual = Get-FileHashValue "{sample}"
if ($actual -ne "{expected}") {{
    throw "Expected {expected}, got $actual"
}}
"""
            completed = _run_powershell(command)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def test_release_manifest_git_failures_are_not_treated_as_clean(self):
        script = (ROOT / "scripts" / "release_portable.ps1").read_text(encoding="utf-8")
        match = re.search(
            r"function Get-GitValue[\s\S]+?(?=\r?\nfunction Get-FrontendAssets)",
            script,
        )
        self.assertIsNotNone(match, "Could not find release git helper")
        git_helper = match.group(0)

        command = f"""
$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path "{ROOT}"
function git {{
    $global:LASTEXITCODE = 128
    return $null
}}
{git_helper}
try {{
    Get-GitValue "status --short --untracked-files=all" | Out-Null
    throw "Expected git metadata failure"
}} catch {{
    if ($_.Exception.Message -notlike "*Unable to read git metadata for release manifest*") {{
        throw
    }}
}}
"""
        completed = _run_powershell(command)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def test_start_backend_sidecar_fallback_environment_is_inherited(self):
        script = (ROOT / "scripts" / "verify_portable.ps1").read_text(encoding="utf-8")
        match = re.search(
            r"function Start-BackendSidecar[\s\S]+?(?=\r?\nfunction Test-BackendHealth)",
            script,
        )
        self.assertIsNotNone(match, "Could not find sidecar start helper")
        start_helper = match.group(0)

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            output = temp_path / "env.txt"
            command = f"""
$ErrorActionPreference = "Stop"
{start_helper}
$exe = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
$out = "{output}"
$args = "-NoProfile -Command `"Set-Content -Path '$out' -Value (([Environment]::GetEnvironmentVariable('PORT','Process')) + '|' + ([Environment]::GetEnvironmentVariable('MEETING_AI_BACKEND_DIR','Process')) + '|' + ([Environment]::GetEnvironmentVariable('ANALYSIS_MODE','Process'))) -Encoding UTF8`""
$process = Start-BackendSidecar $exe "{temp_path}" 18777 $args
$process.WaitForExit(15000) | Out-Null
if (-not (Test-Path -LiteralPath $out)) {{
    throw "Expected child process to write inherited environment"
}}
$actual = Get-Content -LiteralPath $out -Raw
if ($actual -notlike "18777|{temp_path}|real*") {{
    throw "Unexpected inherited env: $actual"
}}
"""
            completed = _run_powershell(command)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def test_verify_portable_has_handoff_mode_for_slim_packages(self):
        script = (ROOT / "scripts" / "verify_portable.ps1").read_text(encoding="utf-8")

        self.assertIn("[switch]$Handoff", script)
        self.assertIn("[string]$_.role -eq \"diarization\"", script)
        self.assertIn("[string]$_.role -eq \"default_stt\"", script)
        self.assertIn("excluded from handoff", script)
        self.assertIn("required handoff models ready", script)

    def test_release_and_diagnose_scripts_fallback_when_cim_is_unavailable(self):
        release_script = (ROOT / "scripts" / "release_portable.ps1").read_text(encoding="utf-8")
        diagnose_script = (ROOT / "scripts" / "diagnose_portable.ps1").read_text(encoding="utf-8")

        self.assertIn("Could not inspect Win32_Process command lines", release_script)
        self.assertIn("Get-Process -ErrorAction SilentlyContinue", release_script)
        self.assertIn("Could not inspect Win32_Process command lines", diagnose_script)
        self.assertIn("Get-Process -ErrorAction SilentlyContinue", diagnose_script)

    def test_verify_script_resolves_default_from_repo_root_and_rejects_broad_paths(self):
        script = (ROOT / "scripts" / "verify_portable.ps1").read_text(encoding="utf-8")
        match = re.search(
            r"function Normalize-FullPath[\s\S]+?(?=\r?\nfunction Add-Result)",
            script,
        )
        self.assertIsNotNone(match, "Could not find verify path helper functions")
        helpers = match.group(0)

        command = f"""
$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path "{ROOT}"
{helpers}
Set-Location $env:TEMP
$resolved = Resolve-InRepoPath "releases\\lmo_audio"
$expected = Normalize-FullPath (Join-Path $RepoRoot "releases\\lmo_audio")
if (-not $resolved.Equals($expected, [System.StringComparison]::OrdinalIgnoreCase)) {{
    throw "Expected default portable path to resolve from repo root, got $resolved"
}}
$safe = Assert-SafePortablePath $resolved
if (-not $safe.EndsWith("releases\\lmo_audio")) {{
    throw "Expected safe portable path"
}}
foreach ($unsafe in @($RepoRoot.Path, (Join-Path $RepoRoot "releases"), (Join-Path $RepoRoot "desktop-app"))) {{
    try {{
        Assert-SafePortablePath $unsafe | Out-Null
        throw "Expected unsafe portable path failure for $unsafe"
    }} catch {{
        if ($_.Exception.Message -notlike "*Unsafe PortableDir*") {{
            throw
        }}
    }}
}}
"""
        completed = _run_powershell(command)
        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

    def test_verify_portable_preserves_config_and_manifest(self):
        # Never launch a real user's installed sidecar from this test module.
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = Path(temp_dir) / "lmo_audio"
            fixture = {
                "backend/config.json": '{"paths":{"output_dir":"./outputs","temp_dir":"./temp"}}',
                "backend/main.py": "packaged code",
                "backend/ffmpeg.exe": "fixture", "backend/outputs/meeting.json": "meeting",
                "backend/temp/resume.json": "resume", "backend/logs/private.log": "private",
                "logs/analysis.log": "existing log", "personal-backup.json": "backup",
            }
            for relative, text in fixture.items():
                target = portable / relative
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text(text, encoding="utf-8")
            # Minimal headers are only for structural checks, never executable.
            pe = bytearray(4096)
            pe[0x3c:0x40] = (128).to_bytes(4, "little")
            pe[128 + 24 + 68:128 + 24 + 70] = (2).to_bytes(2, "little")
            for relative in ("lmo_audio.exe", "binaries/meeting-backend-x86_64-pc-windows-msvc.exe"):
                path = portable / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(pe)
            (portable / "runtime/ollama").mkdir(parents=True)
            layout = json.loads(MODEL_LAYOUT_PATH.read_text(encoding="utf-8"))
            for model in layout["models"]:
                for marker in model["requiredMarkers"]:
                    path = portable / "models" / model["portableDir"] / marker
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text("model fixture", encoding="utf-8")
            manifest = {"dirty": True, "modelMarkers": [], "files": {"backendConfig": {
                "path": "backend/config.json", "sha256": _sha256(portable / "backend/config.json"),
            }, "backendMain": {"path": "backend/main.py", "sha256": _sha256(portable / "backend/main.py")}}}
            (portable / "release-manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            # A valid user setting change is intentional mutable state; its old
            # release hash must not invalidate installed integrity checks.
            (portable / "backend/config.json").write_text('{"paths":{"output_dir":"./outputs","temp_dir":"./temp"},"user_setting":true}', encoding="utf-8")
            before = {path.relative_to(portable).as_posix(): _sha256(path) for path in portable.rglob("*") if path.is_file()}
            for mode, expected_code in (("-ExistingInstallation", 0), ("", 1)):
                with self.subTest(mode=mode):
                    command = f"& '{ROOT / 'scripts/verify_portable.ps1'}' -PortableDir '{portable}' -AllowDirty {mode}"
                    result = _run_powershell(command)
                    self.assertEqual(result.returncode, expected_code, result.stdout + result.stderr)
                    self.assertIn("runtime smoke deferred" if mode else "preflight failed", result.stdout + result.stderr)
                    after = {path.relative_to(portable).as_posix(): _sha256(path) for path in portable.rglob("*") if path.is_file()}
                    self.assertEqual(before, after)
            command = f"& '{ROOT / 'scripts/verify_portable.ps1'}' -PortableDir '{portable}' -AllowDirty -ExistingInstallation"
            for relative, modified in (("backend/main.py", "tampered code"), ("backend/config.json", "invalid json")):
                with self.subTest(invalid=relative):
                    path = portable / relative
                    original = path.read_bytes()
                    path.write_text(modified, encoding="utf-8")
                    result = _run_powershell(command)
                    self.assertEqual(result.returncode, 1, result.stdout + result.stderr)
                    self.assertIn("integrity verification failed", result.stdout + result.stderr)
                    self.assertEqual(path.read_text(encoding="utf-8"), modified)
                    path.write_bytes(original)

    def test_verifier_cleanup_never_deletes_nonempty_user_data(self):
        script = (ROOT / "scripts/verify_portable.ps1").read_text(encoding="utf-8")
        cleanup = re.search(r"function Remove-PortableRuntimeArtifacts[\s\S]+?(?=\r?\nfunction Assert-NoPortableProcesses)", script)
        self.assertIsNotNone(cleanup)
        self.assertNotIn("Stop-PortableProcesses", script)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            for relative in ("logs/analysis.log", "backend/outputs/meeting.json", "backend/temp/resume.json"):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("existing private data", encoding="utf-8")
            before = {path: _sha256(path) for path in root.rglob("*") if path.is_file()}
            result = _run_powershell(f'''
$ErrorActionPreference = "Stop"
function Normalize-FullPath([string]$Path) {{ return [System.IO.Path]::GetFullPath($Path).TrimEnd('\\', '/') }}
{cleanup.group(0)}
Remove-PortableRuntimeArtifacts '{root}' | Out-Null
''')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            self.assertEqual(before, {path: _sha256(path) for path in root.rglob("*") if path.is_file()})

    def test_custom_data_layout_is_rejected_before_update_or_handoff(self):
        script = (ROOT / "scripts/release_portable.ps1").read_text(encoding="utf-8")
        sync = re.search(r"function Sync-PortableToDeploy[\s\S]+?(?=\r?\n\$DeployPath =)", script)
        self.assertIsNotNone(sync)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source, portable = root / "source", root / "lmo_audio"
            source.mkdir()
            for directory in ("backend/saved-meetings", "binaries", "models"):
                (portable / directory).mkdir(parents=True, exist_ok=True)
            (portable / "lmo_audio.exe").write_text("existing app", encoding="utf-8")
            record = portable / "backend/saved-meetings/private.json"
            record.write_text("private meeting", encoding="utf-8")
            config = portable / "backend/config.json"
            config.write_text('{"paths":{"output_dir":"./saved-meetings"}}', encoding="utf-8")
            before = {path: _sha256(path) for path in portable.rglob("*") if path.is_file()}
            result = _run_powershell(f'''
$ErrorActionPreference = "Stop"
$PortableAppExeName = "lmo_audio.exe"
. '{ROOT / 'scripts/portable_data_safety.ps1'}'
{sync.group(0)}
try {{ Sync-PortableToDeploy '{source}' '{portable}'; throw 'Expected rejection' }}
catch {{ if ($_.Exception.Message -notlike '*Unsupported portable data layout*') {{ throw }} }}
''')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            result = _run_powershell(f"& '{ROOT / 'scripts/create_handoff_package.ps1'}' -PortableDir '{portable}' -AllowStale -PackageName 'must-not-create-custom-data-package'")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Unsupported portable data layout", result.stdout + result.stderr)
            self.assertEqual(before, {path: _sha256(path) for path in portable.rglob("*") if path.is_file()})

    def test_selected_summary_model_is_rejected_before_update_or_handoff(self):
        for reference in ("./private-model.gguf", "private-model.gguf", ".\\private-model.bin", "absolute",
                          "private-model", "models/private-model", "  ./private-model.gguf  "):
            with self.subTest(reference=reference), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                portable, other = root / "lmo_audio", root / "other"
                backend = portable / "backend"
                backend.mkdir(parents=True)
                other.mkdir()
                model = backend / ("private-model.gguf" if reference == "absolute" else reference.strip())
                model.parent.mkdir(parents=True, exist_ok=True)
                model.write_text("private model fixture", encoding="utf-8")
                config = {"paths": {"llm_model": "./models/llm/gemma.gguf"}, "summary": {
                    "model": str(model) if reference == "absolute" else reference,
                }}
                (backend / "config.json").write_text(json.dumps(config), encoding="utf-8")
                (portable / "personal-backup.json").write_text("keep", encoding="utf-8")
                before = {path: _sha256(path) for path in portable.rglob("*") if path.is_file()}
                for source, destination in ((other, portable), (portable, other)):
                    result = _run_powershell(f'''
$ErrorActionPreference = "Stop"
$PortableAppExeName = "lmo_audio.exe"
. '{ROOT / 'scripts/portable_data_safety.ps1'}'
{_release_function('Sync-PortableToDeploy')}
Sync-PortableToDeploy '{source}' '{destination}'
''')
                    self.assertNotEqual(result.returncode, 0)
                    self.assertIn("Unsupported portable data layout", result.stdout + result.stderr)
                    self.assertEqual(list(other.iterdir()), [])
                    self.assertEqual(before, {path: _sha256(path) for path in portable.rglob("*") if path.is_file()})
                # The real handoff entry must refuse before even validating or
                # creating an output root; this test never writes to releases/.
                output = root / "handoff"
                result = _run_powershell(
                    f"& '{ROOT / 'scripts/create_handoff_package.ps1'}' -PortableDir '{portable}' "
                    f"-OutputRoot '{output}' -AllowStale -PackageName 'private-model-must-not-be-packaged'"
                )
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Unsupported portable data layout", result.stdout + result.stderr)
                self.assertFalse(output.exists())
                self.assertEqual(before, {path: _sha256(path) for path in portable.rglob("*") if path.is_file()})

    def test_summary_models_outside_backend_and_ollama_names_are_allowed(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            portable = root / "lmo_audio"
            (portable / "backend").mkdir(parents=True)
            for model in (portable / "models/user.gguf", root / "external/model.bin"):
                model.parent.mkdir(parents=True, exist_ok=True)
                model.write_text("user model", encoding="utf-8")
            for reference in ("gemma4:e2b", "library/gemma4:e2b", "../models/user.gguf", str(root / "external/model.bin")):
                with self.subTest(reference=reference):
                    (portable / "backend/config.json").write_text(json.dumps({"summary": {"model": reference}}), encoding="utf-8")
                    before = {path: _sha256(path) for path in root.rglob("*") if path.is_file()}
                    result = _run_powershell(f'''
$ErrorActionPreference = "Stop"
. '{ROOT / 'scripts/portable_data_safety.ps1'}'
Assert-PortableDataLayout '{portable}'
''')
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
                    self.assertEqual(before, {path: _sha256(path) for path in root.rglob("*") if path.is_file()})

    def test_deploy_completion_uses_build_manifest_and_rejects_skipped_wrong_code(self):
        release = (ROOT / "scripts/release_portable.ps1").read_text(encoding="utf-8")
        completion = release[release.index("\nSync-PortableToDeploy $TargetPortableDir $DeployPath"):]
        # Exercise the actual completion sequence, including any manifest writes,
        # with the real read-only verifier and fake, never executable PE headers.
        completion = completion.replace(
            '(Join-Path $PSScriptRoot "verify_portable.ps1")',
            f"'{ROOT / 'scripts/verify_portable.ps1'}'",
        )
        helpers = "\n".join(_release_function(name) for name in (
            "Normalize-FullPath", "Get-FileHashValue", "Get-PortablePayloadFiles",
            "Write-ReleaseManifest", "Sync-PortableToDeploy",
        ))
        for wrong_code in (False, True):
            with self.subTest(wrong_code=wrong_code), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                source, destination = root / "source/lmo_audio", root / "destination/lmo_audio"
                pe = bytearray(4096)
                pe[0x3c:0x40] = (128).to_bytes(4, "little")
                pe[128 + 24 + 68:128 + 24 + 70] = (2).to_bytes(2, "little")
                packaged = {
                    "lmo_audio.exe": pe, "binaries/meeting-backend-x86_64-pc-windows-msvc.exe": pe,
                    "backend/main.py": b"NEW CODE", "backend/config.json": b"{}",
                    "backend/ffmpeg.exe": b"fake", "runtime/ollama/README.txt": b"download later",
                    "START_HERE.txt": b"help",
                }
                for relative, content in packaged.items():
                    path = source / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
                for model in json.loads(MODEL_LAYOUT_PATH.read_text(encoding="utf-8"))["models"]:
                    for marker in model["requiredMarkers"]:
                        path = source / "models" / model["portableDir"] / marker
                        path.parent.mkdir(parents=True, exist_ok=True)
                        path.write_bytes(b"model fixture")
                protected = {
                    "backend/config.json": b'{"user_setting":true}',
                    "backend/outputs/meeting.json": b"private record",
                    "models/downloaded/user.bin": b"user model",
                    "runtime/ollama/ollama.exe": b"downloaded runtime",
                }
                for relative, content in protected.items():
                    path = destination / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_bytes(content)
                if wrong_code:
                    stale = destination / "backend/main.py"
                    stale.write_bytes(b"OLD CODE")
                    stamp = (source / "backend/main.py").stat().st_mtime_ns
                    os.utime(stale, ns=(stamp, stamp))
                    self.assertEqual(stale.stat().st_size, (source / "backend/main.py").stat().st_size)
                    self.assertEqual(stale.stat().st_mtime_ns, stamp)
                    self.assertNotEqual(_sha256(stale), _sha256(source / "backend/main.py"))
                result = _run_powershell(f'''
$ErrorActionPreference = "Stop"
$RepoRoot = Resolve-Path '{ROOT}'
$PortableAppExeName = "lmo_audio.exe"
$ModelLayout = Get-Content '{MODEL_LAYOUT_PATH}' -Raw | ConvertFrom-Json
$TargetPortableDir = '{source}'
$DeployPath = '{destination}'
$AllowDirty = $false
$AllowMissingEmbeddedOllama = $false
. '{ROOT / 'scripts/portable_data_safety.ps1'}'
{helpers}
function Get-GitValue([string]$Command) {{ if ($Command -like 'status*') {{ return '' }}; return 'fixture' }}
function Get-FrontendAssets {{ return @() }}
Write-ReleaseManifest $TargetPortableDir | Out-Null
{completion}
''')
                self.assertEqual(result.returncode, 1 if wrong_code else 0, result.stdout + result.stderr)
                self.assertIn("integrity verification failed" if wrong_code else "runtime smoke deferred", result.stdout + result.stderr)
                self.assertEqual((destination / "backend/main.py").read_bytes(), b"OLD CODE" if wrong_code else b"NEW CODE")
                # The trusted build manifest must survive the completion sequence
                # byte for byte, even when a mismatched deploy is rejected.
                self.assertEqual((source / "release-manifest.json").read_bytes(),
                                 (destination / "release-manifest.json").read_bytes())
                for relative, content in protected.items():
                    self.assertEqual((destination / relative).read_bytes(), content)

    def test_external_data_paths_are_allowed_but_runtime_smoke_is_refused(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            portable = root / "lmo_audio"
            (portable / "backend").mkdir(parents=True)
            (portable / "backend/config.json").write_text(json.dumps({"paths": {
                "output_dir": str(root / "external-meetings"), "temp_dir": "./temp/",
            }}), encoding="utf-8")
            result = _run_powershell(f'''
$ErrorActionPreference = "Stop"
. '{ROOT / 'scripts/portable_data_safety.ps1'}'
Assert-PortableDataLayout '{portable}'
try {{ Assert-PortableDataLayout '{portable}' -ForRuntimeSmoke; throw 'Expected smoke rejection' }}
catch {{ if ($_.Exception.Message -notlike '*Unsupported portable data layout*') {{ throw }} }}
''')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_verifier_refuses_live_target_without_stopping_sibling_installation(self):
        script = (ROOT / "scripts/verify_portable.ps1").read_text(encoding="utf-8")
        guard = re.search(r"function Assert-NoPortableProcesses[\s\S]+?(?=\r?\nfunction Test-PortAvailable)", script)
        self.assertIsNotNone(guard)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir) / "lmo_audio"
            result = _run_powershell(f'''
$ErrorActionPreference = "Stop"
. '{ROOT / 'scripts/portable_data_safety.ps1'}'
{guard.group(0)}
function Stop-Process {{ throw 'Must not stop any existing process' }}
function Get-Process {{ return [pscustomobject]@{{Path='{root}_other\\app.exe'}} }}
Assert-NoPortableProcesses '{root}'
function Get-Process {{ return [pscustomobject]@{{Path='{root}\\app.exe'}} }}
try {{ Assert-NoPortableProcesses '{root}'; throw 'Expected live target rejection' }}
catch {{ if ($_.Exception.Message -notlike '*this installation is running*') {{ throw }} }}
''')
            self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_verify_portable_checks_export_zip_structure(self):
        script = (ROOT / "scripts" / "verify_portable.ps1").read_text(encoding="utf-8")
        self.assertIn("Get-ZipMissingEntries", script)
        self.assertIn("[System.Security.Cryptography.SHA256]::Create()", script)
        self.assertIn("[System.Environment]::SetEnvironmentVariable", script)
        self.assertIn("[switch]$AllowDirty", script)
        self.assertIn("manifest clean", script)
        for required in (
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "META-INF/container.xml",
            "Contents/content.hpf",
            "Contents/section0.xml",
        ):
            self.assertIn(required, script)

    def test_release_process_cleanup_uses_path_boundary_check(self):
        script = (ROOT / "scripts" / "release_portable.ps1").read_text(encoding="utf-8")
        self.assertIn("function Test-IsPathWithin", script)
        self.assertIn("Test-IsPathWithin $_.ExecutablePath $portableFullPath", script)
        self.assertIn("Test-IsPathWithin $_.Path $portableFullPath", script)
        self.assertNotIn("ExecutablePath.StartsWith($portableFullPath", script)
        self.assertNotIn('$_.CommandLine -match', script)

    def test_deploy_update_preserves_records_settings_and_downloads(self):
        script = (ROOT / "scripts" / "release_portable.ps1").read_text(encoding="utf-8")
        sync = re.search(r"function Sync-PortableToDeploy[\s\S]+?(?=\r?\n\$DeployPath =)", script)
        self.assertIsNotNone(sync)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source, destination, fresh = (root / name for name in ("source", "existing", "fresh"))
            packaged = {
                "lmo_audio.exe": "new app", "release-manifest.json": "{}", "START_HERE.txt": "help",
                "binaries/sidecar.exe": "new sidecar", "backend/main.py": "new code",
                "backend/config.json": '{"default":true}', "runtime/ffmpeg/ffmpeg.exe": "ffmpeg",
                "models/default/model.bin": "default model",
            }
            preserved = {
                "backend/config.json": '{"custom":true}', "backend/outputs/result.json": "meeting",
                "backend/temp/resume.json": "resume", "backend/logs/engine.log": "log",
                "backend/database/records": "database", "backend/history.db": "db",
                "backend/history.db-wal": "wal", "backend/history.sqlite3-shm": "shm",
                "models/downloaded/model.bin": "downloaded model",
                "runtime/ollama/ollama.exe": "downloaded runtime", "personal-backup.json": "backup",
            }
            for base, entries in ((source, packaged), (destination, preserved)):
                for relative, content in entries.items():
                    path = base / relative
                    path.parent.mkdir(parents=True, exist_ok=True)
                    path.write_text(content, encoding="utf-8")
            for relative in ("backend/obsolete.py", "binaries/obsolete.dll"):
                path = destination / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("obsolete", encoding="utf-8")
            # Source-side runtime data must neither replace existing records nor
            # be copied to a fresh installation.
            for relative in ("backend/outputs/private.json", "backend/history.db-wal"):
                path = source / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("source private data", encoding="utf-8")
            before = {relative: _sha256(destination / relative) for relative in preserved}
            completed = _run_powershell(f'''
$ErrorActionPreference = "Stop"
$PortableAppExeName = "lmo_audio.exe"
. '{ROOT / 'scripts/portable_data_safety.ps1'}'
{sync.group(0)}
Sync-PortableToDeploy '{source}' '{destination}'
Sync-PortableToDeploy '{source}' '{fresh}'
exit 0
''')
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            self.assertEqual(before, {relative: _sha256(destination / relative) for relative in preserved})
            for relative, content in packaged.items():
                self.assertEqual((fresh / relative).read_text(encoding="utf-8"), content)
                if relative != "backend/config.json":
                    self.assertEqual((destination / relative).read_text(encoding="utf-8"), content)
            for relative in ("backend/obsolete.py", "binaries/obsolete.dll"):
                self.assertFalse((destination / relative).exists())
            for base in (destination, fresh):
                self.assertFalse((base / "backend/outputs/private.json").exists())
            self.assertFalse((fresh / "backend/history.db-wal").exists())

    def test_deploy_update_replaces_packaged_ollama_as_a_unit(self):
        script = (ROOT / "scripts" / "release_portable.ps1").read_text(encoding="utf-8")
        sync = re.search(r"function Sync-PortableToDeploy[\s\S]+?(?=\r?\n\$DeployPath =)", script)
        self.assertIsNotNone(sync)
        packaged = {
            "lmo_audio.exe": "new app", "release-manifest.json": "{}", "START_HERE.txt": "help",
            "binaries/sidecar.exe": "new sidecar", "backend/main.py": "new code",
            "backend/config.json": '{"default":true}', "runtime/ffmpeg/ffmpeg.exe": "new ffmpeg",
            "models/default/model.bin": "default model",
        }
        embedded_ollama = {
            "runtime/ollama/ollama.exe": "new ollama",
            "runtime/ollama/lib/ollama/ggml-base.dll": "new base",
            "runtime/ollama/lib/ollama/cuda_v13/ggml-cuda.dll": "new cuda",
        }
        user_ollama = {
            "runtime/ollama/ollama.exe": "user ollama",
            "runtime/ollama/lib/ollama/ggml-cpu-old.dll": "user cpu",
            "runtime/ollama/lib/ollama/cuda_v12/ggml-cuda.dll": "user cuda",
        }
        # Ollama models live outside the runtime and other runtime folders are
        # never mirrored, so both survive either update.
        user_kept = {"models/ollama/blobs/sha256-model": "user model", "runtime/other/keep.txt": "user runtime"}
        cases = {
            "packaged": {**packaged, **embedded_ollama},
            "downloaded": {**packaged, "runtime/ollama/README.txt": "downloaded on first use"},
        }

        def write_tree(base, entries):
            for relative, content in entries.items():
                path = base / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(content, encoding="utf-8")

        def ollama_files(base):
            root = base / "runtime/ollama"
            return {path.relative_to(base).as_posix(): path.read_text(encoding="utf-8")
                    for path in root.rglob("*") if path.is_file()}

        for case, source_entries in cases.items():
            with self.subTest(source=case), tempfile.TemporaryDirectory() as temp_dir:
                root = Path(temp_dir)
                source, destination = root / "source", root / "existing"
                write_tree(source, source_entries)
                write_tree(destination, {**user_ollama, **user_kept})
                self.assertEqual(ollama_files(destination), user_ollama)
                completed = _run_powershell(f'''
$ErrorActionPreference = "Stop"
$PortableAppExeName = "lmo_audio.exe"
. '{ROOT / 'scripts/portable_data_safety.ps1'}'
{sync.group(0)}
Sync-PortableToDeploy '{source}' '{destination}'
exit 0
''')
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                if case == "packaged":
                    self.assertEqual(ollama_files(destination), embedded_ollama)
                    for relative in ("runtime/ollama/lib/ollama/ggml-cpu-old.dll",
                                     "runtime/ollama/lib/ollama/cuda_v12/ggml-cuda.dll"):
                        self.assertFalse((destination / relative).exists(), relative)
                else:
                    self.assertEqual(ollama_files(destination),
                                     {**user_ollama, "runtime/ollama/README.txt": "downloaded on first use"})
                for relative, content in user_kept.items():
                    self.assertEqual((destination / relative).read_text(encoding="utf-8"), content)
                self.assertEqual((destination / "runtime/ffmpeg/ffmpeg.exe").read_text(encoding="utf-8"), "new ffmpeg")

    def test_release_payload_manifest_excludes_mutable_record_data(self):
        script = (ROOT / "scripts" / "release_portable.ps1").read_text(encoding="utf-8")
        payload = re.search(r"function Get-PortablePayloadFiles[\s\S]+?(?=\r?\nfunction Write-ReleaseManifest)", script)
        self.assertIsNotNone(payload)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            private = ("backend/outputs/result.json", "backend/temp/resume.json", "backend/logs/engine.log",
                       "backend/database/records", "backend/history.db", "backend/history.db-wal",
                       "backend/history.sqlite3-shm", "backend/config.json")
            for relative in (*private, "backend/main.py", "runtime/ffmpeg.exe"):
                path = root / relative
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text("fixture", encoding="utf-8")
            output = root / "payload.json"
            completed = _run_powershell(f'''
$ErrorActionPreference = "Stop"
$PortableAppExeName = "lmo_audio.exe"
function Normalize-FullPath([string]$Path) {{ return [System.IO.Path]::GetFullPath($Path) }}
function Get-FileHashValue([string]$Path) {{ return "fixture-hash" }}
{payload.group(0)}
@(Get-PortablePayloadFiles '{root}') | ConvertTo-Json | Set-Content -LiteralPath '{output}' -Encoding UTF8
''')
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            entries = json.loads(output.read_text(encoding="utf-8-sig"))
            self.assertEqual({entry["path"].replace("\\", "/") for entry in entries},
                             {"backend/main.py", "runtime/ffmpeg.exe"})

    def test_verify_manifest_dirty_requires_allow_dirty(self):
        script = (ROOT / "scripts" / "verify_portable.ps1").read_text(encoding="utf-8")
        add_result = re.search(
            r"function Add-Result[\s\S]+?(?=\r?\nfunction Get-PeSubsystem)",
            script,
        )
        manifest_check = re.search(
            r"function Test-ReleaseManifest[\s\S]+?(?=\r?\nfunction Test-CleanPortableSurface)",
            script,
        )
        self.assertIsNotNone(add_result, "Could not find Add-Result helper")
        self.assertIsNotNone(manifest_check, "Could not find manifest helper")

        with tempfile.TemporaryDirectory() as temp_dir:
            temp_path = Path(temp_dir)
            manifest_path = temp_path / "release-manifest.json"
            manifest_path.write_text(
                json.dumps({"dirty": True, "files": {}, "modelMarkers": []}),
                encoding="utf-8",
            )
            command = f"""
$ErrorActionPreference = "Stop"
$script:Results = @()
$script:Failed = $false
{add_result.group(0)}
{manifest_check.group(0)}
function Get-FileHashValue([string]$Path) {{ return $null }}
Test-ReleaseManifest "{temp_path}" "{manifest_path}" $false
if (-not $script:Failed) {{
    throw "Expected dirty manifest to fail without AllowDirty"
}}
$script:Results = @()
$script:Failed = $false
Test-ReleaseManifest "{temp_path}" "{manifest_path}" $true
if ($script:Failed) {{
    throw "Expected dirty manifest to pass with AllowDirty"
}}
"""
            completed = _run_powershell(command)
            self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)


if __name__ == "__main__":
    unittest.main()
