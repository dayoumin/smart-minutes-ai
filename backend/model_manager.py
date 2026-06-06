import os
from dataclasses import dataclass, field
from typing import Dict, Optional

from config_normalization import (
    DEFAULT_SUMMARY_MODEL,
    get_summary_candidate_models,
    get_summary_model_options,
    get_summary_option_models,
    normalize_summary_model_name,
)
from ollama_utils import find_ollama_executable
from process_utils import run_hidden


def normalize_windows_path(path: str) -> str:
    if path.startswith("\\\\?\\UNC\\"):
        return "\\\\" + path[8:]
    if path.startswith("\\\\?\\"):
        return path[4:]
    return path


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
    install_url: str = ""
    install_command: str = ""
    install_options: tuple[dict[str, str], ...] = field(default_factory=tuple)


MODEL_SPECS = [
    ModelSpec(
        key="stt_faster_whisper",
        label="Faster Whisper Large v3",
        repo_id="Systran/faster-whisper-large-v3",
        local_dir="../models/faster-whisper-large-v3",
        aliases=("./models/stt/faster-whisper-large-v3",),
        marker_files=("model.bin", "tokenizer.json", "config.json"),
        required=True,
        license_url="https://huggingface.co/Systran/faster-whisper-large-v3",
        install_url="https://huggingface.co/Systran/faster-whisper-large-v3",
        manual_note=(
            "모델 페이지는 참고용입니다. 관리자가 준비한 faster-whisper-large-v3 전체 묶음을 "
            "models\\faster-whisper-large-v3 폴더에 넣어 주세요."
        ),
    ),
    ModelSpec(
        key="diarization",
        label="참석자 구분 모델",
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
        install_url="https://huggingface.co/pyannote/speaker-diarization-community-1",
        requires_token=True,
        manual_note=(
            "모델 페이지는 참고용입니다. 배포본에 포함되어 있으면 별도 작업이 필요 없고, "
            "없으면 speaker-diarization-community-1 전체 묶음을 models\\speaker-diarization-community-1 폴더에 넣어 주세요."
        ),
    ),
]


def resolve_backend_path(base_dir: str, path_value: str) -> str:
    if os.path.isabs(path_value):
        return normalize_windows_path(os.path.normpath(path_value))
    return normalize_windows_path(os.path.normpath(os.path.join(base_dir, path_value)))


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
    return model_name in list_ollama_models()


def list_ollama_models() -> list[str]:
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
        return []

    models: list[str] = []
    for line in result.stdout.splitlines()[1:]:
        parts = line.split(maxsplit=1)
        if parts and parts[0] not in models:
            models.append(parts[0])
    return models


def _summary_model_status(base_dir: str, config: Optional[dict]) -> dict:
    config = config or {"summary": {"model": DEFAULT_SUMMARY_MODEL}}
    summary = config.get("summary", {}) if isinstance(config.get("summary", {}), dict) else {}
    configured_model = normalize_summary_model_name(summary.get("model") or DEFAULT_SUMMARY_MODEL)
    options = get_summary_model_options(config)
    option_models = get_summary_option_models(config)
    uses_configured_option = configured_model in option_models
    visible_options = list(options) if uses_configured_option else []
    candidate_models = get_summary_candidate_models(config)
    ollama_models = []
    for model in list_ollama_models():
        normalized_model = normalize_summary_model_name(model)
        if normalized_model and normalized_model not in ollama_models:
            ollama_models.append(normalized_model)
    ollama_model_set = set(ollama_models)
    visible_model_names: list[str] = []
    for model in [configured_model, *get_summary_option_models(config)]:
        if model and model not in visible_model_names:
            visible_model_names.append(model)
    status_model_names = list(visible_model_names)
    for model in ollama_models:
        if model and model not in status_model_names:
            status_model_names.append(model)

    installed_model = ""
    installed_path = ""
    installed_models: list[str] = []
    for model in status_model_names:
        candidate_path = resolve_backend_path(base_dir, model) if model.startswith((".", "..")) or (model.endswith((".gguf", ".bin")) and not os.path.isabs(model)) else model
        if os.path.exists(candidate_path) or (not model.endswith((".gguf", ".bin")) and model in ollama_model_set):
            installed_models.append(model)

    for model in candidate_models:
        candidate_path = resolve_backend_path(base_dir, model) if model.startswith((".", "..")) or (model.endswith((".gguf", ".bin")) and not os.path.isabs(model)) else model
        if os.path.exists(candidate_path):
            installed_model = model
            installed_path = candidate_path
            break
        if not model.endswith((".gguf", ".bin")) and model in ollama_model_set:
            installed_model = model
            installed_path = f"ollama:{model}"
            break

    primary_option = next((option for option in visible_options if option.get("model") == configured_model), None)
    first_actionable_option = next((option for option in visible_options if option.get("url") or option.get("command")), {})
    install_url = (primary_option or first_actionable_option).get("url", "")
    install_command = (primary_option or first_actionable_option).get("command", "")
    if not install_command and configured_model and not configured_model.endswith((".gguf", ".bin")):
        install_command = f"ollama run {configured_model}"

    return {
        "key": "llm",
        "label": configured_model or "Ollama summary model",
        "repo_id": None,
        "path": installed_path or (f"ollama:{configured_model}" if configured_model and not configured_model.endswith((".gguf", ".bin")) else configured_model),
        "installed": bool(installed_model),
        "installed_model": installed_model,
        "installed_models": installed_models,
        "configured_model": configured_model,
        "required": False,
        "gated": False,
        "requires_token": False,
        "token_available": False,
        "license_name": "",
        "license_url": install_url,
        "manual_note": f"Ollama 설치 후 {configured_model} 모델을 준비하면 전체 요약과 주제별 정리를 사용할 수 있습니다.",
        "install_url": install_url,
        "install_command": install_command,
        "install_options": visible_options,
        "downloadable": False,
    }


def get_model_status(base_dir: str, config: Optional[dict] = None) -> Dict:
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
            "install_url": spec.install_url,
            "install_command": spec.install_command,
            "install_options": list(spec.install_options),
            "downloadable": spec.key == "stt_faster_whisper",
        })
    models.append(_summary_model_status(base_dir, config))

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
