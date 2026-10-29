import hashlib
import json
from pathlib import Path
import struct
import tempfile
import unittest
from unittest.mock import patch
import zlib

from scripts import extract_installer_diagnostic_helper as extraction

ROOT = Path(__file__).resolve().parents[1]


class InstallerDiagnosticHelperTest(unittest.TestCase):
    def _fixture(self, folder, data=None):
        payload = data or b"MZ" + b"fixture" + b"MEI\x0c\x0b\x0a\x0b\x0e"
        encoder = zlib.compressobj(wbits=-15)
        packed = encoder.compress(payload) + encoder.flush()
        header = b"\0" * 4 + bytes.fromhex("efbeadde") + b"NullsoftInst" + b"\0" * 8
        installer = folder / "reference.exe"
        installer.write_bytes(header + struct.pack("<I", len(packed) | 0x80000000) + packed)
        metadata = {"packageFormat": "barorok-web-local-engine-installer-poc-v1", "engineVersion": "fixture",
                    "installer": {"file": installer.name, "bytes": installer.stat().st_size,
                                  "sha256": hashlib.sha256(installer.read_bytes()).hexdigest()}}
        descriptor = folder / "descriptor.json"
        descriptor.write_text(json.dumps(metadata), encoding="utf-8")
        return installer, descriptor, folder / "helper.exe", payload, metadata

    def test_helper_bytes_are_reused_without_running_or_rebuilding_them(self):
        with tempfile.TemporaryDirectory(dir=ROOT / ".tmp") as value:
            installer, descriptor, output, payload, metadata = self._fixture(Path(value))
            with patch.object(extraction, "CArchiveReader") as archive:
                archive.return_value.toc = {"web_local_engine_installer_preflight": None, "base_library.zip": None}
                report = extraction.extract_helper(installer, descriptor, output, "fixture")
            self.assertEqual(output.read_bytes(), payload)
            self.assertEqual(report["helperSha256"], hashlib.sha256(payload).hexdigest())
            self.assertEqual(report["referenceInstallerSha256"], metadata["installer"]["sha256"])
            self.assertIs(report["helperRebuilt"], False)

    def test_mismatched_identity_is_rejected_before_creating_output(self):
        for field, replacement in (("sha256", "0" * 64), ("bytes", 1), ("engineVersion", "different")):
            with self.subTest(field=field), tempfile.TemporaryDirectory(dir=ROOT / ".tmp") as value:
                installer, descriptor, output, _, metadata = self._fixture(Path(value))
                if field == "engineVersion":
                    metadata[field] = replacement
                else:
                    metadata["installer"][field] = replacement
                descriptor.write_text(json.dumps(metadata), encoding="utf-8")
                with self.assertRaises(ValueError):
                    extraction.extract_helper(installer, descriptor, output, "fixture")
                self.assertFalse(output.exists())

    def test_existing_output_and_decompression_limit_are_preserved(self):
        with tempfile.TemporaryDirectory(dir=ROOT / ".tmp") as value:
            installer, descriptor, output, _, _ = self._fixture(Path(value))
            output.write_bytes(b"user sentinel")
            with self.assertRaises(FileExistsError):
                extraction.extract_helper(installer, descriptor, output, "fixture")
            self.assertEqual(output.read_bytes(), b"user sentinel")
        with tempfile.TemporaryDirectory(dir=ROOT / ".tmp") as value:
            installer, descriptor, output, _, _ = self._fixture(Path(value), b"MZ" + b"x" * 5000)
            with patch.object(extraction, "MAX_BLOCK", 256), self.assertRaisesRegex(ValueError, "limit"):
                extraction.extract_helper(installer, descriptor, output, "fixture")
            self.assertFalse(output.exists())


if __name__ == "__main__":
    unittest.main()
