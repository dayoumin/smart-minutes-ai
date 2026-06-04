import hashlib
import json
import shutil
import subprocess
import tempfile
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
MODEL_LAYOUT_PATH = ROOT / "scripts" / "portable_model_layout.json"


def _ps_quote(path: Path | str) -> str:
    return "'" + str(path).replace("'", "''") + "'"


def _run_powershell(command: str, timeout: int = 90) -> subprocess.CompletedProcess[str]:
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
    return hashlib.sha256(path.read_bytes()).hexdigest().upper()


def _write(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def _package_name(prefix: str) -> str:
    return f"{prefix}_{uuid.uuid4().hex}"


def _write_model_markers(root: Path) -> None:
    layout = json.loads(MODEL_LAYOUT_PATH.read_text(encoding="utf-8"))
    for model in layout["models"]:
        for marker in model["requiredMarkers"]:
            _write(root / "models" / model["portableDir"] / marker, f"{model['key']}:{marker}")


def _make_fake_portable(root: Path) -> Path:
    portable = root / "lmo_audio"
    _write(portable / "lmo_audio.exe", "new app exe")
    _write(portable / "START_HERE.txt", "start here")
    _write(portable / "binaries" / "meeting-backend-x86_64-pc-windows-msvc.exe", "new sidecar")
    _write(portable / "backend" / "ffmpeg.exe", "new ffmpeg")
    _write(portable / "backend" / "main.py", "new backend")
    _write(portable / "backend" / "module" / "temp" / "data.txt", "nested temp is source-owned")
    _write(portable / "backend" / "module" / "config.json", '{"nested":true}')
    _write(portable / "backend" / "config.json", '{"from":"new-release"}')
    _write(portable / "backend" / "outputs" / "old-result.json", "{}")
    _write(portable / "backend" / "temp" / "old.tmp", "tmp")
    _write(portable / "backend" / "__pycache__" / "main.pyc", "pyc")
    _write_model_markers(portable)
    manifest = {
        "commit": "abcdef1234567890",
        "dirty": False,
        "app": {"name": "lmo_audio"},
        "files": {
            "appExe": {
                "path": "lmo_audio.exe",
                "sha256": _sha256(portable / "lmo_audio.exe"),
            },
            "sidecarExe": {
                "path": "binaries\\meeting-backend-x86_64-pc-windows-msvc.exe",
                "sha256": _sha256(portable / "binaries" / "meeting-backend-x86_64-pc-windows-msvc.exe"),
            },
            "backendMain": {
                "path": "backend\\main.py",
                "sha256": _sha256(portable / "backend" / "main.py"),
            },
            "backendConfig": {
                "path": "backend\\config.json",
                "sha256": _sha256(portable / "backend" / "config.json"),
            }
        },
        "portablePayloadFiles": [
            {
                "path": "lmo_audio.exe",
                "sha256": _sha256(portable / "lmo_audio.exe"),
                "bytes": (portable / "lmo_audio.exe").stat().st_size,
            },
            {
                "path": "START_HERE.txt",
                "sha256": _sha256(portable / "START_HERE.txt"),
                "bytes": (portable / "START_HERE.txt").stat().st_size,
            },
            {
                "path": "binaries\\meeting-backend-x86_64-pc-windows-msvc.exe",
                "sha256": _sha256(portable / "binaries" / "meeting-backend-x86_64-pc-windows-msvc.exe"),
                "bytes": (portable / "binaries" / "meeting-backend-x86_64-pc-windows-msvc.exe").stat().st_size,
            },
            {
                "path": "backend\\ffmpeg.exe",
                "sha256": _sha256(portable / "backend" / "ffmpeg.exe"),
                "bytes": (portable / "backend" / "ffmpeg.exe").stat().st_size,
            },
            {
                "path": "backend\\main.py",
                "sha256": _sha256(portable / "backend" / "main.py"),
                "bytes": (portable / "backend" / "main.py").stat().st_size,
            },
            {
                "path": "backend\\module\\temp\\data.txt",
                "sha256": _sha256(portable / "backend" / "module" / "temp" / "data.txt"),
                "bytes": (portable / "backend" / "module" / "temp" / "data.txt").stat().st_size,
            },
            {
                "path": "backend\\module\\config.json",
                "sha256": _sha256(portable / "backend" / "module" / "config.json"),
                "bytes": (portable / "backend" / "module" / "config.json").stat().st_size,
            },
        ],
        "modelMarkers": [],
    }
    _write(portable / "release-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return portable


def _make_fake_target(root: Path) -> Path:
    target = root / "lmo_audio"
    _write(target / "lmo_audio.exe", "old app exe")
    _write(target / "binaries" / "meeting-backend-x86_64-pc-windows-msvc.exe", "old sidecar")
    _write(target / "backend" / "ffmpeg.exe", "old ffmpeg")
    _write(target / "backend" / "main.py", "old backend")
    _write(target / "backend" / "stale.py", "stale backend file")
    _write(target / "backend" / "module" / "stale.txt", "stale nested file")
    _write(target / "backend" / "config.json", '{"from":"existing-user"}')
    _write(target / "backend" / "outputs" / "keep.json", '{"keep":true}')
    _write(target / "backend" / "temp" / "keep.tmp", "keep tmp")
    _write_model_markers(target)
    _write(target / "release-manifest.json", json.dumps({"commit": "old", "dirty": False, "files": {}}, indent=2))
    return target


class UpdatePackageScriptTest(unittest.TestCase):
    def test_root_scripts_include_manual_update_commands(self):
        package_json = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        scripts = package_json["scripts"]
        self.assertIn("package:update", scripts)
        self.assertIn("create_update_package.ps1", scripts["package:update"])
        self.assertIn("verify:update", scripts)
        self.assertIn("verify_update.ps1", scripts["verify:update"])

    def test_create_update_package_excludes_user_owned_paths(self):
        package_name = _package_name("test_update_package")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = _make_fake_portable(Path(temp_dir))
            try:
                completed = _run_powershell(
                    "& "
                    + _ps_quote(ROOT / "scripts" / "create_update_package.ps1")
                    + " -PortableDir "
                    + _ps_quote(portable)
                    + " -OutputRoot "
                    + _ps_quote(ROOT / "releases" / "updates")
                    + f" -PackageName {package_name} -AllowStale -Force"
                )
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)

                self.assertTrue((package_root / "payload" / "lmo_audio.exe").exists())
                self.assertTrue((package_root / "update_lmo_audio.ps1").exists())
                self.assertTrue((package_root / "verify_update.ps1").exists())
                self.assertFalse((package_root / "payload" / "models").exists())
                self.assertFalse((package_root / "payload" / "backend" / "config.json").exists())
                self.assertFalse((package_root / "payload" / "backend" / "outputs").exists())
                self.assertFalse((package_root / "payload" / "backend" / "temp").exists())
                self.assertFalse((package_root / "payload" / "backend" / "__pycache__").exists())

                manifest = json.loads((package_root / "update-manifest.json").read_text(encoding="utf-8-sig"))
                payload_paths = {entry["path"] for entry in manifest["payloadFiles"]}
                self.assertEqual(manifest["packageFormat"], "lmo-audio-manual-update-v1")
                self.assertIn("models", manifest["preservedTargetPaths"])
                self.assertIn("backend\\config.json", manifest["preservedTargetPaths"])
                self.assertIn("releaseManifestSha256", manifest["source"])
                self.assertNotIn("payload\\release-manifest.json", payload_paths)
                self.assertNotIn("payload\\backend\\config.json", payload_paths)
                self.assertIn("payload\\backend\\module\\temp\\data.txt", payload_paths)
                self.assertIn("payload\\backend\\module\\config.json", payload_paths)
            finally:
                shutil.rmtree(package_root, ignore_errors=True)

    def test_create_update_package_allows_modified_preserved_backend_config(self):
        package_name = _package_name("test_update_preserved_config")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = _make_fake_portable(Path(temp_dir))
            (portable / "backend" / "config.json").write_text('{"from":"user-edited"}', encoding="utf-8")
            try:
                completed = _run_powershell(
                    "& "
                    + _ps_quote(ROOT / "scripts" / "create_update_package.ps1")
                    + " -PortableDir "
                    + _ps_quote(portable)
                    + " -OutputRoot "
                    + _ps_quote(ROOT / "releases" / "updates")
                    + f" -PackageName {package_name} -AllowStale -Force"
                )
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertFalse((package_root / "payload" / "backend" / "config.json").exists())

                manifest = json.loads((package_root / "update-manifest.json").read_text(encoding="utf-8-sig"))
                payload_paths = {entry["path"] for entry in manifest["payloadFiles"]}
                self.assertIn("backend\\config.json", manifest["preservedTargetPaths"])
                self.assertNotIn("payload\\backend\\config.json", payload_paths)
            finally:
                shutil.rmtree(package_root, ignore_errors=True)

    def test_create_update_package_rejects_stale_release_without_override(self):
        package_name = _package_name("test_update_stale")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = _make_fake_portable(Path(temp_dir))
            try:
                completed = _run_powershell(
                    "& "
                    + _ps_quote(ROOT / "scripts" / "create_update_package.ps1")
                    + " -PortableDir "
                    + _ps_quote(portable)
                    + " -OutputRoot "
                    + _ps_quote(ROOT / "releases" / "updates")
                    + f" -PackageName {package_name}"
                )
                self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertIn("does not match current HEAD", completed.stdout + completed.stderr)
                self.assertFalse(package_root.exists())
            finally:
                shutil.rmtree(package_root, ignore_errors=True)

    def test_create_update_package_rejects_manifest_file_hash_mismatch(self):
        package_name = _package_name("test_update_manifest_mismatch")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = _make_fake_portable(Path(temp_dir))
            (portable / "backend" / "main.py").write_text("changed after manifest", encoding="utf-8")
            try:
                completed = _run_powershell(
                    "& "
                    + _ps_quote(ROOT / "scripts" / "create_update_package.ps1")
                    + " -PortableDir "
                    + _ps_quote(portable)
                    + " -OutputRoot "
                    + _ps_quote(ROOT / "releases" / "updates")
                    + f" -PackageName {package_name} -AllowStale"
                )
                self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertIn("release manifest does not match", (completed.stdout + completed.stderr).lower())
                self.assertFalse(package_root.exists())
            finally:
                shutil.rmtree(package_root, ignore_errors=True)

    def test_create_update_package_rejects_empty_manifest_file_hashes(self):
        package_name = _package_name("test_update_empty_manifest")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = _make_fake_portable(Path(temp_dir))
            manifest_path = portable / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["files"] = {}
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                completed = _run_powershell(
                    "& "
                    + _ps_quote(ROOT / "scripts" / "create_update_package.ps1")
                    + " -PortableDir "
                    + _ps_quote(portable)
                    + " -OutputRoot "
                    + _ps_quote(ROOT / "releases" / "updates")
                    + f" -PackageName {package_name} -AllowStale"
                )
                self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertIn("does not include file hashes", completed.stdout + completed.stderr)
                self.assertFalse(package_root.exists())
            finally:
                shutil.rmtree(package_root, ignore_errors=True)

    def test_create_update_package_rejects_package_name_path_segments(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = _make_fake_portable(Path(temp_dir))
            completed = _run_powershell(
                "& "
                + _ps_quote(ROOT / "scripts" / "create_update_package.ps1")
                + " -PortableDir "
                + _ps_quote(portable)
                + " -OutputRoot "
                + _ps_quote(ROOT / "releases" / "updates")
                + " -PackageName .. -AllowStale"
            )
            self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
            self.assertIn("PackageName must be a concrete child folder name", completed.stdout + completed.stderr)

    def test_update_package_applies_payload_and_preserves_user_owned_paths(self):
        package_name = _package_name("test_update_apply")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            portable = _make_fake_portable(Path(source_dir))
            target = _make_fake_target(Path(target_dir))
            config_before = (target / "backend" / "config.json").read_text(encoding="utf-8")
            model_marker = target / "models" / "faster-whisper-large-v3" / "model.bin"
            model_before = model_marker.read_text(encoding="utf-8")
            try:
                create_completed = _run_powershell(
                    "& "
                    + _ps_quote(ROOT / "scripts" / "create_update_package.ps1")
                    + " -PortableDir "
                    + _ps_quote(portable)
                    + " -OutputRoot "
                    + _ps_quote(ROOT / "releases" / "updates")
                    + f" -PackageName {package_name} -AllowStale -Force"
                )
                self.assertEqual(create_completed.returncode, 0, create_completed.stdout + create_completed.stderr)

                apply_completed = _run_powershell(
                    "& "
                    + _ps_quote(package_root / "update_lmo_audio.ps1")
                    + " -TargetDir "
                    + _ps_quote(target)
                    + " -PackageDir "
                    + _ps_quote(package_root)
                )
                self.assertEqual(apply_completed.returncode, 0, apply_completed.stdout + apply_completed.stderr)
                self.assertIn("Update verification passed", apply_completed.stdout)

                self.assertEqual((target / "lmo_audio.exe").read_text(encoding="utf-8"), "new app exe")
                self.assertEqual((target / "backend" / "main.py").read_text(encoding="utf-8"), "new backend")
                self.assertFalse((target / "backend" / "stale.py").exists())
                self.assertFalse((target / "backend" / "module" / "stale.txt").exists())
                self.assertEqual((target / "backend" / "module" / "temp" / "data.txt").read_text(encoding="utf-8"), "nested temp is source-owned")
                self.assertEqual((target / "backend" / "module" / "config.json").read_text(encoding="utf-8"), '{"nested":true}')
                self.assertEqual((target / "backend" / "config.json").read_text(encoding="utf-8"), config_before)
                self.assertTrue((target / "backend" / "outputs" / "keep.json").exists())
                self.assertTrue((target / "backend" / "temp" / "keep.tmp").exists())
                self.assertEqual(model_marker.read_text(encoding="utf-8"), model_before)

                release_manifest = json.loads((target / "release-manifest.json").read_text(encoding="utf-8-sig"))
                self.assertEqual(release_manifest["commit"], "abcdef1234567890")
                marker_by_path = {marker["path"]: marker for marker in release_manifest["modelMarkers"]}
                self.assertEqual(
                    marker_by_path["models\\faster-whisper-large-v3\\model.bin"]["bytes"],
                    model_marker.stat().st_size,
                )
                self.assertEqual(
                    release_manifest["files"]["backendConfig"]["sha256"],
                    _sha256(target / "backend" / "config.json"),
                )
                self.assertEqual(release_manifest["update"]["packageFormat"], "lmo-audio-manual-update-v1")
            finally:
                shutil.rmtree(package_root, ignore_errors=True)

    def test_update_package_preflights_tampered_payload_before_touching_target(self):
        package_name = _package_name("test_update_tamper")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            portable = _make_fake_portable(Path(source_dir))
            target = _make_fake_target(Path(target_dir))
            app_before = (target / "lmo_audio.exe").read_text(encoding="utf-8")
            backend_before = (target / "backend" / "main.py").read_text(encoding="utf-8")
            try:
                create_completed = _run_powershell(
                    "& "
                    + _ps_quote(ROOT / "scripts" / "create_update_package.ps1")
                    + " -PortableDir "
                    + _ps_quote(portable)
                    + " -OutputRoot "
                    + _ps_quote(ROOT / "releases" / "updates")
                    + f" -PackageName {package_name} -AllowStale -Force"
                )
                self.assertEqual(create_completed.returncode, 0, create_completed.stdout + create_completed.stderr)
                (package_root / "payload" / "backend" / "main.py").write_text("tampered!!!", encoding="utf-8")

                apply_completed = _run_powershell(
                    "& "
                    + _ps_quote(package_root / "update_lmo_audio.ps1")
                    + " -TargetDir "
                    + _ps_quote(target)
                    + " -PackageDir "
                    + _ps_quote(package_root)
                )
                self.assertNotEqual(apply_completed.returncode, 0, apply_completed.stdout + apply_completed.stderr)
                self.assertIn("hash mismatch", apply_completed.stdout + apply_completed.stderr)
                self.assertEqual((target / "lmo_audio.exe").read_text(encoding="utf-8"), app_before)
                self.assertEqual((target / "backend" / "main.py").read_text(encoding="utf-8"), backend_before)
            finally:
                shutil.rmtree(package_root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
