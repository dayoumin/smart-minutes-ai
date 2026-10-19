import json
import os
from pathlib import Path
import tempfile
import unittest
import io
import urllib.request
import urllib.response
import subprocess
from unittest.mock import patch

from scripts import replay_summary_diagnostics as replay


class SummaryDiagnosticsReplayTest(unittest.TestCase):
    @unittest.skipUnless(os.name == "nt", "Windows private-folder ACL")
    def test_private_directory_extracts_sid_without_decoding_account_name(self):
        identity = '\"한글사용자\\계정\",\"S-1-5-21-123-456-789-1001\"\r\n'.encode("utf-8")
        with tempfile.TemporaryDirectory() as tmp, patch.object(replay.subprocess, "run", side_effect=[
            subprocess.CompletedProcess([], 0, stdout=identity), subprocess.CompletedProcess([], 0),
        ]) as command:
            run = replay.private_run_directory(Path(tmp))
            self.assertTrue(run.is_dir())
            self.assertFalse(command.call_args_list[0].kwargs.get("text", False))
            self.assertIn("*S-1-5-21-123-456-789-1001:(OI)(CI)F", command.call_args_list[1].args[0])

    def fixture(self, root):
        outputs = root / "outputs"
        outputs.mkdir()
        source = outputs / "job_result.json"
        source.write_text(json.dumps({
            "job_id": "job", "segments": [{"text": "raw source"}],
            "display_segments": [{"text": "display source"}],
            "summary": {"overview": "original", "title": "original title"},
        }), encoding="utf-8")
        criteria = root / "criteria.json"
        criteria.write_text(json.dumps({
            "required_topics": [{"position": part, "topic": part} for part in ("beginning", "middle", "end")],
            "decision_rule": "explicit agreement only", "attribution_rule": "no inferred identities",
        }), encoding="utf-8")
        return source, criteria

    def test_prepare_creates_fresh_snapshots_without_runtime_or_source_changes(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(replay, "runtime_identity") as runtime:
            root = Path(tmp)
            source, criteria = self.fixture(root)
            before = source.read_bytes(), source.stat().st_mtime_ns
            runs = [replay.replay(source, criteria, root / "private", "model", "http://127.0.0.1:17965", prepare_only=True) for _ in range(2)]
            self.assertNotEqual(runs[0], runs[1])
            for run in runs:
                manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
                self.assertEqual(manifest["source_sha256"], replay.digest(before[0]))
                self.assertTrue(manifest["source_unchanged"])
                self.assertFalse(manifest["inference_executed"])
                self.assertEqual(manifest["semantic_quality"], "not_evaluated")
                self.assertEqual((run / "source-result.json").read_bytes(), before[0])
                self.assertTrue((run / "events.jsonl").exists())
                self.assertIsNone(json.loads((run / "final-summary.json").read_text(encoding="utf-8")))
            self.assertEqual((source.read_bytes(), source.stat().st_mtime_ns), before)
            runtime.assert_not_called()

    def test_generation_uses_display_segments_and_restores_process_environment(self):
        def generate(segments, model, *, meeting_context, diagnostic_callback):
            self.assertEqual(segments, [{"text": "display source"}])
            self.assertEqual(meeting_context["title"], "original title")
            self.assertEqual(os.environ["OLLAMA_HOST"], "127.0.0.1:17965")
            diagnostic_callback({"event": "raw_response", "response": "private response"})
            return {"overview": "generated"}
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(replay, "runtime_identity", return_value={"model": {"digest": "fixture"}}), \
                patch.object(replay, "summarize_meeting", side_effect=generate), \
                patch.dict(os.environ, {"OLLAMA_HOST": "original:11434"}):
            root = Path(tmp)
            source, criteria = self.fixture(root)
            run = replay.replay(source, criteria, root / "private", "model", "http://127.0.0.1:17965")
            self.assertEqual(os.environ["OLLAMA_HOST"], "original:11434")
            manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "generated_unreviewed")
            self.assertEqual(json.loads((run / "final-summary.json").read_text(encoding="utf-8")), {"overview": "generated"})
            self.assertIn("private response", (run / "events.jsonl").read_text(encoding="utf-8"))

    def test_preflight_failure_leaves_readable_manifest_and_no_inference(self):
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(replay, "runtime_identity", side_effect=ConnectionError("private error")), \
                patch.object(replay, "summarize_meeting") as generate:
            root = Path(tmp)
            source, criteria = self.fixture(root)
            with self.assertRaises(ConnectionError):
                replay.replay(source, criteria, root / "private", "model", "http://127.0.0.1:17965")
            run = next((root / "private").iterdir())
            manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
            self.assertEqual(manifest["status"], "failed")
            self.assertNotIn("private error", json.dumps(manifest))
            self.assertTrue(manifest["source_unchanged"])
            generate.assert_not_called()

    def test_actual_generation_ignores_external_proxy_and_never_uses_default_urlopen(self):
        requests = []
        def send(_handler, request):
            requests.append(request)
            data = json.dumps({"response": '{"overview":"generated locally"}',
                               "prompt_eval_count": 123, "eval_count": 45, "done_reason": "stop"}).encode()
            response = urllib.response.addinfourl(io.BytesIO(data), {}, request.full_url, 200)
            response.msg = "OK"
            return response
        with tempfile.TemporaryDirectory() as tmp, \
                patch.object(replay, "runtime_identity", return_value={"model": {"digest": "fixture"}}), \
                patch.dict(os.environ, {"HTTP_PROXY": "http://proxy.example:8080", "http_proxy": "http://proxy.example:8080", "NO_PROXY": "", "no_proxy": ""}), \
                patch.object(urllib.request.HTTPHandler, "http_open", send), \
                patch.object(urllib.request, "urlopen", side_effect=AssertionError("default transport must not receive source text")):
            root = Path(tmp)
            source, criteria = self.fixture(root)
            run = replay.replay(source, criteria, root / "private", "model", "http://127.0.0.1:17965")
            self.assertEqual(len(requests), 1)
            self.assertEqual(requests[0].host, "127.0.0.1:17965")
            self.assertIn("display source", json.loads(requests[0].data)["prompt"])
            self.assertEqual(json.loads((run / "final-summary.json").read_text(encoding="utf-8"))["overview"], "generated locally")
            trace = [json.loads(line) for line in (run / "events.jsonl").read_text(encoding="utf-8").splitlines()]
            metadata = next(event for event in trace if event["event"] == "provider_metadata")
            self.assertEqual(metadata["stage"], "direct")
            self.assertEqual(metadata["metadata"], {"prompt_eval_count": 123, "eval_count": 45, "done_reason": "stop"})

    def test_local_opener_refuses_generation_redirects(self):
        opener = replay.local_opener()
        handler = next(handler for handler in opener.handlers if isinstance(handler, urllib.request.HTTPRedirectHandler))
        request = urllib.request.Request("http://127.0.0.1:17965/api/generate", data=b"private prompt")
        self.assertIsNone(handler.redirect_request(request, None, 302, "found", {}, "https://external.example"))

    def test_remote_endpoints_frontend_records_and_output_folder_writes_are_rejected(self):
        for url in ("https://example.com", "http://example.com", "http://127.0.0.1/api", "http://user:pass@localhost", "http://localhost?x=1"):
            with self.subTest(url=url), self.assertRaises(ValueError):
                replay.local_base_url(url)
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, criteria = self.fixture(root)
            with self.assertRaises(ValueError):
                replay.replay(source, criteria, source.parent / "new", "model", "http://localhost")
            source.write_text('{"jobId":"frontend","segments":[{"text":"source"}]}')
            with self.assertRaises(ValueError):
                replay.replay(source, criteria, root / "private", "model", "http://localhost")

    def test_criteria_for_a_different_source_cannot_be_replayed(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source, criteria = self.fixture(root)
            data = json.loads(criteria.read_text(encoding="utf-8"))
            data["source_sha256"] = "0" * 64
            criteria.write_text(json.dumps(data))
            with self.assertRaisesRegex(ValueError, "different source"):
                replay.replay(source, criteria, root / "private", "model", "http://localhost")
            self.assertFalse((root / "private").exists())


if __name__ == "__main__":
    unittest.main()
