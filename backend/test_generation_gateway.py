import json
import socket
import subprocess
import sys
import unittest
import urllib.error
from pathlib import Path
from io import BytesIO
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

    def test_model_that_does_not_fit_in_memory_points_at_settings(self) -> None:
        body = b'{"error":"model requires more system memory (12.4 GiB) than is available (7.8 GiB)"}'
        http_error = urllib.error.HTTPError("http://local", 500, "Internal Server Error", {}, BytesIO(body))
        first = generation_gateway.classify_generation_exception(http_error)
        # Classified twice (log + caller): the body is read once and the answer stays the same.
        second = generation_gateway.classify_generation_exception(http_error)
        for failure in (first, second):
            self.assertEqual(failure.code, "model_too_large")
            self.assertFalse(failure.retryable)
            self.assertEqual(failure.user_action, "open_settings")
            self.assertNotIn("GiB", failure.user_message)
        vram = urllib.error.HTTPError("http://local", 500, "err", {}, BytesIO(b'{"error":"cudaMalloc failed: out of memory"}'))
        self.assertEqual(generation_gateway.classify_generation_exception(vram).code, "model_too_large")
        cli = subprocess.CalledProcessError(1, ["ollama", "run"], stderr="Error: model requires more system memory")
        self.assertEqual(generation_gateway.classify_generation_exception(cli).code, "model_too_large")
        paging = urllib.error.HTTPError("http://local", 500, "err", {}, BytesIO(b'{"error":"The paging file is too small for this operation to complete."}'))
        self.assertEqual(generation_gateway.classify_generation_exception(paging).code, "model_too_large")
        other = urllib.error.HTTPError("http://local", 500, "err", {}, BytesIO(b'{"error":"unexpected EOF"}'))
        self.assertEqual(generation_gateway.classify_generation_exception(other).code, "generation_internal_error")

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

    def test_preparing_failure_remains_retryable_with_existing_detail_contract(self) -> None:
        failure = generation_gateway.failure_for_code("runtime_preparing")
        self.assertEqual(failure.http_status, 503)
        self.assertEqual(failure.as_detail("summary"), {
            "code": "runtime_preparing", "message": failure.user_message,
            "retryable": True, "user_action": "retry", "generation_kind": "summary",
        })

    def test_prepared_runtime_is_scoped_to_the_model_and_operation(self) -> None:
        with (
            patch.object(generation_gateway, "ollama_executable_available", return_value=True),
            patch.object(generation_gateway, "ensure_ollama_server_running", return_value=True) as ensure,
        ):
            with generation_gateway.prepared_ollama_runtime("gemma4:e4b"):
                generation_gateway._ensure_runtime("gemma4:e4b")
                ensure.assert_not_called()
                generation_gateway._ensure_runtime("another:model")
                self.assertEqual(ensure.call_count, 1)
            generation_gateway._ensure_runtime("gemma4:e4b")
        self.assertEqual(ensure.call_count, 2)

    def test_explicit_http_transport_is_scoped_and_normal_requests_keep_default_transport(self):
        data = json.dumps({"response": "private diagnostic response"}).encode()
        with patch.object(generation_gateway, "_ensure_runtime"), \
                patch.object(generation_gateway.urllib.request, "urlopen", return_value=BytesIO(data)) as default:
            custom = lambda request, timeout: BytesIO(data)
            with generation_gateway.generation_http_transport(custom):
                self.assertEqual(generation_gateway._generate_with_http("model", "private prompt"), "private diagnostic response")
                default.assert_not_called()
            self.assertEqual(generation_gateway._generate_with_http("model", "ordinary prompt"), "private diagnostic response")
            default.assert_called_once()

    def test_http_logging_contains_timings_without_content_or_model(self) -> None:
        payload = {
            "response": "PRIVATE RESPONSE", "load_duration": 123,
            "prompt_eval_duration": 456, "eval_duration": 789,
        }
        with (
            patch.object(generation_gateway, "_ensure_runtime"),
            patch.object(generation_gateway.urllib.request, "urlopen", return_value=BytesIO(json.dumps(payload).encode())) as request,
            self.assertLogs(level="INFO") as logs,
        ):
            self.assertEqual(generation_gateway._generate_with_http("PRIVATE MODEL", "PRIVATE PROMPT"), "PRIVATE RESPONSE")
        self.assertEqual(request.call_args.kwargs["timeout"], 600)
        output = "\n".join(logs.output)
        self.assertIn("request begin", output)
        self.assertIn("load_duration_ns=123", output)
        self.assertIn("prompt_eval_duration_ns=456", output)
        self.assertIn("eval_duration_ns=789", output)
        for value in ("PRIVATE RESPONSE", "PRIVATE MODEL", "PRIVATE PROMPT"):
            self.assertNotIn(value, output)

    def test_response_schema_is_used_only_inside_scope_and_resets_after_failure(self):
        formats = []

        def open_request(request, timeout):
            formats.append(json.loads(request.data)["format"])
            return BytesIO(json.dumps({"response": "{}"}).encode())

        schema = {"type": "object", "required": ["notes"]}
        with patch.object(generation_gateway, "_ensure_runtime"), \
                generation_gateway.generation_http_transport(open_request):
            with self.assertRaises(RuntimeError):
                with generation_gateway.generation_response_schema(schema):
                    generation_gateway._generate_with_http("model", "structured")
                    raise RuntimeError("stop this operation")
            generation_gateway._generate_with_http("model", "ordinary")
        self.assertEqual(formats, [schema, "json"])
        failure = generation_gateway.failure_for_code("invalid_model_response")
        with self.assertRaises(generation_gateway.GenerationFailure) as raised:
            with generation_gateway.generation_response_schema(schema):
                raise failure
        self.assertIs(raised.exception, failure)

    def test_failed_http_logging_does_not_include_exception_details(self) -> None:
        with (
            patch.object(generation_gateway, "_ensure_runtime"),
            patch.object(generation_gateway.urllib.request, "urlopen", side_effect=TimeoutError("PRIVATE ERROR")),
            self.assertLogs(level="INFO") as logs,
        ):
            with self.assertRaises(TimeoutError):
                generation_gateway._generate_with_http("PRIVATE MODEL", "PRIVATE PROMPT")
        output = "\n".join(logs.output)
        self.assertIn("status=failed code=request_timeout", output)
        self.assertNotIn("PRIVATE", output)

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

    def test_prepared_runtime_connection_loss_does_not_restart_through_cli(self) -> None:
        with (
            patch.object(generation_gateway, "_generate_with_http", side_effect=urllib.error.URLError(ConnectionRefusedError())),
            patch.object(generation_gateway, "_generate_with_cli") as cli_generate,
            generation_gateway.prepared_ollama_runtime("gemma4:e2b"),
        ):
            with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                generation_gateway.generate_ollama_text("gemma4:e2b", "prompt")
        self.assertEqual(raised.exception.code, "server_unreachable")
        self.assertTrue(raised.exception.retryable)
        cli_generate.assert_not_called()

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
