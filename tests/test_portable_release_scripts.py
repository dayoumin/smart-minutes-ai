import hashlib
import json
import re
import subprocess
import tempfile
import unittest
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
        portable_dir = ROOT / "releases" / "lmo_audio"
        config_path = portable_dir / "backend" / "config.json"
        manifest_path = portable_dir / "release-manifest.json"
        if not config_path.exists() or not manifest_path.exists():
            self.skipTest("Portable release folder is not available")
        runtime_paths = [
            portable_dir / "logs",
            portable_dir / "backend" / "outputs",
            portable_dir / "backend" / "temp",
        ]
        if any(path.exists() for path in runtime_paths):
            self.skipTest("Portable release folder has runtime artifacts; preservation test requires a clean deploy folder")

        before_config = _sha256(config_path)
        before_manifest = _sha256(manifest_path)
        completed = subprocess.run(
            [
                "powershell",
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(ROOT / "scripts" / "verify_portable.ps1"),
                "-PortableDir",
                str(portable_dir),
                "-AllowDirty",
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=300,
        )

        self.assertEqual(completed.returncode, 0, (completed.stdout or "") + (completed.stderr or ""))
        self.assertIn("Qwen optional model omitted", completed.stdout)
        self.assertIn("Portable verification passed", completed.stdout)
        self.assertEqual(before_config, _sha256(config_path))
        self.assertEqual(before_manifest, _sha256(manifest_path))

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

    def test_verify_manifest_dirty_requires_allow_dirty(self):
        script = (ROOT / "scripts" / "verify_portable.ps1").read_text(encoding="utf-8")
        add_result = re.search(
            r"function Add-Result[\s\S]+?(?=\r?\nfunction Get-PeSubsystem)",
            script,
        )
        manifest_check = re.search(
            r"function Test-ReleaseManifest[\s\S]+?(?=\r?\nfunction Stop-PortableProcesses)",
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
