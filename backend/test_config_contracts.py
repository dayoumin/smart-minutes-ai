import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


BACKEND_DIR = str(Path(__file__).resolve().parent)
if BACKEND_DIR not in sys.path:
    sys.path.insert(0, BACKEND_DIR)

import config_normalization
import model_manager


class ConfigContractTest(unittest.TestCase):
    def test_legacy_disabled_diarization_stays_disabled_in_analysis_setting(self) -> None:
        normalized = config_normalization.normalize_app_config({
            "diarization": {"enabled": False},
        })

        self.assertFalse(normalized["diarization"]["enabled"])
        self.assertFalse(normalized["diarization"]["generate_during_analysis"])

    def test_summary_model_directory_is_not_reported_as_installed_file(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            model_directory = Path(temp_dir) / "summary-model"
            model_directory.mkdir()
            config = config_normalization.normalize_app_config({
                "summary": {"enabled": True, "model": str(model_directory)},
            })

            with (
                patch.object(model_manager, "ollama_executable_available", return_value=False),
                patch.object(model_manager, "list_ollama_models", return_value=[]),
            ):
                status = model_manager._summary_model_status(temp_dir, config, start_ollama=False)

        self.assertFalse(status["installed"])
        self.assertNotIn(str(model_directory), status["installed_models"])

    def test_summary_model_directory_is_not_ready_for_generation(self) -> None:
        import main

        with tempfile.TemporaryDirectory() as temp_dir:
            model_directory = Path(temp_dir) / "summary-model"
            model_directory.mkdir()
            config = config_normalization.normalize_app_config({
                "summary": {"enabled": True, "model": str(model_directory)},
            })

            readiness = main._summary_model_readiness(config, start_ollama=False)

        self.assertFalse(readiness["ready"])
        self.assertEqual(readiness["reason"], "model_missing")


if __name__ == "__main__":
    unittest.main()
