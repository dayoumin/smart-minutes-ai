import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient

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
        # Only the transcript can verify a name; the summary may have copied the typed list.
        self.assertIn("unless the transcript itself states that speaker's name", prompts[0])
        self.assertIn("A name that appears only in the basic summary, topic sections or meeting context is not verified.", prompts[0])
        self.assertNotIn("present in the transcript or summary", prompts[0])
        self.assertNotIn("verified participant name", prompts[0])
        # The retry prompt carries the same rules.
        self.assertEqual(len(prompts), 2)
        self.assertIn(summarize.SPEAKER_NAME_RULES, prompts[1])

    def test_action_owner_rule_only_when_participants_are_typed(self):
        rule = "- 할 일 담당자도 이 목록에서 고르지 않습니다. 대화록에 나온 이름이나 화자 라벨만 쓰고, 확인되지 않으면 `담당자 미정`으로 씁니다.\n"
        self.assertIn(rule, summarize._meeting_context_block({"participants": "김수산"}))
        self.assertNotIn("담당자", summarize._meeting_context_block({"meeting_purpose": "결과 공유"}))
        prompt = summarize._build_prompt("참석자01: 결과를 공유합니다.", meeting_context={"participants": "김수산"})
        self.assertEqual(prompt.count(rule), 1)

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


# "이 자원조사" must not count as saying 이자원: names are matched with their spacing.
SEGMENTS = [
    {"start": 0, "end": 2, "speaker": "SPEAKER_00", "speaker_name": "참석자01", "text": "이 자원조사 결과를 공유합니다."},
    {"start": 2, "end": 4, "speaker": "SPEAKER_01", "speaker_name": "참석자02", "text": "다음 주까지 보고서를 정리하겠습니다."},
]


def _speaker_item(speaker, display_name, **fields):
    return {
        "speaker": speaker,
        "display_name": display_name,
        "role_in_meeting": fields.get("role_in_meeting", ""),
        "summary": fields.get("summary", ""),
        "key_points": fields.get("key_points", []),
        "actions": fields.get("actions", []),
        "needs_check": fields.get("needs_check", []),
    }


def _typed_name_response():
    return {"speaker_context_summaries": [
        _speaker_item(
            "참석자01", "김수산",
            role_in_meeting="김수산 발표",
            summary="김수산은 자원조사 결과를 공유했다.",
            key_points=["김수산: 결과 공유"],
            actions=["김수산: 결과표 배포", "이자원: 일정 확인"],
        ),
        _speaker_item("참석자02", "참석자02", summary="보고서 정리를 맡았다.", actions=["참석자02: 보고서 정리"]),
    ]}


def _speaker_summaries(response, segments=SEGMENTS, participants="김수산, 이자원"):
    with patch.object(summarize, "_generate_json_once", return_value=response):
        return summarize.generate_speaker_context_summaries(
            segments, {"overview": "참석자: 김수산, 이자원"}, meeting_context={"participants": participants},
        )


class TypedParticipantNameGuardTest(unittest.TestCase):
    def test_typed_name_not_in_transcript_goes_back_to_speaker_label(self):
        raw = summarize._speaker_context_summaries_from_response(_typed_name_response())
        self.assertEqual(raw[0]["display_name"], "김수산")

        guarded = _speaker_summaries(_typed_name_response())

        self.assertEqual(guarded[0], _speaker_item(
            "참석자01", "참석자01",
            role_in_meeting="참석자01 발표",
            summary="참석자01은 자원조사 결과를 공유했다.",
            key_points=["참석자01: 결과 공유"],
            actions=["참석자01: 결과표 배포", "담당자 미정: 일정 확인"],
        ))
        self.assertEqual(guarded[1], raw[1])
        self.assertNotIn("김수산", str(guarded))
        self.assertNotIn("이자원", str(guarded))
        self.assertEqual(
            [item["participant"] for item in main._participant_summaries_from_speaker_context(guarded)],
            ["참석자01", "참석자02"],
        )

    def test_reverted_name_is_replaced_in_every_item_but_kept_in_needs_check(self):
        guarded = _speaker_summaries({"speaker_context_summaries": [
            _speaker_item(
                "참석자01", "김수산 팀장",
                summary="김수산은 결과를 공유했다.",
                needs_check=["참석자01이 김수산인지 확인 필요"],
            ),
            _speaker_item("참석자02", "참석자02", summary="김수산 팀장의 제안에 동의했다.", key_points=["김수산 의견 지지"]),
        ]})
        self.assertEqual(guarded, [
            _speaker_item("참석자01", "참석자01", summary="참석자01은 결과를 공유했다.", needs_check=["참석자01이 김수산인지 확인 필요"]),
            _speaker_item("참석자02", "참석자02", summary="참석자01의 제안에 동의했다.", key_points=["참석자01 의견 지지"]),
        ])

    def test_name_claimed_for_two_speakers_is_not_replaced_in_text(self):
        guarded = _speaker_summaries({"speaker_context_summaries": [
            _speaker_item("참석자01", "김수산", summary="김수산이 발표했다."),
            _speaker_item("참석자02", "김수산", summary="김수산에게 질문했다."),
        ]})
        self.assertEqual(guarded, [
            _speaker_item("참석자01", "참석자01", summary="김수산이 발표했다."),
            _speaker_item("참석자02", "참석자02", summary="김수산에게 질문했다."),
        ])

    def test_speaker_id_without_shown_label_falls_back_to_the_id(self):
        segments = [{"start": 0, "end": 2, "speaker": "SPEAKER_00", "text": "결과를 공유합니다."}]
        guarded = _speaker_summaries({"speaker_context_summaries": [_speaker_item("SPEAKER_00", "김수산")]}, segments)
        self.assertEqual(guarded, [_speaker_item("SPEAKER_00", "SPEAKER_00")])

    def test_name_said_in_transcript_is_kept(self):
        segments = [*SEGMENTS, {"start": 4, "end": 6, "speaker": "SPEAKER_01", "speaker_name": "참석자02", "text": "김수산 팀장님이 결과표를 돌려 주세요."}]
        guarded = _speaker_summaries(_typed_name_response(), segments)
        self.assertEqual(guarded[0]["display_name"], "김수산")
        self.assertEqual(guarded[0]["summary"], "김수산은 자원조사 결과를 공유했다.")
        # 이자원 is still never said, so only that owner changes.
        self.assertEqual(guarded[0]["actions"], ["김수산: 결과표 배포", "담당자 미정: 일정 확인"])

    def test_user_label_that_matches_a_typed_name_is_kept(self):
        segments = [{**segment, "speaker_name": "김수산" if segment["speaker"] == "SPEAKER_00" else segment["speaker_name"]} for segment in SEGMENTS]
        guarded = _speaker_summaries({"speaker_context_summaries": [_speaker_item("김수산", "김수산", actions=["김수산: 결과표 배포"])]}, segments)
        self.assertEqual(guarded, [_speaker_item("김수산", "김수산", actions=["김수산: 결과표 배포"])])

    def test_no_typed_participants_keeps_model_output(self):
        raw = summarize._speaker_context_summaries_from_response(_typed_name_response())
        for participants in ("", "  \n "):
            self.assertEqual(_speaker_summaries(_typed_name_response(), participants=participants), raw)
        with patch.object(summarize, "_generate_json_once", return_value=_typed_name_response()):
            self.assertEqual(summarize.generate_speaker_context_summaries(SEGMENTS, {}, meeting_context=None), raw)

    def test_typed_name_used_as_speaker_is_relabelled(self):
        swapped = _speaker_summaries({"speaker_context_summaries": [_speaker_item("김수산", "참석자01", summary="김수산이 발표했다.")]})
        self.assertEqual(swapped, [_speaker_item("참석자01", "참석자01", summary="참석자01이 발표했다.")])

        guessed = _speaker_summaries({"speaker_context_summaries": [
            _speaker_item("참석자01", "참석자01"),
            _speaker_item("이자원", "이자원"),
            _speaker_item("김수산", "김수산"),
        ]})
        self.assertEqual(guessed[0], _speaker_item("참석자01", "참석자01"))
        # Same position as the excerpts when that label is free, otherwise a plain label; both are flagged.
        self.assertEqual(guessed[1], _speaker_item("참석자02", "참석자02", needs_check=[summarize.UNKNOWN_SPEAKER_NOTE]))
        self.assertEqual(guessed[2], _speaker_item("참석자", "참석자", needs_check=[summarize.UNKNOWN_SPEAKER_NOTE]))

        # The only label left is used even off position; a label another item holds is not reused.
        only_left = _speaker_summaries({"speaker_context_summaries": [
            _speaker_item("참석자02", "참석자02"),
            _speaker_item("김수산", "김수산"),
        ]})
        self.assertEqual(only_left[1], _speaker_item("참석자01", "참석자01", needs_check=[summarize.UNKNOWN_SPEAKER_NOTE]))
        taken = _speaker_summaries({"speaker_context_summaries": [
            _speaker_item("참석자01", "참석자01"),
            _speaker_item("김수산", "참석자01"),
        ]})
        self.assertEqual(taken[1], _speaker_item("참석자02", "참석자02", needs_check=[summarize.UNKNOWN_SPEAKER_NOTE]))

    def test_summary_action_owners(self):
        original = [
            "김수산: 결과표 배포",
            "김수산 팀장: 결과 보고",
            "김수산·이자원: 현장 일정 공유",
            "김수산, 참석자02: 회의록 검토",
            "김수산 및 참석자02: 일정 공유",
            "참석자02: 보고서 정리",
            "일정: 다음 주 확정",
            # A long summary joins qualifiers with " · "; the text before 조건 is the task, not an owner.
            "김수산 보고서 작성 · 조건: 승인 후",
            "결과 공유",
        ]
        response = json.dumps({
            "title": "자원조사 결과 공유",
            "overview": "조사 결과를 공유했다.",
            "topics": [],
            "decisions": [],
            "actions": original,
            "needs_check": [],
        }, ensure_ascii=False)

        def actions_for(participants, segments=SEGMENTS):
            with patch.object(summarize, "generate_ollama_text", return_value=response):
                return summarize.summarize_meeting(segments, "gemma3:4b", meeting_context={"participants": participants})["actions"]

        self.assertEqual(actions_for(""), original)
        self.assertEqual(actions_for("김수산, 이자원"), [
            "담당자 미정: 결과표 배포",
            "담당자 미정: 결과 보고",
            "담당자 미정: 현장 일정 공유",
            "참석자02: 회의록 검토",
            "참석자02: 일정 공유",
            "참석자02: 보고서 정리",
            "일정: 다음 주 확정",
            "김수산 보고서 작성 · 조건: 승인 후",
            "결과 공유",
        ])
        said = [*SEGMENTS, {"start": 4, "end": 6, "speaker": "SPEAKER_01", "speaker_name": "참석자02", "text": "김수산 님이 배포해 주세요."}]
        # 김수산 is said, so only the never-said 이자원 leaves its owner list.
        self.assertEqual(actions_for("김수산, 이자원", said), [
            *original[:2], "김수산: 현장 일정 공유", *original[3:],
        ])


class SpeakerContextEndpointTest(unittest.TestCase):
    def test_result_json_and_saved_report_use_the_speaker_label(self):
        job_id = "unit_typed_participant_guard"
        with tempfile.TemporaryDirectory() as output_dir:
            result_path = Path(output_dir) / f"{job_id}_result.json"
            result_path.write_text(json.dumps({
                "job_id": job_id,
                "participants": "김수산, 이자원",
                "segments": SEGMENTS,
                "summary": {
                    "title": "자원조사",
                    "overview": "참석자: 김수산, 이자원. 조사 결과를 공유했다.",
                    "topic_sections": [{"topic": "자원조사 결과", "summary": "결과를 공유했다.", "evidence": [], "actions": []}],
                    "generation_status": {"summary": "completed", "topic_sections": "completed", "speaker_context_summaries": "not_started"},
                },
            }, ensure_ascii=False), encoding="utf-8")

            with (
                patch.object(main, "_get_output_dir", return_value=output_dir),
                patch.object(main, "_resolve_summary_model", return_value="gemma3:4b"),
                patch("pipeline.summarize._generate_json_once", return_value=_typed_name_response()),
            ):
                response = TestClient(main.app).post(f"/api/outputs/{job_id}/generate-speaker-context")

            self.assertEqual(response.status_code, 200, response.text)
            payload = response.json()
            self.assertIsNone(payload["export_error"])
            self.assertEqual([item["participant"] for item in payload["participant_summaries"]], ["참석자01", "참석자02"])
            saved = json.loads(result_path.read_text(encoding="utf-8"))["summary"]
            self.assertEqual([item["display_name"] for item in saved["speaker_context_summaries"]], ["참석자01", "참석자02"])
            self.assertEqual([item["participant"] for item in saved["participant_summaries"]], ["참석자01", "참석자02"])
            self.assertEqual(saved["participant_summaries"][0]["actions"], ["참석자01: 결과표 배포", "담당자 미정: 일정 확인"])
            report = (Path(output_dir) / f"{job_id}_report.md").read_text(encoding="utf-8")
            self.assertIn("참석자01\n\n참석자01은 자원조사 결과를 공유했다.", report)
            self.assertIn("- 할 일: 담당자 미정: 일정 확인", report)
            self.assertNotIn("김수산은", report)
            self.assertNotIn("이자원:", report)


if __name__ == "__main__":
    unittest.main()
