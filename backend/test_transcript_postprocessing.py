import unittest

try:
    from pipeline.align_speakers import align_segments_with_speakers, smooth_short_speaker_turns
    from pipeline.transcript_display import build_display_segments
except ModuleNotFoundError:
    from backend.pipeline.align_speakers import align_segments_with_speakers, smooth_short_speaker_turns
    from backend.pipeline.transcript_display import build_display_segments


class TranscriptPostprocessingTests(unittest.TestCase):
    def test_display_segments_merge_long_same_speaker_blocks(self) -> None:
        segments = [
            {"start": 0.0, "end": 30.0, "speaker": "참석자01", "text": "첫 번째 설명입니다."},
            {"start": 30.4, "end": 60.0, "speaker": "참석자01", "text": "두 번째 설명입니다."},
            {"start": 60.5, "end": 95.0, "speaker": "참석자01", "text": "세 번째 설명입니다."},
            {"start": 96.0, "end": 110.0, "speaker": "참석자02", "text": "다른 참석자 의견입니다."},
        ]

        display_segments = build_display_segments(segments)

        self.assertEqual(len(display_segments), 2)
        self.assertEqual(display_segments[0]["speaker"], "참석자01")
        self.assertIn("첫 번째", display_segments[0]["text"])
        self.assertIn("세 번째", display_segments[0]["text"])
        self.assertEqual(display_segments[0]["source_segment_count"], 3)

    def test_display_segments_merge_complete_same_speaker_until_soft_limit(self) -> None:
        segments = [
            {"start": 0.0, "end": 60.0, "speaker": "참석자01", "text": "첫 번째 긴 설명입니다."},
            {"start": 60.5, "end": 120.0, "speaker": "참석자01", "text": "두 번째 긴 설명입니다."},
            {"start": 120.5, "end": 170.0, "speaker": "참석자01", "text": "세 번째 긴 설명입니다."},
        ]

        display_segments = build_display_segments(segments)

        self.assertEqual(len(display_segments), 1)
        self.assertEqual(display_segments[0]["source_segment_count"], 3)
        self.assertLessEqual(display_segments[0]["end"] - display_segments[0]["start"], 180.0)

    def test_short_speaker_flicker_is_smoothed_between_same_speaker(self) -> None:
        speaker_segments = [
            {"start": 0.0, "end": 10.0, "speaker": "SPEAKER_00"},
            {"start": 10.1, "end": 10.7, "speaker": "SPEAKER_01"},
            {"start": 10.8, "end": 20.0, "speaker": "SPEAKER_00"},
        ]

        smoothed = smooth_short_speaker_turns(speaker_segments)

        self.assertEqual(len(smoothed), 1)
        self.assertEqual(smoothed[0]["speaker"], "SPEAKER_00")
        self.assertTrue(smoothed[0]["speaker_smoothed"])

    def test_overlapping_short_interjection_is_not_smoothed(self) -> None:
        speaker_segments = [
            {"start": 0.0, "end": 10.5, "speaker": "SPEAKER_00"},
            {"start": 10.0, "end": 10.8, "speaker": "SPEAKER_01"},
            {"start": 10.6, "end": 20.0, "speaker": "SPEAKER_00"},
        ]

        smoothed = smooth_short_speaker_turns(speaker_segments)

        self.assertEqual([segment["speaker"] for segment in smoothed], ["SPEAKER_00", "SPEAKER_01", "SPEAKER_00"])

    def test_alignment_splits_mixed_long_transcript_segment(self) -> None:
        transcript_segments = [
            {
                "start": 0.0,
                "end": 12.0,
                "text": "첫 번째 참석자가 길게 말했습니다. 두 번째 참석자가 이어서 답했습니다.",
            }
        ]
        speaker_segments = [
            {"start": 0.0, "end": 7.0, "speaker": "SPEAKER_00"},
            {"start": 7.0, "end": 12.0, "speaker": "SPEAKER_01"},
        ]

        aligned = align_segments_with_speakers(transcript_segments, speaker_segments)

        self.assertEqual(len(aligned), 2)
        self.assertEqual(aligned[0]["speaker_name"], "참석자01")
        self.assertEqual(aligned[1]["speaker_name"], "참석자02")
        self.assertTrue(all(segment["mixed_speaker_split"] for segment in aligned))

    def test_alignment_preserves_transcript_bounds_when_speaker_split_has_gaps(self) -> None:
        transcript_segments = [
            {
                "start": 0.0,
                "end": 12.0,
                "text": "첫 번째 참석자가 길게 말했습니다. 두 번째 참석자가 이어서 답했습니다.",
            }
        ]
        speaker_segments = [
            {"start": 1.0, "end": 5.0, "speaker": "SPEAKER_00"},
            {"start": 7.0, "end": 11.0, "speaker": "SPEAKER_01"},
        ]

        aligned = align_segments_with_speakers(transcript_segments, speaker_segments)

        self.assertEqual(len(aligned), 2)
        self.assertEqual(aligned[0]["start"], 0.0)
        self.assertEqual(aligned[-1]["end"], 12.0)
        self.assertEqual(aligned[0]["end"], aligned[1]["start"])
        self.assertTrue(all(segment["speaker_needs_review"] for segment in aligned))
        self.assertTrue(all(segment["speaker_split_coverage_gap"] for segment in aligned))

    def test_alignment_avoids_overlapping_ranges_when_speaker_split_overlaps(self) -> None:
        transcript_segments = [
            {
                "start": 0.0,
                "end": 12.0,
                "text": "첫 번째 참석자가 길게 말했습니다. 두 번째 참석자가 이어서 답했습니다.",
            }
        ]
        speaker_segments = [
            {"start": 0.0, "end": 7.0, "speaker": "SPEAKER_00"},
            {"start": 5.0, "end": 12.0, "speaker": "SPEAKER_01"},
        ]

        aligned = align_segments_with_speakers(transcript_segments, speaker_segments)

        self.assertEqual(len(aligned), 2)
        self.assertEqual(aligned[0]["start"], 0.0)
        self.assertEqual(aligned[-1]["end"], 12.0)
        self.assertEqual(aligned[0]["end"], aligned[1]["start"])
        self.assertTrue(all(segment["speaker_needs_review"] for segment in aligned))
        self.assertTrue(all(segment["speaker_split_coverage_overlap"] for segment in aligned))

    def test_alignment_marks_short_interjection_inside_long_segment_for_review(self) -> None:
        transcript_segments = [
            {
                "start": 0.0,
                "end": 10.0,
                "text": "첫 번째 참석자가 길게 설명하는 중에 짧은 맞장구가 들어왔습니다.",
            }
        ]
        speaker_segments = [
            {"start": 0.0, "end": 9.0, "speaker": "SPEAKER_00"},
            {"start": 4.0, "end": 4.6, "speaker": "SPEAKER_01"},
        ]

        aligned = align_segments_with_speakers(transcript_segments, speaker_segments)

        self.assertEqual(len(aligned), 1)
        self.assertEqual(aligned[0]["speaker_name"], "참석자01")
        self.assertTrue(aligned[0]["speaker_needs_review"])
        self.assertTrue(aligned[0]["short_speaker_overlap"])


if __name__ == "__main__":
    unittest.main()
