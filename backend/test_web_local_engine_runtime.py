import json
import os
import sys
import tempfile
import threading
import types
import unittest
from argparse import Namespace
from pathlib import Path
from unittest.mock import Mock, patch

from brand import BRAND_NAME
from web_local_engine_runtime import (
    WindowsNamedEvent,
    WindowsNamedMutex,
    apply_web_local_engine_environment,
    arm_pairing_helper,
    approve_browser_connection,
    build_web_local_engine_environment,
    consume_pairing_helper_arm,
    confirm_browser_approval_recovery,
    dispatch_windows_message,
    engine_stop_event_name,
    load_web_local_engine_settings,
    make_pairing_code_presenter,
    pairing_helper_is_armed,
    pairing_mutex_name,
    prepare_web_local_engine_data,
    resolve_web_local_engine_layout,
    signal_windows_named_event,
    signal_engine_stop,
    validate_production_web_origin,
    windows_named_mutex_exists,
)


class WebLocalEngineRuntimeTest(unittest.TestCase):
    def test_browser_approval_recovery_requires_explicit_yes_and_defaults_to_no(self):
        for answer in (6, 7, 0):
            with self.subTest(answer=answer), patch('web_local_engine_runtime.ctypes.WinDLL', create=True) as library:
                library.return_value.MessageBoxW.return_value = answer
                self.assertEqual(confirm_browser_approval_recovery('https://minutes.example'), answer == 6)
                call = library.return_value.MessageBoxW.call_args.args
                self.assertIn('https://minutes.example', call[1])
                self.assertIn('회의록·설정·모델', call[1])
                self.assertEqual(call[3] & 0xF, 4)  # YES/NO
                self.assertEqual(call[3] & 0x300, 0x100)  # default NO
        with patch('web_local_engine_runtime.ctypes.WinDLL', create=True) as library:
            with self.assertRaises(ValueError):
                confirm_browser_approval_recovery('http://minutes.example')
            library.assert_not_called()

    def test_server_recovers_only_after_native_consent_and_reports_backup_failure(self):
        from local_engine_browser_approval import BrowserApprovalCoordinator
        from local_engine_security import LocalEngineSessionStore
        from web_local_engine_server import _configure_browser_approvals

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / 'browser-approvals.json'
            damaged = b'{broken'
            path.write_bytes(damaged)
            for accepted in (False, True):
                coordinator = BrowserApprovalCoordinator(LocalEngineSessionStore())
                with (
                    patch('web_local_engine_server.confirm_browser_approval_recovery', return_value=accepted) as consent,
                    patch('web_local_engine_server.show_windows_message') as notice,
                ):
                    self.assertEqual(_configure_browser_approvals(coordinator, path, 'https://minutes.example'), accepted)
                consent.assert_called_once_with('https://minutes.example')
                notice.assert_not_called()
                self.assertEqual(coordinator.available, accepted)
                if not accepted:
                    self.assertEqual(path.read_bytes(), damaged)
            self.assertEqual(next(path.parent.glob('*.damaged-*')).read_bytes(), damaged)

            path.write_bytes(damaged)
            coordinator = BrowserApprovalCoordinator(LocalEngineSessionStore())
            with (
                patch('web_local_engine_server.confirm_browser_approval_recovery', return_value=True),
                patch.object(Path, 'rename', side_effect=PermissionError('private path')),
                patch('web_local_engine_server.show_windows_message') as notice,
            ):
                self.assertFalse(_configure_browser_approvals(coordinator, path, 'https://minutes.example'))
            self.assertFalse(coordinator.available)
            self.assertEqual(path.read_bytes(), damaged)
            notice.assert_called_once()
            self.assertNotIn('private path', notice.call_args.args[1])

    def test_server_keeps_healthy_browser_registration_without_recovery_prompt(self):
        from local_engine_browser_approval import BrowserApprovalCoordinator
        from local_engine_security import LocalEngineSessionStore
        from web_local_engine_server import _configure_browser_approvals

        with tempfile.TemporaryDirectory() as temp_dir:
            path = Path(temp_dir) / 'browser-approvals.json'
            data = json.dumps({'format': 1, 'grants': {'a' * 64: 'https://minutes.example'}}).encode()
            path.write_bytes(data)
            coordinator = BrowserApprovalCoordinator(LocalEngineSessionStore())
            with (
                patch('web_local_engine_server.confirm_browser_approval_recovery') as consent,
                patch('web_local_engine_server.show_windows_message') as notice,
            ):
                self.assertTrue(_configure_browser_approvals(coordinator, path, 'https://minutes.example'))
            self.assertTrue(coordinator.available)
            consent.assert_not_called()
            notice.assert_not_called()
            self.assertEqual(path.read_bytes(), data)

    def test_declined_recovery_releases_single_instance_lock_for_shortcut_retry(self):
        from local_engine_browser_approval import BrowserApprovalCoordinator
        from local_engine_security import LocalEngineSessionStore
        from web_local_engine_server import main

        with tempfile.TemporaryDirectory() as temp_dir:
            layout = self._layout(Path(temp_dir))
            layout.config_dir.mkdir(parents=True)
            path = layout.config_dir / 'browser-approvals.json'
            damaged = b'{broken'
            path.write_bytes(damaged)
            backend = types.ModuleType('main')
            backend.LOCAL_ENGINE_PAIRING = types.SimpleNamespace()
            backend.LOCAL_ENGINE_BROWSER_APPROVAL = BrowserApprovalCoordinator(LocalEngineSessionStore())
            backend.app = object()
            lock_held = False
            def acquire():
                nonlocal lock_held
                if lock_held:
                    return False
                lock_held = True
                return True
            def release():
                nonlocal lock_held
                lock_held = False
            with (
                patch('web_local_engine_server._resolve_startup_layout', return_value=layout),
                patch('web_local_engine_server._resolve_startup_settings', return_value=('https://minutes.example', '1.2.3')),
                patch('web_local_engine_server.prepare_web_local_engine_data'),
                patch('web_local_engine_server.apply_web_local_engine_environment'),
                patch('web_local_engine_server._configure_logging'),
                patch('web_local_engine_server.WindowsNamedMutex') as mutex,
                patch('web_local_engine_server.WindowsNamedEvent') as stop_event,
                patch('web_local_engine_server.stop_embedded_ollama_server'),
                patch('web_local_engine_server._create_server') as server,
                patch('web_local_engine_server.confirm_browser_approval_recovery', side_effect=[False, True]) as consent,
                patch('web_local_engine_server.show_windows_message') as notice,
                patch.dict(sys.modules, {'main': backend}),
            ):
                mutex.return_value.acquire.side_effect = acquire
                mutex.return_value.release.side_effect = release
                stop_event.return_value.wait.return_value = False
                self.assertEqual(main([]), 2)
                self.assertFalse(lock_held)
                self.assertFalse(backend.LOCAL_ENGINE_BROWSER_APPROVAL.available)
                self.assertEqual(path.read_bytes(), damaged)
                server.assert_not_called()
                self.assertEqual(main([]), 0)
                self.assertTrue(backend.LOCAL_ENGINE_BROWSER_APPROVAL.available)
                self.assertFalse(lock_held)
                self.assertEqual(consent.call_count, 2)
                self.assertEqual(mutex.return_value.release.call_count, 2)
                server.return_value.run.assert_called_once()
                notice.assert_not_called()
                self.assertEqual(next(path.parent.glob('*.damaged-*')).read_bytes(), damaged)

    def test_installed_browser_connection_needs_no_additional_native_dialog(self):
        with patch('web_local_engine_runtime.ctypes.WinDLL', create=True) as library:
            self.assertTrue(approve_browser_connection('https://minutes.example'))
            library.assert_not_called()
        with self.assertRaises(ValueError):
            approve_browser_connection('http://minutes.example')

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
            self.assertEqual(shown[0][0], f"{BRAND_NAME} 연결 코드")
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

    def test_server_uses_post_creation_layout_for_runtime_and_helpers(self) -> None:
        from web_local_engine_server import main

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            initial = self._layout(root / "logical")
            resolved = resolve_web_local_engine_layout(
                local_app_data=root / "physical",
                install_root=initial.install_root,
            )
            prepared = False

            def resolve_after_creation(*_args, **_kwargs):
                return resolved if prepared else initial

            def prepare_data(layout, **_kwargs):
                nonlocal prepared
                self.assertEqual(layout, initial)
                prepared = True

            backend = types.ModuleType("main")
            backend.LOCAL_ENGINE_PAIRING = types.SimpleNamespace()
            backend.LOCAL_ENGINE_BROWSER_APPROVAL = types.SimpleNamespace(configure=Mock())
            backend.app = object()
            with (
                patch("web_local_engine_server._resolve_startup_layout", side_effect=resolve_after_creation) as resolve,
                patch("web_local_engine_server._resolve_startup_settings", return_value=("https://minutes.example", "1.2.3")),
                patch("web_local_engine_server.prepare_web_local_engine_data", side_effect=prepare_data) as prepare,
                patch("web_local_engine_server.apply_web_local_engine_environment") as apply_environment,
                patch("web_local_engine_server._configure_logging") as configure_logging,
                patch("web_local_engine_server.WindowsNamedMutex") as mutex,
                patch("web_local_engine_server.WindowsNamedEvent") as stop_event,
                patch("web_local_engine_server.make_pairing_code_presenter") as presenter,
                patch("web_local_engine_server.pairing_helper_is_armed", return_value=True) as helper_armed,
                patch("web_local_engine_server.threading.Thread"),
                patch("web_local_engine_server.stop_embedded_ollama_server") as stop_runtime,
                patch("web_local_engine_server.uvicorn.Config") as server_config,
                patch("web_local_engine_server.uvicorn.Server") as server,
                patch.dict(sys.modules, {"main": backend}),
            ):
                mutex.return_value.acquire.return_value = True
                stop_event.return_value.wait.return_value = False
                cleanup_order = []
                server.return_value.run.side_effect = lambda: cleanup_order.append("server")
                stop_runtime.side_effect = lambda: cleanup_order.append("ollama")
                stop_event.return_value.close.side_effect = lambda: cleanup_order.append("event")
                mutex.return_value.release.side_effect = lambda: cleanup_order.append("mutex")
                self.assertEqual(main([]), 0)
                self.assertTrue(backend.LOCAL_ENGINE_PAIRING.availability_check())

            self.assertEqual(resolve.call_count, 2)
            prepare.assert_called_once_with(initial, default_config_path=str(initial.defaults_dir / "config.json"))
            environment = apply_environment.call_args.args[0]
            self.assertEqual(environment["MEETING_AI_BACKEND_DIR"], str(resolved.config_dir))
            self.assertEqual(environment["LMO_LOCAL_OLLAMA_RUNTIME_DIR"], str(resolved.runtime_dir / "ollama"))
            configure_logging.assert_called_once_with(resolved.logs_dir / "engine.log")
            backend.LOCAL_ENGINE_BROWSER_APPROVAL.configure.assert_called_once_with(
                resolved.config_dir / 'browser-approvals.json', 'https://minutes.example',
                approve_browser_connection, recovery_prompt=confirm_browser_approval_recovery,
            )
            mutex.assert_called_once_with(pairing_mutex_name(resolved))
            stop_event.assert_called_once_with(engine_stop_event_name(resolved))
            presenter.assert_called_once_with(resolved, origin="https://minutes.example")
            helper_armed.assert_called_once_with(resolved, origin="https://minutes.example")
            self.assertEqual(server_config.call_args.kwargs.get("timeout_graceful_shutdown"), 5)
            server.return_value.run.assert_called_once_with()
            stop_runtime.assert_called_once_with()
            stop_event.return_value.close.assert_called_once_with()
            mutex.return_value.release.assert_called_once_with()
            self.assertEqual(cleanup_order, ["server", "ollama", "event", "mutex"])

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

    @unittest.skipUnless(os.name == "nt", "Windows named event contract")
    def test_named_stop_event_can_signal_a_running_engine(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            layout = self._layout(Path(temp_dir))
            event_name = engine_stop_event_name(layout)
            event = WindowsNamedEvent(event_name)
            try:
                self.assertFalse(signal_windows_named_event(event_name))
                event.create()
                self.assertTrue(signal_windows_named_event(event_name))
                self.assertTrue(event.wait(timeout_seconds=1))
            finally:
                event.close()
            self.assertFalse(signal_windows_named_event(event_name))

    def test_stop_signal_retries_during_engine_startup(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            layout = self._layout(Path(temp_dir))
            with (
                patch(
                    "web_local_engine_runtime.signal_windows_named_event",
                    side_effect=(False, False, True),
                ) as signal,
                patch("web_local_engine_runtime.time.sleep") as sleep,
            ):
                self.assertTrue(signal_engine_stop(
                    layout,
                    timeout_seconds=1,
                    poll_interval_seconds=0.01,
                ))
            self.assertEqual(signal.call_count, 3)
            self.assertEqual(sleep.call_count, 2)


if __name__ == "__main__":
    unittest.main()
