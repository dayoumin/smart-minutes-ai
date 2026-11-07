import hashlib
import io
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from resumable_download import download_pinned_file, partial_size


class Response(io.BytesIO):
    def __init__(self, data, status=200, content_range=""):
        super().__init__(data)
        self.status = status
        self.headers = {"Content-Range": content_range}


class ResumableDownloadTest(unittest.TestCase):
    payload = b"a pinned executable archive"
    url = "https://example.invalid/pinned.zip"

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.part = Path(self.temp.name) / "runtime.zip.part"
        self.sha = hashlib.sha256(self.payload).hexdigest()

    def download(self, *, cancelled=lambda: False, progress=lambda *_: None, sha=None):
        download_pinned_file(self.part, url=self.url, sha256=sha or self.sha,
                             expected_bytes=len(self.payload), cancelled=cancelled,
                             progress=progress, chunk_bytes=4)

    def stop_after_prefix(self):
        counts = []
        with patch("urllib.request.urlopen", return_value=Response(self.payload)):
            with self.assertRaises(InterruptedError):
                self.download(cancelled=lambda: bool(counts and counts[-1] >= 8),
                              progress=lambda count, _: counts.append(count))
        self.assertEqual(self.part.read_bytes(), self.payload[:8])

    def test_stop_retains_prefix_and_resume_verifies_entire_file(self):
        self.stop_after_prefix()
        with patch("urllib.request.urlopen", return_value=Response(self.payload[8:], 206, f"bytes 8-{len(self.payload)-1}/{len(self.payload)}")) as opened:
            self.download()
        self.assertEqual(opened.call_args.args[0].get_header("Range"), "bytes=8-")
        self.assertEqual(self.part.read_bytes(), self.payload)

    def test_ignored_range_replaces_instead_of_appending(self):
        self.stop_after_prefix()
        with patch("urllib.request.urlopen", return_value=Response(self.payload)):
            self.download()
        self.assertEqual(self.part.read_bytes(), self.payload)

    def test_wrong_range_is_rejected_without_changing_prefix(self):
        self.stop_after_prefix()
        with patch("urllib.request.urlopen", return_value=Response(self.payload, 206, "bytes 0-4/5")):
            with self.assertRaisesRegex(RuntimeError, "range"):
                self.download()
        self.assertEqual(self.part.read_bytes(), self.payload[:8])

    def test_checksum_covers_existing_prefix(self):
        self.stop_after_prefix()
        self.part.write_bytes(b"x" * 8)
        with patch("urllib.request.urlopen", return_value=Response(self.payload[8:], 206, f"bytes 8-{len(self.payload)-1}/{len(self.payload)}")):
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                self.download()
        self.assertFalse(self.part.exists())

    def test_changed_identity_restarts_from_zero(self):
        self.stop_after_prefix()
        with patch("urllib.request.urlopen", return_value=Response(self.payload)) as opened:
            with self.assertRaisesRegex(RuntimeError, "checksum"):
                self.download(sha="0" * 64)
        self.assertIsNone(opened.call_args.args[0].get_header("Range"))

    def test_complete_partial_is_verified_without_network(self):
        with patch("urllib.request.urlopen", return_value=Response(self.payload)):
            self.download()
        with patch("urllib.request.urlopen", side_effect=AssertionError("No network needed")):
            self.download()
        self.assertEqual(partial_size(self.part, self.url, self.sha, len(self.payload)), len(self.payload))

    def test_short_response_keeps_prefix_for_retry(self):
        with patch("urllib.request.urlopen", return_value=Response(self.payload[:8])):
            with self.assertRaisesRegex(RuntimeError, "incomplete"):
                self.download()
        self.assertEqual(self.part.read_bytes(), self.payload[:8])

    def test_network_failure_retains_partial(self):
        self.stop_after_prefix()
        with patch("urllib.request.urlopen", side_effect=OSError("offline")):
            with self.assertRaises(OSError):
                self.download()
        self.assertEqual(self.part.read_bytes(), self.payload[:8])

    def test_oversized_response_cannot_be_installed(self):
        with patch("urllib.request.urlopen", return_value=Response(self.payload + b"extra")):
            with self.assertRaisesRegex(RuntimeError, "exceeded"):
                self.download()


if __name__ == "__main__":
    unittest.main()
