import copy
import json
import math
from pathlib import Path
import sys
import unittest

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))

from pipeline.chunk_audio import apply_time_offset
from pipeline.transcript_display import build_display_segments


class ChunkTimestampTest(unittest.TestCase):
    def test_long_video_model_overshoots_do_not_invade_next_chunk(self):
        for offset, start, end in ((450.0, 29.74, 59.72), (630.0, 29.97, 59.95)):
            with self.subTest(offset=offset):
                cached = [{"start": start, "end": end, "text": "발언 보존", "speaker_needs_review": True}]
                original = copy.deepcopy(cached)
                adjusted = apply_time_offset(cached, offset, duration_seconds=30)
                self.assertEqual(cached, original)
                self.assertEqual(adjusted[0]["start"], start+offset)
                self.assertEqual(adjusted[0]["end"], offset+30)
                self.assertEqual(adjusted[0]["text"], original[0]["text"])
                self.assertTrue(adjusted[0]["timing_approximate"])
                self.assertTrue(adjusted[0]["speaker_needs_review"])

    def test_outside_and_reversed_ranges_keep_text_without_inventing_duration(self):
        segments = [
            {"start": -3, "end": 2, "text": "앞"},
            {"start": 7, "end": 5, "text": "역전"},
            {"start": 31, "end": 45, "text": "끝"},
        ]
        adjusted = apply_time_offset(segments, 60, duration_seconds=30)
        self.assertEqual([(s["start"], s["end"]) for s in adjusted], [(60, 62), (67, 67), (90, 90)])
        self.assertEqual([s["text"] for s in adjusted], [s["text"] for s in segments])
        self.assertTrue(all(s["timing_approximate"] for s in adjusted))
        saved = json.loads(json.dumps({"segments": adjusted}))
        displayed = build_display_segments(saved["segments"])
        self.assertEqual(" ".join(s["text"] for s in displayed), "앞 역전 끝")
        self.assertTrue(all(s["timing_approximate"] for s in displayed))

    def test_valid_and_missing_end_timestamps_receive_one_offset(self):
        segments = [{"start": 2, "end": 4, "text": "정상"}, {"start": 5, "text": "종료 없음"}]
        for kwargs in ({}, {"duration_seconds": 30}):
            adjusted = apply_time_offset(segments, 60, **kwargs)
            self.assertEqual([(s["start"], s["end"]) for s in adjusted], [(62, 64), (65, 65)])
            self.assertFalse(any(s.get("timing_approximate") for s in adjusted))

    def test_last_short_chunk_uses_its_real_duration(self):
        adjusted = apply_time_offset([{"start": 0.3, "end": 30, "text": "마지막"}], 1800, duration_seconds=1.25)
        self.assertEqual(adjusted[0]["end"], 1801.25)

    def test_nonfinite_timestamps_and_invalid_duration_are_rejected(self):
        for value in (math.nan, math.inf, -math.inf, None, "invalid"):
            with self.subTest(value=value), self.assertRaises(ValueError):
                apply_time_offset([{"start": 0, "end": value}], 0, duration_seconds=30)
        for duration in (0, -1, math.nan, math.inf):
            with self.subTest(duration=duration), self.assertRaises(ValueError):
                apply_time_offset([], 0, duration_seconds=duration)


if __name__ == "__main__":
    unittest.main()
