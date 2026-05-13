import argparse
import asyncio
import copy
import hashlib
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
from job_checkpoints import (
    CorruptCheckpointError,
    atomic_write_json,
    build_config_fingerprint,
    build_job_checkpoint_paths,
    ensure_job_checkpoint_dirs,
    get_job_upload_path,
    get_stt_chunk_checkpoint_path,
    hash_file_contents,
    load_json_checkpoint,
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
ACTIVE_GENERATIONS: set[tuple[str, str]] = set()
ANALYSIS_HEARTBEAT_SECONDS = 15
ANALYSIS_STALL_ERROR_SECONDS = 180
ANALYSIS_STALL_ERROR_SECONDS_PREPROCESS = 600
ANALYSIS_STALL_ERROR_SECONDS_PREPARE = 300
ANALYSIS_STALL_ERROR_SECONDS_TRANSCRIBE = 600
DETAIL_SUMMARY_INPUT_CHANGED = "summary_input_changed"
DETAIL_TOPIC_INPUT_CHANGED = "topic_input_changed"
DETAIL_SPEAKER_INPUT_CHANGED = "speaker_input_changed"
ANALYSIS_CHECKPOINT_VERSION = 1
ANALYSIS_PIPELINE_VERSION = "2026-05-13-long-file-v1"

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
    return {
        **last_progress,
        "type": "progress",
        "heartbeat": True,
    }


def _analysis_config_fingerprint(config: dict) -> str:
    return build_config_fingerprint({
        "stt": config.get("stt", {}),
        "processing": config.get("processing", {}),
        "preprocessing": config.get("preprocessing", {}),
        "diarization": config.get("diarization", {}),
        "summary": {
            "enabled": config.get("summary", {}).get("enabled", True),
            "model": config.get("summary", {}).get("model", ""),
        },
        "paths": {
            "stt_model": config.get("paths", {}).get("stt_model", ""),
            "diarization_model": config.get("paths", {}).get("diarization_model", ""),
            "llm_model": config.get("paths", {}).get("llm_model", ""),
        },
    })


def _load_job_state(paths) -> dict:
    try:
        return load_json_checkpoint(paths.state_path) or {}
    except CorruptCheckpointError:
        return {}


def _write_job_state(paths, payload: dict) -> dict:
    current = _load_job_state(paths)
    merged = {
        **current,
        **payload,
        "updated_at": datetime.now().isoformat(),
    }
    atomic_write_json(paths.state_path, merged)
    return merged


def _normalize_resume_file_size(value: int | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _normalize_resume_last_modified(value: int | None) -> int | None:
    if value is None:
        return None
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def _stt_execution_fingerprint(model_path: str, device: str, chunk_seconds: int) -> str:
    payload = json.dumps(
        {
            "model_path": os.path.normcase(os.path.normpath(model_path)),
            "device": device,
            "chunk_seconds": int(chunk_seconds),
            "pipeline_version": ANALYSIS_PIPELINE_VERSION,
            "checkpoint_version": ANALYSIS_CHECKPOINT_VERSION,
        },
        ensure_ascii=False,
        sort_keys=True,
        separators=(",", ":"),
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _seed_analysis_job_state(
    *,
    job_id: str,
    config: dict,
    source_filename: str | None,
    source_size: int | None,
    source_last_modified: int | None,
    resume_requested: bool,
) -> None:
    temp_dir = resolve_config_path(config["paths"]["temp_dir"])
    checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
    ensure_job_checkpoint_dirs(checkpoint_paths)
    _write_job_state(checkpoint_paths, {
        "job_id": job_id,
        "source_file": source_filename or job_id,
        "source_filename": source_filename or "",
        "source_size": _normalize_resume_file_size(source_size),
        "source_last_modified": _normalize_resume_last_modified(source_last_modified),
        "config_fingerprint": _analysis_config_fingerprint(config),
        "pipeline_version": ANALYSIS_PIPELINE_VERSION,
        "checkpoint_version": ANALYSIS_CHECKPOINT_VERSION,
        "resume_requested": bool(resume_requested),
        "stage": "uploaded",
        "cancelled": False,
        "failed": False,
        "resume_supported": False,
        "cleanup_policy": "preserve_checkpoints",
        "last_progress": {
            "message": "업로드 파일 저장 완료",
            "progress": 0,
            "status": "processing",
        },
        "last_heartbeat_at": datetime.now().isoformat(),
    })


def _build_resume_candidate_payload(job_id: str, state: dict) -> dict:
    progress_payload = state.get("last_progress") or {}
    completed_chunk_count = len(state.get("completed_chunk_indices") or [])
    return {
        "job_id": job_id,
        "stage": state.get("stage") or "unknown",
        "updated_at": state.get("updated_at"),
        "created_at": state.get("created_at"),
        "resume_supported": bool(state.get("resume_supported")),
        "active": ANALYSIS_JOBS.has(job_id),
        "chunk_count": int(state.get("chunk_count") or 0),
        "completed_chunk_count": completed_chunk_count,
        "last_progress": {
            "message": str(progress_payload.get("message") or ""),
            "progress": int(progress_payload.get("progress") or 0),
            "status": str(progress_payload.get("status") or ""),
        },
    }


def _find_resume_candidates(
    *,
    config: dict,
    source_filename: str,
    source_size: int | None,
    source_last_modified: int | None,
) -> list[dict]:
    temp_dir = resolve_config_path(config["paths"]["temp_dir"])
    jobs_root = os.path.join(os.path.abspath(temp_dir), "jobs")
    if not os.path.isdir(jobs_root):
        return []

    expected_size = _normalize_resume_file_size(source_size)
    expected_last_modified = _normalize_resume_last_modified(source_last_modified)
    config_fingerprint = _analysis_config_fingerprint(config)
    candidates: list[dict] = []

    for entry in os.scandir(jobs_root):
        if not entry.is_dir():
            continue
        job_id = entry.name
        checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
        state = _load_job_state(checkpoint_paths)
        if not state:
            continue
        if state.get("stage") == "completed":
            continue
        if not state.get("resume_supported"):
            continue
        completed_chunk_count = len(state.get("completed_chunk_indices") or [])
        if completed_chunk_count <= 0:
            continue
        if state.get("config_fingerprint") != config_fingerprint:
            continue
        if str(state.get("source_filename") or "") != source_filename:
            continue
        if expected_size is not None and _normalize_resume_file_size(state.get("source_size")) != expected_size:
            continue
        if (
            expected_last_modified is not None
            and _normalize_resume_last_modified(state.get("source_last_modified")) != expected_last_modified
        ):
            continue
        candidates.append(_build_resume_candidate_payload(job_id, state))

    candidates.sort(
        key=lambda item: (
            int(item.get("completed_chunk_count") or 0),
            item.get("updated_at") or item.get("created_at") or "",
        ),
        reverse=True,
    )
    return candidates


def _build_analysis_draft_status(job_id: str, state: dict) -> dict:
    progress_payload = state.get("last_progress") or {}
    stage = str(state.get("stage") or "unknown")
    completed_chunk_count = len(state.get("completed_chunk_indices") or [])
    if state.get("cancelled"):
        status = "cancelled"
    elif state.get("failed"):
        status = "failed"
    elif stage == "completed":
        status = "completed"
    elif ANALYSIS_JOBS.has(job_id):
        status = "active"
    else:
        status = "stopped"
    return {
        "job_id": job_id,
        "status": status,
        "stage": stage,
        "active": ANALYSIS_JOBS.has(job_id),
        "resume_supported": bool(state.get("resume_supported")),
        "completed_chunk_count": completed_chunk_count,
        "updated_at": state.get("updated_at"),
        "created_at": state.get("created_at"),
        "source_filename": str(state.get("source_filename") or ""),
        "source_size": _normalize_resume_file_size(state.get("source_size")),
        "source_last_modified": _normalize_resume_last_modified(state.get("source_last_modified")),
        "last_progress": {
            "message": str(progress_payload.get("message") or ""),
            "progress": int(progress_payload.get("progress") or 0),
            "status": str(progress_payload.get("status") or ""),
        },
        "last_error": str(state.get("last_error") or ""),
    }


def _reset_checkpoint_root_for_new_run(paths, preserve_upload_path: str | None = None) -> None:
    if not os.path.isdir(paths.root_dir):
        return

    preserved_name = None
    if preserve_upload_path:
        try:
            preserved_name = os.path.basename(os.path.dirname(os.path.abspath(preserve_upload_path)))
        except OSError:
            preserved_name = None

    for child_name in os.listdir(paths.root_dir):
        if preserved_name and child_name == preserved_name:
            continue
        child_path = os.path.join(paths.root_dir, child_name)
        if os.path.isdir(child_path):
            shutil.rmtree(child_path, ignore_errors=True)
        else:
            try:
                os.remove(child_path)
            except FileNotFoundError:
                pass


def _record_analysis_heartbeat(job_id: str, progress_payload: dict) -> None:
    try:
        config = load_config()
        temp_dir = resolve_config_path(config["paths"]["temp_dir"])
        paths = build_job_checkpoint_paths(temp_dir, job_id)
        if not os.path.exists(paths.state_path):
            return
        _write_job_state(paths, {
            "last_heartbeat_at": datetime.now().isoformat(),
            "last_progress": {
                "message": str(progress_payload.get("message") or ""),
                "progress": int(progress_payload.get("progress") or 0),
                "status": str(progress_payload.get("status") or ""),
            },
        })
    except Exception:
        logging.exception("Failed to record analysis heartbeat")


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

    checkpoint_root = os.path.join(temp_dir, "jobs", job_id)
    if os.path.isdir(checkpoint_root):
        shutil.rmtree(checkpoint_root, ignore_errors=True)
        deleted.append(os.path.join("jobs", job_id))

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


def _load_or_rebuild_job_result(job_id: str, payload: dict | None = None, *, persist_rebuilt: bool = True) -> tuple[dict, bool]:
    from pipeline.transcript_display import get_transcript_segments

    try:
        result_data = _load_job_result(job_id)
        existed = True
    except HTTPException as exc:
        if exc.status_code != 404 or not payload:
            raise
        result_data = _meeting_record_to_export_result({**payload, "jobId": job_id})
        if not get_transcript_segments(result_data):
            raise HTTPException(status_code=404, detail="Output result not found")
        existed = False
        if persist_rebuilt:
            _save_job_result(job_id, result_data)
        return result_data, existed

    result_data = _apply_payload_transcript_override(result_data, payload)
    if not get_transcript_segments(result_data):
        raise HTTPException(status_code=404, detail="Output result not found")
    return result_data, existed


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
    status.setdefault("summary", "completed" if summary.get("overview") else "not_started")
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


def _begin_generation(job_id: str, kind: str) -> tuple[str, str]:
    generation_key = (job_id, kind)
    if generation_key in ACTIVE_GENERATIONS:
        raise HTTPException(status_code=409, detail=f"{kind} generation is already running")
    ACTIVE_GENERATIONS.add(generation_key)
    return generation_key


def _end_generation(generation_key: tuple[str, str] | None) -> None:
    if generation_key:
        ACTIVE_GENERATIONS.discard(generation_key)


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


@app.post("/api/outputs/{job_id}/generate-summary")
async def generate_output_summary(job_id: str, payload: dict | None = Body(None)) -> dict:
    from pipeline.summarize import summarize_meeting
    from pipeline.transcript_display import get_transcript_segments

    job_id = _validate_job_id(job_id)
    generation_key = None
    try:
        with GENERATION_STATUS_LOCK:
            result_data, had_saved_result = _load_or_rebuild_job_result(job_id, payload, persist_rebuilt=False)
            segments = get_transcript_segments(result_data)
            if not segments:
                raise HTTPException(status_code=400, detail="Transcript segments are required")
            segments_fingerprint = _segment_fingerprint(segments)

            summary = result_data.setdefault("summary", {})
            status = _ensure_generation_status(summary)
            if status.get("summary") == "generating":
                raise HTTPException(status_code=409, detail="Summary is already being generated")
            generation_key = _begin_generation(job_id, "summary")
            status["summary"] = "generating"
            if had_saved_result:
                _save_job_result(job_id, result_data)

        try:
            config = load_config()
            summary_data = await asyncio.to_thread(
                summarize_meeting,
                segments,
                _resolve_summary_model(config),
            )
        except Exception:
            with GENERATION_STATUS_LOCK:
                if os.path.exists(_get_job_result_path(job_id)):
                    latest_result = _load_latest_generation_result(job_id, result_data)
                    latest_summary = latest_result.setdefault("summary", {})
                    latest_status = _ensure_generation_status(latest_summary)
                    latest_status["summary"] = "failed"
                    _save_job_result(job_id, latest_result)
            logging.exception("Failed to generate summary")
            raise HTTPException(status_code=500, detail="Failed to generate summary")

        with GENERATION_STATUS_LOCK:
            latest_result = _load_latest_generation_result(job_id, result_data)
            if _segment_fingerprint(get_transcript_segments(latest_result)) != segments_fingerprint:
                latest_summary = latest_result.setdefault("summary", {})
                latest_status = _ensure_generation_status(latest_summary)
                latest_status["summary"] = "not_started"
                if os.path.exists(_get_job_result_path(job_id)):
                    _save_job_result(job_id, latest_result)
                raise HTTPException(status_code=409, detail=DETAIL_SUMMARY_INPUT_CHANGED)
            latest_summary = latest_result.setdefault("summary", {})
            latest_status = _ensure_generation_status(latest_summary)
            previous_topic_sections = latest_summary.get("topic_sections", [])
            previous_speaker_context = latest_summary.get("speaker_context_summaries", [])
            previous_participant_summaries = latest_summary.get("participant_summaries", [])

            latest_summary.update(summary_data)
            latest_summary["topic_sections"] = []
            latest_summary["speaker_context_summaries"] = []
            latest_summary["participant_summaries"] = []
            latest_status["summary"] = "completed"
            latest_status["topic_sections"] = "not_started"
            latest_status["speaker_context_summaries"] = "not_started"
            latest_summary["generation_status"] = latest_status
            _save_job_result(job_id, latest_result)
            result_data = latest_result
            summary = latest_summary
            status = latest_status

        export_error = None
        try:
            outputs = _refresh_summary_exports(job_id, result_data)
        except Exception:
            logging.exception("Failed to refresh exports after summary generation")
            outputs = _result_outputs(job_id)
            export_error = "정리는 완료됐지만 다운로드 파일 갱신은 실패했습니다."

        return {
            "job_id": job_id,
            "summary": summary.get("overview", ""),
            "topics": summary.get("topics", []),
            "actions": summary.get("actions", []),
            "decisions": summary.get("decisions", []),
            "needs_check": summary.get("needs_check", []),
            "topic_sections": summary.get("topic_sections", []),
            "speaker_context_summaries": summary.get("speaker_context_summaries", []),
            "participant_summaries": summary.get("participant_summaries", []),
            "generation_status": status,
            "outputs": outputs,
            "export_error": export_error,
            "cleared_topic_sections": bool(previous_topic_sections),
            "cleared_speaker_context_summaries": bool(previous_speaker_context or previous_participant_summaries),
        }
    finally:
        with GENERATION_STATUS_LOCK:
            _end_generation(generation_key)


@app.post("/api/outputs/{job_id}/generate-topic-sections")
async def generate_output_topic_sections(job_id: str, payload: dict | None = Body(None)) -> dict:
    from pipeline.transcript_display import get_transcript_segments

    job_id = _validate_job_id(job_id)
    generation_key = None
    try:
        with GENERATION_STATUS_LOCK:
            result_data, had_saved_result = _load_or_rebuild_job_result(job_id, payload, persist_rebuilt=False)
            segments = get_transcript_segments(result_data)
            if not segments:
                raise HTTPException(status_code=400, detail="Transcript segments are required")
            segments_fingerprint = _segment_fingerprint(segments)

            summary = result_data.setdefault("summary", {})
            summary_fingerprint = _summary_generation_fingerprint(summary)
            status = _ensure_generation_status(summary)
            if status.get("topic_sections") == "generating":
                raise HTTPException(status_code=409, detail="Topic sections are already being generated")
            generation_key = _begin_generation(job_id, "topic_sections")
            status["topic_sections"] = "generating"
            if had_saved_result:
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
                if os.path.exists(_get_job_result_path(job_id)):
                    latest_result = _load_latest_generation_result(job_id, result_data)
                    latest_summary = latest_result.setdefault("summary", {})
                    latest_status = _ensure_generation_status(latest_summary)
                    latest_status["topic_sections"] = "failed"
                    _save_job_result(job_id, latest_result)
            logging.exception("Failed to generate topic sections")
            raise HTTPException(status_code=500, detail="Failed to generate topic sections")

        with GENERATION_STATUS_LOCK:
            latest_result = _load_latest_generation_result(job_id, result_data)
            latest_summary = latest_result.setdefault("summary", {})
            if (
                _segment_fingerprint(get_transcript_segments(latest_result)) != segments_fingerprint
                or _summary_generation_fingerprint(latest_summary) != summary_fingerprint
            ):
                latest_status = _ensure_generation_status(latest_summary)
                latest_status["topic_sections"] = "not_started"
                if os.path.exists(_get_job_result_path(job_id)):
                    _save_job_result(job_id, latest_result)
                raise HTTPException(status_code=409, detail=DETAIL_TOPIC_INPUT_CHANGED)
            latest_status = _ensure_generation_status(latest_summary)
            latest_summary["topic_sections"] = topic_sections
            existing_topics = [topic for topic in latest_summary.get("topics", []) if isinstance(topic, str) and topic.strip()]
            generated_topics = [section["topic"] for section in topic_sections if section.get("topic")]
            latest_summary["topics"] = list(dict.fromkeys(existing_topics + generated_topics))
            latest_status["topic_sections"] = "completed"
            latest_summary["generation_status"] = latest_status
            _save_job_result(job_id, latest_result)
            result_data = latest_result
            summary = latest_summary
            status = latest_status

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
    finally:
        with GENERATION_STATUS_LOCK:
            _end_generation(generation_key)


@app.post("/api/outputs/{job_id}/generate-speaker-context")
async def generate_output_speaker_context(job_id: str, payload: dict | None = Body(None)) -> dict:
    from pipeline.transcript_display import get_transcript_segments

    job_id = _validate_job_id(job_id)
    generation_key = None
    try:
        with GENERATION_STATUS_LOCK:
            result_data, had_saved_result = _load_or_rebuild_job_result(job_id, payload, persist_rebuilt=False)
            segments = get_transcript_segments(result_data)
            if not segments:
                raise HTTPException(status_code=400, detail="Transcript segments are required")
            segments_fingerprint = _segment_fingerprint(segments)

            summary = result_data.setdefault("summary", {})
            summary_fingerprint = _summary_generation_fingerprint(summary)
            status = _ensure_generation_status(summary)
            topic_sections = summary.get("topic_sections") or []
            if status.get("topic_sections") != "completed" or not topic_sections:
                raise HTTPException(
                    status_code=409,
                    detail="Topic sections must be generated before speaker context summaries",
                )
            if status.get("speaker_context_summaries") == "generating":
                raise HTTPException(status_code=409, detail="Speaker context summaries are already being generated")
            generation_key = _begin_generation(job_id, "speaker_context_summaries")
            status["speaker_context_summaries"] = "generating"
            if had_saved_result:
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
                if os.path.exists(_get_job_result_path(job_id)):
                    latest_result = _load_latest_generation_result(job_id, result_data)
                    latest_summary = latest_result.setdefault("summary", {})
                    latest_status = _ensure_generation_status(latest_summary)
                    latest_status["speaker_context_summaries"] = "failed"
                    _save_job_result(job_id, latest_result)
            logging.exception("Failed to generate speaker context summaries")
            raise HTTPException(status_code=500, detail="Failed to generate speaker context summaries")

        with GENERATION_STATUS_LOCK:
            latest_result = _load_latest_generation_result(job_id, result_data)
            latest_summary = latest_result.setdefault("summary", {})
            if (
                _segment_fingerprint(get_transcript_segments(latest_result)) != segments_fingerprint
                or _summary_generation_fingerprint(latest_summary) != summary_fingerprint
            ):
                latest_status = _ensure_generation_status(latest_summary)
                latest_status["speaker_context_summaries"] = "not_started"
                if os.path.exists(_get_job_result_path(job_id)):
                    _save_job_result(job_id, latest_result)
                raise HTTPException(status_code=409, detail=DETAIL_SPEAKER_INPUT_CHANGED)
            latest_status = _ensure_generation_status(latest_summary)
            latest_summary["speaker_context_summaries"] = speaker_context_summaries
            latest_summary["participant_summaries"] = _participant_summaries_from_speaker_context(speaker_context_summaries)
            latest_status["speaker_context_summaries"] = "completed"
            latest_summary["generation_status"] = latest_status
            _save_job_result(job_id, latest_result)
            result_data = latest_result
            summary = latest_summary
            status = latest_status

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
    finally:
        with GENERATION_STATUS_LOCK:
            _end_generation(generation_key)


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


def _normalize_speaker_labels(value) -> dict[str, str]:
    if not isinstance(value, dict):
        return {}
    labels = {}
    for key, label in value.items():
        speaker = str(key or "").strip()
        display_name = str(label or "").strip()
        if speaker and display_name:
            labels[speaker] = display_name
    return labels


def _payload_has_key(payload: dict, *keys: str) -> bool:
    return any(key in payload for key in keys)


def _payload_segments(payload: dict, *keys: str) -> list:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


def _normalize_payload_segments(items: list, speaker_labels: dict[str, str]) -> list[dict]:
    segments = []
    for segment in items or []:
        speaker = (
            segment.get("speaker")
            or segment.get("speaker_id")
            or segment.get("speaker_name")
            or ""
        )
        speaker = str(speaker or "").strip()
        display_speaker = (
            speaker_labels.get(speaker)
            or segment.get("displaySpeaker")
            or segment.get("display_speaker")
            or segment.get("speaker_name")
            or speaker
        )
        display_speaker = str(display_speaker or "").strip()
        segments.append({
            "start": _time_to_seconds(segment.get("start", 0.0)),
            "end": _time_to_seconds(segment.get("end", 0.0)),
            "speaker": speaker,
            "speaker_name": display_speaker or speaker,
            "text": segment.get("text", ""),
            "timing_approximate": bool(segment.get("timingApproximate") or segment.get("timing_approximate")),
            "display_only": bool(segment.get("displayOnly") or segment.get("display_only")),
        })
    return segments


def _meeting_record_to_export_result(payload: dict) -> dict:
    speaker_labels = _normalize_speaker_labels(payload.get("speakerLabels") or payload.get("speaker_labels"))
    segments = _normalize_payload_segments(_payload_segments(payload, "segments"), speaker_labels)
    edited_payload_segments = _payload_segments(payload, "editedDisplaySegments", "edited_display_segments")
    base_display_segments = _payload_segments(payload, "displaySegments", "display_segments", "sentenceSegments", "sentence_segments")
    if edited_payload_segments:
        display_source_segments = edited_payload_segments
    elif _payload_has_key(payload, "editedDisplaySegments", "edited_display_segments"):
        display_source_segments = base_display_segments
    else:
        display_source_segments = base_display_segments
    display_segments = _normalize_payload_segments(display_source_segments, speaker_labels)

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
        "display_segments": display_segments,
        "speaker_labels": speaker_labels,
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


def _apply_payload_metadata_override(result_data: dict, payload: dict | None) -> dict:
    if not payload:
        return result_data

    if "sourceFile" in payload or "source_file" in payload:
        result_data["source_file"] = payload.get("sourceFile") or payload.get("source_file") or ""
    if "date" in payload:
        result_data["created_at"] = payload.get("date") or result_data.get("created_at") or ""
    if "participants" in payload:
        result_data["participants"] = payload.get("participants") or ""
    if "title" in payload:
        summary = result_data.setdefault("summary", {})
        summary["title"] = payload.get("title") or summary.get("title") or "회의록"
    return result_data


def _apply_payload_transcript_override(result_data: dict, payload: dict | None) -> dict:
    if not payload:
        return result_data

    result_data = _apply_payload_metadata_override(result_data, payload)
    has_speaker_labels = _payload_has_key(payload, "speakerLabels", "speaker_labels")
    speaker_labels = _normalize_speaker_labels(payload.get("speakerLabels") or payload.get("speaker_labels"))
    edited_payload_segments = _payload_segments(payload, "editedDisplaySegments", "edited_display_segments")
    base_display_segments = _payload_segments(payload, "displaySegments", "display_segments", "sentenceSegments", "sentence_segments")
    has_display_override = _payload_has_key(
        payload,
        "editedDisplaySegments",
        "edited_display_segments",
        "displaySegments",
        "display_segments",
        "sentenceSegments",
        "sentence_segments",
    )
    if edited_payload_segments:
        display_source_segments = edited_payload_segments
    elif _payload_has_key(payload, "editedDisplaySegments", "edited_display_segments"):
        display_source_segments = base_display_segments
    else:
        display_source_segments = base_display_segments
    display_segments = _normalize_payload_segments(display_source_segments, speaker_labels)

    if has_display_override:
        result_data["display_segments"] = display_segments
    if has_speaker_labels:
        result_data["speaker_labels"] = speaker_labels
    return result_data


def _stable_json_fingerprint(value) -> str:
    normalized = json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
    return hashlib.sha1(normalized.encode("utf-8")).hexdigest()


def _segment_fingerprint(segments: list[dict]) -> str:
    normalized = [
        {
            "start": round(_time_to_seconds(segment.get("start", 0.0)), 3),
            "end": round(_time_to_seconds(segment.get("end", segment.get("start", 0.0))), 3),
            "speaker": str(segment.get("speaker") or ""),
            "speaker_name": str(segment.get("speaker_name") or ""),
            "text": str(segment.get("text") or ""),
            "timing_approximate": bool(segment.get("timing_approximate")),
            "display_only": bool(segment.get("display_only")),
        }
        for segment in segments or []
    ]
    return _stable_json_fingerprint(normalized)


def _summary_generation_fingerprint(summary: dict) -> str:
    normalized = {
        "overview": summary.get("overview", ""),
        "topics": summary.get("topics", []),
        "actions": summary.get("actions", []),
        "decisions": summary.get("decisions", []),
        "needs_check": summary.get("needs_check", []),
        "topic_sections": summary.get("topic_sections", []),
    }
    return _stable_json_fingerprint(normalized)


def _load_latest_generation_result(job_id: str, fallback_result: dict) -> dict:
    try:
        return _load_job_result(job_id)
    except HTTPException:
        return fallback_result


@app.post("/api/outputs/{job_id}/sync-record")
async def sync_output_record(job_id: str, payload: dict = Body(...)) -> dict:
    from pipeline.transcript_display import get_transcript_segments

    job_id = _validate_job_id(job_id)
    with GENERATION_STATUS_LOCK:
        result_data, _ = _load_or_rebuild_job_result(job_id, payload)
        result_data = _apply_payload_transcript_override(result_data, payload)
        if not get_transcript_segments(result_data):
            raise HTTPException(status_code=400, detail="Transcript segments are required")
        _save_job_result(job_id, result_data)

    export_error = None
    try:
        outputs = _refresh_summary_exports(job_id, result_data)
    except Exception:
        logging.exception("Failed to refresh exports after sync")
        outputs = _result_outputs(job_id)
        export_error = "저장 내용은 동기화됐지만 다운로드 파일 갱신은 실패했습니다."

    return {
        "job_id": job_id,
        "outputs": outputs,
        "export_error": export_error,
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
        from pipeline.transcript_display import get_transcript_segments

        export_txt(get_transcript_segments(result_data), output_path)
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
    file_size: int | None = Form(None),
    file_last_modified: int | None = Form(None),
    resume_requested: bool = Form(False),
) -> StreamingResponse:
    if mode not in {"mock", "real"}:
        raise HTTPException(status_code=400, detail="mode must be 'mock' or 'real'")

    if mode == "real":
        analysis_job_id = _validate_job_id(job_id) if job_id else datetime.now().strftime("%Y%m%d_%H%M%S_%f")
        try:
            cancel_event = ANALYSIS_JOBS.create(analysis_job_id)
        except ValueError as exc:
            raise HTTPException(status_code=409, detail=str(exc)) from exc
        config = load_config()
        try:
            upload_path = await save_analysis_upload(file, analysis_job_id)
            _seed_analysis_job_state(
                job_id=analysis_job_id,
                config=config,
                source_filename=file.filename,
                source_size=file_size,
                source_last_modified=file_last_modified,
                resume_requested=resume_requested,
            )
        except Exception:
            ANALYSIS_JOBS.remove(analysis_job_id, cancel_event)
            raise
        return StreamingResponse(
            stream_real_analysis(
                title,
                date,
                participants,
                None,
                analysis_job_id,
                prepared_upload_path=upload_path,
                source_filename=file.filename,
                prepared_cancel_event=cancel_event,
            ),
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


@app.post("/api/analyze/resume-candidates")
async def analyze_resume_candidates(payload: dict = Body(...)) -> dict:
    source_filename = str(payload.get("source_filename") or "").strip()
    if not source_filename:
        raise HTTPException(status_code=400, detail="source_filename is required")

    config = load_config()
    candidates = _find_resume_candidates(
        config=config,
        source_filename=source_filename,
        source_size=_normalize_resume_file_size(payload.get("source_size")),
        source_last_modified=_normalize_resume_last_modified(payload.get("source_last_modified")),
    )
    return {
        "candidates": candidates,
        "recommended_job_id": candidates[0]["job_id"] if candidates else None,
    }


@app.post("/api/analyze/draft-statuses")
async def analyze_draft_statuses(payload: dict = Body(...)) -> dict:
    job_ids = payload.get("job_ids")
    if not isinstance(job_ids, list):
        raise HTTPException(status_code=400, detail="job_ids must be a list")

    config = load_config()
    temp_dir = resolve_config_path(config["paths"]["temp_dir"])
    drafts: list[dict] = []

    for raw_job_id in job_ids:
        if not isinstance(raw_job_id, str):
            continue
        try:
            job_id = _validate_job_id(raw_job_id)
        except HTTPException:
            continue
        checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
        state = _load_job_state(checkpoint_paths)
        if not state:
            drafts.append({"job_id": job_id, "status": "missing"})
            continue
        drafts.append(_build_analysis_draft_status(job_id, state))

    return {"drafts": drafts}


@app.post("/api/analyze/{job_id}/cancel")
async def cancel_analysis(job_id: str) -> dict:
    job_id = _validate_job_id(job_id)
    return {"job_id": job_id, "cancel_requested": ANALYSIS_JOBS.cancel(job_id)}


async def save_analysis_upload(file: UploadFile, job_id: str) -> str:
    config = load_config()
    temp_dir = resolve_config_path(config["paths"]["temp_dir"])
    checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
    ensure_job_checkpoint_dirs(checkpoint_paths)
    suffix = Path(file.filename or "upload").suffix
    upload_path = get_job_upload_path(checkpoint_paths, suffix)

    try:
        with open(upload_path, "wb") as buffer:
            while chunk := await file.read(1024 * 1024):
                buffer.write(chunk)
    except Exception:
        if os.path.exists(upload_path):
            os.remove(upload_path)
        raise

    return upload_path


async def stream_real_analysis(
    title: str,
    date: str,
    participants: str,
    file: UploadFile | None,
    requested_job_id: str | None = None,
    *,
    prepared_upload_path: str | None = None,
    source_filename: str | None = None,
    prepared_cancel_event=None,
) -> AsyncIterator[str]:
    queue: asyncio.Queue[dict | str] = asyncio.Queue()
    loop = asyncio.get_running_loop()
    job_id = _validate_job_id(requested_job_id) if requested_job_id else datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    temp_dir = resolve_config_path(load_config()["paths"]["temp_dir"])
    checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
    cancel_event = prepared_cancel_event
    if cancel_event is None:
        try:
            cancel_event = ANALYSIS_JOBS.create(job_id)
        except ValueError as exc:
            if prepared_upload_path and os.path.exists(prepared_upload_path):
                os.remove(prepared_upload_path)
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
        if prepared_upload_path:
            return prepared_upload_path
        if file is None:
            raise RuntimeError("업로드 파일을 찾을 수 없습니다.")
        return await save_analysis_upload(file, job_id)

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
                    "source_file": source_filename or (file.filename if file else ""),
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
                "segments": segments_for_ui(result_data.get("segments", [])),
                "display_segments": segments_for_ui(result_data.get("display_segments", [])),
            }
            await queue.put(final_data)
            await queue.put("[DONE]")
        except AnalysisCancelledError as exc:
            _write_job_state(checkpoint_paths, {
                "stage": "cancelled",
                "cancelled": True,
                "resume_supported": True,
                "last_heartbeat_at": datetime.now().isoformat(),
            })
            await queue.put({
                "type": "cancelled",
                "mode": "real",
                "progress": 0,
                "status": "cancelled",
                "message": str(exc),
            })
            await queue.put("[DONE]")
        except Exception as exc:
            _write_job_state(checkpoint_paths, {
                "stage": "failed",
                "failed": True,
                "resume_supported": True,
                "last_heartbeat_at": datetime.now().isoformat(),
                "last_error": str(exc),
            })
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
                        _record_analysis_heartbeat(job_id, last_progress)
                        yield sse_event({
                            "type": "error",
                            "mode": "real",
                            "progress": last_progress.get("progress", 0),
                            "status": "error",
                            "message": "같은 분석 단계가 너무 오래 진행되지 않았습니다. 분석을 중단하고 다시 시도해 주세요.",
                        }, event="error")
                        yield sse_event("[DONE]", event="done")
                        break
                    _record_analysis_heartbeat(job_id, last_progress)
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


def segments_for_ui(segments: list[dict]) -> list[dict]:
    return [
        {
            "start": seconds_to_timestamp(segment.get("start", 0.0)),
            "end": seconds_to_timestamp(segment.get("end", 0.0)),
            "speaker": segment.get("speaker") or segment.get("speaker_name") or "Speaker",
            "displaySpeaker": segment.get("speaker_name") or segment.get("speaker") or "Speaker",
            "text": segment.get("text", ""),
            "timingApproximate": bool(segment.get("timing_approximate", False)),
            "displayOnly": bool(segment.get("display_only", False)),
        }
        for segment in segments or []
    ]


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
    from pipeline.transcript_display import build_display_segments, get_transcript_segments
    from pipeline.transcribe import transcribe_audio

    if config is None:
        config = load_config()
    else:
        config = normalize_app_config(config)

    def _raise_if_cancelled():
        if cancel_event is not None and cancel_event.is_set():
            raise AnalysisCancelledError("분석이 취소되었습니다.")

    output_dir = resolve_config_path(config["paths"]["output_dir"])
    temp_dir = resolve_config_path(config["paths"]["temp_dir"])
    
    os.makedirs(output_dir, exist_ok=True)
    os.makedirs(temp_dir, exist_ok=True)
    
    if not job_id:
        base_name = os.path.splitext(os.path.basename(input_file))[0]
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        job_id = f"{timestamp}_{base_name}"

    try:
        input_fingerprint = hash_file_contents(input_file)
    except OSError:
        input_fingerprint = hashlib.sha256(input_file.encode("utf-8")).hexdigest()
    config_fingerprint = _analysis_config_fingerprint(config)
    checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
    existing_state = _load_job_state(checkpoint_paths)
    resume_requested = bool(existing_state.get("resume_requested"))
    resume_mode = "fresh_start"
    resume_message = ""
    resume_fallback_reason = ""
    reused_chunk_count = 0
    reused_diarization = False
    seeded_source_metadata = {
        "source_file": existing_state.get("source_file") or os.path.basename(input_file),
        "source_filename": existing_state.get("source_filename", ""),
        "source_size": existing_state.get("source_size"),
        "source_last_modified": existing_state.get("source_last_modified"),
    }
    if existing_state and (
        existing_state.get("input_fingerprint") != input_fingerprint
        or existing_state.get("config_fingerprint") != config_fingerprint
    ):
        _reset_checkpoint_root_for_new_run(checkpoint_paths, preserve_upload_path=input_file)
        if resume_requested:
            resume_mode = "fallback_fresh_start"
            resume_message = "이전 분석 기록과 일치하지 않아 처음부터 다시 분석합니다."
            resume_fallback_reason = "fingerprint_mismatch"
        existing_state = {}
    ensure_job_checkpoint_dirs(checkpoint_paths)
    owner_run_id = datetime.now().strftime("%Y%m%d_%H%M%S_%f")
    created_at = existing_state.get("created_at", datetime.now().isoformat())
    _write_job_state(checkpoint_paths, {
        "job_id": job_id,
        **seeded_source_metadata,
        "created_at": created_at,
        "pipeline_version": ANALYSIS_PIPELINE_VERSION,
        "checkpoint_version": ANALYSIS_CHECKPOINT_VERSION,
        "config_fingerprint": config_fingerprint,
        "input_fingerprint": input_fingerprint,
        "owner_run_id": owner_run_id,
        "stage": "preprocessing",
        "chunk_count": 0,
        "completed_chunk_indices": [],
        "stt_completed": False,
        "diarization_completed": False,
        "summary_completed": False,
        "cancelled": False,
        "failed": False,
        "resume_supported": False,
        "cleanup_policy": "preserve_checkpoints",
        "last_heartbeat_at": datetime.now().isoformat(),
        "resume_mode": resume_mode,
        "resume_message": resume_message,
        "resume_fallback_reason": resume_fallback_reason,
    })
    current_stage = "preprocessing"

    def _set_stage(stage: str, **extra) -> None:
        nonlocal current_stage
        current_stage = stage
        _write_job_state(checkpoint_paths, {
            "stage": stage,
            "last_heartbeat_at": datetime.now().isoformat(),
            **extra,
        })

    def _report_progress(step: str, prog: int):
        _raise_if_cancelled()
        print(f"[{prog}%] {step}")
        _write_job_state(checkpoint_paths, {
            "stage": current_stage,
            "last_heartbeat_at": datetime.now().isoformat(),
            "last_progress": {
                "message": step,
                "progress": prog,
                "status": "processing",
            },
        })
        if progress_callback:
            progress_callback(step, prog)

    if resume_message:
        _report_progress(resume_message, 5)

    temp_wav_path = checkpoint_paths.source_wav_path
    out_json_path = os.path.join(output_dir, f"{job_id}_result.json")
    out_txt_path = os.path.join(output_dir, f"{job_id}_transcript.txt")
    out_md_path = os.path.join(output_dir, f"{job_id}_report.md")
    out_docx_path = os.path.join(output_dir, f"{job_id}_report.docx")
    out_hwpx_path = os.path.join(output_dir, f"{job_id}_report.hwpx")

    print(f"--- Local Meeting AI Pipeline ---")
    print(f"Input: {input_file}")
    _raise_if_cancelled()
    
    # 1. Convert to WAV
    _set_stage("preprocessing")
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
    _write_job_state(checkpoint_paths, {
        "preprocessing_applied": preprocessing_applied,
    })
    _raise_if_cancelled()
    
    # 2. STT (Transcribe)
    _set_stage("stt_preparing")
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
    chunk_dir = checkpoint_paths.chunks_dir
    chunks = (
        split_wav_by_duration(temp_wav_path, chunk_dir, long_chunk_seconds, ffmpeg_path)
        if enable_chunking
        else [{"path": temp_wav_path, "offset": 0.0, "duration": None, "index": 0}]
    )
    _write_job_state(checkpoint_paths, {
        "chunk_count": len(chunks),
        "long_chunk_seconds": long_chunk_seconds,
    })
    _raise_if_cancelled()

    stt_language = config["stt"].get("language", "ko")
    stt_device = config["stt"].get("device", "auto")
    stt_chunk_seconds = int(config["stt"].get("chunk_seconds", DEFAULT_STT_CHUNK_SECONDS))
    def _transcribe_chunks(chunks_to_process, model_path, allow_internal_fallback):
        nonlocal reused_chunk_count
        collected_segments = []
        total = len(chunks_to_process)
        execution_fingerprint = _stt_execution_fingerprint(model_path, stt_device, stt_chunk_seconds)
        _set_stage("transcribing")
        for idx, chunk in enumerate(chunks_to_process):
            _raise_if_cancelled()
            progress = 30 + int((idx / max(total, 1)) * 35)
            message = f"Transcribing chunk {idx + 1}/{total}..."
            _report_progress(message, progress)
            chunk_checkpoint_path = get_stt_chunk_checkpoint_path(checkpoint_paths, idx)
            checkpoint_payload = load_json_checkpoint(chunk_checkpoint_path) if os.path.exists(chunk_checkpoint_path) else None
            if (
                checkpoint_payload
                and checkpoint_payload.get("stt_execution_fingerprint") == execution_fingerprint
                and isinstance(checkpoint_payload.get("segments"), list)
            ):
                reused_chunk_count += 1
                collected_segments.extend(apply_time_offset(checkpoint_payload["segments"], float(chunk.get("offset", 0.0))))
                continue
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
                atomic_write_json(chunk_checkpoint_path, {
                    "chunk_index": idx,
                    "offset": float(chunk.get("offset", 0.0)),
                    "duration": chunk.get("duration"),
                    "stt_execution_fingerprint": execution_fingerprint,
                    "segments": chunk_segments,
                })
                state = _load_job_state(checkpoint_paths)
                completed_indices = sorted(set(int(item) for item in state.get("completed_chunk_indices", []) + [idx]))
                _write_job_state(checkpoint_paths, {
                    "completed_chunk_indices": completed_indices,
                    "resume_supported": True,
                })
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
        if os.path.isdir(checkpoint_paths.stt_dir):
            for child_name in os.listdir(checkpoint_paths.stt_dir):
                child_path = os.path.join(checkpoint_paths.stt_dir, child_name)
                if os.path.isfile(child_path):
                    try:
                        os.remove(child_path)
                    except FileNotFoundError:
                        pass
        _write_job_state(checkpoint_paths, {
            "completed_chunk_indices": [],
            "resume_supported": False,
        })
        reused_chunk_count = 0
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
    if resume_requested and reused_chunk_count > 0:
        resume_mode = "reused_stt"
        resume_message = "이전 음성 인식 진행분을 재사용했습니다."
    atomic_write_json(checkpoint_paths.stt_merged_path, {
        "segments": segments,
        "input_fingerprint": input_fingerprint,
        "config_fingerprint": config_fingerprint,
    })
    _write_job_state(checkpoint_paths, {
        "stage": "stt_completed",
        "stt_completed": True,
        "resume_supported": True,
        "completed_chunk_indices": list(range(len(chunks))),
        "resume_mode": resume_mode,
        "resume_message": resume_message,
        "resume_fallback_reason": resume_fallback_reason,
    })
    _report_progress("음성 인식이 완료되었습니다. 후처리를 준비하고 있습니다.", 65)
    raw_stt_segments = copy.deepcopy(segments)
    segments_fingerprint = _segment_fingerprint(segments)

    if not segments:
        print("[STT] No transcript segments were returned; skipping diarization and summary.")
        summary_data = {
            "overview": "음성 인식 결과가 없어 회의 요약을 만들지 못했습니다.",
        }
    else:
        summary_data = {}
    
    # 3. Diarization (Optional)
    if segments and config.get("diarization", {}).get("enabled", True):
        _set_stage("diarization")
        diarization_checkpoint = load_json_checkpoint(checkpoint_paths.diarization_segments_path)
        aligned_checkpoint = load_json_checkpoint(checkpoint_paths.aligned_segments_path)
        display_checkpoint = load_json_checkpoint(checkpoint_paths.display_segments_path)
        can_reuse_diarization = (
            resume_requested
            and bool(existing_state.get("diarization_completed"))
            and existing_state.get("pipeline_version") == ANALYSIS_PIPELINE_VERSION
            and existing_state.get("checkpoint_version") == ANALYSIS_CHECKPOINT_VERSION
            and isinstance(diarization_checkpoint, dict)
            and isinstance(aligned_checkpoint, dict)
            and isinstance(display_checkpoint, dict)
            and diarization_checkpoint.get("input_fingerprint") == input_fingerprint
            and diarization_checkpoint.get("config_fingerprint") == config_fingerprint
            and diarization_checkpoint.get("segments_fingerprint") == segments_fingerprint
            and aligned_checkpoint.get("input_fingerprint") == input_fingerprint
            and aligned_checkpoint.get("config_fingerprint") == config_fingerprint
            and aligned_checkpoint.get("segments_fingerprint") == segments_fingerprint
            and display_checkpoint.get("input_fingerprint") == input_fingerprint
            and display_checkpoint.get("config_fingerprint") == config_fingerprint
            and display_checkpoint.get("segments_fingerprint") == segments_fingerprint
            and isinstance(aligned_checkpoint.get("segments"), list)
            and isinstance(display_checkpoint.get("segments"), list)
        )

        if can_reuse_diarization:
            _report_progress("이전 화자 구분 결과를 재사용합니다.", 70)
            segments = aligned_checkpoint["segments"]
            reused_diarization = True
            _write_job_state(checkpoint_paths, {
                "diarization_completed": True,
                "resume_supported": True,
            })
            aligned_segments = copy.deepcopy(segments)
            display_segments = display_checkpoint["segments"]
        else:
            _report_progress("Speaker Diarization & Alignment...", 70)
            _raise_if_cancelled()
            diarize_model_path = config["paths"]["diarization_model"]
            if diarize_model_path and diarize_model_path.startswith((".", "..")):
                diarize_model_path = os.path.normpath(os.path.join(BASE_DIR, diarize_model_path))
            min_spk = config["diarization"].get("min_speakers")
            max_spk = config["diarization"].get("max_speakers")

            spk_segments = diarize_audio(temp_wav_path, diarize_model_path, min_spk, max_spk)
            atomic_write_json(checkpoint_paths.diarization_segments_path, {
                "speaker_segments": spk_segments,
                "input_fingerprint": input_fingerprint,
                "config_fingerprint": config_fingerprint,
                "segments_fingerprint": segments_fingerprint,
            })
            _raise_if_cancelled()
            _report_progress("화자 구간 분석 완료. 문장 시간과 맞추는 중", 78)
            segments = align_segments_with_speakers(segments, spk_segments)
            _write_job_state(checkpoint_paths, {
                "diarization_completed": True,
                "resume_supported": True,
            })
            aligned_segments = copy.deepcopy(segments)
            display_segments = build_display_segments(segments)
    else:
        aligned_segments = copy.deepcopy(segments)
        display_segments = build_display_segments(segments)
    atomic_write_json(checkpoint_paths.aligned_segments_path, {
        "segments": aligned_segments,
        "input_fingerprint": input_fingerprint,
        "config_fingerprint": config_fingerprint,
        "segments_fingerprint": segments_fingerprint,
    })
    atomic_write_json(checkpoint_paths.display_segments_path, {
        "segments": display_segments,
        "input_fingerprint": input_fingerprint,
        "config_fingerprint": config_fingerprint,
        "segments_fingerprint": segments_fingerprint,
    })
    
    # 4. Summary (Optional)
    if segments and config.get("summary", {}).get("enabled", True):
        _set_stage("summary")
        _report_progress("Summarizing with Local LLM...", 85)
        _raise_if_cancelled()
        llm_model = config["summary"].get("model", "gemma-4b")
        if llm_model and llm_model.startswith((".", "..")):
            llm_model = os.path.normpath(os.path.join(BASE_DIR, llm_model))
        summary_data = summarize_meeting(segments, model_name_or_path=llm_model)
        _raise_if_cancelled()
    if summary_data:
        _ensure_generation_status(summary_data)
    
    # 5. Save Results
    _set_stage("saving_results")
    _report_progress("Saving results...", 95)
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
        "raw_stt_segments": raw_stt_segments,
        "aligned_segments": aligned_segments,
        "display_segments": display_segments,
        "summary": summary_data
    }
    
    save_result_json(result_data, out_json_path)
    export_txt(get_transcript_segments(result_data), out_txt_path)
    
    if summary_data:
        export_markdown(result_data, out_md_path)
        export_docx(result_data, out_docx_path)
        export_hwpx(result_data, out_hwpx_path)
    
    if reused_diarization:
        if reused_chunk_count > 0:
            resume_mode = "reused_stt_and_diarization"
            resume_message = "이전 음성 인식 진행분과 화자 구분 결과를 재사용했습니다."
        else:
            resume_mode = "reused_diarization"
            resume_message = "이전 화자 구분 결과를 재사용했습니다."

    # Cleanup temp wav
    _write_job_state(checkpoint_paths, {
        "stage": "completed",
        "summary_completed": bool(summary_data),
        "diarization_completed": bool(config.get("diarization", {}).get("enabled", True) and segments),
        "resume_supported": True,
        "resume_mode": resume_mode,
        "resume_message": resume_message,
        "resume_fallback_reason": resume_fallback_reason,
    })

    if config["privacy"].get("auto_delete_temp_audio", True):
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
        "result_data": result_data,
        "resume": {
            "requested": resume_requested,
            "mode": resume_mode,
            "message": resume_message,
            "fallback_reason": resume_fallback_reason or None,
            "reused_chunk_count": reused_chunk_count,
        },
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
