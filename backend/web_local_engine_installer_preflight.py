from __future__ import annotations

import argparse
import errno
import http.client
import json
import os
import stat
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import Mapping

from local_engine_preflight import (
    InstallerTargetPaths,
    PortInspection,
    StorageRequirement,
    collect_installer_target_preflight,
    inspect_fixed_port,
    write_preflight_json,
)


PRODUCT_ID = "barorok-local-engine"
LOCAL_ENGINE_PORT = 17863
ARTIFACT_MANIFEST_FORMAT = "barorok-web-local-engine-poc-v1"
MAX_MANIFEST_BYTES = 16 * 1024 * 1024
MAX_RESULT_BYTES = 256 * 1024
PROBE_MAX_BYTES = 64 * 1024
NTFS_ALLOCATION_UNIT_BYTES = 4096
INSTALLER_METADATA_RESERVE_BYTES = 16 * 1024 * 1024
INSTALL_MARKER_NAME = ".barorok-install-owned"
INSTALL_MARKER_CONTENT = "barorok-local-engine-v1"
UNINSTALL_MARKER_NAME = ".barorok-uninstall-pending"
UNINSTALL_MARKER_CONTENT = "barorok-local-engine-uninstall-v1"
INSTALLER_EXTRA_FILES = {
    INSTALL_MARKER_NAME,
    ".barorok-transaction-pending",
    UNINSTALL_MARKER_NAME,
    "poc-manifest.json",
    "Uninstall.exe",
    "installer/barorok-installer-preflight.exe",
}
INSTALLER_DECISION_EXIT_CODES = {
    "ready": 0,
    "contract_failure": 2,
    "confirm": 10,
    "blocked": 20,
    "retry": 30,
}
EXPECTED_CHECK_IDS = (
    "installer_install_space",
    "installer_staging_space",
    "installer_model_space",
    "installer_analysis_temp_space",
    "installer_results_space",
    "installer_local_app_data_write",
    "installer_local_app_data_cleanup",
    "installer_fixed_port",
)
CRITICAL_CHECK_IDS = {
    "installer_install_space",
    "installer_staging_space",
    "installer_local_app_data_write",
    "installer_local_app_data_cleanup",
    "installer_fixed_port",
}
ALLOWED_STATUSES = {"pass", "warning", "blocked", "unknown"}
ALLOWED_ACTIONS = {
    "none",
    "retry_check",
    "free_space_and_retry",
    "check_folder_permissions",
    "stop_local_engine_and_retry",
    "close_conflicting_app_and_retry",
    "request_administrator",
}


@dataclass(frozen=True)
class InstallerDecision:
    decision: str
    primary_action: str
    exit_code: int


def _read_json_object(path: Path, *, maximum_bytes: int, label: str) -> dict:
    if not path.is_file():
        raise ValueError(f"{label} is unavailable")
    if path.stat().st_size > maximum_bytes:
        raise ValueError(f"{label} is too large")
    try:
        payload = json.loads(path.read_text(encoding="utf-8-sig"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError(f"{label} is invalid") from exc
    if not isinstance(payload, dict):
        raise ValueError(f"{label} must be an object")
    return payload


def _validated_payload_path(value: object) -> str:
    if not isinstance(value, str) or not value or "/" in value or "\x00" in value:
        raise ValueError("Artifact payload path is invalid")
    path = PureWindowsPath(value)
    if path.is_absolute() or path.drive or any(part in {"", ".", ".."} for part in path.parts):
        raise ValueError("Artifact payload path is invalid")
    return str(path)


def requirements_from_artifact_manifest(
    manifest_path: str | os.PathLike[str],
) -> dict[str, StorageRequirement]:
    resolved_manifest_path = Path(manifest_path).expanduser().resolve()
    manifest = _read_json_object(
        resolved_manifest_path,
        maximum_bytes=MAX_MANIFEST_BYTES,
        label="Artifact manifest",
    )
    if (
        manifest.get("packageFormat") != ARTIFACT_MANIFEST_FORMAT
        or manifest.get("installScope") != "current-user"
        or manifest.get("bind") != f"127.0.0.1:{LOCAL_ENGINE_PORT}"
        or manifest.get("userDataRoot") != r"%LOCALAPPDATA%\Barorok\LocalEngine"
        or not isinstance(manifest.get("signed"), bool)
        or not isinstance(manifest.get("distributionReady"), bool)
    ):
        raise ValueError("Artifact manifest contract is invalid")
    payload_files = manifest.get("payloadFiles")
    if not isinstance(payload_files, list) or not payload_files:
        raise ValueError("Artifact payload is empty")

    allocated_payload_bytes = 0
    seen_paths: set[str] = set()
    for item in payload_files:
        if not isinstance(item, dict):
            raise ValueError("Artifact payload entry is invalid")
        payload_path = _validated_payload_path(item.get("path"))
        folded_path = payload_path.casefold()
        if folded_path in seen_paths:
            raise ValueError("Artifact payload paths are duplicated")
        seen_paths.add(folded_path)
        byte_count = item.get("bytes")
        checksum = item.get("sha256")
        if (
            isinstance(byte_count, bool)
            or not isinstance(byte_count, int)
            or byte_count < 0
            or not isinstance(checksum, str)
            or len(checksum) != 64
            or any(character not in "0123456789abcdef" for character in checksum)
        ):
            raise ValueError("Artifact payload entry is invalid")
        if byte_count:
            allocated_payload_bytes += (
                (byte_count + NTFS_ALLOCATION_UNIT_BYTES - 1) // NTFS_ALLOCATION_UNIT_BYTES
            ) * NTFS_ALLOCATION_UNIT_BYTES
        if allocated_payload_bytes > (2**63 - 1):
            raise ValueError("Artifact payload size is invalid")

    manifest_bytes = Path(manifest_path).expanduser().resolve().stat().st_size
    allocated_manifest_bytes = (
        (manifest_bytes + NTFS_ALLOCATION_UNIT_BYTES - 1) // NTFS_ALLOCATION_UNIT_BYTES
    ) * NTFS_ALLOCATION_UNIT_BYTES
    required_bytes = (
        allocated_payload_bytes
        + allocated_manifest_bytes
        + INSTALLER_METADATA_RESERVE_BYTES
    )
    payload_requirement = StorageRequirement(required_bytes, required_bytes)
    return {
        "install": payload_requirement,
        # Transactional install/update keeps one complete staged payload before
        # swapping the current-user install tree.
        "staging": payload_requirement,
        # Official model and analysis working-set sizes require real-device
        # evidence. Unknown is advisory for these future-readiness roles.
        "models": StorageRequirement(None, None),
        "analysis_temp": StorageRequirement(None, None),
        "results": StorageRequirement(None, None),
    }


def _overall_status(checks: list[Mapping[str, object]]) -> str:
    statuses = {str(check.get("status")) for check in checks}
    for status in ("blocked", "warning", "unknown"):
        if status in statuses:
            return status
    return "pass"


def evaluate_installer_preflight(
    payload: Mapping[str, object],
    *,
    request_generation: int,
) -> InstallerDecision:
    if (
        payload.get("schema_version") != 1
        or payload.get("preflight_kind") != "installer_target"
        or payload.get("request_generation") != request_generation
        or not isinstance(payload.get("checked_at"), int)
        or isinstance(payload.get("checked_at"), bool)
        or not isinstance(payload.get("run_id"), str)
        or len(str(payload.get("run_id"))) != 32
        or any(character not in "0123456789abcdef" for character in str(payload.get("run_id")))
    ):
        raise ValueError("Preflight result identity is invalid")
    raw_checks = payload.get("checks")
    if not isinstance(raw_checks, list) or len(raw_checks) != len(EXPECTED_CHECK_IDS):
        raise ValueError("Preflight result check set is invalid")

    checks: list[Mapping[str, object]] = []
    seen: set[str] = set()
    for raw_check in raw_checks:
        if not isinstance(raw_check, dict):
            raise ValueError("Preflight result check is invalid")
        check_id = raw_check.get("check_id")
        status = raw_check.get("status")
        action = raw_check.get("action_code")
        if (
            check_id not in EXPECTED_CHECK_IDS
            or check_id in seen
            or status not in ALLOWED_STATUSES
            or action not in ALLOWED_ACTIONS
            or not isinstance(raw_check.get("reason_code"), str)
            or not raw_check.get("reason_code")
            or not isinstance(raw_check.get("retryable"), bool)
            or not isinstance(raw_check.get("checked_at"), int)
            or isinstance(raw_check.get("checked_at"), bool)
            or not isinstance(raw_check.get("measured"), dict)
            or not isinstance(raw_check.get("required"), dict)
        ):
            raise ValueError("Preflight result check is invalid")
        seen.add(str(check_id))
        checks.append(raw_check)
    if seen != set(EXPECTED_CHECK_IDS):
        raise ValueError("Preflight result check set is incomplete")
    if payload.get("overall_status") != _overall_status(checks):
        raise ValueError("Preflight overall status is inconsistent")

    blocked = [check for check in checks if check.get("status") == "blocked"]
    critical_unknown = [
        check
        for check in checks
        if check.get("check_id") in CRITICAL_CHECK_IDS and check.get("status") == "unknown"
    ]
    advisory = [check for check in checks if check.get("status") in {"warning", "unknown"}]
    if blocked:
        decision = "blocked"
        candidates = blocked
    elif critical_unknown:
        decision = "retry"
        candidates = critical_unknown
    elif advisory:
        decision = "confirm"
        candidates = advisory
    else:
        decision = "ready"
        candidates = checks

    action_priority = {
        "blocked": (
            "close_conflicting_app_and_retry",
            "free_space_and_retry",
            "check_folder_permissions",
            "request_administrator",
            "retry_check",
        ),
        "retry": (
            "stop_local_engine_and_retry",
            "check_folder_permissions",
            "retry_check",
            "request_administrator",
        ),
        "confirm": (
            "stop_local_engine_and_retry",
            "free_space_and_retry",
            "check_folder_permissions",
            "retry_check",
        ),
        "ready": ("none",),
    }[decision]
    primary_action = next(
        (
            action
            for action in action_priority
            if any(check.get("action_code") == action for check in candidates)
        ),
        "none",
    )
    return InstallerDecision(
        decision=decision,
        primary_action=primary_action,
        exit_code=INSTALLER_DECISION_EXIT_CODES[decision],
    )


def _is_same_or_child(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def write_installer_decision(
    path: str | os.PathLike[str],
    decision: InstallerDecision,
    *,
    request_generation: int,
    temp_root: str | os.PathLike[str] | None = None,
) -> None:
    allowed_root = Path(temp_root or tempfile.gettempdir()).expanduser().resolve()
    output_path = Path(path).expanduser().resolve()
    if not _is_same_or_child(output_path, allowed_root):
        raise ValueError("Installer decision must stay inside the user temporary directory")
    if not output_path.parent.is_dir():
        raise ValueError("Installer decision parent is unavailable")
    content = (
        "[preflight]\r\n"
        f"decision={decision.decision}\r\n"
        f"primary_action={decision.primary_action}\r\n"
        f"request_generation={request_generation}\r\n"
    ).encode("utf-8")
    descriptor = os.open(output_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    try:
        with os.fdopen(descriptor, "wb", closefd=False) as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
    finally:
        os.close(descriptor)


def _arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Barorok installer target preflight helper")
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--probe-running-engine", action="store_true")
    mode.add_argument("--probe-stopped-engine", action="store_true")
    mode.add_argument("--cleanup-owned-tree")
    mode.add_argument("--validate-owned-tree")
    mode.add_argument("--cleanup-uninstall-tombstone")
    parser.add_argument("--preserve-self-removal-files", action="store_true")
    parser.add_argument("--require-complete-tree", action="store_true")
    parser.add_argument("--require-transaction-marker", action="store_true")
    parser.add_argument("--manifest")
    parser.add_argument("--result-json")
    parser.add_argument("--decision-ini")
    parser.add_argument("--request-generation", type=int)
    return parser.parse_args(argv)


def _layout_paths(local_app_data: Path) -> InstallerTargetPaths:
    install = local_app_data / "Programs" / "Barorok" / "LocalEngine"
    staging = local_app_data / "Programs" / "Barorok" / ".LocalEngine-stage"
    data = local_app_data / "Barorok" / "LocalEngine"
    return InstallerTargetPaths(
        install=install,
        staging=staging,
        models=data / "models",
        analysis_temp=data / "temp",
        results=data / "results",
        write_targets=(install, data),
    )


def _mutex_name(data_root: Path) -> str:
    import hashlib

    suffix = hashlib.sha256(str(data_root.resolve()).casefold().encode("utf-8")).hexdigest()[:16]
    return f"Local\\BarorokLocalEngine-{suffix}"


def _windows_named_mutex_exists(name: str) -> bool:
    if os.name != "nt":
        raise RuntimeError("Windows is required")
    import ctypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.OpenMutexW.argtypes = [ctypes.c_uint32, ctypes.c_bool, ctypes.c_wchar_p]
    kernel32.OpenMutexW.restype = ctypes.c_void_p
    handle = kernel32.OpenMutexW(0x00100000, False, name)
    if handle:
        kernel32.CloseHandle(handle)
        return True
    error = ctypes.get_last_error()
    if error == 2:
        return False
    raise ctypes.WinError(error)


def probe_running_engine(
    paths: InstallerTargetPaths,
    *,
    expected_engine_version: str,
    mutex_reader=None,
    product_probe=None,
) -> bool:
    marker = mutex_reader or (lambda: _windows_named_mutex_exists(_mutex_name(paths.models.parent)))
    probe = product_probe or _probe_exact_running_engine
    try:
        return bool(marker()) and bool(probe(expected_engine_version))
    except Exception:
        return False


def _probe_exact_running_engine(expected_engine_version: str) -> bool:
    connection = http.client.HTTPConnection("127.0.0.1", LOCAL_ENGINE_PORT, timeout=0.5)
    try:
        connection.request(
            "GET",
            "/api/probe",
            headers={"Accept": "application/json", "Connection": "close"},
        )
        response = connection.getresponse()
        content_length = response.getheader("Content-Length")
        if content_length is not None and int(content_length) > PROBE_MAX_BYTES:
            return False
        body = response.read(PROBE_MAX_BYTES + 1)
        if response.status != 200 or len(body) > PROBE_MAX_BYTES:
            return False
        payload = json.loads(body.decode("utf-8"))
        return bool(
            isinstance(payload, dict)
            and payload.get("product_id") == PRODUCT_ID
            and payload.get("engine_version") == expected_engine_version
            and payload.get("api_contract_version") == 1
        )
    except (OSError, UnicodeError, ValueError, json.JSONDecodeError, http.client.HTTPException):
        return False
    finally:
        connection.close()


def probe_stopped_engine(
    paths: InstallerTargetPaths,
    *,
    mutex_reader=None,
    port_reader=None,
) -> bool:
    marker = mutex_reader or (lambda: _windows_named_mutex_exists(_mutex_name(paths.models.parent)))
    inspect = port_reader or (lambda: inspect_fixed_port(
        port=LOCAL_ENGINE_PORT,
        expected_product_id=PRODUCT_ID,
        own_engine_marker=lambda: False,
    ))
    try:
        inspection = inspect()
        return (
            not bool(marker())
            and isinstance(inspection, PortInspection)
            and inspection.state == "available"
        )
    except Exception:
        return False


def _has_reparse_attribute(path: Path) -> bool:
    attributes = getattr(path.lstat(), "st_file_attributes", 0)
    return bool(attributes & getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400))


def _retry_cleanup_operation(operation, *, attempts: int = 5, delay_seconds: float = 0.05) -> None:
    for attempt in range(attempts):
        try:
            operation()
            return
        except OSError as exc:
            retryable = (
                isinstance(exc, PermissionError)
                or getattr(exc, "winerror", None) in {5, 32, 33}
                or exc.errno in {errno.EACCES, errno.EBUSY}
            )
            if not retryable or attempt + 1 >= attempts:
                raise
            time.sleep(delay_seconds)


def cleanup_owned_install_tree(
    target: str | os.PathLike[str],
    manifest_path: str | os.PathLike[str],
    *,
    local_app_data: str | os.PathLike[str],
    preserve_self_removal_files: bool = False,
    validate_only: bool = False,
    require_complete_tree: bool = False,
    require_transaction_marker: bool = False,
) -> None:
    local_root = Path(os.path.abspath(os.path.expanduser(str(local_app_data))))
    paths = _layout_paths(local_root)
    allowed_targets = {
        Path(os.path.abspath(str(paths.install))),
        Path(os.path.abspath(str(paths.staging))),
        Path(os.path.abspath(str(local_root / "Programs" / "Barorok" / ".LocalEngine-rollback"))),
    }
    target_path = Path(os.path.abspath(os.path.expanduser(str(target))))
    if target_path not in allowed_targets:
        raise ValueError("Cleanup target is not installer-owned")
    if not os.path.lexists(target_path):
        return
    if _has_reparse_attribute(target_path) or not target_path.is_dir():
        raise ValueError("Cleanup target is unsafe")
    marker = target_path / INSTALL_MARKER_NAME
    if (
        not marker.is_file()
        or _has_reparse_attribute(marker)
        or marker.read_text(encoding="utf-8-sig") != INSTALL_MARKER_CONTENT
    ):
        raise ValueError("Cleanup ownership marker is invalid")

    requirements_from_artifact_manifest(manifest_path)
    resolved_manifest_path = Path(manifest_path).expanduser().resolve()
    manifest_restore_bytes = resolved_manifest_path.read_bytes()
    manifest = _read_json_object(
        resolved_manifest_path,
        maximum_bytes=MAX_MANIFEST_BYTES,
        label="Artifact manifest",
    )
    expected_files = {
        _validated_payload_path(item.get("path")).replace("\\", "/").casefold()
        for item in manifest["payloadFiles"]
    }
    expected_files.update(item.casefold() for item in INSTALLER_EXTRA_FILES)
    allowed_directories: set[str] = set()
    for relative in expected_files:
        parent = PureWindowsPath(relative).parent
        while str(parent) not in {"", "."}:
            allowed_directories.add(str(parent).replace("\\", "/").casefold())
            parent = parent.parent

    discovered_files: dict[str, Path] = {}
    discovered_directories: list[tuple[str, Path]] = []
    def raise_walk_error(error: OSError) -> None:
        raise error

    for current_root, directory_names, file_names in os.walk(
        target_path,
        topdown=True,
        onerror=raise_walk_error,
        followlinks=False,
    ):
        current = Path(current_root)
        for name in directory_names:
            child = current / name
            if _has_reparse_attribute(child):
                raise ValueError("Cleanup tree contains a reparse point")
            relative = child.relative_to(target_path).as_posix().casefold()
            if relative not in allowed_directories:
                raise ValueError("Cleanup tree contains an undeclared directory")
            discovered_directories.append((relative, child))
        for name in file_names:
            child = current / name
            if _has_reparse_attribute(child) or not child.is_file():
                raise ValueError("Cleanup tree contains an unsafe file")
            relative = child.relative_to(target_path).as_posix().casefold()
            if relative not in expected_files:
                raise ValueError("Cleanup tree contains an undeclared file")
            discovered_files[relative] = child

    if require_complete_tree:
        required_files = set(expected_files)
        required_files.discard(UNINSTALL_MARKER_NAME.casefold())
        if not require_transaction_marker:
            required_files.discard(".barorok-transaction-pending")
        if set(discovered_files) != required_files:
            raise ValueError("Cleanup tree is incomplete")

    transaction_file = ".barorok-transaction-pending"
    transaction_path = discovered_files.get(transaction_file)
    had_transaction = transaction_path is not None
    if transaction_path is not None and transaction_path.read_text(encoding="utf-8-sig") != "pending":
        raise ValueError("Cleanup transaction marker is invalid")

    preserved = set()
    if preserve_self_removal_files:
        preserved = {
            "uninstall.exe",
            "installer/barorok-installer-preflight.exe",
            INSTALL_MARKER_NAME.casefold(),
            ".barorok-transaction-pending",
            UNINSTALL_MARKER_NAME.casefold(),
            "poc-manifest.json",
        }
    if validate_only:
        return

    control_files = {INSTALL_MARKER_NAME.casefold(), "poc-manifest.json"}
    ordinary_files = sorted(
        (item for item in discovered_files.items() if item[0] not in control_files and item[0] != transaction_file),
        key=lambda item: item[0],
    )
    for relative, path in ordinary_files:
        if relative not in preserved:
            _retry_cleanup_operation(path.unlink)
    preserved_parents = {
        str(PureWindowsPath(relative).parent).replace("\\", "/").casefold()
        for relative in preserved
    }
    for relative, path in sorted(discovered_directories, key=lambda item: len(item[0]), reverse=True):
        if relative not in preserved_parents:
            _retry_cleanup_operation(path.rmdir)
    for relative in sorted(control_files):
        path = discovered_files.get(relative)
        if path is not None and relative not in preserved:
            _retry_cleanup_operation(path.unlink)
    if transaction_path is not None and transaction_file not in preserved:
        _retry_cleanup_operation(transaction_path.unlink)
    if not preserve_self_removal_files:
        try:
            _retry_cleanup_operation(target_path.rmdir)
        except OSError:
            if target_path.is_dir():
                _retry_cleanup_operation(
                    lambda: (target_path / INSTALL_MARKER_NAME).write_text(
                        INSTALL_MARKER_CONTENT,
                        encoding="utf-8",
                    )
                )
                _retry_cleanup_operation(
                    lambda: (target_path / "poc-manifest.json").write_bytes(manifest_restore_bytes)
                )
                if had_transaction:
                    _retry_cleanup_operation(
                        lambda: (target_path / transaction_file).write_text("pending", encoding="utf-8")
                    )
            raise


def cleanup_uninstall_tombstone(
    target: str | os.PathLike[str],
    *,
    local_app_data: str | os.PathLike[str],
) -> None:
    local_root = Path(os.path.abspath(os.path.expanduser(str(local_app_data))))
    install = Path(os.path.abspath(str(_layout_paths(local_root).install)))
    target_path = Path(os.path.abspath(os.path.expanduser(str(target))))
    if target_path != install:
        raise ValueError("Uninstall cleanup target is invalid")
    if not os.path.lexists(target_path):
        return
    if _has_reparse_attribute(target_path) or not target_path.is_dir():
        raise ValueError("Uninstall cleanup target is unsafe")

    tombstone = target_path / UNINSTALL_MARKER_NAME
    if (
        not tombstone.is_file()
        or _has_reparse_attribute(tombstone)
        or tombstone.read_text(encoding="utf-8-sig") != UNINSTALL_MARKER_CONTENT
    ):
        raise ValueError("Uninstall cleanup marker is invalid")

    allowed_files = {item.casefold() for item in INSTALLER_EXTRA_FILES}
    allowed_directories = {"installer"}
    discovered_files: dict[str, Path] = {}
    discovered_directories: list[tuple[str, Path]] = []

    def raise_walk_error(error: OSError) -> None:
        raise error

    for current_root, directory_names, file_names in os.walk(
        target_path,
        topdown=True,
        onerror=raise_walk_error,
        followlinks=False,
    ):
        current = Path(current_root)
        for name in directory_names:
            child = current / name
            if _has_reparse_attribute(child):
                raise ValueError("Uninstall cleanup contains a reparse point")
            relative = child.relative_to(target_path).as_posix().casefold()
            if relative not in allowed_directories:
                raise ValueError("Uninstall cleanup contains an undeclared directory")
            discovered_directories.append((relative, child))
        for name in file_names:
            child = current / name
            if _has_reparse_attribute(child) or not child.is_file():
                raise ValueError("Uninstall cleanup contains an unsafe file")
            relative = child.relative_to(target_path).as_posix().casefold()
            if relative not in allowed_files:
                raise ValueError("Uninstall cleanup contains an undeclared file")
            discovered_files[relative] = child

    tombstone_key = UNINSTALL_MARKER_NAME.casefold()
    for relative, path in sorted(discovered_files.items()):
        if relative != tombstone_key:
            _retry_cleanup_operation(path.unlink)
    for _relative, path in sorted(discovered_directories, key=lambda item: len(item[0]), reverse=True):
        _retry_cleanup_operation(path.rmdir)
    _retry_cleanup_operation(tombstone.unlink)
    try:
        _retry_cleanup_operation(target_path.rmdir)
    except OSError:
        if target_path.is_dir() and not tombstone.exists():
            _retry_cleanup_operation(
                lambda: tombstone.write_text(UNINSTALL_MARKER_CONTENT, encoding="utf-8")
            )
            if tombstone.read_text(encoding="utf-8-sig") != UNINSTALL_MARKER_CONTENT:
                raise OSError("Uninstall cleanup marker restore failed")
        raise


def main(argv: list[str] | None = None) -> int:
    try:
        args = _arguments(argv)
        if args.probe_running_engine:
            if (
                not args.manifest
                or any((
                    args.result_json,
                    args.decision_ini,
                    args.request_generation is not None,
                    args.preserve_self_removal_files,
                    args.require_complete_tree,
                    args.require_transaction_marker,
                ))
            ):
                raise ValueError("Running probe mode requires only the artifact manifest")
        elif args.probe_stopped_engine:
            if any((
                args.manifest,
                args.result_json,
                args.decision_ini,
                args.request_generation is not None,
                args.preserve_self_removal_files,
                args.require_complete_tree,
                args.require_transaction_marker,
            )):
                raise ValueError("Stopped probe mode does not accept preflight arguments")
        elif args.cleanup_owned_tree:
            if (
                not args.manifest
                or any((
                    args.result_json,
                    args.decision_ini,
                    args.request_generation is not None,
                    args.require_complete_tree,
                    args.require_transaction_marker,
                ))
            ):
                raise ValueError("Cleanup mode requires only the artifact manifest")
        elif args.validate_owned_tree:
            if (
                not args.manifest
                or any((args.result_json, args.decision_ini, args.request_generation is not None, args.preserve_self_removal_files))
                or (args.require_transaction_marker and not args.require_complete_tree)
            ):
                raise ValueError("Validation mode requires only the artifact manifest")
        elif args.cleanup_uninstall_tombstone:
            if any((
                args.manifest,
                args.result_json,
                args.decision_ini,
                args.request_generation is not None,
                args.preserve_self_removal_files,
                args.require_complete_tree,
                args.require_transaction_marker,
            )):
                raise ValueError("Uninstall cleanup mode does not accept preflight arguments")
        elif args.preserve_self_removal_files or args.require_complete_tree or args.require_transaction_marker:
            raise ValueError("Installer preflight does not accept cleanup arguments")
        elif (
            not args.manifest
            or not args.result_json
            or not args.decision_ini
            or args.request_generation is None
        ):
            raise ValueError("Installer preflight arguments are required")
        elif args.request_generation < 0:
            raise ValueError("request_generation must be non-negative")
        local_app_data_value = os.environ.get("LOCALAPPDATA")
        if not local_app_data_value:
            raise RuntimeError("LOCALAPPDATA is required")
        local_app_data = Path(local_app_data_value).expanduser().resolve()
        paths = _layout_paths(local_app_data)
        if args.probe_running_engine:
            requirements_from_artifact_manifest(args.manifest)
            manifest = _read_json_object(
                Path(args.manifest).expanduser().resolve(),
                maximum_bytes=MAX_MANIFEST_BYTES,
                label="Artifact manifest",
            )
            engine_version = manifest.get("engineVersion")
            if not isinstance(engine_version, str) or not engine_version.strip():
                raise ValueError("Artifact engine version is invalid")
            return 0 if probe_running_engine(
                paths,
                expected_engine_version=engine_version,
            ) else 3
        if args.probe_stopped_engine:
            return 0 if probe_stopped_engine(paths) else 3
        if args.cleanup_owned_tree:
            cleanup_owned_install_tree(
                args.cleanup_owned_tree,
                args.manifest,
                local_app_data=local_app_data,
                preserve_self_removal_files=args.preserve_self_removal_files,
            )
            return 0
        if args.validate_owned_tree:
            cleanup_owned_install_tree(
                args.validate_owned_tree,
                args.manifest,
                local_app_data=local_app_data,
                validate_only=True,
                require_complete_tree=args.require_complete_tree,
                require_transaction_marker=args.require_transaction_marker,
            )
            return 0
        if args.cleanup_uninstall_tombstone:
            cleanup_uninstall_tombstone(
                args.cleanup_uninstall_tombstone,
                local_app_data=local_app_data,
            )
            return 0
        requirements = requirements_from_artifact_manifest(args.manifest)
        payload = collect_installer_target_preflight(
            paths,
            requirements,
            request_generation=args.request_generation,
            port_reader=lambda: inspect_fixed_port(
                port=LOCAL_ENGINE_PORT,
                expected_product_id=PRODUCT_ID,
                own_engine_marker=lambda: _windows_named_mutex_exists(_mutex_name(paths.models.parent)),
            ),
        )
        write_preflight_json(args.result_json, payload)
        decision = evaluate_installer_preflight(
            payload,
            request_generation=args.request_generation,
        )
        write_installer_decision(
            args.decision_ini,
            decision,
            request_generation=args.request_generation,
        )
        return decision.exit_code
    except Exception:
        return INSTALLER_DECISION_EXIT_CODES["contract_failure"]


if __name__ == "__main__":
    raise SystemExit(main())
