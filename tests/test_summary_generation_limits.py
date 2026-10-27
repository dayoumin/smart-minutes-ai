import json
import re
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from pipeline import summarize, summary_evidence


def evidence_notes(source, *, kind="discussion", text=None, concerns=(), problems=(), goals=(), opposing=(), conditions=()):
    return {"notes": [{"kind": kind, "topic": "검토 논점", "text": text or source, "evidence_ids": ["s1"],
                       "problems": list(problems), "goals": list(goals),
                       "opposing": list(opposing), "conditions": list(conditions)}],
            "needs_check": list(concerns)}


def grouping_plan(prompt, *, groups=None):
    nodes = json.loads(prompt.split("Notes:\n", 1)[1])
    return {"title": "검토 회의", "overview": "서로 다른 근거와 후속 계획을 검토했다.",
            "groups": groups if groups is not None else [{"topic": "검토 결과", "ids": [node["id"] for node in nodes]}]}


def source_unit(prompt):
    body = prompt.split("Source unit ", 1)[1].split(":\n", 1)[1]
    return "\n".join(span["quote"] for span in json.loads(body)["spans"])


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
                    json.dumps(evidence_notes("one")), json.dumps(evidence_notes("two")), "{}", "{}"
                ]) as generate:
            result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "test-model")
        self.assert_invalid(result)
        self.assertEqual(generate.call_count, 4)

    def test_bounded_reduction_includes_all_parts_in_order_and_keeps_uncertainties(self):
        merge_inputs = []

        def generate(_model, prompt):
            self.assertIn("A nearby name, adjacent remark or shared speaker is not enough", prompt)
            if "Notes:\n" in prompt:
                merge_inputs.append(prompt.split("Notes:\n", 1)[1])
                return json.dumps(grouping_plan(prompt))
            source = source_unit(prompt)
            return json.dumps(evidence_notes(source, concerns=["uncertain-" + source[-2:]]))

        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "SUMMARY_MERGE_CHARS", 300, create=True), \
                patch.object(summarize, "_split_text_for_summary", return_value=[f"SOURCE_{i:02}" for i in range(9)]), \
                patch.object(summarize, "generate_ollama_text", side_effect=generate):
            result = summarize.summarize_meeting([{"text": "fixture source"}], "test-model")
        self.assertGreater(len(merge_inputs), 1)
        self.assertTrue(all(len(body) <= 300 for body in merge_inputs))
        self.assertEqual(re.findall(r"SOURCE_\d{2}", " ".join(result["topics"])), [f"SOURCE_{i:02}" for i in range(9)])
        self.assertEqual(result["needs_check"], [f"uncertain-{i:02}" for i in range(9)])

    def test_supported_summary_lists_can_supply_content_without_invented_actions(self):
        for field in ("topics", "decisions", "actions"):
            with self.subTest(field=field), patch.object(
                summarize, "generate_ollama_text", return_value=json.dumps({field: ["근거 있는 항목"]})
            ) as generate:
                result = summarize.summarize_meeting([{"text": "source"}], "test-model")
            self.assertEqual(result[field], ["근거 있는 항목"])
            self.assertNotIn("generation_error", result)
            self.assertEqual(generate.call_count, 1)

    def test_oversized_titles_and_no_pair_progress_fail_without_truncation(self):
        # A full note can use a title-only grouping preview. Only titles that
        # cannot fit individually or in any pair are an unrecoverable boundary.
        for chars in (100, 60):
            def generate(_model, prompt):
                source = source_unit(prompt)
                response = evidence_notes(source)
                response["notes"][0]["topic"] = "x" * chars
                return json.dumps(response)
            with self.subTest(chars=chars), patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                    patch.object(summarize, "SUMMARY_MERGE_CHARS", 110, create=True), \
                    patch.object(summarize, "_split_text_for_summary", return_value=["one", "two"]), \
                    patch.object(summarize, "generate_ollama_text", side_effect=generate) as generate_mock:
                result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "test-model")
            self.assert_invalid(result)
            self.assertEqual(generate_mock.call_count, 2, "Do not send an oversized or non-reducing merge")

    def test_large_valid_notes_use_bounded_title_previews_without_losing_full_contents(self):
        for count, chars in ((6, 250), (12, 300)):
            sources = [f"source{i} opposition{i} pending{i}" for i in range(2)]
            payloads = []
            events = []
            merge_bodies = []
            for index, source in enumerate(sources):
                payloads.append(evidence_notes(source, kind="decision" if index == 0 else "action",
                    text=f"claim{index}" + "m" * 590,
                    opposing=[{"text": f"opposition{index}-{j}" + "o" * chars, "evidence_ids": ["s1"]} for j in range(count)],
                    conditions=[{"text": f"condition{index}-{j}" + "c" * chars, "evidence_ids": ["s1"]} for j in range(count)]))
            def generate(_model, prompt):
                if "Notes:\n" in prompt:
                    merge_bodies.append(prompt.split("Notes:\n", 1)[1])
                    return json.dumps(grouping_plan(prompt))
                return json.dumps(payloads[sources.index(source_unit(prompt))])
            with self.subTest(count=count, chars=chars), \
                    patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                    patch.object(summarize, "_split_text_for_summary", return_value=sources), \
                    patch.object(summarize, "generate_ollama_text", side_effect=generate) as generate_mock:
                result = summarize.summarize_meeting([{"text": "source"}], "model", diagnostic_callback=events.append)
            self.assertNotIn("generation_error", result)
            self.assertEqual(generate_mock.call_count, 3)
            self.assertEqual(len(merge_bodies), 1)
            self.assertLessEqual(len(merge_bodies[0]), 6000)
            preview = json.loads(merge_bodies[0])
            self.assertEqual([node["id"] for node in preview], ["u1-n1", "u2-n1"])
            self.assertTrue(all("text" not in node for node in preview))
            self.assertTrue(any(event["event"] == "grouping_preview" and event["mode"] == "titles_only" for event in events))
            topics = " ".join(result["topics"])
            for index, payload in enumerate(payloads):
                note = payload["notes"][0]
                rendered_item = result["decisions" if index == 0 else "actions"][0]
                for text in [note["text"], *[item["text"] for key in ("opposing", "conditions") for item in note[key]]]:
                    self.assertIn(text, topics)
                    self.assertIn(text, rendered_item)

    def test_generation_call_budget_also_limits_compact_retry(self):
        with patch.object(summarize, "SUMMARY_MAX_GENERATION_CALLS", 1, create=True), \
                patch.object(summarize, "generate_ollama_text", return_value="{}") as generate:
            result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "test-model")
        self.assert_invalid(result)
        self.assertEqual(generate.call_count, 1)

    def test_reduction_round_limit_is_a_failure_not_a_partial_success(self):
        def generate(_model, prompt):
            if "Notes:\n" in prompt:
                return json.dumps(grouping_plan(prompt))
            source = source_unit(prompt)
            return json.dumps(evidence_notes(source, text="x" * 50))

        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "SUMMARY_MERGE_CHARS", 260, create=True), \
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
            {"choices": [{"text": json.dumps(evidence_notes("source one"))}]},
            {"choices": [{"text": json.dumps(evidence_notes("source two"))}]},
            {"choices": [{"text": json.dumps({"title": "meeting", "overview": "combined summary",
                                              "groups": [{"topic": "combined", "ids": ["u1-n1", "u2-n1"]}]})}]},
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
        self.assertIn("source one", llama.call_args_list[2].args[0])
        self.assertIn("source two", llama.call_args_list[2].args[0])
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

    def test_opt_in_diagnostics_capture_retry_and_raw_response_before_parsing(self):
        events = []
        with patch.object(summarize, "generate_ollama_text", side_effect=["{}", '{"overview":"accepted"}']):
            result = summarize.summarize_meeting(
                [{"text": "private original"}], "model", diagnostic_callback=events.append,
            )
        self.assertEqual(result["overview"], "accepted")
        self.assertEqual([item["event"] for item in events], [
            "stage_input", "request", "raw_response", "request", "raw_response", "accepted", "final",
        ])
        self.assertIn("private original", events[0]["source"])
        requests = [item for item in events if item["event"] == "request"]
        self.assertEqual([item["attempt"] for item in requests], [1, 2])
        self.assertNotEqual(requests[0]["prompt"], requests[1]["prompt"])
        for item in requests:
            self.assertIn("private original", item["prompt"])
        self.assertEqual(events[2]["response"], "{}")
        events[-1]["summary"]["overview"] = "observer mutation"
        self.assertEqual(result["overview"], "accepted")

    def test_diagnostics_keep_malformed_response_and_never_leak_into_app_logs(self):
        events = []
        with patch.object(summarize, "generate_ollama_text", return_value="PRIVATE MALFORMED RESPONSE"), \
                self.assertLogs(level="INFO") as logs:
            result = summarize.summarize_meeting(
                [{"text": "PRIVATE SOURCE"}], "model", diagnostic_callback=events.append,
            )
        self.assert_invalid(result)
        self.assertEqual(events[-1]["event"], "raw_response")
        self.assertEqual(events[-1]["response"], "PRIVATE MALFORMED RESPONSE")
        self.assertNotIn("PRIVATE", "\n".join(logs.output))

    def test_diagnostics_identify_partial_and_merge_inputs_and_final_caveats(self):
        events = []
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=["early source", "late source"]), \
                patch.object(summarize, "generate_ollama_text", side_effect=[
                    json.dumps(evidence_notes("early source", concerns=["unknown subject"])),
                    json.dumps(evidence_notes("late source", text="late technical talk")),
                    json.dumps({"title": "meeting", "overview": "early only",
                                "groups": [{"topic": "discussion", "ids": ["u1-n1", "u2-n1"]}]}),
                ]):
            result = summarize.summarize_meeting([{"text": "source"}], "model", diagnostic_callback=events.append)
        inputs = [item for item in events if item["event"] == "stage_input"]
        self.assertEqual([item["stage"] for item in inputs], ["partial-1", "partial-2", "merge-1-1"])
        self.assertIn("late technical talk", inputs[-1]["source"])
        self.assertEqual(events[-1]["summary"], result)
        self.assertEqual(result["needs_check"], ["unknown subject"])
        coverage = next(item for item in events if item["event"] == "evidence_coverage")
        self.assertEqual([item["id"] for item in coverage["notes"]], ["u1-n1", "u2-n1"])
        self.assertEqual(coverage["groups"][0]["leaves"], ["u1-n1", "u2-n1"])
        self.assertIn("late technical talk", " ".join(result["topics"]))
        self.assertNotIn("unknown subject", " ".join(result["topics"]))
        # The internal coverage trace proves which accepted notes survived;
        # it does not assert that extraction was semantically complete.
        self.assertEqual(result["overview"], "early only")

    def test_decisions_actions_opposition_and_conditions_survive_multiple_grouping_levels(self):
        sources = [f"SOURCE_{i:02} pending approval_{i:02} competing evidence_{i:02}" for i in range(9)]
        merge_calls = []
        events = []
        def generate(_model, prompt):
            if "Notes:\n" in prompt:
                merge_calls.append(prompt)
                # Reverse references: user-facing evidence must retain source order.
                nodes = json.loads(prompt.split("Notes:\n", 1)[1])
                return json.dumps(grouping_plan(prompt, groups=[{"topic": "검토", "ids": [node["id"] for node in reversed(nodes)]}]))
            source = source_unit(prompt)
            index = sources.index(source)
            kind = "decision" if index == 7 else "action" if index == 8 else "discussion"
            return json.dumps(evidence_notes(source, kind=kind, text=f"finding_{index:02}",
                problems=[{"text": f"problem_{index:02}", "evidence_ids": ["s1"]}],
                goals=[{"text": f"goal_{index:02}", "evidence_ids": ["s1"]}],
                opposing=[{"text": f"opposition_{index:02}", "evidence_ids": ["s1"]}],
                conditions=[{"text": f"condition_{index:02}", "evidence_ids": ["s1"]}]))
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "SUMMARY_MERGE_CHARS", 430), \
                patch.object(summarize, "_split_text_for_summary", return_value=sources), \
                patch.object(summarize, "generate_ollama_text", side_effect=generate):
            result = summarize.summarize_meeting([{"text": "source"}], "model", diagnostic_callback=events.append)
        self.assertNotIn("generation_error", result)
        self.assertGreater(len(merge_calls), 1)
        self.assertTrue(any(event["event"] == "request" and event["stage"].startswith("merge-2-") for event in events))
        topics = " ".join(result["topics"])
        self.assertEqual(re.findall(r"finding_\d{2}", topics), [f"finding_{i:02}" for i in range(9)])
        for index in range(9):
            self.assertIn(f"문제: problem_{index:02}", topics)
            self.assertIn(f"목표: goal_{index:02}", topics)
            self.assertIn(f"opposition_{index:02}", topics)
            self.assertIn(f"condition_{index:02}", topics)
        self.assertEqual(len(result["decisions"]), 1)
        self.assertIn("finding_07", result["decisions"][0])
        self.assertIn("problem_07", result["decisions"][0])
        self.assertIn("goal_07", result["decisions"][0])
        self.assertIn("condition_07", result["decisions"][0])
        self.assertEqual(len(result["actions"]), 1)
        self.assertIn("finding_08", result["actions"][0])
        self.assertIn("problem_08", result["actions"][0])
        self.assertIn("goal_08", result["actions"][0])
        self.assertIn("opposition_08", result["actions"][0])

    def test_long_summary_requests_note_limit_and_preserves_all_boundary_notes(self):
        payload = evidence_notes("actual source")
        payload["notes"] = [
            {**payload["notes"][0], "text": f"boundary_note_{index:02}"}
            for index in range(summary_evidence.MAX_NOTES_PER_UNIT)
        ]
        events = []

        def generate(_model, prompt):
            return json.dumps(grouping_plan(prompt) if "Notes:\n" in prompt else payload)

        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=["actual source"]), \
                patch.object(summarize, "generate_ollama_text", side_effect=generate), \
                patch.object(summarize, "generation_response_schema", wraps=summarize.generation_response_schema) as schema_context:
            result = summarize.summarize_meeting([{"text": "source"}], "model", diagnostic_callback=events.append)
        self.assertNotIn("generation_error", result)
        requested_schema = schema_context.call_args_list[0].args[0]
        self.assertEqual(requested_schema["properties"]["notes"]["maxItems"], summary_evidence.MAX_NOTES_PER_UNIT)
        self.assertEqual(summary_evidence.MAX_NOTES_PER_UNIT, 12)
        request = next(event for event in events if event["event"] == "request")
        self.assertIn(f"노트 최대 {summary_evidence.MAX_NOTES_PER_UNIT}개", request["prompt"])
        self.assertEqual(re.findall(r"boundary_note_\d{2}", " ".join(result["topics"])),
                         [note["text"] for note in payload["notes"]])
        coverage = next(event for event in events if event["event"] == "evidence_coverage")
        self.assertEqual(len(coverage["notes"]), summary_evidence.MAX_NOTES_PER_UNIT)

    def test_oversized_notes_retry_once_without_truncation(self):
        oversized = evidence_notes("actual source", text="REJECTED OVERSIZED CLAIM")
        oversized["notes"] *= summary_evidence.MAX_NOTES_PER_UNIT + 1
        good = evidence_notes("actual source", text="accepted grounded note")
        for recover in (False, True):
            events = []
            with self.subTest(recover=recover), patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                    patch.object(summarize, "_split_text_for_summary", return_value=["actual source"]), \
                    patch.object(summarize, "generate_ollama_text", side_effect=[
                        json.dumps(oversized), json.dumps(good if recover else oversized),
                    ]) as generate, \
                    patch.object(summarize, "generation_response_schema", wraps=summarize.generation_response_schema) as schema_context:
                result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "model", diagnostic_callback=events.append)
            self.assertEqual(generate.call_count, 2)
            for call in schema_context.call_args_list:
                self.assertEqual(call.args[0]["properties"]["notes"]["maxItems"], summary_evidence.MAX_NOTES_PER_UNIT)
            rejected = [event for event in events if event["event"] == "rejected"]
            self.assertEqual([event["reason"] for event in rejected], ["note_count"] * (1 if recover else 2))
            self.assertNotIn("REJECTED OVERSIZED CLAIM", str(result))
            if recover:
                self.assertIn("accepted grounded note", " ".join(result["topics"]))
            else:
                self.assert_invalid(result)

    def test_invalid_evidence_ids_retry_once_without_adopting_unanchored_notes(self):
        good = evidence_notes("actual source", text="grounded assertion")
        for field in ("main", "problems", "goals", "opposing", "conditions"):
            for refs in (None, [], ["s1", "s1"], ["unknown"]):
                bad = evidence_notes("actual source", text="unsupported assertion")
                anchored = bad["notes"][0]
                if field != "main":
                    anchored = {"text": "unsupported qualifier"}
                    bad["notes"][0][field] = [anchored]
                if refs is None:
                    anchored.pop("evidence_ids", None)
                else:
                    anchored["evidence_ids"] = refs
                for recover in (False, True):
                    with self.subTest(field=field, refs=refs, recover=recover), patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                            patch.object(summarize, "_split_text_for_summary", return_value=["actual source"]), \
                            patch.object(summarize, "generate_ollama_text", side_effect=[json.dumps(bad), json.dumps(good if recover else bad)]) as generate:
                        result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "model")
                    self.assertEqual(generate.call_count, 2)
                    if recover:
                        self.assertIn("grounded assertion", " ".join(result["topics"]))
                        self.assertNotIn("unsupported assertion", str(result))
                        self.assertNotIn("unsupported qualifier", str(result))
                    else:
                        self.assert_invalid(result)

    def test_category_arrays_are_required_bounded_and_can_be_explicitly_empty(self):
        for field in ("problems", "goals"):
            for value in (None, "not a list", [{"text": "claim", "evidence_ids": ["s1"]}] * 13):
                bad = evidence_notes("actual source")
                bad["notes"][0][field] = value
                with self.subTest(field=field, value=value), self.assertRaises(summary_evidence.InvalidNotes):
                    summary_evidence.validate_notes(bad, "actual source", "u1")
            missing = evidence_notes("actual source")
            del missing["notes"][0][field]
            with self.subTest(field=field, missing=True), self.assertRaises(summary_evidence.InvalidNotes):
                summary_evidence.validate_notes(missing, "actual source", "u1")
        valid = summary_evidence.validate_notes(evidence_notes("actual source"), "actual source", "u1")
        self.assertEqual(valid["notes"][0]["problems"], [])
        self.assertEqual(valid["notes"][0]["goals"], [])
        fields = summary_evidence.NOTES_SCHEMA["properties"]["notes"]["items"]
        self.assertTrue({"problems", "goals", "conditions"}.issubset(fields["required"]))
        for field in ("problems", "goals", "opposing", "conditions"):
            self.assertEqual(fields["properties"][field]["maxItems"], summary_evidence.MAX_NOTES_PER_UNIT)

    def test_evidence_quotes_are_copied_exactly_from_selected_source_spans(self):
        spans = ["화자00: 자료가 없다.", "화자01: 다만 재검토는 가능하다.", "화자02: 자료가 오면 검토한다."]
        source = "\n".join(spans)
        payload = evidence_notes(source, text="자료 부족과 조건부 재검토",
            problems=[{"text": "검토 자료가 부족하다", "evidence_ids": ["s1"]}],
            goals=[{"text": "자료가 도착하면 검토하려 한다", "evidence_ids": ["s3"]}],
            opposing=[{"text": "재검토 가능 의견", "evidence_ids": ["s2"]}],
            conditions=[{"text": "자료 도착 조건", "evidence_ids": ["s3"]}])
        payload["notes"][0]["evidence_ids"] = ["s1", "s3"]
        events = []
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=[source]), \
                patch.object(summarize, "generate_ollama_text", return_value=json.dumps(payload)) as generate:
            result = summarize.summarize_meeting([{"text": source}], "model", diagnostic_callback=events.append)
        self.assertNotIn("generation_error", result)
        self.assertEqual(generate.call_count, 1)
        note = next(event for event in events if event["event"] == "accepted")["summary"]["notes"][0]
        self.assertEqual(note["evidence"], [{"id": "s1", "quote": spans[0]}, {"id": "s3", "quote": spans[2]}])
        self.assertEqual(note["opposing"][0]["evidence"], [{"id": "s2", "quote": spans[1]}])
        self.assertEqual(note["conditions"][0]["evidence"], [{"id": "s3", "quote": spans[2]}])
        self.assertEqual(note["problems"][0]["evidence"], [{"id": "s1", "quote": spans[0]}])
        self.assertEqual(note["goals"][0]["evidence"], [{"id": "s3", "quote": spans[2]}])
        self.assertIn("문제: 검토 자료가 부족하다", " ".join(result["topics"]))
        self.assertIn("목표: 자료가 도착하면 검토하려 한다", " ".join(result["topics"]))
        self.assertNotIn("evidence", result)
        self.assertIn("자료 도착 조건", " ".join(result["topics"]))

    def test_rejected_partial_keeps_uncertainty_but_not_claim_or_next_meeting_state(self):
        bad = evidence_notes("source", text="UNSUPPORTED REJECTED CLAIM", concerns=["대상 미확인"])
        bad["notes"][0]["evidence_ids"] = ["unknown"]
        good = evidence_notes("source", text="accepted grounded note")
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=["source"]), \
                patch.object(summarize, "generate_ollama_text", side_effect=[json.dumps(bad), json.dumps(good)]) as generate:
            result = summarize.summarize_meeting([{"text": "source"}], "model")
        self.assertNotIn("generation_error", result)
        self.assertEqual(generate.call_count, 2)
        self.assertEqual(result["needs_check"], ["대상 미확인"])
        self.assertIn("accepted grounded note", " ".join(result["topics"]))
        self.assertNotIn("UNSUPPORTED REJECTED CLAIM", str(result))
        self.assertNotIn("대상 미확인", result["overview"] + " ".join(result["topics"]))
        with patch.object(summarize, "generate_ollama_text", return_value='{"overview":"another meeting"}'):
            next_result = summarize.summarize_meeting([{"text": "other source"}], "model")
        self.assertEqual(next_result["needs_check"], [])

    def test_persistent_missing_duplicate_or_unknown_group_refs_keep_separate_known_notes(self):
        for refs in (["u1-n1"], ["u1-n1", "u1-n1"], ["u1-n1", "unknown"]):
            events = []
            groups = [{"topic": "MODEL ONLY TOPIC", "ids": refs}]
            plan = {"title": "meeting", "overview": "overview", "groups": groups}
            with self.subTest(refs=refs), patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                    patch.object(summarize, "_split_text_for_summary", return_value=["one", "two"]), \
                    patch.object(summarize, "generate_ollama_text", side_effect=[
                        json.dumps(evidence_notes("one", kind="decision", concerns=["extraction uncertainty"],
                            conditions=[{"text": "if approved", "evidence_ids": ["s1"]}])),
                        json.dumps(evidence_notes("two", kind="action")),
                        json.dumps(plan), json.dumps(plan),
                    ]) as generate:
                result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "model", diagnostic_callback=events.append)
            self.assertNotIn("generation_error", result)
            self.assertEqual(generate.call_count, 4)
            self.assertEqual(result["topics"], ["검토 논점: one · 조건: if approved", "검토 논점: two"])
            self.assertEqual(result["decisions"], ["one · 조건: if approved"])
            self.assertEqual(result["actions"], ["two"])
            self.assertEqual(result["needs_check"], ["extraction uncertainty", "주제를 합쳐 정리하지 못한 부분은 개별 논의와 후속 항목을 유지했습니다."])
            self.assertNotIn("MODEL ONLY TOPIC", " ".join(result["topics"]))
            self.assertNotIn("extraction uncertainty", " ".join(result["topics"]))
            self.assertEqual([event["reason"] for event in events if event["event"] == "rejected"], ["coverage_mismatch", "coverage_mismatch"])
            repair = next(event for event in events if event["event"] == "deterministic_grouping")
            self.assertEqual([group["ids"] for group in repair["summary"]["groups"]], [["u1-n1"], ["u2-n1"]])
            adoption = next(event for event in events if event["event"] == "accepted" and event["stage"].startswith("merge-"))
            self.assertEqual(adoption["origin"], "deterministic_grouping")

    def test_invalid_grouping_field_shapes_are_not_recovered_as_valid_plans(self):
        valid = {"title": "meeting", "overview": "overview", "groups": [{"topic": "all", "ids": ["u1-n1", "u2-n1"]}]}
        invalid_plans = [
            {}, {**valid, "title": None}, {**valid, "overview": ""},
            {**valid, "groups": []}, {**valid, "groups": "not groups"},
            {**valid, "groups": [{"topic": "", "ids": ["u1-n1"]}]},
            {**valid, "groups": [{"topic": "all", "ids": []}]},
            {**valid, "groups": [{"topic": "all", "ids": [123]}]},
        ]
        for plan in invalid_plans:
            events = []
            with self.subTest(plan=plan), patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                    patch.object(summarize, "_split_text_for_summary", return_value=["one", "two"]), \
                    patch.object(summarize, "generate_ollama_text", side_effect=[
                        json.dumps(evidence_notes("one")), json.dumps(evidence_notes("two")), json.dumps(plan), json.dumps(plan),
                    ]) as generate:
                result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "model", diagnostic_callback=events.append)
            self.assert_invalid(result)
            self.assertEqual(generate.call_count, 4)
            self.assertFalse(any(event["event"] == "deterministic_grouping" for event in events))

    def test_one_to_one_groups_are_valid_and_later_rounds_preserve_all_notes(self):
        sources = [f"SOURCE_{index:02}" for index in range(9)]
        events = []
        first_round_plans = []
        def generate(_model, prompt):
            if "Notes:\n" not in prompt:
                return json.dumps(evidence_notes(source_unit(prompt)))
            nodes = json.loads(prompt.split("Notes:\n", 1)[1])
            if all(node["id"].startswith("u") for node in nodes):
                # Distinct subjects may legitimately stay distinct. Their
                # reduced previews can be batched again on a later round.
                groups = [{"topic": "논점", "ids": [node["id"]]} for node in nodes]
                first_round_plans.append(groups)
                return json.dumps(grouping_plan(prompt, groups=groups))
            return json.dumps(grouping_plan(prompt))
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "SUMMARY_MERGE_CHARS", 300), \
                patch.object(summarize, "_split_text_for_summary", return_value=sources), \
                patch.object(summarize, "generate_ollama_text", side_effect=generate):
            result = summarize.summarize_meeting([{"text": "source"}], "model", diagnostic_callback=events.append)
        self.assertNotIn("generation_error", result)
        self.assertTrue(first_round_plans)
        self.assertTrue(all(len(group["ids"]) == 1 for plan in first_round_plans for group in plan))
        self.assertTrue(any(event["event"] == "request" and event["stage"].startswith("merge-2-") for event in events))
        self.assertFalse(any(event["event"] == "rejected" for event in events))
        self.assertEqual(re.findall(r"SOURCE_\d{2}", " ".join(result["topics"])), sources)

    def test_final_single_batch_can_keep_distinct_topic_groups(self):
        plan = {"title": "meeting", "overview": "distinct subjects",
                "groups": [{"topic": "first", "ids": ["u1-n1"]}, {"topic": "second", "ids": ["u2-n1"]}]}
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=["one", "two"]), \
                patch.object(summarize, "generate_ollama_text", side_effect=[
                    json.dumps(evidence_notes("one")), json.dumps(evidence_notes("two")), json.dumps(plan),
                ]) as generate:
            result = summarize.summarize_meeting([{"text": "source"}], "model")
        self.assertNotIn("generation_error", result)
        self.assertEqual(generate.call_count, 3)
        self.assertEqual(result["topics"], ["first: one", "second: two"])

    def test_many_distinct_notes_use_bounded_parent_batches_without_losing_ledger(self):
        sources = [f"SOURCE_{index:02}" for index in range(37)]
        events = []
        merge_inputs = []
        def generate(_model, prompt):
            if "Notes:\n" in prompt:
                nodes = json.loads(prompt.split("Notes:\n", 1)[1])
                merge_inputs.append(nodes)
                # Return a valid 1:1 plan for every batch, including the last.
                # Progress must come from bounded internal parents, rather
                # than forcing the model to discard distinct subjects.
                groups = [{"topic": f"논점 {index}", "ids": [node["id"]]} for index, node in enumerate(nodes)]
                return json.dumps(grouping_plan(prompt, groups=groups))
            source = source_unit(prompt)
            index = sources.index(source)
            kind = "decision" if index == 35 else "action" if index == 36 else "discussion"
            return json.dumps(evidence_notes(source, kind=kind, text=f"finding_{index:02}",
                conditions=[{"text": f"condition_{index:02}", "evidence_ids": ["s1"]}]))
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=sources), \
                patch.object(summarize, "generate_ollama_text", side_effect=generate) as generate_mock:
            result = summarize.summarize_meeting([{"text": "source"}], "model", diagnostic_callback=events.append)
        self.assertNotIn("generation_error", result)
        self.assertTrue(merge_inputs)
        self.assertTrue(all(2 <= len(nodes) <= 12 for nodes in merge_inputs))
        self.assertTrue(any(event["event"] == "request" and event["stage"].startswith("merge-2-") for event in events))
        self.assertTrue(any(any(not node["id"].startswith("u") for node in nodes) for nodes in merge_inputs))
        self.assertFalse(any(event["event"] == "rejected" for event in events))
        self.assertEqual(generate_mock.call_count, len(sources) + len(merge_inputs))
        topics = " ".join(result["topics"])
        self.assertEqual(re.findall(r"finding_\d{2}", topics), [f"finding_{i:02}" for i in range(37)])
        self.assertEqual(re.findall(r"condition_\d{2}", topics), [f"condition_{i:02}" for i in range(37)])
        self.assertEqual(result["decisions"], ["finding_35 · 조건: condition_35"])
        self.assertEqual(result["actions"], ["finding_36 · 조건: condition_36"])
        coverage = next(event for event in events if event["event"] == "evidence_coverage")
        self.assertEqual([leaf for group in coverage["groups"] for leaf in group["leaves"]],
                         [f"u{i}-n1" for i in range(1, 38)])

    def test_missing_group_ref_can_recover_once_with_all_notes_preserved(self):
        complete = {"title": "meeting", "overview": "complete",
                    "groups": [{"topic": "all", "ids": ["u1-n1", "u2-n1"]}]}
        missing = {**complete, "groups": [{"topic": "all", "ids": ["u1-n1"]}]}
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=["one", "two"]), \
                patch.object(summarize, "generate_ollama_text", side_effect=[
                    json.dumps(evidence_notes("one")), json.dumps(evidence_notes("two")),
                    json.dumps(missing), json.dumps(complete),
                ]) as generate:
            result = summarize.summarize_meeting([{"text": "source"}], "model")
        self.assertNotIn("generation_error", result)
        self.assertEqual(generate.call_count, 4)
        self.assertIn("one", result["topics"][0])
        self.assertIn("two", result["topics"][0])

    def test_long_input_call_budget_includes_validation_retry(self):
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "SUMMARY_MAX_GENERATION_CALLS", 3), \
                patch.object(summarize, "_split_text_for_summary", return_value=["one", "two"]), \
                patch.object(summarize, "generate_ollama_text", side_effect=[
                    json.dumps(evidence_notes("one")), json.dumps(evidence_notes("two")), "{}",
                ]) as generate:
            result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "model")
        self.assert_invalid(result)
        self.assertEqual(generate.call_count, 3)

    def test_long_input_validation_logs_never_contain_private_source_or_response(self):
        events = []
        bad = evidence_notes("PRIVATE SOURCE", text="PRIVATE GENERATED ASSERTION")
        bad["notes"][0]["evidence_ids"] = ["PRIVATE UNKNOWN SPAN"]
        with patch.object(summarize, "MAX_DIRECT_SUMMARY_CHARS", 1), \
                patch.object(summarize, "_split_text_for_summary", return_value=["PRIVATE SOURCE"]), \
                patch.object(summarize, "generate_ollama_text", return_value=json.dumps(bad)), \
                self.assertLogs(level="INFO") as logs:
            result = summarize.summarize_meeting([{"text": "PRIVATE TRANSCRIPT"}], "PRIVATE MODEL", diagnostic_callback=events.append)
        self.assert_invalid(result)
        self.assertNotIn("PRIVATE", "\n".join(logs.output))
        reasons = [event["reason"] for event in events if event["event"] == "rejected"]
        self.assertEqual(len(reasons), 2)
        self.assertNotIn("PRIVATE", " ".join(reasons))
        self.assertIn("PRIVATE GENERATED ASSERTION", next(event["response"] for event in events if event["event"] == "raw_response"))

    def test_default_summary_does_not_emit_or_write_diagnostics(self):
        with patch.object(summarize, "generate_ollama_text", return_value='{"overview":"summary"}'), \
                patch("builtins.open") as open_file:
            result = summarize.summarize_meeting([{"text": "PRIVATE SOURCE"}], "model")
        self.assertEqual(result["overview"], "summary")
        open_file.assert_not_called()


if __name__ == "__main__":
    unittest.main()
