import argparse
import csv
import os
import re
import subprocess
import sys
import wave
from pathlib import Path


def find_ffmpeg(repo_root: Path) -> str | None:
    candidates = [
        repo_root / "backend" / "ffmpeg.exe",
        repo_root / "ffmpeg.exe",
    ]
    for candidate in candidates:
        if candidate.exists():
            return str(candidate)
    return None


def probe_volume(ffmpeg_path: str, audio_path: Path) -> tuple[str, str]:
    command = [
        ffmpeg_path,
        "-hide_banner",
        "-i",
        str(audio_path),
        "-af",
        "volumedetect",
        "-f",
        "null",
        "NUL" if os.name == "nt" else "/dev/null",
    ]
    completed = subprocess.run(command, capture_output=True, text=True, check=False)
    output = "\n".join(part for part in (completed.stdout, completed.stderr) if part)
    mean_match = re.search(r"mean_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", output)
    max_match = re.search(r"max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB", output)
    mean_volume = mean_match.group(1) if mean_match else ""
    max_volume = max_match.group(1) if max_match else ""
    return mean_volume, max_volume


def analyze_wav(audio_path: Path) -> dict:
    with wave.open(str(audio_path), "rb") as wav_file:
        frames = wav_file.getnframes()
        sample_rate = wav_file.getframerate()
        channels = wav_file.getnchannels()
        sample_width = wav_file.getsampwidth()
    duration_seconds = frames / float(sample_rate) if sample_rate else 0.0
    return {
        "duration_seconds": f"{duration_seconds:.2f}",
        "sample_rate_hz": str(sample_rate),
        "channels": str(channels),
        "sample_width_bytes": str(sample_width),
    }


def main() -> int:
    parser = argparse.ArgumentParser(description="Analyze local audio files for testset preparation.")
    parser.add_argument("audio_dir", help="Directory containing WAV files")
    parser.add_argument("--output", default="docs/audio-inventory-report.csv", help="Output CSV path")
    args = parser.parse_args()

    repo_root = Path(__file__).resolve().parents[1]
    audio_dir = Path(args.audio_dir)
    output_path = Path(args.output)
    if not audio_dir.exists():
        print(f"Audio directory not found: {audio_dir}", file=sys.stderr)
        return 1

    ffmpeg_path = find_ffmpeg(repo_root)
    rows = []
    for audio_path in sorted(audio_dir.rglob("*.wav")):
        row = {
            "file_path": str(audio_path),
            "file_name": audio_path.name,
            "file_size_bytes": str(audio_path.stat().st_size),
            "duration_seconds": "",
            "sample_rate_hz": "",
            "channels": "",
            "sample_width_bytes": "",
            "mean_volume_db": "",
            "max_volume_db": "",
        }
        try:
            row.update(analyze_wav(audio_path))
        except Exception as exc:
            row["notes"] = f"wav_read_error: {exc}"
        if ffmpeg_path:
            mean_volume, max_volume = probe_volume(ffmpeg_path, audio_path)
            row["mean_volume_db"] = mean_volume
            row["max_volume_db"] = max_volume
        rows.append(row)

    output_path.parent.mkdir(parents=True, exist_ok=True)
    fieldnames = [
        "file_path",
        "file_name",
        "file_size_bytes",
        "duration_seconds",
        "sample_rate_hz",
        "channels",
        "sample_width_bytes",
        "mean_volume_db",
        "max_volume_db",
        "notes",
    ]
    with output_path.open("w", newline="", encoding="utf-8") as csv_file:
        writer = csv.DictWriter(csv_file, fieldnames=fieldnames)
        writer.writeheader()
        writer.writerows(rows)

    print(f"Wrote {len(rows)} rows to {output_path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
