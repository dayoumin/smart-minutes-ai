import unittest

from backend.pipeline.qwen_segments import (
    build_display_segments_from_transcript,
    merge_aligner_segments_to_utterances,
    remove_repeated_sentences,
)


class QwenSegmentMergeTest(unittest.TestCase):
    def test_merges_word_segments_until_sentence_boundary(self) -> None:
        segments = [
            {"start": 0.0, "end": 0.2, "text": "five"},
            {"start": 0.2, "end": 0.4, "text": "party"},
            {"start": 0.4, "end": 0.8, "text": "candidates"},
            {"start": 0.8, "end": 1.1, "text": "debated."},
            {"start": 1.5, "end": 1.9, "text": "next"},
            {"start": 1.9, "end": 2.2, "text": "topic"},
            {"start": 2.2, "end": 2.8, "text": "starts."},
        ]

        merged = merge_aligner_segments_to_utterances(segments, min_chars=6)

        self.assertEqual(len(merged), 2)
        self.assertEqual(merged[0]["start"], 0.0)
        self.assertEqual(merged[0]["end"], 1.1)
        self.assertEqual(merged[0]["text"], "five party candidates debated.")
        self.assertFalse(merged[0]["timing_approximate"])
        self.assertTrue(merged[0]["split_on_speaker_change"])
        self.assertEqual(merged[1]["text"], "next topic starts.")

    def test_splits_on_gap_when_current_text_is_long_enough(self) -> None:
        segments = [
            {"start": 0.0, "end": 0.4, "text": "first"},
            {"start": 0.4, "end": 0.8, "text": "statement"},
            {"start": 2.0, "end": 2.4, "text": "second"},
            {"start": 2.4, "end": 2.8, "text": "statement"},
        ]

        merged = merge_aligner_segments_to_utterances(segments, gap_seconds=0.8, min_chars=5)

        self.assertEqual([item["text"] for item in merged], ["first statement", "second statement"])
        self.assertEqual(merged[0]["end"], 0.8)
        self.assertEqual(merged[1]["start"], 2.0)

    def test_splits_on_max_chars(self) -> None:
        segments = [
            {"start": 0.0, "end": 0.2, "text": "alpha"},
            {"start": 0.2, "end": 0.4, "text": "beta"},
            {"start": 0.4, "end": 0.6, "text": "gamma"},
            {"start": 0.6, "end": 0.8, "text": "delta"},
        ]

        merged = merge_aligner_segments_to_utterances(segments, max_chars=16, min_chars=1)

        self.assertEqual([item["text"] for item in merged], ["alpha beta gamma", "delta"])

    def test_restores_display_text_from_full_transcript(self) -> None:
        segments = [
            {"start": 0.0, "end": 1.0, "text": "candidate"},
            {"start": 1.0, "end": 2.0, "text": "s"},
            {"start": 2.0, "end": 3.0, "text": "debated"},
            {"start": 3.0, "end": 4.0, "text": "today"},
        ]

        merged = merge_aligner_segments_to_utterances(
            segments,
            transcript_text="Candidates debated today.",
            max_seconds=2.1,
            min_chars=1,
        )

        self.assertEqual(len(merged), 2)
        self.assertEqual([item["text_source"] for item in merged], ["transcript", "transcript"])
        self.assertEqual(" ".join(item["text"] for item in merged), "Candidates debated today.")

    def test_builds_sentence_display_segments_with_approximate_timing(self) -> None:
        timing_segments = [
            {"start": 10.0, "end": 12.0, "text": "alpha beta"},
            {"start": 12.0, "end": 16.0, "text": "gamma delta"},
        ]

        display = build_display_segments_from_transcript(
            "First sentence. Second sentence?",
            timing_segments,
        )

        self.assertEqual([item["text"] for item in display], ["First sentence.", "Second sentence?"])
        self.assertEqual(display[0]["start"], 10.0)
        self.assertEqual(display[-1]["end"], 16.0)
        self.assertTrue(all(item["timing_approximate"] for item in display))
        self.assertTrue(all(item["display_only"] for item in display))

    def test_removes_adjacent_repeated_sentence(self) -> None:
        cleaned = remove_repeated_sentences("차 있어요? 운전할 줄 알아요? 운전할 줄 알아요? 네.")

        self.assertEqual(cleaned, "차 있어요? 운전할 줄 알아요? 네.")

    def test_removes_trailing_loop_back_to_early_sentence(self) -> None:
        cleaned = remove_repeated_sentences("아 문 열어주는 거예요? 다른 이야기를 합니다. 아 문 열어주는 거예요?")

        self.assertEqual(cleaned, "아 문 열어주는 거예요? 다른 이야기를 합니다.")


if __name__ == "__main__":
    unittest.main()
