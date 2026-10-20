"""Product display name for user-facing backend messages.

The name is written only in configs/brand.json, which the web app and the installer build also read.
Packaged builds carry that file next to the bundled modules (scripts/package_backend_sidecar.ps1).
"""

from __future__ import annotations

import json
import sys
from pathlib import Path


def brand_config_path() -> Path:
    bundle_dir = getattr(sys, "_MEIPASS", None)
    if bundle_dir:
        return Path(bundle_dir) / "configs" / "brand.json"
    return Path(__file__).resolve().parent.parent / "configs" / "brand.json"


def load_brand_name(path: Path | None = None) -> str:
    # utf-8-sig: the file is edited by hand, and some Windows editors save a BOM.
    return json.loads((path or brand_config_path()).read_text(encoding="utf-8-sig"))["brandName"]


BRAND_NAME: str = load_brand_name()


def with_josa(word: str, josa: str) -> str:
    """Append the particle ("을/를", "이/가", "은/는", "으로/로") that fits the word's last syllable."""
    with_final, without_final = josa.split("/")
    offset = ord(word[-1]) - 0xAC00 if word else -1
    if not 0 <= offset <= 11171:
        return f"{word}{with_final}({without_final})"
    final_consonant = offset % 28
    # 로 also follows a final ㄹ (연결로, 서울로).
    takes_short_form = final_consonant == 0 or (josa == "으로/로" and final_consonant == 8)
    return f"{word}{without_final if takes_short_form else with_final}"
