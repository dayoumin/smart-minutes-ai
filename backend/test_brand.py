import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND_DIR = str(Path(__file__).resolve().parent)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import brand


REPO_BRAND_CONFIG = Path(__file__).resolve().parent.parent / "configs" / "brand.json"
TAURI_CONFIG = Path(__file__).resolve().parent.parent / "desktop-app" / "src-tauri" / "tauri.conf.json"


class BrandTest(unittest.TestCase):
    def test_brand_name_comes_from_the_shared_config(self) -> None:
        configured = json.loads(REPO_BRAND_CONFIG.read_text(encoding="utf-8"))["brandName"]
        self.assertEqual(brand.BRAND_NAME, configured)
        self.assertEqual(brand.brand_config_path(), REPO_BRAND_CONFIG)

    def test_desktop_app_name_matches_the_brand(self) -> None:
        # tauri.conf.json is plain JSON and cannot read configs/brand.json, so it keeps a copy that must match.
        tauri = json.loads(TAURI_CONFIG.read_text(encoding="utf-8"))
        self.assertEqual(tauri["productName"], brand.BRAND_NAME)
        self.assertEqual([window["title"] for window in tauri["app"]["windows"]], [brand.BRAND_NAME])
        self.assertNotEqual(tauri["productName"], "AI 회의록 도우미")

    def test_packaged_build_reads_the_bundled_copy(self) -> None:
        bundle_dir = Path("C:/bundle/_internal")
        self.assertFalse(hasattr(sys, "_MEIPASS"))
        with patch.object(sys, "_MEIPASS", str(bundle_dir), create=True):
            self.assertEqual(brand.brand_config_path(), bundle_dir / "configs" / "brand.json")
        self.assertFalse(hasattr(sys, "_MEIPASS"))
        self.assertEqual(brand.brand_config_path(), REPO_BRAND_CONFIG)

    def test_hand_edited_config_with_bom_still_loads(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / "brand.json"
            path.write_bytes(b"\xef\xbb\xbf" + json.dumps({"brandName": "새이름"}).encode("utf-8"))
            self.assertTrue(path.read_bytes().startswith(b"\xef\xbb\xbf"))
            self.assertEqual(brand.load_brand_name(path), "새이름")
            self.assertNotEqual(brand.load_brand_name(path), brand.BRAND_NAME)

    def test_particles_follow_the_last_syllable(self) -> None:
        self.assertEqual(brand.with_josa("바로록", "을/를"), "바로록을")
        self.assertEqual(brand.with_josa("LMO 회의록", "을/를"), "LMO 회의록을")
        self.assertEqual(brand.with_josa("바로", "을/를"), "바로를")
        self.assertEqual(brand.with_josa("바로록 연결", "이/가"), "바로록 연결이")
        self.assertEqual(brand.with_josa("바로", "이/가"), "바로가")
        self.assertEqual(brand.with_josa("바로록 연결", "으로/로"), "바로록 연결로")
        self.assertEqual(brand.with_josa("음성 분석", "으로/로"), "음성 분석으로")
        self.assertEqual(brand.with_josa("바로", "으로/로"), "바로로")
        self.assertEqual(brand.with_josa("LMO", "을/를"), "LMO을(를)")
        self.assertNotEqual(brand.with_josa("바로", "을/를"), "바로을")


if __name__ == "__main__":
    unittest.main()
