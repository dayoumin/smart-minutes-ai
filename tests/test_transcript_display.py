import copy
import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from pipeline.transcript_display import build_display_segments, get_transcript_segments  # noqa: E402


class TranscriptDisplayTest(unittest.TestCase):
    def test_merging_preserves_later_review_flags_and_does_not_mutate_source(self) -> None:
        flag_pairs = {
            "speaker_needs_review": "speakerNeedsReview",
            "speaker_split_coverage_gap": "speakerSplitCoverageGap",
            "speaker_split_coverage_overlap": "speakerSplitCoverageOverlap",
            "short_speaker_overlap": "shortSpeakerOverlap",
            "mixed_speaker_split": "mixedSpeakerSplit",
        }
        for snake, camel in flag_pairs.items():
            for input_key in (snake, camel):
                with self.subTest(flag=input_key):
                    segments = [
                        {"start": 0, "end": 2, "speaker": "SPEAKER_00", "text": "첫 발언", snake: False},
                        {"start": 2, "end": 4, "speaker": "SPEAKER_00", "text": "검토할 발언", input_key: True},
                        {"start": 4, "end": 6, "speaker": "SPEAKER_00", "text": "다음 발언", snake: False},
                    ]
                    original = copy.deepcopy(segments)
                    display = build_display_segments(segments)
                    self.assertEqual(len(display), 1)
                    self.assertTrue(display[0].get(snake))
                    self.assertEqual(display[0]["text"], "첫 발언 검토할 발언 다음 발언")
                    self.assertEqual((display[0]["start"], display[0]["end"]), (0, 6))
                    self.assertEqual(display[0]["source_segment_count"], 3)
                    self.assertEqual(segments, original)

    def test_review_flags_do_not_leak_to_another_speaker(self) -> None:
        display = build_display_segments([
            {"start": 0, "end": 2, "speaker": "SPEAKER_00", "text": "검토 발언", "speaker_needs_review": True},
            {"start": 2, "end": 4, "speaker": "SPEAKER_01", "text": "명확한 다른 발언"},
        ])
        self.assertEqual(len(display), 2)
        self.assertTrue(display[0]["speaker_needs_review"])
        self.assertFalse(display[1].get("speaker_needs_review", False))

    def test_merges_same_speaker_incomplete_tail(self) -> None:
        segments = [
            {"start": 0.0, "end": 5.0, "speaker": "화자000", "speaker_name": "화자000", "text": "전 세계 어디에도 원하지 않는 그런 내용들을"},
            {"start": 5.0, "end": 8.0, "speaker": "화자000", "speaker_name": "화자000", "text": "특히 저희 해수부를 찍어서 얘기를 했거든요."},
        ]

        display = build_display_segments(segments)

        self.assertEqual(len(display), 1)
        self.assertEqual(display[0]["text"], "전 세계 어디에도 원하지 않는 그런 내용들을 특히 저희 해수부를 찍어서 얘기를 했거든요.")
        self.assertEqual(display[0]["speaker"], "화자000")
        self.assertTrue(display[0]["display_only"])

    def test_does_not_merge_across_speaker_change(self) -> None:
        segments = [
            {"start": 0.0, "end": 5.0, "speaker": "화자000", "text": "자료를 검토하고"},
            {"start": 5.0, "end": 8.0, "speaker": "화자001", "text": "다음 의견을 말하겠습니다."},
        ]

        display = build_display_segments(segments)

        self.assertEqual(len(display), 2)
        self.assertEqual([item["speaker"] for item in display], ["화자000", "화자001"])

    def test_does_not_merge_across_long_gap(self) -> None:
        segments = [
            {"start": 0.0, "end": 5.0, "speaker": "화자000", "text": "첫 번째 의견은"},
            {"start": 15.0, "end": 18.0, "speaker": "화자000", "text": "나중에 다시 말했습니다."},
        ]

        display = build_display_segments(segments)

        self.assertEqual(len(display), 2)

    def test_prefers_display_segments_for_exports(self) -> None:
        result = {
            "segments": [{"text": "원본"}],
            "display_segments": [{"text": "표시본"}],
        }

        self.assertEqual(get_transcript_segments(result)[0]["text"], "표시본")

    def test_falls_back_to_segments_when_display_segments_empty(self) -> None:
        result = {
            "segments": [{"text": "원본"}],
            "display_segments": [],
        }

        self.assertEqual(get_transcript_segments(result)[0]["text"], "원본")


if __name__ == "__main__":
    unittest.main()
