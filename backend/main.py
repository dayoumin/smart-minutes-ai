import argparse
import asyncio
import os
import json
import logging
import re
import shutil
import sys
import threading
import time
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from analysis_jobs import AnalysisCancelledError, AnalysisJobRegistry
from config_normalization import (
    DEFAULT_LONG_AUDIO_CHUNK_SECONDS,
    DEFAULT_STT_CHUNK_SECONDS,
    normalize_app_config,
)
from model_manager import get_model_status, model_exists, get_model_spec, normalize_windows_path, resolve_model_path
from pipeline.transcribe import get_stt_device_status

BASE_DIR = os.path.abspath(
    os.environ.get(
        "MEETING_AI_BACKEND_DIR",
        getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))),
    )
)
BASE_DIR = normalize_windows_path(BASE_DIR)

app = FastAPI(title="NIFS AI Meeting API")

ANALYSIS_JOBS = AnalysisJobRegistry()
GENERATION_STATUS_LOCK = threading.Lock()
ANALYSIS_HEARTBEAT_SECONDS = 15
ANALYSIS_STALL_ERROR_SECONDS = 180
ANALYSIS_STALL_ERROR_SECONDS_PREPROCESS = 600
ANALYSIS_STALL_ERROR_SECONDS_PREPARE = 300
ANALYSIS_STALL_ERROR_SECONDS_TRANSCRIBE = 600

app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    ],
    allow_origin_regex=r"^https?://(localhost|127\.0\.0\.1|tauri\.localhost)(:\d+)?$",
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def sse_event(payload: dict | str, event: str | None = None) -> str:
    lines = []
    if event:
        lines.append(f"event: {event}")
    if isinstance(payload, str):
        data = payload
    else:
        data = json.dumps(payload, ensure_ascii=False)
    lines.append(f"data: {data}")
    return "\n".join(lines) + "\n\n"


def make_analysis_heartbeat(last_progress: dict) -> dict:
    message = last_progress.get("message") or "분석을 진행하고 있습니다."
    return {
        **last_progress,
        "type": "progress",
        "heartbeat": True,
        "message": f"{message} 같은 단계가 오래 걸리고 있습니다. 진행이 바뀌지 않으면 취소 후 다시 시도해 주세요.",
    }


def get_analysis_stall_timeout_seconds(last_progress: dict) -> int:
    message = str(last_progress.get("message") or "")
    progress_value = int(last_progress.get("progress") or 0)
    if message.startswith("Converting to WAV"):
        return ANALYSIS_STALL_ERROR_SECONDS_PREPROCESS
    if message.startswith("Transcribing chunk"):
        return ANALYSIS_STALL_ERROR_SECONDS_TRANSCRIBE
    if progress_value <= 25 or message.startswith("Preparing audio chunks"):
        return ANALYSIS_STALL_ERROR_SECONDS_PREPARE
    return ANALYSIS_STALL_ERROR_SECONDS


@app.get("/api/health")
async def health_check() -> dict:
    return {
        "ok": True,
        "service": "NIFS AI Meeting API",
        "backend_dir": BASE_DIR,
        "python_executable": sys.executable,
    }


@app.get("/api/settings")
async def get_settings() -> dict:
    config = load_config()
    return {
        "app_name": config.get("app_name"),
        "offline_mode": config.get("offline_mode", True),
        "analysis_mode": os.environ.get("ANALYSIS_MODE", "mock"),
        "paths": config.get("paths", {}),
        "processing": config.get("processing", {}),
        "preprocessing": config.get("preprocessing", {}),
        "privacy": config.get("privacy", {}),
        "summary": config.get("summary", {}),
        "diarization": config.get("diarization", {}),
        "stt": config.get("stt", {}),
    }


@app.patch("/api/settings")
async def update_settings(payload: dict = Body(...)) -> dict:
    config = load_config()

    if "processing" in payload:
        processing = payload["processing"] or {}
        if "enable_long_audio_chunking" in processing:
            config.setdefault("processing", {})["enable_long_audio_chunking"] = bool(processing["enable_long_audio_chunking"])
        if "long_audio_chunk_seconds" in processing:
            chunk_seconds = int(processing["long_audio_chunk_seconds"])
            if chunk_seconds < 10 or chunk_seconds > 3600:
                raise HTTPException(status_code=400, detail="long_audio_chunk_seconds must be between 10 and 3600")
            config.setdefault("processing", {})["long_audio_chunk_seconds"] = chunk_seconds

    if "preprocessing" in payload:
        preprocessing = payload["preprocessing"] or {}
        target = config.setdefault("preprocessing", {})
        if "enabled" in preprocessing:
            target["enabled"] = bool(preprocessing["enabled"])
        if "normalize_audio" in preprocessing:
            target["normalize_audio"] = bool(preprocessing["normalize_audio"])
        if "normalization_mode" in preprocessing:
            mode = str(preprocessing["normalization_mode"]).lower()
            if mode not in {"auto", "loudnorm", "dynaudnorm", "speechnorm"}:
                raise HTTPException(status_code=400, detail="preprocessing.normalization_mode must be auto, loudnorm, dynaudnorm, or speechnorm")
            target["normalization_mode"] = mode

    if "diarization" in payload:
        diarization = payload["diarization"] or {}
        if "enabled" in diarization:
            config.setdefault("diarization", {})["enabled"] = bool(diarization["enabled"])

    if "stt" in payload:
        stt = payload["stt"] or {}
        config.setdefault("stt", {})["selected_model"] = "faster-whisper-large-v3"
        if "device" in stt:
            device = str(stt["device"])
            if device not in {"cpu", "cuda"}:
                raise HTTPException(status_code=400, detail="stt.device must be cpu or cuda")
            config.setdefault("stt", {})["device"] = device

    save_config(config)
    return await get_settings()


@app.get("/api/models/status")
async def models_status() -> dict:
    try:
        status = get_model_status(BASE_DIR)
        config = load_config()
        selected_stt = "faster-whisper-large-v3"
        selected_device = config.get("stt", {}).get("device", "cpu")
        diarization_enabled = bool(config.get("diarization", {}).get("enabled", False))
        stt_device_status = get_stt_device_status()
        required_stt_keys = {"stt_faster_whisper"}
        for model in status.get("models", []):
            key = model.get("key")
            if key == "stt_faster_whisper":
                model["required"] = key in required_stt_keys
            elif key == "diarization":
                model["required"] = diarization_enabled
        required_models = [model for model in status.get("models", []) if model.get("required")]
        status["ready"] = all(model.get("installed") for model in required_models)
        status["selected_stt_model"] = selected_stt
        status["selected_stt_device"] = selected_device
        status["diarization_enabled"] = diarization_enabled
        status["stt_device_status"] = stt_device_status
        if selected_device == "cuda" and not stt_device_status.get("gpu_usable"):
            status["ready"] = False
            errors = list(status.get("errors") or [])
            errors.append(stt_device_status.get("gpu_reason") or "GPU 가속 조건이 아직 준비되지 않았습니다.")
            status["errors"] = errors
        return status
    except Exception as exc:
        logging.exception("Failed to inspect model status")
        return {
            "ready": False,
            "models": [],
            "errors": [
                "모델 상태를 확인하지 못했습니다. 앱을 다시 실행하거나 models 폴더 구성을 확인해 주세요.",
                str(exc),
            ],
        }


def _asr_benchmark_dirs() -> list[Path]:
    return [
        Path(BASE_DIR) / "temp" / "asr_benchmark",
        Path(BASE_DIR) / "temp" / "api_quality_test",
        Path(BASE_DIR) / "temp" / "audio_performance_eval",
    ]


def _asr_benchmark_file_id(path: Path) -> str:
    try:
        relative = path.relative_to(Path(BASE_DIR) / "temp")
        return str(relative).replace("\\", "/")
    except ValueError:
        return path.name


def _resolve_asr_benchmark_file(file_id: str) -> Path:
    normalized = file_id.replace("\\", "/").strip("/")
    if not normalized or ".." in Path(normalized).parts:
        raise HTTPException(status_code=400, detail="Invalid benchmark result id")

    temp_root = (Path(BASE_DIR) / "temp").resolve()
    candidate = (temp_root / normalized).resolve()
    if not str(candidate).startswith(str(temp_root)) or candidate.suffix.lower() != ".json":
        raise HTTPException(status_code=400, detail="Invalid benchmark result id")
    if not candidate.exists():
        raise HTTPException(status_code=404, detail="Benchmark result not found")
    return candidate


@app.get("/api/dev/asr-benchmarks")
async def list_asr_benchmarks() -> dict:
    results = []
    for directory in _asr_benchmark_dirs():
        if not directory.exists():
            continue
        for path in directory.rglob("*.json"):
            try:
                payload = json.loads(path.read_text(encoding="utf-8"))
            except Exception:
                payload = {}
            payload_dict = payload if isinstance(payload, dict) else {}
            stat = path.stat()
            results.append({
                "id": _asr_benchmark_file_id(path),
                "name": path.name,
                "path": str(path),
                "created_at": payload_dict.get("created_at"),
                "modified_at": datetime.fromtimestamp(stat.st_mtime).isoformat(timespec="seconds"),
                "size_bytes": stat.st_size,
                "sample_count": len(payload_dict.get("samples", [])) if isinstance(payload_dict.get("samples"), list) else None,
                "engine_count": len(payload_dict.get("engines", [])) if isinstance(payload_dict.get("engines"), list) else None,
                "kind": "asr_benchmark" if "samples" in payload_dict else "single_result",
            })
    results.sort(key=lambda item: item.get("modified_at") or "", reverse=True)
    return {"results": results}


@app.get("/api/dev/asr-benchmarks/{file_id:path}")
async def get_asr_benchmark(file_id: str) -> dict:
    path = _resolve_asr_benchmark_file(file_id)
    try:
        payload = json.loads(path.read_text(encoding="utf-8"))
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Failed to read benchmark result: {exc}") from exc
    return {
        "id": _asr_benchmark_file_id(path),
        "name": path.name,
        "path": str(path),
        "payload": payload,
    }


@app.get("/api/outputs/{job_id}/{kind}")
async def download_output(job_id: str, kind: str) -> FileResponse:
    allowed = {
        "json": (f"{job_id}_result.json", "application/json"),
        "txt": (f"{job_id}_transcript.txt", "text/plain; charset=utf-8"),
        "md": (f"{job_id}_report.md", "text/markdown; charset=utf-8"),
        "docx": (f"{job_id}_report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "hwpx": (f"{job_id}_report.hwpx", "application/hwp+zip"),
    }
    if kind not in allowed:
        raise HTTPException(status_code=404, detail="Unknown output type")

    config = load_config()
    output_dir = os.path.abspath(resolve_config_path(config["paths"]["output_dir"]))
    filename, media_type = allowed[kind]
    file_path = os.path.abspath(os.path.join(output_dir, filename))
    if kind == "hwpx" and file_path.startswith(output_dir + os.sep) and not os.path.exists(file_path):
        json_path = os.path.abspath(os.path.join(output_dir, allowed["json"][0]))
        if json_path.startswith(output_dir + os.sep) and os.path.exists(json_path):
            from pipeline.export_hwpx import export_hwpx

            with open(json_path, "r", encoding="utf-8") as f:
                export_hwpx(json.load(f), file_path)
    if not file_path.startswith(output_dir + os.sep) or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Output file not found")

    return FileResponse(file_path, filename=filename, media_type=media_type)


def _validate_job_id(job_id: str) -> str:
    if not job_id or os.path.basename(job_id) != job_id or ".." in job_id:
        raise HTTPException(status_code=400, detail="Invalid job id")
    return job_id


def _artifact_belongs_to_job(name: str, job_id: str) -> bool:
    job_ids = {job_id, _safe_export_id(job_id)}
    exact_names = {
        f"{candidate}.wav"
        for candidate in job_ids
    }
    exact_names.update(
        artifact
        for candidate in job_ids
        for artifact in {
            f"{candidate}_original.wav",
            f"{candidate}_upload.wav",
            f"{candidate}_upload.mp3",
            f"{candidate}_upload.m4a",
            f"{candidate}_upload.aac",
            f"{candidate}_upload.flac",
            f"{candidate}_upload.mp4",
            f"{candidate}_upload.mov",
            f"{candidate}_upload.mkv",
            f"{candidate}_upload.avi",
            f"{candidate}_upload.webm",
            f"{candidate}_chunks",
            f"{candidate}_result.json",
            f"{candidate}_transcript.txt",
            f"{candidate}_report.md",
            f"{candidate}_report.docx",
            f"{candidate}_report.hwpx",
        }
    )
    return (
        name in exact_names
        or any(name.startswith(f"{candidate}_upload.") for candidate in job_ids)
        or any(name.startswith(f"{candidate}_original.") for candidate in job_ids)
        or any(name.startswith(f"{candidate}_export_") for candidate in job_ids)
    )


def _delete_job_artifacts(job_id: str) -> list[str]:
    config = load_config()
    output_dir = os.path.abspath(resolve_config_path(config["paths"]["output_dir"]))
    temp_dir = os.path.abspath(resolve_config_path(config["paths"]["temp_dir"]))
    deleted: list[str] = []

    if os.path.isdir(output_dir):
        for name in os.listdir(output_dir):
            if not _artifact_belongs_to_job(name, job_id):
                continue
            file_path = os.path.abspath(os.path.join(output_dir, name))
            if file_path.startswith(output_dir + os.sep) and os.path.isfile(file_path):
                os.remove(file_path)
                deleted.append(os.path.basename(file_path))

    if os.path.isdir(temp_dir):
        for name in os.listdir(temp_dir):
            if not _artifact_belongs_to_job(name, job_id):
                continue
            path = os.path.abspath(os.path.join(temp_dir, name))
            if not path.startswith(temp_dir + os.sep):
                continue
            if os.path.isdir(path):
                shutil.rmtree(path)
            elif os.path.exists(path):
                os.remove(path)
            deleted.append(os.path.basename(path))

    return deleted


@app.delete("/api/outputs/{job_id}")
async def delete_outputs(job_id: str) -> dict:
    job_id = _validate_job_id(job_id)
    return {"job_id": job_id, "deleted": _delete_job_artifacts(job_id)}


def _get_output_dir() -> str:
    config = load_config()
    output_dir = os.path.abspath(resolve_config_path(config["paths"]["output_dir"]))
    os.makedirs(output_dir, exist_ok=True)
    return output_dir


def _get_job_result_path(job_id: str) -> str:
    job_id = _validate_job_id(job_id)
    output_dir = _get_output_dir()
    result_path = os.path.abspath(os.path.join(output_dir, f"{job_id}_result.json"))
    if not result_path.startswith(output_dir + os.sep):
        raise HTTPException(status_code=400, detail="Invalid output path")
    return result_path


def _load_job_result(job_id: str) -> dict:
    result_path = _get_job_result_path(job_id)
    if not os.path.exists(result_path):
        raise HTTPException(status_code=404, detail="Output result not found")
    with open(result_path, "r", encoding="utf-8") as f:
        return json.load(f)


def _load_or_rebuild_job_result(job_id: str, payload: dict | None = None) -> dict:
    try:
        return _load_job_result(job_id)
    except HTTPException as exc:
        if exc.status_code != 404 or not payload:
            raise

    result_data = _meeting_record_to_export_result({**payload, "jobId": job_id})
    if not result_data.get("segments"):
        raise HTTPException(status_code=404, detail="Output result not found")
    _save_job_result(job_id, result_data)
    return result_data


def _save_job_result(job_id: str, result_data: dict) -> None:
    result_path = _get_job_result_path(job_id)
    with open(result_path, "w", encoding="utf-8") as f:
        json.dump(result_data, f, ensure_ascii=False, indent=2)
        f.write("\n")


def _resolve_summary_model(config: dict) -> str:
    llm_model = config.get("summary", {}).get("model", "gemma-4b")
    if llm_model and llm_model.startswith((".", "..")):
        llm_model = os.path.normpath(os.path.join(BASE_DIR, llm_model))
    return llm_model


def _ensure_generation_status(summary: dict) -> dict:
    status = summary.get("generation_status")
    if not isinstance(status, dict):
        status = {}
    status.setdefault("topic_sections", "completed" if summary.get("topic_sections") else "not_started")
    status.setdefault(
        "speaker_context_summaries",
        "completed" if summary.get("speaker_context_summaries") else "not_started",
    )
    summary["generation_status"] = status
    return status


def _result_outputs(job_id: str) -> dict:
    return {
        "job_id": job_id,
        "json": f"/api/outputs/{job_id}/json",
        "txt": f"/api/outputs/{job_id}/txt",
        "md": f"/api/outputs/{job_id}/md",
        "docx": f"/api/outputs/{job_id}/docx",
        "hwpx": f"/api/outputs/{job_id}/hwpx",
    }


def _refresh_summary_exports(job_id: str, result_data: dict) -> dict:
    from pipeline.export_docx import export_docx
    from pipeline.export_hwpx import export_hwpx
    from pipeline.export_markdown import export_markdown

    output_dir = _get_output_dir()
    md_path = os.path.abspath(os.path.join(output_dir, f"{job_id}_report.md"))
    docx_path = os.path.abspath(os.path.join(output_dir, f"{job_id}_report.docx"))
    hwpx_path = os.path.abspath(os.path.join(output_dir, f"{job_id}_report.hwpx"))
    for path in (md_path, docx_path, hwpx_path):
        if not path.startswith(output_dir + os.sep):
            raise HTTPException(status_code=400, detail="Invalid export path")

    export_markdown(result_data, md_path)
    export_docx(result_data, docx_path)
    export_hwpx(result_data, hwpx_path)
    return _result_outputs(job_id)


def _participant_summaries_from_speaker_context(items: list[dict]) -> list[dict]:
    return [
        {
            "participant": item.get("display_name") or item.get("speaker") or "발언자",
            "summary": item.get("summary", ""),
            "key_points": item.get("key_points", []),
            "actions": item.get("actions", []),
        }
        for item in items
    ]


@app.post("/api/outputs/{job_id}/generate-topic-sections")
async def generate_output_topic_sections(job_id: str, payload: dict | None = Body(None)) -> dict:
    job_id = _validate_job_id(job_id)
    with GENERATION_STATUS_LOCK:
        result_data = _load_or_rebuild_job_result(job_id, payload)
        segments = result_data.get("segments") or []
        if not segments:
            raise HTTPException(status_code=400, detail="Transcript segments are required")

        summary = result_data.setdefault("summary", {})
        status = _ensure_generation_status(summary)
        if status.get("topic_sections") == "generating":
            raise HTTPException(status_code=409, detail="Topic sections are already being generated")
        status["topic_sections"] = "generating"
        _save_job_result(job_id, result_data)

    try:
        config = load_config()
        from pipeline.summarize import generate_topic_sections

        topic_sections = await asyncio.to_thread(
            generate_topic_sections,
            segments,
            summary,
            _resolve_summary_model(config),
        )
    except Exception:
        with GENERATION_STATUS_LOCK:
            status["topic_sections"] = "failed"
            _save_job_result(job_id, result_data)
        logging.exception("Failed to generate topic sections")
        raise HTTPException(status_code=500, detail="Failed to generate topic sections")

    summary["topic_sections"] = topic_sections
    existing_topics = [topic for topic in summary.get("topics", []) if isinstance(topic, str) and topic.strip()]
    generated_topics = [section["topic"] for section in topic_sections if section.get("topic")]
    summary["topics"] = list(dict.fromkeys(existing_topics + generated_topics))
    status["topic_sections"] = "completed"
    with GENERATION_STATUS_LOCK:
        _save_job_result(job_id, result_data)

    export_error = None
    try:
        outputs = _refresh_summary_exports(job_id, result_data)
    except Exception:
        logging.exception("Failed to refresh exports after topic section generation")
        outputs = _result_outputs(job_id)
        export_error = "정리는 완료됐지만 다운로드 파일 갱신은 실패했습니다."

    return {
        "job_id": job_id,
        "topic_sections": topic_sections,
        "topics": summary.get("topics", []),
        "generation_status": status,
        "outputs": outputs,
        "export_error": export_error,
    }


@app.post("/api/outputs/{job_id}/generate-speaker-context")
async def generate_output_speaker_context(job_id: str, payload: dict | None = Body(None)) -> dict:
    job_id = _validate_job_id(job_id)
    with GENERATION_STATUS_LOCK:
        result_data = _load_or_rebuild_job_result(job_id, payload)
        segments = result_data.get("segments") or []
        if not segments:
            raise HTTPException(status_code=400, detail="Transcript segments are required")

        summary = result_data.setdefault("summary", {})
        status = _ensure_generation_status(summary)
        topic_sections = summary.get("topic_sections") or []
        if status.get("topic_sections") != "completed" or not topic_sections:
            raise HTTPException(
                status_code=409,
                detail="Topic sections must be generated before speaker context summaries",
            )
        if status.get("speaker_context_summaries") == "generating":
            raise HTTPException(status_code=409, detail="Speaker context summaries are already being generated")
        status["speaker_context_summaries"] = "generating"
        _save_job_result(job_id, result_data)

    try:
        config = load_config()
        from pipeline.summarize import generate_speaker_context_summaries

        speaker_context_summaries = await asyncio.to_thread(
            generate_speaker_context_summaries,
            segments,
            summary,
            summary.get("topic_sections", []),
            _resolve_summary_model(config),
        )
    except Exception:
        with GENERATION_STATUS_LOCK:
            status["speaker_context_summaries"] = "failed"
            _save_job_result(job_id, result_data)
        logging.exception("Failed to generate speaker context summaries")
        raise HTTPException(status_code=500, detail="Failed to generate speaker context summaries")

    summary["speaker_context_summaries"] = speaker_context_summaries
    summary["participant_summaries"] = _participant_summaries_from_speaker_context(speaker_context_summaries)
    status["speaker_context_summaries"] = "completed"
    with GENERATION_STATUS_LOCK:
        _save_job_result(job_id, result_data)

    export_error = None
    try:
        outputs = _refresh_summary_exports(job_id, result_data)
    except Exception:
        logging.exception("Failed to refresh exports after speaker context generation")
        outputs = _result_outputs(job_id)
        export_error = "정리는 완료됐지만 다운로드 파일 갱신은 실패했습니다."

    return {
        "job_id": job_id,
        "speaker_context_summaries": speaker_context_summaries,
        "participant_summaries": summary["participant_summaries"],
        "generation_status": status,
        "outputs": outputs,
        "export_error": export_error,
    }


def _safe_export_name(title: str, extension: str) -> str:
    safe = "".join("-" if ch in '/\\?%*:|"<> ' else ch for ch in title.strip())
    return f"{safe or 'meeting-minutes'}.{extension}"


def _safe_export_id(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    safe = safe.strip("._-")
    return safe[:80] or "record"


def _time_to_seconds(value) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    if not isinstance(value, str):
        return 0.0

    parts = value.strip().split(":")
    try:
        if len(parts) == 3:
            hours, minutes, seconds = parts
            return int(hours) * 3600 + int(minutes) * 60 + float(seconds)
        if len(parts) == 2:
            minutes, seconds = parts
            return int(minutes) * 60 + float(seconds)
        return float(value)
    except ValueError:
        return 0.0


def _meeting_record_to_export_result(payload: dict) -> dict:
    segments = []
    for segment in payload.get("segments") or []:
        speaker = segment.get("speaker_name") or segment.get("speaker") or ""
        segments.append({
            "start": _time_to_seconds(segment.get("start", 0.0)),
            "end": _time_to_seconds(segment.get("end", 0.0)),
            "speaker": speaker,
            "speaker_name": speaker,
            "text": segment.get("text", ""),
            "timing_approximate": bool(segment.get("timingApproximate") or segment.get("timing_approximate")),
        })

    title = str(payload.get("title") or "회의록")
    speaker_context_summaries = payload.get("speakerContextSummaries") or payload.get("speaker_context_summaries") or []
    participant_summaries = (
        payload.get("participantSummaries")
        or payload.get("participant_summaries")
        or _participant_summaries_from_speaker_context(speaker_context_summaries)
    )
    return {
        "job_id": payload.get("jobId") or payload.get("id") or datetime.now().strftime("%Y%m%d_%H%M%S"),
        "source_file": payload.get("sourceFile") or "",
        "created_at": payload.get("date") or datetime.now().isoformat(timespec="seconds"),
        "participants": payload.get("participants") or "",
        "segments": segments,
        "summary": {
            "title": title,
            "overview": payload.get("summary") or "",
            "topics": payload.get("topics") or [],
            "topic_sections": payload.get("topicSections") or payload.get("topic_sections") or [],
            "participant_summaries": participant_summaries,
            "speaker_context_summaries": speaker_context_summaries,
            "generation_status": payload.get("generationStatus") or payload.get("generation_status") or {},
            "actions": payload.get("actions") or [],
            "decisions": payload.get("decisions") or [],
            "needs_check": payload.get("needs_check") or payload.get("needsCheck") or [],
        },
    }


@app.post("/api/export-record/{kind}")
async def export_record(kind: str, payload: dict = Body(...)) -> FileResponse:
    allowed = {
        "txt": ("txt", "text/plain; charset=utf-8"),
        "md": ("md", "text/markdown; charset=utf-8"),
        "docx": ("docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "hwpx": ("hwpx", "application/hwp+zip"),
    }
    if kind not in allowed:
        raise HTTPException(status_code=404, detail="Unknown export type")

    config = load_config()
    output_dir = os.path.abspath(resolve_config_path(config["paths"]["output_dir"]))
    os.makedirs(output_dir, exist_ok=True)

    result_data = _meeting_record_to_export_result(payload)
    extension, media_type = allowed[kind]
    record_id = _safe_export_id(str(payload.get("jobId") or payload.get("id") or "record"))
    export_id = f"{record_id}_export_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"
    output_path = os.path.abspath(os.path.join(output_dir, f"{export_id}_current.{extension}"))
    if not output_path.startswith(output_dir + os.sep):
        raise HTTPException(status_code=400, detail="Invalid export path")

    if kind == "txt":
        from pipeline.export_txt import export_txt

        export_txt(result_data["segments"], output_path)
    elif kind == "md":
        from pipeline.export_markdown import export_markdown

        export_markdown(result_data, output_path)
    elif kind == "docx":
        from pipeline.export_docx import export_docx

        export_docx(result_data, output_path)
    else:
        from pipeline.export_hwpx import export_hwpx

        export_hwpx(result_data, output_path)

    filename = _safe_export_name(result_data["summary"]["title"], extension)
    return FileResponse(output_path, filename=filename, media_type=media_type)


@app.post("/api/analyze")
async def analyze_meeting(
    title: str = Form(...),
    date: str = Form(...),
    participants: str = Form(...),
    file: UploadFile = File(...),
    mode: str = Form("real"),
    job_id: str | None = Form(None),
) -> StreamingResponse:
    if mode not in {"mock", "real"}:
        raise HTTPException(status_code=400, detail="mode must be 'mock' or 'real'")

    if mode == "real":
        return StreamingResponse(
            stream_real_analysis(title, date, participants, file, job_id),
            media_type="text/event-stream",
            headers={
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
                "X-Accel-Buffering": "no",
            },
        )

    async def event_generator() -> AsyncIterator[str]:
        steps = [
            (10, "파일 업로드 수신 완료"),
            (25, "오디오 전처리 준비 중"),
            (45, "음성 인식(STT) mock 처리 중"),
            (65, "화자 분리 mock 처리 중"),
            (85, "회의 요약 mock 생성 중"),
        ]

        for progress, message in steps:
            await asyncio.sleep(0.35)
            yield sse_event({
                "type": "progress",
                "progress": progress,
                "message": message,
                "status": "processing",
            }, event="progress")

        final_data = {
            "type": "result",
            "mode": "mock",
            "progress": 100,
            "status": "completed",
            "meeting": {
                "title": title,
                "date": date,
                "participants": participants,
                "source_file": file.filename,
            },
            "summary": (
                f"[Mock 회의록]\n"
                f"- 회의명: {title}\n"
                f"- 일시: {date}\n"
                f"- 참석자: {participants}\n"
                f"- 업로드 파일: {file.filename}\n\n"
                "프론트엔드가 FastAPI 백엔드에 파일과 메타데이터를 전송했고, "
                "백엔드는 SSE 스트리밍으로 진행률과 최종 회의록 결과를 반환했습니다."
            ),
            "topics": ["엔드투엔드 연결", "SSE 진행률 스트리밍", "실제 AI 파이프라인 연동 준비"],
            "decisions": ["SSE 스트리밍 기반 분석 흐름을 유지합니다."],
            "needs_check": [],
            "actions": ["Mock 응답을 실제 STT/요약 파이프라인으로 교체", "회의록 DB 저장 API 추가"],
            "segments": [
                {
                    "start": "00:00:00",
                    "end": "00:00:05",
                    "speaker": "Speaker 1",
                    "text": "FastAPI 서버가 업로드 요청을 정상적으로 받았습니다.",
                },
                {
                    "start": "00:00:06",
                    "end": "00:00:11",
                    "speaker": "Speaker 2",
                    "text": "프론트엔드는 SSE 스트림에서 진행률 이벤트를 수신하고 있습니다.",
                },
            ],
        }

        yield sse_event(final_data, event="result")
        yield sse_event("[DONE]", event="done")

    return StreamingResponse(
        event_generator(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )


@app.post("/api/analyze/{job_id}/cancel")
async def cancel_analysis(job_id: str) -> dict:
    job_id = _validate_job_id(job_id)
    return {"job_id": job_id, "cancel_requested": ANALYSIS_JOBS.cancel(job_id)}


async def stream_real_analysis(
    title: str,
    date: str,
    participants: str,
    file: UploadFile,
    requested_job_id: str | None = None,
) -> AsyncIterator[str]:
    queue: asyncio.Queue[dict | str] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    job_id = _validate_job_id(requested_job_id) if requested_job_id else datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    try:
        cancel_event = ANALYSIS_JOBS.create(job_id)
    except ValueError as exc:
        yield sse_event({
            "type": "error",
            "mode": "real",
            "progress": 0,
            "status": "error",
            "message": str(exc),
        }, event="error")
        yield sse_event("[DONE]", event="done")
        return
    last_progress: dict = {
        "type": "progress",
        "mode": "real",
        "progress": 0,
        "message": "분석을 준비하고 있습니다.",
        "status": "processing",
    }
    last_real_progress_at = time.monotonic()

    def raise_if_cancelled() -> None:
        if cancel_event.is_set():
            raise AnalysisCancelledError("분석이 취소되었습니다.")

    def report_progress(step: str, progress: int) -> None:
        nonlocal last_progress, last_real_progress_at
        raise_if_cancelled()
        last_real_progress_at = time.monotonic()
        last_progress = {
            "type": "progress",
            "mode": "real",
            "progress": progress,
            "message": step,
            "status": "processing",
        }
        loop.call_soon_threadsafe(
            queue.put_nowait,
            last_progress,
        )

    async def save_upload() -> str:
        raise_if_cancelled()
        config = load_config()
        temp_dir = resolve_config_path(config["paths"]["temp_dir"])
        os.makedirs(temp_dir, exist_ok=True)
        suffix = Path(file.filename or "upload").suffix
        upload_path = os.path.join(temp_dir, f"{job_id}_upload{suffix}")

        try:
            with open(upload_path, "wb") as buffer:
                while chunk := await file.read(1024 * 1024):
                    raise_if_cancelled()
                    buffer.write(chunk)
        except Exception:
            if os.path.exists(upload_path):
                os.remove(upload_path)
            raise

        return upload_path

    async def prepare_real_config() -> dict:
        raise_if_cancelled()
        config = load_config()

        report_progress("음성 인식 모델 확인 중", 6)
        config.setdefault("stt", {})["selected_model"] = "faster-whisper-large-v3"
        stt_spec = get_model_spec("stt_faster_whisper")
        if not model_exists(BASE_DIR, stt_spec):
            raise RuntimeError(
                f"선택한 음성 인식 모델이 없습니다: {stt_spec.label}. "
                "실행 파일 옆 models 폴더에 모델 폴더를 넣은 뒤 다시 실행해 주세요."
            )
        config["paths"]["stt_model"] = resolve_model_path(BASE_DIR, stt_spec)
        report_progress("음성 인식 모델 준비 완료", 8)

        diarization_spec = get_model_spec("diarization")
        diarization_ready = model_exists(BASE_DIR, diarization_spec)

        if diarization_ready:
            config["paths"]["diarization_model"] = resolve_model_path(BASE_DIR, diarization_spec)
        else:
            config["diarization"]["enabled"] = False
            report_progress("화자 분리 모델이 없어 STT 중심 분석으로 진행합니다.", 10)

        return config

    async def worker() -> None:
        upload_path = ""
        try:
            raise_if_cancelled()
            upload_path = await save_upload()
            last_progress.update({
                "type": "progress",
                "mode": "real",
                "progress": 5,
                "message": "업로드 파일 저장 완료",
                "status": "processing",
            })
            await queue.put(dict(last_progress))

            config = await prepare_real_config()
            raise_if_cancelled()
            result = await asyncio.to_thread(
                process_audio_pipeline,
                upload_path,
                job_id,
                config,
                report_progress,
                cancel_event,
            )
            raise_if_cancelled()
            result_data = result["result_data"]
            final_data = {
                "type": "result",
                "mode": "real",
                "progress": 100,
                "status": "completed",
                "meeting": {
                    "title": title,
                    "date": date,
                    "participants": participants,
                    "source_file": file.filename,
                    "job_id": result["job_id"],
                },
                "outputs": {
                    "job_id": result["job_id"],
                    "json": f"/api/outputs/{result['job_id']}/json",
                    "txt": f"/api/outputs/{result['job_id']}/txt",
                    "md": f"/api/outputs/{result['job_id']}/md" if result.get("md_file") else None,
                    "docx": f"/api/outputs/{result['job_id']}/docx" if result.get("docx_file") else None,
                    "hwpx": f"/api/outputs/{result['job_id']}/hwpx" if result.get("hwpx_file") else None,
                },
                "summary": format_summary_for_ui(result_data.get("summary", {}), title, date, participants),
            "topics": result_data.get("summary", {}).get("topics", []),
            "topic_sections": result_data.get("summary", {}).get("topic_sections", []),
            "participant_summaries": result_data.get("summary", {}).get("participant_summaries", []),
            "speaker_context_summaries": result_data.get("summary", {}).get("speaker_context_summaries", []),
            "generation_status": result_data.get("summary", {}).get("generation_status", {}),
            "actions": result_data.get("summary", {}).get("actions", []),
            "decisions": result_data.get("summary", {}).get("decisions", []),
            "needs_check": result_data.get("summary", {}).get("needs_check", []),
            "segments": [
                    {
                        "start": seconds_to_timestamp(segment.get("start", 0.0)),
                        "end": seconds_to_timestamp(segment.get("end", 0.0)),
                        "speaker": segment.get("speaker_name") or segment.get("speaker") or "Speaker",
                        "text": segment.get("text", ""),
                        "timingApproximate": bool(segment.get("timing_approximate", False)),
                    }
                    for segment in result_data.get("segments", [])
                ],
            }
            await queue.put(final_data)
            await queue.put("[DONE]")
        except AnalysisCancelledError as exc:
            await queue.put({
                "type": "cancelled",
                "mode": "real",
                "progress": 0,
                "status": "cancelled",
                "message": str(exc),
            })
            await queue.put("[DONE]")
            try:
                _delete_job_artifacts(job_id)
            except Exception:
                logging.exception("Failed to delete cancelled analysis artifacts")
        except Exception as exc:
            await queue.put({
                "type": "error",
                "mode": "real",
                "progress": 100,
                "status": "error",
                "message": str(exc),
            })
            await queue.put("[DONE]")
        finally:
            try:
                if upload_path:
                    config = load_config()
                    if not config["privacy"].get("save_original_audio_copy", False) and os.path.exists(upload_path):
                        os.remove(upload_path)
            except Exception:
                logging.exception("Failed to clean up uploaded analysis file")
            finally:
                ANALYSIS_JOBS.remove(job_id, cancel_event)

    task = asyncio.create_task(worker())

    try:
        while True:
            try:
                payload = await asyncio.wait_for(queue.get(), timeout=ANALYSIS_HEARTBEAT_SECONDS)
            except asyncio.TimeoutError:
                if task.done():
                    try:
                        payload = queue.get_nowait()
                    except asyncio.QueueEmpty:
                        yield sse_event("[DONE]", event="done")
                        break
                else:
                    stall_timeout_seconds = get_analysis_stall_timeout_seconds(last_progress)
                    if time.monotonic() - last_real_progress_at >= stall_timeout_seconds:
                        cancel_event.set()
                        yield sse_event({
                            "type": "error",
                            "mode": "real",
                            "progress": last_progress.get("progress", 0),
                            "status": "error",
                            "message": "같은 분석 단계가 너무 오래 진행되지 않았습니다. 분석을 중단하고 다시 시도해 주세요.",
                        }, event="error")
                        yield sse_event("[DONE]", event="done")
                        break
                    yield sse_event(make_analysis_heartbeat(last_progress), event="progress")
                    continue
            if payload == "[DONE]":
                yield sse_event("[DONE]", event="done")
                break
            event = payload.get("type") if isinstance(payload, dict) else None
            yield sse_event(payload, event=event)
    finally:
        if not task.done():
            cancel_event.set()


def resolve_config_path(path_value: str) -> str:
    if os.path.isabs(path_value):
        return path_value
    return os.path.normpath(os.path.join(BASE_DIR, path_value))


def seconds_to_timestamp(seconds: float) -> str:
    seconds = max(0, int(float(seconds)))
    h = seconds // 3600
    m = (seconds % 3600) // 60
    s = seconds % 60
    return f"{h:02d}:{m:02d}:{s:02d}"


def format_summary_for_ui(summary: dict, title: str, date: str, participants: str) -> str:
    overview = summary.get("overview") if isinstance(summary, dict) else None
    if overview:
        return overview
    return f"{title} 회의({date}, {participants}) 분석이 완료되었습니다."

def normalize_stt_config(config: dict) -> dict:
    """Backward-compatible wrapper for older tests and imports."""
    return normalize_app_config(config)


def load_config(config_path: str = "config.json") -> dict:
    # Resolve relative to script location for sidecar stability
    full_path = os.path.join(BASE_DIR, config_path)
    with open(full_path, "r", encoding="utf-8") as f:
        return normalize_app_config(json.load(f))


def save_config(config: dict, config_path: str = "config.json") -> None:
    full_path = os.path.join(BASE_DIR, config_path)
    with open(full_path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
        f.write("\n")

def process_audio_pipeline(input_file: str, job_id: str = None, config: dict = None, progress_callback=None, cancel_event=None) -> dict:
    from pipeline.align_speakers import align_segments_with_speakers
    from pipeline.audio_preprocess import convert_to_wav
    from pipeline.chunk_audio import apply_time_offset, split_wav_by_duration
    from pipeline.diarize import diarize_audio
    from pipeline.export_docx import export_docx
    from pipeline.export_hwpx import export_hwpx
    from pipeline.export_markdown import export_markdown
    from pipeline.export_txt import export_txt, save_result_json
    from pipeline.summarize import summarize_meeting
    from pipeline.transcribe import transcribe_audio

    if config is None:
        config = load_config()
    else:
        config = normalize_app_config(config)

    def _raise_if_cancelled():
        if cancel_event is not None and cancel_event.is_set():
            raise AnalysisCancelledError("분석이 취소되었습니다.")
        
    def _report_progress(step: str, prog: int):
        _raise_if_cancelled()
        print(f"[{prog}%] {step}")
        if progress_callback:
            progress_callback(step, prog)

    output_dir = resolve_config_path(config["paths"]["output_dir"])
    temp_dir = resolve_config_path(config["paths"]["temp_dir"])
    
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(temp_dir, exist_ok=True)
    
    if not job_id:
        base_name = os.path.splitext(os.path.basename(input_file))[0]
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        job_id = f"{timestamp}_{base_name}"
    
    temp_wav_path = os.path.join(temp_dir, f"{job_id}.wav")
    out_json_path = os.path.join(output_dir, f"{job_id}_result.json")
    out_txt_path = os.path.join(output_dir, f"{job_id}_transcript.txt")
    out_md_path = os.path.join(output_dir, f"{job_id}_report.md")
    out_docx_path = os.path.join(output_dir, f"{job_id}_report.docx")
    out_hwpx_path = os.path.join(output_dir, f"{job_id}_report.hwpx")

    print(f"--- Local Meeting AI Pipeline ---")
    print(f"Input: {input_file}")
    _raise_if_cancelled()
    
    # 1. Convert to WAV
    _report_progress("Converting to WAV...", 10)
    # ffmpeg path is safe to leave as-is if it's "ffmpeg" (system path), otherwise resolve
    ffmpeg_path = config["paths"]["ffmpeg"]
    if not ffmpeg_path.lower() == "ffmpeg" and not os.path.isabs(ffmpeg_path):
        ffmpeg_path = os.path.normpath(os.path.join(BASE_DIR, ffmpeg_path))
    preprocess_result = convert_to_wav(
        input_file,
        temp_wav_path,
        ffmpeg_path,
        preprocessing=config.get("preprocessing", {}),
    )
    preprocessing_applied = preprocess_result.get("preprocessing", {}) if isinstance(preprocess_result, dict) else {}
    _raise_if_cancelled()
    
    # 2. STT (Transcribe)
    _report_progress("Preparing audio chunks...", 25)
    stt_model_path = config["paths"]["stt_model"]
    if stt_model_path.startswith((".", "..")):
        stt_model_path = resolve_config_path(stt_model_path)

    fallback_stt_model_path = None
    fallback_stt_spec = get_model_spec("stt_faster_whisper")
    if model_exists(BASE_DIR, fallback_stt_spec):
        fallback_stt_model_path = resolve_model_path(BASE_DIR, fallback_stt_spec)
    if (
        fallback_stt_model_path
        and os.path.normcase(os.path.normpath(fallback_stt_model_path))
        == os.path.normcase(os.path.normpath(stt_model_path))
    ):
        fallback_stt_model_path = None

    processing_config = config.get("processing", {})
    enable_chunking = processing_config.get("enable_long_audio_chunking", True)
    long_chunk_seconds = int(processing_config.get("long_audio_chunk_seconds", DEFAULT_LONG_AUDIO_CHUNK_SECONDS))
    chunk_dir = os.path.join(temp_dir, f"{job_id}_chunks")
    chunks = (
        split_wav_by_duration(temp_wav_path, chunk_dir, long_chunk_seconds, ffmpeg_path)
        if enable_chunking
        else [{"path": temp_wav_path, "offset": 0.0, "duration": None, "index": 0}]
    )
    _raise_if_cancelled()

    stt_language = config["stt"].get("language", "ko")
    stt_device = config["stt"].get("device", "auto")
    stt_chunk_seconds = int(config["stt"].get("chunk_seconds", DEFAULT_STT_CHUNK_SECONDS))
    def _transcribe_chunks(chunks_to_process, model_path, allow_internal_fallback):
        collected_segments = []
        total = len(chunks_to_process)
        for idx, chunk in enumerate(chunks_to_process):
            _raise_if_cancelled()
            progress = 30 + int((idx / max(total, 1)) * 35)
            message = f"Transcribing chunk {idx + 1}/{total}..."
            _report_progress(message, progress)
            try:
                chunk_segments = transcribe_audio(
                    chunk["path"],
                    model_path,
                    language=stt_language,
                    device=stt_device,
                    chunk_seconds=stt_chunk_seconds,
                    fallback_model_path=fallback_stt_model_path if allow_internal_fallback else None,
                )
                _raise_if_cancelled()
                collected_segments.extend(apply_time_offset(chunk_segments, float(chunk.get("offset", 0.0))))
            except Exception as chunk_exc:
                print(f"[STT] Exception while transcribing chunk {idx + 1}: {chunk_exc}")
                import traceback
                traceback.print_exc()
                raise
        return collected_segments

    try:
        segments = _transcribe_chunks(
            chunks,
            stt_model_path,
            allow_internal_fallback=True,
        )
    except Exception:
        if not fallback_stt_model_path:
            raise
        _report_progress("Primary speech recognition failed; using fallback model...", 30)
        fallback_chunks = (
            split_wav_by_duration(temp_wav_path, chunk_dir, long_chunk_seconds, ffmpeg_path)
            if enable_chunking
            else [{"path": temp_wav_path, "offset": 0.0, "duration": None, "index": 0}]
        )
        segments = _transcribe_chunks(
            fallback_chunks,
            fallback_stt_model_path,
            allow_internal_fallback=False,
        )

    if not segments:
        print("[STT] No transcript segments were returned; skipping diarization and summary.")
        summary_data = {
            "overview": "음성 인식 결과가 없어 회의 요약을 만들지 못했습니다.",
        }
    else:
        summary_data = {}
    
    # 3. Diarization (Optional)
    if segments and config.get("diarization", {}).get("enabled", True):
        _report_progress("Speaker Diarization & Alignment...", 60)
        _raise_if_cancelled()
        diarize_model_path = config["paths"]["diarization_model"]
        if diarize_model_path and diarize_model_path.startswith((".", "..")):
            diarize_model_path = os.path.normpath(os.path.join(BASE_DIR, diarize_model_path))
        min_spk = config["diarization"].get("min_speakers")
        max_spk = config["diarization"].get("max_speakers")
        
        spk_segments = diarize_audio(temp_wav_path, diarize_model_path, min_spk, max_spk)
        _raise_if_cancelled()
        segments = align_segments_with_speakers(segments, spk_segments)
    
    # 4. Summary (Optional)
    if segments and config.get("summary", {}).get("enabled", True):
        _report_progress("Summarizing with Local LLM...", 80)
        _raise_if_cancelled()
        llm_model = config["summary"].get("model", "gemma-4b")
        if llm_model and llm_model.startswith((".", "..")):
            llm_model = os.path.normpath(os.path.join(BASE_DIR, llm_model))
        summary_data = summarize_meeting(segments, model_name_or_path=llm_model)
        _raise_if_cancelled()
    if summary_data:
        _ensure_generation_status(summary_data)
    
    # 5. Save Results
    _report_progress("Saving results...", 90)
    _raise_if_cancelled()
    result_data = {
        "job_id": job_id,
        "source_file": os.path.basename(input_file),
        "created_at": datetime.now().isoformat(),
        "language": config["stt"]["language"],
        "settings": {
            "stt_model": stt_model_path,
            "diarization_model": config["paths"].get("diarization_model"),
            "llm_model": config["paths"].get("llm_model"),
            "diarization": config.get("diarization", {}).get("enabled", True),
            "summary": config.get("summary", {}).get("enabled", True),
            "preprocessing": preprocessing_applied,
        },
        "segments": segments,
        "summary": summary_data
    }
    
    save_result_json(result_data, out_json_path)
    export_txt(segments, out_txt_path)
    
    if summary_data:
        export_markdown(result_data, out_md_path)
        export_docx(result_data, out_docx_path)
        export_hwpx(result_data, out_hwpx_path)
    
    # Cleanup temp wav
    if config["privacy"].get("auto_delete_temp_audio", True):
        if os.path.exists(temp_wav_path):
            os.remove(temp_wav_path)
        if os.path.isdir(chunk_dir):
            shutil.rmtree(chunk_dir, ignore_errors=True)
            
    return {
        "success": True,
        "job_id": job_id,
        "json_file": out_json_path,
        "txt_file": out_txt_path,
        "md_file": out_md_path if summary_data else None,
        "docx_file": out_docx_path if summary_data else None,
        "hwpx_file": out_hwpx_path if summary_data else None,
        "result_data": result_data
    }

def main():
    parser = argparse.ArgumentParser(description="Local Meeting AI - CLI MVP")
    parser.add_argument("--input", help="Input audio/video file path")
    parser.add_argument("--mode", default="standard", help="Processing mode: fast, standard, accurate")
    parser.add_argument("--serve", action="store_true", help="Run the FastAPI server")
    args = parser.parse_args()

    if args.serve or not args.input:
        import uvicorn
        uvicorn.run("main:app", host="127.0.0.1", port=8000, reload=True)
        return

    results = process_audio_pipeline(args.input)
    
    print(f"Done! Results saved in outputs/")
    print(f" - JSON: {results['json_file']}")
    print(f" - TXT: {results['txt_file']}")
    if results['md_file']:
        print(f" - MD: {results['md_file']}")
        print(f" - DOCX: {results['docx_file']}")


if __name__ == "__main__":
    main()
