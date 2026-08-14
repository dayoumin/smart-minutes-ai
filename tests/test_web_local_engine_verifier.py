from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import verify_web_local_engine_poc as verifier  # noqa: E402


class WebLocalEngineVerifierTest(unittest.TestCase):
    def _write_artifact(self, root: Path) -> Path:
        artifact = root / "artifact"
        files = {
            "engine/ffmpeg.exe": b"ffmpeg",
            "engine/engine.exe": b"engine",
            "defaults/config.json": b"{}",
        }
        payload = []
        for relative, content in files.items():
            path = artifact / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            payload.append({
                "path": relative.replace("/", "\\"),
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            })
        (artifact / "poc-manifest.json").write_text(json.dumps({
            "distributionReady": False,
            "signed": False,
            "bind": "127.0.0.1:17863",
            "payloadFiles": payload,
        }), encoding="utf-8")
        return artifact

    def test_manifest_is_closed_world_and_rejects_unlisted_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact = self._write_artifact(Path(temp_dir))
            _manifest, snapshot = verifier.verify_manifest(artifact)
            self.assertEqual(len(snapshot), 3)

            (artifact / "engine" / "unexpected.dll").write_bytes(b"unexpected")
            with self.assertRaisesRegex(RuntimeError, "file set mismatch"):
                verifier.verify_manifest(artifact)

    def test_manifest_rejects_duplicate_and_traversal_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = self._write_artifact(root)
            manifest_path = artifact / "poc-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["payloadFiles"].append(dict(manifest["payloadFiles"][0]))
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "duplicated"):
                verifier.verify_manifest(artifact)

            outside = root / "outside.bin"
            outside.write_bytes(b"outside")
            manifest["payloadFiles"] = manifest["payloadFiles"][:-1]
            manifest["payloadFiles"].append({
                "path": "../outside.bin",
                "bytes": outside.stat().st_size,
                "sha256": hashlib.sha256(outside.read_bytes()).hexdigest(),
            })
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "unsafe"):
                verifier.verify_manifest(artifact)

    def test_start_probe_failure_always_reaps_the_engine(self) -> None:
        process = MagicMock()
        process.poll.return_value = None
        with (
            patch.object(verifier, "start_process", return_value=process),
            patch.object(verifier, "wait_for_probe", side_effect=RuntimeError("not ready")),
        ):
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                verifier.start_and_probe(
                    Path("engine.exe"),
                    {},
                    "https://minutes.example",
                )
        process.kill.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=5)

    @unittest.skipUnless(os.name == "nt", "Windows read-only payload attributes")
    def test_read_only_payload_attributes_are_restored(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact = self._write_artifact(Path(temp_dir))
            handles = verifier.lock_install_files_read_only(artifact)
            config = artifact / "defaults" / "config.json"
            self.assertTrue(verifier.windows_file_write_is_denied(config))
            verifier.close_install_read_locks(handles)
            self.assertFalse(verifier.windows_file_write_is_denied(config))


if __name__ == "__main__":
    unittest.main()
