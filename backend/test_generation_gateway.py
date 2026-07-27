import json
import socket
import subprocess
import sys
import unittest
import urllib.error
from pathlib import Path
from unittest.mock import patch

BACKEND_DIR = str(Path(__file__).resolve().parent)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import generation_gateway


class GenerationGatewayTest(unittest.TestCase):
    def test_classifies_known_failure_categories(self) -> None:
        cases = [
            (FileNotFoundError("ollama"), "runtime_missing"),
            (TimeoutError("late"), "request_timeout"),
            (socket.timeout("late"), "request_timeout"),
            (json.JSONDecodeError("bad", "x", 0), "invalid_model_response"),
            (urllib.error.HTTPError("http://local", 404, "missing", {}, None), "model_missing"),
            (urllib.error.URLError(ConnectionRefusedError()), "server_unreachable"),
            (RuntimeError("raw internal detail"), "generation_internal_error"),
        ]
        for error, expected_code in cases:
            with self.subTest(expected_code=expected_code):
                failure = generation_gateway.classify_generation_exception(error)
                self.assertEqual(failure.code, expected_code)
                self.assertNotIn("raw internal detail", failure.user_message)

    def test_missing_runtime_is_reported_before_start_attempt(self) -> None:
        with (
            patch.object(generation_gateway, "ollama_executable_available", return_value=False),
            patch.object(generation_gateway, "ensure_ollama_server_running") as ensure_runtime,
        ):
            with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                generation_gateway._ensure_runtime()

        self.assertEqual(raised.exception.code, "runtime_missing")
        self.assertEqual(raised.exception.user_action, "open_settings")
        ensure_runtime.assert_not_called()

    def test_timeout_does_not_retry_with_cli(self) -> None:
        with (
            patch.object(generation_gateway, "_generate_with_http", side_effect=TimeoutError("late")),
            patch.object(generation_gateway, "_generate_with_cli") as cli_generate,
        ):
            with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                generation_gateway.generate_ollama_text("gemma4:e2b", "prompt")

        self.assertEqual(raised.exception.code, "request_timeout")
        cli_generate.assert_not_called()

    def test_connection_refused_can_use_cli_once(self) -> None:
        with (
            patch.object(
                generation_gateway,
                "_generate_with_http",
                side_effect=urllib.error.URLError(ConnectionRefusedError()),
            ),
            patch.object(generation_gateway, "_generate_with_cli", return_value='{"summary":"ok"}') as cli_generate,
        ):
            result = generation_gateway.generate_ollama_text("gemma4:e2b", "prompt")

        self.assertEqual(result, '{"summary":"ok"}')
        cli_generate.assert_called_once_with("gemma4:e2b", "prompt")

    def test_cli_failure_does_not_expose_raw_process_output(self) -> None:
        process_error = subprocess.CalledProcessError(
            1,
            ["ollama", "run"],
            stderr="private path and stack trace",
        )
        with (
            patch.object(
                generation_gateway,
                "_generate_with_http",
                side_effect=urllib.error.URLError(ConnectionRefusedError()),
            ),
            patch.object(generation_gateway, "_generate_with_cli", side_effect=process_error),
        ):
            with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                generation_gateway.generate_ollama_text("gemma4:e2b", "prompt")

        self.assertEqual(raised.exception.code, "generation_internal_error")
        self.assertNotIn("private path", raised.exception.user_message)


if __name__ == "__main__":
    unittest.main()
