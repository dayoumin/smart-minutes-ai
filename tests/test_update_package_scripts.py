import hashlib
import json
import re
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


def _entry(root: Path, relative: str) -> dict:
    path = root / relative.replace("\\", "/")
    return {"path": relative, "sha256": _sha256(path), "bytes": path.stat().st_size}


# Files users or the app create inside backend. No update step may ship,
# replace or delete them.
BACKEND_USER_FILES = {
    "backend/outputs - 복사본/result.json": "user copy of results",
    "backend/models/stt/model.bin": "alias model folder",
    "backend/logs/app.log": "app log",
    "backend/database/records": "database",
    "backend/history.db-wal": "wal",
}


def _write_model_markers(root: Path) -> None:
    layout = json.loads(MODEL_LAYOUT_PATH.read_text(encoding="utf-8"))
    for model in layout["models"]:
        for marker in model["requiredMarkers"]:
            _write(root / "models" / model["portableDir"] / marker, f"{model['key']}:{marker}")


def _make_fake_portable(root: Path, ollama_installed: bool = False) -> Path:
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
    for relative, content in BACKEND_USER_FILES.items():
        _write(portable / relative, content)
    _write(portable / "runtime" / "ollama" / "README.txt", "download Ollama on first use")
    _write_model_markers(portable)
    readme_entry = _entry(portable, "runtime\\ollama\\README.txt")
    if ollama_installed:
        # Installing Ollama from the app replaces the guide.
        (portable / "runtime" / "ollama" / "README.txt").unlink()
        _write(portable / "runtime" / "ollama" / "ollama.exe", "downloaded runtime")
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
            readme_entry,
        ],
        "modelMarkers": [],
    }
    _write(portable / "release-manifest.json", json.dumps(manifest, ensure_ascii=False, indent=2))
    return portable


OLD_PACKAGE_FILES = {
    "lmo_audio.exe": "old app exe",
    "binaries/meeting-backend-x86_64-pc-windows-msvc.exe": "old sidecar",
    "backend/ffmpeg.exe": "old ffmpeg",
    "backend/main.py": "old backend",
    "backend/stale.py": "stale backend file",
    "backend/module/stale.txt": "stale nested file",
    "backend/retired/only.py": "retired package folder",
    "backend/shared/old.py": "retired file beside a user note",
    "backend/templates/edited.docx": "packaged template",
}


# Entries a damaged or crafted installed list could carry. They name user data,
# some in spellings Windows resolves to the same file, or lack a hash.
def _hostile_entries(target: Path) -> list:
    keep = _entry(target, "backend\\outputs\\keep.json")
    log = _entry(target, "backend\\logs\\app.log")
    config = _entry(target, "backend\\config.json")
    return [
        keep, log, config, _entry(target, "backend\\history.db-wal"),
        {**keep, "path": "backend\\.\\outputs\\keep.json"},
        {**keep, "path": "backend\\outputs.\\keep.json"},
        {**log, "path": "backend\\x\\..\\logs\\app.log"},
        {**config, "path": "backend\\config.json."},
        {"path": "backend\\nohash.py"},
    ]


def _make_fake_target(root: Path, with_package_list: bool = True, handoff_block: dict | None = None) -> Path:
    target = root / "lmo_audio"
    for relative, content in OLD_PACKAGE_FILES.items():
        _write(target / relative, content)
    entries = [_entry(target, relative.replace("/", "\\")) for relative in OLD_PACKAGE_FILES]
    # Changed after install, so the update must not remove it.
    _write(target / "backend" / "templates" / "edited.docx", "user edited template")
    _write(target / "backend" / "shared" / "note.txt", "user note")
    _write(target / "backend" / "config.json", '{"from":"existing-user"}')
    _write(target / "backend" / "outputs" / "keep.json", '{"keep":true}')
    _write(target / "backend" / "temp" / "keep.tmp", "keep tmp")
    for relative, content in BACKEND_USER_FILES.items():
        _write(target / relative, content)
    _write(target / "backend" / "nohash.py", "listed without a hash")
    _write(target / "runtime" / "ollama" / "ollama.exe", "downloaded runtime")
    _write_model_markers(target)
    manifest = {"commit": "old", "dirty": False, "files": {}}
    if with_package_list:
        manifest["portablePayloadFiles"] = entries + _hostile_entries(target)
    if handoff_block is not None:
        manifest["handoff"] = handoff_block
    _write(target / "release-manifest.json", json.dumps(manifest, indent=2))
    return target


def _create_package(portable: Path, package_name: str) -> subprocess.CompletedProcess[str]:
    return _run_powershell(
        "& "
        + _ps_quote(ROOT / "scripts" / "create_update_package.ps1")
        + " -PortableDir "
        + _ps_quote(portable)
        + " -OutputRoot "
        + _ps_quote(ROOT / "releases" / "updates")
        + f" -PackageName {package_name} -AllowStale -Force"
    )


def _apply_package(package_root: Path, target: Path) -> subprocess.CompletedProcess[str]:
    return _run_powershell(
        "& "
        + _ps_quote(package_root / "update_lmo_audio.ps1")
        + " -TargetDir "
        + _ps_quote(target)
        + " -PackageDir "
        + _ps_quote(package_root)
    )


def _file_hashes(root: Path) -> dict:
    return {path.relative_to(root).as_posix(): _sha256(path) for path in root.rglob("*") if path.is_file()}


def _hash_helper(script_name: str) -> str:
    source = (ROOT / "scripts" / script_name).read_text(encoding="utf-8")
    match = re.search(r"^function Get-FileHashValue\b[\s\S]+?(?=^function |\Z)", source, re.MULTILINE)
    if match is None:
        raise AssertionError(f"Hash helper missing from {script_name}")
    return match.group(0)


class UpdateHashSelectionTest(unittest.TestCase):
    def test_full_verifier_keeps_target_hash_package_hash_and_size_failures(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            portable = _make_fake_portable(root / "source")
            target = _make_fake_target(root / "target")
            package_name = _package_name("test_cached_hash_verifier")
            package_root = ROOT / "releases" / "updates" / package_name
            try:
                created = _create_package(portable, package_name)
                self.assertEqual(created.returncode, 0, created.stdout + created.stderr)
                applied = _apply_package(package_root, target)
                self.assertEqual(applied.returncode, 0, applied.stdout + applied.stderr)
                target_before = _file_hashes(target)
                protected_before = {relative: target_before[relative] for relative in BACKEND_USER_FILES}
                verify_command = (
                    "& " + _ps_quote(package_root / "verify_update.ps1")
                    + " -TargetDir " + _ps_quote(target) + " -PackageDir " + _ps_quote(package_root)
                )
                for path, message in (
                    (target / "backend/main.py", "main.py hash mismatch"),
                    (package_root / "payload/backend/main.py", "package hash mismatch"),
                ):
                    with self.subTest(path=path.parent.name, message=message):
                        original = path.read_bytes()
                        path.write_bytes(bytes([original[0] ^ 1]) + original[1:])
                        try:
                            rejected = _run_powershell(verify_command)
                            self.assertNotEqual(rejected.returncode, 0)
                            self.assertIn(message, rejected.stdout + rejected.stderr)
                        finally:
                            path.write_bytes(original)
                manifest_path = package_root / "update-manifest.json"
                original_manifest = manifest_path.read_bytes()
                manifest = json.loads(original_manifest.decode("utf-8-sig"))
                manifest["payloadFiles"][0]["bytes"] += 1
                manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
                try:
                    rejected = _run_powershell(verify_command)
                    self.assertNotEqual(rejected.returncode, 0)
                    self.assertIn("package size mismatch", rejected.stdout + rejected.stderr)
                finally:
                    manifest_path.write_bytes(original_manifest)
                accepted = _run_powershell(verify_command)
                self.assertEqual(accepted.returncode, 0, accepted.stdout + accepted.stderr)
                self.assertEqual(_file_hashes(target), target_before)
                for relative, expected in protected_before.items():
                    self.assertEqual(_sha256(target / relative), expected, relative)
            finally:
                if package_root.exists():
                    self.assertTrue(package_root.resolve().is_relative_to((ROOT / "releases/updates").resolve()))
                    shutil.rmtree(package_root)

    def test_missing_hash_command_is_discovered_once_but_every_file_is_read_again(self):
        for script in ("verify_update.ps1", "update_lmo_audio.ps1"):
            with self.subTest(script=script), tempfile.TemporaryDirectory() as temp_dir:
                path = Path(temp_dir) / "content.bin"
                path.write_bytes(b"first")
                command = f"""
$ErrorActionPreference = 'Stop'
$script:FileHashCommandResolved = $false
$script:FileHashCommand = $null
$script:DiscoveryCalls = 0
function Get-Command {{ $script:DiscoveryCalls++; throw 'Hash command unavailable' }}
{_hash_helper(script)}
$path = {_ps_quote(path)}
if ($null -ne (Get-FileHashValue ($path + '.missing'))) {{ throw 'Missing file became valid' }}
if ($script:DiscoveryCalls -ne 0) {{ throw 'Missing file should not require a hash command' }}
$first = Get-FileHashValue $path
[IO.File]::WriteAllText($path, 'other')
$second = Get-FileHashValue $path
if ($first -ne '{hashlib.sha256(b'first').hexdigest().upper()}') {{ throw 'First hash mismatch' }}
if ($second -ne '{hashlib.sha256(b'other').hexdigest().upper()}') {{ throw 'Changed file was not read again' }}
if ($script:DiscoveryCalls -ne 1) {{ throw "Expected one discovery, got $script:DiscoveryCalls" }}
$locked = [IO.File]::Open($path, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None)
try {{
    $rejected = $false
    try {{ $null = Get-FileHashValue $path }} catch {{ $rejected = $true }}
    if (-not $rejected) {{ throw 'Unreadable file was accepted' }}
}} finally {{ $locked.Dispose() }}
if ((Get-FileHashValue $path) -ne $second) {{ throw 'Read did not recover after unlock' }}
if ($script:DiscoveryCalls -ne 1) {{ throw 'Fallback selection was rediscovered' }}
"""
                result = _run_powershell(command)
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_available_hash_command_is_cached_and_invocation_failure_still_falls_back(self):
        for fail_invocation in (False, True):
            for script in ("verify_update.ps1", "update_lmo_audio.ps1"):
                with self.subTest(script=script, fail_invocation=fail_invocation), tempfile.TemporaryDirectory() as temp_dir:
                    path = Path(temp_dir) / "content.bin"
                    path.write_bytes(b"verify")
                    setup = """
Import-Module ($env:WINDIR + '\\System32\\WindowsPowerShell\\v1.0\\Modules\\Microsoft.PowerShell.Utility\\Microsoft.PowerShell.Utility.psd1') -ErrorAction Stop
$script:ActualHashCommand = Microsoft.PowerShell.Core\\Get-Command Get-FileHash -ErrorAction Stop
"""
                    if fail_invocation:
                        setup = """
$script:InvocationCalls = 0
function Invoke-BrokenHash { $script:InvocationCalls++; throw 'Per-file command failure' }
$script:ActualHashCommand = Microsoft.PowerShell.Core\\Get-Command Invoke-BrokenHash -ErrorAction Stop
"""
                    result = _run_powershell(f"""
$ErrorActionPreference = 'Stop'
$script:FileHashCommandResolved = $false
$script:FileHashCommand = $null
$script:DiscoveryCalls = 0
{setup}
function Get-Command {{ $script:DiscoveryCalls++; return $script:ActualHashCommand }}
{_hash_helper(script)}
$path = {_ps_quote(path)}
foreach ($index in 1..3) {{
    if ((Get-FileHashValue $path) -ne '{_sha256(path)}') {{ throw 'SHA256 mismatch' }}
}}
if ($script:DiscoveryCalls -ne 1) {{ throw "Expected one discovery, got $script:DiscoveryCalls" }}
if ({'$true' if fail_invocation else '$false'} -and $script:InvocationCalls -ne 3) {{ throw 'Invocation failure must still read each file' }}
""")
                    self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


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

                apply_completed = subprocess.run(
                    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                     str(package_root / "update_lmo_audio.ps1"), "-TargetDir", str(target)],
                    cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90,
                )
                self.assertEqual(apply_completed.returncode, 0, apply_completed.stdout + apply_completed.stderr)
                self.assertIn("Update verification passed", apply_completed.stdout)
                verify_completed = subprocess.run(
                    ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File",
                     str(package_root / "verify_update.ps1"), "-TargetDir", str(target)],
                    cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=90,
                )
                self.assertEqual(verify_completed.returncode, 0, verify_completed.stdout + verify_completed.stderr)

                self.assertEqual((target / "lmo_audio.exe").read_text(encoding="utf-8"), "new app exe")
                self.assertEqual((target / "backend" / "main.py").read_text(encoding="utf-8"), "new backend")
                for relative in ("stale.py", "module/stale.txt", "retired/only.py", "shared/old.py"):
                    self.assertFalse((target / "backend" / relative).exists(), relative)
                self.assertFalse((target / "backend" / "retired").exists())
                self.assertEqual((target / "backend" / "shared" / "note.txt").read_text(encoding="utf-8"), "user note")
                self.assertEqual(
                    (target / "backend" / "templates" / "edited.docx").read_text(encoding="utf-8"),
                    "user edited template",
                )
                self.assertIn("Kept a changed file", apply_completed.stdout + apply_completed.stderr)
                for relative, content in BACKEND_USER_FILES.items():
                    self.assertEqual((target / relative).read_text(encoding="utf-8"), content, relative)
                self.assertEqual((target / "backend" / "outputs" / "keep.json").read_text(encoding="utf-8"), '{"keep":true}')
                self.assertEqual((target / "backend" / "nohash.py").read_text(encoding="utf-8"), "listed without a hash")
                self.assertFalse((target / "runtime" / "ollama" / "README.txt").exists())
                self.assertEqual(
                    (target / "runtime" / "ollama" / "ollama.exe").read_text(encoding="utf-8"), "downloaded runtime"
                )
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
                # The update does not ship runtime, so the installed (empty) runtime list stays.
                listed = {entry["path"] for entry in release_manifest["portablePayloadFiles"]}
                self.assertNotIn("runtime\\ollama\\README.txt", listed)
                self.assertIn("backend\\main.py", listed)
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


class UpdatePackageDataSafetyTest(unittest.TestCase):
    def test_create_update_package_ships_only_listed_files_with_installed_ollama(self):
        package_name = _package_name("test_update_listed_only")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = _make_fake_portable(Path(temp_dir), ollama_installed=True)
            before = _file_hashes(portable)
            try:
                completed = _create_package(portable, package_name)
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                payload = package_root / "payload"
                manifest = json.loads((package_root / "update-manifest.json").read_text(encoding="utf-8-sig"))
                payload_paths = {entry["path"] for entry in manifest["payloadFiles"]}
                self.assertEqual(payload_paths, {
                    "payload\\lmo_audio.exe",
                    "payload\\START_HERE.txt",
                    "payload\\binaries\\meeting-backend-x86_64-pc-windows-msvc.exe",
                    "payload\\backend\\ffmpeg.exe",
                    "payload\\backend\\main.py",
                    "payload\\backend\\module\\temp\\data.txt",
                    "payload\\backend\\module\\config.json",
                })
                for relative in BACKEND_USER_FILES:
                    self.assertFalse((payload / relative).exists(), relative)
                self.assertFalse((payload / "runtime").exists())
                self.assertTrue((package_root / "portable_data_safety.ps1").exists())
                self.assertIn("backend\\logs", manifest["preservedTargetPaths"])
                self.assertEqual(before, _file_hashes(portable))
            finally:
                shutil.rmtree(package_root, ignore_errors=True)

    def test_create_update_package_rejects_user_data_listed_as_payload(self):
        package_name = _package_name("test_update_listed_user_data")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as temp_dir:
            portable = _make_fake_portable(Path(temp_dir))
            manifest_path = portable / "release-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["portablePayloadFiles"].append(_entry(portable, "backend\\logs\\app.log"))
            manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
            try:
                completed = _create_package(portable, package_name)
                self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertIn("lists user data as package payload", completed.stdout + completed.stderr)
                self.assertFalse(package_root.exists())
            finally:
                shutil.rmtree(package_root, ignore_errors=True)

    def test_update_without_installed_package_list_keeps_unknown_backend_files(self):
        package_name = _package_name("test_update_no_list")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            portable = _make_fake_portable(Path(source_dir))
            target = _make_fake_target(Path(target_dir), with_package_list=False)
            try:
                self.assertEqual(_create_package(portable, package_name).returncode, 0)
                completed = _apply_package(package_root, target)
                self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertIn("no package file list", completed.stdout + completed.stderr)
                self.assertEqual((target / "backend" / "main.py").read_text(encoding="utf-8"), "new backend")
                # Without the installed list nothing can be proven package-owned.
                self.assertEqual((target / "backend" / "stale.py").read_text(encoding="utf-8"), "stale backend file")
                for relative, content in BACKEND_USER_FILES.items():
                    self.assertEqual((target / relative).read_text(encoding="utf-8"), content, relative)
            finally:
                shutil.rmtree(package_root, ignore_errors=True)

    def test_update_does_not_trust_lists_from_older_handoffs(self):
        package_name = _package_name("test_update_old_handoff")
        package_root = ROOT / "releases" / "updates" / package_name
        old_handoff = {"packageFormat": "lmo-audio-slim-handoff-v1"}
        for block, stale_removed in ((old_handoff, False), ({**old_handoff, "payloadList": "build"}, True)):
            with self.subTest(payloadList=block.get("payloadList")), \
                    tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
                portable = _make_fake_portable(Path(source_dir))
                target = _make_fake_target(Path(target_dir), handoff_block=block)
                try:
                    self.assertEqual(_create_package(portable, package_name).returncode, 0)
                    completed = _apply_package(package_root, target)
                    self.assertEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                    self.assertEqual((target / "backend" / "stale.py").exists(), not stale_removed)
                    self.assertEqual("no package file list" in completed.stdout + completed.stderr, not stale_removed)
                    for relative, content in BACKEND_USER_FILES.items():
                        self.assertEqual((target / relative).read_text(encoding="utf-8"), content, relative)
                finally:
                    shutil.rmtree(package_root, ignore_errors=True)

    def test_update_refuses_custom_data_layout_before_touching_target(self):
        package_name = _package_name("test_update_custom_layout")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            portable = _make_fake_portable(Path(source_dir))
            target = _make_fake_target(Path(target_dir))
            _write(target / "backend" / "config.json", json.dumps({"paths": {"output_dir": "./my-results"}}))
            _write(target / "backend" / "my-results" / "meeting.json", "custom records")
            before = _file_hashes(target)
            try:
                self.assertEqual(_create_package(portable, package_name).returncode, 0)
                completed = _apply_package(package_root, target)
                self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertIn("Unsupported portable data layout", completed.stdout + completed.stderr)
                self.assertEqual(before, _file_hashes(target))
            finally:
                shutil.rmtree(package_root, ignore_errors=True)

    def test_update_refuses_package_that_would_overwrite_user_data(self):
        package_name = _package_name("test_update_overwrite_user_data")
        package_root = ROOT / "releases" / "updates" / package_name
        with tempfile.TemporaryDirectory() as source_dir, tempfile.TemporaryDirectory() as target_dir:
            portable = _make_fake_portable(Path(source_dir))
            target = _make_fake_target(Path(target_dir))
            before = _file_hashes(target)
            try:
                self.assertEqual(_create_package(portable, package_name).returncode, 0)
                planted = package_root / "payload" / "backend" / "outputs" / "keep.json"
                _write(planted, '{"replaced":true}')
                manifest_path = package_root / "update-manifest.json"
                manifest = json.loads(manifest_path.read_text(encoding="utf-8-sig"))
                manifest["payloadFiles"].append(_entry(package_root, "payload\\backend\\outputs\\keep.json"))
                manifest_path.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
                completed = _apply_package(package_root, target)
                self.assertNotEqual(completed.returncode, 0, completed.stdout + completed.stderr)
                self.assertIn("would overwrite user data", completed.stdout + completed.stderr)
                self.assertEqual(before, _file_hashes(target))
            finally:
                shutil.rmtree(package_root, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
