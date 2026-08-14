import json
import socket
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from local_engine_preflight import (
    HOST_PREFLIGHT_KIND,
    INSTALLER_PREFLIGHT_KIND,
    InstallerTargetPaths,
    PREFLIGHT_SCHEMA_VERSION,
    PortInspection,
    StorageRequirement,
    VolumeSpace,
    WriteCleanupProbe,
    WindowsSystemFacts,
    collect_installer_target_preflight,
    collect_windows_preflight,
    detect_native_architecture,
    inspect_fixed_port,
    normalize_windows_architecture,
    probe_write_cleanup,
    read_installer_preflight_request,
    read_volume_space,
    windows_machine_code_to_architecture,
    write_preflight_json,
)


GIB = 1024 * 1024 * 1024


class LocalEnginePreflightTest(unittest.TestCase):
    def _collect(
        self,
        root: Path,
        *,
        facts: WindowsSystemFacts | None = None,
    ) -> dict:
        arguments = {
            "facts": facts or WindowsSystemFacts("Windows", 26100, "x64", 16 * GIB),
            "clock": lambda: 1234,
            "run_id_factory": lambda: "run-1234",
        }
        return collect_windows_preflight(**arguments)

    def test_supported_machine_returns_versioned_non_sensitive_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            payload = self._collect(root)

        self.assertEqual(payload["schema_version"], PREFLIGHT_SCHEMA_VERSION)
        self.assertEqual(payload["preflight_kind"], HOST_PREFLIGHT_KIND)
        self.assertEqual(payload["run_id"], "run-1234")
        self.assertEqual(payload["overall_status"], "pass")
        self.assertEqual(payload["checked_at"], 1234)
        self.assertEqual(
            {check["check_id"] for check in payload["checks"]},
            {
                "supported_windows",
                "supported_architecture",
                "system_memory",
            },
        )
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn(str(root), serialized)
        self.assertNotIn("User", serialized)
        self.assertNotIn("token", serialized.casefold())
        self.assertNotIn("pairing", serialized.casefold())

    def test_unsupported_windows_and_architecture_are_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            payload = self._collect(
                Path(temp_dir),
                facts=WindowsSystemFacts("Windows", 19045, "arm64", 16 * GIB),
            )
        checks = {check["check_id"]: check for check in payload["checks"]}
        self.assertEqual(payload["overall_status"], "blocked")
        self.assertEqual(checks["supported_windows"]["status"], "blocked")
        self.assertEqual(checks["supported_architecture"]["status"], "blocked")
        self.assertFalse(checks["supported_architecture"]["retryable"])

    def test_detection_failures_are_unknown_without_false_blocking(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            payload = self._collect(
                Path(temp_dir),
                facts=WindowsSystemFacts("Windows", None, "unknown", None, None),
            )
        checks = {check["check_id"]: check for check in payload["checks"]}
        self.assertEqual(payload["overall_status"], "unknown")
        self.assertEqual(checks["supported_windows"]["status"], "unknown")
        self.assertEqual(checks["supported_architecture"]["status"], "unknown")
        self.assertEqual(checks["system_memory"]["status"], "unknown")

    def test_architecture_normalization_prefers_native_windows_architecture(self) -> None:
        self.assertEqual(normalize_windows_architecture("AMD64", {}), "x64")
        self.assertEqual(
            normalize_windows_architecture(
                "AMD64",
                {"PROCESSOR_ARCHITEW6432": "ARM64", "PROCESSOR_ARCHITECTURE": "AMD64"},
            ),
            "arm64",
        )
        self.assertEqual(windows_machine_code_to_architecture(0x8664), "x64")
        self.assertEqual(windows_machine_code_to_architecture(0xAA64), "arm64")
        self.assertEqual(windows_machine_code_to_architecture(0), "unknown")
        self.assertEqual(
            detect_native_architecture(
                {},
                is_windows=True,
                native_machine_reader=lambda: 0x8664,
            ),
            "x64",
        )
        self.assertEqual(
            detect_native_architecture(
                {"PROCESSOR_ARCHITECTURE": "AMD64"},
                is_windows=True,
                native_machine_reader=lambda: None,
            ),
            "unknown",
        )

    def test_json_output_is_temp_confined_and_never_overwrites(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_path = root / "한글 preflight.json"
            payload = {"schema_version": 1, "overall_status": "pass", "checks": []}
            written = write_preflight_json(output_path, payload, temp_root=root)
            self.assertEqual(json.loads(written.read_text(encoding="utf-8")), payload)
            with self.assertRaises(FileExistsError):
                write_preflight_json(output_path, payload, temp_root=root)
            outside = root.parent / "outside-preflight.json"
            with self.assertRaisesRegex(ValueError, "temporary directory"):
                write_preflight_json(outside, payload, temp_root=root)

    def test_json_output_does_not_leave_a_partial_result_when_publish_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_path = root / "preflight.json"
            with (
                patch("local_engine_preflight._publish_preflight_no_replace", side_effect=OSError("publish failed")),
                self.assertRaisesRegex(OSError, "publish failed"),
            ):
                write_preflight_json(output_path, {"schema_version": 1}, temp_root=root)
            self.assertFalse(output_path.exists())
            self.assertEqual(list(root.glob(".*.tmp")), [])

    def _installer_paths(self, root: Path) -> InstallerTargetPaths:
        return InstallerTargetPaths(
            install=root / "Programs" / "Barorok" / "LocalEngine",
            staging=root / "staging",
            models=root / "Barorok" / "LocalEngine" / "models",
            analysis_temp=root / "Barorok" / "LocalEngine" / "temp",
            results=root / "Barorok" / "LocalEngine" / "results",
            write_targets=(
                root / "Programs" / "Barorok" / "LocalEngine",
                root / "Barorok" / "LocalEngine",
            ),
        )

    def _requirements(
        self,
        *,
        install: int | None = 20,
        staging: int | None = 20,
        models: int | None = 30,
        analysis_temp: int | None = 10,
        results: int | None = 5,
    ) -> dict[str, StorageRequirement]:
        values = {
            "install": install,
            "staging": staging,
            "models": models,
            "analysis_temp": analysis_temp,
            "results": results,
        }
        return {
            role: StorageRequirement(value, value)
            for role, value in values.items()
        }

    def _collect_installer(
        self,
        root: Path,
        *,
        available: int = 200,
        requirements: dict[str, StorageRequirement] | None = None,
        access: WriteCleanupProbe | None = None,
        port: PortInspection | None = None,
    ) -> dict:
        return collect_installer_target_preflight(
            self._installer_paths(root),
            requirements or self._requirements(),
            request_generation=7,
            clock=lambda: 1234,
            run_id_factory=lambda: "run-installer",
            volume_reader=lambda _path: VolumeSpace("shared-volume", available),
            write_cleanup_reader=lambda _targets: access or WriteCleanupProbe("pass", "pass", 1, 1),
            port_reader=lambda: port or PortInspection("available"),
        )

    def test_installer_preflight_returns_versioned_scoped_private_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            payload = self._collect_installer(root)

        self.assertEqual(payload["schema_version"], PREFLIGHT_SCHEMA_VERSION)
        self.assertEqual(payload["preflight_kind"], INSTALLER_PREFLIGHT_KIND)
        self.assertEqual(payload["request_generation"], 7)
        self.assertEqual(payload["overall_status"], "pass")
        self.assertEqual(
            {check["check_id"] for check in payload["checks"]},
            {
                "installer_install_space",
                "installer_staging_space",
                "installer_model_space",
                "installer_analysis_temp_space",
                "installer_results_space",
                "installer_local_app_data_write",
                "installer_local_app_data_cleanup",
                "installer_fixed_port",
            },
        )
        serialized = json.dumps(payload, ensure_ascii=False)
        self.assertNotIn(str(root), serialized)
        self.assertNotIn("shared-volume", serialized)

    def test_same_volume_uses_aggregate_peak_without_false_pass(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            payload = self._collect_installer(Path(temp_dir), available=35)
        checks = {check["check_id"]: check for check in payload["checks"]}
        self.assertEqual(payload["overall_status"], "blocked")
        self.assertEqual(checks["installer_install_space"]["status"], "blocked")
        self.assertEqual(checks["installer_staging_space"]["status"], "blocked")
        self.assertEqual(checks["installer_model_space"]["status"], "warning")
        self.assertEqual(
            checks["installer_install_space"]["measured"]["aggregate_required_bytes"],
            40,
        )
        self.assertEqual(
            checks["installer_model_space"]["measured"]["aggregate_required_bytes"],
            45,
        )

    def test_missing_requirement_is_unknown_instead_of_guessing(self) -> None:
        requirements = self._requirements(models=None)
        with tempfile.TemporaryDirectory() as temp_dir:
            payload = self._collect_installer(Path(temp_dir), requirements=requirements)
        checks = {check["check_id"]: check for check in payload["checks"]}
        self.assertEqual(checks["installer_model_space"]["status"], "unknown")
        self.assertEqual(checks["installer_analysis_temp_space"]["status"], "unknown")
        self.assertEqual(checks["installer_results_space"]["status"], "unknown")
        self.assertEqual(payload["overall_status"], "unknown")

        incomplete = self._requirements()
        incomplete["models"] = StorageRequirement(30, None)
        with tempfile.TemporaryDirectory() as temp_dir:
            payload = self._collect_installer(Path(temp_dir), requirements=incomplete)
        checks = {check["check_id"]: check for check in payload["checks"]}
        self.assertEqual(checks["installer_model_space"]["status"], "unknown")
        self.assertEqual(checks["installer_analysis_temp_space"]["status"], "unknown")
        self.assertEqual(checks["installer_results_space"]["status"], "unknown")

    def test_write_cleanup_and_port_states_map_to_terminal_contract(self) -> None:
        cases = (
            (WriteCleanupProbe("blocked", "unknown", 0, 0), PortInspection("available"), "blocked"),
            (WriteCleanupProbe("pass", "warning", 2, 1), PortInspection("available"), "warning"),
            (WriteCleanupProbe("pass", "pass", 1, 1), PortInspection("local_engine"), "warning"),
            (WriteCleanupProbe("pass", "pass", 1, 1), PortInspection("occupied"), "blocked"),
            (WriteCleanupProbe("pass", "pass", 1, 1), PortInspection("unknown"), "unknown"),
        )
        for access, port, expected in cases:
            with self.subTest(access=access, port=port):
                with tempfile.TemporaryDirectory() as temp_dir:
                    payload = self._collect_installer(
                        Path(temp_dir),
                        access=access,
                        port=port,
                    )
                self.assertEqual(payload["overall_status"], expected)

    def test_request_is_temp_confined_and_validates_requirements(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            request_path = root / "installer-request.json"
            request_path.write_text(json.dumps({
                "schema_version": 1,
                "preflight_kind": "installer_target",
                "request_generation": 9,
                "requirements": {
                    role: {"required_bytes": index, "recommended_bytes": index + 1}
                    for index, role in enumerate((
                        "install",
                        "staging",
                        "models",
                        "analysis_temp",
                        "results",
                    ))
                },
            }), encoding="utf-8")
            generation, requirements = read_installer_preflight_request(request_path, temp_root=root)
            self.assertEqual(generation, 9)
            self.assertEqual(requirements["results"].required_bytes, 4)

            outside = root.parent / "outside-installer-request.json"
            with self.assertRaisesRegex(ValueError, "temporary directory"):
                read_installer_preflight_request(outside, temp_root=root)

            request_path.write_text(json.dumps({
                "schema_version": 1,
                "preflight_kind": "installer_target",
                "requirements": {
                    "install": {"required_bytes": -1},
                },
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "non-negative"):
                read_installer_preflight_request(request_path, temp_root=root)

            request_path.write_text(json.dumps({
                "schema_version": 1,
                "preflight_kind": "installer_target",
                "requirements": {},
            }), encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "request_generation"):
                read_installer_preflight_request(request_path, temp_root=root)

    def test_write_cleanup_probe_uses_only_unique_canaries_and_leaves_no_residue(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            existing = root / "existing"
            existing.mkdir()
            sentinel = existing / "sentinel.txt"
            sentinel.write_text("preserve", encoding="utf-8")
            probe = probe_write_cleanup((existing / "future" / "target", existing))
            self.assertEqual(probe.write_status, "pass")
            self.assertEqual(probe.cleanup_status, "pass")
            self.assertEqual(sentinel.read_text(encoding="utf-8"), "preserve")
            self.assertEqual(list(existing.glob(".barorok-preflight-*")), [])
            self.assertFalse((existing / "future").exists())

    def test_write_cleanup_probe_never_deletes_or_replaces_preexisting_canaries(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            source = root / ".barorok-preflight-fixed.tmp"
            renamed = root / ".barorok-preflight-fixed.check"
            source.write_text("existing-source", encoding="utf-8")
            renamed.write_text("existing-renamed", encoding="utf-8")
            probe = probe_write_cleanup((root,), token_factory=lambda: "fixed")
            self.assertEqual(probe.write_status, "blocked")
            self.assertEqual(source.read_text(encoding="utf-8"), "existing-source")
            self.assertEqual(renamed.read_text(encoding="utf-8"), "existing-renamed")

            source.unlink()
            probe = probe_write_cleanup((root,), token_factory=lambda: "fixed")
            self.assertEqual(probe.write_status, "blocked")
            self.assertFalse(source.exists())
            self.assertEqual(renamed.read_text(encoding="utf-8"), "existing-renamed")

    def test_broken_directory_link_is_blocked_instead_of_falling_back_to_parent(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            broken = root / "broken-directory"
            try:
                broken.symlink_to(root / "missing-target", target_is_directory=True)
            except OSError as exc:
                self.skipTest(f"Directory symlink creation is unavailable: {exc}")
            target = broken / "future"
            probe = probe_write_cleanup((target,))
            self.assertEqual(probe.write_status, "blocked")
            with self.assertRaises((NotADirectoryError, OSError)):
                read_volume_space(target)

    def test_fixed_port_distinguishes_product_other_and_unknown_listener(self) -> None:
        listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        listener.bind(("127.0.0.1", 0))
        listener.listen(1)
        port = listener.getsockname()[1]
        try:
            self.assertEqual(
                inspect_fixed_port(
                    port=port,
                    expected_product_id="barorok-local-engine",
                    own_engine_marker=lambda: False,
                    product_probe=lambda _port: True,
                ).state,
                "local_engine",
            )
            self.assertEqual(
                inspect_fixed_port(
                    port=port,
                    expected_product_id="barorok-local-engine",
                    own_engine_marker=lambda: False,
                    product_probe=lambda _port: False,
                ).state,
                "occupied",
            )
            self.assertEqual(
                inspect_fixed_port(
                    port=port,
                    expected_product_id="barorok-local-engine",
                    own_engine_marker=lambda: False,
                    product_probe=lambda _port: None,
                ).state,
                "occupied",
            )
        finally:
            listener.close()

    def test_server_preflight_finishes_before_settings_data_or_engine_start(self) -> None:
        from web_local_engine_server import main

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            output_path = root / "result.json"
            payload = {"schema_version": 1, "overall_status": "pass", "checks": []}
            with (
                patch("web_local_engine_server.collect_windows_preflight", return_value=payload) as collect,
                patch("web_local_engine_server.write_preflight_json") as write,
                patch("web_local_engine_server._resolve_startup_layout") as layout,
                patch("web_local_engine_server._resolve_startup_settings") as settings,
                patch("web_local_engine_server.prepare_web_local_engine_data") as prepare,
                patch("web_local_engine_server.WindowsNamedMutex") as mutex,
            ):
                self.assertEqual(main(["--preflight-json", str(output_path)]), 0)
            collect.assert_called_once_with()
            write.assert_called_once_with(str(output_path), payload)
            layout.assert_not_called()
            settings.assert_not_called()
            prepare.assert_not_called()
            mutex.assert_not_called()

    def test_server_preflight_returns_a_quiet_error_when_output_cannot_be_written(self) -> None:
        from web_local_engine_server import main

        with tempfile.TemporaryDirectory() as temp_dir:
            output_path = Path(temp_dir) / "preflight.json"
            with (
                patch("web_local_engine_server.collect_windows_preflight", return_value={"schema_version": 1}),
                patch("web_local_engine_server.write_preflight_json", side_effect=FileExistsError),
                patch("web_local_engine_server._resolve_startup_layout") as layout,
            ):
                self.assertEqual(main(["--preflight-json", str(output_path)]), 2)
            layout.assert_not_called()

    def test_server_installer_preflight_uses_canonical_targets_before_startup(self) -> None:
        from web_local_engine_server import main

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            request_path = root / "request.json"
            output_path = root / "result.json"
            layout_value = SimpleNamespace(
                install_root=root / "Programs" / "Barorok" / "LocalEngine",
                data_root=root / "Barorok" / "LocalEngine",
                models_dir=root / "Barorok" / "LocalEngine" / "models",
                temp_dir=root / "Barorok" / "LocalEngine" / "temp",
                results_dir=root / "Barorok" / "LocalEngine" / "results",
            )
            requirements = self._requirements()
            payload = {
                "schema_version": 1,
                "preflight_kind": "installer_target",
                "overall_status": "blocked",
                "checks": [],
            }
            with (
                patch("web_local_engine_server.read_installer_preflight_request", return_value=(4, requirements)) as read,
                patch("web_local_engine_server.resolve_web_local_engine_layout", return_value=layout_value) as resolve,
                patch("web_local_engine_server.collect_installer_target_preflight", return_value=payload) as collect,
                patch("web_local_engine_server.write_preflight_json") as write,
                patch("web_local_engine_server._resolve_startup_layout") as startup_layout,
                patch("web_local_engine_server._resolve_startup_settings") as settings,
                patch("web_local_engine_server.prepare_web_local_engine_data") as prepare,
                patch("web_local_engine_server.WindowsNamedMutex") as mutex,
            ):
                self.assertEqual(main([
                    "--installer-target-preflight-json",
                    str(request_path),
                    str(output_path),
                ]), 0)
            read.assert_called_once_with(str(request_path))
            resolve.assert_called_once_with()
            collect.assert_called_once()
            write.assert_called_once_with(str(output_path), payload)
            startup_layout.assert_not_called()
            settings.assert_not_called()
            prepare.assert_not_called()
            mutex.assert_not_called()


if __name__ == "__main__":
    unittest.main()
