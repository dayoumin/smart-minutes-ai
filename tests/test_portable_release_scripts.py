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
            timeout=timeout,
        )
    finally:
        script_path.unlink(missing_ok=True)


def _sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PortableReleaseScriptTest(unittest.TestCase):
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
if (-not $resolved.EndsWith("smart-minutes-ai\\releases\\lmo_audio")) {{
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
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            timeout=300,
        )

        self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
        self.assertIn("Qwen optional model omitted", completed.stdout)
        self.assertIn("Portable verification passed", completed.stdout)
        self.assertEqual(before_config, _sha256(config_path))
        self.assertEqual(before_manifest, _sha256(manifest_path))

    def test_verify_portable_checks_export_zip_structure(self):
        script = (ROOT / "scripts" / "verify_portable.ps1").read_text(encoding="utf-8")
        self.assertIn("Get-ZipMissingEntries", script)
        for required in (
            "[Content_Types].xml",
            "_rels/.rels",
            "word/document.xml",
            "META-INF/container.xml",
            "Contents/content.hpf",
            "Contents/section0.xml",
        ):
            self.assertIn(required, script)


if __name__ == "__main__":
    unittest.main()
