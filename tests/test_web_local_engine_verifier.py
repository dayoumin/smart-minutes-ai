from __future__ import annotations

import hashlib
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import MagicMock, patch


ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "scripts"))
import verify_web_local_engine_poc as verifier  # noqa: E402
import verify_installer_target_preflight_source as source_verifier  # noqa: E402


class WebLocalEngineVerifierTest(unittest.TestCase):
    def test_directory_rename_retries_a_transient_windows_access_denial(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "source"
            target = Path(temp_dir) / "target"
            source.mkdir()
            with (
                patch.object(Path, "rename", side_effect=[PermissionError(), None]) as rename,
                patch("verify_web_local_engine_poc.time.sleep") as sleep,
            ):
                verifier.rename_directory_with_retry(source, target)

        self.assertEqual(rename.call_count, 2)
        sleep.assert_called_once_with(0.1)

    def _write_artifact(self, root: Path) -> Path:
        artifact = root / "artifact"
        files = {
            "engine/ffmpeg.exe": b"ffmpeg",
            "engine/engine.exe": b"engine",
            "defaults/config.json": b"{}",
        }
        payload = []
        for relative, content in files.items():
            path = artifact / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(content)
            payload.append({
                "path": relative.replace("/", "\\"),
                "bytes": len(content),
                "sha256": hashlib.sha256(content).hexdigest(),
            })
        (artifact / "poc-manifest.json").write_text(json.dumps({
            "distributionReady": False,
            "signed": False,
            "bind": "127.0.0.1:17863",
            "payloadFiles": payload,
        }), encoding="utf-8")
        return artifact

    def test_manifest_is_closed_world_and_rejects_unlisted_files(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact = self._write_artifact(Path(temp_dir))
            _manifest, snapshot = verifier.verify_manifest(artifact)
            self.assertEqual(len(snapshot), 3)

            (artifact / "engine" / "unexpected.dll").write_bytes(b"unexpected")
            with self.assertRaisesRegex(RuntimeError, "file set mismatch"):
                verifier.verify_manifest(artifact)

    def test_manifest_rejects_duplicate_and_traversal_paths(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            artifact = self._write_artifact(root)
            manifest_path = artifact / "poc-manifest.json"
            manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
            manifest["payloadFiles"].append(dict(manifest["payloadFiles"][0]))
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "duplicated"):
                verifier.verify_manifest(artifact)

            outside = root / "outside.bin"
            outside.write_bytes(b"outside")
            manifest["payloadFiles"] = manifest["payloadFiles"][:-1]
            manifest["payloadFiles"].append({
                "path": "../outside.bin",
                "bytes": outside.stat().st_size,
                "sha256": hashlib.sha256(outside.read_bytes()).hexdigest(),
            })
            manifest_path.write_text(json.dumps(manifest), encoding="utf-8")
            with self.assertRaisesRegex(RuntimeError, "unsafe"):
                verifier.verify_manifest(artifact)

    def test_start_probe_failure_always_reaps_the_engine(self) -> None:
        process = MagicMock()
        process.poll.return_value = None
        with (
            patch.object(verifier, "start_process", return_value=process),
            patch.object(verifier, "wait_for_probe", side_effect=RuntimeError("not ready")),
        ):
            with self.assertRaisesRegex(RuntimeError, "not ready"):
                verifier.start_and_probe(
                    Path("engine.exe"),
                    {},
                    "https://minutes.example",
                )
        process.kill.assert_called_once_with()
        process.wait.assert_called_once_with(timeout=5)

    def test_frozen_preflight_contract_is_validated_and_output_is_removed(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            executable = root / "artifact" / "engine" / verifier.ENGINE_EXE_NAME
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"engine")
            calls = 0
            child_environments = []

            def run_preflight(command, **kwargs):
                nonlocal calls
                calls += 1
                child_environments.append(kwargs["env"])
                output_path = Path(command[-1])
                if calls == 1:
                    output_path.write_text(json.dumps({
                        "schema_version": 1,
                        "preflight_kind": "host_system",
                        "run_id": "a" * 32,
                        "overall_status": "pass",
                        "checks": [
                            {"check_id": "supported_windows"},
                            {"check_id": "supported_architecture"},
                            {"check_id": "system_memory"},
                        ],
                    }), encoding="utf-8")
                    return MagicMock(returncode=0)
                return MagicMock(returncode=2)

            with patch.object(verifier.subprocess, "run", side_effect=run_preflight):
                payload = verifier.exercise_preflight_json(
                    executable,
                    {"LOCALAPPDATA": str(root / "local-data"), "USERNAME": "system"},
                    temp_root=root,
                )

            self.assertEqual(payload["schema_version"], 1)
            self.assertEqual(calls, 2)
            self.assertTrue(all(item["USERNAME"].startswith("barorok-preflight-user-") for item in child_environments))
            self.assertTrue(all(item["TEMP"] == item["TMP"] for item in child_environments))
            self.assertEqual(list(root.glob("barorok-preflight-env-*")), [])

    def test_frozen_preflight_rejects_a_raw_windows_path_canary(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            executable = root / "artifact" / "engine" / verifier.ENGINE_EXE_NAME
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"engine")

            def run_preflight(command, **kwargs):
                Path(command[-1]).write_text(json.dumps({
                    "schema_version": 1,
                    "preflight_kind": "host_system",
                    "run_id": "a" * 32,
                    "overall_status": "pass",
                    "checks": [
                        {"check_id": "supported_windows"},
                        {"check_id": "supported_architecture"},
                        {
                            "check_id": "system_memory",
                            "measured": {"path": kwargs["env"]["LOCALAPPDATA"]},
                        },
                    ],
                }), encoding="utf-8")
                return MagicMock(returncode=0)

            with (
                patch.object(verifier.subprocess, "run", side_effect=run_preflight),
                self.assertRaisesRegex(RuntimeError, "private runtime data"),
            ):
                verifier.exercise_preflight_json(executable, {}, temp_root=root)

            self.assertEqual(list(root.glob("barorok-preflight-env-*")), [])

    def test_frozen_installer_target_preflight_contract_and_cleanup(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            root = Path(temp_dir)
            executable = root / "artifact" / "engine" / verifier.ENGINE_EXE_NAME
            executable.parent.mkdir(parents=True)
            executable.write_bytes(b"engine")
            runtime_temp = root / "runtime-temp"
            runtime_temp.mkdir()
            local_app_data = root / "local-app-data"
            local_app_data.mkdir()
            calls = 0

            def run_preflight(command, **_kwargs):
                nonlocal calls
                calls += 1
                output_path = Path(command[-1])
                if calls == 1:
                    output_path.write_text(json.dumps({
                        "schema_version": 1,
                        "preflight_kind": "installer_target",
                        "request_generation": 41,
                        "run_id": "b" * 32,
                        "overall_status": "pass",
                        "checks": [
                            {
                                "check_id": check_id,
                                "status": "pass",
                                "measured": {},
                                "required": {},
                            }
                            for check_id in sorted(verifier.INSTALLER_TARGET_CHECK_IDS)
                        ],
                    }), encoding="utf-8")
                    return MagicMock(returncode=0)
                return MagicMock(returncode=2)

            environment = {
                "TEMP": str(runtime_temp),
                "TMP": str(runtime_temp),
                "LOCALAPPDATA": str(local_app_data),
                "USERNAME": "fixture-user",
            }
            with patch.object(verifier.subprocess, "run", side_effect=run_preflight):
                payload = verifier.exercise_installer_target_preflight(
                    executable,
                    environment,
                    expected_port_status="pass",
                )

            self.assertEqual(payload["preflight_kind"], "installer_target")
            self.assertEqual(calls, 2)
            self.assertEqual(list(runtime_temp.glob("barorok-installer-preflight-*")), [])

    def test_source_installer_preflight_privacy_check_reads_parsed_windows_strings(self) -> None:
        leaked = Path(r"C:\Users\Private User\AppData\Local")
        payload = {
            "schema_version": 1,
            "preflight_kind": "installer_target",
            "overall_status": "pass",
            "checks": [
                {
                    "check_id": check_id,
                    "status": "pass",
                    "measured": {"path": str(leaked)} if check_id == "installer_install_space" else {},
                }
                for check_id in source_verifier.CHECK_IDS
            ],
        }
        with self.assertRaisesRegex(RuntimeError, "private path"):
            source_verifier.validate_payload(
                payload,
                expected_port_status="pass",
                forbidden_paths=(leaked,),
            )

    @unittest.skipUnless(os.name == "nt", "Windows read-only payload attributes")
    def test_read_only_payload_attributes_are_restored(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            artifact = self._write_artifact(Path(temp_dir))
            handles = verifier.lock_install_files_read_only(artifact)
            config = artifact / "defaults" / "config.json"
            self.assertTrue(verifier.windows_file_write_is_denied(config))
            verifier.close_install_read_locks(handles)
            self.assertFalse(verifier.windows_file_write_is_denied(config))


if __name__ == "__main__":
    unittest.main()
