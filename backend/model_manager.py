import os
from dataclasses import dataclass
from typing import Dict, Iterable, Optional

from huggingface_hub import snapshot_download


@dataclass(frozen=True)
class ModelSpec:
    key: str
    label: str
    repo_id: Optional[str]
    local_dir: str
    required: bool = True
    gated: bool = False


MODEL_SPECS = [
    ModelSpec(
        key="stt_fallback",
        label="Faster Whisper Large v3",
        repo_id="Systran/faster-whisper-large-v3",
        local_dir="./models/stt/faster-whisper-large-v3",
    ),
    ModelSpec(
        key="diarization",
        label="Pyannote Speaker Diarization",
        repo_id="pyannote/speaker-diarization-3.1",
        local_dir="./models/diarization/speaker-diarization-3.1",
        gated=True,
    ),
    ModelSpec(
        key="segmentation",
        label="Pyannote Segmentation",
        repo_id="pyannote/segmentation-3.0",
        local_dir="./models/segmentation/segmentation-3.0",
        gated=True,
    ),
    ModelSpec(
        key="llm",
        label="Gemma GGUF",
        repo_id=None,
        local_dir="./models/llm/gemma.gguf",
        required=False,
    ),
]


def resolve_backend_path(base_dir: str, path_value: str) -> str:
    if os.path.isabs(path_value):
        return path_value
    return os.path.normpath(os.path.join(base_dir, path_value))


def model_exists(base_dir: str, spec: ModelSpec) -> bool:
    path = resolve_backend_path(base_dir, spec.local_dir)
    if os.path.isfile(path):
        return os.path.getsize(path) > 0
    if os.path.isdir(path):
        return any(os.scandir(path))
    return False


def get_model_status(base_dir: str) -> Dict:
    models = []
    for spec in MODEL_SPECS:
        path = resolve_backend_path(base_dir, spec.local_dir)
        installed = model_exists(base_dir, spec)
        models.append({
            "key": spec.key,
            "label": spec.label,
            "repo_id": spec.repo_id,
            "path": path,
            "installed": installed,
            "required": spec.required,
            "gated": spec.gated,
            "downloadable": spec.repo_id is not None,
        })

    required_models = [model for model in models if model["required"]]
    return {
        "ready": all(model["installed"] for model in required_models),
        "models": models,
    }


def missing_downloadable_models(base_dir: str) -> Iterable[ModelSpec]:
    for spec in MODEL_SPECS:
        if spec.repo_id and not model_exists(base_dir, spec):
            yield spec


def download_model(base_dir: str, spec: ModelSpec, token: Optional[str] = None) -> str:
    if not spec.repo_id:
        raise ValueError(f"{spec.key} is not downloadable automatically")

    local_dir = resolve_backend_path(base_dir, spec.local_dir)
    os.makedirs(local_dir, exist_ok=True)
    snapshot_download(
        repo_id=spec.repo_id,
        local_dir=local_dir,
        local_dir_use_symlinks=False,
        token=token,
    )
    return local_dir
