import json
import os
import tempfile
import threading
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import patch

from web_local_engine_runtime import (
    WindowsNamedMutex,
    apply_web_local_engine_environment,
    arm_pairing_helper,
    build_web_local_engine_environment,
    consume_pairing_helper_arm,
    dispatch_windows_message,
    load_web_local_engine_settings,
    make_pairing_code_presenter,
    pairing_helper_is_armed,
    pairing_mutex_name,
    prepare_web_local_engine_data,
    resolve_web_local_engine_layout,
    validate_production_web_origin,
    windows_named_mutex_exists,
)


class WebLocalEngineRuntimeTest(unittest.TestCase):
    def _layout(self, root: Path):
        return resolve_web_local_engine_layout(
            local_app_data=root,
            install_root=root / "Programs" / "Barorok" / "LocalEngine",
            data_root=root / "Barorok" / "LocalEngine",
        )

    def _default_config(self, root: Path) -> Path:
        path = root / "default-config.json"
        path.write_text(json.dumps({
            "paths": {
                "ffmpeg": "ffmpeg.exe",
                "stt_model": "../models/faster-whisper-large-v3",
                "diarization_model": "../models",
                "llm_model": "./models/llm/gemma.gguf",
                "output_dir": "./outputs",
                "temp_dir": "./temp",
                "log_dir": "./logs",
            },
            "export_templates": {
                "hwpx_template_path": "./templates/default_meeting.hwpx",
                "docx_template_path": "./templates/default_meeting.docx",
            },
        }), encoding="utf-8")
        return path

    def test_default_layout_separates_program_files_and_user_data(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            layout = resolve_web_local_engine_layout(local_app_data=root)
            self.assertEqual(layout.install_root, (root / "Programs" / "Barorok" / "LocalEngine").resolve())
            self.assertEqual(layout.data_root, (root / "Barorok" / "LocalEngine").resolve())
            self.assertEqual(layout.config_path, layout.data_root / "config" / "config.json")
            self.assertEqual(layout.models_dir, layout.data_root / "models")
            self.assertEqual(layout.database_dir, layout.data_root / "database")
            self.assertEqual(layout.results_dir, layout.data_root / "results")

    def test_nested_program_and_data_roots_are_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with self.assertRaisesRegex(ValueError, "separate directory trees"):
                resolve_web_local_engine_layout(
                    local_app_data=root,
                    install_root=root / "engine",
                    data_root=root / "engine" / "data",
                )

    def test_prepare_creates_user_config_once_and_preserves_it(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            layout = self._layout(root)
            default_config = self._default_config(root)

            self.assertTrue(prepare_web_local_engine_data(layout, default_config_path=default_config))
            config = json.loads(layout.config_path.read_text(encoding="utf-8"))
            self.assertEqual(config["paths"]["output_dir"], str(layout.results_dir))
            self.assertEqual(config["paths"]["temp_dir"], str(layout.temp_dir))
            self.assertEqual(config["paths"]["stt_model"], str(layout.models_dir / "faster-whisper-large-v3"))
            self.assertEqual(config["paths"]["ffmpeg"], str(layout.engine_dir / "ffmpeg.exe"))
            self.assertEqual(
                config["export_templates"]["hwpx_template_path"],
                str(layout.engine_dir / "templates" / "default_meeting.hwpx"),
            )
            config["user_marker"] = "keep-me"
            layout.config_path.write_text(json.dumps(config), encoding="utf-8")

            self.assertFalse(prepare_web_local_engine_data(layout, default_config_path=default_config))
            preserved = json.loads(layout.config_path.read_text(encoding="utf-8"))
            self.assertEqual(preserved["user_marker"], "keep-me")
            for directory in (
                layout.models_dir,
                layout.database_dir,
                layout.results_dir,
                layout.temp_dir,
                layout.logs_dir,
                layout.runtime_dir,
            ):
                self.assertTrue(directory.is_dir())

    def test_runtime_environment_is_production_and_default_deny(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            layout = self._layout(Path(temp_dir))
            environment = build_web_local_engine_environment(
                layout,
                origin="https://minutes.example",
                engine_version="1.2.3",
            )
            self.assertEqual(environment["MEETING_AI_BACKEND_DIR"], str(layout.config_dir))
            self.assertEqual(environment["LMO_RUNTIME_PROFILE"], "production")
            self.assertEqual(environment["LMO_API_AUTH_ENFORCEMENT"], "enabled")
            self.assertEqual(environment["LMO_WEB_ALLOWED_ORIGINS"], "https://minutes.example")
            self.assertEqual(environment["LMO_ENGINE_VERSION"], "1.2.3")
            self.assertEqual(environment["LMO_LOCAL_OLLAMA_RUNTIME_DIR"], str(layout.runtime_dir / "ollama"))
            self.assertEqual(environment["LMO_LOCAL_OLLAMA_MODELS_DIR"], str(layout.models_dir / "ollama"))
            target_environment = {"LMO_DESKTOP_ACTION_TOKEN": "must-not-survive", "UNCHANGED": "yes"}
            apply_web_local_engine_environment(environment, target=target_environment)
            self.assertNotIn("LMO_DESKTOP_ACTION_TOKEN", target_environment)
            self.assertEqual(target_environment["UNCHANGED"], "yes")
            with patch.dict(os.environ, environment, clear=False):
                from ollama_utils import get_local_ollama_models_dir, get_local_ollama_runtime_dir

                self.assertEqual(get_local_ollama_runtime_dir(), layout.runtime_dir / "ollama")
                self.assertEqual(get_local_ollama_models_dir(), layout.models_dir / "ollama")

    def test_immutable_engine_settings_supply_packaged_startup_values(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            layout = self._layout(Path(temp_dir))
            layout.defaults_dir.mkdir(parents=True)
            (layout.defaults_dir / "engine-settings.json").write_text(json.dumps({
                "format": 1,
                "allowed_origin": "https://minutes.example",
                "engine_version": "2.0.1",
            }), encoding="utf-8")
            self.assertEqual(
                load_web_local_engine_settings(layout),
                ("https://minutes.example", "2.0.1"),
            )
            (layout.defaults_dir / "engine-settings.json").write_text(
                json.dumps({
                    "format": 1,
                    "allowed_origin": "https://minutes.example",
                    "engine_version": "2.0.2",
                }),
                encoding="utf-8-sig",
            )
            self.assertEqual(load_web_local_engine_settings(layout)[1], "2.0.2")

            from web_local_engine_server import _resolve_startup_settings

            override_args = Namespace(
                origin="https://override.example",
                engine_version="99.0.0",
            )
            self.assertEqual(
                _resolve_startup_settings(
                    layout,
                    override_args,
                    frozen=True,
                    environment={
                        "LMO_WEB_ALLOWED_ORIGINS": "https://environment.example",
                        "LMO_ENGINE_VERSION": "88.0.0",
                    },
                ),
                ("https://minutes.example", "2.0.2"),
            )
            self.assertEqual(
                _resolve_startup_settings(
                    layout,
                    override_args,
                    frozen=False,
                    environment={},
                ),
                ("https://override.example", "99.0.0"),
            )

    def test_standalone_origin_requires_one_exact_https_origin(self) -> None:
        self.assertEqual(validate_production_web_origin("https://minutes.example/"), "https://minutes.example")
        for invalid in (
            "http://minutes.example",
            "https://minutes.example/path",
            "https://one.example,https://two.example",
            "https://*.example",
            "",
        ):
            with self.subTest(origin=invalid):
                with self.assertRaises(ValueError):
                    validate_production_web_origin(invalid)

    def test_pairing_arm_is_short_lived_origin_bound_and_one_time(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            layout = self._layout(Path(temp_dir))
            layout.runtime_dir.mkdir(parents=True)
            arm_pairing_helper(layout, origin="https://minutes.example", now=100, ttl_seconds=30)
            arm_payload = layout.pairing_arm_path.read_text(encoding="utf-8")
            self.assertNotIn("123456", arm_payload)
            self.assertTrue(pairing_helper_is_armed(
                layout,
                origin="https://minutes.example",
                now=120,
            ))
            self.assertTrue(consume_pairing_helper_arm(
                layout,
                origin="https://minutes.example",
                now=120,
            ))
            self.assertFalse(consume_pairing_helper_arm(
                layout,
                origin="https://minutes.example",
                now=120,
            ))

            arm_pairing_helper(layout, origin="https://minutes.example", now=200, ttl_seconds=10)
            self.assertFalse(consume_pairing_helper_arm(
                layout,
                origin="https://other.example",
                now=205,
            ))
            self.assertFalse(layout.pairing_arm_path.exists())
            self.assertFalse(pairing_helper_is_armed(
                layout,
                origin="https://minutes.example",
                now=205,
            ))

            arm_pairing_helper(layout, origin="https://minutes.example", now=300, ttl_seconds=10)
            self.assertFalse(consume_pairing_helper_arm(
                layout,
                origin="https://minutes.example",
                now=311,
            ))

    def test_presenter_does_not_show_code_without_manual_arm(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            layout = self._layout(Path(temp_dir))
            layout.runtime_dir.mkdir(parents=True)
            shown = []
            presenter = make_pairing_code_presenter(
                layout,
                origin="https://minutes.example",
                dispatch_message=lambda title, message: not shown.append((title, message)),
                clock=lambda: 100,
            )
            self.assertFalse(presenter("pairing", "123456", 220))
            self.assertEqual(shown, [])

            arm_pairing_helper(layout, origin="https://minutes.example", now=90)
            self.assertTrue(presenter("pairing", "123456", 220))
            self.assertEqual(len(shown), 1)
            self.assertIn("https://minutes.example", shown[0][1])
            self.assertIn("123456", shown[0][1])
            self.assertFalse(layout.pairing_arm_path.exists())

    def test_windows_message_dispatch_returns_before_the_dialog_closes(self) -> None:
        started = threading.Event()
        release = threading.Event()

        def blocking_message(_title: str, _message: str) -> bool:
            started.set()
            release.wait(timeout=2)
            return True

        with patch("web_local_engine_runtime.show_windows_message", side_effect=blocking_message):
            self.assertTrue(dispatch_windows_message("title", "message"))
            self.assertTrue(started.wait(timeout=1))
            self.assertFalse(release.is_set())
            release.set()

    def test_windows_message_failure_log_never_includes_the_pairing_code(self) -> None:
        logged = threading.Event()
        with (
            patch(
                "web_local_engine_runtime.show_windows_message",
                side_effect=RuntimeError("secret-code-123456"),
            ),
            patch(
                "web_local_engine_runtime.logging.error",
                side_effect=lambda *_args, **_kwargs: logged.set(),
            ) as error_log,
        ):
            self.assertTrue(dispatch_windows_message("title", "code 123456"))
            self.assertTrue(logged.wait(timeout=1))
            logged_arguments = repr(error_log.call_args)
            self.assertNotIn("123456", logged_arguments)

    def test_frozen_startup_rejects_path_overrides(self) -> None:
        from web_local_engine_server import _resolve_startup_layout

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            default_install_root = str(root / "Programs" / "Barorok" / "LocalEngine")
            base = {
                "install_root": default_install_root,
                "data_root": None,
                "default_config": None,
            }
            layout = _resolve_startup_layout(
                Namespace(**base),
                frozen=True,
                default_install_root=default_install_root,
            )
            self.assertEqual(layout.install_root, Path(default_install_root).resolve())

            overrides = (
                {"install_root": str(root / "other-install")},
                {"data_root": str(root / "other-data")},
                {"default_config": str(root / "other-config.json")},
            )
            for override in overrides:
                with self.subTest(override=override):
                    arguments = {**base, **override}
                    with self.assertRaisesRegex(ValueError, "cannot be overridden"):
                        _resolve_startup_layout(
                            Namespace(**arguments),
                            frozen=True,
                            default_install_root=default_install_root,
                        )

    @unittest.skipUnless(os.name == "nt", "Windows named mutex contract")
    def test_named_mutex_allows_only_one_server_instance_per_user_data_root(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            layout = self._layout(Path(temp_dir))
            first = WindowsNamedMutex(pairing_mutex_name(layout))
            second = WindowsNamedMutex(pairing_mutex_name(layout))
            try:
                self.assertFalse(windows_named_mutex_exists(pairing_mutex_name(layout)))
                self.assertTrue(first.acquire())
                self.assertTrue(windows_named_mutex_exists(pairing_mutex_name(layout)))
                self.assertFalse(second.acquire())
            finally:
                second.release()
                first.release()
            self.assertFalse(windows_named_mutex_exists(pairing_mutex_name(layout)))


if __name__ == "__main__":
    unittest.main()
