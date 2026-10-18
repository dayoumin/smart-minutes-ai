import json
import unittest
from io import BytesIO
from unittest.mock import patch

import model_manager


class OllamaModelListTest(unittest.TestCase):
    def test_reads_names_from_configured_runtime_without_starting_cli(self):
        payload = {"models": [{"name": "gemma4:e2b"}, {"name": "gemma4:e4b"},
                              {"name": "gemma4:e2b"}, None, {"name": 2}, {"name": " "}]}
        with (
            patch.object(model_manager, "ensure_ollama_server_running", return_value=True) as start,
            patch.object(model_manager, "get_ollama_base_url", return_value="http://127.0.0.1:12281"),
            patch.object(model_manager.urllib.request, "urlopen", return_value=BytesIO(json.dumps(payload).encode())) as request,
            patch("subprocess.Popen") as subprocess_start,
        ):
            self.assertEqual(model_manager.list_ollama_models(), ["gemma4:e2b", "gemma4:e4b"])
        start.assert_called_once_with(timeout_seconds=10)
        request.assert_called_once_with("http://127.0.0.1:12281/api/tags", timeout=5)
        subprocess_start.assert_not_called()

    def test_passive_lookup_reads_running_server_without_starting_it(self):
        with (
            patch.object(model_manager, "probe_ollama_server", return_value=True),
            patch.object(model_manager, "ensure_ollama_server_running") as start,
            patch.object(model_manager.urllib.request, "urlopen", return_value=BytesIO(b'{"models":[{"name":"gemma4:e2b"}]}')),
        ):
            self.assertTrue(model_manager.ollama_model_exists("gemma4:e2b", start_server=False))
        start.assert_not_called()

    def test_unavailable_server_does_not_attempt_model_request(self):
        for passive in (False, True):
            with (
                self.subTest(passive=passive),
                patch.object(model_manager, "probe_ollama_server", return_value=False),
                patch.object(model_manager, "ensure_ollama_server_running", return_value=False),
                patch.object(model_manager.urllib.request, "urlopen") as request,
            ):
                self.assertEqual(model_manager.list_ollama_models(start_server=not passive), [])
                request.assert_not_called()

    def test_failed_or_malformed_response_returns_empty_list(self):
        for body in (b'not json', b'null', b'[]', b'{"models":null}', b'{"models":{}}', b'{}'):
            with (
                self.subTest(body=body),
                patch.object(model_manager, "ensure_ollama_server_running", return_value=True),
                patch.object(model_manager.urllib.request, "urlopen", return_value=BytesIO(body)),
            ):
                self.assertEqual(model_manager.list_ollama_models(), [])
        with (
            patch.object(model_manager, "ensure_ollama_server_running", return_value=True),
            patch.object(model_manager.urllib.request, "urlopen", side_effect=TimeoutError("busy")),
        ):
            self.assertEqual(model_manager.list_ollama_models(), [])

    def test_strict_inventory_distinguishes_empty_store_from_failed_lookup(self):
        for body, complete in (
            (b'{"models":[]}', True), (b'{}', False), (b'{"models":[{"name":3}]}', False),
        ):
            with (
                self.subTest(body=body),
                patch.object(model_manager.urllib.request, "urlopen", return_value=BytesIO(body)),
                patch.object(model_manager, "ensure_ollama_server_running") as start,
                patch.object(model_manager, "probe_ollama_server") as probe,
            ):
                inventory = model_manager.read_ollama_model_inventory(server_prepared=True)
            self.assertEqual(inventory.complete, complete)
            self.assertEqual(inventory.models, ())
            start.assert_not_called()
            probe.assert_not_called()

    def test_strict_inventory_http_and_timeout_failures_are_not_confirmed_absence(self):
        import urllib.error

        for error in (TimeoutError("busy"), urllib.error.HTTPError("http://local", 503, "busy", {}, None)):
            with (
                self.subTest(error=type(error).__name__),
                patch.object(model_manager.urllib.request, "urlopen", side_effect=error),
            ):
                inventory = model_manager.read_ollama_model_inventory(server_prepared=True)
            self.assertFalse(inventory.complete)
            self.assertEqual(inventory.models, ())


if __name__ == "__main__":
    unittest.main()
