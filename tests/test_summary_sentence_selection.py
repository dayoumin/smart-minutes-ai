import sys
from copy import deepcopy
from pathlib import Path
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from pipeline.summary_sentence_selection import (
    STATES, normalize_selections, selection_prompt, selection_schema, sentence_windows, validate_states,
    normalize_checked_roles, validate_checked, decode_fact_labels, parse_model_labels,
)
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from scripts.eval_summary_sentence_states import evaluate, validate_case


class SentenceSelectionTests(unittest.TestCase):
    def setUp(self):
        self.source = [{"id": f"p1s{i}", "speaker": "A", "segment": 1, "text": text}
                       for i, text in enumerate([
                           "접속하면 제목이 남습니다.", "오류가 생기면 기록합니다.",
                           "아직 확인하지 않았습니다.", "원본을 바꾸지 않습니다.",
                           "이번 안건을 소개합니다.", "새 기능을 검토합시다.",
                       ], 1)]

    def test_all_states_are_requested_and_unknown_ids_rejected(self):
        schema = selection_schema(self.source)
        self.assertEqual(schema["required"], [s["id"] for s in self.source])
        self.assertEqual(schema["properties"]["p1s1"]["enum"], list(STATES))
        for bad in ({}, {"unknown": "background"}, {s["id"]: "invented" for s in self.source}):
            with self.subTest(bad=bad), self.assertRaises(ValueError):
                validate_states(bad, self.source)

    def test_non_problem_states_never_become_observed_problems_and_all_text_survives(self):
        states = dict(zip([s["id"] for s in self.source], [
            "observed_normal", "hypothetical", "unconfirmed", "constraint", "background", "proposal",
        ]))
        result = normalize_selections(self.source, [states])
        self.assertEqual(result["problems"], [])
        self.assertEqual([s["text"] for s in result["sentences"]], [s["text"] for s in self.source])
        self.assertEqual([s["id"] for s in result["conditions"]], ["p1s2", "p1s3", "p1s4"])
        self.assertEqual([s["id"] for s in result["context"]], ["p1s1", "p1s5"])
        self.assertEqual(result["goals"][0]["id"], "p1s6")

    def test_overlap_conflict_is_preserved_for_review_instead_of_unioning_problem(self):
        states = {s["id"]: "background" for s in self.source}
        result = normalize_selections(self.source, [states, {"p1s1": "observed_problem"}])
        self.assertEqual(result["problems"], [])
        self.assertEqual(result["needs_check"][0]["text"], self.source[0]["text"])
        self.assertEqual(result["needs_check"][0]["states"], ["background", "observed_problem"])
        self.assertEqual(len(result["sentences"]), len(self.source))

    def test_missing_classification_is_failure_and_identical_overlap_is_deduplicated(self):
        with self.assertRaises(ValueError):
            normalize_selections(self.source, [{"p1s1": "observed_normal"}])
        states = {s["id"]: "observed_problem" for s in self.source}
        result = normalize_selections(self.source, [states, states])
        self.assertEqual(len(result["problems"]), len(self.source))
        self.assertEqual(result["needs_check"], [])

    def test_dual_role_and_invalid_duplicate_source(self):
        result = normalize_selections(self.source[:1], [{"p1s1": "proposal_constraint"}])
        self.assertEqual(result["goals"][0]["text"], result["conditions"][0]["text"])
        for bad in ([], self.source + [self.source[0]]):
            with self.assertRaises(ValueError):
                selection_schema(bad)

    def test_prompt_contains_original_negations_without_rewriting(self):
        prompt = selection_prompt(self.source)
        for row in self.source:
            self.assertIn(f'[{row["id"]}] A: {row["text"]}', prompt)

    def test_windows_cover_all_sentences_without_cutting_a_long_sentence(self):
        source = self.source + [{"id": "long", "speaker": "A", "text": "가" * 700}]
        windows = sentence_windows(source, 30)
        self.assertEqual({s["id"] for w in windows for s in w}, {s["id"] for s in source})
        self.assertEqual(windows[-1][-1]["text"], "가" * 700)
        self.assertLessEqual(len(windows), len(source))

    def test_evaluator_rejects_unscored_conflict(self):
        source = self.source[:2]
        states = {"p1s1": "observed_normal", "p1s2": "background"}
        case = {"source": source, "expected_states": {"p1s1": ["observed_normal"]},
                "core": [], "constraints": []}
        predictions = [states, {"p1s2": "constraint"}]
        result = normalize_selections(source, predictions)
        self.assertEqual(evaluate(case, predictions, result)["conflict_ids"], ["p1s2"])
        self.assertFalse(evaluate(case, predictions, result)["semantic_gate_passed"])

    def test_evaluator_rejects_changed_quote_even_if_roles_match(self):
        source = self.source[:1]
        predictions = [{"p1s1": "observed_normal"}]
        case = {"source": source, "expected_states": {"p1s1": ["observed_normal"]},
                "core": [], "constraints": []}
        result = normalize_selections(source, predictions)
        self.assertTrue(evaluate(case, predictions, result)["semantic_gate_passed"])
        broken = deepcopy(result)
        broken["sentences"][0]["text"] = "변조된 문장"
        self.assertFalse(evaluate(case, predictions, broken)["all_source_quotes_preserved"])
        self.assertFalse(evaluate(case, predictions, broken)["semantic_gate_passed"])

    def test_role_candidates_need_independent_factual_confirmation(self):
        source = self.source[:3]
        roles = {s["id"]: "problem" for s in source}
        facts = dict(zip(roles, ["observed_normal", "hypothetical", "unconfirmed"]))
        result = normalize_checked_roles(source, [roles], [facts])
        self.assertEqual(result["problems"], [])
        self.assertEqual([s["id"] for s in result["conditions"]], ["p1s2", "p1s3"])
        self.assertEqual(result["context"][0]["states"], ["observed_normal"])

    def test_checked_roles_preserve_goals_and_do_not_promote_unconfirmed_defects(self):
        source = self.source[:3]
        roles = {"p1s1": "goal", "p1s2": "other", "p1s3": "problem"}
        facts = {"p1s1": "not_factual", "p1s2": "unconfirmed", "p1s3": "not_factual"}
        result = normalize_checked_roles(source, [roles], [facts])
        self.assertEqual(result["goals"][0]["id"], "p1s1")
        self.assertEqual(result["conditions"][0]["id"], "p1s2")
        self.assertEqual(result["needs_check"][0]["id"], "p1s3")
        with self.assertRaises(ValueError):
            validate_checked({"p1s1": "proposal"}, source[:1], fact_check=True)

    def test_checked_overlap_and_new_problem_claim_are_reviewed_without_promotion(self):
        source = self.source[:1]
        result = normalize_checked_roles(source, [{"p1s1": "other"}], [{"p1s1": "observed_problem"}])
        self.assertEqual(result["problems"], [])
        self.assertEqual(len(result["needs_check"]), 1)
        case = {"source": source, "expected_states": {"p1s1": ["observed_problem"]}, "core": [], "constraints": []}
        self.assertEqual(evaluate(case, [{"p1s1": "observed_problem"}], result)["missing_observed_problem_ids"], ["p1s1"])

    def test_native_fact_labels_are_validated_and_normalized(self):
        self.assertEqual(decode_fact_labels({"p1s1": "정상동작"}, self.source[:1]), {"p1s1": "observed_normal"})
        with self.assertRaises(ValueError):
            decode_fact_labels({"p1s1": "observed_normal"}, self.source[:1])

    def test_future_goal_and_observed_success_conflict_is_preserved_for_review(self):
        result = normalize_checked_roles(self.source[:1], [{"p1s1": "goal"}], [{"p1s1": "observed_normal"}])
        self.assertEqual(result["goals"], [])
        self.assertEqual(result["needs_check"][0]["id"], "p1s1")

    def test_test_instruction_and_observed_success_conflict_is_preserved(self):
        result = normalize_checked_roles(self.source[:1], [{"p1s1": "condition"}], [{"p1s1": "observed_normal"}])
        self.assertEqual(result["conditions"], [])
        self.assertEqual(result["needs_check"][0]["id"], "p1s1")

    def test_frozen_case_criteria_reference_only_known_sources(self):
        case = {"source": self.source[:1], "expected_states": {"p1s1": ["observed_normal"]}, "core": [], "constraints": []}
        validate_case(case)
        for bad in ({**case, "expected_states": {"missing": ["background"]}},
                    {**case, "core": [{"role": "goals", "any": ["missing"]}]}):
            with self.assertRaises(ValueError):
                validate_case(bad)

    def test_duplicate_model_keys_cannot_silently_replace_an_earlier_state(self):
        with self.assertRaisesRegex(ValueError, "duplicate_model_id"):
            parse_model_labels('{"p1s1":"actual", "p1s1":"other"}')


if __name__ == "__main__":
    unittest.main()
