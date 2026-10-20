import unittest
from unittest.mock import patch

import main
from pipeline import summarize


def _key_terms_glossary(*terms, inactive=()):
    entries = [{"id": f"key-term-{index}", "canonical": term, "use": "summary", "active": True} for index, term in enumerate(terms)]
    entries += [{"id": f"off-{index}", "canonical": term, "use": "summary", "active": False} for index, term in enumerate(inactive)]
    return {"id": summarize.MEETING_KEY_TERMS_GLOSSARY_ID, "name": "주요 용어", "category": "회의", "entries": entries}


class MeetingContextBlockTest(unittest.TestCase):
    def test_optional_writer_inputs_reach_the_prompt(self):
        base = {"title": "3분기 자원조사", "meeting_purpose": "결과 공유"}
        before = summarize._meeting_context_block(base)
        self.assertNotIn("참석자", before)
        self.assertNotIn("주요 용어", before)

        after = summarize._meeting_context_block({
            **base,
            "participants": "김수산,  이자원\n박해양",
            "term_glossaries": [_key_terms_glossary("연근해 자원조사", "수산과학원")],
        })
        self.assertIn("- 참석자(사용자 입력): 김수산, 이자원, 박해양\n", after)
        self.assertIn("발언자를 짐작해 이 이름을 붙이지 않습니다", after)
        self.assertIn("- 주요 용어(사용자 입력, 표기 참고용): 연근해 자원조사, 수산과학원\n", after)
        # The reserved glossary is said once as key terms, not again under the field glossaries header.
        self.assertNotIn("선택 분야별 용어", after)
        self.assertNotIn("- 주요 용어: 연근해 자원조사", after)
        self.assertIn("trust the transcript", after)

    def test_field_glossaries_still_listed_beside_key_terms(self):
        block = summarize._meeting_context_block({
            "term_glossaries": [
                _key_terms_glossary("수산과학원"),
                {"id": "fishery-resources", "name": "수산자원", "entries": [{"canonical": "체장", "active": True}]},
            ],
        })
        self.assertEqual(block.count("수산과학원"), 1)
        self.assertIn("- 선택 분야별 용어:", block)
        self.assertIn("- 수산자원: 체장\n", block)

    def test_key_terms_are_deduplicated_trimmed_and_capped(self):
        long_term = "가" * 60
        many = [f"용어{index}" for index in range(40)]
        terms = summarize._meeting_key_terms([
            _key_terms_glossary(" 연근해 ", "연근해", long_term, inactive=("숨김",)),
            _key_terms_glossary(*many),
        ])
        self.assertEqual(terms[0], "연근해")
        self.assertEqual(terms.count("연근해"), 1)
        self.assertEqual(terms[1], "가" * summarize.MAX_CONTEXT_KEY_TERM_CHARS)
        self.assertNotIn("숨김", terms)
        self.assertEqual(len(terms), summarize.MAX_CONTEXT_KEY_TERMS)

    def test_blank_inputs_add_nothing(self):
        self.assertEqual(summarize._meeting_context_block({"participants": "  \n ", "term_glossaries": [_key_terms_glossary("  ")]}), "")

    def test_participant_summary_prompt_does_not_map_typed_names_to_speakers(self):
        prompts = []

        def capture(_model, prompt):
            prompts.append(prompt)
            return {"speaker_context_summaries": []}

        segments = [{"start": 0, "end": 2, "speaker": "SPEAKER_00", "text": "조사 결과를 공유합니다."}]
        with patch.object(summarize, "_generate_json_once", side_effect=capture):
            summarize.generate_speaker_context_summaries(
                segments,
                {"overview": "조사 결과 공유"},
                meeting_context={"participants": "김수산, 이자원"},
            )
        self.assertTrue(prompts)
        self.assertIn("- 참석자(사용자 입력): 김수산, 이자원", prompts[0])
        self.assertIn("never use them to rename a speaker label or fill display_name", prompts[0])

    def test_regeneration_context_keeps_participants(self):
        context = main._meeting_context_from_result_data({
            "participants": "김수산, 이자원",
            "meeting_purpose": "결과 공유",
            "term_glossaries": [_key_terms_glossary("수산과학원")],
            "summary": {"title": "3분기 자원조사"},
        })
        self.assertEqual(context["participants"], "김수산, 이자원")
        self.assertEqual(summarize._meeting_key_terms(context["term_glossaries"]), ["수산과학원"])
        self.assertEqual(main._meeting_context_from_result_data({"summary": {}})["participants"], "")


if __name__ == "__main__":
    unittest.main()
