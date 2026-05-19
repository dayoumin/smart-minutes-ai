import json
import os
import sys
import tempfile
import unittest
import zipfile
from pathlib import Path
from urllib.parse import quote
from xml.etree import ElementTree
from unittest.mock import patch

from fastapi.testclient import TestClient

PROJECT_ROOT = Path(__file__).resolve().parents[1]
BACKEND_DIR = PROJECT_ROOT / "backend"
sys.path.insert(0, str(BACKEND_DIR))

import main  # noqa: E402


def legacy_meeting_payload(**overrides):
    payload = {
        "id": "2026-05-05 01:55:hjhjhjhjh",
        "title": "회의록: 기존/기록 테스트",
        "date": "2026-05-05 01:55",
        "participants": "hj",
        "sourceFile": "[특집대담] 대선 주자 TV 스탠딩 토론회.mp4",
        "summary": "기존 IndexedDB 기록에서 내려받기를 다시 생성합니다.",
        "topics": ["안보", "인권"],
        "actions": ["후속 검토"],
        "segments": [
            {
                "start": "00:00:03",
                "end": "00:00:29",
                "speaker": "화자03",
                "text": "테스트 발화입니다.",
                "timingApproximate": True,
            }
        ],
    }
    payload.update(overrides)
    return payload


class ExportRecordTest(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp_dir.cleanup)
        self.work_dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.work_dir.cleanup)
        self.config = {
            "paths": {
                "output_dir": self.temp_dir.name,
                "temp_dir": self.work_dir.name,
            }
        }
        self.config_patch = patch.object(main, "load_config", return_value=self.config)
        self.config_patch.start()
        self.addCleanup(self.config_patch.stop)
        self.client = TestClient(main.app)

    def test_exports_legacy_record_with_windows_invalid_id(self):
        payload = legacy_meeting_payload()

        for kind in ("md", "hwpx", "docx", "txt"):
            with self.subTest(kind=kind):
                response = self.client.post(f"/api/export-record/{kind}", json=payload)

                self.assertEqual(response.status_code, 200, response.text)
                self.assertGreater(len(response.content), 0)
                disposition = response.headers.get("content-disposition", "")
                self.assertIn(f".{kind}", disposition)

        generated = os.listdir(self.temp_dir.name)
        self.assertTrue(generated)
        self.assertTrue(all(":" not in filename for filename in generated))

    def test_exports_record_with_path_like_id_without_leaving_output_dir(self):
        payload = legacy_meeting_payload(id="../outside\\bad:id", title="")

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        generated = [Path(self.temp_dir.name) / name for name in os.listdir(self.temp_dir.name)]
        self.assertTrue(generated)
        self.assertTrue(all(path.parent == Path(self.temp_dir.name) for path in generated))
        self.assertTrue(all(".." not in path.name and "\\" not in path.name and "/" not in path.name for path in generated))

    def test_delete_outputs_removes_sanitized_export_for_legacy_job_id(self):
        job_id = "old:meeting?1"
        payload = legacy_meeting_payload(id=job_id, jobId=job_id)

        response = self.client.post("/api/export-record/md", json=payload)
        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(os.listdir(self.temp_dir.name))

        delete_response = self.client.delete(f"/api/outputs/{quote(job_id, safe='')}")

        self.assertEqual(delete_response.status_code, 200, delete_response.text)
        self.assertEqual(os.listdir(self.temp_dir.name), [])

    def test_exports_record_without_segments(self):
        payload = legacy_meeting_payload(segments=[], topics=[], actions=[])

        response = self.client.post("/api/export-record/hwpx", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertGreater(len(response.content), 0)

    def test_download_output_regenerates_legacy_minimal_hwpx(self):
        job_id = "legacy_hwpx"
        result_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        result_path.write_text(
            json.dumps(
                {
                    "source_file": "상반기 & 회의.mp4",
                    "created_at": "2026-05-18 14:44",
                    "summary": {
                        "title": "상반기 회의",
                        "overview": "기존 HWPX를 재생성합니다.",
                    },
                    "segments": [
                        {
                            "start": 0,
                            "end": 5,
                            "speaker_name": "김철수",
                            "text": "검토 의견입니다.",
                        }
                    ],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        hwpx_path = Path(self.temp_dir.name) / f"{job_id}_report.hwpx"
        with zipfile.ZipFile(hwpx_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("mimetype", "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
            archive.writestr("META-INF/container.xml", "<container/>")
            archive.writestr("version.xml", "<version/>")
            archive.writestr("Contents/content.hpf", "<package/>")
            archive.writestr("Contents/section0.xml", "<section/>")

        response = self.client.get(f"/api/outputs/{job_id}/hwpx")

        self.assertEqual(response.status_code, 200, response.text)
        with zipfile.ZipFile(hwpx_path) as archive:
            names = set(archive.namelist())
            self.assertTrue(
                {
                    "META-INF/manifest.xml",
                    "Contents/header.xml",
                    "settings.xml",
                    "Preview/PrvText.txt",
                }.issubset(names)
            )
            content_root = ElementTree.fromstring(archive.read("Contents/content.hpf"))
            opf_ns = {"opf": "http://www.idpf.org/2007/opf/"}
            spine_refs = [
                item.attrib.get("idref")
                for item in content_root.findall("./opf:spine/opf:itemref", opf_ns)
            ]
            self.assertEqual(spine_refs, ["header", "section0"])
            preview = archive.read("Preview/PrvText.txt").decode("utf-8")
            self.assertIn("기존 HWPX를 재생성합니다.", preview)

    def test_download_output_keeps_existing_hwpx_when_refresh_fails(self):
        job_id = "legacy_hwpx_refresh_failure"
        result_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        result_path.write_text(
            json.dumps(
                {
                    "summary": {
                        "title": "상반기 회의",
                        "overview": "재생성 실패 시 기존 파일을 유지합니다.",
                    },
                    "segments": [],
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        hwpx_path = Path(self.temp_dir.name) / f"{job_id}_report.hwpx"
        with zipfile.ZipFile(hwpx_path, "w", compression=zipfile.ZIP_DEFLATED) as archive:
            archive.writestr("mimetype", "application/hwp+zip", compress_type=zipfile.ZIP_STORED)
            archive.writestr("META-INF/container.xml", "<container/>")
            archive.writestr("version.xml", "<version/>")
            archive.writestr("Contents/content.hpf", "<package/>")
            archive.writestr("Contents/section0.xml", "<section/>")
        before = hwpx_path.read_bytes()

        with (
            patch("main.logging.exception") as log_exception,
            patch("pipeline.export_hwpx.export_hwpx", side_effect=RuntimeError("boom")),
        ):
            response = self.client.get(f"/api/outputs/{job_id}/hwpx")

        self.assertEqual(response.status_code, 200, response.text)
        log_exception.assert_called_once()
        self.assertEqual(hwpx_path.read_bytes(), before)
        self.assertFalse(list(Path(self.temp_dir.name).glob(f"{job_id}_report.hwpx.*.tmp")))

    def test_export_record_prefers_display_segments_and_speaker_labels(self):
        payload = legacy_meeting_payload(
            speakerLabels={"화자000": "김철수"},
            segments=[
                {
                    "start": "00:00:00",
                    "end": "00:00:05",
                    "speaker": "화자000",
                    "text": "원본 조각입니다.",
                }
            ],
            displaySegments=[
                {
                    "start": "00:00:00",
                    "end": "00:00:10",
                    "speaker": "화자000",
                    "text": "읽기 좋은 표시용 문장입니다.",
                }
            ],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("읽기 좋은 표시용 문장입니다.", content)
        self.assertNotIn("원본 조각입니다.", content)
        self.assertIn("김철수", content)

    def test_exports_speaker_context_without_participant_summaries(self):
        payload = legacy_meeting_payload(
            participantSummaries=[],
            speakerContextSummaries=[
                {
                    "speaker": "SPEAKER_00",
                    "display_name": "화자1",
                    "summary": "발언자별 맥락 정리만 있는 기록입니다.",
                    "key_points": ["핵심 발언"],
                    "actions": ["후속 확인"],
                }
            ],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("발언자별 맥락 정리만 있는 기록입니다.", content)
        self.assertIn("화자1", content)

    def test_export_record_applies_speaker_labels_to_speaker_context_summaries(self):
        payload = legacy_meeting_payload(
            speakerLabels={"SPEAKER_00": "김철수"},
            participantSummaries=[
                {
                    "participant": "화자1",
                    "summary": "화자1은 예산을 설명했습니다.",
                }
            ],
            speakerContextSummaries=[
                {
                    "speaker": "SPEAKER_00",
                    "display_name": "화자1",
                    "summary": "화자1은 발언자별 맥락을 정리했습니다.",
                    "key_points": ["화자1 핵심 발언"],
                    "actions": ["화자1 후속 확인"],
                }
            ],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("### 김철수", content)
        self.assertNotIn("화자1", content)

    def test_export_record_empty_speaker_labels_clear_stale_names(self):
        payload = legacy_meeting_payload(
            speakerLabels={},
            speaker_labels={"SPEAKER_00": "김철수"},
            segments=[
                {
                    "start": "00:00:00",
                    "end": "00:00:05",
                    "speaker": "SPEAKER_00",
                    "text": "발언 내용입니다.",
                }
            ],
            participantSummaries=[
                {
                    "participant": "김철수",
                    "summary": "김철수는 이전 이름으로 저장된 참석자별 정리입니다.",
                }
            ],
            speakerContextSummaries=[
                {
                    "speaker": "SPEAKER_00",
                    "display_name": "김철수",
                    "summary": "김철수는 발언자별 맥락을 정리했습니다.",
                    "key_points": ["김철수 핵심 발언"],
                    "actions": ["김철수 후속 확인"],
                }
            ],
        )

        response = self.client.post("/api/export-record/md", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        content = response.content.decode("utf-8")
        self.assertIn("### SPEAKER_00", content)
        self.assertNotIn("김철수", content)

    def test_topic_generation_stays_completed_when_export_refresh_fails(self):
        job_id = "unit_topic_export_refresh_failure"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {
                        "generation_status": {"topic_sections": "not_started"},
                        "generation_error_detail": "topic_generation_empty",
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with (
            patch("pipeline.summarize.generate_topic_sections", return_value=[{"topic": "예산", "summary": "예산 논의"}]),
            patch.object(main, "_refresh_summary_exports", side_effect=RuntimeError("export failed")),
            patch.object(main.logging, "exception"),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections")

        self.assertEqual(response.status_code, 200, response.text)
        data = response.json()
        self.assertEqual(data["generation_status"]["topic_sections"], "completed")
        self.assertEqual(data["export_error"], "정리는 완료됐지만 다운로드 파일 갱신은 실패했습니다.")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["summary"]["generation_status"]["topic_sections"], "completed")
        self.assertNotIn("generation_error_detail", result_data["summary"])

    def test_topic_generation_clears_stale_speaker_context(self):
        job_id = "unit_topic_generation_clears_speaker_context"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {
                        "topic_sections": [{"topic": "Old", "summary": "Old topic"}],
                        "speaker_context_summaries": [
                            {"speaker": "SPEAKER_00", "display_name": "Speaker 00", "summary": "Old speaker context"}
                        ],
                        "participant_summaries": [
                            {"participant": "Speaker 00", "summary": "Old participant summary"}
                        ],
                        "generation_status": {
                            "summary": "completed",
                            "topic_sections": "completed",
                            "speaker_context_summaries": "completed",
                        },
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with (
            patch("pipeline.summarize.generate_topic_sections", return_value=[{"topic": "Budget", "summary": "Budget discussion"}]),
            patch.object(main, "_refresh_summary_exports", return_value=main._result_outputs(job_id)),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections")

        self.assertEqual(response.status_code, 200, response.text)
        response_data = response.json()
        self.assertEqual(response_data["speaker_context_summaries"], [])
        self.assertEqual(response_data["participant_summaries"], [])
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        summary = result_data["summary"]
        self.assertEqual(summary["generation_status"]["topic_sections"], "completed")
        self.assertEqual(summary["generation_status"]["speaker_context_summaries"], "not_started")
        self.assertEqual(summary["speaker_context_summaries"], [])
        self.assertEqual(summary["participant_summaries"], [])

    def test_topic_generation_empty_result_is_not_marked_completed(self):
        job_id = "unit_topic_generation_empty"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {"generation_status": {"summary": "completed", "topic_sections": "not_started"}},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with patch("pipeline.summarize.generate_topic_sections", return_value=[]):
            response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections")

        self.assertEqual(response.status_code, 502, response.text)
        self.assertEqual(response.json()["detail"], "topic_generation_empty")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["summary"]["generation_status"]["topic_sections"], "failed")
        self.assertEqual(result_data["summary"]["generation_error_detail"], "topic_generation_empty")

    def test_speaker_context_empty_result_is_not_marked_completed(self):
        job_id = "unit_speaker_context_empty"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {
                        "topic_sections": [{"topic": "Budget", "summary": "Budget discussion"}],
                        "generation_status": {
                            "summary": "completed",
                            "topic_sections": "completed",
                            "speaker_context_summaries": "not_started",
                        },
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        with patch("pipeline.summarize.generate_speaker_context_summaries", return_value=[]):
            response = self.client.post(f"/api/outputs/{job_id}/generate-speaker-context")

        self.assertEqual(response.status_code, 502, response.text)
        self.assertEqual(response.json()["detail"], "speaker_context_generation_empty")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["summary"]["generation_status"]["speaker_context_summaries"], "failed")
        self.assertEqual(result_data["summary"]["generation_error_detail"], "speaker_context_generation_empty")

    def test_speaker_context_success_clears_previous_generation_error(self):
        job_id = "unit_speaker_context_clears_error"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {
                        "topic_sections": [{"topic": "Budget", "summary": "Budget discussion"}],
                        "generation_error_detail": "speaker_context_generation_empty",
                        "generation_status": {
                            "summary": "completed",
                            "topic_sections": "completed",
                            "speaker_context_summaries": "not_started",
                        },
                    },
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        speaker_summary = [{"speaker": "SPEAKER_00", "display_name": "Speaker 00", "summary": "Discussed budget."}]
        with (
            patch("pipeline.summarize.generate_speaker_context_summaries", return_value=speaker_summary),
            patch.object(main, "_refresh_summary_exports", return_value=main._result_outputs(job_id)),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-speaker-context")

        self.assertEqual(response.status_code, 200, response.text)
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["summary"]["generation_status"]["speaker_context_summaries"], "completed")
        self.assertNotIn("generation_error_detail", result_data["summary"])

    def test_diarization_runtime_error_is_persisted_with_detail(self):
        job_id = "unit_diarization_runtime_error"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"start": 0.0, "end": 1.0, "speaker": "SPEAKER_00", "text": "Hello."}],
                    "settings": {"diarization": False},
                    "summary": {"generation_status": {"summary": "completed"}},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )
        wav_path = Path(self.work_dir.name) / "source.wav"
        wav_path.write_bytes(b"RIFF0000WAVE")

        with (
            patch.object(main, "_resolve_job_audio_path", return_value=str(wav_path)),
            patch("pipeline.chunk_audio.get_wav_duration_seconds", return_value=10.0),
            patch.object(main, "model_exists", return_value=True),
            patch.object(main, "resolve_model_path", return_value=self.work_dir.name),
            patch("pipeline.diarize.diarize_audio", side_effect=RuntimeError("pyannote failed")),
            patch.object(main.logging, "exception"),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-diarization")

        self.assertEqual(response.status_code, 500, response.text)
        self.assertEqual(response.json()["detail"], "diarization_runtime_error")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["settings"]["diarization_generation_status"], "failed")
        self.assertEqual(result_data["settings"]["diarization_error_detail"], "diarization_runtime_error")
        self.assertIn("pyannote failed", result_data["settings"]["diarization_error_message"])

    def test_completed_diarization_conflict_does_not_persist_failure(self):
        job_id = "unit_diarization_already_completed"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"start": 0.0, "end": 1.0, "speaker": "SPEAKER_00", "text": "Hello."}],
                    "settings": {
                        "diarization": True,
                        "diarization_generation_status": "completed",
                    },
                    "summary": {"generation_status": {"summary": "completed"}},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        response = self.client.post(f"/api/outputs/{job_id}/generate-diarization")

        self.assertEqual(response.status_code, 409, response.text)
        self.assertEqual(response.json()["detail"], "diarization_already_completed")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["settings"]["diarization_generation_status"], "completed")
        self.assertNotIn("diarization_error_detail", result_data["settings"])
        self.assertNotIn("diarization_error_message", result_data["settings"])

    def test_rejects_duplicate_topic_generation_while_generating(self):
        job_id = "unit_topic_generation_duplicate"
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"
        output_path.write_text(
            json.dumps(
                {
                    "segments": [{"speaker": "SPEAKER_00", "text": "Discuss budget."}],
                    "summary": {"generation_status": {"topic_sections": "generating"}},
                },
                ensure_ascii=False,
            ),
            encoding="utf-8",
        )

        response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections")

        self.assertEqual(response.status_code, 409)

    def test_topic_generation_rebuilds_missing_result_from_record_payload(self):
        job_id = "unit_rebuild_topic_generation"
        payload = legacy_meeting_payload(id=job_id, jobId=job_id)
        output_path = Path(self.temp_dir.name) / f"{job_id}_result.json"

        with (
            patch("pipeline.summarize.generate_topic_sections", return_value=[{"topic": "budget", "summary": "Budget discussion"}]),
            patch.object(main, "_refresh_summary_exports", return_value=main._result_outputs(job_id)),
        ):
            response = self.client.post(f"/api/outputs/{job_id}/generate-topic-sections", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertTrue(output_path.exists())
        data = response.json()
        self.assertEqual(data["generation_status"]["topic_sections"], "completed")
        result_data = json.loads(output_path.read_text(encoding="utf-8"))
        self.assertEqual(result_data["job_id"], job_id)
        self.assertTrue(result_data["segments"])

    def test_txt_export_without_segments_has_placeholder(self):
        payload = legacy_meeting_payload(segments=[])

        response = self.client.post("/api/export-record/txt", json=payload)

        self.assertEqual(response.status_code, 200, response.text)
        self.assertIn("발화 스크립트 데이터가 없습니다.", response.content.decode("utf-8"))

    def test_rejects_unknown_export_kind(self):
        response = self.client.post("/api/export-record/pdf", json=legacy_meeting_payload())

        self.assertEqual(response.status_code, 404)

    def test_user_model_download_endpoint_is_not_exposed(self):
        response = self.client.post("/api/models/download", json={"models": ["stt_primary"]})

        self.assertEqual(response.status_code, 404)

    def test_model_status_returns_degraded_payload_on_internal_error(self):
        with (
            patch.object(main, "get_model_status", side_effect=RuntimeError("scan failed")),
            patch.object(main.logging, "exception"),
        ):
            response = self.client.get("/api/models/status")

        self.assertEqual(response.status_code, 200, response.text)
        payload = response.json()
        self.assertFalse(payload["ready"])
        self.assertEqual(payload["models"], [])
        self.assertIn("모델 상태를 확인하지 못했습니다.", payload["errors"][0])


if __name__ == "__main__":
    unittest.main()
