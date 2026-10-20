import json
import os
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
from model_manager import OllamaModelInventory


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
            patch.object(generation_gateway, "read_ollama_model_inventory",
                         return_value=OllamaModelInventory(True, ("gemma4:e4b", "another:model"))),
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
            patch.object(generation_gateway, "_model_partly_on_cpu", return_value=False),
            patch.object(generation_gateway, "_generate_with_cli") as cli_generate,
        ):
            with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                generation_gateway.generate_ollama_text("gemma4:e2b", "prompt")

        self.assertEqual(raised.exception.code, "request_timeout")
        cli_generate.assert_not_called()

    def test_timeout_with_model_split_between_gpu_and_cpu_points_at_a_lighter_model(self) -> None:
        def failure_for(models, model_name="gemma4:e4b"):
            calls = []

            def open_request(request, timeout):
                self.assertLessEqual(timeout, 3)
                body = json.loads(request.data.decode("utf-8")) if request.data else None
                calls.append((request.full_url.rsplit("/api/", 1)[-1], body))
                if request.full_url.endswith("/api/ps"):
                    return BytesIO(json.dumps({"models": models}).encode("utf-8"))
                return BytesIO(b"{}")

            with (
                patch.object(generation_gateway, "_generate_with_http", side_effect=TimeoutError("late")),
                generation_gateway.generation_http_transport(open_request),
            ):
                with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                    generation_gateway.generate_ollama_text(model_name, "prompt")
            return raised.exception, calls

        split, calls = failure_for([{"name": "gemma4:e4b", "model": "gemma4:e4b", "size": 9_000_000_000, "size_vram": 4_000_000_000}])
        self.assertEqual(split.code, "model_too_slow")
        self.assertFalse(split.retryable)
        self.assertEqual(split.user_action, "open_settings")
        # The split model is dropped so the next try is placed again instead of reusing the split for 5 minutes.
        self.assertEqual(calls, [("ps", None), ("generate", {"model": "gemma4:e4b", "keep_alive": 0})])
        # Names: an untagged name is ':latest', `model` alone is enough, case does not matter.
        self.assertEqual(failure_for([{"name": "Gemma4:latest", "size": 9_000, "size_vram": 4_000}], "gemma4")[0].code, "model_too_slow")
        self.assertEqual(failure_for([{"model": "gemma4:e4b", "size": 9_000, "size_vram": 4_000}])[0].code, "model_too_slow")
        # No evidence keeps the plain timeout and unloads nothing: fully on GPU, no GPU, another model, nothing loaded.
        for models in (
            [{"name": "gemma4:e4b", "size": 9_000, "size_vram": 9_000}],
            [{"name": "gemma4:e4b", "size": 9_000, "size_vram": 0}],
            [{"name": "gemma4:e2b", "size": 9_000, "size_vram": 4_000}],
            [],
        ):
            failure, calls = failure_for(models)
            self.assertEqual(failure.code, "request_timeout")
            self.assertEqual([url for url, _ in calls], ["ps"])

    def test_timeout_probe_failure_keeps_the_plain_timeout(self) -> None:
        def broken(request, timeout):
            raise urllib.error.URLError(ConnectionRefusedError())
        with (
            patch.object(generation_gateway, "_generate_with_http", side_effect=TimeoutError("late")),
            generation_gateway.generation_http_transport(broken),
        ):
            with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                generation_gateway.generate_ollama_text("gemma4:e4b", "prompt")
        self.assertEqual(raised.exception.code, "request_timeout")

    def test_cloud_model_is_refused_before_any_request(self) -> None:
        for cloud_model in ("gpt-oss:120b-cloud", "glm-4.6:cloud", "Kimi-K2:1T-CLOUD"):
            with (
                self.subTest(model=cloud_model),
                patch.object(generation_gateway, "ollama_host_is_local", return_value=True),
                patch.object(generation_gateway, "_generate_with_http") as http_generate,
                patch.object(generation_gateway, "_generate_with_cli") as cli_generate,
            ):
                with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                    generation_gateway.generate_ollama_text(cloud_model, "private meeting text")

            self.assertEqual(raised.exception.code, "summary_model_not_local")
            self.assertFalse(raised.exception.retryable)
            self.assertEqual(raised.exception.user_action, "open_settings")
            self.assertEqual(raised.exception.http_status, 409)
            self.assertNotIn("private meeting text", raised.exception.user_message)
            http_generate.assert_not_called()
            cli_generate.assert_not_called()

    def test_ollama_address_on_another_computer_is_refused_before_any_request(self) -> None:
        with (
            patch.dict(os.environ, {"OLLAMA_HOST": "http://192.168.0.20:11434"}),
            patch("ollama_utils.using_embedded_ollama", return_value=False),
            patch.object(generation_gateway, "_generate_with_http") as http_generate,
            patch.object(generation_gateway, "_generate_with_cli") as cli_generate,
            patch.object(generation_gateway.urllib.request, "urlopen") as urlopen,
        ):
            with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                generation_gateway.generate_ollama_text("gemma4:e2b", "private meeting text")

        self.assertEqual(raised.exception.code, "summary_runtime_not_local")
        self.assertFalse(raised.exception.retryable)
        self.assertIn("OLLAMA_HOST", raised.exception.user_message)
        self.assertNotIn("192.168.0.20", raised.exception.user_message)
        http_generate.assert_not_called()
        cli_generate.assert_not_called()
        urlopen.assert_not_called()

    def test_local_looking_alias_of_a_remote_model_is_refused_before_generating(self) -> None:
        inventory = OllamaModelInventory(True, ("gemma4:e2b", "notes:latest"), ("notes:latest",))
        with (
            patch.object(generation_gateway, "ollama_executable_available", return_value=True),
            patch.object(generation_gateway, "ensure_ollama_server_running", return_value=True),
            patch.object(generation_gateway, "read_ollama_model_inventory", return_value=inventory),
            patch.object(generation_gateway.urllib.request, "urlopen") as urlopen,
            patch.object(generation_gateway, "run_hidden") as cli_run,
        ):
            with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                generation_gateway.generate_ollama_text("notes", "private meeting text")
            self.assertEqual(raised.exception.code, "summary_model_not_local")
            urlopen.assert_not_called()
            cli_run.assert_not_called()
            # The local model in the same list still passes the check.
            generation_gateway._ensure_runtime("gemma4:e2b")

    def test_unreadable_model_list_does_not_count_as_local(self) -> None:
        with (
            patch.object(generation_gateway, "ollama_executable_available", return_value=True),
            patch.object(generation_gateway, "ensure_ollama_server_running", return_value=True),
            patch.object(generation_gateway, "read_ollama_model_inventory",
                         return_value=OllamaModelInventory(False)),
        ):
            with self.assertRaises(generation_gateway.GenerationFailure) as raised:
                generation_gateway._ensure_runtime("gemma4:e2b")
        self.assertEqual(raised.exception.code, "server_unreachable")

    def test_local_model_on_this_pc_still_generates(self) -> None:
        for host in ("127.0.0.1:11434", "localhost:11434", "0.0.0.0"):
            with (
                self.subTest(host=host),
                patch.dict(os.environ, {"OLLAMA_HOST": host}),
                patch("ollama_utils.using_embedded_ollama", return_value=False),
                patch.object(generation_gateway, "_generate_with_http", return_value='{"summary":"ok"}') as http_generate,
            ):
                self.assertEqual(generation_gateway.generate_ollama_text("gemma4:e2b", "prompt"), '{"summary":"ok"}')
            http_generate.assert_called_once_with("gemma4:e2b", "prompt")

    def test_refusal_codes_survive_saved_generation_errors(self) -> None:
        internal_message = generation_gateway.GENERATION_ERROR_MESSAGES["generation_internal_error"]
        for code in ("summary_model_not_local", "summary_runtime_not_local"):
            with self.subTest(code=code):
                failure = generation_gateway.failure_for_code(code)
                self.assertEqual(failure.code, code)
                self.assertEqual(failure.as_detail("summary")["code"], code)
                self.assertNotEqual(failure.user_message, internal_message)

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
