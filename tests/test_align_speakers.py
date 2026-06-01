import unittest

from backend.pipeline.align_speakers import align_segments_with_speakers


class AlignSpeakersTest(unittest.TestCase):
    def test_splits_segment_when_explicitly_marked_for_speaker_change(self) -> None:
        transcript_segments = [
            {
                "start": 0.0,
                "end": 10.0,
                "text": "First speaker talks. Second speaker replies.",
                "split_on_speaker_change": True,
            }
        ]
        speaker_segments = [
            {"start": 0.0, "end": 5.0, "speaker": "SPEAKER_00"},
            {"start": 5.0, "end": 10.0, "speaker": "SPEAKER_01"},
        ]

        aligned = align_segments_with_speakers(transcript_segments, speaker_segments)

        self.assertEqual(len(aligned), 2)
        self.assertEqual(aligned[0]["speaker"], "SPEAKER_00")
        self.assertEqual(aligned[1]["speaker"], "SPEAKER_01")
        self.assertEqual(aligned[0]["speaker_name"], "참석자01")
        self.assertEqual(aligned[1]["speaker_name"], "참석자02")
        self.assertEqual(aligned[0]["text"], "First speaker talks.")
        self.assertEqual(aligned[1]["text"], "Second speaker replies.")
        self.assertEqual(aligned[0]["end"], 5.0)
        self.assertEqual(aligned[1]["start"], 5.0)


if __name__ == "__main__":
    unittest.main()
