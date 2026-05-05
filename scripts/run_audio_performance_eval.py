import argparse
import csv
import json
import os
import re
import shutil
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


def resolve_existing_path(root: Path, raw_path: str | None) -> Path | None:
    if not raw_path:
        return None
    path = Path(raw_path)
    if not path.is_absolute():
        path = root / path
    return path if path.exists() else None


def find_stt_model(root: Path, override: str | None = None) -> Path:
    override_path = resolve_existing_path(root, override)
    if override_path:
        return override_path

    candidates = [
        root / "Smart Minutes AI" / "models",
        root / "backend" / "models" / "stt" / "cohere-transcribe-03-2026",
        root / "backend" / "models",
    ]
    required = ["config.json", "model.safetensors"]
    for candidate in candidates:
        if candidate.exists() and all((candidate / item).exists() for item in required):
            return candidate
    return candidates[0]


def find_diarization_model(root: Path, override: str | None = None) -> Path:
    override_path = resolve_existing_path(root, override)
    if override_path:
        return override_path

    candidates = [
        root / "Smart Minutes AI" / "models",
        root / "backend" / "models" / "diarization" / "speaker-diarization-community-1",
    ]
    required = ["config.yaml", "embedding", "segmentation", "plda"]
    for candidate in candidates:
        if candidate.exists() and all((candidate / item).exists() for item in required):
            return candidate
    return candidates[0]


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


def collect_media_files(media_dir: Path) -> list[Path]:
    extensions = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".mp4", ".mov", ".mkv", ".avi", ".webm"}
    return sorted(
        (path for path in media_dir.rglob("*") if path.is_file() and path.suffix.lower() in extensions),
        key=lambda path: path.stat().st_size,
    )


def resolve_manifest_path(root: Path, media_dir: Path, row: dict[str, str]) -> Path | None:
    raw_path = (row.get("file_path") or "").strip()
    if raw_path:
        path = Path(raw_path)
        if not path.is_absolute():
            path = root / path
        return path if path.exists() else None

    raw_name = (row.get("file_name") or "").strip()
    if raw_name:
        matches = [path for path in collect_media_files(media_dir) if path.name == raw_name]
        return matches[0] if matches else None

    return None


def load_manifest_samples(root: Path, media_dir: Path, manifest_path: Path) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    with manifest_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for index, row in enumerate(reader, start=2):
            normalized = {str(key or "").strip(): str(value or "").strip() for key, value in row.items()}
            if not any(normalized.values()):
                continue
            path = resolve_manifest_path(root, media_dir, normalized)
            if path is None:
                identifier = normalized.get("sample_id") or normalized.get("file_path") or normalized.get("file_name") or f"line {index}"
                raise SystemExit(f"Manifest sample not found at line {index}: {identifier}")
            samples.append({
                "path": path,
                "manifest": normalized,
            })
    return samples


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
    parser.add_argument("--video-dir", default=r"Smart Minutes AI\video", help="Directory containing audio/video samples.")
    parser.add_argument("--manifest", default=None, help="CSV manifest listing samples to evaluate.")
    parser.add_argument("--sample-seconds", type=int, default=60)
    parser.add_argument("--limit", type=int, default=2)
    parser.add_argument("--run-stt", action="store_true")
    parser.add_argument("--run-diarization", action="store_true")
    parser.add_argument("--diarization-all-variants", action="store_true")
    parser.add_argument("--long-seconds", type=int, default=1800)
    parser.add_argument("--output", default=r"backend\temp\audio_performance_eval\latest.json")
    parser.add_argument("--stt-model", default=None)
    parser.add_argument("--diarization-model", default=None)
    parser.add_argument("--clean", action="store_true", help="Delete the output work directory before running.")
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
    manifest_path = (root / args.manifest) if args.manifest else None
    if manifest_path and not manifest_path.exists():
        raise SystemExit(f"Manifest file not found: {manifest_path}")
    manifest_samples = load_manifest_samples(root, video_dir, manifest_path) if manifest_path else None
    all_media = [sample["path"] for sample in manifest_samples] if manifest_samples is not None else collect_media_files(video_dir)
    videos = list(all_media)
    if args.limit > 0:
        videos = videos[: args.limit]
    if not videos:
        raise SystemExit(f"No audio/video files found in {video_dir}")

    output_path = root / args.output
    work_dir = output_path.parent
    if args.clean and work_dir.exists():
        shutil.rmtree(work_dir)
    work_dir.mkdir(parents=True, exist_ok=True)

    stt_model = find_stt_model(root, args.stt_model)
    diarization_model = find_diarization_model(root, args.diarization_model)

    preprocessing_modes = {
        "off": {"enabled": False, "normalize_audio": False, "normalization_mode": "off"},
        "auto": {"enabled": True, "normalize_audio": True, "normalization_mode": "auto"},
        "loudnorm": {"enabled": True, "normalize_audio": True, "normalization_mode": "loudnorm"},
        "speechnorm": {"enabled": True, "normalize_audio": True, "normalization_mode": "speechnorm"},
    }
    variants = ["normal", "quiet", "noise", "silence_trim", "denoise"]

    report: dict[str, Any] = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "video_dir": str(video_dir),
        "manifest": str(manifest_path) if manifest_path else None,
        "sample_seconds": args.sample_seconds,
        "stt_model": str(stt_model),
        "diarization_model": str(diarization_model),
        "videos": [],
        "long_file": None,
    }

    for index, video in enumerate(videos, start=1):
        manifest_row = manifest_samples[index - 1]["manifest"] if manifest_samples is not None else None
        manifest_sample_id = manifest_row.get("sample_id") if manifest_row else ""
        sample_id = manifest_sample_id or f"{index:02d}_{safe_slug(video.stem, 'sample')}"
        sample_dir = work_dir / safe_slug(sample_id, f"{index:02d}_sample")
        source_wav = sample_dir / "source_60s.wav"
        extract_wav(ffmpeg, video, source_wav, args.sample_seconds)
        video_item: dict[str, Any] = {
            "sample_id": sample_id,
            "source_video": str(video),
            "source_size_bytes": video.stat().st_size,
            "source_mean_volume_db": _probe_mean_volume(str(source_wav), ffmpeg),
            "variants": [],
        }
        if manifest_row is not None:
            video_item["manifest"] = manifest_row

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

            modes_to_run = preprocessing_modes if variant in {"normal", "quiet", "noise"} else {"off": {"enabled": False}}
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

                should_run_diarization = diarize_audio is not None and (
                    (variant == "normal" and mode in {"off", "auto", "loudnorm", "speechnorm"})
                    or args.diarization_all_variants
                )
                if should_run_diarization:
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

    long_candidates = all_media or videos
    long_video = max(long_candidates, key=lambda path: path.stat().st_size)
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
    summary_json = json.dumps({
        "output": str(output_path),
        "videos": len(report["videos"]),
        "long_file": report["long_file"],
    }, ensure_ascii=False, indent=2)
    sys.stdout.buffer.write((summary_json + "\n").encode("utf-8", errors="replace"))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
