import argparse
import asyncio
import copy
import hashlib
import os
import json
import logging
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import zipfile
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator
from xml.etree import ElementTree

from fastapi import Body, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, Response, StreamingResponse

from analysis_jobs import AnalysisCancelledError, AnalysisJobRegistry
from config_normalization import (
    DEFAULT_LONG_AUDIO_CHUNK_SECONDS,
    DEFAULT_SUMMARY_MODEL,
    DEFAULT_STT_CHUNK_SECONDS,
    add_summary_user_model,
    get_summary_candidate_models,
    get_summary_model_options,
    get_summary_option_models,
    normalize_summary_model_name,
    normalize_app_config,
    remove_summary_user_model,
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
from model_manager import (
    get_model_status,
    model_exists,
    get_model_spec,
    normalize_windows_path,
    ollama_model_exists,
    resolve_model_path,
)
from ollama_utils import ensure_ollama_server_running, find_ollama_executable, ollama_executable_available, ollama_subprocess_env
from pipeline.transcribe import get_stt_device_status
from process_utils import hidden_subprocess_kwargs
from storage_preflight import build_analysis_storage_preflight

BASE_DIR = os.path.abspath(
    os.environ.get(
        "MEETING_AI_BACKEND_DIR",
        getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))),
    )
)
BASE_DIR = normalize_windows_path(BASE_DIR)

app = FastAPI(title="NIFS AI Meeting API")

ANALYSIS_JOBS = AnalysisJobRegistry()
GENERATION_STATUS_LOCK = threading.RLock()
OLLAMA_PULL_STATUS_LOCK = threading.RLock()
MODEL_DOWNLOAD_STATUS_LOCK = threading.RLock()
CONFIG_LOCK = threading.RLock()
JOB_STATE_LOCKS_LOCK = threading.Lock()
JOB_STATE_LOCKS: dict[str, threading.RLock] = {}
ACTIVE_GENERATIONS: set[tuple[str, str]] = set()
GENERATION_PROGRESS: dict[tuple[str, str], dict] = {}
GENERATION_STOP_REQUESTS: dict[tuple[str, str], dict] = {}
OLLAMA_PULL_STATUS: dict[str, dict] = {}
OLLAMA_PULL_PROCESSES: dict[str, subprocess.Popen] = {}
MODEL_DOWNLOAD_STATUS: dict[str, dict] = {}
MODEL_DOWNLOAD_EXPECTED_BYTES = {
    "stt_faster_whisper": 3_090_839_274,
}
MODEL_DOWNLOAD_FREE_SPACE_BUFFER_BYTES = 512 * 1024 * 1024
SUPPORT_EMAIL_WORK = "ecomarine@korea.kr"
SUPPORT_EMAIL_PERSONAL = "ecomarin@naver.com"
SUPPORT_EMAIL_PERSONAL_FROM = datetime(2027, 4, 1).date()
ANALYSIS_HEARTBEAT_SECONDS = 15
ANALYSIS_STALL_ERROR_SECONDS = 180
ANALYSIS_STALL_ERROR_SECONDS_PREPROCESS = 600
ANALYSIS_STALL_ERROR_SECONDS_PREPARE = 300
ANALYSIS_STALL_ERROR_SECONDS_TRANSCRIBE = 600
GENERATION_PROGRESS_TTL_SECONDS = 60 * 60
GENERATION_PROGRESS_MAX_ENTRIES = 128
DETAIL_SUMMARY_INPUT_CHANGED = "summary_input_changed"
DETAIL_TOPIC_INPUT_CHANGED = "topic_input_changed"
DETAIL_SPEAKER_INPUT_CHANGED = "speaker_input_changed"
DETAIL_TOPIC_EMPTY_RESULT = "topic_generation_empty"
DETAIL_SPEAKER_EMPTY_RESULT = "speaker_context_generation_empty"
DETAIL_DIARIZATION_RUNTIME_ERROR = "diarization_runtime_error"
DETAIL_DIARIZATION_CANCELLED = "diarization_cancelled"
DETAIL_DIARIZATION_DEFERRED = "diarization_deferred"
GENERIC_SINGLE_TOPIC_TITLES = {"핵심 주제", "주요 주제", "전체 요약", "회의 요약", "전체 대화"}
ANALYSIS_CHECKPOINT_VERSION = 1
ANALYSIS_PIPELINE_VERSION = "2026-05-13-long-file-v1"
MAX_EXPORT_STEM_CHARS = 96
HWPX_REQUIRED_ENTRIES = {
    "mimetype",
    "META-INF/container.xml",
    "META-INF/manifest.xml",
    "version.xml",
    "Contents/content.hpf",
    "Contents/header.xml",
    "Contents/section0.xml",
    "settings.xml",
    "Preview/PrvText.txt",
}
DIARIZATION_WAVEFORM_SAMPLE_RATE = 16000
DIARIZATION_WAVEFORM_CHANNELS = 1
DIARIZATION_WAVEFORM_BYTES_PER_SAMPLE = 4
SUMMARY_4B_MEMORY_THRESHOLD_GB = 15.5
RECOVERABLE_SOURCE_EXTENSIONS = {
    ".aac",
    ".avi",
    ".flac",
    ".m4a",
    ".mkv",
    ".mov",
    ".mp3",
    ".mp4",
    ".ogg",
    ".wav",
    ".webm",
    ".wma",
}
AUDIO_EXTRACT_SOURCE_EXTENSIONS = RECOVERABLE_SOURCE_EXTENSIONS

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
    })


def _analysis_legacy_config_fingerprint(config: dict) -> str:
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


def _analysis_prepared_legacy_config(config: dict) -> dict:
    prepared = copy.deepcopy(config)
    prepared.setdefault("stt", {})["selected_model"] = "faster-whisper-large-v3"
    try:
        stt_spec = get_model_spec("stt_faster_whisper")
        prepared.setdefault("paths", {})["stt_model"] = resolve_model_path(BASE_DIR, stt_spec)
    except Exception:
        pass
    try:
        diarization_spec = get_model_spec("diarization")
        if model_exists(BASE_DIR, diarization_spec):
            prepared.setdefault("paths", {})["diarization_model"] = resolve_model_path(BASE_DIR, diarization_spec)
    except Exception:
        pass
    return prepared


def _analysis_compatible_config_fingerprints(config: dict) -> set[str]:
    prepared_legacy = _analysis_prepared_legacy_config(config)
    return {
        _analysis_config_fingerprint(config),
        _analysis_legacy_config_fingerprint(config),
        _analysis_legacy_config_fingerprint(prepared_legacy),
    }


def _load_job_state(paths) -> dict:
    try:
        return load_json_checkpoint(paths.state_path) or {}
    except CorruptCheckpointError:
        return {}


def _write_job_state(paths, payload: dict) -> dict:
    state_path = os.path.abspath(paths.state_path)
    with JOB_STATE_LOCKS_LOCK:
        lock = JOB_STATE_LOCKS.setdefault(state_path, threading.RLock())
    with lock:
        current = _load_job_state(paths)
        merged = {
            **current,
            **payload,
            "updated_at": datetime.now().isoformat(),
        }
        atomic_write_json(paths.state_path, merged)
        return merged


def _estimate_diarization_waveform_mb(duration_seconds: float) -> float:
    if duration_seconds <= 0:
        return 0.0
    bytes_count = (
        duration_seconds
        * DIARIZATION_WAVEFORM_SAMPLE_RATE
        * DIARIZATION_WAVEFORM_CHANNELS
        * DIARIZATION_WAVEFORM_BYTES_PER_SAMPLE
    )
    return bytes_count / (1024 * 1024)


def _diarization_resource_decision(config: dict, source_wav_duration: float, requested_override: bool | None = None) -> dict:
    diarization_config = config.get("diarization", {})
    requested = bool(diarization_config.get("enabled", True)) if requested_override is None else bool(requested_override)
    max_duration = int(diarization_config.get("max_duration_seconds") or 0)
    max_waveform_mb = int(diarization_config.get("max_waveform_mb") or 0)
    estimated_waveform_mb = _estimate_diarization_waveform_mb(source_wav_duration)
    decision = {
        "requested": requested,
        "run": requested,
        "skipped": False,
        "skip_reason": "",
        "skip_message": "",
        "duration_seconds": float(source_wav_duration or 0.0),
        "estimated_waveform_mb": round(estimated_waveform_mb, 1),
        "max_duration_seconds": max_duration,
        "max_waveform_mb": max_waveform_mb,
    }
    if not requested:
        decision["run"] = False
        return decision
    if not diarization_config.get("auto_skip_long_audio", True):
        return decision
    if max_duration > 0 and source_wav_duration > max_duration:
        decision.update({
            "run": False,
            "skipped": True,
            "skip_reason": "duration_limit",
            "skip_message": "긴 음성 파일이라 참석자 구분은 제외하고 대화록을 먼저 저장했습니다.",
        })
        return decision
    if max_waveform_mb > 0 and estimated_waveform_mb > max_waveform_mb:
        decision.update({
            "run": False,
            "skipped": True,
            "skip_reason": "memory_limit",
            "skip_message": "음성 파일이 커서 참석자 구분은 제외하고 대화록을 먼저 저장했습니다.",
        })
    return decision


def _defer_diarization_decision(decision: dict) -> dict:
    deferred = {**decision}
    deferred.update({
        "run": False,
        "skipped": False,
        "deferred": True,
        "defer_reason": "manual",
        "defer_message": "참석자 구분은 회의 기록에서 별도로 실행할 수 있습니다.",
    })
    return deferred


def _source_not_preserved_diarization_decision(decision: dict) -> dict:
    skipped = {**decision}
    skipped.update({
        "run": False,
        "skipped": True,
        "deferred": False,
        "skip_reason": "source_not_preserved",
        "skip_message": "음성 파일 보존 설정이 꺼져 있어 참석자 구분은 별도로 실행할 수 없습니다. 필요하면 다시 분석해 주세요.",
        "defer_reason": "",
        "defer_message": "",
    })
    return skipped


def _failed_diarization_decision(decision: dict, message: str | None = None) -> dict:
    failed = {**decision}
    failed.update({
        "run": False,
        "skipped": True,
        "deferred": False,
        "skip_reason": "runtime_error",
        "skip_message": message or "참석자 구분 중 문제가 있어 회의록만 저장했습니다. 결과 화면에서 다시 실행할 수 있습니다.",
        "defer_reason": "",
        "defer_message": "",
    })
    return failed


def _can_defer_diarization_for_later(config: dict) -> bool:
    privacy_config = config.get("privacy", {})
    return bool(
        privacy_config.get("preserve_extracted_audio", False)
        or privacy_config.get("save_original_audio_copy", False)
    )


def _should_generate_diarization_during_analysis(config: dict) -> bool:
    diarization_config = config.get("diarization", {})
    return bool(diarization_config.get("generate_during_analysis", False))


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
            "transcript_ready": bool(progress_payload.get("transcript_ready") or state.get("transcript_ready")),
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
    compatible_config_fingerprints = _analysis_compatible_config_fingerprints(config)
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
        if state.get("config_fingerprint") not in compatible_config_fingerprints:
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
        status = "stopped" if state.get("cancel_action") == "stop" else "cancelled"
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
            "transcript_ready": bool(progress_payload.get("transcript_ready") or state.get("transcript_ready")),
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
    with CONFIG_LOCK:
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
            target = config.setdefault("diarization", {})
            if "enabled" in diarization:
                target["enabled"] = bool(diarization["enabled"])
            if "generate_during_analysis" in diarization:
                target["generate_during_analysis"] = bool(diarization["generate_during_analysis"])

        if "stt" in payload:
            stt = payload["stt"] or {}
            config.setdefault("stt", {})["selected_model"] = "faster-whisper-large-v3"
            if "device" in stt:
                device = str(stt["device"])
                if device not in {"cpu", "cuda"}:
                    raise HTTPException(status_code=400, detail="stt.device must be cpu or cuda")
                config.setdefault("stt", {})["device"] = device

        if "summary" in payload:
            summary = payload["summary"] or {}
            target = config.setdefault("summary", {})
            if "provider" in summary:
                provider = str(summary["provider"]).strip().lower()
                if provider not in {"ollama"}:
                    raise HTTPException(status_code=400, detail="summary.provider must be ollama")
                target["provider"] = provider
            if "model" in summary:
                model = _validate_ollama_model_name(str(summary["model"]))
                target["model"] = model
                add_summary_user_model(config, model)

        if "privacy" in payload:
            privacy = payload["privacy"] or {}
            privacy_config = config.setdefault("privacy", {})
            if "preserve_extracted_audio" in privacy:
                privacy_config["preserve_extracted_audio"] = bool(privacy["preserve_extracted_audio"])
            if "auto_save_hwpx_copy" in privacy:
                privacy_config["auto_save_hwpx_copy"] = bool(privacy["auto_save_hwpx_copy"])
            if "auto_save_audio_copy" in privacy:
                privacy_config["auto_save_audio_copy"] = bool(privacy["auto_save_audio_copy"])
            if not privacy_config.get("preserve_extracted_audio", True):
                privacy_config["auto_save_audio_copy"] = False

        save_config(config)
    return await get_settings()


@app.get("/api/models/status")
async def models_status() -> dict:
    try:
        config = load_config()
        status = get_model_status(BASE_DIR, config)
        selected_stt = "faster-whisper-large-v3"
        selected_device = config.get("stt", {}).get("device", "cpu")
        diarization_enabled = bool(config.get("diarization", {}).get("enabled", False))
        diarization_during_analysis = bool(config.get("diarization", {}).get("generate_during_analysis", False))
        summary_readiness = _summary_model_readiness(config)
        stt_device_status = get_stt_device_status()
        memory_gb = _system_memory_gb()
        required_stt_keys = {"stt_faster_whisper"}
        for model in status.get("models", []):
            key = model.get("key")
            if key == "stt_faster_whisper":
                model["required"] = key in required_stt_keys
            elif key == "diarization":
                model["required"] = diarization_during_analysis
        required_models = [model for model in status.get("models", []) if model.get("required")]
        status["ready"] = all(model.get("installed") for model in required_models)
        status["selected_stt_model"] = selected_stt
        status["selected_stt_device"] = selected_device
        status["diarization_enabled"] = diarization_enabled
        status["diarization_generate_during_analysis"] = diarization_during_analysis
        status["summary_ready"] = bool(summary_readiness.get("ready"))
        status["summary_status"] = summary_readiness.get("status")
        status["summary_message"] = summary_readiness.get("message", "")
        status["system_profile"] = {"memory_gb": memory_gb}
        status["summary_model_recommendation"] = _summary_model_recommendation(config, memory_gb)
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


def _system_memory_gb() -> float | None:
    try:
        if sys.platform.startswith("win"):
            import ctypes

            class MemoryStatusEx(ctypes.Structure):
                _fields_ = [
                    ("dwLength", ctypes.c_ulong),
                    ("dwMemoryLoad", ctypes.c_ulong),
                    ("ullTotalPhys", ctypes.c_ulonglong),
                    ("ullAvailPhys", ctypes.c_ulonglong),
                    ("ullTotalPageFile", ctypes.c_ulonglong),
                    ("ullAvailPageFile", ctypes.c_ulonglong),
                    ("ullTotalVirtual", ctypes.c_ulonglong),
                    ("ullAvailVirtual", ctypes.c_ulonglong),
                    ("sullAvailExtendedVirtual", ctypes.c_ulonglong),
                ]

            status = MemoryStatusEx()
            status.dwLength = ctypes.sizeof(MemoryStatusEx)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
                return round(status.ullTotalPhys / (1024 ** 3), 1)
            return None
        if hasattr(os, "sysconf"):
            pages = os.sysconf("SC_PHYS_PAGES")
            page_size = os.sysconf("SC_PAGE_SIZE")
            return round((pages * page_size) / (1024 ** 3), 1)
    except Exception:
        return None
    return None


def _summary_model_recommendation(config: dict, memory_gb: float | None) -> dict:
    option_models = [
        option.get("model", "")
        for option in get_summary_model_options(config)
        if option.get("model")
    ]
    if "gemma4:e4b" in option_models and memory_gb is not None and memory_gb >= SUMMARY_4B_MEMORY_THRESHOLD_GB:
        memory_label = f"약 {round(memory_gb):g}GB"
        return {
            "model": "gemma4:e4b",
            "basis": "memory",
            "message": f"이 PC 메모리는 {memory_label}입니다. 4B를 권장합니다. 속도나 저장 공간이 걱정되면 2B를 선택하세요.",
        }

    fallback_model = DEFAULT_SUMMARY_MODEL if DEFAULT_SUMMARY_MODEL in option_models else (option_models[0] if option_models else DEFAULT_SUMMARY_MODEL)
    message = (
        "PC 메모리를 확인하지 못해 가벼운 2B 모델을 권장합니다."
        if memory_gb is None
        else f"이 PC 메모리는 약 {round(memory_gb):g}GB입니다. 2B를 권장합니다. 여유가 충분하면 4B도 선택할 수 있습니다."
    )
    return {
        "model": fallback_model,
        "basis": "memory",
        "message": message,
    }


def _validate_ollama_model_name(model_name: str) -> str:
    model_name = normalize_summary_model_name(model_name)
    if not model_name:
        raise HTTPException(status_code=400, detail="model is required")
    if model_name.startswith("-") or any(character.isspace() for character in model_name):
        raise HTTPException(status_code=400, detail="model must be a valid Ollama model name")
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}", model_name):
        raise HTTPException(status_code=400, detail="model must be a valid Ollama model name")
    return model_name


DOWNLOADABLE_MODEL_KEYS = {"stt_faster_whisper"}


def _validate_downloadable_model_key(model_key: str) -> str:
    model_key = (model_key or "").strip()
    if model_key not in DOWNLOADABLE_MODEL_KEYS:
        raise HTTPException(status_code=400, detail="이 모델은 앱에서 직접 받을 수 없습니다.")
    spec = get_model_spec(model_key)
    if spec.gated or spec.requires_token or not spec.repo_id:
        raise HTTPException(status_code=400, detail="이 모델은 관리자가 직접 준비해야 합니다.")
    return model_key


def _directory_size_bytes(path: str) -> int:
    root = Path(path)
    if not root.exists():
        return 0
    if root.is_file():
        try:
            return root.stat().st_size
        except OSError:
            return 0
    total = 0
    for child in root.rglob("*"):
        if not child.is_file():
            continue
        try:
            total += child.stat().st_size
        except OSError:
            continue
    return total


def _parse_iso_datetime(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _model_download_progress(model_key: str, target_path: str, started_at: str | None, active: bool) -> dict:
    expected_bytes = MODEL_DOWNLOAD_EXPECTED_BYTES.get(model_key, 0)
    downloaded_bytes = _directory_size_bytes(target_path) if target_path else 0
    progress_percent = None
    eta_seconds = None
    if expected_bytes > 0:
        capped_bytes = min(downloaded_bytes, expected_bytes)
        progress_percent = round((capped_bytes / expected_bytes) * 100, 1)
        if active and progress_percent >= 100:
            progress_percent = 99.9
        started = _parse_iso_datetime(started_at)
        if active and started and downloaded_bytes > 0:
            elapsed_seconds = max((datetime.now() - started).total_seconds(), 1)
            bytes_per_second = downloaded_bytes / elapsed_seconds
            remaining_bytes = max(expected_bytes - downloaded_bytes, 0)
            if bytes_per_second > 0 and remaining_bytes > 0:
                eta_seconds = int(remaining_bytes / bytes_per_second)
    return {
        "downloaded_bytes": downloaded_bytes,
        "expected_bytes": expected_bytes,
        "progress_percent": progress_percent,
        "eta_seconds": eta_seconds,
    }


def _model_download_snapshot(model_key: str) -> dict:
    with MODEL_DOWNLOAD_STATUS_LOCK:
        status = dict(MODEL_DOWNLOAD_STATUS.get(model_key) or {})
    if status:
        status.update(_model_download_progress(
            model_key,
            str(status.get("target_path") or ""),
            str(status.get("started_at") or ""),
            bool(status.get("active")),
        ))
        return status
    return {
        "key": model_key,
        "active": False,
        "status": "idle",
        "message": "",
        "target_path": "",
        "started_at": "",
        "updated_at": "",
        "error": "",
        "downloaded_bytes": 0,
        "expected_bytes": MODEL_DOWNLOAD_EXPECTED_BYTES.get(model_key, 0),
        "progress_percent": None,
        "eta_seconds": None,
    }


def _set_model_download_status(model_key: str, **updates) -> dict:
    now = datetime.now().isoformat()
    with MODEL_DOWNLOAD_STATUS_LOCK:
        current = dict(MODEL_DOWNLOAD_STATUS.get(model_key) or {"key": model_key})
        current.update(updates)
        current["key"] = model_key
        current["updated_at"] = now
        MODEL_DOWNLOAD_STATUS[model_key] = current
        return dict(current)


def _model_download_cancel_requested(model_key: str) -> bool:
    with MODEL_DOWNLOAD_STATUS_LOCK:
        current = dict(MODEL_DOWNLOAD_STATUS.get(model_key) or {})
    return bool(current.get("cancel_requested"))


def _mark_model_download_cancelled(model_key: str, target_path: str, message: str = "모델 받기를 중지했습니다.") -> dict:
    return _set_model_download_status(
        model_key,
        active=False,
        status="cancelled",
        message=message,
        target_path=target_path,
        error="",
        cancel_requested=False,
    )


def _request_model_download_stop(model_key: str) -> dict:
    model_key = _validate_downloadable_model_key(model_key)
    with MODEL_DOWNLOAD_STATUS_LOCK:
        current = dict(MODEL_DOWNLOAD_STATUS.get(model_key) or {})
        if not current.get("active"):
            return _model_download_snapshot(model_key)
        current.update({
            "active": True,
            "status": "cancelling",
            "message": "모델 받기를 중지하고 있습니다. 진행 중인 파일 작업이 끝나면 멈춥니다.",
            "cancel_requested": True,
            "updated_at": datetime.now().isoformat(),
        })
        MODEL_DOWNLOAD_STATUS[model_key] = current
    return _model_download_snapshot(model_key)


def _download_huggingface_snapshot(repo_id: str, target_dir: str) -> None:
    from huggingface_hub import snapshot_download

    snapshot_download(
        repo_id=repo_id,
        local_dir=target_dir,
    )


def _support_contact_email(now: datetime | None = None) -> str:
    today = (now or datetime.now()).date()
    if today < SUPPORT_EMAIL_PERSONAL_FROM:
        return SUPPORT_EMAIL_WORK
    return SUPPORT_EMAIL_PERSONAL


def _download_blocked_message(subject: str, recovery_action: str) -> str:
    contact_email = _support_contact_email()
    return (
        f"{subject} 받지 못했습니다. 회사 보안 정책 또는 인터넷 연결 문제일 수 있습니다. "
        f"사내망에서 계속 막히면 담당자에게 {recovery_action} 요청해 주세요. "
        f"계속 실패하면 {contact_email}으로 문의해 주세요."
    )


def _model_download_preflight(model_key: str, target_path: str) -> str:
    target = Path(target_path)
    try:
        target.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        return f"모델을 저장할 폴더를 만들지 못했습니다. 저장 위치 권한을 확인해 주세요: {exc}"

    probe_path: Path | None = None
    try:
        with tempfile.NamedTemporaryFile(prefix=".download-check-", dir=target, delete=False) as handle:
            probe_path = Path(handle.name)
            handle.write(b"ok")
    except OSError as exc:
        return f"모델 폴더에 파일을 쓸 수 없습니다. 저장 위치 권한을 확인해 주세요: {exc}"
    finally:
        if probe_path:
            try:
                probe_path.unlink(missing_ok=True)
            except OSError:
                pass

    expected_bytes = MODEL_DOWNLOAD_EXPECTED_BYTES.get(model_key, 0)
    if expected_bytes <= 0:
        return ""

    try:
        required_free_bytes = expected_bytes + MODEL_DOWNLOAD_FREE_SPACE_BUFFER_BYTES
        free_bytes = shutil.disk_usage(str(target)).free
    except OSError:
        return ""

    if free_bytes < required_free_bytes:
        required_gb = required_free_bytes / (1024 ** 3)
        free_gb = free_bytes / (1024 ** 3)
        return f"저장 공간이 부족합니다. 모델을 받으려면 약 {required_gb:.1f}GB가 필요하고, 현재 여유 공간은 약 {free_gb:.1f}GB입니다."
    return ""


def _run_model_download(model_key: str) -> None:
    spec = get_model_spec(model_key)
    target_path = resolve_model_path(BASE_DIR, spec)
    if _model_download_cancel_requested(model_key):
        _mark_model_download_cancelled(model_key, target_path)
        return
    _set_model_download_status(
        model_key,
        active=True,
        status="running",
        message=f"{spec.label} 모델을 받는 중입니다. 용량이 커서 시간이 오래 걸릴 수 있습니다.",
        target_path=target_path,
        started_at=datetime.now().isoformat(),
        error="",
        cancel_requested=False,
    )
    try:
        Path(target_path).mkdir(parents=True, exist_ok=True)
        if _model_download_cancel_requested(model_key):
            _mark_model_download_cancelled(model_key, target_path)
            return
        _download_huggingface_snapshot(str(spec.repo_id), target_path)
        if _model_download_cancel_requested(model_key):
            _mark_model_download_cancelled(model_key, target_path)
            return
        if not model_exists(BASE_DIR, spec):
            raise RuntimeError("Downloaded files did not include the required model markers.")
        _set_model_download_status(
            model_key,
            active=False,
            status="completed",
            message=f"{spec.label} 모델 받기가 완료되었습니다.",
            target_path=target_path,
            error="",
            cancel_requested=False,
        )
    except Exception as exc:
        if _model_download_cancel_requested(model_key):
            _mark_model_download_cancelled(model_key, target_path)
            return
        logging.exception("Failed to download model %s", model_key)
        _set_model_download_status(
            model_key,
            active=False,
            status="failed",
            message=_download_blocked_message(f"{spec.label} 모델을", "모델 파일 준비를"),
            target_path=target_path,
            error=str(exc),
            cancel_requested=False,
        )


def _start_model_download(model_key: str) -> dict:
    model_key = _validate_downloadable_model_key(model_key)
    spec = get_model_spec(model_key)
    target_path = resolve_model_path(BASE_DIR, spec)

    with MODEL_DOWNLOAD_STATUS_LOCK:
        current = dict(MODEL_DOWNLOAD_STATUS.get(model_key) or {})
        if current.get("active"):
            return _model_download_snapshot(model_key)

    if model_exists(BASE_DIR, spec):
        _set_model_download_status(
            model_key,
            active=False,
            status="completed",
            message=f"{spec.label} 모델이 이미 준비되어 있습니다.",
            target_path=target_path,
            started_at=datetime.now().isoformat(),
            error="",
            cancel_requested=False,
        )
        return _model_download_snapshot(model_key)

    preflight_error = _model_download_preflight(model_key, target_path)
    if preflight_error:
        _set_model_download_status(
            model_key,
            active=False,
            status="failed",
            message=preflight_error,
            target_path=target_path,
            started_at=datetime.now().isoformat(),
            error=preflight_error,
            cancel_requested=False,
        )
        return _model_download_snapshot(model_key)

    with MODEL_DOWNLOAD_STATUS_LOCK:
        current = dict(MODEL_DOWNLOAD_STATUS.get(model_key) or {})
        if current.get("active"):
            return _model_download_snapshot(model_key)
        MODEL_DOWNLOAD_STATUS[model_key] = {
            "key": model_key,
            "active": True,
            "status": "starting",
            "message": "",
            "target_path": target_path,
            "started_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
            "error": "",
            "cancel_requested": False,
        }

    worker = threading.Thread(target=_run_model_download, args=(model_key,), daemon=True)
    worker.start()
    return _model_download_snapshot(model_key)


def _ollama_executable_available() -> bool:
    return ollama_executable_available()


def _ollama_pull_snapshot(model_name: str) -> dict:
    with OLLAMA_PULL_STATUS_LOCK:
        status = dict(OLLAMA_PULL_STATUS.get(model_name) or {})
    if status:
        return status
    return {
        "model": model_name,
        "active": False,
        "status": "idle",
        "message": "",
        "started_at": "",
        "updated_at": "",
        "exit_code": None,
        "progress_percent": None,
        "eta_seconds": None,
    }


def _set_ollama_pull_status(model_name: str, **updates) -> dict:
    now = datetime.now().isoformat()
    with OLLAMA_PULL_STATUS_LOCK:
        current = dict(OLLAMA_PULL_STATUS.get(model_name) or {"model": model_name})
        current.update(updates)
        current["model"] = model_name
        current["updated_at"] = now
        OLLAMA_PULL_STATUS[model_name] = current
        return dict(current)


def _ollama_pull_cancel_requested(model_name: str) -> bool:
    with OLLAMA_PULL_STATUS_LOCK:
        current = dict(OLLAMA_PULL_STATUS.get(model_name) or {})
    return bool(current.get("cancel_requested"))


def _parse_ollama_progress_percent(text: str) -> float | None:
    matches = re.findall(r"(\d+(?:\.\d+)?)\s*%", text or "")
    if not matches:
        return None
    try:
        return max(0.0, min(100.0, float(matches[-1])))
    except ValueError:
        return None


def _estimate_pull_eta_seconds(started_at: str | None, progress_percent: float | None) -> int | None:
    if progress_percent is None or progress_percent <= 0 or progress_percent >= 100:
        return None
    started = _parse_iso_datetime(started_at)
    if not started:
        return None
    elapsed_seconds = max((datetime.now() - started).total_seconds(), 1)
    estimated_total_seconds = elapsed_seconds / (progress_percent / 100)
    remaining_seconds = max(estimated_total_seconds - elapsed_seconds, 0)
    return int(remaining_seconds) if remaining_seconds > 0 else None


def _update_ollama_pull_progress_from_output(model_name: str, text: str) -> None:
    progress_percent = _parse_ollama_progress_percent(text)
    if progress_percent is None:
        return
    with OLLAMA_PULL_STATUS_LOCK:
        current = dict(OLLAMA_PULL_STATUS.get(model_name) or {})
    eta_seconds = _estimate_pull_eta_seconds(str(current.get("started_at") or ""), progress_percent)
    _set_ollama_pull_status(
        model_name,
        progress_percent=round(progress_percent, 1),
        eta_seconds=eta_seconds,
    )


def _read_process_output(pipe, output_queue: "queue.Queue[str]") -> None:
    try:
        while True:
            chunk = pipe.read(1)
            if not chunk:
                break
            output_queue.put(chunk)
    finally:
        try:
            pipe.close()
        except Exception:
            pass


def _request_ollama_pull_stop(model_name: str) -> dict:
    model_name = _validate_ollama_model_name(model_name)
    process = None
    with OLLAMA_PULL_STATUS_LOCK:
        current = dict(OLLAMA_PULL_STATUS.get(model_name) or {})
        if not current.get("active"):
            return _ollama_pull_snapshot(model_name)
        current.update({
            "active": True,
            "status": "cancelling",
            "message": f"{model_name} 모델 받기를 중지하고 있습니다.",
            "cancel_requested": True,
            "updated_at": datetime.now().isoformat(),
        })
        OLLAMA_PULL_STATUS[model_name] = current
        process = OLLAMA_PULL_PROCESSES.get(model_name)
    if process and process.poll() is None:
        try:
            process.terminate()
        except Exception:
            logging.exception("Failed to terminate Ollama pull process for %s", model_name)
    return _ollama_pull_snapshot(model_name)


def _remember_summary_model(model_name: str, *, managed_by_app: bool = False) -> None:
    with CONFIG_LOCK:
        config = load_config()
        add_summary_user_model(config, model_name, managed_by_app=managed_by_app)
        save_config(config)


def _run_ollama_pull(model_name: str) -> None:
    started_at = datetime.now().isoformat()
    with OLLAMA_PULL_STATUS_LOCK:
        current = dict(OLLAMA_PULL_STATUS.get(model_name) or {"model": model_name})
        if current.get("cancel_requested"):
            current.update({
                "model": model_name,
                "active": False,
                "status": "cancelled",
                "message": f"{model_name} 모델 받기를 중지했습니다.",
                "started_at": current.get("started_at") or started_at,
                "updated_at": started_at,
                "exit_code": None,
                "error": "",
                "cancel_requested": False,
                "eta_seconds": None,
            })
            OLLAMA_PULL_STATUS[model_name] = current
            return
        current.update({
            "model": model_name,
            "active": True,
            "status": "running",
            "message": f"{model_name} 모델을 받거나 업데이트를 확인하는 중입니다.",
            "started_at": current.get("started_at") or started_at,
            "updated_at": started_at,
            "exit_code": None,
            "error": "",
            "cancel_requested": False,
            "progress_percent": None,
            "eta_seconds": None,
        })
        OLLAMA_PULL_STATUS[model_name] = current
    process = None
    try:
        ensure_ollama_server_running(timeout_seconds=15)
        if _ollama_pull_cancel_requested(model_name):
            _set_ollama_pull_status(
                model_name,
                active=False,
                status="cancelled",
                message=f"{model_name} 모델 받기를 중지했습니다.",
                updated_at=datetime.now().isoformat(),
                exit_code=None,
                error="",
                cancel_requested=False,
                eta_seconds=None,
            )
            return
        process = subprocess.Popen(
            [find_ollama_executable(), "pull", model_name],
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
            env=ollama_subprocess_env(),
            **hidden_subprocess_kwargs(),
        )
        with OLLAMA_PULL_STATUS_LOCK:
            OLLAMA_PULL_PROCESSES[model_name] = process

        output_queue: "queue.Queue[str]" = queue.Queue()
        reader_thread = None
        if process.stdout is not None:
            reader_thread = threading.Thread(target=_read_process_output, args=(process.stdout, output_queue), daemon=True)
            reader_thread.start()

        output_parts: list[str] = []
        current_line = ""
        terminate_requested_at: float | None = None
        while True:
            try:
                chunk = output_queue.get(timeout=0.2)
                output_parts.append(chunk)
                if chunk in {"\r", "\n"}:
                    line = current_line.strip()
                    current_line = ""
                    if line:
                        _update_ollama_pull_progress_from_output(model_name, line)
                else:
                    current_line += chunk
            except queue.Empty:
                pass

            if _ollama_pull_cancel_requested(model_name) and process.poll() is None:
                if terminate_requested_at is None:
                    terminate_requested_at = time.monotonic()
                    try:
                        process.terminate()
                    except Exception:
                        logging.exception("Failed to terminate Ollama pull process for %s", model_name)
                elif time.monotonic() - terminate_requested_at > 5:
                    try:
                        process.kill()
                    except Exception:
                        logging.exception("Failed to kill Ollama pull process for %s", model_name)

            if process.poll() is not None and output_queue.empty():
                break

        if reader_thread is not None:
            reader_thread.join(timeout=1)
            while not output_queue.empty():
                chunk = output_queue.get_nowait()
                output_parts.append(chunk)
                if chunk in {"\r", "\n"}:
                    line = current_line.strip()
                    current_line = ""
                    if line:
                        _update_ollama_pull_progress_from_output(model_name, line)
                else:
                    current_line += chunk

        if current_line.strip():
            _update_ollama_pull_progress_from_output(model_name, current_line.strip())
        return_code = process.wait()
        output = "".join(output_parts).strip()
        if _ollama_pull_cancel_requested(model_name):
            _set_ollama_pull_status(
                model_name,
                active=False,
                status="cancelled",
                message=f"{model_name} 모델 받기를 중지했습니다.",
                exit_code=return_code,
                error="",
                output=output[-4000:],
                cancel_requested=False,
            )
        elif return_code == 0:
            _set_ollama_pull_status(
                model_name,
                active=False,
                status="completed",
                message=f"{model_name} 모델 받기가 완료되었습니다.",
                exit_code=return_code,
                output=output[-4000:],
                progress_percent=100,
                eta_seconds=0,
                cancel_requested=False,
            )
        else:
            _set_ollama_pull_status(
                model_name,
                active=False,
                status="failed",
                message=_download_blocked_message(f"{model_name} 모델을", "요약 프로그램 설치 또는 요약 모델 준비를"),
                exit_code=return_code,
                error=output[-4000:],
                cancel_requested=False,
            )
    except FileNotFoundError:
        _set_ollama_pull_status(
            model_name,
            active=False,
            status="failed",
            message=(
                "요약 프로그램(Ollama)을 찾지 못했습니다. 요약 프로그램을 설치한 뒤 준비 상태 확인을 눌러 주세요. "
                f"설치 페이지가 열리지 않으면 {_support_contact_email()}으로 문의해 주세요."
            ),
            exit_code=None,
            error="ollama executable not found",
            cancel_requested=False,
        )
    except Exception as exc:
        if _ollama_pull_cancel_requested(model_name):
            _set_ollama_pull_status(
                model_name,
                active=False,
                status="cancelled",
                message=f"{model_name} 모델 받기를 중지했습니다.",
                exit_code=None,
                error="",
                cancel_requested=False,
            )
            return
        logging.exception("Failed to pull Ollama model %s", model_name)
        _set_ollama_pull_status(
            model_name,
            active=False,
            status="failed",
            message=_download_blocked_message(f"{model_name} 모델을", "요약 프로그램 설치 또는 요약 모델 준비를"),
            exit_code=None,
            error=str(exc),
            cancel_requested=False,
        )
    finally:
        with OLLAMA_PULL_STATUS_LOCK:
            if OLLAMA_PULL_PROCESSES.get(model_name) is process:
                OLLAMA_PULL_PROCESSES.pop(model_name, None)


def _ollama_model_exists_strict(model_name: str) -> bool:
    try:
        ensure_ollama_server_running(timeout_seconds=10)
        completed = subprocess.run(
            [find_ollama_executable(), "list"],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            env=ollama_subprocess_env(),
            timeout=15,
            **hidden_subprocess_kwargs(),
        )
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail="요약 프로그램(Ollama)을 찾지 못했습니다. 요약 프로그램을 설치한 뒤 준비 상태 확인을 눌러 주세요.")
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"Ollama 모델 상태를 확인하지 못했습니다: {exc}")

    output = "\n".join(part.strip() for part in (completed.stdout, completed.stderr) if part and part.strip())
    if completed.returncode != 0:
        raise HTTPException(
            status_code=503,
            detail=output[-4000:] or "Ollama 모델 상태를 확인하지 못했습니다.",
        )

    return any(line.split(maxsplit=1)[0] == model_name for line in completed.stdout.splitlines()[1:] if line.split())


def _remove_ollama_model(model_name: str, replacement_model: str = "") -> dict:
    def _assert_removable(config: dict) -> str:
        configured_model = normalize_summary_model_name(config.get("summary", {}).get("model") or DEFAULT_SUMMARY_MODEL)
        visible_model_names = set(get_summary_option_models(config))
        if model_name not in visible_model_names:
            raise HTTPException(
                status_code=403,
                detail="이 앱의 요약 모델 목록에 있는 모델만 PC에서 삭제할 수 있습니다. 다른 Ollama 모델은 Ollama 앱이나 명령어에서 관리해 주세요.",
            )
        if model_name == configured_model:
            replacement = normalize_summary_model_name(replacement_model)
            if not replacement or replacement == model_name:
                raise HTTPException(status_code=409, detail="사용 중인 모델은 다른 요약 모델로 바꾼 뒤 삭제할 수 있습니다.")
            if replacement not in visible_model_names:
                raise HTTPException(status_code=400, detail="삭제 후 사용할 요약 모델을 찾지 못했습니다.")
            return replacement
        return ""

    with CONFIG_LOCK:
        config = load_config()
        replacement = _assert_removable(config)

        with OLLAMA_PULL_STATUS_LOCK:
            current_pull = dict(OLLAMA_PULL_STATUS.get(model_name) or {})
        if current_pull.get("active"):
            raise HTTPException(status_code=409, detail="받는 중인 모델은 삭제할 수 없습니다. 완료 후 다시 시도해 주세요.")

    if replacement and not _ollama_model_exists_strict(replacement):
        raise HTTPException(status_code=400, detail="삭제 후 사용할 요약 모델이 이 PC에 없습니다. 설치된 모델로 먼저 바꾼 뒤 삭제해 주세요.")

    was_installed = _ollama_model_exists_strict(model_name)
    removed = False
    output = ""
    if was_installed:
        try:
            ensure_ollama_server_running(timeout_seconds=10)
            completed = subprocess.run(
                [find_ollama_executable(), "rm", model_name],
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                env=ollama_subprocess_env(),
                timeout=120,
                **hidden_subprocess_kwargs(),
            )
        except FileNotFoundError:
            raise HTTPException(status_code=503, detail="요약 프로그램(Ollama)을 찾지 못했습니다. 요약 프로그램을 설치한 뒤 준비 상태 확인을 눌러 주세요.")
        output = "\n".join(part.strip() for part in (completed.stdout, completed.stderr) if part and part.strip())
        if completed.returncode != 0:
            raise HTTPException(
                status_code=500,
                detail=output[-4000:] or f"{model_name} 모델을 삭제하지 못했습니다.",
            )
        removed = True

    with CONFIG_LOCK:
        config = load_config()
        replacement = _assert_removable(config)
        if replacement:
            config.setdefault("summary", {})["provider"] = "ollama"
            config.setdefault("summary", {})["model"] = replacement
        remove_summary_user_model(config, model_name)
        save_config(config)
    message = f"{model_name} 모델을 삭제했습니다." if removed else f"{model_name} 모델은 설치되어 있지 않습니다."
    if replacement:
        message = f"{message} 요약 모델은 {replacement}로 변경했습니다."
    return {
        "model": model_name,
        "removed": removed,
        "replacement_model": replacement,
        "message": message,
        "output": output[-4000:],
    }


def _forget_summary_model(model_name: str) -> dict:
    with CONFIG_LOCK:
        config = load_config()
        configured_model = normalize_summary_model_name(config.get("summary", {}).get("model") or DEFAULT_SUMMARY_MODEL)
        if model_name == configured_model:
            raise HTTPException(status_code=409, detail="사용 중인 모델은 목록에서 제거할 수 없습니다. 다른 모델을 선택한 뒤 제거해 주세요.")

        before_models = {
            option.get("model")
            for option in config.get("summary", {}).get("user_models", [])
            if isinstance(option, dict)
        }
        remove_summary_user_model(config, model_name)
        save_config(config)
        return {
            "model": model_name,
            "removed": model_name in before_models,
            "message": f"{model_name} 모델을 목록에서 제거했습니다.",
        }


def _start_ollama_pull(model_name: str) -> dict:
    with OLLAMA_PULL_STATUS_LOCK:
        current = dict(OLLAMA_PULL_STATUS.get(model_name) or {})
        if current.get("active"):
            return current
        OLLAMA_PULL_STATUS[model_name] = {
            "model": model_name,
            "active": True,
            "status": "starting",
            "message": f"{model_name} 모델 받기 또는 업데이트 확인을 시작합니다.",
            "started_at": datetime.now().isoformat(),
            "updated_at": datetime.now().isoformat(),
            "exit_code": None,
            "error": "",
            "cancel_requested": False,
            "progress_percent": None,
            "eta_seconds": None,
        }

    worker = threading.Thread(target=_run_ollama_pull, args=(model_name,), daemon=True)
    worker.start()
    return _ollama_pull_snapshot(model_name)


@app.post("/api/models/ollama/pull")
async def start_ollama_model_pull(payload: dict = Body(...)) -> dict:
    model_name = _validate_ollama_model_name(str((payload or {}).get("model") or ""))
    if not _ollama_executable_available():
        return _set_ollama_pull_status(
            model_name,
            active=False,
            status="failed",
            message=(
                "요약 프로그램(Ollama)을 찾지 못했습니다. 요약 프로그램을 설치한 뒤 준비 상태 확인을 눌러 주세요. "
                f"설치 페이지가 열리지 않으면 {_support_contact_email()}으로 문의해 주세요."
            ),
            exit_code=None,
            error="ollama executable not found",
        )
    _remember_summary_model(model_name, managed_by_app=True)
    return _start_ollama_pull(model_name)


@app.post("/api/models/ollama/pull/stop")
async def stop_ollama_model_pull(payload: dict = Body(...)) -> dict:
    model_name = _validate_ollama_model_name(str((payload or {}).get("model") or ""))
    return _request_ollama_pull_stop(model_name)


@app.get("/api/models/ollama/pull-status")
async def get_ollama_model_pull_status(model: str) -> dict:
    model_name = _validate_ollama_model_name(model)
    return _ollama_pull_snapshot(model_name)


@app.post("/api/models/download")
async def start_model_download(payload: dict = Body(...)) -> dict:
    model_key = _validate_downloadable_model_key(str((payload or {}).get("key") or ""))
    return _start_model_download(model_key)


@app.post("/api/models/download/stop")
async def stop_model_download(payload: dict = Body(...)) -> dict:
    model_key = _validate_downloadable_model_key(str((payload or {}).get("key") or ""))
    return _request_model_download_stop(model_key)


@app.get("/api/models/download-status")
async def get_model_download_status(key: str) -> dict:
    model_key = _validate_downloadable_model_key(key)
    return _model_download_snapshot(model_key)


@app.delete("/api/models/ollama/model")
async def delete_ollama_model(model: str, delete_files: bool = False, replacement_model: str = "") -> dict:
    model_name = _validate_ollama_model_name(model)
    if delete_files:
        replacement = _validate_ollama_model_name(replacement_model) if replacement_model else ""
        return _remove_ollama_model(model_name, replacement)
    return _forget_summary_model(model_name)


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
async def download_output(job_id: str, kind: str, request: Request) -> FileResponse:
    job_id = _validate_job_id(job_id)
    allowed = {
        "json": (f"{job_id}_result.json", "application/json"),
        "txt": (f"{job_id}_transcript.txt", "text/plain; charset=utf-8"),
        "md": (f"{job_id}_report.md", "text/markdown; charset=utf-8"),
        "docx": (f"{job_id}_report.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
        "hwpx": (f"{job_id}_report.hwpx", "application/hwp+zip"),
    }
    if kind == "audio":
        _require_save_copy_origin(request)
        config = load_config()
        audio_path = _resolve_job_audio_path(config, job_id)
        if not audio_path:
            raise HTTPException(status_code=404, detail="Audio file not found")
        return FileResponse(audio_path, filename=f"{job_id}_audio.wav", media_type="audio/wav")

    if kind not in allowed:
        raise HTTPException(status_code=404, detail="Unknown output type")

    config = load_config()
    output_dir = os.path.abspath(resolve_config_path(config["paths"]["output_dir"]))
    filename, media_type = allowed[kind]
    file_path = os.path.abspath(os.path.join(output_dir, filename))
    if kind == "hwpx":
        _refresh_hwpx_output_if_needed(output_dir, job_id, file_path)
    if not file_path.startswith(output_dir + os.sep) or not os.path.exists(file_path):
        raise HTTPException(status_code=404, detail="Output file not found")

    return FileResponse(file_path, filename=filename, media_type=media_type)


@app.head("/api/outputs/{job_id}/audio")
async def head_output_audio(job_id: str, request: Request) -> Response:
    _require_save_copy_origin(request)
    job_id = _validate_job_id(job_id)
    config = load_config()
    audio_path = _resolve_job_audio_path(config, job_id)
    if not audio_path:
        raise HTTPException(status_code=404, detail="Audio file not found")
    return Response(headers={
        "content-length": str(os.path.getsize(audio_path)),
        "content-type": "audio/wav",
    })


@app.post("/api/outputs/{job_id}/{kind}/save-copy")
async def save_output_copy(job_id: str, kind: str, request: Request) -> dict:
    _require_save_copy_origin(request)
    job_id = _validate_job_id(job_id)
    config = load_config()
    output_dir = os.path.abspath(resolve_config_path(config["paths"]["output_dir"]))
    temp_dir = os.path.abspath(resolve_config_path(config["paths"]["temp_dir"]))
    allowed = {
        "txt": (f"{job_id}_transcript.txt", "txt"),
        "md": (f"{job_id}_report.md", "md"),
        "docx": (f"{job_id}_report.docx", "docx"),
        "hwpx": (f"{job_id}_report.hwpx", "hwpx"),
    }

    if kind == "audio":
        source_path = _resolve_job_audio_path(config, job_id)
        extension = "wav"
        if not source_path:
            raise HTTPException(status_code=404, detail="Audio file not found")
    elif kind in allowed:
        filename, extension = allowed[kind]
        source_path = os.path.abspath(os.path.join(output_dir, filename))
        if kind == "hwpx":
            _refresh_hwpx_output_if_needed(output_dir, job_id, source_path)
    else:
        raise HTTPException(status_code=404, detail="Unknown output type")

    if not os.path.exists(source_path):
        raise HTTPException(status_code=404, detail="Output file not found")

    target_path = _unique_download_path(f"{_safe_export_id(job_id)}_{kind}.{extension}")
    _copy_file_atomic(source_path, target_path)

    return {
        "job_id": job_id,
        "kind": kind,
        "saved_path": str(target_path),
        "size_bytes": target_path.stat().st_size,
    }


@app.post("/api/tools/extract-audio/save-copy")
async def extract_audio_copy(request: Request, file: UploadFile = File(...)) -> dict:
    _require_save_copy_origin(request)
    suffix = _validate_audio_extract_filename(file.filename)
    config = load_config()
    temp_root = Path(resolve_config_path(config["paths"]["temp_dir"])) / "audio_extract"
    temp_root.mkdir(parents=True, exist_ok=True)
    work_dir = Path(tempfile.mkdtemp(prefix="extract_", dir=temp_root))
    source_path = work_dir / f"source{suffix}"
    output_path = work_dir / "audio.wav"
    source_stem = Path(file.filename or "audio").stem or "audio"

    try:
        await _save_upload_to_path(file, source_path)
        if not source_path.exists() or source_path.stat().st_size <= 0:
            raise HTTPException(status_code=400, detail="파일을 읽지 못했습니다.")

        from pipeline.audio_preprocess import convert_to_wav

        try:
            await asyncio.to_thread(
                convert_to_wav,
                str(source_path),
                str(output_path),
                _resolve_config_ffmpeg_path(config),
                {"enabled": False},
            )
        except Exception as exc:
            raise HTTPException(status_code=400, detail=_audio_extract_error_message(exc)) from exc

        if not output_path.exists() or output_path.stat().st_size <= 0:
            raise HTTPException(status_code=400, detail="선택한 파일에서 음성 트랙을 찾지 못했습니다.")

        target_path = _unique_download_path(_safe_export_name(source_stem, "wav"))
        await asyncio.to_thread(_copy_file_atomic, str(output_path), target_path)
        return {
            "kind": "audio",
            "source_filename": file.filename or "",
            "saved_path": str(target_path),
            "size_bytes": target_path.stat().st_size,
        }
    finally:
        try:
            shutil.rmtree(work_dir, ignore_errors=True)
        finally:
            await file.close()


@app.get("/api/outputs/{job_id}/generation-progress/{kind}")
async def get_output_generation_progress(job_id: str, kind: str) -> dict:
    job_id = _validate_job_id(job_id)
    if kind != "diarization":
        raise HTTPException(status_code=404, detail="Unknown generation type")

    generation_key = (job_id, kind)
    with GENERATION_STATUS_LOCK:
        progress = dict(GENERATION_PROGRESS.get(generation_key) or {})

    if progress:
        return progress

    return {
        "job_id": job_id,
        "kind": kind,
        "progress": 0,
        "message": "",
        "status": "idle",
        "active": False,
    }


@app.post("/api/outputs/{job_id}/generation-stop/{kind}")
async def stop_output_generation(job_id: str, kind: str, payload: dict | None = Body(None)) -> dict:
    job_id = _validate_job_id(job_id)
    if kind != "diarization":
        raise HTTPException(status_code=404, detail="Unknown generation type")

    action = str((payload or {}).get("action") or "cancel")
    if action not in {"cancel", "defer"}:
        raise HTTPException(status_code=400, detail="Unknown stop action")

    generation_key = (job_id, kind)
    final_status = "deferred" if action == "defer" else "cancelled"
    final_message = (
        "참석자 구분을 중지하고 있습니다. 원본 음성이 남아 있으면 이 회의록에서 다시 실행할 수 있습니다."
        if action == "defer"
        else "참석자 구분 실행을 취소하고 있습니다. 나중에 다시 실행할 수 있습니다."
    )
    stop_state_saved = False
    with GENERATION_STATUS_LOCK:
        progress = GENERATION_PROGRESS.get(generation_key) or {}
        running = generation_key in ACTIVE_GENERATIONS
        if not running:
            return {
                "job_id": job_id,
                "kind": kind,
                "action": action,
                "status": "idle",
                "message": "진행 중인 참석자 구분이 없습니다.",
                "active": False,
                "running": False,
                "accepted": False,
            }
        GENERATION_STOP_REQUESTS[generation_key] = {
            "action": action,
            "final_status": final_status,
            "requested_at": datetime.now().isoformat(),
        }
        try:
            stop_state_saved = _apply_diarization_stop_to_result(job_id, {}, action)
        except Exception:
            logging.exception("Failed to persist diarization stop state")
            raise HTTPException(status_code=500, detail="diarization_stop_persist_failed")
        _set_generation_progress(
            generation_key,
            int(progress.get("progress") or 0),
            final_message,
            status="stopping",
            active=True,
        )

    if stop_state_saved:
        try:
            _refresh_transcript_and_summary_exports(job_id, _load_job_result(job_id))
        except Exception:
            logging.exception("Failed to refresh exports after diarization stop")

    return {
        "job_id": job_id,
        "kind": kind,
        "action": action,
        "status": "stopping",
        "message": final_message,
        "active": True,
        "running": running,
        "accepted": True,
    }


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
            f"{candidate}_partial_result.json",
            f"{candidate}_partial_transcript.txt",
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


def _delete_resume_artifacts(job_id: str) -> list[str]:
    config = load_config()
    output_dir = os.path.abspath(resolve_config_path(config["paths"]["output_dir"]))
    temp_dir = os.path.abspath(resolve_config_path(config["paths"]["temp_dir"]))
    deleted: list[str] = []

    partial_output_names = {
        f"{job_id}_partial_result.json",
        f"{job_id}_partial_transcript.txt",
    }
    if os.path.isdir(output_dir):
        for name in partial_output_names:
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


def _raise_if_active_analysis_job(job_id: str) -> None:
    if ANALYSIS_JOBS.has(job_id):
        raise HTTPException(status_code=409, detail="analysis_job_active")


@app.delete("/api/outputs/{job_id}")
async def delete_outputs(job_id: str) -> dict:
    job_id = _validate_job_id(job_id)
    _raise_if_active_analysis_job(job_id)
    return {"job_id": job_id, "deleted": _delete_job_artifacts(job_id)}


@app.delete("/api/analyze/drafts/{job_id}")
async def delete_analysis_draft(job_id: str) -> dict:
    job_id = _validate_job_id(job_id)
    _raise_if_active_analysis_job(job_id)
    return {"job_id": job_id, "deleted": _delete_resume_artifacts(job_id)}


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


def _hwpx_needs_regeneration(file_path: str) -> bool:
    if not os.path.exists(file_path):
        return True

    try:
        with zipfile.ZipFile(file_path) as archive:
            names = set(archive.namelist())
            if not HWPX_REQUIRED_ENTRIES.issubset(names):
                return True

            content_root = ElementTree.fromstring(archive.read("Contents/content.hpf"))
            opf_ns = {"opf": "http://www.idpf.org/2007/opf/"}
            spine_refs = [
                item.attrib.get("idref")
                for item in content_root.findall("./opf:spine/opf:itemref", opf_ns)
            ]
            if spine_refs[:2] != ["header", "section0"]:
                return True

            manifest_root = ElementTree.fromstring(archive.read("META-INF/manifest.xml"))
            manifest_ns = {"manifest": "urn:oasis:names:tc:opendocument:xmlns:manifest:1.0"}
            media_types = {
                entry.attrib.get("{urn:oasis:names:tc:opendocument:xmlns:manifest:1.0}full-path"): entry.attrib.get(
                    "{urn:oasis:names:tc:opendocument:xmlns:manifest:1.0}media-type"
                )
                for entry in manifest_root.findall("./manifest:file-entry", manifest_ns)
            }
            return media_types.get("Contents/content.hpf") != "application/hwpml-package+xml"
    except (ElementTree.ParseError, KeyError, OSError, zipfile.BadZipFile):
        return True


def _refresh_hwpx_output_if_needed(output_dir: str, job_id: str, hwpx_path: str) -> None:
    if not hwpx_path.startswith(output_dir + os.sep) or not _hwpx_needs_regeneration(hwpx_path):
        return

    json_path = os.path.abspath(os.path.join(output_dir, f"{job_id}_result.json"))
    if not json_path.startswith(output_dir + os.sep) or not os.path.exists(json_path):
        return

    from pipeline.export_hwpx import export_hwpx

    existing_hwpx = os.path.exists(hwpx_path)
    temp_path = f"{hwpx_path}.{os.getpid()}.{threading.get_ident()}.tmp"
    try:
        with open(json_path, "r", encoding="utf-8") as f:
            export_hwpx(json.load(f), temp_path)
        if _hwpx_needs_regeneration(temp_path):
            raise RuntimeError("Regenerated HWPX did not pass package validation")
        os.replace(temp_path, hwpx_path)
    except Exception:
        if existing_hwpx:
            logging.exception("Failed to refresh existing HWPX output; serving existing file")
            return
        raise
    finally:
        if os.path.exists(temp_path):
            try:
                os.remove(temp_path)
            except OSError:
                logging.debug("Failed to remove temporary HWPX file: %s", temp_path, exc_info=True)


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
    summary_config = config.get("summary", {}) if isinstance(config.get("summary", {}), dict) else {}
    llm_model = str(summary_config.get("model") or DEFAULT_SUMMARY_MODEL).strip()
    if llm_model and llm_model.startswith((".", "..")):
        llm_model = os.path.normpath(os.path.join(BASE_DIR, llm_model))
    if llm_model and os.path.exists(llm_model):
        return llm_model
    if llm_model and llm_model.endswith((".gguf", ".bin")):
        return llm_model
    for candidate in get_summary_candidate_models(config):
        if candidate and ollama_model_exists(candidate):
            return candidate
    return llm_model


def _summary_model_readiness(config: dict) -> dict:
    summary_config = config.get("summary", {})
    if not summary_config.get("enabled", True):
        return {
            "ready": False,
            "status": "skipped",
            "message": "요약 기능이 꺼져 있어 대화록만 생성했습니다.",
        }

    model_name_or_path = _resolve_summary_model(config)
    if not model_name_or_path:
        return {
            "ready": False,
            "status": "skipped",
            "message": "요약 AI 설정이 없어 대화록만 생성했습니다.",
        }

    if os.path.exists(model_name_or_path):
        return {"ready": True, "status": "ready", "message": ""}

    if model_name_or_path.endswith((".gguf", ".bin")):
        return {
            "ready": False,
            "status": "skipped",
            "message": "요약 AI 모델 파일이 없어 대화록만 생성했습니다.",
        }

    if ollama_model_exists(model_name_or_path):
        return {"ready": True, "status": "ready", "message": ""}

    return {
        "ready": False,
        "status": "skipped",
        "message": f"요약 AI가 준비되지 않아 대화록만 생성했습니다. 요약을 사용하려면 Ollama에 {model_name_or_path} 모델을 준비해 주세요.",
    }


def _skipped_summary(message: str) -> dict:
    return {
        "title": "회의록",
        "overview": message,
        "topics": [],
        "topic_sections": [],
        "participant_summaries": [],
        "decisions": [],
        "actions": [],
        "needs_check": [message],
        "generation_status": {
            "summary": "skipped",
            "topic_sections": "skipped",
            "speaker_context_summaries": "skipped",
        },
    }


def _should_generate_summary_during_analysis(config: dict) -> bool:
    summary_config = config.get("summary", {})
    return bool(summary_config.get("generate_during_analysis", False))


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


def _summary_status(summary: dict) -> str:
    status = _ensure_generation_status(summary)
    value = status.get("summary")
    return value if isinstance(value, str) else "not_started"


def _has_existing_summary_content(summary: dict | None) -> bool:
    if not isinstance(summary, dict):
        return False
    return any(
        bool(summary.get(key))
        for key in ("overview", "topics", "topic_sections", "speaker_context_summaries", "participant_summaries")
    )


def _result_outputs(job_id: str, include_audio: bool | None = None) -> dict:
    outputs = {
        "job_id": job_id,
        "json": f"/api/outputs/{job_id}/json",
        "txt": f"/api/outputs/{job_id}/txt",
        "md": f"/api/outputs/{job_id}/md",
        "docx": f"/api/outputs/{job_id}/docx",
        "hwpx": f"/api/outputs/{job_id}/hwpx",
    }
    if include_audio is None:
        try:
            include_audio = _resolve_job_audio_path(load_config(), job_id) is not None
        except Exception:
            include_audio = False
    if include_audio:
        outputs["audio"] = f"/api/outputs/{job_id}/audio"
    return outputs


def _prune_generation_progress_locked(now: float | None = None) -> None:
    now = now if now is not None else time.time()

    def progress_epoch(progress: dict) -> float:
        value = progress.get("inactive_at_epoch")
        if value is None:
            value = progress.get("updated_at_epoch")
        try:
            return float(value)
        except (TypeError, ValueError):
            return now

    expired_keys = [
        key
        for key, progress in GENERATION_PROGRESS.items()
        if not progress.get("active", False)
        and now - progress_epoch(progress) > GENERATION_PROGRESS_TTL_SECONDS
    ]
    for key in expired_keys:
        GENERATION_PROGRESS.pop(key, None)

    if len(GENERATION_PROGRESS) <= GENERATION_PROGRESS_MAX_ENTRIES:
        return

    inactive_keys = [
        key
        for key, progress in GENERATION_PROGRESS.items()
        if not progress.get("active", False)
    ]
    inactive_keys.sort(key=lambda key: progress_epoch(GENERATION_PROGRESS.get(key, {})))
    overflow = len(GENERATION_PROGRESS) - GENERATION_PROGRESS_MAX_ENTRIES
    for key in inactive_keys[:max(0, overflow)]:
        GENERATION_PROGRESS.pop(key, None)


def _begin_generation(job_id: str, kind: str) -> tuple[str, str]:
    generation_key = (job_id, kind)
    _prune_generation_progress_locked()
    if generation_key in ACTIVE_GENERATIONS:
        raise HTTPException(status_code=409, detail=f"{kind} generation is already running")
    ACTIVE_GENERATIONS.add(generation_key)
    GENERATION_STOP_REQUESTS.pop(generation_key, None)
    if kind == "diarization":
        _set_generation_progress(generation_key, 0, "준비 중")
    return generation_key


def _end_generation(generation_key: tuple[str, str] | None) -> None:
    if generation_key:
        ACTIVE_GENERATIONS.discard(generation_key)
        GENERATION_STOP_REQUESTS.pop(generation_key, None)
        progress = GENERATION_PROGRESS.get(generation_key)
        if progress:
            progress["active"] = False
            progress["updated_at"] = datetime.now().isoformat()
            progress["updated_at_epoch"] = time.time()
            progress["inactive_at_epoch"] = progress["updated_at_epoch"]
        _prune_generation_progress_locked()


def _set_generation_progress(
    generation_key: tuple[str, str] | None,
    progress: int,
    message: str,
    *,
    status: str = "processing",
    active: bool = True,
) -> None:
    if not generation_key:
        return
    now = datetime.now().isoformat()
    now_epoch = time.time()
    current = GENERATION_PROGRESS.get(generation_key) or {}
    GENERATION_PROGRESS[generation_key] = {
        **current,
        "job_id": generation_key[0],
        "kind": generation_key[1],
        "progress": max(0, min(100, int(progress))),
        "message": message,
        "status": status,
        "active": active,
        "started_at": current.get("started_at") or now,
        "updated_at": now,
        "updated_at_epoch": now_epoch,
        "inactive_at_epoch": current.get("inactive_at_epoch") if active else now_epoch,
    }


def _record_generation_progress(
    generation_key: tuple[str, str] | None,
    progress: int,
    message: str,
    *,
    status: str = "processing",
    active: bool = True,
) -> None:
    with GENERATION_STATUS_LOCK:
        _set_generation_progress(generation_key, progress, message, status=status, active=active)


def _generation_stop_request(generation_key: tuple[str, str] | None) -> dict | None:
    if not generation_key:
        return None
    with GENERATION_STATUS_LOCK:
        request = GENERATION_STOP_REQUESTS.get(generation_key)
        return dict(request) if request else None


def _raise_if_generation_stopped(generation_key: tuple[str, str] | None) -> None:
    request = _generation_stop_request(generation_key)
    if not request:
        return
    detail = DETAIL_DIARIZATION_DEFERRED if request.get("action") == "defer" else DETAIL_DIARIZATION_CANCELLED
    raise HTTPException(status_code=409, detail=detail)


def _apply_diarization_stop_to_result(job_id: str, result_data: dict, action: str) -> bool:
    if not os.path.exists(_get_job_result_path(job_id)):
        return False
    latest_result = _load_latest_generation_result(job_id, result_data)
    raw_segments = latest_result.get("raw_stt_segments")
    if isinstance(raw_segments, list) and raw_segments:
        latest_result["segments"] = raw_segments
        latest_result["aligned_segments"] = raw_segments
        latest_result["display_segments"] = raw_segments
    latest_settings = latest_result.setdefault("settings", {})
    is_deferred = action == "defer"
    latest_settings.update({
        "diarization": False,
        "diarization_requested": True,
        "diarization_skipped": False,
        "diarization_deferred": is_deferred,
        "diarization_skip_reason": "",
        "diarization_skip_message": "",
        "diarization_defer_message": (
            "참석자 구분을 멈췄습니다. 원본 음성이 남아 있으면 이 회의록에서 다시 실행할 수 있습니다."
            if is_deferred
            else ""
        ),
        "diarization_generation_status": "deferred" if is_deferred else "cancelled",
    })
    latest_settings.pop("diarization_error_detail", None)
    latest_settings.pop("diarization_error_message", None)
    latest_summary = latest_result.setdefault("summary", {})
    latest_status = _ensure_generation_status(latest_summary)
    latest_status["speaker_context_summaries"] = "not_started"
    latest_summary["generation_status"] = latest_status
    latest_summary["speaker_context_summaries"] = []
    latest_summary["participant_summaries"] = []
    _save_job_result(job_id, latest_result)
    return True


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


def _refresh_transcript_and_summary_exports(job_id: str, result_data: dict) -> dict:
    from pipeline.export_txt import export_txt
    from pipeline.transcript_display import get_transcript_segments

    output_dir = _get_output_dir()
    out_txt_path = os.path.abspath(os.path.join(output_dir, f"{job_id}_transcript.txt"))
    if not out_txt_path.startswith(output_dir + os.sep):
        raise HTTPException(status_code=400, detail="Invalid export path")
    export_txt(get_transcript_segments(result_data), out_txt_path)
    return _refresh_summary_exports(job_id, result_data)


def _participant_summaries_from_speaker_context(items: list[dict]) -> list[dict]:
    return [
        {
            "participant": item.get("display_name") or item.get("speaker") or "참석자",
            "summary": item.get("summary", ""),
            "key_points": item.get("key_points", []),
            "actions": item.get("actions", []),
        }
        for item in items
    ]


def _default_participant_label(value: str) -> str:
    label = str(value or "").strip()
    speaker_match = re.match(r"^SPEAKER[_\s-]?(\d+)$", label, re.IGNORECASE)
    if speaker_match:
        return f"참석자{int(speaker_match.group(1)) + 1:02d}"
    legacy_match = re.match(r"^화자(\d+)$", label)
    if legacy_match:
        digits = legacy_match.group(1)
        value = int(digits)
        participant_number = value + 1 if len(digits) >= 2 else max(1, value)
        return f"참석자{participant_number:02d}"
    return label or "참석자"


def _is_default_speaker_label(value: str) -> bool:
    label = str(value or "").strip()
    return bool(
        re.match(r"^SPEAKER[_\s-]?\d+$", label, re.IGNORECASE)
        or re.match(r"^화자\d+$", label)
        or re.match(r"^참석자\d+$", label)
    )


def _participant_copy_text(value: str) -> str:
    text = str(value or "")
    text = (
        text.replace("발화자 구분", "참석자 구분")
        .replace("화자 분리", "참석자 구분")
        .replace("화자 구분", "참석자 구분")
        .replace("화자별", "참석자별")
        .replace("화자 라벨", "자동 참석자 라벨")
        .replace("발화자", "참석자")
        .replace("발언자", "참석자")
    )
    return re.sub(r"화자\d+", lambda match: _default_participant_label(match.group(0)), text)


def _participant_copy_value(value):
    if isinstance(value, str):
        return _participant_copy_text(value)
    if isinstance(value, list):
        return [_participant_copy_value(item) for item in value]
    if isinstance(value, dict):
        return {key: _participant_copy_value(item) for key, item in value.items()}
    return value


def _speaker_label_for_export(speaker_labels: dict, speaker: str, fallback: str = "") -> str:
    speaker = str(speaker or "").strip()
    fallback = str(fallback or "").strip()
    explicit_label = str(speaker_labels.get(speaker) or speaker_labels.get(fallback) or "").strip()
    if explicit_label:
        return explicit_label
    if speaker and (not fallback or _is_default_speaker_label(fallback)):
        return _default_participant_label(speaker)
    return _default_participant_label(fallback or speaker)


def _speaker_label_replacements(speaker: str, previous_label: str, next_label: str) -> list[tuple[str, str]]:
    next_label = str(next_label or "").strip()
    if not next_label:
        return []

    replacements = []
    seen = set()
    for source in (previous_label, speaker):
        source = str(source or "").strip()
        if not source or source == next_label or source in seen:
            continue
        seen.add(source)
        replacements.append((source, next_label))
    return replacements


def _replace_speaker_label_text(value, replacements: list[tuple[str, str]]):
    if not replacements:
        return value
    if isinstance(value, str):
        next_value = value
        for source, target in sorted(replacements, key=lambda item: len(item[0]), reverse=True):
            next_value = next_value.replace(source, target)
        return next_value
    if isinstance(value, list):
        return [_replace_speaker_label_text(item, replacements) for item in value]
    return value


def _replace_speaker_label_fields(item: dict, replacements: list[tuple[str, str]]) -> dict:
    if not replacements:
        return item
    next_item = dict(item)
    for key in ("role_in_meeting", "summary", "key_points", "actions", "needs_check", "evidence"):
        if key in next_item:
            next_item[key] = _replace_speaker_label_text(next_item[key], replacements)
    return next_item


def _apply_speaker_labels_to_result_segments(
    result_data: dict,
    speaker_labels: dict,
    *,
    speaker_fallback_when_unlabeled: bool = False,
) -> dict:
    for key in ("segments", "display_segments"):
        segments = result_data.get(key)
        if not isinstance(segments, list):
            continue
        for segment in segments:
            if not isinstance(segment, dict):
                continue
            speaker = str(segment.get("speaker") or segment.get("speaker_id") or "").strip()
            if not speaker:
                continue
            fallback = speaker if speaker_fallback_when_unlabeled else str(segment.get("speaker_name") or "").strip()
            display_name = _speaker_label_for_export(speaker_labels, speaker, fallback)
            if display_name:
                segment["speaker_name"] = display_name
    return result_data


def _speaker_context_summaries_for_export(
    items: list[dict],
    speaker_labels: dict,
    *,
    speaker_fallback_when_unlabeled: bool = False,
) -> list[dict]:
    summaries = []
    for item in items or []:
        if not isinstance(item, dict):
            continue
        speaker = str(item.get("speaker") or item.get("participant") or "").strip()
        fallback_display_name = str(item.get("display_name") or item.get("displayName") or "").strip()
        if speaker_fallback_when_unlabeled and speaker:
            fallback_display_name = speaker
        display_name = _speaker_label_for_export(
            speaker_labels,
            speaker,
            fallback_display_name,
        )
        next_item = dict(item)
        if display_name:
            next_item["display_name"] = display_name
        replacements = _speaker_label_replacements(speaker, str(item.get("display_name") or item.get("displayName") or ""), display_name)
        next_item = _replace_speaker_label_fields(next_item, replacements)
        summaries.append(next_item)
    return summaries


def _participant_summaries_for_export(
    participant_summaries: list[dict],
    speaker_context_summaries: list[dict],
    speaker_labels: dict,
    *,
    speaker_fallback_when_unlabeled: bool = False,
) -> list[dict]:
    if speaker_context_summaries:
        return _participant_summaries_from_speaker_context(
            _speaker_context_summaries_for_export(
                speaker_context_summaries,
                speaker_labels,
                speaker_fallback_when_unlabeled=speaker_fallback_when_unlabeled,
            )
        )

    summaries = []
    for item in participant_summaries or []:
        if not isinstance(item, dict):
            continue
        speaker = str(item.get("speaker") or "").strip()
        participant = str(item.get("participant") or item.get("speaker") or "").strip()
        next_item = dict(item)
        if participant:
            previous_participant = participant
            fallback_participant = speaker if speaker_fallback_when_unlabeled and speaker else participant
            next_participant = _speaker_label_for_export(
                speaker_labels,
                speaker or participant,
                fallback_participant,
            )
            next_item["participant"] = next_participant
            replacements = _speaker_label_replacements(speaker, previous_participant, next_participant)
            next_item = _replace_speaker_label_fields(next_item, replacements)
        summaries.append(next_item)
    return summaries


def _apply_speaker_labels_to_result_summary(result_data: dict, *, speaker_fallback_when_unlabeled: bool = False) -> dict:
    summary = result_data.get("summary")
    if not isinstance(summary, dict):
        return result_data

    speaker_context_summaries = summary.get("speaker_context_summaries") or []
    participant_summaries = summary.get("participant_summaries") or []
    if not speaker_context_summaries and not participant_summaries:
        return result_data

    speaker_labels = _normalize_speaker_labels(result_data.get("speaker_labels"))
    next_speaker_context_summaries = _speaker_context_summaries_for_export(
        speaker_context_summaries,
        speaker_labels,
        speaker_fallback_when_unlabeled=speaker_fallback_when_unlabeled,
    )
    summary["speaker_context_summaries"] = next_speaker_context_summaries
    summary["participant_summaries"] = _participant_summaries_for_export(
        participant_summaries,
        next_speaker_context_summaries,
        speaker_labels,
        speaker_fallback_when_unlabeled=speaker_fallback_when_unlabeled,
    )
    return result_data


def _clear_speaker_context_after_topic_change(summary: dict, status: dict) -> None:
    summary["speaker_context_summaries"] = []
    summary["participant_summaries"] = []
    status["speaker_context_summaries"] = "not_started"


def _valid_generated_topic_sections(topic_sections: list[dict]) -> list[dict]:
    sections = [
        section
        for section in topic_sections or []
        if isinstance(section, dict) and section.get("topic")
    ]
    if len(sections) == 1 and str(sections[0].get("topic") or "").strip() in GENERIC_SINGLE_TOPIC_TITLES:
        return []
    return sections


def _mark_generation_failed(job_id: str, result_data: dict, summary_key: str, detail: str) -> dict:
    latest_result = _load_latest_generation_result(job_id, result_data)
    latest_summary = latest_result.setdefault("summary", {})
    latest_status = _ensure_generation_status(latest_summary)
    latest_status[summary_key] = "failed"
    latest_summary["generation_status"] = latest_status
    latest_summary["generation_error_detail"] = detail
    _save_job_result(job_id, latest_result)
    return latest_result


def _restore_topic_section_status_after_custom_failure(
    job_id: str,
    result_data: dict,
    fallback_status: str,
    detail: str = "",
) -> dict:
    latest_result = _load_latest_generation_result(job_id, result_data)
    latest_summary = latest_result.setdefault("summary", {})
    latest_status = _ensure_generation_status(latest_summary)
    topic_sections = latest_summary.get("topic_sections") or []
    valid_topic_section_count = len([
        section
        for section in topic_sections
        if isinstance(section, dict) and section.get("topic")
    ])
    if valid_topic_section_count >= 1:
        latest_status["topic_sections"] = "completed"
        latest_summary.pop("generation_error_detail", None)
    else:
        latest_status["topic_sections"] = fallback_status
        if detail and fallback_status == "failed":
            latest_summary["generation_error_detail"] = detail
    latest_summary["generation_status"] = latest_status
    _save_job_result(job_id, latest_result)
    return latest_result


def _mark_diarization_failed(job_id: str, result_data: dict, detail: str, message: str = "") -> None:
    if not os.path.exists(_get_job_result_path(job_id)):
        return
    latest_result = _load_latest_generation_result(job_id, result_data)
    latest_settings = latest_result.setdefault("settings", {})
    latest_settings["diarization_generation_status"] = "failed"
    latest_settings["diarization_error_detail"] = detail
    latest_settings["diarization_error_message"] = message
    _save_job_result(job_id, latest_result)


def _should_mark_diarization_failed(exc: HTTPException) -> bool:
    detail = str(exc.detail)
    if exc.status_code == 409 and detail in {
        "diarization_already_completed",
        "diarization generation is already running",
    }:
        return False
    return True


@app.post("/api/outputs/{job_id}/generate-diarization")
async def generate_output_diarization(job_id: str, payload: dict | None = Body(None)) -> dict:
    from pipeline.align_speakers import align_segments_with_speakers
    from pipeline.chunk_audio import get_wav_duration_seconds
    from pipeline.diarize import diarize_audio
    from pipeline.transcript_display import build_display_segments

    job_id = _validate_job_id(job_id)
    generation_key = None
    config = None
    restored_source_audio = False
    restored_source_audio_deleted = False
    source_audio_path = None
    try:
        with GENERATION_STATUS_LOCK:
            result_data, had_saved_result = _load_or_rebuild_job_result(job_id, payload, persist_rebuilt=False)
            source_segments = (
                result_data.get("raw_stt_segments")
                or result_data.get("aligned_segments")
                or result_data.get("segments")
                or []
            )
            raw_segments = numeric_transcript_segments(source_segments)
            if not raw_segments:
                raise HTTPException(status_code=400, detail="Transcript segments are required")
            result_settings = result_data.setdefault("settings", {})
            if result_settings.get("diarization"):
                raise HTTPException(status_code=409, detail="diarization_already_completed")
            generation_key = _begin_generation(job_id, "diarization")
            result_settings["diarization_generation_status"] = "generating"
            if had_saved_result:
                _save_job_result(job_id, result_data)

        config = load_config()
        _record_generation_progress(generation_key, 8, "참석자 구분 준비 중")
        _raise_if_generation_stopped(generation_key)
        source_audio_path = _resolve_job_audio_path(config, job_id)
        if not source_audio_path:
            _record_generation_progress(generation_key, 12, "원본 파일에서 참석자 구분용 음성 파일을 준비하는 중")
            _raise_if_generation_stopped(generation_key)
            recoverable_source_path = _resolve_recoverable_source_path(config, job_id, payload, result_data)
            if recoverable_source_path:
                source_audio_path = await asyncio.to_thread(
                    lambda: _restore_job_audio_path_for_diarization(config, job_id, recoverable_source_path)
                )
                restored_source_audio = bool(source_audio_path)
                _raise_if_generation_stopped(generation_key)
        if not source_audio_path:
            raise HTTPException(status_code=404, detail="audio_required_for_diarization")

        _record_generation_progress(generation_key, 15, "음성 파일 확인 중")
        _raise_if_generation_stopped(generation_key)
        decision = _diarization_resource_decision(
            config,
            get_wav_duration_seconds(source_audio_path),
            requested_override=True,
        )
        if decision.get("skipped"):
            raise HTTPException(status_code=409, detail="diarization_resource_limit")

        _record_generation_progress(generation_key, 22, "참석자 구분 모델 확인 중")
        _raise_if_generation_stopped(generation_key)
        diarization_spec = get_model_spec("diarization")
        if model_exists(BASE_DIR, diarization_spec):
            diarize_model_path = resolve_model_path(BASE_DIR, diarization_spec)
        else:
            diarize_model_path = str(config.get("paths", {}).get("diarization_model") or "")
            if diarize_model_path.startswith((".", "..")):
                diarize_model_path = os.path.normpath(os.path.join(BASE_DIR, diarize_model_path))
        if not diarize_model_path or not os.path.exists(diarize_model_path):
            raise HTTPException(status_code=409, detail="diarization_model_not_ready")

        min_spk = config.get("diarization", {}).get("min_speakers")
        max_spk = config.get("diarization", {}).get("max_speakers")
        _record_generation_progress(generation_key, 30, "참석자 음성 구간 분석 중")
        _raise_if_generation_stopped(generation_key)
        speaker_segments = await asyncio.to_thread(
            lambda: diarize_audio(source_audio_path, diarize_model_path, min_spk, max_spk)
        )
        _raise_if_generation_stopped(generation_key)
        _record_generation_progress(generation_key, 78, "참석자 구간을 대화록 시간과 맞추는 중")
        aligned_segments = align_segments_with_speakers(copy.deepcopy(raw_segments), speaker_segments)
        _raise_if_generation_stopped(generation_key)
        _record_generation_progress(generation_key, 86, "참석자 구분을 대화록에 반영 중")
        display_segments = build_display_segments(copy.deepcopy(aligned_segments))
        _raise_if_generation_stopped(generation_key)

        output_dir = _get_output_dir()
        temp_dir = os.path.abspath(resolve_config_path(config["paths"]["temp_dir"]))
        checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
        ensure_job_checkpoint_dirs(checkpoint_paths)
        segments_fingerprint = _segment_fingerprint(raw_segments)
        config_fingerprint = _analysis_config_fingerprint(config)
        atomic_write_json(checkpoint_paths.diarization_segments_path, {
            "speaker_segments": speaker_segments,
            "config_fingerprint": config_fingerprint,
            "segments_fingerprint": segments_fingerprint,
        })
        atomic_write_json(checkpoint_paths.aligned_segments_path, {
            "segments": aligned_segments,
            "config_fingerprint": config_fingerprint,
            "segments_fingerprint": segments_fingerprint,
        })
        atomic_write_json(checkpoint_paths.display_segments_path, {
            "segments": display_segments,
            "config_fingerprint": config_fingerprint,
            "segments_fingerprint": segments_fingerprint,
        })
        _raise_if_generation_stopped(generation_key)

        with GENERATION_STATUS_LOCK:
            _raise_if_generation_stopped(generation_key)
            latest_result = _load_latest_generation_result(job_id, result_data)
            latest_result["segments"] = aligned_segments
            latest_result["aligned_segments"] = aligned_segments
            latest_result["display_segments"] = display_segments
            latest_result.setdefault("raw_stt_segments", raw_segments)
            latest_settings = latest_result.setdefault("settings", {})
            latest_settings.update({
                "diarization": True,
                "diarization_requested": True,
                "diarization_skipped": False,
                "diarization_deferred": False,
                "diarization_skip_reason": "",
                "diarization_skip_message": "",
                "diarization_defer_message": "",
                "diarization_generation_status": "completed",
                "diarization_resource_decision": {**decision, "run": True, "skipped": False},
            })
            latest_settings.pop("diarization_error_detail", None)
            latest_settings.pop("diarization_error_message", None)
            latest_summary = latest_result.setdefault("summary", {})
            latest_status = _ensure_generation_status(latest_summary)
            if latest_status.get("speaker_context_summaries") == "completed":
                latest_status["speaker_context_summaries"] = "not_started"
                latest_summary["speaker_context_summaries"] = []
                latest_summary["participant_summaries"] = []
            latest_summary["generation_status"] = latest_status
            _save_job_result(job_id, latest_result)
            result_data = latest_result

        export_error = None
        try:
            _raise_if_generation_stopped(generation_key)
            _record_generation_progress(generation_key, 94, "내보내기 파일 갱신 중")
            outputs = _refresh_transcript_and_summary_exports(job_id, result_data)
        except HTTPException:
            raise
        except Exception:
            logging.exception("Failed to refresh summary exports after diarization")
            outputs = _result_outputs(job_id)
            export_error = "참석자 구분은 저장했지만 일부 문서 파일을 갱신하지 못했습니다."

        _write_job_state(checkpoint_paths, {
            "diarization_completed": True,
            "diarization_skipped": False,
            "diarization_deferred": False,
            "resume_supported": True,
        })
        _raise_if_generation_stopped(generation_key)
        _record_generation_progress(generation_key, 100, "참석자 구분 완료", status="completed", active=False)
        if (
            restored_source_audio
            and source_audio_path
            and config is not None
            and not config.get("privacy", {}).get("preserve_extracted_audio", False)
        ):
            try:
                restored_source_audio_deleted = _delete_restored_diarization_audio(config, job_id, source_audio_path)
                if restored_source_audio_deleted:
                    outputs.pop("audio", None)
            except Exception:
                logging.exception("Failed to clean up restored diarization audio")
        return {
            "job_id": job_id,
            "segments": segments_for_ui(result_data.get("segments", [])),
            "display_segments": segments_for_ui(result_data.get("display_segments", [])),
            "diarization_applied": True,
            "diarization_requested": True,
            "diarization_skipped": False,
            "diarization_deferred": False,
            "generation_status": result_data.get("summary", {}).get("generation_status", {}),
            "speaker_context_summaries": result_data.get("summary", {}).get("speaker_context_summaries", []),
            "participant_summaries": result_data.get("summary", {}).get("participant_summaries", []),
            "outputs": outputs,
            "export_error": export_error,
        }
    except HTTPException as exc:
        if str(exc.detail) in {DETAIL_DIARIZATION_CANCELLED, DETAIL_DIARIZATION_DEFERRED}:
            action = "defer" if str(exc.detail) == DETAIL_DIARIZATION_DEFERRED else "cancel"
            message = (
                "참석자 구분을 멈췄습니다. 원본 음성이 남아 있으면 이 회의록에서 다시 실행할 수 있습니다."
                if action == "defer"
                else "참석자 구분을 취소했습니다."
            )
            stop_state_saved = False
            with GENERATION_STATUS_LOCK:
                try:
                    _set_generation_progress(
                        generation_key,
                        GENERATION_PROGRESS.get(generation_key, {}).get("progress", 0),
                        message,
                        status="deferred" if action == "defer" else "cancelled",
                        active=False,
                    )
                    stop_state_saved = _apply_diarization_stop_to_result(
                        job_id,
                        result_data if "result_data" in locals() else {},
                        action,
                    )
                except Exception:
                    logging.exception("Failed to persist diarization stop state")
                    raise HTTPException(status_code=500, detail="diarization_stop_persist_failed")
            if stop_state_saved:
                try:
                    _refresh_transcript_and_summary_exports(job_id, _load_job_result(job_id))
                except Exception:
                    logging.exception("Failed to refresh exports after diarization stop")
            raise
        with GENERATION_STATUS_LOCK:
            try:
                _set_generation_progress(
                    generation_key,
                    GENERATION_PROGRESS.get(generation_key, {}).get("progress", 0),
                    str(exc.detail),
                    status="failed",
                    active=False,
                )
                if _should_mark_diarization_failed(exc):
                    _mark_diarization_failed(
                        job_id,
                        result_data if "result_data" in locals() else {},
                        str(exc.detail),
                        str(exc.detail),
                    )
            except Exception:
                pass
        raise
    except Exception as exc:
        with GENERATION_STATUS_LOCK:
            try:
                _set_generation_progress(
                    generation_key,
                    GENERATION_PROGRESS.get(generation_key, {}).get("progress", 0),
                    "참석자 구분 실행 중 오류가 발생했습니다.",
                    status="failed",
                    active=False,
                )
                _mark_diarization_failed(
                    job_id,
                    result_data if "result_data" in locals() else {},
                    DETAIL_DIARIZATION_RUNTIME_ERROR,
                    f"{type(exc).__name__}: {exc}",
                )
            except Exception:
                pass
        logging.exception("Failed to generate diarization")
        raise HTTPException(status_code=500, detail=DETAIL_DIARIZATION_RUNTIME_ERROR)
    finally:
        if (
            restored_source_audio
            and source_audio_path
            and config is not None
            and not restored_source_audio_deleted
            and not config.get("privacy", {}).get("preserve_extracted_audio", False)
        ):
            try:
                _delete_restored_diarization_audio(config, job_id, source_audio_path)
            except Exception:
                logging.exception("Failed to clean up restored diarization audio")
        with GENERATION_STATUS_LOCK:
            _end_generation(generation_key)


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
            input_fingerprint = _generation_input_fingerprint(result_data, segments)

            summary = result_data.setdefault("summary", {})
            status = _ensure_generation_status(summary)
            if status.get("summary") == "generating":
                raise HTTPException(status_code=409, detail="Summary is already being generated")
            had_existing_summary_content = _has_existing_summary_content(summary)
            previous_summary_status = status.get("summary") if isinstance(status.get("summary"), str) else "not_started"
            generation_key = _begin_generation(job_id, "summary")
            status["summary"] = "generating"
            if had_saved_result:
                _save_job_result(job_id, result_data)

        try:
            config = load_config()
            readiness = await asyncio.to_thread(_summary_model_readiness, config)
            if not readiness["ready"]:
                summary_data = _skipped_summary(readiness["message"])
            else:
                summary_data = await asyncio.to_thread(
                    lambda: summarize_meeting(
                        segments,
                        _resolve_summary_model(config),
                        meeting_context={
                            "title": result_data.get("summary", {}).get("title", ""),
                            "date": result_data.get("created_at", ""),
                            "meeting_purpose": result_data.get("meeting_purpose", ""),
                        },
                    )
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
            if _generation_input_fingerprint(latest_result, get_transcript_segments(latest_result)) != input_fingerprint:
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

            summary_state = (
                _summary_status(summary_data)
                if isinstance(summary_data.get("generation_status"), dict)
                else "completed"
            )
            if summary_state == "skipped" and had_existing_summary_content:
                latest_status["summary"] = previous_summary_status if previous_summary_status != "generating" else "completed"
                latest_summary["generation_status"] = latest_status
                _save_job_result(job_id, latest_result)
                raise HTTPException(status_code=409, detail="summary_model_not_ready")
            latest_summary.update(summary_data)
            latest_summary["topic_sections"] = []
            latest_summary["speaker_context_summaries"] = []
            latest_summary["participant_summaries"] = []
            latest_status["summary"] = summary_state
            if summary_state == "completed":
                latest_status["topic_sections"] = "not_started"
                latest_status["speaker_context_summaries"] = "not_started"
            elif summary_state == "skipped":
                latest_status["topic_sections"] = "skipped"
                latest_status["speaker_context_summaries"] = "skipped"
            else:
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
            input_fingerprint = _generation_input_fingerprint(result_data, segments)

            summary = result_data.setdefault("summary", {})
            summary_fingerprint = _summary_generation_fingerprint(summary)
            status = _ensure_generation_status(summary)
            if status.get("topic_sections") == "generating":
                raise HTTPException(status_code=409, detail="Topic sections are already being generated")
            if status.get("summary") == "skipped":
                raise HTTPException(status_code=409, detail="summary_model_not_ready")
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
                    _mark_generation_failed(job_id, result_data, "topic_sections", "topic_generation_error")
            logging.exception("Failed to generate topic sections")
            raise HTTPException(status_code=500, detail="Failed to generate topic sections")

        topic_sections = _valid_generated_topic_sections(topic_sections)
        if not topic_sections:
            with GENERATION_STATUS_LOCK:
                if os.path.exists(_get_job_result_path(job_id)):
                    _mark_generation_failed(job_id, result_data, "topic_sections", DETAIL_TOPIC_EMPTY_RESULT)
            raise HTTPException(status_code=502, detail=DETAIL_TOPIC_EMPTY_RESULT)

        with GENERATION_STATUS_LOCK:
            latest_result = _load_latest_generation_result(job_id, result_data)
            latest_summary = latest_result.setdefault("summary", {})
            if (
                _segment_fingerprint(get_transcript_segments(latest_result)) != segments_fingerprint
                or _generation_input_fingerprint(latest_result, get_transcript_segments(latest_result)) != input_fingerprint
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
            _clear_speaker_context_after_topic_change(latest_summary, latest_status)
            latest_summary["generation_status"] = latest_status
            latest_summary.pop("generation_error_detail", None)
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
            "speaker_context_summaries": summary.get("speaker_context_summaries", []),
            "participant_summaries": summary.get("participant_summaries", []),
            "outputs": outputs,
            "export_error": export_error,
        }
    finally:
        with GENERATION_STATUS_LOCK:
            _end_generation(generation_key)


@app.post("/api/outputs/{job_id}/generate-topic-section")
async def generate_output_topic_section(job_id: str, payload: dict | None = Body(None)) -> dict:
    from pipeline.transcript_display import get_transcript_segments

    job_id = _validate_job_id(job_id)
    payload = payload or {}
    topic_title = str(
        payload.get("topicTitle")
        or payload.get("topic_title")
        or payload.get("title")
        or ""
    ).strip()
    if not topic_title:
        raise HTTPException(status_code=400, detail="Topic title is required")

    generation_key = None
    try:
        with GENERATION_STATUS_LOCK:
            result_data, had_saved_result = _load_or_rebuild_job_result(job_id, payload, persist_rebuilt=False)
            segments = get_transcript_segments(result_data)
            if not segments:
                raise HTTPException(status_code=400, detail="Transcript segments are required")
            segments_fingerprint = _segment_fingerprint(segments)
            input_fingerprint = _generation_input_fingerprint(result_data, segments)

            summary = result_data.setdefault("summary", {})
            summary_fingerprint = _summary_generation_fingerprint(summary)
            status = _ensure_generation_status(summary)
            if status.get("topic_sections") == "generating":
                raise HTTPException(status_code=409, detail="Topic sections are already being generated")
            if status.get("summary") == "skipped":
                raise HTTPException(status_code=409, detail="summary_model_not_ready")
            generation_key = _begin_generation(job_id, "topic_sections")
            status["topic_sections"] = "generating"
            if had_saved_result:
                _save_job_result(job_id, result_data)

        try:
            config = load_config()
            readiness = await asyncio.to_thread(_summary_model_readiness, config)
            if not readiness["ready"]:
                raise HTTPException(status_code=409, detail="summary_model_not_ready")

            from pipeline.summarize import generate_topic_section_for_title

            topic_section = await asyncio.to_thread(
                generate_topic_section_for_title,
                segments,
                summary,
                topic_title,
                _resolve_summary_model(config),
            )
        except HTTPException:
            with GENERATION_STATUS_LOCK:
                if os.path.exists(_get_job_result_path(job_id)):
                    _restore_topic_section_status_after_custom_failure(job_id, result_data, "not_started")
            raise
        except Exception:
            with GENERATION_STATUS_LOCK:
                if os.path.exists(_get_job_result_path(job_id)):
                    _restore_topic_section_status_after_custom_failure(
                        job_id,
                        result_data,
                        "failed",
                        "topic_generation_error",
                    )
            logging.exception("Failed to generate topic section")
            raise HTTPException(status_code=500, detail="Failed to generate topic section")

        if not topic_section:
            with GENERATION_STATUS_LOCK:
                if os.path.exists(_get_job_result_path(job_id)):
                    _restore_topic_section_status_after_custom_failure(
                        job_id,
                        result_data,
                        "failed",
                        DETAIL_TOPIC_EMPTY_RESULT,
                    )
            raise HTTPException(status_code=502, detail=DETAIL_TOPIC_EMPTY_RESULT)

        with GENERATION_STATUS_LOCK:
            latest_result = _load_latest_generation_result(job_id, result_data)
            latest_summary = latest_result.setdefault("summary", {})
            if (
                _segment_fingerprint(get_transcript_segments(latest_result)) != segments_fingerprint
                or _generation_input_fingerprint(latest_result, get_transcript_segments(latest_result)) != input_fingerprint
                or _summary_generation_fingerprint(latest_summary) != summary_fingerprint
            ):
                latest_status = _ensure_generation_status(latest_summary)
                latest_status["topic_sections"] = "not_started"
                if os.path.exists(_get_job_result_path(job_id)):
                    _save_job_result(job_id, latest_result)
                raise HTTPException(status_code=409, detail=DETAIL_TOPIC_INPUT_CHANGED)

            latest_status = _ensure_generation_status(latest_summary)
            existing_sections = [
                section
                for section in latest_summary.get("topic_sections", [])
                if isinstance(section, dict) and section.get("topic")
            ]
            topic_key = topic_title.strip().casefold()
            replaced = False
            next_sections = []
            for section in existing_sections:
                if str(section.get("topic", "")).strip().casefold() == topic_key:
                    next_sections.append(topic_section)
                    replaced = True
                else:
                    next_sections.append(section)
            if not replaced:
                next_sections.append(topic_section)

            latest_summary["topic_sections"] = next_sections
            existing_topics = [topic for topic in latest_summary.get("topics", []) if isinstance(topic, str) and topic.strip()]
            latest_summary["topics"] = list(dict.fromkeys(existing_topics + [section["topic"] for section in next_sections if section.get("topic")]))
            latest_status["topic_sections"] = "completed" if len(next_sections) >= 1 else "not_started"
            _clear_speaker_context_after_topic_change(latest_summary, latest_status)
            latest_summary["generation_status"] = latest_status
            latest_summary.pop("generation_error_detail", None)
            _save_job_result(job_id, latest_result)
            result_data = latest_result
            summary = latest_summary
            status = latest_status

        export_error = None
        try:
            outputs = _refresh_summary_exports(job_id, result_data)
        except Exception:
            logging.exception("Failed to refresh exports after custom topic section generation")
            outputs = _result_outputs(job_id)
            export_error = "정리는 완료됐지만 다운로드 파일 갱신은 실패했습니다."

        return {
            "job_id": job_id,
            "topic_section": topic_section,
            "topic_sections": summary.get("topic_sections", []),
            "topics": summary.get("topics", []),
            "generation_status": status,
            "speaker_context_summaries": summary.get("speaker_context_summaries", []),
            "participant_summaries": summary.get("participant_summaries", []),
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
            input_fingerprint = _generation_input_fingerprint(result_data, segments)

            summary = result_data.setdefault("summary", {})
            summary_fingerprint = _summary_generation_fingerprint(summary)
            status = _ensure_generation_status(summary)
            topic_sections = summary.get("topic_sections") or []
            valid_topic_section_count = len([section for section in topic_sections if isinstance(section, dict) and section.get("topic")])
            if status.get("topic_sections") != "completed" or valid_topic_section_count < 1:
                raise HTTPException(
                    status_code=409,
                    detail="Topic sections must be generated before speaker context summaries",
                )
            if status.get("summary") == "skipped":
                raise HTTPException(status_code=409, detail="summary_model_not_ready")
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
                    _mark_generation_failed(
                        job_id,
                        result_data,
                        "speaker_context_summaries",
                        "speaker_context_generation_error",
                    )
            logging.exception("Failed to generate speaker context summaries")
            raise HTTPException(status_code=500, detail="Failed to generate speaker context summaries")

        if not speaker_context_summaries:
            with GENERATION_STATUS_LOCK:
                if os.path.exists(_get_job_result_path(job_id)):
                    _mark_generation_failed(
                        job_id,
                        result_data,
                        "speaker_context_summaries",
                        DETAIL_SPEAKER_EMPTY_RESULT,
                    )
            raise HTTPException(status_code=502, detail=DETAIL_SPEAKER_EMPTY_RESULT)

        with GENERATION_STATUS_LOCK:
            latest_result = _load_latest_generation_result(job_id, result_data)
            latest_summary = latest_result.setdefault("summary", {})
            if (
                _segment_fingerprint(get_transcript_segments(latest_result)) != segments_fingerprint
                or _generation_input_fingerprint(latest_result, get_transcript_segments(latest_result)) != input_fingerprint
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
            latest_summary.pop("generation_error_detail", None)
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
    safe = safe.strip(".- ")
    safe = safe[:MAX_EXPORT_STEM_CHARS].rstrip(".- ")
    return f"{safe or 'meeting-minutes'}.{extension}"


def _safe_export_id(value: str) -> str:
    safe = re.sub(r"[^A-Za-z0-9_.-]+", "_", value.strip())
    safe = safe.strip("._-")
    return safe[:80] or "record"


def _unique_download_path(filename: str) -> Path:
    downloads_dir = Path.home() / "Downloads"
    if not downloads_dir.exists():
        downloads_dir = Path.home()
    downloads_dir.mkdir(parents=True, exist_ok=True)

    candidate = downloads_dir / filename
    stem = candidate.stem
    suffix = candidate.suffix
    counter = 1
    while candidate.exists():
        candidate = downloads_dir / f"{stem}_{counter}{suffix}"
        counter += 1
    return candidate


def _allowed_save_copy_origins() -> set[str]:
    configured = os.environ.get("MEETING_AI_SAVE_COPY_ALLOWED_ORIGINS", "")
    origins = {
        "http://localhost:5173",
        "http://127.0.0.1:5173",
        "http://localhost:3000",
        "http://127.0.0.1:3000",
        "http://tauri.localhost",
        "https://tauri.localhost",
        "tauri://localhost",
    }
    origins.update(origin.strip() for origin in configured.split(",") if origin.strip())
    return origins


def _require_save_copy_origin(request: Request) -> None:
    origin = request.headers.get("origin")
    if not origin or origin not in _allowed_save_copy_origins():
        raise HTTPException(status_code=403, detail="Save-copy is only available from the desktop app")


def _resolve_config_ffmpeg_path(config: dict) -> str:
    ffmpeg_path = str(config.get("paths", {}).get("ffmpeg") or "ffmpeg")
    if ffmpeg_path.lower() != "ffmpeg" and not os.path.isabs(ffmpeg_path):
        ffmpeg_path = os.path.normpath(os.path.join(BASE_DIR, ffmpeg_path))
    return ffmpeg_path


def _validate_audio_extract_filename(filename: str | None) -> str:
    suffix = Path(filename or "").suffix.lower()
    if not suffix or suffix not in AUDIO_EXTRACT_SOURCE_EXTENSIONS:
        raise HTTPException(status_code=400, detail="지원하지 않는 파일 형식입니다.")
    return suffix


def _audio_extract_error_message(error: Exception) -> str:
    raw_message = str(error)
    normalized = raw_message.lower()
    no_audio_markers = (
        "does not contain any stream",
        "matches no streams",
        "stream map",
        "output file does not contain any stream",
        "audio:0kib",
    )
    if any(marker in normalized for marker in no_audio_markers):
        return "선택한 파일에서 음성 트랙을 찾지 못했습니다."
    if "ffmpeg를 찾을 수 없습니다" in raw_message:
        return "음성 추출 도구를 찾지 못했습니다."
    return "음성 파일로 저장하지 못했습니다."


async def _save_upload_to_path(file: UploadFile, path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("wb") as buffer:
        while chunk := await file.read(1024 * 1024):
            buffer.write(chunk)


def _path_is_within(path: str, root: str) -> bool:
    try:
        return os.path.commonpath([os.path.abspath(path), os.path.abspath(root)]) == os.path.abspath(root)
    except ValueError:
        return False


def _resolve_job_audio_path(config: dict, job_id: str) -> str | None:
    temp_dir = os.path.abspath(resolve_config_path(config["paths"]["temp_dir"]))
    checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
    jobs_root = os.path.abspath(os.path.join(temp_dir, "jobs"))
    candidates = [
        os.path.abspath(checkpoint_paths.source_wav_path),
        os.path.abspath(os.path.join(checkpoint_paths.root_dir, "source.wav")),
    ]
    for candidate in candidates:
        if _path_is_within(candidate, jobs_root) and os.path.exists(candidate):
            return candidate
    return None


def _safe_source_filename(value) -> str:
    if not isinstance(value, str):
        return ""
    normalized = value.strip().replace("\\", "/")
    filename = normalized.rsplit("/", 1)[-1].strip()
    if not filename or filename in {".", ".."}:
        return ""
    return filename


def _source_filename_candidates(*payloads: dict | None) -> list[str]:
    candidates: list[str] = []
    seen: set[str] = set()

    def add(value) -> None:
        filename = _safe_source_filename(value)
        key = filename.casefold()
        if filename and key not in seen:
            candidates.append(filename)
            seen.add(key)

    for payload in payloads:
        if not isinstance(payload, dict):
            continue
        add(payload.get("sourceFile"))
        add(payload.get("source_file"))
        add(payload.get("source_filename"))
        meeting = payload.get("meeting")
        if isinstance(meeting, dict):
            add(meeting.get("sourceFile"))
            add(meeting.get("source_file"))
            add(meeting.get("source_filename"))
    return candidates


def _source_filename_match_keys(filename: str) -> set[str]:
    collapsed = re.sub(r"\s+", " ", filename).strip()
    compact = re.sub(r"[\s_]+", "", filename)
    return {filename.casefold(), collapsed.casefold(), compact.casefold()}


def _is_recoverable_source_filename(filename: str) -> bool:
    return Path(filename).suffix.casefold() in RECOVERABLE_SOURCE_EXTENSIONS


def _known_source_roots() -> list[str]:
    project_root = os.path.abspath(os.path.dirname(BASE_DIR))
    roots = [
        os.path.join(project_root, "releases", "lmo_audio"),
        os.path.join(project_root, "video"),
        os.path.join(project_root, "samples"),
    ]
    unique_roots: list[str] = []
    seen: set[str] = set()
    for root in roots:
        root = os.path.abspath(root)
        key = os.path.normcase(root)
        if key not in seen and os.path.isdir(root):
            unique_roots.append(root)
            seen.add(key)
    return unique_roots


def _resolve_job_upload_source_path(config: dict, job_id: str, source_filenames: list[str]) -> str | None:
    temp_dir = os.path.abspath(resolve_config_path(config["paths"]["temp_dir"]))
    checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
    upload_root = os.path.abspath(checkpoint_paths.upload_dir)
    candidates: list[str] = []

    for filename in source_filenames:
        if not _is_recoverable_source_filename(filename):
            continue
        suffix = Path(filename).suffix
        if suffix:
            candidates.append(os.path.abspath(get_job_upload_path(checkpoint_paths, suffix)))

    seen: set[str] = set()
    for candidate in candidates:
        key = os.path.normcase(candidate)
        if key in seen:
            continue
        seen.add(key)
        if (
            _path_is_within(candidate, upload_root)
            and os.path.isfile(candidate)
            and os.path.getsize(candidate) > 0
        ):
            return candidate
    return None


def _resolve_known_source_file_path(source_filenames: list[str]) -> str | None:
    source_filenames = [
        filename
        for filename in source_filenames
        if _is_recoverable_source_filename(filename)
    ]
    if not source_filenames:
        return None

    roots = _known_source_roots()
    for filename in source_filenames:
        for root in roots:
            candidate = os.path.abspath(os.path.join(root, filename))
            if _path_is_within(candidate, root) and os.path.isfile(candidate):
                return candidate

    match_keys: set[str] = set()
    for filename in source_filenames:
        match_keys.update(_source_filename_match_keys(filename))

    for root in roots:
        matches: list[str] = []
        try:
            for entry in os.scandir(root):
                if not entry.is_file():
                    continue
                if _source_filename_match_keys(entry.name) & match_keys:
                    matches.append(os.path.abspath(entry.path))
        except OSError:
            continue
        if len(matches) == 1:
            return matches[0]
        if len(matches) > 1:
            logging.warning("Ambiguous source file match for diarization restore: %s", matches)
            return None
    return None


def _resolve_recoverable_source_path(
    config: dict,
    job_id: str,
    payload: dict | None,
    result_data: dict | None,
) -> str | None:
    temp_dir = os.path.abspath(resolve_config_path(config["paths"]["temp_dir"]))
    checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
    state = _load_job_state(checkpoint_paths)
    source_filenames = _source_filename_candidates(payload, result_data, state)

    upload_source_path = _resolve_job_upload_source_path(config, job_id, source_filenames)
    if upload_source_path:
        return upload_source_path
    return _resolve_known_source_file_path(source_filenames)


def _restore_job_audio_path_for_diarization(
    config: dict,
    job_id: str,
    source_path: str,
) -> str | None:
    from pipeline.audio_preprocess import convert_to_wav

    source_path = os.path.abspath(source_path)
    if not os.path.isfile(source_path):
        return None

    temp_dir = os.path.abspath(resolve_config_path(config["paths"]["temp_dir"]))
    checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
    state = _load_job_state(checkpoint_paths)
    jobs_root = os.path.abspath(os.path.join(temp_dir, "jobs"))
    source_wav_path = os.path.abspath(checkpoint_paths.source_wav_path)
    if not _path_is_within(source_wav_path, jobs_root):
        return None

    ensure_job_checkpoint_dirs(checkpoint_paths)
    ffmpeg_path = str(config.get("paths", {}).get("ffmpeg") or "ffmpeg")
    if ffmpeg_path.lower() != "ffmpeg" and not os.path.isabs(ffmpeg_path):
        ffmpeg_path = os.path.normpath(os.path.join(BASE_DIR, ffmpeg_path))

    restore_preprocessing = state.get("preprocessing_config")
    if not isinstance(restore_preprocessing, dict):
        restore_preprocessing = config.get("preprocessing", {})

    preprocess_result = convert_to_wav(
        source_path,
        source_wav_path,
        ffmpeg_path,
        preprocessing=restore_preprocessing,
    )
    if not os.path.isfile(source_wav_path) or os.path.getsize(source_wav_path) <= 0:
        return None

    preprocessing_applied = (
        preprocess_result.get("preprocessing", {})
        if isinstance(preprocess_result, dict)
        else {}
    )
    source_filename = os.path.basename(source_path)
    _write_job_state(checkpoint_paths, {
        "source_file": source_filename,
        "source_filename": source_filename,
        "source_wav_completed": True,
        "source_wav_deleted": False,
        "source_wav_path": source_wav_path,
        "source_wav_size": os.path.getsize(source_wav_path),
        "source_wav_restored": True,
        "source_wav_restored_from": source_filename,
        "preprocessing_config": restore_preprocessing,
        "preprocessing_applied": preprocessing_applied,
        "preserve_source_audio": bool(config.get("privacy", {}).get("preserve_extracted_audio", False)),
        "resume_supported": True,
    })
    return source_wav_path


def _delete_restored_diarization_audio(config: dict, job_id: str, source_audio_path: str) -> bool:
    temp_dir = os.path.abspath(resolve_config_path(config["paths"]["temp_dir"]))
    checkpoint_paths = build_job_checkpoint_paths(temp_dir, job_id)
    jobs_root = os.path.abspath(os.path.join(temp_dir, "jobs"))
    source_audio_path = os.path.abspath(source_audio_path)
    if not _path_is_within(source_audio_path, jobs_root) or not os.path.exists(source_audio_path):
        return False
    os.remove(source_audio_path)
    _write_job_state(checkpoint_paths, {
        "source_wav_completed": False,
        "source_wav_deleted": True,
        "source_wav_deleted_at": datetime.now().isoformat(),
    })
    return True


def _copy_file_atomic(source_path: str, target_path: Path) -> None:
    temp_path = target_path.with_name(f".{target_path.name}.{time.time_ns()}.part")
    try:
        with open(source_path, "rb") as source, open(temp_path, "xb") as target:
            shutil.copyfileobj(source, target, length=1024 * 1024)
        os.replace(temp_path, target_path)
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise


def _export_record_to_download_path(kind: str, payload: dict, target_path: Path) -> dict:
    temp_path = target_path.with_name(f".{target_path.name}.{time.time_ns()}.part")
    try:
        result_data = _export_record_to_path(kind, payload, str(temp_path))
        os.replace(temp_path, target_path)
        return result_data
    except Exception:
        try:
            temp_path.unlink(missing_ok=True)
        except Exception:
            pass
        raise


def _auto_save_completed_outputs(
    *,
    result_data: dict,
    title: str,
    hwpx_path: str | None,
    audio_path: str | None,
    privacy_config: dict,
) -> tuple[dict[str, str], dict[str, str]]:
    saved: dict[str, str] = {}
    errors: dict[str, str] = {}
    safe_title = title or result_data.get("summary", {}).get("title") or "회의록"

    if privacy_config.get("auto_save_hwpx_copy", False) and (not hwpx_path or not os.path.exists(hwpx_path)):
        errors["hwpx"] = "HWPX 파일이 아직 만들어지지 않았습니다."
    elif privacy_config.get("auto_save_hwpx_copy", False):
        try:
            target_path = _unique_download_path(_safe_export_name(safe_title, "hwpx"))
            _copy_file_atomic(str(hwpx_path), target_path)
            saved["hwpx"] = str(target_path)
        except Exception as exc:
            logging.exception("Failed to auto-save HWPX copy")
            errors["hwpx"] = str(exc) or "HWPX 자동 저장 실패"

    if privacy_config.get("auto_save_audio_copy", False) and (not audio_path or not os.path.exists(audio_path)):
        errors["audio"] = "음성 파일이 아직 만들어지지 않았습니다."
    elif privacy_config.get("auto_save_audio_copy", False):
        try:
            target_path = _unique_download_path(_safe_export_name(f"{safe_title}_음성", "wav"))
            _copy_file_atomic(str(audio_path), target_path)
            saved["audio"] = str(target_path)
        except Exception as exc:
            logging.exception("Failed to auto-save audio copy")
            errors["audio"] = str(exc) or "음성 파일 자동 저장 실패"

    return saved, errors


def _export_record_to_path(kind: str, payload: dict, output_path: str) -> dict:
    result_data = _meeting_record_to_export_result(payload)
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
    elif kind == "hwpx":
        from pipeline.export_hwpx import export_hwpx

        export_hwpx(result_data, output_path)
    else:
        raise HTTPException(status_code=404, detail="Unknown export type")
    return result_data


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


def _payload_speaker_labels(payload: dict) -> dict[str, str]:
    if "speakerLabels" in payload:
        return _normalize_speaker_labels(payload.get("speakerLabels"))
    if "speaker_labels" in payload:
        return _normalize_speaker_labels(payload.get("speaker_labels"))
    return {}


def _payload_has_key(payload: dict, *keys: str) -> bool:
    return any(key in payload for key in keys)


def _payload_segments(payload: dict, *keys: str) -> list:
    for key in keys:
        value = payload.get(key)
        if isinstance(value, list):
            return value
    return []


def _normalize_payload_segments(
    items: list,
    speaker_labels: dict[str, str],
    *,
    speaker_fallback_when_unlabeled: bool = False,
) -> list[dict]:
    segments = []
    for segment in items or []:
        speaker = (
            segment.get("speaker")
            or segment.get("speaker_id")
            or segment.get("speaker_name")
            or ""
        )
        speaker = str(speaker or "").strip()
        fallback_speaker = (
            speaker
            if speaker_fallback_when_unlabeled and speaker
            else (
                segment.get("displaySpeaker")
                or segment.get("display_speaker")
                or segment.get("speaker_name")
                or speaker
            )
        )
        display_speaker = _speaker_label_for_export(speaker_labels, speaker, str(fallback_speaker or ""))
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
    has_speaker_labels = _payload_has_key(payload, "speakerLabels", "speaker_labels")
    speaker_labels = _payload_speaker_labels(payload)
    segments = _normalize_payload_segments(
        _payload_segments(payload, "segments"),
        speaker_labels,
        speaker_fallback_when_unlabeled=has_speaker_labels,
    )
    edited_payload_segments = _payload_segments(payload, "editedDisplaySegments", "edited_display_segments")
    base_display_segments = _payload_segments(payload, "displaySegments", "display_segments", "sentenceSegments", "sentence_segments")
    if edited_payload_segments:
        display_source_segments = edited_payload_segments
    elif _payload_has_key(payload, "editedDisplaySegments", "edited_display_segments"):
        display_source_segments = base_display_segments
    else:
        display_source_segments = base_display_segments
    display_segments = _normalize_payload_segments(
        display_source_segments,
        speaker_labels,
        speaker_fallback_when_unlabeled=has_speaker_labels,
    )

    title = str(payload.get("title") or "회의록")
    speaker_context_summaries = _speaker_context_summaries_for_export(
        payload.get("speakerContextSummaries") or payload.get("speaker_context_summaries") or [],
        speaker_labels,
        speaker_fallback_when_unlabeled=has_speaker_labels,
    )
    participant_summaries = _participant_summaries_for_export(
        payload.get("participantSummaries") or payload.get("participant_summaries") or [],
        speaker_context_summaries,
        speaker_labels,
        speaker_fallback_when_unlabeled=has_speaker_labels,
    )
    return {
        "job_id": payload.get("jobId") or payload.get("id") or datetime.now().strftime("%Y%m%d_%H%M%S"),
        "source_file": payload.get("sourceFile") or "",
        "created_at": payload.get("date") or datetime.now().isoformat(timespec="seconds"),
        "participants": payload.get("participants") or "",
        "meeting_purpose": payload.get("meetingPurpose") or payload.get("meeting_purpose") or "",
        "segments": segments,
        "display_segments": display_segments,
        "speaker_labels": speaker_labels,
        "settings": {
            "diarization_skipped": bool(payload.get("diarizationSkipped") or payload.get("diarization_skipped")),
            "diarization_skip_message": payload.get("diarizationSkipMessage") or payload.get("diarization_skip_message") or "",
        },
        "summary": {
            "title": title,
            "overview": _participant_copy_value(payload.get("summary") or ""),
            "topics": _participant_copy_value(payload.get("topics") or []),
            "topic_sections": _participant_copy_value(payload.get("topicSections") or payload.get("topic_sections") or []),
            "participant_summaries": participant_summaries,
            "speaker_context_summaries": speaker_context_summaries,
            "generation_status": payload.get("generationStatus") or payload.get("generation_status") or {},
            "actions": _participant_copy_value(payload.get("actions") or []),
            "decisions": _participant_copy_value(payload.get("decisions") or []),
            "needs_check": _participant_copy_value(payload.get("needs_check") or payload.get("needsCheck") or []),
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
    if "meetingPurpose" in payload or "meeting_purpose" in payload:
        result_data["meeting_purpose"] = payload.get("meetingPurpose") or payload.get("meeting_purpose") or ""
    if "title" in payload:
        summary = result_data.setdefault("summary", {})
        summary["title"] = payload.get("title") or summary.get("title") or "회의록"
    return result_data


def _apply_payload_transcript_override(result_data: dict, payload: dict | None) -> dict:
    if not payload:
        return result_data

    result_data = _apply_payload_metadata_override(result_data, payload)
    has_speaker_labels = _payload_has_key(payload, "speakerLabels", "speaker_labels")
    speaker_labels = _payload_speaker_labels(payload)
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
    display_segments = _normalize_payload_segments(
        display_source_segments,
        speaker_labels,
        speaker_fallback_when_unlabeled=has_speaker_labels,
    )

    if has_display_override:
        result_data["display_segments"] = display_segments
    if has_speaker_labels:
        result_data["speaker_labels"] = speaker_labels
        result_data = _apply_speaker_labels_to_result_segments(
            result_data,
            speaker_labels,
            speaker_fallback_when_unlabeled=True,
        )
        result_data = _apply_speaker_labels_to_result_summary(
            result_data,
            speaker_fallback_when_unlabeled=True,
        )
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


def _generation_input_fingerprint(result_data: dict, segments: list[dict]) -> str:
    summary = result_data.get("summary") or {}
    normalized = {
        "segments": _segment_fingerprint(segments),
        "title": summary.get("title", ""),
        "created_at": result_data.get("created_at", ""),
        "meeting_purpose": result_data.get("meeting_purpose", ""),
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

    extension, media_type = allowed[kind]
    record_id = _safe_export_id(str(payload.get("jobId") or payload.get("id") or "record"))
    export_id = f"{record_id}_export_{datetime.now().strftime('%Y%m%d_%H%M%S_%f')}"
    output_path = os.path.abspath(os.path.join(output_dir, f"{export_id}_current.{extension}"))
    if not output_path.startswith(output_dir + os.sep):
        raise HTTPException(status_code=400, detail="Invalid export path")

    result_data = _export_record_to_path(kind, payload, output_path)

    filename = _safe_export_name(result_data["summary"]["title"], extension)
    return FileResponse(output_path, filename=filename, media_type=media_type)


@app.post("/api/export-record/{kind}/save-copy")
async def save_export_record_copy(kind: str, request: Request, payload: dict = Body(...)) -> dict:
    _require_save_copy_origin(request)
    allowed = {
        "txt": "txt",
        "md": "md",
        "docx": "docx",
        "hwpx": "hwpx",
    }
    if kind not in allowed:
        raise HTTPException(status_code=404, detail="Unknown export type")

    extension = allowed[kind]
    title = str(payload.get("title") or "회의록")
    target_path = _unique_download_path(_safe_export_name(title, extension))
    result_data = _export_record_to_download_path(kind, payload, target_path)
    return {
        "kind": kind,
        "saved_path": str(target_path),
        "size_bytes": target_path.stat().st_size,
        "title": result_data.get("summary", {}).get("title", title),
    }


def _build_analysis_storage_preflight(file_size_bytes: int | float | None, duration_seconds: float | int | None) -> dict:
    config = load_config()
    temp_dir = os.path.abspath(resolve_config_path(config["paths"]["temp_dir"]))
    output_dir = os.path.abspath(resolve_config_path(config["paths"]["output_dir"]))
    return build_analysis_storage_preflight(temp_dir, file_size_bytes, duration_seconds, output_dir)


@app.post("/api/analyze/preflight")
async def analyze_preflight(payload: dict = Body(...)) -> dict:
    return _build_analysis_storage_preflight(
        payload.get("file_size"),
        payload.get("duration_seconds"),
    )


@app.post("/api/analyze")
async def analyze_meeting(
    title: str = Form(...),
    date: str = Form(...),
    participants: str = Form(""),
    file: UploadFile = File(...),
    mode: str = Form("real"),
    job_id: str | None = Form(None),
    file_size: int | None = Form(None),
    file_last_modified: int | None = Form(None),
    resume_requested: bool = Form(False),
    meeting_purpose: str = Form(""),
) -> StreamingResponse:
    if not isinstance(meeting_purpose, str):
        meeting_purpose = ""
    if not isinstance(participants, str):
        participants = ""
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
                meeting_purpose=meeting_purpose,
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
            (65, "참석자 구분 mock 처리 중"),
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
                    "speaker": "참석자01",
                    "text": "FastAPI 서버가 업로드 요청을 정상적으로 받았습니다.",
                },
                {
                    "start": "00:00:06",
                    "end": "00:00:11",
                    "speaker": "참석자02",
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
async def cancel_analysis(job_id: str, payload: dict | None = Body(None)) -> dict:
    job_id = _validate_job_id(job_id)
    action = str((payload or {}).get("action") or "stop").strip().lower()
    if action not in {"stop", "cancel"}:
        raise HTTPException(status_code=400, detail="invalid_cancel_action")
    return {
        "job_id": job_id,
        "action": action,
        "cancel_requested": ANALYSIS_JOBS.cancel(job_id, action),
    }


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
    meeting_purpose: str = "",
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

    def report_progress(step: str, progress: int, metadata: dict | None = None) -> None:
        nonlocal last_progress, last_real_progress_at
        raise_if_cancelled()
        last_real_progress_at = time.monotonic()
        last_progress = {
            "type": "progress",
            "mode": "real",
            "progress": progress,
            "message": step,
            "status": "processing",
            **(metadata or {}),
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
            report_progress("참석자 구분 모델이 없어 STT 중심 분석으로 진행합니다.", 10)

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
            config["_meeting_context"] = {
                "title": title,
                "date": date,
                "participants": participants,
                "meeting_purpose": meeting_purpose,
            }
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
            result_settings = result_data.get("settings", {}) if isinstance(result_data, dict) else {}
            final_data = {
                "type": "result",
                "mode": "real",
                "progress": 100,
                "status": "completed",
                "meeting": {
                    "title": title,
                    "date": date,
                    "participants": participants,
                    "meeting_purpose": meeting_purpose,
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
                    "audio": f"/api/outputs/{result['job_id']}/audio" if result.get("audio_file") else None,
                },
                "auto_saved_files": result.get("auto_saved_files", {}),
                "auto_save_errors": result.get("auto_save_errors", {}),
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
                "diarization_skipped": bool(result_settings.get("diarization_skipped")),
                "diarization_applied": bool(result_settings.get("diarization")),
                "diarization_requested": bool(result_settings.get("diarization_requested")),
                "diarization_deferred": bool(result_settings.get("diarization_deferred")),
                "diarization_skip_message": str(result_settings.get("diarization_skip_message") or ""),
                "diarization_skip_reason": str(result_settings.get("diarization_skip_reason") or ""),
                "diarization_defer_message": str(result_settings.get("diarization_defer_message") or ""),
            }
            await queue.put(final_data)
            await queue.put("[DONE]")
        except AnalysisCancelledError as exc:
            cancel_action = ANALYSIS_JOBS.get_action(job_id) or "stop"
            cancelled_status = "stopped" if cancel_action == "stop" else "cancelled"
            cancelled_message = (
                "분석을 중지했습니다. 같은 파일을 선택하면 이어서 진행할 수 있습니다."
                if cancel_action == "stop"
                else str(exc)
            )
            _write_job_state(checkpoint_paths, {
                "stage": cancelled_status,
                "cancelled": True,
                "cancel_action": cancel_action,
                "resume_supported": cancel_action == "stop",
                "cleanup_policy": "delete_resume_artifacts" if cancel_action == "cancel" else "preserve_checkpoints",
                "last_heartbeat_at": datetime.now().isoformat(),
            })
            if cancel_action == "cancel":
                try:
                    _delete_resume_artifacts(job_id)
                except Exception:
                    logging.exception("Failed to delete cancelled analysis draft artifacts")
            await queue.put({
                "type": cancelled_status,
                "mode": "real",
                "progress": 0,
                "status": cancelled_status,
                "action": cancel_action,
                "message": cancelled_message,
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


def timestamp_to_seconds(value) -> float:
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


def numeric_transcript_segments(segments: list[dict]) -> list[dict]:
    numeric_segments: list[dict] = []
    for segment in segments or []:
        if not isinstance(segment, dict):
            continue
        start = timestamp_to_seconds(segment.get("start", 0.0))
        end = timestamp_to_seconds(segment.get("end", start))
        if end < start:
            end = start
        numeric_segments.append({
            **segment,
            "start": start,
            "end": end,
            "speaker": segment.get("speaker") or segment.get("speaker_name") or "참석자",
            "text": segment.get("text", ""),
        })
    return numeric_segments


def segments_for_ui(segments: list[dict]) -> list[dict]:
    return [
        {
            "start": seconds_to_timestamp(segment.get("start", 0.0)),
            "end": seconds_to_timestamp(segment.get("end", 0.0)),
            "speaker": segment.get("speaker") or segment.get("speaker_name") or "참석자",
            "displaySpeaker": segment.get("speaker_name") or segment.get("speaker") or "참석자",
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
    with CONFIG_LOCK:
        with open(full_path, "r", encoding="utf-8") as f:
            return normalize_app_config(json.load(f))


def save_config(config: dict, config_path: str = "config.json") -> None:
    full_path = os.path.join(BASE_DIR, config_path)
    with CONFIG_LOCK:
        with open(full_path, "w", encoding="utf-8") as f:
            json.dump(config, f, ensure_ascii=False, indent=2)
            f.write("\n")

def process_audio_pipeline(
    input_file: str,
    job_id: str = None,
    config: dict = None,
    progress_callback=None,
    cancel_event=None,
    meeting_context: dict | None = None,
) -> dict:
    from pipeline.align_speakers import align_segments_with_speakers
    from pipeline.audio_preprocess import convert_to_wav
    from pipeline.chunk_audio import apply_time_offset, get_wav_duration_seconds, split_wav_by_duration
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
    meeting_context = meeting_context or config.get("_meeting_context") or {}

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
    compatible_config_fingerprints = _analysis_compatible_config_fingerprints(config)
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
        or existing_state.get("config_fingerprint") not in compatible_config_fingerprints
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

    def _report_progress(step: str, prog: int, **extra):
        _raise_if_cancelled()
        print(f"[{prog}%] {step}")
        last_progress_payload = {
            "message": step,
            "progress": prog,
            "status": "processing",
            **extra,
        }
        state_update = {
            "stage": current_stage,
            "last_heartbeat_at": datetime.now().isoformat(),
            "last_progress": last_progress_payload,
        }
        if extra.get("transcript_ready"):
            state_update["transcript_ready"] = True
        _write_job_state(checkpoint_paths, state_update)
        if progress_callback:
            try:
                progress_callback(step, prog, dict(extra))
            except TypeError:
                progress_callback(step, prog)

    if resume_message:
        _report_progress(resume_message, 5)

    temp_wav_path = checkpoint_paths.source_wav_path
    out_json_path = os.path.join(output_dir, f"{job_id}_result.json")
    out_partial_json_path = os.path.join(output_dir, f"{job_id}_partial_result.json")
    out_partial_txt_path = os.path.join(output_dir, f"{job_id}_partial_transcript.txt")
    out_txt_path = os.path.join(output_dir, f"{job_id}_transcript.txt")
    out_md_path = os.path.join(output_dir, f"{job_id}_report.md")
    out_docx_path = os.path.join(output_dir, f"{job_id}_report.docx")
    out_hwpx_path = os.path.join(output_dir, f"{job_id}_report.hwpx")
    privacy_config = config.get("privacy", {})
    preserve_source_audio = bool(privacy_config.get("preserve_extracted_audio", False))

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
    can_reuse_source_wav = (
        bool(existing_state.get("source_wav_completed"))
        and os.path.exists(temp_wav_path)
        and os.path.getsize(temp_wav_path) > 0
        and existing_state.get("input_fingerprint") == input_fingerprint
        and existing_state.get("config_fingerprint") in compatible_config_fingerprints
    )
    if can_reuse_source_wav:
        _report_progress("저장된 음성 파일을 재사용합니다.", 10)
        preprocessing_applied = existing_state.get("preprocessing_applied", {})
    else:
        preprocess_result = convert_to_wav(
            input_file,
            temp_wav_path,
            ffmpeg_path,
            preprocessing=config.get("preprocessing", {}),
        )
        preprocessing_applied = preprocess_result.get("preprocessing", {}) if isinstance(preprocess_result, dict) else {}
    try:
        source_wav_duration = get_wav_duration_seconds(temp_wav_path)
    except Exception:
        source_wav_duration = float(existing_state.get("source_wav_duration") or 0.0)
    source_wav_size = os.path.getsize(temp_wav_path) if os.path.exists(temp_wav_path) else 0
    diarization_decision = _diarization_resource_decision(
        config,
        source_wav_duration,
        requested_override=_should_generate_diarization_during_analysis(config),
    )
    if diarization_decision.get("run") and not _should_generate_diarization_during_analysis(config):
        if _can_defer_diarization_for_later(config):
            diarization_decision = _defer_diarization_decision(diarization_decision)
        else:
            diarization_decision = _source_not_preserved_diarization_decision(diarization_decision)
    _write_job_state(checkpoint_paths, {
        "source_wav_completed": True,
        "source_wav_path": temp_wav_path,
        "source_wav_size": source_wav_size,
        "source_wav_duration": source_wav_duration,
        "preprocessing_config": copy.deepcopy(config.get("preprocessing", {})),
        "preprocessing_applied": preprocessing_applied,
        "diarization_decision": diarization_decision,
        "resume_supported": True,
        "preserve_source_audio": preserve_source_audio,
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

    def _chunk_path_allowed(path: str) -> bool:
        absolute_path = os.path.abspath(path)
        return (
            _path_is_within(absolute_path, chunk_dir)
            or os.path.normcase(absolute_path) == os.path.normcase(os.path.abspath(temp_wav_path))
        )

    def _chunk_entry(chunk: dict, idx: int) -> dict:
        path = os.path.abspath(str(chunk.get("path") or ""))
        return {
            **chunk,
            "path": path,
            "index": int(chunk.get("index", idx) or idx),
            "offset": float(chunk.get("offset", 0.0) or 0.0),
            "duration": float(chunk.get("duration", 0.0) or 0.0),
            "size_bytes": os.path.getsize(path) if os.path.exists(path) else 0,
        }

    def _chunk_manifest_entries(raw_chunks: list[dict]) -> list[dict]:
        return [_chunk_entry(chunk, idx) for idx, chunk in enumerate(raw_chunks)]

    def _manifest_chunks_are_reusable(manifest: dict) -> bool:
        raw_chunks = manifest.get("chunks")
        if not isinstance(raw_chunks, list):
            return False
        for idx, chunk in enumerate(raw_chunks):
            if not isinstance(chunk, dict):
                return False
            path = os.path.abspath(str(chunk.get("path") or ""))
            if not path or not _chunk_path_allowed(path) or not os.path.exists(path):
                return False
            if int(chunk.get("index", idx) or idx) != idx:
                return False
            expected_size = int(chunk.get("size_bytes") or 0)
            if expected_size and os.path.getsize(path) != expected_size:
                return False
        return True

    chunk_manifest = load_json_checkpoint(checkpoint_paths.chunk_manifest_path)
    can_reuse_chunks = (
        isinstance(chunk_manifest, dict)
        and chunk_manifest.get("input_fingerprint") == input_fingerprint
        and chunk_manifest.get("config_fingerprint") in compatible_config_fingerprints
        and int(chunk_manifest.get("source_wav_size") or 0) == int(source_wav_size or 0)
        and int(chunk_manifest.get("long_chunk_seconds") or 0) == long_chunk_seconds
        and bool(chunk_manifest.get("enable_chunking")) == bool(enable_chunking)
        and _manifest_chunks_are_reusable(chunk_manifest)
    )
    if can_reuse_chunks:
        _report_progress("저장된 음성 구간을 재사용합니다.", 25)
        chunks = _chunk_manifest_entries(chunk_manifest["chunks"])
    else:
        chunks = _chunk_manifest_entries(
            split_wav_by_duration(temp_wav_path, chunk_dir, long_chunk_seconds, ffmpeg_path)
            if enable_chunking
            else [{"path": temp_wav_path, "offset": 0.0, "duration": source_wav_duration, "index": 0}]
        )
        atomic_write_json(checkpoint_paths.chunk_manifest_path, {
            "input_fingerprint": input_fingerprint,
            "config_fingerprint": config_fingerprint,
            "source_wav_path": temp_wav_path,
            "source_wav_duration": source_wav_duration,
            "source_wav_size": source_wav_size,
            "enable_chunking": bool(enable_chunking),
            "long_chunk_seconds": long_chunk_seconds,
            "chunks": chunks,
        })
    _write_job_state(checkpoint_paths, {
        "chunk_count": len(chunks),
        "long_chunk_seconds": long_chunk_seconds,
        "chunks_manifest_completed": True,
        "resume_supported": True,
    })
    _raise_if_cancelled()

    stt_language = config["stt"].get("language", "ko")
    stt_device = config["stt"].get("device", "auto")
    stt_chunk_seconds = int(config["stt"].get("chunk_seconds", DEFAULT_STT_CHUNK_SECONDS))

    def _stt_chunk_checkpoint_metadata(chunk: dict, idx: int, execution_fingerprint: str) -> dict:
        path = os.path.abspath(str(chunk.get("path") or ""))
        return {
            "chunk_index": idx,
            "input_fingerprint": input_fingerprint,
            "config_fingerprint": config_fingerprint,
            "source_wav_size": source_wav_size,
            "source_wav_duration": source_wav_duration,
            "chunk_path": path,
            "chunk_size_bytes": os.path.getsize(path) if os.path.exists(path) else 0,
            "offset": float(chunk.get("offset", 0.0)),
            "duration": float(chunk.get("duration", 0.0) or 0.0),
            "stt_execution_fingerprint": execution_fingerprint,
        }

    def _stt_chunk_checkpoint_matches(checkpoint_payload: dict, chunk: dict, idx: int, execution_fingerprint: str) -> bool:
        if not isinstance(checkpoint_payload.get("segments"), list):
            return False
        expected = _stt_chunk_checkpoint_metadata(chunk, idx, execution_fingerprint)
        return (
            checkpoint_payload.get("chunk_index") == expected["chunk_index"]
            and checkpoint_payload.get("input_fingerprint") == expected["input_fingerprint"]
            and checkpoint_payload.get("config_fingerprint") in compatible_config_fingerprints
            and int(checkpoint_payload.get("source_wav_size") or 0) == int(expected["source_wav_size"] or 0)
            and abs(float(checkpoint_payload.get("source_wav_duration") or 0.0) - float(expected["source_wav_duration"] or 0.0)) < 0.001
            and os.path.normcase(os.path.abspath(str(checkpoint_payload.get("chunk_path") or ""))) == os.path.normcase(expected["chunk_path"])
            and int(checkpoint_payload.get("chunk_size_bytes") or 0) == int(expected["chunk_size_bytes"] or 0)
            and abs(float(checkpoint_payload.get("offset") or 0.0) - float(expected["offset"] or 0.0)) < 0.001
            and abs(float(checkpoint_payload.get("duration") or 0.0) - float(expected["duration"] or 0.0)) < 0.001
            and checkpoint_payload.get("stt_execution_fingerprint") == expected["stt_execution_fingerprint"]
        )

    def _transcribe_chunks(chunks_to_process, model_path, allow_internal_fallback):
        nonlocal reused_chunk_count
        collected_segments = []
        total = len(chunks_to_process)
        execution_fingerprint = _stt_execution_fingerprint(model_path, stt_device, stt_chunk_seconds)
        _set_stage("transcribing")

        def _mark_chunk_completed(idx: int) -> None:
            state = _load_job_state(checkpoint_paths)
            completed_indices = sorted(set(int(item) for item in state.get("completed_chunk_indices", []) + [idx]))
            _write_job_state(checkpoint_paths, {
                "completed_chunk_indices": completed_indices,
                "resume_supported": True,
            })

        for idx, chunk in enumerate(chunks_to_process):
            _raise_if_cancelled()
            progress = 30 + int((idx / max(total, 1)) * 35)
            message = f"Transcribing chunk {idx + 1}/{total}..."
            _report_progress(message, progress)
            chunk_checkpoint_path = get_stt_chunk_checkpoint_path(checkpoint_paths, idx)
            checkpoint_payload = load_json_checkpoint(chunk_checkpoint_path) if os.path.exists(chunk_checkpoint_path) else None
            if (
                checkpoint_payload
                and _stt_chunk_checkpoint_matches(checkpoint_payload, chunk, idx, execution_fingerprint)
            ):
                reused_chunk_count += 1
                _mark_chunk_completed(idx)
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
                    **_stt_chunk_checkpoint_metadata(chunk, idx, execution_fingerprint),
                    "segments": chunk_segments,
                })
                _mark_chunk_completed(idx)
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
    except AnalysisCancelledError:
        raise
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
    partial_display_segments = build_display_segments(copy.deepcopy(raw_stt_segments))
    partial_result_data = {
        "job_id": job_id,
        "source_file": os.path.basename(input_file),
        "created_at": datetime.now().isoformat(),
        "language": config["stt"]["language"],
        "meeting_purpose": (meeting_context or {}).get("meeting_purpose", ""),
        "settings": {
            "stt_model": stt_model_path,
            "diarization_model": config["paths"].get("diarization_model"),
            "llm_model": config["paths"].get("llm_model"),
            "diarization": False,
            "diarization_requested": bool(diarization_decision.get("requested")),
            "diarization_skipped": bool(diarization_decision.get("skipped")),
            "diarization_deferred": bool(diarization_decision.get("deferred")),
            "diarization_skip_reason": diarization_decision.get("skip_reason") or "",
            "diarization_skip_message": diarization_decision.get("skip_message") or "",
            "diarization_defer_message": diarization_decision.get("defer_message") or "",
            "diarization_resource_decision": diarization_decision,
            "summary": False,
            "preprocessing": preprocessing_applied,
            "partial": True,
        },
        "segments": raw_stt_segments,
        "raw_stt_segments": raw_stt_segments,
        "aligned_segments": copy.deepcopy(raw_stt_segments),
        "display_segments": partial_display_segments,
        "summary": {
            "title": (meeting_context or {}).get("title") or "회의록",
            "overview": "음성 인식까지 완료된 임시 저장본입니다.",
            "topics": [],
            "topic_sections": [],
            "participant_summaries": [],
            "speaker_context_summaries": [],
            "actions": [],
            "decisions": [],
            "needs_check": [],
            "generation_status": {
                "summary": "not_started",
                "topic_sections": "not_started",
                "speaker_context_summaries": "not_started",
            },
        },
    }
    save_result_json(partial_result_data, out_partial_json_path)
    export_txt(get_transcript_segments(partial_result_data), out_partial_txt_path)
    _write_job_state(checkpoint_paths, {
        "partial_result_path": out_partial_json_path,
        "partial_transcript_path": out_partial_txt_path,
        "stt_partial_saved": True,
        "resume_supported": True,
    })
    _report_progress(
        "대화록 저장이 완료되었습니다. 후속 정리를 확인하고 있습니다.",
        66,
        transcript_ready=True,
    )

    if not segments:
        print("[STT] No transcript segments were returned; skipping diarization and summary.")
        summary_data = {
            "overview": "음성 인식 결과가 없어 회의 요약을 만들지 못했습니다.",
        }
    else:
        summary_data = {}
    
    # 3. Diarization (Optional)
    if segments and diarization_decision.get("run"):
        try:
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
                and diarization_checkpoint.get("config_fingerprint") in compatible_config_fingerprints
                and diarization_checkpoint.get("segments_fingerprint") == segments_fingerprint
                and aligned_checkpoint.get("input_fingerprint") == input_fingerprint
                and aligned_checkpoint.get("config_fingerprint") in compatible_config_fingerprints
                and aligned_checkpoint.get("segments_fingerprint") == segments_fingerprint
                and display_checkpoint.get("input_fingerprint") == input_fingerprint
                and display_checkpoint.get("config_fingerprint") in compatible_config_fingerprints
                and display_checkpoint.get("segments_fingerprint") == segments_fingerprint
                and isinstance(aligned_checkpoint.get("segments"), list)
                and isinstance(display_checkpoint.get("segments"), list)
            )

            if can_reuse_diarization:
                _report_progress("이전 참석자 구분 결과를 재사용합니다.", 70)
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
                _report_progress("참석자 구간 확인 완료. 문장 시간과 맞추는 중", 78)
                segments = align_segments_with_speakers(segments, spk_segments)
                _write_job_state(checkpoint_paths, {
                    "diarization_completed": True,
                    "resume_supported": True,
                })
                aligned_segments = copy.deepcopy(segments)
                display_segments = build_display_segments(segments)
        except AnalysisCancelledError:
            raise
        except Exception as exc:
            logging.exception("Failed to run diarization during analysis")
            message = "참석자 구분 중 문제가 있어 회의록만 저장했습니다. 결과 화면에서 다시 실행할 수 있습니다."
            diarization_decision = _failed_diarization_decision(diarization_decision, message)
            _set_stage("diarization_skipped")
            _report_progress(message, 70)
            _write_job_state(checkpoint_paths, {
                "diarization_completed": False,
                "diarization_skipped": True,
                "diarization_error_detail": str(exc),
                "resume_supported": True,
            })
            segments = copy.deepcopy(raw_stt_segments)
            aligned_segments = copy.deepcopy(segments)
            display_segments = build_display_segments(segments)
    else:
        if segments and diarization_decision.get("deferred"):
            _set_stage("diarization_deferred")
            _report_progress(str(diarization_decision.get("defer_message") or "참석자 구분은 별도로 실행할 수 있습니다."), 70)
        elif segments and diarization_decision.get("skipped"):
            _set_stage("diarization_skipped")
            _report_progress(str(diarization_decision.get("skip_message") or "참석자 구분을 건너뜁니다."), 70)
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
        _raise_if_cancelled()
        if not _should_generate_summary_during_analysis(config):
            message = "대화록 생성이 완료되었습니다. 정리는 회의 기록에서 별도로 실행해 주세요."
            _report_progress(message, 85)
            summary_data = _skipped_summary(message)
        else:
            readiness = _summary_model_readiness(config)
            if not readiness["ready"]:
                _report_progress(readiness["message"], 85)
                summary_data = _skipped_summary(readiness["message"])
            else:
                _report_progress("Summarizing with Local LLM...", 85)
                llm_model = _resolve_summary_model(config)
                summary_data = summarize_meeting(
                    segments,
                    model_name_or_path=llm_model,
                    meeting_context=meeting_context or {},
                )
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
        "meeting_purpose": (meeting_context or {}).get("meeting_purpose", ""),
        "settings": {
            "stt_model": stt_model_path,
            "diarization_model": config["paths"].get("diarization_model"),
            "llm_model": config["paths"].get("llm_model"),
            "diarization": bool(diarization_decision.get("run")),
            "diarization_requested": bool(diarization_decision.get("requested")),
            "diarization_skipped": bool(diarization_decision.get("skipped")),
            "diarization_deferred": bool(diarization_decision.get("deferred")),
            "diarization_skip_reason": diarization_decision.get("skip_reason") or "",
            "diarization_skip_message": diarization_decision.get("skip_message") or "",
            "diarization_defer_message": diarization_decision.get("defer_message") or "",
            "diarization_resource_decision": diarization_decision,
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

    auto_save_privacy_config = dict(privacy_config)
    if not preserve_source_audio:
        auto_save_privacy_config["auto_save_audio_copy"] = False
    auto_saved_files, auto_save_errors = _auto_save_completed_outputs(
        result_data=result_data,
        title=str(meeting_context.get("title") or result_data.get("summary", {}).get("title") or "회의록"),
        hwpx_path=out_hwpx_path if summary_data else None,
        audio_path=temp_wav_path if os.path.exists(temp_wav_path) else None,
        privacy_config=auto_save_privacy_config,
    )
    
    if reused_diarization:
        if reused_chunk_count > 0:
            resume_mode = "reused_stt_and_diarization"
            resume_message = "이전 음성 인식 진행분과 참석자 구분 결과를 재사용했습니다."
        else:
            resume_mode = "reused_diarization"
            resume_message = "이전 참석자 구분 결과를 재사용했습니다."

    # Cleanup temp wav
    _write_job_state(checkpoint_paths, {
        "stage": "completed",
        "summary_completed": _summary_status(summary_data) == "completed" if summary_data else False,
        "summary_skipped": _summary_status(summary_data) == "skipped" if summary_data else False,
        "summary_failed": _summary_status(summary_data) == "failed" if summary_data else False,
        "diarization_completed": bool(diarization_decision.get("run") and segments),
        "diarization_skipped": bool(diarization_decision.get("skipped")),
        "diarization_deferred": bool(diarization_decision.get("deferred")),
        "resume_supported": True,
        "resume_mode": resume_mode,
        "resume_message": resume_message,
        "resume_fallback_reason": resume_fallback_reason,
    })

    if privacy_config.get("auto_delete_temp_audio", True):
        if os.path.isdir(chunk_dir):
            shutil.rmtree(chunk_dir, ignore_errors=True)
        if not preserve_source_audio and os.path.exists(temp_wav_path):
            os.remove(temp_wav_path)
            _write_job_state(checkpoint_paths, {
                "source_wav_completed": False,
                "source_wav_deleted": True,
                "resume_supported": False,
            })
            
    return {
        "success": True,
        "job_id": job_id,
        "json_file": out_json_path,
        "txt_file": out_txt_path,
        "md_file": out_md_path if summary_data else None,
        "docx_file": out_docx_path if summary_data else None,
        "hwpx_file": out_hwpx_path if summary_data else None,
        "audio_file": temp_wav_path if preserve_source_audio and os.path.exists(temp_wav_path) else None,
        "auto_saved_files": auto_saved_files,
        "auto_save_errors": auto_save_errors,
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
