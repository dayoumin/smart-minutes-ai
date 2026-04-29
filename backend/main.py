import argparse
import asyncio
import os
import json
import shutil
import sys
from datetime import datetime
from pathlib import Path
from typing import AsyncIterator

from fastapi import Body, FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse

from model_manager import download_model, get_model_status, missing_downloadable_models, model_exists, get_model_spec

BASE_DIR = os.path.abspath(
    os.environ.get(
        "MEETING_AI_BACKEND_DIR",
        getattr(sys, "_MEIPASS", os.path.dirname(os.path.abspath(__file__))),
    )
)

app = FastAPI(title="NIFS AI Meeting API")

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


@app.get("/api/health")
async def health_check() -> dict:
    return {"ok": True, "service": "NIFS AI Meeting API"}


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
            if mode not in {"auto", "loudnorm", "dynaudnorm"}:
                raise HTTPException(status_code=400, detail="preprocessing.normalization_mode must be auto, loudnorm, or dynaudnorm")
            target["normalization_mode"] = mode

    if "diarization" in payload:
        diarization = payload["diarization"] or {}
        if "enabled" in diarization:
            config.setdefault("diarization", {})["enabled"] = bool(diarization["enabled"])

    if "stt" in payload:
        stt = payload["stt"] or {}
        if "device" in stt:
            device = str(stt["device"])
            if device not in {"auto", "cpu", "cuda"}:
                raise HTTPException(status_code=400, detail="stt.device must be auto, cpu, or cuda")
            config.setdefault("stt", {})["device"] = device

    save_config(config)
    return await get_settings()


@app.get("/api/models/status")
async def models_status() -> dict:
    return get_model_status(BASE_DIR)


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


@app.post("/api/models/download")
async def download_missing_models(payload: dict | None = Body(default=None)) -> StreamingResponse:
    async def event_generator() -> AsyncIterator[str]:
        token = os.environ.get("HF_TOKEN")
        requested_keys = set((payload or {}).get("models") or [])
        if requested_keys:
            candidates = [get_model_spec(key) for key in requested_keys]
            missing = [spec for spec in candidates if not model_exists(BASE_DIR, spec)]
        else:
            missing = list(missing_downloadable_models(BASE_DIR, required_only=True))

        if not missing:
            yield sse_event({
                "type": "result",
                "status": "completed",
                "message": "필수 모델이 이미 준비되어 있습니다.",
                "models": get_model_status(BASE_DIR)["models"],
            }, event="result")
            yield sse_event("[DONE]", event="done")
            return

        total = len(missing)
        for index, spec in enumerate(missing, start=1):
            progress = int(((index - 1) / total) * 100)
            yield sse_event({
                "type": "progress",
                "status": "processing",
                "progress": progress,
                "message": f"{spec.label} 다운로드를 준비하고 있습니다.",
                "model": spec.key,
                "gated": spec.gated,
                "path": os.path.abspath(resolve_config_path(spec.local_dir)),
            }, event="progress")

            try:
                await asyncio.to_thread(download_model, BASE_DIR, spec, token)
            except Exception as exc:
                yield sse_event({
                    "type": "error",
                    "status": "error",
                    "progress": progress,
                    "message": f"{spec.label} 다운로드 실패: {exc}",
                    "model": spec.key,
                }, event="error")
                yield sse_event("[DONE]", event="done")
                return

            yield sse_event({
                "type": "progress",
                "status": "processing",
                "progress": int((index / total) * 100),
                "message": f"{spec.label} 다운로드 완료",
                "model": spec.key,
            }, event="progress")

        yield sse_event({
            "type": "result",
            "status": "completed",
            "progress": 100,
            "message": "모델 다운로드가 완료되었습니다.",
            "models": get_model_status(BASE_DIR)["models"],
        }, event="result")
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


@app.post("/api/analyze")
async def analyze_meeting(
    title: str = Form(...),
    date: str = Form(...),
    participants: str = Form(...),
    file: UploadFile = File(...),
    mode: str = Form("real"),
) -> StreamingResponse:
    if mode not in {"mock", "real"}:
        raise HTTPException(status_code=400, detail="mode must be 'mock' or 'real'")

    if mode == "real":
        return StreamingResponse(
            stream_real_analysis(title, date, participants, file),
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
            yield sse_event(
                {
                    "type": "progress",
                    "progress": progress,
                    "message": message,
                    "status": "processing",
                },
                event="progress",
            )

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
                "프론트엔드가 FastAPI 백엔드에 오디오 파일과 메타데이터를 전송했고, "
                "백엔드는 SSE 스트리밍으로 진행률과 최종 회의록 결과를 반환했습니다."
            ),
            "topics": ["엔드투엔드 연결", "SSE 진행률 스트리밍", "실제 AI 파이프라인 연동 준비"],
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
                {
                    "start": "00:00:12",
                    "end": "00:00:17",
                    "speaker": "Speaker 1",
                    "text": "이제 mock 결과를 실제 모델 출력으로 바꾸면 됩니다.",
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


async def stream_real_analysis(
    title: str,
    date: str,
    participants: str,
    file: UploadFile,
) -> AsyncIterator[str]:
    queue: asyncio.Queue[dict | str] = asyncio.Queue()
    loop = asyncio.get_running_loop()

    def report_progress(step: str, progress: int) -> None:
        loop.call_soon_threadsafe(
            queue.put_nowait,
            {
                "type": "progress",
                "mode": "real",
                "progress": progress,
                "message": step,
                "status": "processing",
            },
        )

    async def save_upload() -> str:
        config = load_config()
        temp_dir = resolve_config_path(config["paths"]["temp_dir"])
        os.makedirs(temp_dir, exist_ok=True)
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
        suffix = Path(file.filename or "upload").suffix
        upload_path = os.path.join(temp_dir, f"{timestamp}_upload{suffix}")

        with open(upload_path, "wb") as buffer:
            while chunk := await file.read(1024 * 1024):
                buffer.write(chunk)

        return upload_path

    async def prepare_real_config() -> dict:
        config = load_config()

        report_progress("Cohere STT 모델 확인 중", 6)
        stt_spec = get_model_spec("stt_primary")
        if not model_exists(BASE_DIR, stt_spec):
            raise RuntimeError(
                "Cohere Transcribe 모델이 없습니다. 설정 화면에서 다운로드하거나 "
                "모델 파일을 준비한 뒤 다시 실행해 주세요."
            )
        config["paths"]["stt_model"] = stt_spec.local_dir
        report_progress("Cohere STT 모델 준비 완료", 8)

        diarization_spec = get_model_spec("diarization")
        diarization_ready = model_exists(BASE_DIR, diarization_spec)

        if not diarization_ready:
            config["diarization"]["enabled"] = False
            report_progress("화자 분리 모델이 없어 STT 중심 분석으로 진행합니다.", 10)

        return config

    async def worker() -> None:
        upload_path = ""
        try:
            upload_path = await save_upload()
            await queue.put({
                "type": "progress",
                "mode": "real",
                "progress": 5,
                "message": "업로드 파일 저장 완료",
                "status": "processing",
            })

            config = await prepare_real_config()
            result = await asyncio.to_thread(
                process_audio_pipeline,
                upload_path,
                None,
                config,
                report_progress,
            )
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
                "actions": result_data.get("summary", {}).get("actions", []),
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
            if upload_path:
                config = load_config()
                if not config["privacy"].get("save_original_audio_copy", False) and os.path.exists(upload_path):
                    os.remove(upload_path)

    task = asyncio.create_task(worker())

    try:
        while True:
            payload = await queue.get()
            if payload == "[DONE]":
                yield sse_event("[DONE]", event="done")
                break
            event = payload.get("type") if isinstance(payload, dict) else None
            yield sse_event(payload, event=event)
    finally:
        if not task.done():
            task.cancel()
        try:
            await task
        except asyncio.CancelledError:
            pass


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

def load_config(config_path: str = "config.json") -> dict:
    # Resolve relative to script location for sidecar stability
    full_path = os.path.join(BASE_DIR, config_path)
    with open(full_path, "r", encoding="utf-8") as f:
        return json.load(f)


def save_config(config: dict, config_path: str = "config.json") -> None:
    full_path = os.path.join(BASE_DIR, config_path)
    with open(full_path, "w", encoding="utf-8") as f:
        json.dump(config, f, ensure_ascii=False, indent=2)
        f.write("\n")

def process_audio_pipeline(input_file: str, job_id: str = None, config: dict = None, progress_callback=None) -> dict:
    from pipeline.align_speakers import align_segments_with_speakers
    from pipeline.audio_preprocess import convert_to_wav
    from pipeline.chunk_audio import apply_time_offset, split_wav_by_duration
    from pipeline.diarize import diarize_audio
    from pipeline.export_docx import export_docx
    from pipeline.export_hwpx import export_hwpx
    from pipeline.export_markdown import export_markdown
    from pipeline.export_txt import export_txt, save_result_json
    from pipeline.summarize import summarize_meeting
    from pipeline.transcribe import is_cohere_model, transcribe_audio

    if config is None:
        config = load_config()
        
    def _report_progress(step: str, prog: int):
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
    
    # 1. Convert to WAV
    _report_progress("Converting to WAV...", 10)
    # ffmpeg path is safe to leave as-is if it's "ffmpeg" (system path), otherwise resolve
    ffmpeg_path = config["paths"]["ffmpeg"]
    if not ffmpeg_path.lower() == "ffmpeg" and not os.path.isabs(ffmpeg_path):
        ffmpeg_path = os.path.normpath(os.path.join(BASE_DIR, ffmpeg_path))
    convert_to_wav(
        input_file,
        temp_wav_path,
        ffmpeg_path,
        preprocessing=config.get("preprocessing", {}),
    )
    
    # 2. STT (Transcribe)
    _report_progress("Preparing audio chunks...", 25)
    stt_model_path = config["paths"]["stt_model"]
    if stt_model_path.startswith((".", "..")):
        stt_model_path = resolve_config_path(stt_model_path)

    fallback_stt_model_path = None
    fallback_stt_spec = get_model_spec("stt_fallback")
    if model_exists(BASE_DIR, fallback_stt_spec):
        fallback_stt_model_path = resolve_config_path(fallback_stt_spec.local_dir)

    processing_config = config.get("processing", {})
    enable_chunking = processing_config.get("enable_long_audio_chunking", True)
    long_chunk_seconds = int(processing_config.get("long_audio_chunk_seconds", 900))
    chunk_dir = os.path.join(temp_dir, f"{job_id}_chunks")
    use_cohere_native_long_form = is_cohere_model(stt_model_path)
    if use_cohere_native_long_form:
        chunks = [{"path": temp_wav_path, "offset": 0.0, "duration": None, "index": 0}]
    else:
        chunks = (
            split_wav_by_duration(temp_wav_path, chunk_dir, long_chunk_seconds, ffmpeg_path)
            if enable_chunking
            else [{"path": temp_wav_path, "offset": 0.0, "duration": None, "index": 0}]
        )

    stt_language = config["stt"].get("language", "ko")
    stt_device = config["stt"].get("device", "auto")
    stt_chunk_seconds = int(config["stt"].get("chunk_seconds", 90))

    def _transcribe_chunks(chunks_to_process, model_path, allow_internal_fallback):
        collected_segments = []
        total = len(chunks_to_process)
        for idx, chunk in enumerate(chunks_to_process):
            progress = 30 + int((idx / max(total, 1)) * 35)
            message = (
                "Transcribing with Cohere native long-form..."
                if use_cohere_native_long_form and model_path == stt_model_path
                else f"Transcribing chunk {idx + 1}/{total}..."
            )
            _report_progress(message, progress)
            chunk_segments = transcribe_audio(
                chunk["path"],
                model_path,
                language=stt_language,
                device=stt_device,
                chunk_seconds=stt_chunk_seconds,
                fallback_model_path=fallback_stt_model_path if allow_internal_fallback else None,
            )
            collected_segments.extend(apply_time_offset(chunk_segments, float(chunk.get("offset", 0.0))))
        return collected_segments

    try:
        segments = _transcribe_chunks(
            chunks,
            stt_model_path,
            allow_internal_fallback=not use_cohere_native_long_form,
        )
    except Exception:
        if not (use_cohere_native_long_form and fallback_stt_model_path):
            raise
        _report_progress("Cohere failed; falling back to chunked STT...", 30)
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
    
    # 3. Diarization (Optional)
    if config.get("diarization", {}).get("enabled", True):
        _report_progress("Speaker Diarization & Alignment...", 60)
        diarize_model_path = config["paths"]["diarization_model"]
        if diarize_model_path and diarize_model_path.startswith((".", "..")):
            diarize_model_path = os.path.normpath(os.path.join(BASE_DIR, diarize_model_path))
        min_spk = config["diarization"].get("min_speakers")
        max_spk = config["diarization"].get("max_speakers")
        
        spk_segments = diarize_audio(temp_wav_path, diarize_model_path, min_spk, max_spk)
        segments = align_segments_with_speakers(segments, spk_segments)
    
    # 4. Summary (Optional)
    summary_data = {}
    if config.get("summary", {}).get("enabled", True):
        _report_progress("Summarizing with Local LLM...", 80)
        llm_model = config["summary"].get("model", "gemma-4b")
        if llm_model and llm_model.startswith((".", "..")):
            llm_model = os.path.normpath(os.path.join(BASE_DIR, llm_model))
        summary_data = summarize_meeting(segments, model_name_or_path=llm_model)
    
    # 5. Save Results
    _report_progress("Saving results...", 90)
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
            "summary": config.get("summary", {}).get("enabled", True)
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
