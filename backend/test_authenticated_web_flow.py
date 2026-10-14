"""Actual API/auth/file integration, with only inference replaced (no browser/network)."""

import copy
import json
import os
import sys
import tempfile
import unittest
import wave
import zipfile
from contextlib import ExitStack
from io import BytesIO
from pathlib import Path
from urllib.parse import unquote
from xml.etree import ElementTree

from fastapi.testclient import TestClient
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(__file__))

import main
from analysis_jobs import AnalysisJobRegistry
from job_checkpoints import build_job_checkpoint_paths
from local_engine_security import LocalEnginePairingCoordinator
from backend.test_local_engine_security import build_isolated_main_app

ORIGIN = "https://auth-flow.example"
JOB_ID = "generate-auth-flow"
ORIGINAL_TEXT = "격리된 회의의 원래 발언입니다."
EDITED_TEXT = "인증된 저장 요청으로 수정한 발언입니다."


def audio_fixture() -> bytes:
    output = BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(16000)
        audio.writeframes(b"\x00\x00" * 320)
    return output.getvalue()


class AuthenticatedWebFlowTest(unittest.TestCase):
    def setUp(self) -> None:
        self.resources = ExitStack()
        self.addCleanup(self.resources.close)
        self.root = Path(self.resources.enter_context(tempfile.TemporaryDirectory(prefix="lmo-auth-flow-")))
        for directory in ("temp", "outputs", "downloads"):
            (self.root / directory).mkdir()
        self.config = {
            "paths": {"temp_dir": str(self.root / "temp"), "output_dir": str(self.root / "outputs")},
            "stt": {"selected_model": "faster-whisper-large-v3"},
            "diarization": {"enabled": False},
            "privacy": {"save_original_audio_copy": False},
        }
        self.audio = audio_fixture()
        self.processing_hook = lambda: None
        self.resources.enter_context(patch.dict(os.environ, {
            "LMO_RUNTIME_PROFILE": "production",
            "LMO_WEB_ALLOWED_ORIGINS": ORIGIN,
            "LMO_API_AUTH_ENFORCEMENT": "enabled",
            "MEETING_AI_SAVE_COPY_ALLOWED_ORIGINS": "",
        }))
        self.resources.enter_context(patch.object(main, "load_config", side_effect=lambda: copy.deepcopy(self.config)))
        self.resources.enter_context(patch.object(main, "ANALYSIS_JOBS", AnalysisJobRegistry()))
        self.resources.enter_context(patch.object(main, "JOB_STATE_LOCKS", {}))
        self.resources.enter_context(patch.object(main, "ACTIVE_GENERATIONS", set()))
        self.resources.enter_context(patch.object(main, "model_exists", return_value=True))
        self.resources.enter_context(patch.object(main, "resolve_model_path", return_value="mock-inference-model"))
        # Even a save-copy regression cannot write into the user's Downloads folder.
        self.download_target = self.resources.enter_context(patch.object(
            main, "_unique_download_path", side_effect=lambda name: self.root / "downloads" / name,
        ))
        self.pipeline = self.resources.enter_context(patch.object(
            main, "process_audio_pipeline", side_effect=self._inference,
        ))
        app, self.sessions = build_isolated_main_app()
        self.presented_codes: dict[str, str] = {}
        pairing = LocalEnginePairingCoordinator(
            session_store=self.sessions,
            code_presenter=lambda pairing_id, code, _expires: not self.presented_codes.update({pairing_id: code}),
        )
        self.resources.enter_context(patch.object(main, "LOCAL_ENGINE_SESSION_STORE", self.sessions))
        self.resources.enter_context(patch.object(main, "LOCAL_ENGINE_PAIRING", pairing))
        self.client = self.resources.enter_context(TestClient(app))

    def _headers(self, token: str, origin: str = ORIGIN) -> dict:
        return {"Origin": origin, "Authorization": f"Bearer {token}"}

    def _pair(self) -> str:
        started = self.client.post("/api/pair/start", headers={"Origin": ORIGIN})
        self.assertEqual(started.status_code, 200)
        self.assertNotIn("code", started.json())
        pairing_id = started.json()["pairing_id"]
        completed = self.client.post("/api/pair/complete", headers={"Origin": ORIGIN}, json={
            "pairing_id": pairing_id, "code": self.presented_codes.pop(pairing_id),
        })
        self.assertEqual(completed.status_code, 200)
        return completed.json()["session_token"]

    def _record(self, job_id: str = JOB_ID, text: str = EDITED_TEXT) -> dict:
        segments = [{"start": "00:00:00", "end": "00:00:01", "speaker": "화자000", "text": text}]
        return {
            "id": "frontend-record", "jobId": job_id, "title": "수정한 인증 회의",
            "date": "2026-10-15 09:30", "participants": "참석자01", "summary": "저장한 회의 요약",
            "segments": segments, "displaySegments": segments, "speakerLabels": {},
        }

    def _seed(self, job_id: str = JOB_ID, config: dict | None = None) -> dict:
        context = (config or {}).get("_meeting_context", {})
        result = {
            "created_at": context.get("date", "2026-10-15 09:00"),
            "participants": "참석자01",
            "summary": {"title": context.get("title", "인증 통합 회의"), "overview": "초기 요약", "topics": [], "actions": []},
            "segments": [{"start": 0.0, "end": 1.0, "speaker": "화자000", "text": ORIGINAL_TEXT}],
            "settings": {"diarization": False},
        }
        main._save_job_result(job_id, result)
        checkpoint = build_job_checkpoint_paths(str(self.root / "temp"), job_id)
        audio_path = Path(checkpoint.source_wav_path)
        audio_path.parent.mkdir(parents=True, exist_ok=True)
        audio_path.write_bytes(self.audio)
        return result

    def _inference(self, upload_path, job_id, config, progress_callback, cancel_event=None):
        self.assertEqual(Path(upload_path).read_bytes(), self.audio)
        self.processing_hook()
        progress_callback("격리된 분석 진행", 65, {"transcript_ready": True})
        result = self._seed(job_id, config)
        # Keep the real serializers/exporters; only the AI inference itself is fake.
        outputs = main._refresh_transcript_and_summary_exports(job_id, result)
        return {"job_id": job_id, "result_data": result, "audio_file": outputs.get("audio")}

    def _analyze(self, headers: dict, job_id: str = JOB_ID):
        return self.client.post("/api/analyze", headers=headers, data={
            "title": "인증 통합 회의", "date": "2026-10-15T09:00", "participants": "참석자01",
            "mode": "real", "job_id": job_id,
        }, files={"file": ("회의.wav", self.audio, "audio/wav")})

    def _snapshot(self) -> dict:
        return {str(path.relative_to(self.root)): path.read_bytes() if path.is_file() else None
                for path in self.root.rglob("*")}

    def _assert_no_side_effect(self, before: dict) -> None:
        self.assertEqual(self._snapshot(), before)
        self.assertEqual(self.pipeline.call_count, 0)
        self.assertFalse(main.ANALYSIS_JOBS.has("denied-upload"))
        self.download_target.assert_not_called()

    def test_pair_analyze_sync_download_and_delete_with_enforced_auth(self) -> None:
        probe = self.client.get("/api/probe")
        self.assertEqual(probe.status_code, 200)
        self.assertTrue(probe.json()["pairing_available"])
        token = self._pair()
        headers = self._headers(token)
        preflight = self.client.post("/api/analyze/preflight", headers=headers, json={
            "file_size": len(self.audio), "duration_seconds": 0.02,
        })
        self.assertEqual(preflight.status_code, 200)
        analyzed = self._analyze(headers)
        self.assertEqual(analyzed.status_code, 200)
        self.assertIn("text/event-stream", analyzed.headers["content-type"])
        self.assertEqual(analyzed.text.count("event: result"), 1)
        self.assertIn("event: progress", analyzed.text)
        self.assertIn("data: [DONE]", analyzed.text)
        self.assertNotIn("event: error", analyzed.text)
        self.assertIn(ORIGINAL_TEXT, analyzed.text)
        self.assertEqual(self.pipeline.call_count, 1)
        self.assertFalse(main.ANALYSIS_JOBS.has(JOB_ID))
        events = [json.loads(line.removeprefix("data: ")) for line in analyzed.text.splitlines()
                  if line.startswith("data: ") and line != "data: [DONE]"]
        result = next(event for event in events if event.get("type") == "result")
        self.assertEqual(result["meeting"]["job_id"], JOB_ID)
        self.assertEqual(result["outputs"]["job_id"], JOB_ID)
        self.assertEqual(result["segments"][0]["text"], ORIGINAL_TEXT)
        json_url = result["outputs"]["json"]
        audio_url = result["outputs"]["audio"]
        self.assertEqual(json_url, f"/api/outputs/{JOB_ID}/json")
        self.assertEqual(audio_url, f"/api/outputs/{JOB_ID}/audio")

        renewed = self.client.post("/api/session/renew", headers=headers)
        self.assertEqual(renewed.status_code, 200)
        self.assertEqual(renewed.json()["session_token"], token)
        synced = self.client.post(f"/api/outputs/{JOB_ID}/sync-record", headers=headers, json=self._record())
        self.assertEqual(synced.status_code, 200)
        self.assertIsNone(synced.json()["export_error"])
        saved = self.client.get(json_url, headers=headers)
        self.assertEqual(saved.status_code, 200)
        self.assertEqual(saved.json()["summary"]["title"], self._record()["title"])
        self.assertEqual(saved.json()["display_segments"][0]["text"], EDITED_TEXT)
        self.assertNotIn(token, saved.text)
        stored_txt = self.client.get(synced.json()["outputs"]["txt"], headers=headers)
        self.assertEqual(stored_txt.status_code, 200)
        self.assertIn(EDITED_TEXT, stored_txt.text)
        self.assertNotIn(ORIGINAL_TEXT, stored_txt.text)
        exported = self.client.post("/api/export-record/txt", headers=headers, json=self._record())
        self.assertEqual(exported.status_code, 200)
        self.assertIn(EDITED_TEXT, exported.text)
        self.assertIn("attachment", exported.headers["content-disposition"])
        self.assertIn("content-disposition", exported.headers["access-control-expose-headers"].lower())
        head = self.client.head(audio_url, headers=headers)
        self.assertEqual(head.status_code, 200)
        self.assertEqual(head.content, b"")
        self.assertEqual(int(head.headers["content-length"]), len(self.audio))
        ranged = self.client.get(audio_url, headers={**headers, "Range": "bytes=2-7"})
        self.assertEqual(ranged.status_code, 206)
        self.assertEqual(ranged.content, self.audio[2:8])
        self.assertEqual(ranged.headers["content-range"], f"bytes 2-7/{len(self.audio)}")
        unrelated = self.root / "outputs" / "unrelated_result.json"
        unrelated.write_bytes(b"preserve this unrelated fixture")
        deleted = self.client.delete(f"/api/outputs/{JOB_ID}", headers=headers)
        self.assertEqual(deleted.status_code, 200)
        self.assertTrue(deleted.json()["deleted"])
        self.assertEqual(unrelated.read_bytes(), b"preserve this unrelated fixture")
        for kind in ("json", "audio"):
            self.assertEqual(self.client.get(f"/api/outputs/{JOB_ID}/{kind}", headers=headers).status_code, 404)

    def test_invalid_sessions_reject_before_upload_or_mutation(self) -> None:
        self._seed()
        token = self._pair()
        expired, _ = self.sessions.issue(origin=ORIGIN, capabilities=["analysis", "export", "meeting-storage"], now=0)
        revoked, _ = self.sessions.issue(origin=ORIGIN, capabilities=["analysis", "export", "meeting-storage"])
        self.sessions.revoke(revoked)
        cases = {
            "missing": {"Origin": ORIGIN}, "tampered": self._headers("tampered"),
            "expired": self._headers(expired), "revoked": self._headers(revoked),
            "other-origin": self._headers(token, "https://other.example"),
            "missing-origin": {"Authorization": f"Bearer {token}"},
        }
        preflight = self.client.options("/api/analyze", headers={
            "Origin": ORIGIN, "Access-Control-Request-Method": "POST",
            "Access-Control-Request-Headers": "authorization, content-type",
        })
        self.assertEqual(preflight.status_code, 200, "CORS permission is not authentication")
        before = self._snapshot()
        for name, headers in cases.items():
            with self.subTest(session=name):
                responses = [
                    self._analyze(headers, "denied-upload"),
                    self.client.post(f"/api/outputs/{JOB_ID}/sync-record", headers=headers, json=self._record()),
                    self.client.post("/api/export-record/txt", headers=headers, json=self._record()),
                    self.client.delete(f"/api/outputs/{JOB_ID}", headers=headers),
                    self.client.get(f"/api/outputs/{JOB_ID}/json", headers=headers),
                    self.client.get(f"/api/outputs/{JOB_ID}/audio", headers={**headers, "Range": "bytes=0-3"}),
                ]
                for response in responses:
                    self.assertEqual(response.status_code, 401)
                    self.assertEqual(response.headers.get("www-authenticate"), "Bearer")
                    self.assertNotIn("text/event-stream", response.headers["content-type"])
                    self.assertNotIn(token, response.text)
                self._assert_no_side_effect(before)

    def test_capability_denials_and_minimal_capability_success(self) -> None:
        self._seed()
        tokens = {capability: self.sessions.issue(origin=ORIGIN, capabilities=[capability])[0]
                  for capability in ("analysis", "export", "meeting-storage", "model-management")}
        before = self._snapshot()
        denied = [
            self.client.get(f"/api/outputs/{JOB_ID}/json", headers=self._headers(tokens["analysis"])),
            self.client.get(f"/api/outputs/{JOB_ID}/audio", headers=self._headers(tokens["analysis"])),
            self.client.post(f"/api/outputs/{JOB_ID}/sync-record", headers=self._headers(tokens["export"]), json=self._record()),
            self.client.delete(f"/api/outputs/{JOB_ID}", headers=self._headers(tokens["export"])),
            self.client.post("/api/export-record/txt", headers=self._headers(tokens["meeting-storage"]), json=self._record()),
            self._analyze(self._headers(tokens["export"]), "denied-upload"),
            self.client.get("/api/settings", headers=self._headers(tokens["analysis"])),
        ]
        for response in denied:
            self.assertEqual(response.status_code, 403)
            self.assertEqual(response.headers["access-control-allow-origin"], ORIGIN)
        self._assert_no_side_effect(before)
        self.assertEqual(self.client.get(f"/api/outputs/{JOB_ID}/json", headers=self._headers(tokens["export"])).status_code, 200)
        self.assertEqual(self.client.post(f"/api/outputs/{JOB_ID}/sync-record", headers=self._headers(tokens["meeting-storage"]), json=self._record()).status_code, 200)
        self.assertEqual(self.client.get("/api/settings", headers=self._headers(tokens["model-management"])).status_code, 200)
        self.assertEqual(self._analyze(self._headers(tokens["analysis"])).status_code, 200)
        self.assertEqual(self.pipeline.call_count, 1)

    def test_revoke_blocks_new_work_until_repairing_without_replaying_analysis(self) -> None:
        token = self._pair()
        headers = self._headers(token)
        self.assertEqual(self._analyze(headers).status_code, 200)
        self.assertEqual(self.pipeline.call_count, 1)
        before = self._snapshot()
        self.assertEqual(self.client.post("/api/session/revoke", headers=headers).status_code, 200)
        for response in (
            self.client.post("/api/session/renew", headers=headers),
            self._analyze(headers, "denied-upload"),
            self.client.post(f"/api/outputs/{JOB_ID}/sync-record", headers=headers, json=self._record()),
            self.client.get(f"/api/outputs/{JOB_ID}/json", headers=headers),
        ):
            self.assertEqual(response.status_code, 401)
        self.assertEqual(self._snapshot(), before)
        self.assertEqual(self.pipeline.call_count, 1)
        replacement = self._pair()
        self.assertNotEqual(replacement, token)
        self.assertEqual(self.client.get(f"/api/outputs/{JOB_ID}/json", headers=self._headers(replacement)).status_code, 200)
        self.assertEqual(self.pipeline.call_count, 1)

    def test_revocation_after_admission_does_not_replay_a_started_stream(self) -> None:
        token = self._pair()
        self.processing_hook = lambda: self.sessions.revoke(token)
        response = self._analyze(self._headers(token))
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.text.count("event: result"), 1)
        self.assertIn("data: [DONE]", response.text)
        self.assertEqual(self.pipeline.call_count, 1)
        self.assertEqual(self.client.get(f"/api/outputs/{JOB_ID}/json", headers=self._headers(token)).status_code, 401)

    def test_web_download_permission_does_not_allow_save_copy(self) -> None:
        self._seed()
        headers = self._headers(self._pair())
        before = self._snapshot()
        for path in (f"/api/outputs/{JOB_ID}/audio/save-copy", "/api/export-record/txt/save-copy"):
            response = self.client.post(path, headers=headers, json=self._record())
            self.assertEqual(response.status_code, 403)
        self._assert_no_side_effect(before)

    def test_actual_export_files_preserve_current_content_and_scope(self) -> None:
        """Check downloaded bytes, not mock file names or Office/Hancom rendering."""
        headers = self._headers(self._pair())
        self._seed()
        stored_before = (self.root / "outputs" / f"{JOB_ID}_result.json").read_bytes()
        payload = self._record()
        payload.update({
            "downloadFilename": "현재 내용 파일 검증",
            "speaker_labels": {"화자000": "STALE_LEGACY_LABEL"},
            "summary": "CURRENT_OVERVIEW 수정한 회의 요약",
            "topics": ["CURRENT_TOPIC 주요 주제"],
            "topicSections": [{"topic": "CURRENT_TOPIC_TITLE", "summary": "CURRENT_TOPIC_BODY 주제별 정리"}],
            "participantSummaries": [{
                "speaker": "화자000", "participant": "STALE_SPEAKER_NAME",
                "summary": "CURRENT_PARTICIPANT_BODY STALE_SPEAKER_NAME의 발언 정리",
            }],
            "decisions": ["CURRENT_DECISION 결정 사항"],
            "actions": ["CURRENT_ACTION 후속 작업"],
            "needsCheck": ["CURRENT_CHECK 확인 사항"],
            "reportTemplate": {"id": "test-report", "name": "CHANGED_TEMPLATE_NAME"},
            "meetingReport": {
                "templateId": "test-report",
                "templateSnapshot": {"id": "test-report", "name": "SAVED_TEMPLATE_NAME"},
                "content": "CURRENT_REPORT_INTRO 보고서 개요",
                "sections": [{"title": "CURRENT_REPORT_TITLE", "content": "CURRENT_REPORT_BODY 보고서 내용"}],
            },
            "editedDisplaySegments": [{
                "start": "00:00:00", "end": "00:00:01", "speaker": "화자000",
                "displaySpeaker": "STALE_SPEAKER_NAME", "text": "CURRENT_TRANSCRIPT_EDIT 화면에서 수정한 발언",
            }],
        })
        payload["displaySegments"][0]["displaySpeaker"] = "STALE_SPEAKER_NAME"
        original_payload = copy.deepcopy(payload)
        organized_markers = (
            "CURRENT_OVERVIEW", "CURRENT_TOPIC_BODY", "CURRENT_PARTICIPANT_BODY",
            "CURRENT_DECISION", "CURRENT_ACTION", "CURRENT_CHECK",
        )
        report_markers = ("CURRENT_REPORT_INTRO", "CURRENT_REPORT_TITLE", "CURRENT_REPORT_BODY")
        formats_by_scope = {
            "transcript": ("txt",), "organized": ("md", "docx", "hwpx"),
            "report": ("md", "docx", "hwpx"), "full": ("txt", "md", "docx", "hwpx"),
        }
        media_types = {
            "txt": "text/plain", "md": "text/markdown",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "hwpx": "application/hwp+zip",
        }
        for scope, formats in formats_by_scope.items():
            for kind in formats:
                with self.subTest(scope=scope, kind=kind):
                    response = self.client.post(
                        f"/api/export-record/{kind}", headers=headers, json={**payload, "exportScope": scope},
                    )
                    self.assertEqual(response.status_code, 200, response.text if kind in {"txt", "md"} else response.status_code)
                    self.assertEqual(response.headers["content-type"].split(";")[0], media_types[kind])
                    disposition = unquote(response.headers["content-disposition"])
                    self.assertIn("attachment;", disposition)
                    self.assertIn(f"현재-내용-파일-검증.{kind}", disposition)
                    self.assertEqual(int(response.headers["content-length"]), len(response.content))
                    if kind in {"txt", "md"}:
                        text = response.content.decode("utf-8")
                    else:
                        with zipfile.ZipFile(BytesIO(response.content)) as archive:
                            self.assertIsNone(archive.testzip())
                            for name in archive.namelist():
                                if name.endswith((".xml", ".rels", ".hpf")):
                                    ElementTree.fromstring(archive.read(name))
                            if kind == "docx":
                                self.assertTrue({"[Content_Types].xml", "_rels/.rels", "word/document.xml"}.issubset(archive.namelist()))
                                document = ElementTree.fromstring(archive.read("word/document.xml"))
                                text = "\n".join(document.itertext())
                            else:
                                self.assertEqual(archive.read("mimetype"), b"application/hwp+zip")
                                self.assertEqual(archive.getinfo("mimetype").compress_type, zipfile.ZIP_STORED)
                                self.assertTrue({"Contents/header.xml", "Contents/content.hpf", "Contents/section0.xml", "Preview/PrvText.txt"}.issubset(archive.namelist()))
                                document = ElementTree.fromstring(archive.read("Contents/section0.xml"))
                                text = "\n".join(document.itertext())
                                preview = archive.read("Preview/PrvText.txt").decode("utf-8")
                                self.assertEqual(text.split(), preview.split())
                    for marker in organized_markers:
                        if scope in {"organized", "full"}:
                            self.assertIn(marker, text)
                        else:
                            self.assertNotIn(marker, text)
                    for marker in report_markers:
                        if scope in {"report", "full"}:
                            self.assertIn(marker, text)
                        else:
                            self.assertNotIn(marker, text)
                    if scope in {"report", "full"}:
                        self.assertIn("SAVED_TEMPLATE_NAME", text)
                    if scope in {"transcript", "full"}:
                        self.assertIn("CURRENT_TRANSCRIPT_EDIT", text)
                    else:
                        self.assertNotIn("CURRENT_TRANSCRIPT_EDIT", text)
                    if scope != "report":
                        self.assertIn("참석자01", text)
                    if scope != "transcript":
                        self.assertIn(payload["title"], text)
                    self.assertNotIn("STALE_SPEAKER_NAME", text)
                    self.assertNotIn("STALE_LEGACY_LABEL", text)
                    self.assertNotIn("CHANGED_TEMPLATE_NAME", text)
                    self.assertNotIn(ORIGINAL_TEXT, text)
                    self.assertNotIn(EDITED_TEXT, text)
        self.assertEqual(payload, original_payload)
        self.assertEqual((self.root / "outputs" / f"{JOB_ID}_result.json").read_bytes(), stored_before)

    def test_txt_scope_compatibility_and_plain_text_preserve_user_markup(self) -> None:
        headers = self._headers(self._pair())
        transcript_text = "**수정한 발언** #분류\n## 사용자가 입력한 소제목"
        overview = "**사용자 강조** #본문 태그\n## 사용자가 적은 요약 제목"
        report_text = "**보고서 강조** #보고 태그"
        payload = self._record(text=transcript_text)
        payload.update({
            "sourceFile": "current-record.wav",
            "summary": overview,
            "meetingReport": {
                "templateName": "고정 양식",
                "content": "보고서 소개",
                "sections": [{"title": "보고서 문단", "content": report_text}],
            },
        })
        expected_transcript = f"[00:00:00] 참석자01: {transcript_text}\n"
        for scope_payload in ({}, {"exportScope": "transcript"}, {"export_scope": "transcript"}):
            with self.subTest(scope_payload=scope_payload):
                response = self.client.post("/api/export-record/txt", headers=headers, json={**payload, **scope_payload})
                self.assertEqual(response.status_code, 200)
                text = response.content.decode("utf-8").replace("\r\n", "\n")
                self.assertEqual(text, expected_transcript)
                self.assertNotIn(overview, text)
                self.assertNotIn(report_text, text)
        full_texts = []
        for scope_payload in (
            {"exportScope": "full"}, {"export_scope": "full"},
            {"exportScope": " FULL "}, {"exportScope": None, "export_scope": "full"},
        ):
            with self.subTest(scope_payload=scope_payload):
                response = self.client.post("/api/export-record/txt", headers=headers, json={**payload, **scope_payload})
                self.assertEqual(response.status_code, 200)
                text = response.content.decode("utf-8").replace("\r\n", "\n")
                full_texts.append(text)
                self.assertTrue(text.startswith(f"{payload['title']}\n"))
                self.assertIn("파일명: current-record.wav\n", text)
                self.assertIn("\n1. 회의 요약\n", text)
                self.assertIn("\n보고서 문단\n", text)
                self.assertIn("보고 양식: 고정 양식\n", text)
                for generated_markup in ("# 수정한 인증 회의", "**파일명:**", "## 1. 회의 요약", "### 보고서 문단", "**보고 양식:**", "**[00:00]"):
                    self.assertNotIn(generated_markup, text)
                for user_content in (overview, report_text, transcript_text):
                    self.assertIn(user_content, text)
        self.assertTrue(all(text == full_texts[0] for text in full_texts))
        markdown = self.client.post("/api/export-record/md", headers=headers, json={**payload, "exportScope": "full"})
        self.assertEqual(markdown.status_code, 200)
        text = markdown.content.decode("utf-8").replace("\r\n", "\n")
        self.assertTrue(text.startswith(f"# {payload['title']}\n"))
        for generated_markup in ("**파일명:**", "## 1. 회의 요약", "### 보고서 문단", "**보고 양식:**", "**[00:00]"):
            self.assertIn(generated_markup, text)
        for user_content in (overview, report_text, transcript_text):
            self.assertIn(user_content, text)

    def test_missing_json_sync_rebuilds_canonical_status_and_cleared_labels(self) -> None:
        headers = self._headers(self._pair())
        payload = self._record()
        payload["displaySegments"][0]["displaySpeaker"] = "삭제한 이름"
        payload["generationStatus"] = {"summary": "completed", "topicSections": "not_started", "meetingReport": "not_started"}
        response = self.client.post(f"/api/outputs/{JOB_ID}/sync-record", headers=headers, json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["export_error"])
        saved = self.client.get(response.json()["outputs"]["json"], headers=headers).json()
        self.assertEqual(saved["speaker_labels"], {})
        self.assertEqual(saved["display_segments"][0]["speaker_name"], "참석자01")
        status = saved["summary"]["generation_status"]
        self.assertEqual(status["topic_sections"], "not_started")
        self.assertEqual(status["meeting_report"], "not_started")
        self.assertNotIn("topicSections", status)
        downloaded = self.client.get(response.json()["outputs"]["txt"], headers=headers)
        self.assertEqual(downloaded.status_code, 200)
        self.assertIn(EDITED_TEXT, downloaded.text)
        self.assertNotIn("삭제한 이름", downloaded.text)

    def test_missing_json_generation_returns_canonical_completed_status_and_fresh_txt(self) -> None:
        headers = self._headers(self._pair())
        payload = self._record()
        payload["generationStatus"] = {"summary": "completed", "topicSections": "not_started", "speakerContextSummaries": "completed"}
        payload["speakerContextSummaries"] = [{"speaker": "화자000", "display_name": "이전 이름", "summary": "이전 정리"}]
        payload["participantSummaries"] = [{"participant": "이전 이름", "summary": "이전 정리"}]
        with (
            patch.object(main, "_resolve_summary_model", return_value="mock-generation-model"),
            patch("pipeline.summarize.generate_topic_sections", return_value=[{
                "topic": "예산 검토", "summary": "수정한 발언을 반영한 정리", "evidence": [EDITED_TEXT], "actions": [],
            }]) as generator,
        ):
            response = self.client.post(f"/api/outputs/{JOB_ID}/generate-topic-sections", headers=headers, json=payload)
        self.assertEqual(response.status_code, 200)
        self.assertIsNone(response.json()["export_error"])
        self.assertEqual(generator.call_args.args[0][0]["text"], EDITED_TEXT)
        status = response.json()["generation_status"]
        self.assertEqual(status["topic_sections"], "completed")
        self.assertEqual(status["speaker_context_summaries"], "not_started")
        self.assertNotIn("topicSections", status)
        self.assertNotIn("speakerContextSummaries", status)
        saved = self.client.get(response.json()["outputs"]["json"], headers=headers).json()
        self.assertEqual(saved["summary"]["generation_status"], status)
        self.assertEqual(saved["summary"]["speaker_context_summaries"], [])
        self.assertEqual(saved["summary"]["participant_summaries"], [])
        downloaded = self.client.get(response.json()["outputs"]["txt"], headers=headers)
        self.assertEqual(downloaded.status_code, 200)
        self.assertIn(EDITED_TEXT, downloaded.text)

    def test_generation_failure_keeps_previous_content_and_does_not_persist_missing_record(self) -> None:
        headers = self._headers(self._pair())
        original = self._seed()
        original["summary"]["topic_sections"] = [{"topic": "기존 예산", "summary": "보존할 정상 정리"}]
        main._save_job_result(JOB_ID, original)
        main._refresh_transcript_and_summary_exports(JOB_ID, original)
        original_txt = (self.root / "outputs" / f"{JOB_ID}_transcript.txt").read_bytes()
        for job_id in (JOB_ID, "missing-json-on-failure"):
            with (
                self.subTest(job_id=job_id),
                patch.object(main, "_resolve_summary_model", return_value="mock-generation-model"),
                patch("pipeline.summarize.generate_topic_sections", side_effect=RuntimeError("simulated generator failure")),
                self.assertLogs(level="ERROR"),
            ):
                response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections", headers=headers, json=self._record(job_id))
                self.assertEqual(response.status_code, 500)
        saved = main._load_job_result(JOB_ID)
        self.assertEqual(saved["summary"]["topic_sections"], original["summary"]["topic_sections"])
        self.assertEqual((self.root / "outputs" / f"{JOB_ID}_transcript.txt").read_bytes(), original_txt)
        self.assertFalse((self.root / "outputs" / "missing-json-on-failure_result.json").exists())
        self.assertFalse((self.root / "outputs" / "missing-json-on-failure_transcript.txt").exists())

    def test_canonical_status_preserves_owner_and_prefers_existing_backend_keys(self) -> None:
        status = {"topicSections": "not_started", "topic_sections": "completed", "meetingReport": "not_started"}
        summary = {"generation_status": status}
        normalized = main._ensure_generation_status(summary)
        self.assertIs(normalized, status)
        self.assertIs(summary["generation_status"], status)
        self.assertEqual(status["topic_sections"], "completed")
        self.assertEqual(status["meeting_report"], "not_started")
        self.assertNotIn("topicSections", status)
        self.assertNotIn("meetingReport", status)

    def test_sync_export_failure_keeps_latest_json_and_retry_refreshes_txt(self) -> None:
        headers = self._headers(self._pair())
        main._refresh_transcript_and_summary_exports(JOB_ID, self._seed())
        with (
            patch("pipeline.export_txt.export_txt", side_effect=OSError("simulated export failure")),
            self.assertLogs(level="ERROR"),
        ):
            response = self.client.post(f"/api/outputs/{JOB_ID}/sync-record", headers=headers, json=self._record())
        self.assertEqual(response.status_code, 200)
        self.assertTrue(response.json()["export_error"])
        self.assertEqual(main._load_job_result(JOB_ID)["display_segments"][0]["text"], EDITED_TEXT)
        retried = self.client.post(f"/api/outputs/{JOB_ID}/sync-record", headers=headers, json=self._record())
        self.assertIsNone(retried.json()["export_error"])
        self.assertIn(EDITED_TEXT, self.client.get(retried.json()["outputs"]["txt"], headers=headers).text)


if __name__ == "__main__":
    unittest.main()
