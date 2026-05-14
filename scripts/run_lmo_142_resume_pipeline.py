import argparse
import json
import os
import shutil
import sys
import time
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def add_backend_to_path(root: Path) -> None:
    backend = root / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))


def resolve_path(root: Path, raw_path: str) -> Path:
    path = Path(raw_path)
    if not path.is_absolute():
        path = root / path
    return path


def read_json(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError:
        return {}


def build_config(root: Path, ffmpeg: str | None, enable_summary: bool) -> dict[str, Any]:
    import main

    config = main.normalize_stt_config(main.load_config())
    config.setdefault("paths", {})["temp_dir"] = "./temp"
    config.setdefault("paths", {})["output_dir"] = "./outputs"
    if ffmpeg:
        config["paths"]["ffmpeg"] = str(resolve_path(root, ffmpeg))
    diarization_model = root / "models" / "speaker-diarization-community-1"
    if diarization_model.exists():
        config.setdefault("paths", {})["diarization_model"] = str(diarization_model)
    config.setdefault("diarization", {})["enabled"] = True
    config.setdefault("diarization", {})["auto_skip_long_audio"] = False
    config.setdefault("summary", {})["enabled"] = enable_summary
    config.setdefault("privacy", {})["preserve_extracted_audio"] = True
    config.setdefault("processing", {})["enable_long_audio_chunking"] = True
    config.setdefault("processing", {})["long_audio_chunk_seconds"] = 30
    config.setdefault("stt", {})["device"] = "cpu"
    return config


def upgrade_legacy_stt_checkpoints(root: Path, source: Path, job_id: str, config: dict[str, Any]) -> dict[str, Any]:
    import main
    from job_checkpoints import (
        atomic_write_json,
        build_job_checkpoint_paths,
        get_stt_chunk_checkpoint_path,
    )
    from pipeline.chunk_audio import get_wav_duration_seconds

    temp_dir = main.resolve_config_path(config["paths"]["temp_dir"])
    paths = build_job_checkpoint_paths(temp_dir, job_id)
    state = read_json(Path(paths.state_path))
    source_wav = Path(paths.source_wav_path)
    if not source_wav.exists():
        legacy_source_wav = Path(temp_dir) / "jobs" / job_id / "source.wav"
        if legacy_source_wav.exists():
            source_wav.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy2(legacy_source_wav, source_wav)
        else:
            return {"upgraded": 0, "reason": f"source WAV not found: {source_wav}"}

    input_fingerprint = main.hash_file_contents(str(source))
    config_fingerprint = main._analysis_config_fingerprint(config)
    source_wav_size = source_wav.stat().st_size
    source_wav_duration = get_wav_duration_seconds(str(source_wav))
    chunk_seconds = int(config.get("processing", {}).get("long_audio_chunk_seconds", 30))
    stt_model_path = config["paths"]["stt_model"]
    if stt_model_path.startswith((".", "..")):
        stt_model_path = main.resolve_config_path(stt_model_path)
    stt_device = config.get("stt", {}).get("device", "cpu")
    stt_chunk_seconds = int(config.get("stt", {}).get("chunk_seconds", 30))
    stt_execution_fingerprint = main._stt_execution_fingerprint(stt_model_path, stt_device, stt_chunk_seconds)

    chunks = []
    for index, chunk_path in enumerate(sorted(Path(paths.chunks_dir).glob("*.wav"))):
        offset = float(index * chunk_seconds)
        try:
            duration = get_wav_duration_seconds(str(chunk_path))
        except Exception:
            duration = float(chunk_seconds)
        chunks.append({
            "path": str(chunk_path.resolve()),
            "offset": offset,
            "duration": duration,
            "index": index,
            "size_bytes": chunk_path.stat().st_size,
        })

    if chunks:
        atomic_write_json(paths.chunk_manifest_path, {
            "input_fingerprint": input_fingerprint,
            "config_fingerprint": config_fingerprint,
            "source_wav_path": str(source_wav),
            "source_wav_duration": source_wav_duration,
            "source_wav_size": source_wav_size,
            "enable_chunking": True,
            "long_chunk_seconds": chunk_seconds,
            "chunks": chunks,
        })

    upgraded = 0
    completed = []
    for chunk in chunks:
        index = int(chunk["index"])
        checkpoint_path = Path(get_stt_chunk_checkpoint_path(paths, index))
        payload = read_json(checkpoint_path)
        segments = payload.get("segments")
        if not isinstance(segments, list):
            continue
        atomic_write_json(str(checkpoint_path), {
            "chunk_index": index,
            "input_fingerprint": input_fingerprint,
            "config_fingerprint": config_fingerprint,
            "source_wav_size": source_wav_size,
            "source_wav_duration": source_wav_duration,
            "chunk_path": str(Path(chunk["path"]).resolve()),
            "chunk_size_bytes": int(chunk["size_bytes"]),
            "offset": float(chunk["offset"]),
            "duration": float(chunk["duration"]),
            "stt_execution_fingerprint": stt_execution_fingerprint,
            "segments": segments,
        })
        upgraded += 1
        completed.append(index)

    main._write_job_state(paths, {
        "job_id": job_id,
        "source_file": source.name,
        "source_filename": source.name,
        "source_size": source.stat().st_size,
        "source_last_modified": int(source.stat().st_mtime * 1000),
        "config_fingerprint": config_fingerprint,
        "input_fingerprint": input_fingerprint,
        "source_wav_completed": True,
        "source_wav_path": str(source_wav),
        "source_wav_size": source_wav_size,
        "source_wav_duration": source_wav_duration,
        "chunks_manifest_completed": bool(chunks),
        "chunk_count": len(chunks),
        "completed_chunk_indices": completed,
        "cancelled": False,
        "failed": False,
        "resume_supported": True,
        "resume_requested": True,
        "resume_mode": state.get("resume_mode") or "prepared_resume",
    })

    return {
        "upgraded": upgraded,
        "chunk_count": len(chunks),
        "source_wav_duration": round(source_wav_duration, 2),
        "config_fingerprint": config_fingerprint,
        "input_fingerprint": input_fingerprint,
    }


def main_cli() -> int:
    parser = argparse.ArgumentParser(description="Resume the LMO 142 pipeline with diarization enabled.")
    parser.add_argument("--source", required=True)
    parser.add_argument("--job-id", default="1fa6f7be-c02c-4f62-b849-bb2b02bf687f")
    parser.add_argument("--ffmpeg", default=r"backend\ffmpeg.exe")
    parser.add_argument("--no-summary", action="store_true")
    args = parser.parse_args()

    root = repo_root()
    add_backend_to_path(root)
    import main

    source = resolve_path(root, args.source)
    config = build_config(root, args.ffmpeg, enable_summary=not args.no_summary)
    upgrade = upgrade_legacy_stt_checkpoints(root, source, args.job_id, config)
    print(json.dumps({"upgrade": upgrade}, ensure_ascii=False), flush=True)

    started = time.perf_counter()

    def progress(message: str, progress: int) -> None:
        elapsed = round(time.perf_counter() - started, 1)
        print(json.dumps({"elapsed_seconds": elapsed, "progress": progress, "message": message}, ensure_ascii=False), flush=True)

    result = main.process_audio_pipeline(
        str(source),
        job_id=args.job_id,
        config=config,
        progress_callback=progress,
        meeting_context={
            "title": "제142차 LMO 심사위원회",
            "date": "2026-04-24T14:19",
            "meeting_purpose": "LMO 심사위원회 회의록 작성",
        },
    )
    print(json.dumps({
        "ok": True,
        "elapsed_seconds": round(time.perf_counter() - started, 1),
        "json_file": result.get("json_file"),
        "txt_file": result.get("txt_file"),
        "md_file": result.get("md_file"),
        "docx_file": result.get("docx_file"),
        "hwpx_file": result.get("hwpx_file"),
    }, ensure_ascii=False), flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main_cli())
