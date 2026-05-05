import os
from dataclasses import dataclass, field
from typing import Dict, Optional

from ollama_utils import find_ollama_executable
from process_utils import run_hidden


@dataclass(frozen=True)
class ModelSpec:
    key: str
    label: str
    repo_id: Optional[str]
    local_dir: str
    aliases: tuple[str, ...] = field(default_factory=tuple)
    marker_files: tuple[str, ...] = field(default_factory=tuple)
    required: bool = True
    gated: bool = False
    license_name: str = ""
    license_url: str = ""
    requires_token: bool = False
    manual_note: str = ""


MODEL_SPECS = [
    ModelSpec(
        key="stt_primary",
        label="기본 음성 인식 모델",
        repo_id="CohereLabs/cohere-transcribe-03-2026",
        local_dir="../models",
        aliases=("../models/cohere-transcribe-03-2026", "./models/stt/cohere-transcribe-03-2026"),
        marker_files=(
            "config.json",
            "model.safetensors",
            "preprocessor_config.json",
            "tokenizer_config.json",
        ),
        gated=True,
        license_name="Apache-2.0",
        license_url="https://huggingface.co/CohereLabs/cohere-transcribe-03-2026",
        requires_token=True,
        manual_note=(
            "실행 파일 옆 models 폴더 바로 아래에 기본 음성 인식 모델 파일을 넣으세요. "
            "config.json, model.safetensors 등이 models 폴더 안에 바로 보여야 합니다."
        ),
    ),
    ModelSpec(
        key="stt_fallback",
        label="Faster Whisper Large v3",
        repo_id="Systran/faster-whisper-large-v3",
        local_dir="../models/faster-whisper-large-v3",
        aliases=("./models/stt/faster-whisper-large-v3",),
        marker_files=("model.bin", "model.safetensors", "tokenizer.json"),
        required=False,
        license_url="https://huggingface.co/Systran/faster-whisper-large-v3",
    ),
    ModelSpec(
        key="diarization",
        label="화자 분리 모델",
        repo_id="pyannote/speaker-diarization-community-1",
        local_dir="../models",
        aliases=("../models/speaker-diarization-community-1", "./models/diarization/speaker-diarization-community-1"),
        marker_files=(
            "config.yaml",
            "embedding/pytorch_model.bin",
            "segmentation/pytorch_model.bin",
            "plda/plda.npz",
        ),
        gated=True,
        license_url="https://huggingface.co/pyannote/speaker-diarization-community-1",
        requires_token=True,
        manual_note=(
            "화자 분리 모델도 실행 파일 옆 models 폴더 바로 아래에 넣을 수 있습니다. "
            "기존 models\\speaker-diarization-community-1 폴더 방식도 함께 인식합니다."
        ),
    ),
    ModelSpec(
        key="llm",
        label="Gemma via Ollama",
        repo_id=None,
        local_dir="ollama:gemma4:e2b",
        required=False,
        manual_note="Ollama에 gemma4:e2b 또는 호환 Gemma 모델이 있으면 요약 품질이 좋아집니다.",
    ),
]


def resolve_backend_path(base_dir: str, path_value: str) -> str:
    if os.path.isabs(path_value):
        return path_value
    return os.path.normpath(os.path.join(base_dir, path_value))


def candidate_paths(base_dir: str, spec: ModelSpec) -> list[str]:
    if spec.local_dir.startswith("ollama:"):
        return [spec.local_dir]
    return [resolve_backend_path(base_dir, path) for path in (spec.local_dir, *spec.aliases)]


def directory_has_model_payload(path: str) -> bool:
    model_extensions = {
        ".bin",
        ".gguf",
        ".model",
        ".npz",
        ".onnx",
        ".pt",
        ".pth",
        ".safetensors",
    }
    ignored_dirs = {".cache", ".eval_results", ".git", "assets", "demo"}
    ignored_files = {"README.md", ".gitattributes"}

    for root, dirs, files in os.walk(path):
        dirs[:] = [directory for directory in dirs if directory not in ignored_dirs]
        for filename in files:
            if filename in ignored_files:
                continue
            if os.path.splitext(filename)[1].lower() in model_extensions:
                return True
    return False


def path_has_model_payload(path: str, spec: Optional[ModelSpec] = None) -> bool:
    if os.path.isfile(path):
        return os.path.getsize(path) > 0
    if os.path.isdir(path):
        if spec and spec.marker_files:
            return all(os.path.exists(os.path.join(path, *marker.split("/"))) for marker in spec.marker_files)
        return directory_has_model_payload(path)
    return False


def resolve_model_path(base_dir: str, spec: ModelSpec) -> str:
    if spec.local_dir.startswith("ollama:"):
        return spec.local_dir

    paths = candidate_paths(base_dir, spec)
    for path in paths:
        if path_has_model_payload(path, spec):
            return path
    return paths[0]


def model_exists(base_dir: str, spec: ModelSpec) -> bool:
    if spec.local_dir.startswith("ollama:"):
        return ollama_model_exists(spec.local_dir.removeprefix("ollama:"))
    return any(path_has_model_payload(path, spec) for path in candidate_paths(base_dir, spec))


def ollama_model_exists(model_name: str) -> bool:
    try:
        result = run_hidden(
            [find_ollama_executable(), "list"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=5,
        )
    except Exception:
        return False

    return any(line.split(maxsplit=1)[0] == model_name for line in result.stdout.splitlines()[1:])


def get_model_status(base_dir: str) -> Dict:
    models = []
    for spec in MODEL_SPECS:
        installed = model_exists(base_dir, spec)
        models.append({
            "key": spec.key,
            "label": spec.label,
            "repo_id": spec.repo_id,
            "path": resolve_model_path(base_dir, spec),
            "installed": installed,
            "required": spec.required,
            "gated": spec.gated,
            "requires_token": spec.requires_token,
            "token_available": False,
            "license_name": spec.license_name,
            "license_url": spec.license_url,
            "manual_note": spec.manual_note,
            "downloadable": False,
        })

    required_models = [model for model in models if model["required"]]
    return {
        "ready": all(model["installed"] for model in required_models),
        "models": models,
    }


def get_model_spec(key: str) -> ModelSpec:
    for spec in MODEL_SPECS:
        if spec.key == key:
            return spec
    raise KeyError(f"Unknown model key: {key}")
