import argparse
import copy
import ctypes
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path
from typing import Any


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def add_backend_to_path(root: Path) -> None:
    backend = root / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))


def safe_slug(value: str, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9가-힣]+", "_", value).strip("_")
    return slug[:48] or fallback


def resolve_path(root: Path, raw_path: str) -> Path:
    path = Path(raw_path)
    if not path.is_absolute():
        path = root / path
    return path


def find_ffmpeg(root: Path, configured: str | None = None) -> str:
    if configured:
        configured_path = resolve_path(root, configured)
        if configured_path.exists():
            return str(configured_path)
        return configured
    candidates = [
        root / "lmo_audio" / "backend" / "ffmpeg.exe",
        root / "backend" / "ffmpeg.exe",
        root / "ffmpeg.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return "ffmpeg"


def collect_media_files(media_dir: Path) -> list[Path]:
    extensions = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".mp4", ".mov", ".mkv", ".avi", ".webm"}
    return sorted(
        (path for path in media_dir.rglob("*") if path.is_file() and path.suffix.lower() in extensions),
        key=lambda path: path.stat().st_size,
        reverse=True,
    )


def choose_source(root: Path, source: str | None, media_dir: str) -> Path:
    if source:
        path = resolve_path(root, source)
        if not path.exists():
            raise SystemExit(f"Source file not found: {path}")
        return path
    candidates = collect_media_files(resolve_path(root, media_dir))
    if not candidates:
        raise SystemExit(f"No media files found in {resolve_path(root, media_dir)}")
    return candidates[0]


def run_ffmpeg(command: list[str]) -> None:
    completed = subprocess.run(command, capture_output=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.decode("utf-8", errors="replace")[-2000:])


def extract_clip(ffmpeg: str, source: Path, output: Path, seconds: int, start: int = 0) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    command = [
        ffmpeg,
        "-hide_banner",
        "-y",
        "-ss",
        str(start),
        "-i",
        str(source),
        "-t",
        str(seconds),
        "-vn",
        "-ac",
        "1",
        "-ar",
        "16000",
        str(output),
    ]
    run_ffmpeg(command)


class ProcessMemorySampler:
    def __init__(self, interval_seconds: float = 0.5) -> None:
        self.interval_seconds = interval_seconds
        self._stop = threading.Event()
        self._thread: threading.Thread | None = None
        self.peak_rss_bytes = 0
        self.samples = 0

    def _current_rss_bytes(self) -> int:
        if os.name != "nt":
            return 0

        class PROCESS_MEMORY_COUNTERS(ctypes.Structure):
            _fields_ = [
                ("cb", ctypes.c_ulong),
                ("PageFaultCount", ctypes.c_ulong),
                ("PeakWorkingSetSize", ctypes.c_size_t),
                ("WorkingSetSize", ctypes.c_size_t),
                ("QuotaPeakPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPagedPoolUsage", ctypes.c_size_t),
                ("QuotaPeakNonPagedPoolUsage", ctypes.c_size_t),
                ("QuotaNonPagedPoolUsage", ctypes.c_size_t),
                ("PagefileUsage", ctypes.c_size_t),
                ("PeakPagefileUsage", ctypes.c_size_t),
            ]

        counters = PROCESS_MEMORY_COUNTERS()
        counters.cb = ctypes.sizeof(PROCESS_MEMORY_COUNTERS)
        ctypes.windll.kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        ctypes.windll.psapi.GetProcessMemoryInfo.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(PROCESS_MEMORY_COUNTERS),
            ctypes.c_ulong,
        ]
        ctypes.windll.psapi.GetProcessMemoryInfo.restype = ctypes.c_int
        handle = ctypes.windll.kernel32.GetCurrentProcess()
        ok = ctypes.windll.psapi.GetProcessMemoryInfo(
            handle,
            ctypes.byref(counters),
            counters.cb,
        )
        if not ok:
            return 0
        return int(counters.WorkingSetSize)

    def _run(self) -> None:
        while not self._stop.is_set():
            current = self._current_rss_bytes()
            self.peak_rss_bytes = max(self.peak_rss_bytes, current)
            self.samples += 1
            self._stop.wait(self.interval_seconds)

    def __enter__(self) -> "ProcessMemorySampler":
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()
        return self

    def __exit__(self, exc_type, exc, tb) -> None:
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=2)
        current = self._current_rss_bytes()
        self.peak_rss_bytes = max(self.peak_rss_bytes, current)


def parse_csv_ints(raw_value: str) -> list[int]:
    values = []
    for item in raw_value.split(","):
        item = item.strip()
        if not item:
            continue
        values.append(int(item))
    return values


def parse_csv_strings(raw_value: str) -> list[str]:
    return [item.strip() for item in raw_value.split(",") if item.strip()]


def build_profile_config(base_config: dict[str, Any], profile: str) -> dict[str, Any]:
    config = copy.deepcopy(base_config)
    config.setdefault("processing", {})["enable_long_audio_chunking"] = True
    config.setdefault("processing", {})["long_audio_chunk_seconds"] = 30
    config.setdefault("stt", {})["device"] = "cpu"
    config.setdefault("privacy", {})["preserve_extracted_audio"] = True
    config.setdefault("privacy", {})["auto_delete_temp_audio"] = True
    config.setdefault("diarization", {})["auto_skip_long_audio"] = False

    if profile == "stt":
        config.setdefault("diarization", {})["enabled"] = False
        config.setdefault("summary", {})["enabled"] = False
    elif profile == "stt-summary":
        config.setdefault("diarization", {})["enabled"] = False
        config.setdefault("summary", {})["enabled"] = True
    elif profile == "full":
        config.setdefault("diarization", {})["enabled"] = True
        config.setdefault("summary", {})["enabled"] = True
    elif profile == "diarization":
        config.setdefault("diarization", {})["enabled"] = True
        config.setdefault("summary", {})["enabled"] = False
    else:
        raise ValueError(f"Unknown profile: {profile}")
    return config


def run_case(
    *,
    root: Path,
    source: Path,
    clip_path: Path,
    output_dir: Path,
    temp_dir: Path,
    job_id: str,
    profile: str,
    base_config: dict[str, Any],
) -> dict[str, Any]:
    from main import process_audio_pipeline

    config = build_profile_config(base_config, profile)
    config.setdefault("paths", {})["output_dir"] = str(output_dir)
    config.setdefault("paths", {})["temp_dir"] = str(temp_dir)

    progress_events: list[dict[str, Any]] = []

    def report_progress(message: str, progress: int) -> None:
        progress_events.append({
            "elapsed_seconds": round(time.perf_counter() - started, 2),
            "progress": progress,
            "message": message,
        })

    started = time.perf_counter()
    result: dict[str, Any] | None = None
    error = ""
    with ProcessMemorySampler() as sampler:
        try:
            result = process_audio_pipeline(
                str(clip_path),
                job_id=job_id,
                config=config,
                progress_callback=report_progress,
                meeting_context={
                    "title": f"long eval {profile}",
                    "date": time.strftime("%Y-%m-%dT%H:%M"),
                    "meeting_purpose": "장시간 파일 처리 검증",
                },
            )
            ok = True
        except Exception as exc:
            ok = False
            error = str(exc)
    elapsed = time.perf_counter() - started

    result_data = result.get("result_data", {}) if isinstance(result, dict) else {}
    summary = result_data.get("summary", {}) if isinstance(result_data, dict) else {}
    settings = result_data.get("settings", {}) if isinstance(result_data, dict) else {}
    segments = result_data.get("segments", []) if isinstance(result_data, dict) else []
    display_segments = result_data.get("display_segments", []) if isinstance(result_data, dict) else []

    state_path = temp_dir / "jobs" / job_id / "job_state.json"
    state = {}
    if state_path.exists():
        state = json.loads(state_path.read_text(encoding="utf-8"))

    return {
        "job_id": job_id,
        "profile": profile,
        "source": str(source),
        "clip_path": str(clip_path),
        "ok": ok,
        "error": error,
        "elapsed_seconds": round(elapsed, 2),
        "peak_rss_mb": round(sampler.peak_rss_bytes / (1024 * 1024), 1),
        "memory_samples": sampler.samples,
        "progress_events": progress_events,
        "last_progress": progress_events[-1] if progress_events else None,
        "state": {
            "stage": state.get("stage"),
            "chunk_count": state.get("chunk_count"),
            "completed_chunk_count": len(state.get("completed_chunk_indices") or []),
            "stt_completed": bool(state.get("stt_completed")),
            "diarization_completed": bool(state.get("diarization_completed")),
            "diarization_skipped": bool(state.get("diarization_skipped")),
            "summary_completed": bool(state.get("summary_completed")),
            "last_error": state.get("last_error", ""),
        },
        "result": {
            "segments": len(segments) if isinstance(segments, list) else 0,
            "display_segments": len(display_segments) if isinstance(display_segments, list) else 0,
            "speaker_count": len({str(item.get("speaker") or "") for item in display_segments if isinstance(item, dict)}),
            "summary_overview_chars": len(str(summary.get("overview") or "")),
            "diarization_enabled": bool(settings.get("diarization")),
            "diarization_skipped": bool(settings.get("diarization_skipped")),
        },
        "outputs": {
            "json": bool(result and result.get("json_file") and Path(result["json_file"]).exists()),
            "txt": bool(result and result.get("txt_file") and Path(result["txt_file"]).exists()),
            "md": bool(result and result.get("md_file") and Path(result["md_file"]).exists()),
            "docx": bool(result and result.get("docx_file") and Path(result["docx_file"]).exists()),
            "hwpx": bool(result and result.get("hwpx_file") and Path(result["hwpx_file"]).exists()),
        },
    }


def run_prep_case(
    *,
    root: Path,
    source: Path,
    clip_path: Path,
    temp_dir: Path,
    job_id: str,
    base_config: dict[str, Any],
) -> dict[str, Any]:
    add_backend_to_path(root)
    from pipeline.chunk_audio import get_wav_duration_seconds, split_wav_by_duration

    ffmpeg = base_config.get("paths", {}).get("ffmpeg") or "ffmpeg"
    chunk_seconds = int(base_config.get("processing", {}).get("long_audio_chunk_seconds", 30))
    chunk_dir = temp_dir / "jobs" / job_id / "chunks"

    started = time.perf_counter()
    error = ""
    chunks: list[dict[str, Any]] = []
    duration = 0.0
    with ProcessMemorySampler() as sampler:
        try:
            duration = get_wav_duration_seconds(str(clip_path))
            chunks = split_wav_by_duration(str(clip_path), str(chunk_dir), chunk_seconds, ffmpeg_path=str(ffmpeg))
            ok = True
        except Exception as exc:
            ok = False
            error = str(exc)
    elapsed = time.perf_counter() - started

    return {
        "job_id": job_id,
        "profile": "prep",
        "source": str(source),
        "clip_path": str(clip_path),
        "ok": ok,
        "error": error,
        "elapsed_seconds": round(elapsed, 2),
        "peak_rss_mb": round(sampler.peak_rss_bytes / (1024 * 1024), 1),
        "memory_samples": sampler.samples,
        "progress_events": [],
        "last_progress": None,
        "state": {
            "stage": "prepared" if ok else "failed",
            "chunk_count": len(chunks),
            "completed_chunk_count": len(chunks),
            "stt_completed": False,
            "diarization_completed": False,
            "diarization_skipped": False,
            "summary_completed": False,
            "last_error": error,
        },
        "result": {
            "duration_seconds": round(duration, 2),
            "segments": 0,
            "display_segments": 0,
            "speaker_count": 0,
            "summary_overview_chars": 0,
            "diarization_enabled": False,
            "diarization_skipped": False,
        },
        "outputs": {
            "json": False,
            "txt": False,
            "md": False,
            "docx": False,
            "hwpx": False,
        },
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Run long audio pipeline baselines with memory/time metrics.")
    parser.add_argument("--source", default=None, help="Audio/video file to clip and evaluate.")
    parser.add_argument("--media-dir", default="video", help="Used only when --source is omitted; largest media file is selected.")
    parser.add_argument("--durations", default="600", help="Comma-separated clip lengths in seconds, e.g. 600,1800,3600.")
    parser.add_argument("--profiles", default="stt,diarization", help="Comma-separated: prep, stt, stt-summary, diarization, full.")
    parser.add_argument("--start", type=int, default=0, help="Start offset in seconds for clip extraction.")
    parser.add_argument("--output", default=r"backend\temp\long_audio_pipeline_eval\latest.json")
    parser.add_argument("--work-dir", default=r"backend\temp\long_audio_pipeline_eval")
    parser.add_argument("--ffmpeg", default=None)
    parser.add_argument("--reuse-clips", action="store_true")
    parser.add_argument("--clean", action="store_true", help="Remove the work directory before starting.")
    args = parser.parse_args()

    root = repo_root()
    add_backend_to_path(root)

    from main import load_config, normalize_stt_config

    source = choose_source(root, args.source, args.media_dir)
    durations = parse_csv_ints(args.durations)
    profiles = parse_csv_strings(args.profiles)
    unknown_profiles = sorted(set(profiles) - {"prep", "stt", "stt-summary", "diarization", "full"})
    if unknown_profiles:
        raise SystemExit(f"Unknown profiles: {', '.join(unknown_profiles)}")

    ffmpeg = find_ffmpeg(root, args.ffmpeg)
    output_path = resolve_path(root, args.output)
    work_dir = resolve_path(root, args.work_dir)
    if args.clean and work_dir.exists():
        shutil.rmtree(work_dir)
    clips_dir = work_dir / "clips"
    runs_dir = work_dir / "runs"
    output_path.parent.mkdir(parents=True, exist_ok=True)
    clips_dir.mkdir(parents=True, exist_ok=True)
    runs_dir.mkdir(parents=True, exist_ok=True)

    base_config = normalize_stt_config(load_config())
    base_config.setdefault("paths", {})["ffmpeg"] = ffmpeg

    report: dict[str, Any] = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "source": str(source),
        "source_size_bytes": source.stat().st_size,
        "durations": durations,
        "profiles": profiles,
        "cases": [],
    }

    for duration in durations:
        clip_name = f"{safe_slug(source.stem, 'source')}_{duration}s.wav"
        clip_path = clips_dir / clip_name
        if not args.reuse_clips or not clip_path.exists():
            extract_clip(ffmpeg, source, clip_path, duration, start=args.start)

        for profile in profiles:
            job_id = f"long_eval_{safe_slug(source.stem, 'source')}_{duration}s_{profile}_{int(time.time())}"
            case_root = runs_dir / job_id
            output_dir = case_root / "outputs"
            temp_dir = case_root / "temp"
            output_dir.mkdir(parents=True, exist_ok=True)
            temp_dir.mkdir(parents=True, exist_ok=True)
            if profile == "prep":
                case = run_prep_case(
                    root=root,
                    source=source,
                    clip_path=clip_path,
                    temp_dir=temp_dir,
                    job_id=job_id,
                    base_config=base_config,
                )
            else:
                case = run_case(
                    root=root,
                    source=source,
                    clip_path=clip_path,
                    output_dir=output_dir,
                    temp_dir=temp_dir,
                    job_id=job_id,
                    profile=profile,
                    base_config=base_config,
                )
            report["cases"].append(case)
            output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")

    summary = {
        "output": str(output_path),
        "source": str(source),
        "cases": [
            {
                "job_id": item["job_id"],
                "profile": item["profile"],
                "ok": item["ok"],
                "elapsed_seconds": item["elapsed_seconds"],
                "peak_rss_mb": item["peak_rss_mb"],
                "stage": item["state"]["stage"],
                "completed_chunk_count": item["state"]["completed_chunk_count"],
                "chunk_count": item["state"]["chunk_count"],
                "error": item["error"],
            }
            for item in report["cases"]
        ],
    }
    sys.stdout.buffer.write((json.dumps(summary, ensure_ascii=False, indent=2) + "\n").encode("utf-8", errors="replace"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
