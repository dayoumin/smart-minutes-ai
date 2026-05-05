import os
import subprocess
from typing import Any


def hidden_subprocess_kwargs() -> dict[str, Any]:
    if os.name != "nt":
        return {}

    startupinfo = subprocess.STARTUPINFO()
    startupinfo.dwFlags |= subprocess.STARTF_USESHOWWINDOW
    startupinfo.wShowWindow = 0

    return {
        "creationflags": getattr(subprocess, "CREATE_NO_WINDOW", 0),
        "startupinfo": startupinfo,
    }


def run_hidden(command: list[str], **kwargs: Any) -> subprocess.CompletedProcess:
    return subprocess.run(command, **hidden_subprocess_kwargs(), **kwargs)
