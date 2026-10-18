import json
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from pipeline import summarize


class SummaryGenerationLimitsTest(unittest.TestCase):
    def assert_invalid(self, result):
        self.assertEqual(result.get("generation_status", {}).get("summary"), "failed")
        self.assertEqual(result.get("generation_error_detail"), "invalid_model_response")
        self.assertTrue(result["generation_error"]["retryable"])
        self.assertNotIn("PRIVATE TRANSCRIPT", result["overview"])

    def test_empty_or_unsupported_json_never_becomes_completed_transcript_prefix(self):
        for value in ({}, [], None, False, 123, "unsupported root", {"title": "title only"},
                      {"unrelated": "value"}, {"overview": " "},
                      {"overview": None}, {"overview": 12},
                      {"needs_check": ["subject unresolved"]},
                      {"topics": [None, {}, 12, " "]},
                      {"topic_sections": [{"summary": "content without required topic"}]},
                      {"participant_summaries": [{"summary": "content without required participant"}]}):
            with self.subTest(value=value), patch.object(
                summarize, "generate_ollama_text", return_value=json.dumps(value)
            ) as generate:
                result = summarize.summarize_meeting(
                    [{"text": "PRIVATE TRANSCRIPT", "speaker": "UNKNOWN"}], "test-model"
                )
            self.assert_invalid(result)
            self.assertEqual(generate.call_count, 2, "Only one compact-contract retry is allowed")

    def test_contentless_json_gets_one_recovery_without_losing_original_input(self):
        source = "PRIVATE TRANSCRIPT: the evaluation subject is unresolved"
        with patch.object(summarize, "generate_ollama_text", side_effect=[
            '{"needs_check":["first uncertainty"]}', json.dumps({"overview": "대상이 불명확한 평가를 분리함.", "needs_check": ["대상 확인"]})
        ]) as generate:
            result = summarize.summarize_meeting([{"text": source}], "test-model")
        self.assertEqual(result["overview"], "대상이 불명확한 평가를 분리함.")
        self.assertEqual(result["needs_check"], ["대상 확인", "first uncertainty"])
        self.assertEqual(generate.call_count, 2)
        retry = generate.call_args_list[1].args[1]
        self.assertIn(source, retry)
        self.assertIn("A nearby name, adjacent remark or shared speaker is not enough", retry)

    def test_timeout_and_malformed_json_do_not_trigger_extra_model_requests(self):
        for value in (TimeoutError(), "not JSON"):
            with self.subTest(value=type(value).__name__), patch.object(
                summarize, "generate_ollama_text",
                side_effect=value if isinstance(value, Exception) else None,
                return_value=value,
            ) as generate:
                result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "test-model")
            self.assertEqual(result["generation_status"]["summary"], "failed")
            self.assertEqual(generate.call_count, 1)

    def test_partial_empty_result_stops_before_merge(self):
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=["part one", "part two"]), \
                patch.object(summarize, "generate_ollama_text", return_value="{}") as generate:
            result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "test-model")
        self.assert_invalid(result)
        self.assertEqual(generate.call_count, 2)

    def test_empty_merge_is_failed_instead_of_a_completed_prefix(self):
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=["one", "two"]), \
                patch.object(summarize, "generate_ollama_text", side_effect=[
                    '{"overview":"first"}', '{"overview":"second"}', "{}", "{}"
                ]) as generate:
            result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "test-model")
        self.assert_invalid(result)
        self.assertEqual(generate.call_count, 4)

    def test_bounded_reduction_includes_all_parts_in_order_and_keeps_uncertainties(self):
        merge_inputs = []

        def generate(_model, prompt):
            body = prompt.split("Partial summaries:\n", 1)[-1] if "Partial summaries:\n" in prompt else prompt.split("Transcript:\n", 1)[-1]
            ids = re.findall(r"SOURCE_\d{2}", body)
            self.assertTrue(ids)
            if "Partial summaries:\n" in prompt:
                merge_inputs.append(body.rstrip("\n"))
            self.assertIn("A nearby name, adjacent remark or shared speaker is not enough", prompt)
            self.assertIn("preserve their needs_check uncertainties", prompt)
            return json.dumps({
                "overview": " ".join(ids) + "x" * 120,
                "needs_check": ["uncertain-" + ids[0][-2:]] if "Partial summaries:\n" not in prompt else ["merge uncertainty"],
            })

        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "SUMMARY_MERGE_CHARS", 500, create=True), \
                patch.object(summarize, "_split_text_for_summary", return_value=[f"SOURCE_{i:02}" for i in range(9)]), \
                patch.object(summarize, "generate_ollama_text", side_effect=generate):
            result = summarize.summarize_meeting([{"text": "fixture source"}], "test-model")
        self.assertGreater(len(merge_inputs), 1)
        self.assertTrue(all(len(body) <= 500 for body in merge_inputs))
        self.assertEqual(re.findall(r"SOURCE_\d{2}", result["overview"]), [f"SOURCE_{i:02}" for i in range(9)])
        self.assertEqual(result["needs_check"].count("merge uncertainty"), 1)
        self.assertEqual([value for value in result["needs_check"] if value != "merge uncertainty"], [f"uncertain-{i:02}" for i in range(9)])

    def test_supported_summary_lists_can_supply_content_without_invented_actions(self):
        for field in ("topics", "decisions", "actions"):
            with self.subTest(field=field), patch.object(
                summarize, "generate_ollama_text", return_value=json.dumps({field: ["근거 있는 항목"]})
            ) as generate:
                result = summarize.summarize_meeting([{"text": "source"}], "test-model")
            self.assertEqual(result[field], ["근거 있는 항목"])
            self.assertNotIn("generation_error", result)
            self.assertEqual(generate.call_count, 1)

    def test_oversized_partial_and_no_pair_progress_fail_without_truncation(self):
        for chars in (1000, 300):
            with self.subTest(chars=chars), patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                    patch.object(summarize, "SUMMARY_MERGE_CHARS", 420, create=True), \
                    patch.object(summarize, "_split_text_for_summary", return_value=["one", "two"]), \
                    patch.object(summarize, "generate_ollama_text", return_value=json.dumps({"overview": "x" * chars})) as generate:
                result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "test-model")
            self.assert_invalid(result)
            self.assertEqual(generate.call_count, 2, "Do not send an oversized or non-reducing merge")

    def test_generation_call_budget_also_limits_compact_retry(self):
        with patch.object(summarize, "SUMMARY_MAX_GENERATION_CALLS", 1, create=True), \
                patch.object(summarize, "generate_ollama_text", return_value="{}") as generate:
            result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "test-model")
        self.assert_invalid(result)
        self.assertEqual(generate.call_count, 1)

    def test_reduction_round_limit_is_a_failure_not_a_partial_success(self):
        def generate(_model, prompt):
            return json.dumps({"overview": "x" * 120})

        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "SUMMARY_MERGE_CHARS", 420, create=True), \
                patch.object(summarize, "SUMMARY_MAX_REDUCTION_ROUNDS", 1, create=True), \
                patch.object(summarize, "_split_text_for_summary", return_value=["one", "two", "three", "four"]), \
                patch.object(summarize, "generate_ollama_text", side_effect=generate):
            result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "test-model")
        self.assert_invalid(result)

    def test_local_provider_uses_the_same_empty_response_guard(self):
        llama = Mock(return_value={"choices": [{"text": "{}"}]})
        module = types.ModuleType("llama_cpp")
        module.Llama = Mock(return_value=llama)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, {"llama_cpp": module}):
            model = Path(tmp) / "fixture.gguf"
            model.write_bytes(b"fixture only; no inference")
            result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], str(model))
        self.assert_invalid(result)
        self.assertEqual(llama.call_count, 2)
        module.Llama.assert_called_once()

    def test_local_provider_loads_once_for_long_input_partials_and_merge(self):
        llama = Mock(side_effect=[
            {"choices": [{"text": '{"overview":"first partial"}'}]},
            {"choices": [{"text": '{"overview":"second partial"}'}]},
            {"choices": [{"text": '{"overview":"combined summary"}'}]},
        ])
        module = types.ModuleType("llama_cpp")
        module.Llama = Mock(return_value=llama)
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, {"llama_cpp": module}), \
                patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=["source one", "source two"]):
            model = Path(tmp) / "fixture.gguf"
            model.write_bytes(b"fixture only; no inference")
            result = summarize.summarize_meeting([{"text": "source one and two"}], str(model))
        self.assertEqual(result["overview"], "combined summary")
        module.Llama.assert_called_once_with(model_path=str(model), n_ctx=8192, n_gpu_layers=-1, verbose=False)
        self.assertEqual(llama.call_count, 3)
        self.assertIn("source one", llama.call_args_list[0].args[0])
        self.assertIn("source two", llama.call_args_list[1].args[0])
        self.assertIn("first partial", llama.call_args_list[2].args[0])
        self.assertIn("second partial", llama.call_args_list[2].args[0])
        for call in llama.call_args_list:
            self.assertEqual(call.kwargs["max_tokens"], 2048)
            self.assertIn("A nearby name, adjacent remark or shared speaker is not enough", call.args[0])

    def test_summary_diagnostics_log_only_structural_metadata(self):
        with patch.object(summarize, "generate_ollama_text", return_value='{"overview":"PRIVATE RESPONSE"}'), \
                self.assertLogs(level="INFO") as logs:
            result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "PRIVATE MODEL")
        self.assertEqual(result["overview"], "PRIVATE RESPONSE")
        output = "\n".join(logs.output)
        self.assertIn("stage=direct", output)
        self.assertIn("root_type=dict", output)
        for private in ("PRIVATE TRANSCRIPT", "PRIVATE RESPONSE", "PRIVATE MODEL"):
            self.assertNotIn(private, output)


if __name__ == "__main__":
    unittest.main()
