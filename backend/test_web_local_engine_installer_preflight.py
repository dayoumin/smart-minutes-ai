import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

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
    write_installer_decision,
)
from local_engine_preflight import InstallerTargetPaths, PortInspection


class WebLocalEngineInstallerPreflightTest(unittest.TestCase):
    def _manifest(
        self,
        root: Path,
        *,
        duplicate: bool = False,
        escaped: bool = False,
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
        path = root / "poc-manifest.json"
        path.write_text(
            json.dumps(
                {
                    "packageFormat": "barorok-web-local-engine-poc-v1",
                    "engineVersion": "test",
                    "installScope": "current-user",
                    "bind": "127.0.0.1:17863",
                    "userDataRoot": "%LOCALAPPDATA%\\Barorok\\LocalEngine",
                    "signed": False,
                    "distributionReady": False,
                    "payloadFiles": files,
                }
            ),
            encoding="utf-8",
        )
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
        self.assertIsNone(requirements["models"].required_bytes)
        self.assertIsNone(requirements["analysis_temp"].recommended_bytes)
        self.assertIsNone(requirements["results"].required_bytes)

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


if __name__ == "__main__":
    unittest.main()
