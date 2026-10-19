import json
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest.mock import Mock, patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from pipeline.summarize import (  # noqa: E402
    _generate_json_once,
    _split_text_for_summary,
    generate_meeting_report,
    generate_speaker_context_summaries,
    generate_topic_sections,
    summarize_meeting,
)
from generation_gateway import GenerationFailure  # noqa: E402


class SummaryAttributionTest(unittest.TestCase):
    def assert_attribution_rules(self, prompt: str) -> None:
        self.assertIn("Speaker labels identify who spoke, not who a remark describes", prompt)
        self.assertIn("A nearby name, adjacent remark or shared speaker is not enough", prompt)
        self.assertIn("keep the remark separate using neutral wording without assigning a name", prompt)
        self.assertIn("explain the unresolved subject in needs_check", prompt)
        self.assertIn("Preserve explicitly named or otherwise unambiguous subjects", prompt)

    def test_ollama_receives_uncertainty_rules_and_keeps_separate_subjects(self):
        segments = [
            {"speaker": "SPEAKER_00", "text": "서연의 발표는 구성이 명확했어요."},
            {"speaker": "SPEAKER_01", "text": "옆 부서에 그런 사람이 있는데 태도가 불친절해요."},
        ]
        generated = {
            "title": "발표와 태도에 대한 의견",
            "overview": "발표 구성에 대한 칭찬과 대상이 불명확한 태도 평가가 나왔다.",
            "topics": ["서연의 발표 구성", "대상이 불명확한 태도 평가"],
            "decisions": [],
            "actions": [],
            "needs_check": ["태도 평가의 대상이 대화에서 명확하지 않음."],
        }
        with patch("pipeline.summarize.generate_ollama_text", return_value=json.dumps(generated, ensure_ascii=False)) as generate:
            result = summarize_meeting(segments, "gemma-test")

        self.assertEqual(generate.call_count, 1, "A short summary must not add another inference request")
        model, prompt = generate.call_args.args
        self.assertEqual(model, "gemma-test")
        self.assert_attribution_rules(prompt)
        for segment in segments:
            self.assertIn(segment["text"], prompt)
        self.assertEqual(result["topics"], generated["topics"])
        self.assertEqual(result["needs_check"], generated["needs_check"])
        self.assertEqual(result["decisions"], [])
        self.assertEqual(result["actions"], [])

    def test_explicit_named_subject_is_preserved_without_blanket_name_removal(self):
        generated = {
            "overview": "윤재가 일정 변경을 승인했다.",
            "topics": ["윤재의 일정 변경 승인"],
            "decisions": ["일정 변경 승인"],
            "needs_check": [],
        }
        with patch("pipeline.summarize.generate_ollama_text", return_value=json.dumps(generated, ensure_ascii=False)) as generate:
            result = summarize_meeting(
                [{"speaker": "SPEAKER_00", "text": "윤재가 일정 변경을 승인했다고 명확하게 말했습니다."}],
                "gemma-test",
            )

        self.assert_attribution_rules(generate.call_args.args[1])
        self.assertEqual(result["overview"], generated["overview"])
        self.assertEqual(result["topics"], generated["topics"])
        self.assertEqual(result["decisions"], generated["decisions"])
        self.assertEqual(result["needs_check"], [])

    def test_partial_summary_uncertainties_survive_merge(self):
        uncertainty = "태도 평가가 어느 사람에 관한 것인지 확인 필요"
        other_uncertainty = "인용한 의견의 발언자 확인 필요"
        segments = [
            {"speaker": "SPEAKER_00", "text": "검토자 가의 발표 자료가 명확했다는 평가가 나왔습니다."},
            {"speaker": "SPEAKER_01", "text": "다른 부서의 누군가가 불친절하다는 의견이 있었습니다."},
        ]
        partials = [
            {"notes": [{"kind": "discussion", "topic": "발표 평가", "text": "발표 자료에 대한 평가",
                        "evidence_ids": ["s1"], "opposing": [], "conditions": []}],
             "needs_check": [uncertainty, uncertainty]},
            {"notes": [{"kind": "discussion", "topic": "대상 미확인 의견", "text": "대상이 불명확한 의견",
                        "evidence_ids": ["s1"], "opposing": [], "conditions": []}],
             "needs_check": [other_uncertainty]},
        ]
        for final in (
            {"title": "평가 회의", "overview": "발표 평가와 대상이 불명확한 의견을 분리해 정리함.",
             "groups": [{"topic": "서로 다른 평가", "ids": ["u1-n1", "u2-n1"]}], "needs_check": [other_uncertainty]},
            {"title": "평가 회의", "overview": "발표 평가와 별도 의견을 정리했지만 확인 사항은 누락됨.",
             "groups": [{"topic": "서로 다른 평가", "ids": ["u1-n1", "u2-n1"]}]},
        ):
            with self.subTest(final=final), patch("pipeline.summarize.MAX_DIRECT_SUMMARY_CHARS", 40), \
                    patch("pipeline.summarize._split_text_for_summary", return_value=[segment["text"] for segment in segments]), \
                    patch("pipeline.summarize.generate_ollama_text", side_effect=[
                        json.dumps(value, ensure_ascii=False) for value in [*partials, final]
                    ]) as generate:
                result = summarize_meeting(segments, "gemma-test")

            self.assertEqual(generate.call_count, 3, "Use the existing two partial calls and one merge only")
            for call in generate.call_args_list:
                self.assert_attribution_rules(call.args[1])
            merge_prompt = generate.call_args_list[-1].args[1]
            # Uncertainties are carried independently, so even a grouping plan
            # that omits them cannot discard them or attach them to a person.
            self.assertIn("u1-n1", merge_prompt)
            self.assertIn("u2-n1", merge_prompt)
            self.assertEqual(result["needs_check"].count(uncertainty), 1)
            self.assertEqual(result["needs_check"].count(other_uncertainty), 1)
            self.assertIn("대상이 불명확한 의견", " ".join(result["topics"]))
            self.assertNotIn("검토자 가", " ".join(result["topics"]))

        with patch("pipeline.summarize.generate_ollama_text", return_value='{"overview":"새 회의 요약"}'):
            next_meeting = summarize_meeting(
                [{"speaker": "SPEAKER_00", "text": "다른 회의에서 일정만 논의했습니다."}],
                "gemma-test",
            )
        self.assertEqual(next_meeting["needs_check"], [], "Partial uncertainties must not leak to another meeting")

    def test_local_model_receives_the_same_attribution_contract(self):
        generated = {
            "overview": "대상이 확인되지 않은 평가를 분리해 정리함.",
            "topics": ["대상 미확인 평가"],
            "needs_check": ["평가 대상 확인 필요"],
        }
        llama = Mock(return_value={"choices": [{"text": json.dumps(generated, ensure_ascii=False)}]})
        factory = Mock(return_value=llama)
        module = types.ModuleType("llama_cpp")
        module.Llama = factory
        with tempfile.TemporaryDirectory() as tmp, patch.dict(sys.modules, {"llama_cpp": module}):
            model_path = Path(tmp) / "summary.gguf"
            model_path.write_bytes(b"test fixture; no inference")
            result = summarize_meeting(
                [{"speaker": "SPEAKER_00", "text": "누군가에 대한 평가인데 그 대상은 확인되지 않았습니다."}],
                str(model_path),
            )

        factory.assert_called_once()
        llama.assert_called_once()
        self.assert_attribution_rules(llama.call_args.args[0])
        self.assertEqual(result["overview"], generated["overview"])
        self.assertEqual(result["needs_check"], generated["needs_check"])


class SummarizeFollowupTest(unittest.TestCase):
    def test_missing_local_model_uses_model_missing_recovery_contract(self):
        with tempfile.TemporaryDirectory() as tmp:
            for filename in ("missing-summary-model.gguf", "missing-summary-model.GGUF", "missing-summary-model"):
                missing_model = Path(tmp) / filename
                with self.subTest(filename=filename):
                    with self.assertRaises(GenerationFailure) as raised:
                        _generate_json_once(str(missing_model), "prompt")

                    self.assertEqual(raised.exception.code, "model_missing")
                    self.assertEqual(raised.exception.user_action, "open_settings")
                    self.assertNotIn(str(missing_model), raised.exception.user_message)

    def test_topic_generation_accepts_top_level_array(self):
        with patch(
            "pipeline.summarize._generate_json_once",
            return_value=[{"topic": "예산", "summary": "예산 논의"}],
        ):
            sections = generate_topic_sections(
                [{"speaker": "SPEAKER_00", "text": "예산을 논의했습니다."}],
                {"overview": "예산 논의"},
                "gemma-test",
            )

        self.assertEqual(sections, [{"topic": "예산", "summary": "예산 논의", "evidence": [], "actions": []}])

    def test_topic_generation_accepts_section_aliases(self):
        with patch(
            "pipeline.summarize._generate_json_once",
            return_value={"sections": [{"title": "일정", "content": "다음 일정을 확인했습니다."}]},
        ):
            sections = generate_topic_sections(
                [{"speaker": "SPEAKER_00", "text": "다음 일정을 확인했습니다."}],
                {"overview": "일정 논의"},
                "gemma-test",
            )

        self.assertEqual(
            sections,
            [{"topic": "일정", "summary": "다음 일정을 확인했습니다.", "evidence": [], "actions": []}],
        )

    def test_topic_generation_retries_when_model_returns_summary_keywords(self):
        with patch(
            "pipeline.summarize._generate_json_once",
            side_effect=[
                {"summary": "Broad summary", "keywords": ["LLM", "business"]},
                {"topic_sections": [{"topic": "LLM update", "summary": "Model updates were discussed."}]},
            ],
        ):
            sections = generate_topic_sections(
                [{"speaker": "SPEAKER_00", "text": "Model updates were discussed."}],
                {"overview": "Model updates"},
                "gemma-test",
            )

        self.assertEqual(
            sections,
            [{"topic": "LLM update", "summary": "Model updates were discussed.", "evidence": [], "actions": []}],
        )

    def test_topic_generation_falls_back_from_summary_keywords(self):
        with patch(
            "pipeline.summarize._generate_json_once",
            return_value={"summary": "Broad summary", "keywords": ["LLM", "business", "cost"]},
        ):
            sections = generate_topic_sections(
                [{"speaker": "SPEAKER_00", "text": "Model updates were discussed."}],
                {"overview": "Model updates"},
                "gemma-test",
            )

        self.assertEqual(
            sections,
            [{
                "topic": "LLM / business / cost",
                "summary": "Broad summary",
                "evidence": ["LLM", "business", "cost"],
                "actions": [],
            }],
        )

    def test_speaker_context_retries_when_model_returns_general_text(self):
        with patch(
            "pipeline.summarize._generate_json_once",
            side_effect=[
                {"text": "General meeting summary."},
                {
                    "speaker_context_summaries": [
                        {"speaker": "SPEAKER_00", "display_name": "Speaker 00", "summary": "Opened the discussion."}
                    ]
                },
            ],
        ):
            summaries = generate_speaker_context_summaries(
                [{"speaker": "SPEAKER_00", "text": "Opened the discussion."}],
                {"overview": "Meeting overview"},
                [{"topic": "Opening", "summary": "Opening discussion"}],
                "gemma-test",
            )

        self.assertEqual(summaries[0]["speaker"], "SPEAKER_00")
        self.assertEqual(summaries[0]["summary"], "Opened the discussion.")

    def test_speaker_context_falls_back_to_transcript_by_speaker(self):
        with patch("pipeline.summarize._generate_json_once", return_value={"text": "General meeting summary."}):
            summaries = generate_speaker_context_summaries(
                [
                    {"speaker": "SPEAKER_00", "speaker_name": "Speaker 00", "text": "Opened the discussion."},
                    {"speaker": "SPEAKER_01", "speaker_name": "Speaker 01", "text": "Shared a concern."},
                ],
                {"overview": "Meeting overview"},
                [{"topic": "Opening", "summary": "Opening discussion"}],
                "gemma-test",
            )

        self.assertEqual([item["speaker"] for item in summaries], ["SPEAKER_00", "SPEAKER_01"])
        self.assertIn("Opened the discussion.", summaries[0]["summary"])
        self.assertTrue(summaries[0]["needs_check"])

    def test_meeting_report_applies_custom_template_section_order(self):
        template = {
            "id": "custom-report",
            "name": "위원회 보고 양식",
            "purpose": "위원회 보고에 맞춰 쟁점과 조치를 분리한다.",
            "instructions": "간결한 보고 문체로 작성한다.",
            "sections": ["검토 배경", "결론 및 조치"],
        }
        captured_prompts: list[str] = []

        def fake_generate_json(_model, prompt):
            captured_prompts.append(prompt)
            return {
                "content": "보고서 전체 본문입니다.",
                "sections": [
                    {"title": "결론 및 조치", "content": "조치 본문"},
                    {"title": "검토 배경", "content": "배경 본문"},
                    {"title": "추가 제목", "content": "참고로 남을 본문"},
                ],
            }

        with patch("pipeline.summarize._generate_json_once", side_effect=fake_generate_json):
            report = generate_meeting_report(
                [{"speaker": "SPEAKER_00", "text": "위원회 보고 배경과 조치를 논의했습니다."}],
                {"overview": "위원회 보고 배경과 조치 논의"},
                [{"topic": "보고", "summary": "보고 배경과 후속 조치"}],
                [],
                template,
                "gemma-test",
                meeting_context={
                    "title": "보고 양식 검증 회의",
                    "meeting_purpose": "보고서 템플릿 적용 확인",
                    "report_template": template,
                },
            )

        self.assertEqual([section["title"] for section in report["sections"]], ["검토 배경", "결론 및 조치", "참고"])
        self.assertEqual(report["sections"][0]["content"], "배경 본문")
        self.assertEqual(report["sections"][1]["content"], "조치 본문")
        self.assertIn("추가 제목", report["sections"][2]["content"])
        self.assertIn("참고로 남을 본문", report["sections"][2]["content"])
        self.assertEqual(len(captured_prompts), 1)
        prompt = captured_prompts[0]
        self.assertIn("위원회 보고 양식", prompt)
        self.assertIn("위원회 보고에 맞춰 쟁점과 조치를 분리한다.", prompt)
        self.assertIn('"검토 배경", "결론 및 조치"', prompt)
        self.assertIn("Use these section titles as the final report section titles", prompt)

    def test_meeting_report_uses_first_template_section_for_plain_content_response(self):
        template = {"sections": ["검토 배경", "결론 및 조치"]}
        with patch(
            "pipeline.summarize._generate_json_once",
            return_value={"content": "섹션 없이 돌아온 보고서 본문입니다."},
        ):
            report = generate_meeting_report(
                [{"speaker": "SPEAKER_00", "text": "검토 배경을 논의했습니다."}],
                {"overview": "검토 배경 논의"},
                report_template=template,
                model_name_or_path="gemma-test",
            )

        self.assertEqual(
            report["sections"],
            [{"title": "검토 배경", "content": "섹션 없이 돌아온 보고서 본문입니다."}],
        )

    def test_meeting_report_does_not_relabel_exact_later_section_to_missing_first_section(self):
        template = {"sections": ["검토 배경", "결론 및 조치"]}
        with patch(
            "pipeline.summarize._generate_json_once",
            return_value={
                "content": "결론 및 조치만 반환된 보고서입니다.",
                "sections": [{"title": "결론 및 조치", "content": "조치 본문"}],
            },
        ):
            report = generate_meeting_report(
                [{"speaker": "SPEAKER_00", "text": "후속 조치를 결정했습니다."}],
                {"overview": "후속 조치 결정"},
                report_template=template,
                model_name_or_path="gemma-test",
            )

        self.assertEqual(report["sections"], [{"title": "결론 및 조치", "content": "조치 본문"}])

    def test_meeting_report_retries_when_sections_do_not_match_template(self):
        template = {"sections": ["검토 배경", "결론 및 조치"]}
        with patch(
            "pipeline.summarize._generate_json_once",
            side_effect=[
                {
                    "content": "처음 보고서입니다.",
                    "sections": [{"title": "무관한 섹션", "content": "재시도 대상 본문"}],
                },
                {
                    "content": "재시도 보고서입니다.",
                    "sections": [{"title": "검토 배경", "content": "재시도 배경 본문"}],
                },
            ],
        ) as generate_json:
            report = generate_meeting_report(
                [{"speaker": "SPEAKER_00", "text": "검토 배경을 논의했습니다."}],
                {"overview": "검토 배경 논의"},
                report_template=template,
                model_name_or_path="gemma-test",
            )

        self.assertEqual(generate_json.call_count, 2)
        self.assertEqual(report["sections"], [{"title": "검토 배경", "content": "재시도 배경 본문"}])

    def test_meeting_report_keeps_unmatched_retry_sections_as_reference(self):
        template = {"sections": ["검토 배경", "결론 및 조치"]}
        with patch(
            "pipeline.summarize._generate_json_once",
            side_effect=[
                {
                    "content": "처음 보고서입니다.",
                    "sections": [{"title": "무관한 섹션", "content": "처음 본문"}],
                },
                {
                    "content": "재시도 보고서입니다.",
                    "sections": [{"title": "여전히 무관한 섹션", "content": "보존할 본문"}],
                },
            ],
        ):
            report = generate_meeting_report(
                [{"speaker": "SPEAKER_00", "text": "검토 배경을 논의했습니다."}],
                {"overview": "검토 배경 논의"},
                report_template=template,
                model_name_or_path="gemma-test",
            )

        self.assertEqual(report["sections"], [{"title": "참고", "content": "여전히 무관한 섹션\n보존할 본문"}])


if __name__ == "__main__":
    unittest.main()
