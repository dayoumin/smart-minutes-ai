"""Reuse the exact helper from a checksum-verified NSIS installer; execute nothing."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import struct
import zlib

from PyInstaller.archive.readers import CArchiveReader

MAX_BLOCK = 64 * 1024 * 1024


def extract_helper(installer: Path, descriptor: Path, output: Path, engine_version: str) -> dict:
    metadata = json.loads(descriptor.read_text(encoding="utf-8-sig"))
    if (metadata.get("packageFormat") != "barorok-web-local-engine-installer-poc-v1"
            or metadata.get("engineVersion") != engine_version):
        raise ValueError("Reference installer format/version mismatch")
    identity = metadata["installer"]
    if (identity.get("file") != installer.name or type(identity.get("bytes")) is not int
            or not re.fullmatch(r"[0-9a-f]{64}", str(identity.get("sha256", "")))):
        raise ValueError("Reference installer descriptor is invalid")
    with installer.open("rb") as stream:
        if installer.stat().st_size != identity["bytes"]:
            raise ValueError("Reference installer size mismatch")
        if hashlib.file_digest(stream, "sha256").hexdigest() != identity["sha256"]:
            raise ValueError("Reference installer SHA256 mismatch")
        stream.seek(0)
        header = stream.read(100000)
        signature = header.index(bytes.fromhex("efbeadde") + b"NullsoftInst")
        stream.seek(signature - 4 + 28)
        for _ in range(8):
            raw_size = stream.read(4)
            if len(raw_size) != 4:
                break
            size = struct.unpack("<I", raw_size)[0]
            length = size & 0x7fffffff
            if length > MAX_BLOCK:
                raise ValueError("NSIS block exceeds diagnostic extraction limit")
            packed = stream.read(length)
            if len(packed) != length:
                raise ValueError("NSIS block is truncated")
            if size & 0x80000000:
                reader = zlib.decompressobj(-15)
                data = reader.decompress(packed, MAX_BLOCK + 1)
                if len(data) > MAX_BLOCK or not reader.eof or reader.unconsumed_tail:
                    raise ValueError("NSIS decompression exceeds diagnostic extraction limit")
            else:
                data = packed
            if not data.startswith(b"MZ") or b"MEI\x0c\x0b\x0a\x0b\x0e" not in data:
                continue
            output.parent.mkdir(parents=True, exist_ok=True)
            with output.open("xb") as destination:
                destination.write(data)
            try:
                archive = CArchiveReader(str(output))
                if not {"web_local_engine_installer_preflight", "base_library.zip"}.issubset(archive.toc):
                    raise ValueError("NSIS member is not the installer preflight helper")
            except Exception:
                output.unlink()  # Only the file created above; never an existing file.
                raise
            return {"referenceInstallerSha256": identity["sha256"], "helperBytes": len(data),
                    "helperSha256": hashlib.sha256(data).hexdigest(), "helperRebuilt": False}
    raise ValueError("Verified installer did not contain the expected helper")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--installer", type=Path, required=True)
    parser.add_argument("--descriptor", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--engine-version", required=True)
    args = parser.parse_args()
    print(json.dumps(extract_helper(args.installer, args.descriptor, args.output, args.engine_version)))
