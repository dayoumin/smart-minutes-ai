import sys
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from pipeline.summarize import (  # noqa: E402
    generate_meeting_report,
    generate_speaker_context_summaries,
    generate_topic_sections,
)


class SummarizeFollowupTest(unittest.TestCase):
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
