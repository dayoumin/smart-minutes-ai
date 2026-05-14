import argparse
import json
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


def read_json(path: Path) -> dict[str, Any] | None:
    if not path.exists():
        return None
    with path.open("r", encoding="utf-8") as handle:
        data = json.load(handle)
    return data if isinstance(data, dict) else None


def choose_segments(paths) -> tuple[str, list[dict[str, Any]]]:
    candidates = [
        ("display", Path(paths.display_segments_path)),
        ("aligned", Path(paths.aligned_segments_path)),
        ("stt", Path(paths.stt_merged_path)),
    ]
    for label, path in candidates:
        payload = read_json(path)
        if not payload:
            continue
        segments = payload.get("segments")
        if isinstance(segments, list) and segments:
            return label, segments
    return "", []


def main() -> int:
    parser = argparse.ArgumentParser(description="Export speaker transcript from job checkpoints.")
    parser.add_argument("--job-id", required=True)
    parser.add_argument("--output-dir", default=r"backend\outputs")
    parser.add_argument("--wait", action="store_true", help="Wait until aligned/display checkpoints exist.")
    parser.add_argument("--timeout-seconds", type=int, default=0, help="0 means wait indefinitely when --wait is set.")
    parser.add_argument("--poll-seconds", type=int, default=60)
    args = parser.parse_args()

    root = repo_root()
    add_backend_to_path(root)

    import main as backend_main
    from job_checkpoints import build_job_checkpoint_paths
    from pipeline.export_txt import export_txt, save_result_json
    from pipeline.transcript_display import get_transcript_segments

    config = backend_main.load_config()
    temp_dir = backend_main.resolve_config_path(config.get("paths", {}).get("temp_dir", "./temp"))
    paths = build_job_checkpoint_paths(temp_dir, args.job_id)
    output_dir = Path(args.output_dir)
    if not output_dir.is_absolute():
        output_dir = root / output_dir
    output_dir.mkdir(parents=True, exist_ok=True)

    started = time.perf_counter()
    source_label = ""
    segments: list[dict[str, Any]] = []
    while True:
        source_label, segments = choose_segments(paths)
        if segments and (source_label in {"display", "aligned"} or not args.wait):
            break
        if not args.wait:
            break
        if args.timeout_seconds > 0 and time.perf_counter() - started >= args.timeout_seconds:
            break
        time.sleep(max(1, args.poll_seconds))

    if not segments:
        print(json.dumps({
            "ok": False,
            "error": "No checkpoint segments found.",
            "job_id": args.job_id,
        }, ensure_ascii=False))
        return 1

    state_path = Path(paths.state_path)
    state = read_json(state_path) or {}
    result_data = {
        "job_id": args.job_id,
        "source_file": state.get("source_file") or state.get("source_filename") or "",
        "checkpoint_source": source_label,
        "display_segments": segments if source_label == "display" else [],
        "aligned_segments": segments if source_label == "aligned" else [],
        "segments": segments,
        "settings": {
            "diarization": source_label in {"display", "aligned"},
            "exported_from_checkpoint": True,
        },
    }

    json_path = output_dir / f"{args.job_id}_speaker_transcript_checkpoint.json"
    txt_path = output_dir / f"{args.job_id}_speaker_transcript_checkpoint.txt"
    save_result_json(result_data, str(json_path))
    export_txt(get_transcript_segments(result_data), str(txt_path))
    print(json.dumps({
        "ok": True,
        "job_id": args.job_id,
        "checkpoint_source": source_label,
        "segment_count": len(segments),
        "json_file": str(json_path),
        "txt_file": str(txt_path),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
