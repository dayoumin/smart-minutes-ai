import sys
import unittest
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

from pipeline.transcript_display import build_display_segments, get_transcript_segments  # noqa: E402


class TranscriptDisplayTest(unittest.TestCase):
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
