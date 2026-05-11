import argparse
import base64
import csv
import json
import mimetypes
import re
import subprocess
import sys
import time
from pathlib import Path
from typing import Any
from urllib import request


MEDIA_EXTENSIONS = {".mp3", ".wav", ".m4a", ".aac", ".flac", ".mp4", ".mov", ".mkv", ".avi", ".webm"}


def repo_root() -> Path:
    return Path(__file__).resolve().parents[1]


def resolve_path(root: Path, value: str | None) -> Path | None:
    if not value:
        return None
    path = Path(value)
    if not path.is_absolute():
        path = root / path
    return path


def load_config(root: Path, path: str) -> dict[str, Any]:
    config_path = resolve_path(root, path)
    if config_path is None or not config_path.exists():
        raise SystemExit(f"ASR config not found: {path}")
    return json.loads(config_path.read_text(encoding="utf-8"))


def collect_media_files(media_dir: Path) -> list[Path]:
    return sorted(
        (path for path in media_dir.rglob("*") if path.is_file() and path.suffix.lower() in MEDIA_EXTENSIONS),
        key=lambda path: path.stat().st_size,
    )


def load_manifest(root: Path, manifest: Path) -> list[dict[str, Any]]:
    samples: list[dict[str, Any]] = []
    with manifest.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        for line_no, row in enumerate(reader, start=2):
            normalized = {str(key or "").strip(): str(value or "").strip() for key, value in row.items()}
            if not any(normalized.values()):
                continue
            raw_path = normalized.get("file_path") or ""
            path = resolve_path(root, raw_path)
            if path is None or not path.exists():
                raise SystemExit(f"Manifest sample not found at line {line_no}: {raw_path}")
            samples.append({"sample_id": normalized.get("sample_id") or path.stem, "path": path, "manifest": normalized})
    return samples


def find_ffmpeg(root: Path) -> str:
    for candidate in [
        root / "lmo_audio" / "backend" / "ffmpeg.exe",
        root / "backend" / "ffmpeg.exe",
        root / "ffmpeg.exe",
    ]:
        if candidate.exists():
            return str(candidate)
    return "ffmpeg"


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


def score_text(text: str) -> dict[str, Any]:
    hangul = sum(1 for ch in text if 0xAC00 <= ord(ch) <= 0xD7A3)
    latin = sum(1 for ch in text if ("A" <= ch <= "Z") or ("a" <= ch <= "z"))
    cyrillic = sum(1 for ch in text if 0x0400 <= ord(ch) <= 0x04FF)
    replacement = text.count("\ufffd")
    total = max(1, hangul + latin + cyrillic)
    return {
        "chars": len(text),
        "hangul": hangul,
        "latin": latin,
        "cyrillic": cyrillic,
        "replacement": replacement,
        "hangul_ratio": round(hangul / total, 3),
        "quality_score": round(hangul - latin * 0.35 - cyrillic * 2 - replacement * 4, 2),
    }


def normalize_segments(segments: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], str]:
    normalized: list[dict[str, Any]] = []
    for segment in segments:
        text = str(segment.get("text", "")).strip()
        if not text:
            continue
        item = {
            "start": float(segment.get("start", 0.0) or 0.0),
            "end": float(segment.get("end", 0.0) or 0.0),
            "text": text,
        }
        normalized.append(item)
    return normalized, " ".join(segment["text"] for segment in normalized).strip()


def run_cohere(root: Path, wav_path: Path, engine: dict[str, Any]) -> dict[str, Any]:
    backend = root / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from pipeline.transcribe import transcribe_audio

    model_path = resolve_path(root, engine.get("model_path"))
    if model_path is None:
        raise RuntimeError("cohere model_path is required")
    segments = transcribe_audio(
        str(wav_path),
        str(model_path),
        language=str(engine.get("language", "ko")),
        device=str(engine.get("device", "auto")),
        chunk_seconds=int(engine.get("chunk_seconds", 30)),
    )
    normalized, text = normalize_segments(segments)
    return {"segments": normalized, "text": text}


def run_faster_whisper(root: Path, wav_path: Path, engine: dict[str, Any]) -> dict[str, Any]:
    from faster_whisper import WhisperModel

    model_path = resolve_path(root, engine.get("model_path"))
    if model_path is None:
        raise RuntimeError("faster_whisper model_path is required")
    device = str(engine.get("device", "auto"))
    compute_type = str(engine.get("compute_type", "auto"))
    configs = [(device, compute_type)] if compute_type != "auto" else [
        (device, "float16"),
        (device, "int8_float16"),
        ("cpu", "int8"),
    ]
    last_error: Exception | None = None
    for try_device, try_compute in configs:
        try:
            model_kwargs: dict[str, Any] = {}
            if try_device == "cpu":
                if engine.get("cpu_threads") is not None:
                    model_kwargs["cpu_threads"] = int(engine["cpu_threads"])
                if engine.get("num_workers") is not None:
                    model_kwargs["num_workers"] = int(engine["num_workers"])

            model = WhisperModel(str(model_path), device=try_device, compute_type=try_compute, **model_kwargs)
            segments_iter, info = model.transcribe(
                str(wav_path),
                language=str(engine.get("language", "ko")),
                vad_filter=bool(engine.get("vad_filter", True)),
                beam_size=int(engine.get("beam_size", 5)),
            )
            segments = [
                {"start": segment.start, "end": segment.end, "text": segment.text.strip()}
                for segment in segments_iter
            ]
            normalized, text = normalize_segments(segments)
            return {
                "segments": normalized,
                "text": text,
                "runtime": {"device": try_device, "compute_type": try_compute, **model_kwargs},
                "model_info": {
                    "language": getattr(info, "language", None),
                    "language_probability": getattr(info, "language_probability", None),
                    "duration": getattr(info, "duration", None),
                },
            }
        except Exception as exc:
            last_error = exc
    raise RuntimeError(f"faster-whisper failed: {last_error}")


def run_qwen_asr(root: Path, wav_path: Path, engine: dict[str, Any]) -> dict[str, Any]:
    import torch
    from qwen_asr import Qwen3ASRModel
    backend = root / "backend"
    if str(backend) not in sys.path:
        sys.path.insert(0, str(backend))
    from pipeline.qwen_segments import (
        build_display_segments_from_transcript,
        merge_aligner_segments_to_utterances,
        remove_repeated_sentences,
    )

    model_name = str(resolve_path(root, engine.get("model_path")) or engine.get("model_id"))
    dtype_name = str(engine.get("dtype", "bfloat16"))
    dtype = getattr(torch, dtype_name)
    kwargs: dict[str, Any] = {
        "dtype": dtype,
        "device_map": engine.get("device_map", "cuda:0"),
        "max_inference_batch_size": int(engine.get("max_inference_batch_size", 8)),
        "max_new_tokens": int(engine.get("max_new_tokens", 4096)),
    }
    aligner = resolve_path(root, engine.get("forced_aligner_path")) or engine.get("forced_aligner_id")
    if aligner:
        kwargs["forced_aligner"] = str(aligner)
        kwargs["forced_aligner_kwargs"] = {
            "dtype": dtype,
            "device_map": engine.get("device_map", "cuda:0"),
        }
    model = Qwen3ASRModel.from_pretrained(model_name, **kwargs)
    results = model.transcribe(
        audio=str(wav_path),
        language=engine.get("language"),
        return_time_stamps=bool(engine.get("return_time_stamps", False)),
    )
    result = results[0] if isinstance(results, list) else results
    text = remove_repeated_sentences(str(getattr(result, "text", "") or "").strip())
    segments: list[dict[str, Any]] = []
    for stamp in getattr(result, "time_stamps", None) or []:
        segments.append({
            "start": float(getattr(stamp, "start_time", 0.0) or 0.0),
            "end": float(getattr(stamp, "end_time", 0.0) or 0.0),
            "text": str(getattr(stamp, "text", "") or "").strip(),
        })
    raw_aligner_segments = segments
    if segments and bool(engine.get("merge_aligner_segments", False)):
        segments = merge_aligner_segments_to_utterances(
            segments,
            transcript_text=text,
            max_chars=int(engine.get("merge_max_chars", 180)),
            max_seconds=float(engine.get("merge_max_seconds", 25.0)),
            gap_seconds=float(engine.get("merge_gap_seconds", 0.8)),
            min_chars=int(engine.get("merge_min_chars", 12)),
        )
    display_segments = (
        build_display_segments_from_transcript(text, segments)
        if segments and bool(engine.get("build_display_segments", False))
        else None
    )
    if not segments:
        segments = [{"start": 0.0, "end": 0.0, "text": text}]
    return {
        "segments": segments,
        "display_segments": display_segments,
        "text": text,
        "model_info": {
            "language": getattr(result, "language", None),
            "raw_aligner_segments": len(raw_aligner_segments),
            "merged_aligner_segments": len(segments) if raw_aligner_segments else None,
        },
    }


def run_openai_audio_server(wav_path: Path, engine: dict[str, Any]) -> dict[str, Any]:
    data_url = "data:{};base64,{}".format(
        mimetypes.guess_type(str(wav_path))[0] or "audio/wav",
        base64.b64encode(wav_path.read_bytes()).decode("ascii"),
    )
    payload = {
        "model": engine.get("model"),
        "messages": [
            {
                "role": "user",
                "content": [
                    {"type": "audio_url", "audio_url": {"url": data_url}},
                ],
            }
        ],
    }
    body = json.dumps(payload).encode("utf-8")
    req = request.Request(
        str(engine["base_url"]),
        data=body,
        method="POST",
        headers={"Content-Type": "application/json"},
    )
    with request.urlopen(req, timeout=int(engine.get("timeout", 600))) as response:
        data = json.loads(response.read().decode("utf-8"))
    text = data["choices"][0]["message"]["content"]
    return {"segments": [{"start": 0.0, "end": 0.0, "text": text}], "text": text, "raw_response": data}


def run_external_command(wav_path: Path, engine: dict[str, Any]) -> dict[str, Any]:
    command = str(engine.get("command") or "").strip()
    if not command:
        raise RuntimeError("external_command requires command in configs/asr-models.json")
    command = command.replace("{audio}", str(wav_path))
    completed = subprocess.run(command, shell=True, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        raise RuntimeError(completed.stderr[-2000:])
    text = completed.stdout.strip()
    return {"segments": [{"start": 0.0, "end": 0.0, "text": text}], "text": text}


RUNNERS = {
    "cohere": run_cohere,
    "faster_whisper": run_faster_whisper,
    "qwen_asr": run_qwen_asr,
}


def run_engine(root: Path, wav_path: Path, engine: dict[str, Any]) -> dict[str, Any]:
    kind = engine.get("engine")
    if kind in RUNNERS:
        return RUNNERS[kind](root, wav_path, engine)
    if kind == "openai_audio_server":
        return run_openai_audio_server(wav_path, engine)
    if kind == "external_command":
        return run_external_command(wav_path, engine)
    raise RuntimeError(f"Unknown engine type: {kind}")


def select_engines(config: dict[str, Any], requested: str) -> list[dict[str, Any]]:
    engines = list(config.get("engines", []))
    if requested == "all":
        return [engine for engine in engines if engine.get("enabled", True)]
    wanted = {item.strip() for item in requested.split(",") if item.strip()}
    selected = [engine for engine in engines if engine.get("id") in wanted]
    missing = wanted - {engine.get("id") for engine in selected}
    if missing:
        raise SystemExit(f"Unknown ASR engine id(s): {', '.join(sorted(missing))}")
    return selected


def main() -> int:
    parser = argparse.ArgumentParser(description="Run ASR model benchmarks with swappable engines.")
    parser.add_argument("--config", default="configs/asr-models.json")
    parser.add_argument("--file", default=None, help="Run one explicit audio/video file without a manifest.")
    parser.add_argument("--manifest", default=None)
    parser.add_argument("--media-dir", default=None)
    parser.add_argument("--engines", default="all", help="all or comma-separated engine ids.")
    parser.add_argument("--sample-seconds", type=int, default=90)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--limit", type=int, default=1)
    parser.add_argument("--output", default=None)
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()

    root = repo_root()
    config = load_config(root, args.config)
    engines = select_engines(config, args.engines)
    if args.list:
        for engine in engines:
            print(f"{engine['id']}\t{engine.get('engine')}\t{engine.get('label', '')}")
        return 0

    explicit_file = resolve_path(root, args.file)
    manifest = resolve_path(root, args.manifest or config.get("default_manifest"))
    if explicit_file:
        if not explicit_file.exists():
            raise SystemExit(f"Input file not found: {explicit_file}")
        samples = [{"sample_id": explicit_file.stem, "path": explicit_file, "manifest": {}}]
    elif manifest and manifest.exists():
        samples = load_manifest(root, manifest)
    elif args.media_dir:
        samples = [{"sample_id": path.stem, "path": path, "manifest": {}} for path in collect_media_files(resolve_path(root, args.media_dir) or root)]
    else:
        raise SystemExit("Provide --manifest or --media-dir.")
    if args.limit > 0:
        samples = samples[: args.limit]

    output_path = resolve_path(
        root,
        args.output or str(Path(config.get("default_output_dir", "backend/temp/asr_benchmark")) / "latest.json"),
    )
    if output_path is None:
        raise SystemExit("Invalid output path.")
    work_dir = output_path.parent
    work_dir.mkdir(parents=True, exist_ok=True)

    report: dict[str, Any] = {
        "created_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "config": args.config,
        "manifest": str(manifest) if manifest else None,
        "sample_seconds": args.sample_seconds,
        "start": args.start,
        "engines": [{"id": engine.get("id"), "engine": engine.get("engine"), "label": engine.get("label")} for engine in engines],
        "samples": [],
    }
    if args.dry_run:
        print(json.dumps(report, ensure_ascii=False, indent=2))
        return 0

    ffmpeg = find_ffmpeg(root)
    for sample in samples:
        sample_id = re.sub(r"[^A-Za-z0-9_.-]+", "_", sample["sample_id"]).strip("_") or "sample"
        sample_dir = work_dir / sample_id
        wav_path = sample_dir / f"{sample_id}_{args.start}s_{args.sample_seconds}s.wav"
        extract_wav(ffmpeg, sample["path"], wav_path, args.sample_seconds, args.start)
        sample_report: dict[str, Any] = {
            "sample_id": sample["sample_id"],
            "source": str(sample["path"]),
            "wav": str(wav_path),
            "manifest": sample.get("manifest", {}),
            "results": [],
        }
        for engine in engines:
            started = time.perf_counter()
            result_item: dict[str, Any] = {
                "engine_id": engine.get("id"),
                "engine": engine.get("engine"),
                "label": engine.get("label"),
                "ok": False,
            }
            try:
                result = run_engine(root, wav_path, engine)
                text = str(result.get("text", "")).strip()
                result_item.update({
                    "ok": True,
                    "seconds": round(time.perf_counter() - started, 2),
                    "score": score_text(text),
                    "preview": text[:1600],
                    "segments": result.get("segments", []),
                    "display_segments": result.get("display_segments"),
                    "runtime": result.get("runtime"),
                    "model_info": result.get("model_info"),
                })
            except Exception as exc:
                result_item.update({
                    "ok": False,
                    "seconds": round(time.perf_counter() - started, 2),
                    "error": str(exc),
                })
            sample_report["results"].append(result_item)
        report["samples"].append(sample_report)

    output_path.write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding="utf-8")
    print(json.dumps({"output": str(output_path), "samples": len(report["samples"])}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
