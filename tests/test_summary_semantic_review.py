"""Advisory saved-partial diagnostics; no real model, server or source edits."""
import copy
import io
import json
import os
from pathlib import Path
import sys
import tempfile
import unittest
import urllib.request
import urllib.response
from unittest.mock import patch

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from pipeline import summary_review as review
from scripts import review_summary_diagnostics as runner


SOURCE = "화자00: 추가 자료를 요청할 근거가 부족하다.\n화자01: 자료가 도착하면 검토한다.\n화자02: 5월 29일 14시 다음 회의에 뵙겠습니다."


def saved_events():
    spans = review.source_spans(SOURCE)
    def claim(text, index):
        return {"text": text, "evidence": [copy.deepcopy(spans[index])]}
    notes = [
        {"id": "u1-n1", "kind": "discussion", "topic": "자료 검토", **claim("추가 요청 근거가 일부 부족하다는 의견", 0),
         "opposing": [claim("추가 요청 근거가 충분하다는 반론", 0)], "conditions": [claim("자료 도착 시 검토", 1)]},
        {"id": "u1-n2", "kind": "decision", "topic": "차기 일정", **claim("차기 회의는 5월 29일 14시", 2), "opposing": [], "conditions": []},
    ]
    return [{"event": "stage_input", "stage": "partial-1", "source": SOURCE},
            {"event": "accepted", "stage": "partial-1", "summary": {"notes": notes, "needs_check": []}}]


def verdict_for(probe):
    if probe["kind"] == "claim":
        return {"verdict": "unclear", "reason": "원문 대조가 필요함"}
    if probe["kind"] == "timeline":
        return {"settled": True, "summary": "다음 회의는 5월 29일 14시", "evidence_ids": ["s3"], "reason": "마지막 발언의 일정"}
    return {"state": "confirmed", "evidence_ids": ["s3"]}


def http_response(request, payload):
    response = urllib.response.addinfourl(io.BytesIO(json.dumps(payload).encode()), {}, request.full_url, 200)
    response.msg = "OK"
    return response


class SavedPartialProbeTest(unittest.TestCase):
    def test_selected_note_has_one_claim_per_probe_and_exact_scope(self):
        events = saved_events()
        original = copy.deepcopy(events)
        claims = [probe for probe in review.build_probes(events, ["partial-1"], ["u1-n1"]) if probe["kind"] == "claim"]
        expected = ["추가 요청 근거가 일부 부족하다는 의견", "추가 요청 근거가 충분하다는 반론", "자료 도착 시 검토"]
        self.assertEqual(len(claims), 3)
        for probe, candidate in zip(claims, expected):
            self.assertEqual(probe["prompt"].count("후보 주장:"), 1)
            self.assertTrue(probe["prompt"].endswith("후보 주장: " + candidate))
            for other in expected:
                if other != candidate:
                    self.assertNotIn(other, probe["prompt"])
            self.assertNotIn("차기 회의는", probe["prompt"])
        self.assertEqual(events, original)

    def test_category_claims_are_reviewed_and_keep_legacy_saved_notes_compatible(self):
        events = saved_events()
        note = events[1]["summary"]["notes"][0]
        for field, text in (("problems", "검토 자료가 부족하다"), ("goals", "자료가 도착하면 검토하려 한다")):
            note[field] = [{"text": text, "evidence": [copy.deepcopy(review.source_spans(SOURCE)[0])]}]
        probes = review.build_probes(events, ["partial-1"], ["u1-n1"])
        for field in ("problems", "goals"):
            probe = next(p for p in probes if p["id"] == f"partial-1/u1-n1/{field}/0")
            self.assertTrue(probe["prompt"].endswith("후보 주장: " + note[field][0]["text"]))
            damaged = copy.deepcopy(events)
            damaged[1]["summary"]["notes"][0][field][0]["evidence"][0]["quote"] = "altered quote"
            with self.subTest(field=field), self.assertRaises(ValueError):
                review.build_probes(damaged, ["partial-1"], ["u1-n1"])
        # Existing tests above deliberately retain the old saved-note shape.

    def test_timeline_uses_source_order_without_candidate_note_content(self):
        timeline = next(probe for probe in review.build_probes(saved_events(), ["partial-1"], ["u1-n1"], schedule_mode="state") if probe["kind"] == "timeline_state")
        self.assertEqual(json.loads(timeline["prompt"].split("Utterances:\n", 1)[1]), review.source_spans(SOURCE))
        self.assertNotIn("추가 요청 근거가 충분하다는 반론", timeline["prompt"])
        self.assertNotIn("차기 회의는", timeline["prompt"])

    def test_dateless_cancellation_change_and_agreement_are_not_filtered_out(self):
        for update in ("그 회의는 취소합니다.", "그 일정을 하루 뒤로 옮기기로 합의했습니다.", "네, 그때 뵙겠습니다."):
            events = saved_events()
            events[0]["source"] += "\n" + update
            original = copy.deepcopy(events)
            timeline = next(p for p in review.build_probes(events, ["partial-1"], schedule_mode="state") if p["kind"] == "timeline_state")
            submitted = json.loads(timeline["prompt"].split("Utterances:\n", 1)[1])
            self.assertEqual(submitted, review.source_spans(events[0]["source"]))
            self.assertEqual(submitted[-1]["quote"], update)
            self.assertIn(submitted[-1]["id"], timeline["schema"]["properties"]["evidence_ids"]["items"]["enum"])
            self.assertEqual(events, original)

    def test_dateless_schedule_discussion_triggers_a_complete_unit_probe(self):
        events = saved_events()
        # Preserve existing claim anchors while removing the sole dated note.
        events[0]["source"] = "\n".join(SOURCE.splitlines()[:2]) + "\n다음 회의 일정은 아직 논의하지 않았습니다."
        events[1]["summary"]["notes"].pop()
        timeline = next(p for p in review.build_probes(events, ["partial-1"], schedule_mode="state") if p["kind"] == "timeline_state")
        self.assertEqual(json.loads(timeline["prompt"].split("Utterances:\n", 1)[1]), review.source_spans(events[0]["source"]))

    def test_missing_unknown_duplicate_or_ambiguous_scope_is_rejected(self):
        for stages, notes in (([], []), (["merge-1-1"], []), (["partial-1"] * 2, []), (["partial-2"], []), (["partial-1"], ["unknown"])):
            with self.subTest(stages=stages, notes=notes), self.assertRaises(ValueError):
                review.build_probes(saved_events(), stages, notes)
        for position in (0, 1):
            for duplicate in (False, True):
                events = saved_events()
                if duplicate:
                    events.append(copy.deepcopy(events[position]))
                else:
                    events.pop(position)
                with self.subTest(position=position, duplicate=duplicate), self.assertRaises(ValueError):
                    review.build_probes(events, ["partial-1"])

    def test_changed_or_unknown_source_anchors_are_rejected(self):
        for anchor in ({"id": "unknown", "quote": SOURCE.splitlines()[0]}, {"id": "s1", "quote": "의역된 인용"}):
            events = saved_events()
            events[1]["summary"]["notes"][0]["evidence"] = [anchor]
            with self.subTest(anchor=anchor), self.assertRaises(ValueError):
                review.build_probes(events, ["partial-1"], ["u1-n1"])

    def test_probe_bound_fails_without_truncating_or_editing_source(self):
        events = saved_events()
        original = copy.deepcopy(events)
        with patch.object(review, "MAX_PROBE_CHARS", 50), self.assertRaises(ValueError):
            review.build_probes(events, ["partial-1"])
        self.assertEqual(events, original)

    def test_supported_contradicted_and_unclear_are_advisory_values_not_quality_passes(self):
        probes = review.build_probes(saved_events(), ["partial-1"])
        for probe in probes:
            self.assertEqual(review.validate_verdict(probe, verdict_for(probe)), verdict_for(probe))
        claim = next(probe for probe in probes if probe["kind"] == "claim")
        for verdict in ("supported", "contradicted", "unclear"):
            self.assertEqual(review.validate_verdict(claim, {"verdict": verdict, "reason": "검토 이유"})["verdict"], verdict)

    def test_invalid_fields_and_unknown_duplicate_or_missing_timeline_refs_are_rejected(self):
        probes = review.build_probes(saved_events(), ["partial-1"], schedule_mode="state")
        claim = next(probe for probe in probes if probe["kind"] == "claim")
        for value in ({}, [], {"verdict": "pass", "reason": "reason"}, {"verdict": "supported", "reason": " "},
                      {"verdict": "supported", "reason": "reason", "rewrite": "forbidden"}):
            with self.subTest(value=value), self.assertRaises(ValueError):
                review.validate_verdict(claim, value)
        timeline = next(probe for probe in probes if probe["kind"] == "timeline_state")
        for changes in ({"evidence_ids": ["unknown"]}, {"evidence_ids": ["s3", "s3"]}, {"evidence_ids": []}, {"state": []}, {"state": "pass"}, {"summary": "forbidden"}):
            with self.subTest(changes=changes), self.assertRaises(ValueError):
                review.validate_verdict(timeline, {**verdict_for(timeline), **changes})
        for state in review.SCHEDULE_STATES:
            self.assertEqual(review.validate_verdict(timeline, {"state": state, "evidence_ids": ["s3"]})["state"], state)
        for state in ("unclear", "no_schedule"):
            self.assertEqual(review.validate_verdict(timeline, {"state": state, "evidence_ids": []})["state"], state)
        for state in set(review.SCHEDULE_STATES) - {"unclear", "no_schedule"}:
            with self.subTest(state=state), self.assertRaises(ValueError):
                review.validate_verdict(timeline, {"state": state, "evidence_ids": []})

    def test_schedule_contract_has_one_state_and_no_rewrite_and_rejects_oversize(self):
        spans = review.source_spans(SOURCE)
        probe = review.schedule_probe(spans, "explicit-scope")
        self.assertEqual(set(probe["schema"]["required"]), {"state", "evidence_ids"})
        self.assertIn("changed", probe["schema"]["properties"]["state"]["enum"])
        self.assertIn("conditional", probe["schema"]["properties"]["state"]["enum"])
        original = copy.deepcopy(spans)
        with patch.object(review, "MAX_PROBE_CHARS", 50), self.assertRaises(ValueError):
            review.schedule_probe(spans, "explicit-scope")
        self.assertEqual(spans, original)
        with self.assertRaises(ValueError):
            review.schedule_probe([], "explicit-scope")

    def test_state_mode_is_explicit_and_legacy_also_keeps_complete_unit(self):
        events = saved_events()
        events[0]["source"] += "\n그 회의는 취소합니다."
        legacy = next(p for p in review.build_probes(events, ["partial-1"]) if p["kind"] == "timeline")
        state = next(p for p in review.build_probes(events, ["partial-1"], schedule_mode="state") if p["kind"] == "timeline_state")
        for probe in (legacy, state):
            self.assertEqual(json.loads(probe["prompt"].split("Utterances:\n", 1)[1]), review.source_spans(events[0]["source"]))
        self.assertEqual(set(legacy["schema"]["required"]), {"settled", "summary", "evidence_ids", "reason"})
        with self.assertRaises(ValueError):
            review.build_probes(events, ["partial-1"], schedule_mode="unknown")


class SavedPartialReviewRunnerTest(unittest.TestCase):
    def setUp(self):
        parent = REPO / ".tmp" / "agent-review"
        parent.mkdir(parents=True, exist_ok=True)
        self.temp = tempfile.TemporaryDirectory(prefix="saved-probes-", dir=parent)
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.saved = self.root / "saved"
        self.saved.mkdir()
        source = b'{"job_id":"fixture-job","summary":{"overview":"saved source"}}'
        manifest = {"job_id": "fixture-job", "source_sha256": runner.digest(source), "model": "fixture-model", "runtime": {"model": {"digest": "fixture-digest"}}}
        for name, value in (("manifest.json", json.dumps(manifest).encode()), ("source-result.json", source),
                            ("events.jsonl", "\n".join(json.dumps(event, ensure_ascii=False) for event in saved_events()).encode()),
                            ("final-summary.json", b'{"overview":"original final"}')):
            (self.saved / name).write_bytes(value)
        self.before = {path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in self.saved.iterdir()}

    def invoke(self, **kwargs):
        return runner.review_saved(self.saved, self.root / "private", ["partial-1"], [], "fixture-model", "http://127.0.0.1:17965", **kwargs)

    def assert_saved_unchanged(self):
        self.assertEqual({path.name: (path.read_bytes(), path.stat().st_mtime_ns) for path in self.saved.iterdir()}, self.before)

    def test_prepare_only_has_no_network_and_preserves_original_four_files(self):
        with patch.object(runner, "runtime_identity") as runtime, patch.object(runner, "local_opener") as opener:
            run = self.invoke(prepare_only=True)
        runtime.assert_not_called()
        opener.assert_not_called()
        manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["planned_calls"], 5)
        self.assertEqual(manifest["new_model_calls"], 0)
        self.assertFalse(manifest["summary_rewritten"])
        self.assertEqual(manifest["semantic_quality"], "not_evaluated")
        self.assertTrue(manifest["saved_inputs_unchanged"])
        self.assert_saved_unchanged()

    def test_experimental_state_mode_is_recorded_and_preparation_never_calls_model(self):
        with patch.object(runner, "runtime_identity") as runtime, patch.object(runner, "local_opener") as opener:
            run = self.invoke(prepare_only=True, schedule_mode="state")
        runtime.assert_not_called()
        opener.assert_not_called()
        manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["schedule_mode"], "state")
        self.assertEqual(manifest["new_model_calls"], 0)
        self.assertFalse(manifest["summary_rewritten"])
        self.assert_saved_unchanged()

    def test_budget_or_invalid_destination_fails_before_network_or_private_run_creation(self):
        with patch.object(runner, "runtime_identity") as runtime, patch.object(runner, "private_run_directory") as create:
            for budget in (0, 1, 65):
                with self.subTest(budget=budget), self.assertRaises(ValueError):
                    self.invoke(max_calls=budget)
            with self.assertRaises(ValueError):
                runner.review_saved(self.saved, self.saved / "new", ["partial-1"], [], "fixture-model", "http://localhost")
        runtime.assert_not_called()
        create.assert_not_called()
        self.assert_saved_unchanged()

    def test_wrong_source_hash_or_model_is_rejected_before_network(self):
        with patch.object(runner, "runtime_identity") as runtime:
            (self.saved / "source-result.json").write_bytes(b"{}")
            with self.assertRaises(ValueError):
                self.invoke()
            (self.saved / "source-result.json").write_bytes(self.before["source-result.json"][0])
            manifest = json.loads((self.saved / "manifest.json").read_text(encoding="utf-8"))
            manifest["model"] = "other"
            (self.saved / "manifest.json").write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaises(ValueError):
                self.invoke()
        runtime.assert_not_called()

    def test_runtime_digest_mismatch_never_sends_private_prompts(self):
        with patch.object(runner, "runtime_identity", return_value={"model": {"digest": "different"}}), patch.object(runner, "local_opener") as opener, self.assertRaises(ValueError):
            self.invoke()
        opener.assert_not_called()
        self.assert_saved_unchanged()

    def test_script_protected_transport_preserves_environment_and_source_and_stays_advisory(self):
        requests = []
        probes = review.build_probes(saved_events(), ["partial-1"])
        def send(_handler, request):
            requests.append(request)
            self.assertEqual(request.host, "127.0.0.1:17965")
            if request.full_url.endswith("/api/ps"):
                return http_response(request, {"models": [{"name": "fixture-model", "context_length": 4096}]})
            submitted = json.loads(request.data)
            index = sum(item.full_url.endswith("/api/generate") for item in requests) - 1
            self.assertEqual(submitted["prompt"], probes[index]["prompt"])
            self.assertEqual(submitted["format"], probes[index]["schema"])
            return http_response(request, {"response": json.dumps(verdict_for(probes[index])), "done": True, "done_reason": "stop", "prompt_eval_count": 123, "eval_count": 12})
        with patch.object(runner, "runtime_identity", return_value={"model": {"digest": "fixture-digest"}}), \
                patch.object(urllib.request.HTTPHandler, "http_open", send), \
                patch.object(urllib.request, "urlopen", side_effect=AssertionError("Default transport must not see prompts")), \
                patch.dict(os.environ, {"HTTP_PROXY": "http://proxy.example:8080", "http_proxy": "http://proxy.example:8080", "NO_PROXY": "", "no_proxy": "", "OLLAMA_HOST": "original:11434"}):
            environment = dict(os.environ)
            run = self.invoke()
            self.assertEqual(dict(os.environ), environment)
        manifest = json.loads((run / "manifest.json").read_text(encoding="utf-8"))
        final = json.loads((run / "final-summary.json").read_text(encoding="utf-8"))
        self.assertEqual(manifest["status"], "completed_advisory")
        self.assertEqual(manifest["new_model_calls"], 5)
        self.assertEqual(manifest["semantic_quality"], "not_evaluated")
        self.assertTrue(final["advisory_only"])
        self.assertFalse(final["summary_rewritten"])
        self.assertEqual(final["results"][0]["verdict"]["verdict"], "unclear")
        self.assertTrue(all(item["status"] == "advisory_unreviewed" for item in final["results"]))
        trace = [json.loads(line) for line in (run / "events.jsonl").read_text(encoding="utf-8").splitlines()]
        self.assertLess(next(i for i, event in enumerate(trace) if event["event"] == "raw_response"), next(i for i, event in enumerate(trace) if event["event"] == "advisory_result"))
        self.assertEqual(len([event for event in trace if event["event"] == "provider_metadata"]), 5)
        self.assert_saved_unchanged()

    def test_invalid_and_truncated_responses_are_distinct_from_unclear_without_retries(self):
        values = iter(["not JSON", {"verdict": "supported", "reason": "extra", "rewrite": "forbidden"},
                       {"verdict": "unclear", "reason": "needs context"}, {"verdict": "supported", "reason": "truncated"},
                       {"state": "confirmed", "evidence_ids": ["unknown"]}])
        calls = []
        def send(_handler, request):
            if request.full_url.endswith("/api/ps"):
                return http_response(request, {"models": []})
            calls.append(request)
            value = next(values)
            return http_response(request, {"response": value if isinstance(value, str) else json.dumps(value), "done": True, "done_reason": "length" if len(calls) == 4 else "stop"})
        with patch.object(runner, "runtime_identity", return_value={"model": {"digest": "fixture-digest"}}), patch.object(urllib.request.HTTPHandler, "http_open", send):
            run = self.invoke()
        final = json.loads((run / "final-summary.json").read_text(encoding="utf-8"))
        self.assertEqual(len(calls), 5)
        self.assertEqual([item["status"] for item in final["results"]], ["invalid_response", "invalid_response", "advisory_unreviewed", "invalid_response", "invalid_response"])
        self.assertEqual(final["results"][2]["verdict"]["verdict"], "unclear")
        self.assert_saved_unchanged()


if __name__ == "__main__":
    unittest.main()
