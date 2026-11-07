"""Resume a pinned download without trusting a partial file as a finished file."""

import hashlib
import hmac
import json
import re
import urllib.request
from pathlib import Path


def partial_size(part: Path, url: str, sha256: str, expected_bytes: int) -> int:
    try:
        identity = json.loads(part.with_suffix(part.suffix + ".json").read_text(encoding="utf-8"))
        size = part.stat().st_size
        if identity == {"url": url, "sha256": sha256, "expected_bytes": expected_bytes} and 0 < size <= expected_bytes:
            return size
    except (OSError, ValueError):
        pass
    return 0


def download_pinned_file(part: Path, *, url: str, sha256: str, expected_bytes: int,
                         cancelled, progress, chunk_bytes: int) -> None:
    """Keep partial bytes on interruption; verify the entire file before returning."""
    metadata = part.with_suffix(part.suffix + ".json")
    if part.is_symlink() or metadata.is_symlink():
        raise RuntimeError("Download files must not be symbolic links.")
    offset = partial_size(part, url, sha256, expected_bytes)
    if not offset:
        # Only our exact temporary download is replaced, never installed files.
        part.write_bytes(b"")
    metadata.write_text(json.dumps({"url": url, "sha256": sha256, "expected_bytes": expected_bytes}), encoding="utf-8")
    if cancelled():
        raise InterruptedError("stopped")
    if offset < expected_bytes:
        headers = {"User-Agent": "LMO-audio-runtime-downloader", "Accept-Encoding": "identity"}
        if offset:
            headers["Range"] = f"bytes={offset}-"
        request = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(request, timeout=30) as response:
            code = getattr(response, "status", 200)
            if code == 206:
                match = re.fullmatch(r"bytes (\d+)-(\d+)/(\d+)", response.headers.get("Content-Range", ""))
                if not match or tuple(map(int, match.groups())) != (offset, expected_bytes - 1, expected_bytes):
                    raise RuntimeError("Unexpected download range.")
            elif code == 200:
                offset = 0  # Server ignored Range: replace rather than append.
            else:
                raise RuntimeError(f"Unexpected download response: {code}")
            progress(offset, expected_bytes)
            with part.open("ab" if offset else "wb") as handle:
                while True:
                    if cancelled():
                        raise InterruptedError("stopped")
                    chunk = response.read(min(chunk_bytes, expected_bytes - offset + 1))
                    if not chunk:
                        break
                    if offset + len(chunk) > expected_bytes:
                        raise RuntimeError("Downloaded file exceeded the pinned size.")
                    handle.write(chunk)
                    offset += len(chunk)
                    progress(offset, expected_bytes)
        if offset != expected_bytes:
            raise RuntimeError("Downloaded file was incomplete.")
    progress(offset, expected_bytes)
    digest = hashlib.sha256()
    with part.open("rb") as handle:
        while chunk := handle.read(chunk_bytes):
            if cancelled():
                raise InterruptedError("stopped")
            digest.update(chunk)
    if not sha256 or not hmac.compare_digest(digest.hexdigest(), sha256.lower()):
        part.unlink(missing_ok=True)
        metadata.unlink(missing_ok=True)
        raise RuntimeError("Downloaded Ollama runtime checksum did not match.")
