from __future__ import annotations

import hashlib
import json
import os
from dataclasses import dataclass
from pathlib import Path
from typing import Any


class CorruptCheckpointError(RuntimeError):
    pass


@dataclass(frozen=True)
class JobCheckpointPaths:
    root_dir: str
    state_path: str
    upload_dir: str
    source_wav_path: str
    chunks_dir: str
    stt_dir: str
    stt_merged_path: str
    diarization_dir: str
    diarization_segments_path: str
    transcript_dir: str
    aligned_segments_path: str
    display_segments_path: str


def build_job_checkpoint_paths(temp_dir: str, job_id: str) -> JobCheckpointPaths:
    root_dir = os.path.join(os.path.abspath(temp_dir), "jobs", job_id)
    return JobCheckpointPaths(
        root_dir=root_dir,
        state_path=os.path.join(root_dir, "job_state.json"),
        upload_dir=os.path.join(root_dir, "upload"),
        source_wav_path=os.path.join(root_dir, "source.wav"),
        chunks_dir=os.path.join(root_dir, "chunks"),
        stt_dir=os.path.join(root_dir, "stt"),
        stt_merged_path=os.path.join(root_dir, "stt", "merged_segments.json"),
        diarization_dir=os.path.join(root_dir, "diarization"),
        diarization_segments_path=os.path.join(root_dir, "diarization", "speaker_segments.json"),
        transcript_dir=os.path.join(root_dir, "transcript"),
        aligned_segments_path=os.path.join(root_dir, "transcript", "aligned_segments.json"),
        display_segments_path=os.path.join(root_dir, "transcript", "display_segments.json"),
    )


def ensure_job_checkpoint_dirs(paths: JobCheckpointPaths) -> None:
    os.makedirs(paths.root_dir, exist_ok=True)
    os.makedirs(paths.upload_dir, exist_ok=True)
    os.makedirs(paths.chunks_dir, exist_ok=True)
    os.makedirs(paths.stt_dir, exist_ok=True)
    os.makedirs(paths.diarization_dir, exist_ok=True)
    os.makedirs(paths.transcript_dir, exist_ok=True)


def get_job_upload_path(paths: JobCheckpointPaths, suffix: str) -> str:
    normalized_suffix = suffix if suffix.startswith(".") else f".{suffix}" if suffix else ""
    return os.path.join(paths.upload_dir, f"source{normalized_suffix}")


def get_stt_chunk_checkpoint_path(paths: JobCheckpointPaths, chunk_index: int) -> str:
    return os.path.join(paths.stt_dir, f"chunk_{chunk_index + 1:03d}.json")


def atomic_write_json(path: str, payload: dict[str, Any]) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temp_path = target.with_name(f"{target.name}.tmp")
    with temp_path.open("w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temp_path, target)


def load_json_checkpoint(path: str) -> dict[str, Any] | None:
    if not os.path.exists(path):
        return None
    try:
        with open(path, "r", encoding="utf-8") as handle:
            data = json.load(handle)
    except json.JSONDecodeError as exc:
        raise CorruptCheckpointError(f"Corrupt checkpoint JSON: {path}") from exc
    if not isinstance(data, dict):
        raise CorruptCheckpointError(f"Checkpoint payload must be a JSON object: {path}")
    return data


def hash_file_contents(path: str, chunk_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        while True:
            chunk = handle.read(chunk_size)
            if not chunk:
                break
            digest.update(chunk)
    return digest.hexdigest()


def build_config_fingerprint(config_payload: dict[str, Any]) -> str:
    normalized = json.dumps(config_payload, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    return hashlib.sha256(normalized.encode("utf-8")).hexdigest()
