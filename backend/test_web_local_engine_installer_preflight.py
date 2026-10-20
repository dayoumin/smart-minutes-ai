import ast
import functools
import json
import os
import re
import subprocess
import tempfile
import unittest
from pathlib import Path, PureWindowsPath
from unittest.mock import patch

import web_local_engine_installer_preflight as installer_preflight
import web_local_engine_storage_requirements as storage_requirements_module
from config_normalization import DEFAULT_SUMMARY_MODEL
from web_local_engine_installer_preflight import (
    EXPECTED_CHECK_IDS,
    InstallerDecision,
    INSTALLER_METADATA_RESERVE_BYTES,
    INSTALL_MARKER_CONTENT,
    cleanup_owned_install_tree,
    cleanup_uninstall_tombstone,
    evaluate_installer_preflight,
    main,
    probe_running_engine,
    probe_stopped_engine,
    requirements_from_artifact_manifest,
    storage_requirements_from_manifest,
    write_installer_decision,
)
from web_local_engine_storage_requirements import storage_requirements
from local_engine_preflight import InstallerTargetPaths, PortInspection, VolumeSpace


GIB = 1024 ** 3


class WebLocalEngineStorageRequirementsTest(unittest.TestCase):
    def test_derived_values_match_documented_sources(self) -> None:
        derived = storage_requirements()
        self.assertEqual(set(derived), {"models", "analysisTemp", "results"})
        self.assertEqual(derived["models"]["requiredBytes"], 11_185_989_538)
        self.assertEqual(derived["models"]["recommendedBytes"], 12_210_001_824)
        self.assertEqual(derived["analysisTemp"]["requiredBytes"], 1_764_941_824)
        self.assertEqual(derived["analysisTemp"]["recommendedBytes"], 2_916_941_824)
        self.assertEqual(derived["results"]["requiredBytes"], 268_435_456)
        self.assertEqual(derived["results"]["recommendedBytes"], 1_073_741_824)
        for entry in derived.values():
            self.assertTrue(entry["basis"])
            self.assertGreaterEqual(entry["recommendedBytes"], entry["requiredBytes"])

    def test_sources_still_match_backend_constants(self) -> None:
        main_source = (Path(__file__).resolve().parent / "main.py").read_text(encoding="utf-8")
        constants = {}
        for node in ast.parse(main_source).body:
            if isinstance(node, ast.Assign) and len(node.targets) == 1 and isinstance(node.targets[0], ast.Name):
                if node.targets[0].id in {
                    "MODEL_DOWNLOAD_EXPECTED_BYTES",
                    "MODEL_DOWNLOAD_FREE_SPACE_BUFFER_BYTES",
                    "OLLAMA_RUNTIME_FREE_SPACE_BUFFER_BYTES",
                }:
                    constants[node.targets[0].id] = eval(compile(ast.Expression(node.value), "main.py", "eval"), {})
        self.assertEqual(
            constants["MODEL_DOWNLOAD_EXPECTED_BYTES"]["stt_faster_whisper"],
            storage_requirements_module.STT_MODEL_BYTES,
        )
        self.assertEqual(
            constants["MODEL_DOWNLOAD_FREE_SPACE_BUFFER_BYTES"],
            storage_requirements_module.DOWNLOAD_FREE_SPACE_BUFFER_BYTES,
        )
        self.assertEqual(
            constants["OLLAMA_RUNTIME_FREE_SPACE_BUFFER_BYTES"],
            storage_requirements_module.DOWNLOAD_FREE_SPACE_BUFFER_BYTES,
        )
        runtime_default = re.search(r'"LMO_OLLAMA_RUNTIME_EXPECTED_BYTES", "(\d+)"', main_source)
        self.assertIsNotNone(runtime_default)
        self.assertEqual(int(runtime_default.group(1)), storage_requirements_module.SUMMARY_RUNTIME_ARCHIVE_BYTES)
        # SUMMARY_MODEL_BYTES is the measured gemma4:e2b size; a new default needs a new measurement.
        self.assertEqual(DEFAULT_SUMMARY_MODEL, "gemma4:e2b")

    def test_script_prints_ascii_manifest_block_accepted_by_the_installer(self) -> None:
        with patch("sys.stdout") as stdout:
            self.assertEqual(storage_requirements_module.main(), 0)
        printed = "".join(call.args[0] for call in stdout.write.call_args_list)
        self.assertTrue(printed.isascii())
        parsed = storage_requirements_from_manifest({"storageRequirements": json.loads(printed)})
        self.assertEqual(parsed["models"].required_bytes, 11_185_989_538)
        self.assertEqual(parsed["analysis_temp"].recommended_bytes, 2_916_941_824)
        self.assertEqual(parsed["results"].required_bytes, 268_435_456)
        self.assertNotIn("install", parsed)


class WebLocalEngineInstallerPreflightTest(unittest.TestCase):
    def _manifest(
        self,
        root: Path,
        *,
        duplicate: bool = False,
        escaped: bool = False,
        storage: dict | None = None,
    ) -> Path:
        files = [
            {
                "path": "..\\escape.exe" if escaped else "engine\\engine.exe",
                "bytes": 120,
                "sha256": "a" * 64,
            },
            {"path": "defaults\\config.json", "bytes": 30, "sha256": "b" * 64},
        ]
        if duplicate:
            files.append({"path": "ENGINE\\engine.exe", "bytes": 1, "sha256": "c" * 64})
        manifest = {
            "packageFormat": "barorok-web-local-engine-poc-v1",
            "engineVersion": "test",
            "installScope": "current-user",
            "bind": "127.0.0.1:17863",
            "userDataRoot": "%LOCALAPPDATA%\\Barorok\\LocalEngine",
            "signed": False,
            "distributionReady": False,
            "payloadFiles": files,
        }
        if storage is not None:
            manifest["storageRequirements"] = storage
        path = root / "poc-manifest.json"
        path.write_text(json.dumps(manifest), encoding="utf-8")
        return path

    def _payload(
        self,
        *,
        overrides: dict[str, tuple[str, str]] | None = None,
        overall_status: str | None = None,
        generation: int = 7,
    ) -> dict:
        overrides = overrides or {}
        checks = []
        for check_id in EXPECTED_CHECK_IDS:
            status, action = overrides.get(check_id, ("pass", "none"))
            checks.append(
                {
                    "check_id": check_id,
                    "status": status,
                    "severity": "info" if status == "pass" else "warning",
                    "reason_code": "synthetic_result",
                    "action_code": action,
                    "retryable": status != "pass",
                    "checked_at": 1234,
                    "measured": {},
                    "required": {},
                }
            )
        if overall_status is None:
            statuses = {check["status"] for check in checks}
            overall_status = next(
                (candidate for candidate in ("blocked", "warning", "unknown") if candidate in statuses),
                "pass",
            )
        return {
            "schema_version": 1,
            "preflight_kind": "installer_target",
            "run_id": "a" * 32,
            "request_generation": generation,
            "overall_status": overall_status,
            "checked_at": 1234,
            "checks": checks,
        }

    def test_manifest_uses_payload_bytes_for_install_and_transactional_staging(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest = self._manifest(Path(temp_dir))
            requirements = requirements_from_artifact_manifest(manifest)
            manifest_allocation = ((manifest.stat().st_size + 4095) // 4096) * 4096
        expected = (2 * 4096) + manifest_allocation + INSTALLER_METADATA_RESERVE_BYTES
        self.assertEqual(requirements["install"].required_bytes, expected)
        self.assertEqual(requirements["staging"].required_bytes, expected)
        self.assertEqual(requirements["install"].recommended_bytes, expected)
        # A manifest from an earlier release has no post-install sizes.
        self.assertIsNone(requirements["models"].required_bytes)
        self.assertIsNone(requirements["analysis_temp"].recommended_bytes)
        self.assertIsNone(requirements["results"].required_bytes)

    def test_manifest_storage_requirements_fill_post_install_roles(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            legacy = requirements_from_artifact_manifest(self._manifest(Path(temp_dir)))
        with tempfile.TemporaryDirectory() as temp_dir:
            manifest = self._manifest(Path(temp_dir), storage=storage_requirements())
            requirements = requirements_from_artifact_manifest(manifest)
        self.assertIsNone(legacy["models"].recommended_bytes)
        self.assertEqual(requirements["models"].required_bytes, 11_185_989_538)
        self.assertEqual(requirements["models"].recommended_bytes, 12_210_001_824)
        self.assertEqual(requirements["analysis_temp"].required_bytes, 1_764_941_824)
        self.assertEqual(requirements["analysis_temp"].recommended_bytes, 2_916_941_824)
        self.assertEqual(requirements["results"].required_bytes, 268_435_456)
        self.assertEqual(requirements["results"].recommended_bytes, 1_073_741_824)
        # The installed payload stays measured from payloadFiles, not from storageRequirements.
        self.assertEqual(requirements["install"], legacy["install"])
        self.assertEqual(set(requirements), {"install", "staging", "models", "analysis_temp", "results"})

    def test_manifest_rejects_incomplete_or_invalid_storage_requirements(self) -> None:
        valid = storage_requirements()
        invalid_cases = {
            "missing role": {key: value for key, value in valid.items() if key != "results"},
            "extra role": {**valid, "install": valid["results"]},
            "recommended below required": {
                **valid,
                "models": {"requiredBytes": 10, "recommendedBytes": 9},
            },
            "boolean": {**valid, "results": {"requiredBytes": True, "recommendedBytes": 2}},
            "zero": {**valid, "results": {"requiredBytes": 0, "recommendedBytes": 2}},
            "text": {**valid, "results": {"requiredBytes": "1", "recommendedBytes": 2}},
            "not an object": {**valid, "analysisTemp": 5},
            "too large": {
                **valid,
                "models": {"requiredBytes": 1, "recommendedBytes": 2 * 1024 ** 4},
            },
        }
        for label, storage in invalid_cases.items():
            with self.subTest(label):
                with tempfile.TemporaryDirectory() as temp_dir:
                    manifest = self._manifest(Path(temp_dir), storage=storage)
                    with self.assertRaisesRegex(ValueError, "storage requirements are invalid"):
                        requirements_from_artifact_manifest(manifest)

    def test_manifest_rejects_duplicate_and_escaped_payload_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with self.assertRaisesRegex(ValueError, "duplicated"):
                requirements_from_artifact_manifest(self._manifest(root, duplicate=True))
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with self.assertRaisesRegex(ValueError, "path is invalid"):
                requirements_from_artifact_manifest(self._manifest(root, escaped=True))

    def test_evaluate_maps_ready_and_advisory_unknown(self) -> None:
        ready = evaluate_installer_preflight(self._payload(), request_generation=7)
        self.assertEqual(ready, InstallerDecision("ready", "none", 0))

        confirm = evaluate_installer_preflight(
            self._payload(overrides={
                "installer_model_space": ("unknown", "retry_check"),
                "installer_analysis_temp_space": ("unknown", "retry_check"),
                "installer_results_space": ("unknown", "retry_check"),
            }),
            request_generation=7,
        )
        self.assertEqual(confirm, InstallerDecision("confirm", "retry_check", 10))
        self.assertIsNone(confirm.free_space_bytes)

    def test_evaluate_reports_space_to_free_for_low_space_warning(self) -> None:
        payload = self._payload(overrides={
            "installer_model_space": ("warning", "free_space_and_retry"),
            "installer_analysis_temp_space": ("warning", "free_space_and_retry"),
            "installer_results_space": ("warning", "free_space_and_retry"),
        })
        for check in payload["checks"]:
            if check["status"] == "warning":
                check["measured"] = {
                    "available_after_install_bytes": 10 * GIB,
                    "aggregate_recommended_bytes": 13 * GIB + 1,
                }
        decision = evaluate_installer_preflight(payload, request_generation=7)
        self.assertEqual(
            decision,
            InstallerDecision("confirm", "free_space_and_retry", 10, 3 * GIB + 1),
        )

        healthy = evaluate_installer_preflight(self._payload(), request_generation=7)
        self.assertIsNone(healthy.free_space_bytes)
        self.assertEqual(healthy.decision, "ready")

    def test_evaluate_maps_blocked_critical_unknown_and_running_engine(self) -> None:
        blocked = evaluate_installer_preflight(
            self._payload(overrides={
                "installer_fixed_port": ("blocked", "close_conflicting_app_and_retry"),
            }),
            request_generation=7,
        )
        self.assertEqual(
            blocked,
            InstallerDecision("blocked", "close_conflicting_app_and_retry", 20),
        )

        retry = evaluate_installer_preflight(
            self._payload(overrides={
                "installer_local_app_data_write": ("unknown", "check_folder_permissions"),
            }),
            request_generation=7,
        )
        self.assertEqual(retry, InstallerDecision("retry", "check_folder_permissions", 30))

        running = evaluate_installer_preflight(
            self._payload(overrides={
                "installer_fixed_port": ("warning", "stop_local_engine_and_retry"),
            }),
            request_generation=7,
        )
        self.assertEqual(running, InstallerDecision("confirm", "stop_local_engine_and_retry", 10))

    def test_evaluate_rejects_stale_duplicate_and_inconsistent_results(self) -> None:
        with self.assertRaisesRegex(ValueError, "identity"):
            evaluate_installer_preflight(self._payload(generation=6), request_generation=7)

        duplicate = self._payload()
        duplicate["checks"][-1]["check_id"] = duplicate["checks"][0]["check_id"]
        with self.assertRaisesRegex(ValueError, "invalid"):
            evaluate_installer_preflight(duplicate, request_generation=7)

        inconsistent = self._payload(overall_status="warning")
        with self.assertRaisesRegex(ValueError, "inconsistent"):
            evaluate_installer_preflight(inconsistent, request_generation=7)

    def test_probe_running_engine_requires_exact_local_engine_classification(self) -> None:
        paths = InstallerTargetPaths(
            install=Path("install"),
            staging=Path("stage"),
            models=Path("data/models"),
            analysis_temp=Path("data/temp"),
            results=Path("data/results"),
            write_targets=(Path("install"), Path("data")),
        )
        self.assertTrue(probe_running_engine(
            paths,
            expected_engine_version="1.2.3",
            mutex_reader=lambda: True,
            product_probe=lambda version: version == "1.2.3",
        ))
        self.assertFalse(probe_running_engine(
            paths,
            expected_engine_version="1.2.3",
            mutex_reader=lambda: True,
            product_probe=lambda _version: False,
        ))
        self.assertFalse(probe_running_engine(
            paths,
            expected_engine_version="1.2.3",
            mutex_reader=lambda: False,
            product_probe=lambda _version: True,
        ))
        self.assertTrue(probe_stopped_engine(
            paths,
            mutex_reader=lambda: False,
            port_reader=lambda: PortInspection("available"),
        ))
        for state in ("local_engine", "occupied", "unknown"):
            self.assertFalse(probe_stopped_engine(
                paths,
                mutex_reader=lambda: False,
                port_reader=lambda state=state: PortInspection(state),
            ))
        self.assertFalse(probe_stopped_engine(
            paths,
            mutex_reader=lambda: True,
            port_reader=lambda: PortInspection("available"),
        ))

    def test_main_rejects_missing_or_mixed_mode_arguments_quietly(self) -> None:
        self.assertEqual(main([]), 2)
        self.assertEqual(main(["--probe-running-engine"]), 2)
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest = self._manifest(root)
            with patch.dict(os.environ, {"LOCALAPPDATA": str(root)}):
                with patch(
                    "web_local_engine_installer_preflight.probe_running_engine",
                    return_value=True,
                ):
                    self.assertEqual(main([
                        "--probe-running-engine",
                        "--manifest",
                        str(manifest),
                    ]), 0)

    def test_cleanup_removes_only_declared_owned_tree(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest = self._manifest(root)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            (install / "engine").mkdir(parents=True)
            (install / "defaults").mkdir()
            (install / "installer").mkdir()
            (install / "engine" / "engine.exe").write_bytes(b"payload")
            (install / "defaults" / "config.json").write_text("{}", encoding="utf-8")
            (install / ".barorok-install-owned").write_text(
                INSTALL_MARKER_CONTENT,
                encoding="utf-8",
            )
            (install / "poc-manifest.json").write_text("{}", encoding="utf-8")
            (install / "Uninstall.exe").write_bytes(b"uninstall")
            (install / "installer" / "barorok-installer-preflight.exe").write_bytes(b"helper")
            cleanup_owned_install_tree(install, manifest, local_app_data=root)
            self.assertFalse(install.exists())

    def test_cleanup_rejects_undeclared_file_before_deleting_payload(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest = self._manifest(root)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            (install / "engine").mkdir(parents=True)
            payload = install / "engine" / "engine.exe"
            payload.write_bytes(b"payload")
            (install / ".barorok-install-owned").write_text(
                INSTALL_MARKER_CONTENT,
                encoding="utf-8",
            )
            (install / "user-note.txt").write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "undeclared file"):
                cleanup_owned_install_tree(install, manifest, local_app_data=root)
            self.assertTrue(payload.exists())
            self.assertTrue((install / "user-note.txt").exists())

    def test_cleanup_preserves_recovery_evidence_for_self_removal(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest = self._manifest(root)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            (install / "engine").mkdir(parents=True)
            (install / "defaults").mkdir()
            (install / "installer").mkdir()
            (install / "engine" / "engine.exe").write_bytes(b"payload")
            (install / "defaults" / "config.json").write_text("{}", encoding="utf-8")
            (install / ".barorok-install-owned").write_text(
                INSTALL_MARKER_CONTENT,
                encoding="utf-8",
            )
            (install / ".barorok-transaction-pending").write_text("pending", encoding="utf-8")
            (install / "poc-manifest.json").write_text("{}", encoding="utf-8")
            (install / "Uninstall.exe").write_bytes(b"uninstall")
            helper = install / "installer" / "barorok-installer-preflight.exe"
            helper.write_bytes(b"helper")

            cleanup_owned_install_tree(
                install,
                manifest,
                local_app_data=root,
                preserve_self_removal_files=True,
            )

            self.assertFalse((install / "engine").exists())
            self.assertFalse((install / "defaults").exists())
            self.assertTrue((install / ".barorok-install-owned").exists())
            self.assertTrue((install / ".barorok-transaction-pending").exists())
            self.assertTrue((install / "poc-manifest.json").exists())
            self.assertTrue((install / "Uninstall.exe").exists())
            self.assertTrue(helper.exists())

    def test_cleanup_deletes_transaction_marker_after_other_control_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest = self._manifest(root)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            install.mkdir(parents=True)
            marker = install / ".barorok-install-owned"
            transaction = install / ".barorok-transaction-pending"
            installed_manifest = install / "poc-manifest.json"
            marker.write_text(INSTALL_MARKER_CONTENT, encoding="utf-8")
            transaction.write_text("pending", encoding="utf-8")
            installed_manifest.write_text("{}", encoding="utf-8")

            deleted: list[str] = []
            original_unlink = Path.unlink

            def record_unlink(path: Path, *args, **kwargs) -> None:
                deleted.append(path.name)
                original_unlink(path, *args, **kwargs)

            with patch.object(Path, "unlink", record_unlink):
                cleanup_owned_install_tree(install, manifest, local_app_data=root)

            self.assertGreater(
                deleted.index(".barorok-transaction-pending"),
                deleted.index("poc-manifest.json"),
            )
            self.assertGreater(
                deleted.index(".barorok-transaction-pending"),
                deleted.index(".barorok-install-owned"),
            )

    def test_cleanup_keeps_recovery_evidence_when_directory_removal_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest = self._manifest(root)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            (install / "engine").mkdir(parents=True)
            (install / "engine" / "engine.exe").write_bytes(b"payload")
            marker = install / ".barorok-install-owned"
            transaction = install / ".barorok-transaction-pending"
            marker.write_text(INSTALL_MARKER_CONTENT, encoding="utf-8")
            transaction.write_text("pending", encoding="utf-8")
            original_rmdir = Path.rmdir

            def fail_engine_rmdir(path: Path) -> None:
                if path.name == "engine":
                    raise PermissionError("synthetic lock")
                original_rmdir(path)

            with patch.object(Path, "rmdir", fail_engine_rmdir):
                with self.assertRaises(PermissionError):
                    cleanup_owned_install_tree(install, manifest, local_app_data=root)

            self.assertTrue(marker.exists())
            self.assertTrue(transaction.exists())

    def test_cleanup_retries_a_transient_directory_lock(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest = self._manifest(root)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            (install / "engine").mkdir(parents=True)
            (install / "engine" / "engine.exe").write_bytes(b"payload")
            (install / ".barorok-install-owned").write_text(
                INSTALL_MARKER_CONTENT,
                encoding="utf-8",
            )
            original_rmdir = Path.rmdir
            attempts = 0

            def fail_once(path: Path) -> None:
                nonlocal attempts
                if path.name == "engine" and attempts == 0:
                    attempts += 1
                    raise PermissionError("synthetic transient lock")
                original_rmdir(path)

            with patch.object(Path, "rmdir", fail_once):
                cleanup_owned_install_tree(install, manifest, local_app_data=root)

            self.assertEqual(attempts, 1)
            self.assertFalse(install.exists())

    def test_cleanup_restores_recovery_evidence_when_root_removal_fails(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest = self._manifest(root)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            install.mkdir(parents=True)
            marker = install / ".barorok-install-owned"
            transaction = install / ".barorok-transaction-pending"
            marker.write_text(INSTALL_MARKER_CONTENT, encoding="utf-8")
            transaction.write_text("pending", encoding="utf-8")
            (install / "poc-manifest.json").write_text("{}", encoding="utf-8")
            original_rmdir = Path.rmdir

            def fail_root_rmdir(path: Path) -> None:
                if path == install:
                    raise PermissionError("synthetic root lock")
                original_rmdir(path)

            with patch.object(Path, "rmdir", fail_root_rmdir):
                with self.assertRaises(PermissionError):
                    cleanup_owned_install_tree(install, manifest, local_app_data=root)

            self.assertEqual(marker.read_text(encoding="utf-8"), INSTALL_MARKER_CONTENT)
            self.assertEqual(transaction.read_text(encoding="utf-8"), "pending")
            self.assertEqual(
                json.loads((install / "poc-manifest.json").read_text(encoding="utf-8"))["packageFormat"],
                "barorok-web-local-engine-poc-v1",
            )

    def test_validate_owned_tree_checks_marker_content_without_deleting(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest = self._manifest(root)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            (install / "engine").mkdir(parents=True)
            payload = install / "engine" / "engine.exe"
            payload.write_bytes(b"payload")
            marker = install / ".barorok-install-owned"
            marker.write_text(INSTALL_MARKER_CONTENT, encoding="utf-8")
            cleanup_owned_install_tree(
                install,
                manifest,
                local_app_data=root,
                validate_only=True,
            )
            self.assertTrue(payload.exists())
            marker.write_text("forged", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "ownership marker"):
                cleanup_owned_install_tree(
                    install,
                    manifest,
                    local_app_data=root,
                    validate_only=True,
                )

    def test_complete_stage_validation_rejects_missing_payload_or_transaction(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            manifest = self._manifest(root)
            stage = root / "Programs" / "Barorok" / ".LocalEngine-stage"
            (stage / "engine").mkdir(parents=True)
            (stage / "defaults").mkdir()
            (stage / "installer").mkdir()
            (stage / "engine" / "engine.exe").write_bytes(b"payload")
            (stage / "defaults" / "config.json").write_text("{}", encoding="utf-8")
            (stage / ".barorok-install-owned").write_text(INSTALL_MARKER_CONTENT, encoding="utf-8")
            (stage / ".barorok-transaction-pending").write_text("pending", encoding="utf-8")
            (stage / "poc-manifest.json").write_text("{}", encoding="utf-8")
            (stage / "Uninstall.exe").write_bytes(b"uninstall")
            helper = stage / "installer" / "barorok-installer-preflight.exe"
            helper.write_bytes(b"helper")

            cleanup_owned_install_tree(
                stage,
                manifest,
                local_app_data=root,
                validate_only=True,
                require_complete_tree=True,
                require_transaction_marker=True,
            )
            (stage / "defaults" / "config.json").unlink()
            with self.assertRaisesRegex(ValueError, "incomplete"):
                cleanup_owned_install_tree(
                    stage,
                    manifest,
                    local_app_data=root,
                    validate_only=True,
                    require_complete_tree=True,
                    require_transaction_marker=True,
                )
            (stage / "defaults" / "config.json").write_text("{}", encoding="utf-8")
            (stage / ".barorok-transaction-pending").unlink()
            with self.assertRaisesRegex(ValueError, "incomplete"):
                cleanup_owned_install_tree(
                    stage,
                    manifest,
                    local_app_data=root,
                    validate_only=True,
                    require_complete_tree=True,
                    require_transaction_marker=True,
                )

    def test_uninstall_tombstone_cleanup_is_closed_and_retryable(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            (install / "installer").mkdir(parents=True)
            (install / ".barorok-uninstall-pending").write_text(
                "barorok-local-engine-uninstall-v1",
                encoding="utf-8",
            )
            (install / "Uninstall.exe").write_bytes(b"uninstall")
            (install / "installer" / "barorok-installer-preflight.exe").write_bytes(b"helper")
            cleanup_uninstall_tombstone(install, local_app_data=root)
            self.assertFalse(install.exists())

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            install.mkdir(parents=True)
            tombstone = install / ".barorok-uninstall-pending"
            tombstone.write_text("barorok-local-engine-uninstall-v1", encoding="utf-8")
            foreign = install / "user-note.txt"
            foreign.write_text("keep", encoding="utf-8")
            with self.assertRaisesRegex(ValueError, "undeclared file"):
                cleanup_uninstall_tombstone(install, local_app_data=root)
            self.assertTrue(tombstone.exists())
            self.assertTrue(foreign.exists())

    def test_decision_is_temp_confined_non_overwriting_and_private(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            decision_path = root / "decision.ini"
            write_installer_decision(
                decision_path,
                InstallerDecision("blocked", "free_space_and_retry", 20),
                request_generation=7,
                temp_root=root,
            )
            content = decision_path.read_text(encoding="utf-8")
            self.assertEqual(
                content,
                "[preflight]\n"
                "decision=blocked\n"
                "primary_action=free_space_and_retry\n"
                "request_generation=7\n",
            )
            self.assertNotIn(str(root), content)
            with self.assertRaises(FileExistsError):
                write_installer_decision(
                    decision_path,
                    InstallerDecision("ready", "none", 0),
                    request_generation=8,
                    temp_root=root,
                )
            with self.assertRaisesRegex(ValueError, "temporary directory"):
                write_installer_decision(
                    root.parent / "outside.ini",
                    InstallerDecision("ready", "none", 0),
                    request_generation=7,
                    temp_root=root,
                )

    def test_decision_names_space_to_free_only_when_low(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            low = root / "low.ini"
            write_installer_decision(
                low,
                InstallerDecision("confirm", "free_space_and_retry", 10, 3 * GIB + 1),
                request_generation=2,
                temp_root=root,
                storage_drive="C:",
            )
            unsafe_drive = root / "unsafe-drive.ini"
            write_installer_decision(
                unsafe_drive,
                InstallerDecision("confirm", "free_space_and_retry", 10, GIB),
                request_generation=2,
                temp_root=root,
                storage_drive="\\\\server\\share",
            )
            ready = root / "ready.ini"
            write_installer_decision(
                ready,
                InstallerDecision("ready", "none", 0),
                request_generation=2,
                temp_root=root,
                storage_drive="C:",
            )
            self.assertEqual(
                low.read_bytes().decode("ascii").splitlines(),
                [
                    "[preflight]",
                    "decision=confirm",
                    "primary_action=free_space_and_retry",
                    "request_generation=2",
                    "free_space_gb=4",
                    "free_space_drive=C:",
                ],
            )
            self.assertEqual(
                unsafe_drive.read_text(encoding="utf-8").splitlines()[-1],
                "free_space_gb=1",
            )
            self.assertNotIn("free_space", ready.read_text(encoding="utf-8"))

    def test_cleanup_ignores_storage_block_that_preflight_rejects(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            future_storage = {**storage_requirements(), "futureRole": {"requiredBytes": 1, "recommendedBytes": 1}}
            manifest = self._manifest(root, storage=future_storage)
            with self.assertRaisesRegex(ValueError, "storage requirements are invalid"):
                requirements_from_artifact_manifest(manifest)
            lenient = requirements_from_artifact_manifest(manifest, include_storage=False)
            self.assertIsNone(lenient["models"].required_bytes)
            install = root / "Programs" / "Barorok" / "LocalEngine"
            (install / "engine").mkdir(parents=True)
            (install / "defaults").mkdir()
            (install / "engine" / "engine.exe").write_bytes(b"payload")
            (install / "defaults" / "config.json").write_text("{}", encoding="utf-8")
            (install / ".barorok-install-owned").write_text(INSTALL_MARKER_CONTENT, encoding="utf-8")
            cleanup_owned_install_tree(install, manifest, local_app_data=root, validate_only=True)
            self.assertTrue((install / "engine" / "engine.exe").exists())
            cleanup_owned_install_tree(install, manifest, local_app_data=root)
            self.assertFalse(install.exists())

    def test_reusable_bytes_use_installed_manifest_and_cap_each_component(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            paths = installer_preflight._layout_paths(root)
            data_root = paths.models.parent
            before = installer_preflight._reusable_bytes(paths)
            paths.install.mkdir(parents=True)
            installed_manifest = self._manifest(paths.install)
            unowned = installer_preflight._reusable_bytes(paths)
            (paths.install / ".barorok-install-owned").write_text(INSTALL_MARKER_CONTENT, encoding="utf-8")
            files = {
                paths.models / "faster-whisper-large-v3" / "model.bin": 500,
                paths.models / "ollama" / "blobs" / "old-summary-model": 900,
                paths.models / "ollama" / "blobs" / "current-summary-model": 300,
                paths.models / "embedding" / "pytorch_model.bin": 60,
                paths.models / "unrelated-download.bin": 4000,
                data_root / "runtime" / "ollama" / "ollama.exe": 70,
                data_root / "config" / "runtime" / "ollama" / "lib.dll": 50,
            }
            for path, size in files.items():
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(b"x" * size)
            with (
                patch.object(installer_preflight, "STT_MODEL_BYTES", 400),
                patch.object(installer_preflight, "SUMMARY_MODEL_BYTES", 1000),
                patch.object(installer_preflight, "DIARIZATION_MODEL_BYTES", 100),
                patch.object(installer_preflight, "SUMMARY_RUNTIME_INSTALLED_BYTES", 110),
            ):
                after = installer_preflight._reusable_bytes(paths)
            expected_install = requirements_from_artifact_manifest(installed_manifest)["install"].required_bytes
        self.assertEqual(before, {"install": 0, "models": 0})
        self.assertEqual(unowned, {"install": 0, "models": 0})
        # STT 500 capped at 400, summary 1200 capped at 1000, speaker separation and
        # unrelated files 4060 capped at 100, both runtime folders 120 capped at 110.
        self.assertEqual(after, {"install": expected_install, "models": 400 + 1000 + 100 + 110})

    def test_reusable_bytes_credit_nothing_when_folders_cannot_be_read(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            paths = installer_preflight._layout_paths(root)
            paths.install.mkdir(parents=True)
            self._manifest(paths.install)
            (paths.install / ".barorok-install-owned").write_text(INSTALL_MARKER_CONTENT, encoding="utf-8")
            readable = installer_preflight._reusable_bytes(paths)
            with (
                patch.object(installer_preflight, "_existing_tree_bytes", side_effect=PermissionError("denied")),
                patch.object(
                    installer_preflight,
                    "requirements_from_artifact_manifest",
                    side_effect=PermissionError("denied"),
                ),
            ):
                denied = installer_preflight._reusable_bytes(paths)
        self.assertGreater(readable["install"], 0)
        self.assertEqual(denied, {"install": 0, "models": 0})

    @unittest.skipUnless(os.name == "nt", "Windows source smoke")
    def test_main_still_decides_when_existing_folders_cannot_be_read(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            with patch.object(installer_preflight, "_existing_tree_bytes", side_effect=PermissionError("denied")):
                exit_code, decision, payload = self._run_main_with_volume(
                    Path(temp_dir),
                    available_bytes=64 * GIB,
                    storage=storage_requirements(),
                )
        self.assertEqual(exit_code, 0)
        self.assertIn("decision=ready", decision)
        self.assertEqual(payload["overall_status"], "pass")

    @unittest.skipUnless(os.name == "nt", "Windows junction")
    def test_existing_tree_bytes_skips_junctions_and_stops_at_entry_limit(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            models = root / "models"
            elsewhere = root / "elsewhere"
            models.mkdir()
            elsewhere.mkdir()
            (models / "a.bin").write_bytes(b"a" * 300)
            (elsewhere / "big.bin").write_bytes(b"b" * 9000)
            linked = subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(models / "linked"), str(elsewhere)],
                capture_output=True,
                text=True,
            )
            self.assertEqual(linked.returncode, 0, linked.stdout + linked.stderr)
            self.assertTrue((models / "linked" / "big.bin").exists())
            self.assertEqual(installer_preflight._existing_tree_bytes(models), 300)
            self.assertEqual(installer_preflight._existing_tree_bytes(models / "linked"), 0)
            same_size = root / "same-size"
            same_size.mkdir()
            for index in range(5):
                (same_size / f"part-{index}.bin").write_bytes(b"e" * 10)
            self.assertEqual(installer_preflight._existing_tree_bytes(same_size), 50)
            self.assertEqual(installer_preflight._existing_tree_bytes(same_size, max_entries=2), 20)

    def _run_main_with_volume(
        self,
        root: Path,
        *,
        available_bytes: int,
        storage: dict | None,
        prepare=None,
    ) -> tuple[int, list[str], dict]:
        fake_temp = root / "임시 공간"
        local_app_data = root / "사용자 자료"
        fake_temp.mkdir()
        local_app_data.mkdir()
        if prepare is not None:
            prepare(local_app_data)
        manifest = self._manifest(root, storage=storage)
        result = fake_temp / "result.json"
        decision = fake_temp / "decision.ini"
        original_collect = installer_preflight.collect_installer_target_preflight
        previous_tempdir = tempfile.tempdir
        try:
            tempfile.tempdir = str(fake_temp)
            with (
                patch.dict(
                    os.environ,
                    {"TEMP": str(fake_temp), "TMP": str(fake_temp), "LOCALAPPDATA": str(local_app_data)},
                ),
                patch.object(
                    installer_preflight,
                    "collect_installer_target_preflight",
                    functools.partial(
                        original_collect,
                        volume_reader=lambda _path: VolumeSpace("c:\\", available_bytes),
                    ),
                ),
                patch.object(
                    installer_preflight,
                    "inspect_fixed_port",
                    lambda **_kwargs: PortInspection("available"),
                ),
            ):
                exit_code = main([
                    "--manifest", str(manifest),
                    "--result-json", str(result),
                    "--decision-ini", str(decision),
                    "--request-generation", "3",
                ])
        finally:
            tempfile.tempdir = previous_tempdir
        return (
            exit_code,
            decision.read_text(encoding="utf-8").splitlines(),
            json.loads(result.read_text(encoding="utf-8")),
        )

    @unittest.skipUnless(os.name == "nt", "Windows source smoke")
    def test_main_passes_healthy_pc_and_names_space_to_free_when_low(self) -> None:
        future_checks = (
            "installer_model_space",
            "installer_analysis_temp_space",
            "installer_results_space",
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            exit_code, decision, payload = self._run_main_with_volume(
                Path(temp_dir),
                available_bytes=64 * GIB,
                storage=storage_requirements(),
            )
        checks = {check["check_id"]: check for check in payload["checks"]}
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            decision,
            ["[preflight]", "decision=ready", "primary_action=none", "request_generation=3"],
        )
        self.assertEqual(payload["overall_status"], "pass")
        for check_id in future_checks:
            self.assertEqual(checks[check_id]["status"], "pass")
            self.assertEqual(checks[check_id]["reason_code"], "space_sufficient")
            self.assertEqual(checks[check_id]["measured"]["aggregate_recommended_bytes"], 16_200_685_472)
        self.assertNotIn("unknown", {check["status"] for check in payload["checks"]})

        # 14 GiB after install is above the 13,219,366,818-byte need but below the
        # 16,200,685,472-byte pass level, so the warning names what to free.
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            install_bytes = requirements_from_artifact_manifest(
                self._manifest(root, storage=storage_requirements())
            )["install"].required_bytes
            exit_code, decision, payload = self._run_main_with_volume(
                root,
                available_bytes=14 * GIB + install_bytes,
                storage=storage_requirements(),
            )
            drive = PureWindowsPath(str((root / "사용자 자료").resolve())).drive.upper()
        checks = {check["check_id"]: check for check in payload["checks"]}
        self.assertEqual(exit_code, 10)
        self.assertEqual(
            decision,
            [
                "[preflight]",
                "decision=confirm",
                "primary_action=free_space_and_retry",
                "request_generation=3",
                "free_space_gb=2",
                f"free_space_drive={drive}",
            ],
        )
        for check_id in future_checks:
            self.assertEqual(checks[check_id]["status"], "warning")
            self.assertEqual(checks[check_id]["reason_code"], "space_below_recommended")
            self.assertEqual(checks[check_id]["measured"]["available_after_install_bytes"], 14 * GIB)
        self.assertEqual(checks["installer_install_space"]["status"], "pass")
        self.assertNotIn("unknown", {check["status"] for check in payload["checks"]})

        # Upgrade: the same 14 GiB volume with an owned install and downloaded files
        # already on disk passes, because those bytes are not needed a second time.
        def prepare_upgrade(local_app_data: Path) -> None:
            install = local_app_data / "Programs" / "Barorok" / "LocalEngine"
            install.mkdir(parents=True)
            (install / ".barorok-install-owned").write_text(INSTALL_MARKER_CONTENT, encoding="utf-8")
            # Same release installed: its manifest states the same payload size.
            self._manifest(install, storage=storage_requirements())

        downloaded = {
            ("models", "faster-whisper-large-v3"): storage_requirements_module.STT_MODEL_BYTES,
            ("models", "ollama"): storage_requirements_module.SUMMARY_MODEL_BYTES,
            ("LocalEngine", "models"): (
                storage_requirements_module.STT_MODEL_BYTES
                + storage_requirements_module.SUMMARY_MODEL_BYTES
                + storage_requirements_module.DIARIZATION_MODEL_BYTES
            ),
            ("runtime", "ollama"): storage_requirements_module.SUMMARY_RUNTIME_INSTALLED_BYTES,
        }

        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            with patch.object(
                installer_preflight,
                "_existing_tree_bytes",
                lambda path, **_kwargs: (
                    0 if path.parent.parent.name == "config"
                    else downloaded.get((path.parent.name, path.name), 0)
                ),
            ):
                exit_code, decision, payload = self._run_main_with_volume(
                    root,
                    available_bytes=14 * GIB,
                    storage=storage_requirements(),
                    prepare=prepare_upgrade,
                )
        checks = {check["check_id"]: check for check in payload["checks"]}
        self.assertEqual(exit_code, 0)
        self.assertEqual(
            decision,
            ["[preflight]", "decision=ready", "primary_action=none", "request_generation=3"],
        )
        for check_id in future_checks:
            self.assertEqual(checks[check_id]["status"], "pass")
            self.assertEqual(checks[check_id]["measured"]["available_after_install_bytes"], 14 * GIB)
            self.assertEqual(checks[check_id]["measured"]["reused_bytes"], 11_185_989_538 + install_bytes)

        # Without the release-build sizes the same healthy volume falls back to the old question.
        with tempfile.TemporaryDirectory() as temp_dir:
            exit_code, decision, payload = self._run_main_with_volume(
                Path(temp_dir),
                available_bytes=64 * GIB,
                storage=None,
            )
        self.assertEqual(exit_code, 10)
        self.assertIn("primary_action=retry_check", decision)
        self.assertEqual(
            {check["reason_code"] for check in payload["checks"] if check["check_id"] in future_checks},
            {"space_requirement_unavailable"},
        )

    @unittest.skipUnless(os.name == "nt", "Windows source smoke")
    def test_main_source_smoke_uses_isolated_targets_and_leaves_no_canary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            fake_temp = root / "임시 공간"
            local_app_data = root / "사용자 자료"
            fake_temp.mkdir()
            local_app_data.mkdir()
            manifest = self._manifest(root)
            result = fake_temp / "result.json"
            decision = fake_temp / "decision.ini"
            previous_tempdir = tempfile.tempdir
            try:
                tempfile.tempdir = str(fake_temp)
                with patch.dict(
                    os.environ,
                    {"TEMP": str(fake_temp), "TMP": str(fake_temp), "LOCALAPPDATA": str(local_app_data)},
                ):
                    exit_code = main([
                        "--manifest", str(manifest),
                        "--result-json", str(result),
                        "--decision-ini", str(decision),
                        "--request-generation", "11",
                    ])
            finally:
                tempfile.tempdir = previous_tempdir

            self.assertEqual(exit_code, 10)
            self.assertEqual(
                decision.read_text(encoding="utf-8").splitlines(),
                [
                    "[preflight]",
                    "decision=confirm",
                    "primary_action=retry_check",
                    "request_generation=11",
                ],
            )
            payload = json.loads(result.read_text(encoding="utf-8"))
            self.assertEqual(payload["request_generation"], 11)
            self.assertEqual(payload["preflight_kind"], "installer_target")
            serialized = json.dumps(payload)
            self.assertNotIn(str(root), serialized)
            self.assertFalse((local_app_data / "Programs" / "Barorok").exists())
            self.assertFalse((local_app_data / "Barorok").exists())
            leftovers = [path for path in root.rglob("*") if "preflight" in path.name.lower()]
            self.assertEqual(leftovers, [])

    @unittest.skipUnless(os.name == "nt", "Windows source smoke")
    def test_main_accepts_nsis_plugins_dir_when_tmp_and_temp_differ(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            python_temp = root / "TEMP 폴더"
            nsis_temp = root / "TMP 폴더"
            plugins_dir = nsis_temp / "nsA1B2.tmp"
            local_app_data = root / "사용자 자료"
            python_temp.mkdir()
            plugins_dir.mkdir(parents=True)
            local_app_data.mkdir()
            manifest = self._manifest(root)
            result = plugins_dir / "preflight-result.json"
            decision = plugins_dir / "preflight-decision.ini"
            previous_tempdir = tempfile.tempdir
            try:
                tempfile.tempdir = str(python_temp)
                with patch.dict(
                    os.environ,
                    {"TEMP": str(python_temp), "TMP": str(nsis_temp), "LOCALAPPDATA": str(local_app_data)},
                ):
                    exit_code = main([
                        "--manifest", str(manifest),
                        "--result-json", str(result),
                        "--decision-ini", str(decision),
                        "--request-generation", "1",
                    ])
            finally:
                tempfile.tempdir = previous_tempdir

            self.assertEqual(exit_code, 10)
            self.assertTrue(result.is_file())
            self.assertEqual(
                decision.read_text(encoding="utf-8").splitlines(),
                [
                    "[preflight]",
                    "decision=confirm",
                    "primary_action=retry_check",
                    "request_generation=1",
                ],
            )
            self.assertEqual(list(python_temp.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
