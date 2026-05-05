import argparse
import json
import os
import re
import subprocess
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


def find_ffmpeg(root: Path) -> str:
    candidates = [
        root / "Smart Minutes AI" / "backend" / "ffmpeg.exe",
        root / "backend" / "ffmpeg.exe",
        root / "ffmpeg.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return "ffmpeg"


def safe_slug(value: str, fallback: str) -> str:
    slug = re.sub(r"[^A-Za-z0-9]+", "_", value).strip("_")
    return slug[:48] or fallback


def run_ffmpeg(command: list[str]) -> None:
    completed = subprocess.run(command, capture_output=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr.decode("utf-8", errors="replace")[-2000:])


def extract_wav(ffmpeg: str, source: Path, output: Path, seconds: int, start: int = 0) -> None:
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


def make_variant(ffmpeg: str, source_wav: Path, output: Path, variant: str) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    if variant == "normal":
        command = [ffmpeg, "-hide_banner", "-y", "-i", str(source_wav), "-ac", "1", "-ar", "16000", str(output)]
    elif variant == "quiet":
        command = [
            ffmpeg,
            "-hide_banner",
            "-y",
            "-i",
            str(source_wav),
            "-af",
            "volume=-15dB",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(output),
        ]
    elif variant == "noise":
        # Low-level white noise mixed with the source. This is an experiment sample,
        # not a suggested production denoise path.
        command = [
            ffmpeg,
            "-hide_banner",
            "-y",
            "-i",
            str(source_wav),
            "-filter_complex",
            "anoisesrc=color=white:amplitude=0.015:sample_rate=16000[a];[0:a][a]amix=inputs=2:duration=first:weights=1 1",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(output),
        ]
    elif variant == "silence_trim":
        command = [
            ffmpeg,
            "-hide_banner",
            "-y",
            "-i",
            str(source_wav),
            "-af",
            "silenceremove=start_periods=1:start_duration=0.3:start_threshold=-45dB:stop_periods=-1:stop_duration=0.6:stop_threshold=-45dB",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(output),
        ]
    elif variant == "denoise":
        command = [
            ffmpeg,
            "-hide_banner",
            "-y",
            "-i",
            str(source_wav),
            "-af",
            "afftdn",
            "-ac",
            "1",
            "-ar",
            "16000",
            str(output),
        ]
    else:
        raise ValueError(f"unknown variant: {variant}")
    run_ffmpeg(command)


def summarize_text(segments: list[dict[str, Any]]) -> tuple[int, str]:
    text = " ".join(str(segment.get("text", "")).strip() for segment in segments).strip()
    return len(text), text[:220]


def main() -> int:
    parser = argparse.ArgumentParser(description="Run reusable audio performance comparisons.")
    parser.add_argument("--video-dir", default=r"Smart Minutes AI\video")
    parser.add_argument("--sample-seconds", type=int, default=60)
    parser.add_argument("--limit", type=int, default=2)
    parser.add_argument("--run-stt", action="store_true")
    parser.add_argument("--run-diarization", action="store_true")
    parser.add_argument("--long-seconds", type=int, default=1800)
    parser.add_argument("--output", default=r"backend\temp\audio_performance_eval\latest.json")
    args = parser.parse_args()

    root = repo_root()
    add_backend_to_path(root)

    from pipeline.audio_preprocess import _probe_mean_volume, convert_to_wav
    from pipeline.chunk_audio import get_wav_duration_seconds, split_wav_by_duration

    transcribe_audio = None
    if args.run_stt:
        from pipeline.transcribe import transcribe_audio as transcribe_audio_fn

        transcribe_audio = transcribe_audio_fn

    diarize_audio = None
    if args.run_diarization:
        from pipeline.diarize import diarize_audio as diarize_audio_fn

        diarize_audio = diarize_audio_fn

    ffmpeg = find_ffmpeg(root)
    video_dir = root / args.video_dir
    videos = sorted(video_dir.glob("*.mp4"), key=lambda path: path.stat().st_size)
    if args.limit > 0:
        videos = videos[: args.limit]
    if not videos:
        raise SystemExit(f"No MP4 files found in {video_dir}")

    output_path = root / args.output
    work_dir = output_path.parent
    work_dir.mkdir(parents=True, exist_ok=True)

    stt_model = root / "backend" / "models" / "stt" / "cohere-transcribe-03-2026"
    diarization_model = root / "Smart Minutes AI" / "models"
    if not diarization_model.exists():
        diarization_model = root / "backend" / "models" / "diarization" / "speaker-diarization-community-1"

    preprocessing_modes = {
        "auto": {"enabled": True, "normalize_audio": True, "normalization_mode": "auto"},
        "loudnorm": {"enabled": True, "normalize_audio": True, "normalization_mode": "loudnorm"},
        "speechnorm": {"enabled": True, "normalize_audio": True, "normalization_mode": "speechnorm"},
    }
    variants = ["normal", "quiet", "noise", "silence_trim", "denoise"]

    report: dict[str, Any] = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "video_dir": str(video_dir),
        "sample_seconds": args.sample_seconds,
        "videos": [],
        "long_file": None,
    }

    for index, video in enumerate(videos, start=1):
        sample_id = f"{index:02d}_{safe_slug(video.stem, 'sample')}"
        sample_dir = work_dir / sample_id
        source_wav = sample_dir / "source_60s.wav"
        extract_wav(ffmpeg, video, source_wav, args.sample_seconds)
        video_item: dict[str, Any] = {
            "sample_id": sample_id,
            "source_video": str(video),
            "source_size_bytes": video.stat().st_size,
            "source_mean_volume_db": _probe_mean_volume(str(source_wav), ffmpeg),
            "variants": [],
        }

        for variant in variants:
            variant_wav = sample_dir / f"{variant}.wav"
            make_variant(ffmpeg, source_wav, variant_wav, variant)
            variant_item: dict[str, Any] = {
                "variant": variant,
                "duration_seconds": round(get_wav_duration_seconds(str(variant_wav)), 3),
                "mean_volume_db": _probe_mean_volume(str(variant_wav), ffmpeg),
                "size_bytes": variant_wav.stat().st_size,
                "preprocessing": [],
            }

            modes_to_run = preprocessing_modes if variant in {"normal", "quiet", "noise"} else {"none": {"enabled": False}}
            for mode, preprocessing in modes_to_run.items():
                processed_wav = sample_dir / f"{variant}_{mode}.wav"
                start = time.perf_counter()
                result = convert_to_wav(str(variant_wav), str(processed_wav), ffmpeg, preprocessing=preprocessing)
                elapsed = time.perf_counter() - start
                plan = result.get("preprocessing", {}) if isinstance(result, dict) else {}
                mode_item: dict[str, Any] = {
                    "mode": mode,
                    "resolved_mode": plan.get("resolved_mode"),
                    "seconds_preprocess": round(elapsed, 3),
                    "output_mean_volume_db": _probe_mean_volume(str(processed_wav), ffmpeg),
                }

                if transcribe_audio is not None:
                    start = time.perf_counter()
                    try:
                        segments = transcribe_audio(str(processed_wav), str(stt_model), language="ko", device="auto", chunk_seconds=30)
                        chars, preview = summarize_text(segments)
                        mode_item.update({
                            "stt_ok": True,
                            "seconds_stt": round(time.perf_counter() - start, 2),
                            "segments": len(segments),
                            "chars": chars,
                            "preview": preview,
                        })
                    except Exception as exc:
                        mode_item.update({"stt_ok": False, "stt_error": str(exc)})

                if diarize_audio is not None and variant == "normal" and mode in {"auto", "loudnorm", "speechnorm"}:
                    start = time.perf_counter()
                    try:
                        diarization_segments = diarize_audio(str(processed_wav), str(diarization_model))
                        speakers = sorted({segment.get("speaker") for segment in diarization_segments})
                        mode_item.update({
                            "diarization_ok": True,
                            "seconds_diarization": round(time.perf_counter() - start, 2),
                            "diarization_segments": len(diarization_segments),
                            "speakers": len(speakers),
                        })
                    except Exception as exc:
                        mode_item.update({"diarization_ok": False, "diarization_error": str(exc)})

                variant_item["preprocessing"].append(mode_item)
            video_item["variants"].append(variant_item)
        report["videos"].append(video_item)

    long_video = max(videos, key=lambda path: path.stat().st_size)
    long_dir = work_dir / "long_file"
    long_wav = long_dir / "long_sample.wav"
    long_dir.mkdir(parents=True, exist_ok=True)
    start = time.perf_counter()
    extract_wav(ffmpeg, long_video, long_wav, args.long_seconds)
    extract_seconds = time.perf_counter() - start
    start = time.perf_counter()
    chunks = split_wav_by_duration(str(long_wav), str(long_dir / "chunks"), 30, ffmpeg)
    chunk_seconds = time.perf_counter() - start
    report["long_file"] = {
        "source_video": str(long_video),
        "requested_seconds": args.long_seconds,
        "actual_duration_seconds": round(get_wav_duration_seconds(str(long_wav)), 3),
        "wav_size_bytes": long_wav.stat().st_size,
        "seconds_extract": round(extract_seconds, 3),
        "chunk_count": len(chunks),
        "seconds_chunking": round(chunk_seconds, 3),
        "chunk_total_bytes": sum(Path(chunk["path"]).stat().st_size for chunk in chunks),
    }

    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({
        "output": str(output_path),
        "videos": len(report["videos"]),
        "long_file": report["long_file"],
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
