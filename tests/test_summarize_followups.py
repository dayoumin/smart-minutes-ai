import sys
import unittest
from pathlib import Path
from unittest.mock import patch

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from pipeline.summarize import generate_speaker_context_summaries, generate_topic_sections  # noqa: E402


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


if __name__ == "__main__":
    unittest.main()
