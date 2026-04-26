import os
import subprocess
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
    license_name: str = ""
    license_url: str = ""
    requires_token: bool = False
    manual_note: str = ""


MODEL_SPECS = [
    ModelSpec(
        key="stt_primary",
        label="Cohere Transcribe 03-2026",
        repo_id="CohereLabs/cohere-transcribe-03-2026",
        local_dir="./models/stt/cohere-transcribe-03-2026",
        license_name="Apache-2.0",
        license_url="https://huggingface.co/CohereLabs/cohere-transcribe-03-2026",
    ),
    ModelSpec(
        key="stt_fallback",
        label="Faster Whisper Large v3",
        repo_id="Systran/faster-whisper-large-v3",
        local_dir="./models/stt/faster-whisper-large-v3",
        required=False,
        license_url="https://huggingface.co/Systran/faster-whisper-large-v3",
    ),
    ModelSpec(
        key="diarization",
        label="Pyannote Community-1 Diarization",
        repo_id="pyannote/speaker-diarization-community-1",
        local_dir="./models/diarization/speaker-diarization-community-1",
        gated=True,
        license_url="https://huggingface.co/pyannote/speaker-diarization-community-1",
        requires_token=True,
        manual_note="Hugging Face에서 사용자 조건을 수락한 뒤 다운로드할 수 있습니다. git-lfs clone 후 이 경로에 배치해도 됩니다.",
    ),
    ModelSpec(
        key="llm",
        label="Gemma via Ollama",
        repo_id=None,
        local_dir="ollama:gemma4:e2b",
        required=False,
        manual_note="Ollama에 gemma4:e2b 또는 호환 Gemma 모델이 있어야 합니다.",
    ),
]


def resolve_backend_path(base_dir: str, path_value: str) -> str:
    if os.path.isabs(path_value):
        return path_value
    return os.path.normpath(os.path.join(base_dir, path_value))


def model_exists(base_dir: str, spec: ModelSpec) -> bool:
    if spec.local_dir.startswith("ollama:"):
        return ollama_model_exists(spec.local_dir.removeprefix("ollama:"))

    path = resolve_backend_path(base_dir, spec.local_dir)
    if os.path.isfile(path):
        return os.path.getsize(path) > 0
    if os.path.isdir(path):
        return any(os.scandir(path))
    return False


def ollama_model_exists(model_name: str) -> bool:
    try:
        result = subprocess.run(
            ["ollama", "list"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )
    except Exception:
        return False

    return any(line.split(maxsplit=1)[0] == model_name for line in result.stdout.splitlines()[1:])


def get_model_status(base_dir: str) -> Dict:
    models = []
    for spec in MODEL_SPECS:
        path = spec.local_dir if spec.local_dir.startswith("ollama:") else resolve_backend_path(base_dir, spec.local_dir)
        installed = model_exists(base_dir, spec)
        models.append({
            "key": spec.key,
            "label": spec.label,
            "repo_id": spec.repo_id,
            "path": path,
            "installed": installed,
            "required": spec.required,
            "gated": spec.gated,
            "requires_token": spec.requires_token,
            "token_available": bool(os.environ.get("HF_TOKEN")),
            "license_name": spec.license_name,
            "license_url": spec.license_url,
            "manual_note": spec.manual_note,
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


def get_model_spec(key: str) -> ModelSpec:
    for spec in MODEL_SPECS:
        if spec.key == key:
            return spec
    raise KeyError(f"Unknown model key: {key}")


def ensure_model(base_dir: str, key: str, token: Optional[str] = None) -> str:
    spec = get_model_spec(key)
    if model_exists(base_dir, spec):
        return spec.local_dir
    if not spec.repo_id:
        raise ValueError(f"{spec.label}은 자동 다운로드 대상이 아닙니다.")
    if spec.requires_token and not token:
        raise ValueError(f"{spec.label} 다운로드에는 HF_TOKEN이 필요합니다.")
    download_model(base_dir, spec, token=token)
    return spec.local_dir


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
