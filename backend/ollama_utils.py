import os
import shutil
from pathlib import Path


def find_ollama_executable() -> str:
    configured = os.environ.get("OLLAMA_EXE")
    if configured and os.path.isfile(configured):
        return configured

    found = shutil.which("ollama")
    if found:
        return found

    candidates = [
        Path.home() / "AppData" / "Local" / "Programs" / "Ollama" / "ollama.exe",
        Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "Ollama" / "ollama.exe",
    ]
    for candidate in candidates:
        if candidate.is_file():
            return str(candidate)

    return "ollama"
