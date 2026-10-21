import copy
import json
import sys
import unittest
import tempfile
import zipfile
import xml.etree.ElementTree as ET
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'backend'))
from pipeline.align_speakers import align_segments_with_speakers
from pipeline.chunk_audio import apply_time_offset
from pipeline.transcript_display import build_display_segments
from pipeline.transcript_review import normalize_issues, segment_review_issues


class TranscriptReviewTest(unittest.TestCase):
    def test_tiny_timing_correction_keeps_provenance_without_user_warning(self):
        tiny = apply_time_offset([{'start': 20, 'end': 30.001, 'text': '본문'}], 60, duration_seconds=30)[0]
        self.assertTrue(tiny['timing_approximate'])
        self.assertEqual(segment_review_issues(tiny), [])
        substantial = apply_time_offset([{'start': 20, 'end': 32, 'text': '본문'}], 60, duration_seconds=30)[0]
        self.assertEqual(segment_review_issues(substantial), [{'reason': 'timestamp_adjusted', 'start': 80, 'end': 90}])

    def test_small_other_speaker_boundary_does_not_warn_but_real_short_overlap_does(self):
        transcript = [{'start': 0, 'end': 10, 'text': '본문'}]
        for boundary, expected in [(9.99, []), (9.5, [{'reason': 'short_speaker_overlap', 'start': 9.5, 'end': 10}])]:
            aligned = align_segments_with_speakers(transcript, [{'start': 0, 'end': boundary, 'speaker': 'A'}, {'start': boundary, 'end': 11, 'speaker': 'B'}])
            self.assertEqual(segment_review_issues(aligned[0]), expected)
            self.assertEqual(aligned[0]['text'], transcript[0]['text'])

    def test_unassigned_speaker_is_always_reviewable(self):
        aligned = align_segments_with_speakers([{'start': 2, 'end': 4, 'text': '미배정'}], [])
        self.assertEqual(aligned[0]['speaker'], 'UNKNOWN')
        self.assertEqual(segment_review_issues(aligned[0]), [{'reason': 'speaker_unassigned', 'start': 2, 'end': 4}])

    def test_merging_keeps_original_review_range_and_reason(self):
        segments = [
            {'start': 0, 'end': 60, 'speaker': 'A', 'text': '정상'},
            {'start': 60, 'end': 63, 'speaker': 'A', 'text': '검토', 'review_version': 1, 'review_issues': [{'reason': 'short_speaker_overlap', 'start': 61.25, 'end': 61.75}]},
            {'start': 63, 'end': 150, 'speaker': 'A', 'text': '정상'},
        ]
        before = copy.deepcopy(segments)
        display = build_display_segments(segments)
        self.assertEqual(len(display), 1)
        self.assertEqual(display[0]['end'], 150)
        self.assertEqual(segment_review_issues(display[0]), [{'reason': 'short_speaker_overlap', 'start': 61.25, 'end': 61.75}])
        self.assertEqual(segments, before)
        self.assertEqual(segment_review_issues(json.loads(json.dumps(display[0]))), segment_review_issues(display[0]))

    def test_split_reason_does_not_claim_measured_low_confidence(self):
        aligned = align_segments_with_speakers([{'start': 0, 'end': 10, 'text': 'First sentence. Second sentence.'}], [{'start': 0, 'end': 5, 'speaker': 'A'}, {'start': 5, 'end': 10, 'speaker': 'B'}])
        self.assertEqual([segment_review_issues(s) for s in aligned], [[{'reason': 'speaker_split', 'start': 0, 'end': 5}], [{'reason': 'speaker_split', 'start': 5, 'end': 10}]])

    def test_invalid_issues_and_nan_are_rejected(self):
        self.assertEqual(normalize_issues([{}, {'reason': {}, 'start': 0, 'end': 1}, {'reason': 'speaker_split', 'start': float('nan'), 'end': 1}]), [])

    def test_split_children_do_not_claim_review_ranges_from_other_children(self):
        aligned = align_segments_with_speakers([{'start': 0, 'end': 30, 'text': 'First sentence. Second sentence. Third sentence.'}], [{'start': 0, 'end': 10, 'speaker': 'A'}, {'start': 10, 'end': 20, 'speaker': 'B'}, {'start': 20.5, 'end': 30, 'speaker': 'C'}])
        self.assertFalse(any(entry['reason'] == 'speaker_coverage_gap' for entry in segment_review_issues(aligned[0])))
        self.assertTrue(any(entry['reason'] == 'speaker_coverage_gap' for entry in segment_review_issues(aligned[1])))

    def test_explicit_empty_metadata_cannot_hide_unassigned_speaker(self):
        self.assertEqual(segment_review_issues({'speaker': 'UNKNOWN', 'start': 0, 'end': 10, 'review_version': 1, 'review_issues': []}), [{'reason': 'speaker_unassigned', 'start': 0, 'end': 10}])

    def test_download_formats_keep_the_same_precise_review_note(self):
        from pipeline.export_txt import export_txt
        from pipeline.export_markdown import export_markdown
        from pipeline.export_docx import export_docx
        from pipeline.export_hwpx import export_hwpx
        from docx import Document
        segment = {'start': 0, 'end': 60, 'speaker': 'A', 'text': '본문', 'review_version': 1,
                   'review_issues': [{'reason': 'short_speaker_overlap', 'start': 1.25, 'end': 1.8}]}
        result = {'source_file': 'review.wav', 'summary': {'title': '회의'}, 'segments': [segment], 'display_segments': [segment]}
        with tempfile.TemporaryDirectory() as temp:
            folder = Path(temp)
            export_txt([segment], str(folder/'review.txt'))
            export_markdown(result, str(folder/'review.md'))
            export_docx(result, str(folder/'review.docx'))
            export_hwpx(result, str(folder/'review.hwpx'))
            texts = [(folder/'review.txt').read_text(encoding='utf-8'), (folder/'review.md').read_text(encoding='utf-8'),
                     '\n'.join(p.text for p in Document(folder/'review.docx').paragraphs)]
            with zipfile.ZipFile(folder/'review.hwpx') as package:
                texts.append(''.join(ET.fromstring(package.read('Contents/section0.xml')).itertext()))
            for text in texts:
                self.assertIn('00:00:01.25–00:00:01.80', text)
                self.assertIn('짧은 다른 참석자 구간', text)


if __name__ == '__main__':
    unittest.main()
