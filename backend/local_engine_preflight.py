from __future__ import annotations

import ctypes
import http.client
import json
import os
import platform
import secrets
import shutil
import socket
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Mapping, Sequence


PREFLIGHT_SCHEMA_VERSION = 1
WINDOWS_11_MINIMUM_BUILD = 22000
WINDOWS_WORKSTATION_PRODUCT_TYPE = 1
IMAGE_FILE_MACHINE_I386 = 0x014C
IMAGE_FILE_MACHINE_ARMNT = 0x01C4
IMAGE_FILE_MACHINE_AMD64 = 0x8664
IMAGE_FILE_MACHINE_ARM64 = 0xAA64

PREFLIGHT_STATUSES = {"pass", "warning", "blocked", "unknown"}
INSTALLER_PREFLIGHT_KIND = "installer_target"
HOST_PREFLIGHT_KIND = "host_system"
INSTALLER_PREFLIGHT_REQUEST_VERSION = 1
INSTALLER_STORAGE_ROLES = (
    "install",
    "staging",
    "models",
    "analysis_temp",
    "results",
)
INSTALLER_STORAGE_CHECK_IDS = {
    "install": "installer_install_space",
    "staging": "installer_staging_space",
    "models": "installer_model_space",
    "analysis_temp": "installer_analysis_temp_space",
    "results": "installer_results_space",
}
INSTALLER_BLOCKING_STORAGE_ROLES = {"install", "staging"}
INSTALLER_PERSISTENT_STORAGE_ROLES = {"install"}
INSTALLER_FUTURE_STORAGE_ROLES = {"models", "analysis_temp", "results"}
INSTALLER_PORT_STATES = {"available", "local_engine", "occupied", "unknown"}
MAX_PREFLIGHT_REQUEST_BYTES = 64 * 1024
PORT_PROBE_MAX_BYTES = 64 * 1024
WINDOWS_ERROR_ALREADY_EXISTS = 183
WINDOWS_ERROR_FILE_EXISTS = 80
WINDOWS_MOVEFILE_WRITE_THROUGH = 0x00000008


@dataclass(frozen=True)
class WindowsSystemFacts:
    system: str
    build: int | None
    architecture: str
    total_memory_bytes: int | None
    product_type: int | None = WINDOWS_WORKSTATION_PRODUCT_TYPE


@dataclass(frozen=True)
class StorageRequirement:
    required_bytes: int | None
    recommended_bytes: int | None


@dataclass(frozen=True)
class InstallerTargetPaths:
    install: Path
    staging: Path
    models: Path
    analysis_temp: Path
    results: Path
    write_targets: tuple[Path, ...]


@dataclass(frozen=True)
class VolumeSpace:
    identity: str
    available_bytes: int


@dataclass(frozen=True)
class WriteCleanupProbe:
    write_status: str
    cleanup_status: str
    cleanup_attempts: int
    target_count: int


@dataclass(frozen=True)
class PortInspection:
    state: str

    def __post_init__(self) -> None:
        if self.state not in INSTALLER_PORT_STATES:
            raise ValueError(f"Unsupported installer port state: {self.state}")


class _MemoryStatusEx(ctypes.Structure):
    _fields_ = [
        ("dwLength", ctypes.c_ulong),
        ("dwMemoryLoad", ctypes.c_ulong),
        ("ullTotalPhys", ctypes.c_ulonglong),
        ("ullAvailPhys", ctypes.c_ulonglong),
        ("ullTotalPageFile", ctypes.c_ulonglong),
        ("ullAvailPageFile", ctypes.c_ulonglong),
        ("ullTotalVirtual", ctypes.c_ulonglong),
        ("ullAvailVirtual", ctypes.c_ulonglong),
        ("ullAvailExtendedVirtual", ctypes.c_ulonglong),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.dwLength = ctypes.sizeof(self)


def normalize_windows_architecture(
    machine: str,
    environment: Mapping[str, str] = os.environ,
) -> str:
    candidates = (
        environment.get("PROCESSOR_ARCHITEW6432", ""),
        environment.get("PROCESSOR_ARCHITECTURE", ""),
        machine,
    )
    normalized = [candidate.strip().upper().replace("-", "_") for candidate in candidates]
    if any(candidate in {"ARM64", "AARCH64"} for candidate in normalized):
        return "arm64"
    if any(candidate in {"AMD64", "X86_64", "IA64"} for candidate in normalized):
        return "x64"
    if any(candidate in {"X86", "I386", "I686"} for candidate in normalized):
        return "x86"
    return "unknown"


def windows_machine_code_to_architecture(machine_code: int) -> str:
    if machine_code == IMAGE_FILE_MACHINE_AMD64:
        return "x64"
    if machine_code == IMAGE_FILE_MACHINE_ARM64:
        return "arm64"
    if machine_code in {IMAGE_FILE_MACHINE_I386, IMAGE_FILE_MACHINE_ARMNT}:
        return "x86"
    return "unknown"


def _windows_native_machine_code() -> int | None:
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        is_wow64_process_2 = kernel32.IsWow64Process2
        is_wow64_process_2.argtypes = [
            ctypes.c_void_p,
            ctypes.POINTER(ctypes.c_ushort),
            ctypes.POINTER(ctypes.c_ushort),
        ]
        is_wow64_process_2.restype = ctypes.c_bool
        kernel32.GetCurrentProcess.restype = ctypes.c_void_p
        process_machine = ctypes.c_ushort()
        native_machine = ctypes.c_ushort()
        if is_wow64_process_2(
            kernel32.GetCurrentProcess(),
            ctypes.byref(process_machine),
            ctypes.byref(native_machine),
        ):
            return int(native_machine.value)
    except (AttributeError, OSError):
        pass
    return None


def detect_native_architecture(
    environment: Mapping[str, str] = os.environ,
    *,
    is_windows: bool | None = None,
    native_machine_reader: Callable[[], int | None] = _windows_native_machine_code,
) -> str:
    windows_runtime = os.name == "nt" if is_windows is None else is_windows
    if windows_runtime:
        machine_code = native_machine_reader()
        if machine_code is None:
            return "unknown"
        return windows_machine_code_to_architecture(machine_code)
    return normalize_windows_architecture(platform.machine(), environment)


def _windows_version_details() -> tuple[int | None, int | None]:
    getter = getattr(sys, "getwindowsversion", None)
    if getter is None:
        return None, None
    try:
        version = getter()
        product_type = getattr(version, "product_type", None)
        return int(version.build), int(product_type) if product_type is not None else None
    except (AttributeError, TypeError, ValueError):
        return None, None


def _windows_total_memory_bytes() -> int | None:
    if os.name != "nt":
        return None
    status = _MemoryStatusEx()
    try:
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GlobalMemoryStatusEx.argtypes = [ctypes.POINTER(_MemoryStatusEx)]
        kernel32.GlobalMemoryStatusEx.restype = ctypes.c_bool
        if not kernel32.GlobalMemoryStatusEx(ctypes.byref(status)):
            return None
    except (AttributeError, OSError):
        return None
    return int(status.ullTotalPhys)


def read_windows_system_facts(
    environment: Mapping[str, str] = os.environ,
) -> WindowsSystemFacts:
    build, product_type = _windows_version_details()
    return WindowsSystemFacts(
        system=platform.system(),
        build=build,
        architecture=detect_native_architecture(environment),
        total_memory_bytes=_windows_total_memory_bytes(),
        product_type=product_type,
    )


def _check(
    check_id: str,
    *,
    status: str,
    severity: str,
    reason_code: str,
    action_code: str,
    retryable: bool,
    checked_at: int,
    measured: Mapping[str, object] | None = None,
    required: Mapping[str, object] | None = None,
) -> dict[str, object]:
    if status not in PREFLIGHT_STATUSES:
        raise ValueError(f"Unsupported preflight status: {status}")
    return {
        "check_id": check_id,
        "status": status,
        "severity": severity,
        "reason_code": reason_code,
        "action_code": action_code,
        "retryable": retryable,
        "checked_at": checked_at,
        "measured": dict(measured or {}),
        "required": dict(required or {}),
    }


def _overall_status(checks: list[dict[str, object]]) -> str:
    statuses = {str(check.get("status")) for check in checks}
    for status in ("blocked", "warning", "unknown"):
        if status in statuses:
            return status
    return "pass"


def collect_windows_preflight(
    *,
    facts: WindowsSystemFacts | None = None,
    clock: Callable[[], float] = time.time,
    run_id_factory: Callable[[], str] = lambda: secrets.token_hex(16),
) -> dict[str, object]:
    checked_at = int(clock())
    system_facts = facts or read_windows_system_facts()
    checks: list[dict[str, object]] = []

    if system_facts.system != "Windows":
        checks.append(_check(
            "supported_windows",
            status="blocked",
            severity="error",
            reason_code="unsupported_operating_system",
            action_code="view_supported_systems",
            retryable=False,
            checked_at=checked_at,
        ))
    elif system_facts.build is None:
        checks.append(_check(
            "supported_windows",
            status="unknown",
            severity="warning",
            reason_code="windows_build_unavailable",
            action_code="retry_check",
            retryable=True,
            checked_at=checked_at,
        ))
    elif (
        system_facts.product_type is not None
        and system_facts.product_type != WINDOWS_WORKSTATION_PRODUCT_TYPE
    ):
        checks.append(_check(
            "supported_windows",
            status="blocked",
            severity="error",
            reason_code="windows_edition_not_supported",
            action_code="view_supported_systems",
            retryable=False,
            checked_at=checked_at,
            measured={"build": system_facts.build},
            required={"product_type": "workstation"},
        ))
    elif system_facts.product_type is None:
        checks.append(_check(
            "supported_windows",
            status="unknown",
            severity="warning",
            reason_code="windows_edition_unavailable",
            action_code="retry_check",
            retryable=True,
            checked_at=checked_at,
            measured={"build": system_facts.build},
        ))
    elif system_facts.build < WINDOWS_11_MINIMUM_BUILD:
        checks.append(_check(
            "supported_windows",
            status="blocked",
            severity="error",
            reason_code="windows_build_not_supported",
            action_code="view_supported_systems",
            retryable=False,
            checked_at=checked_at,
            measured={"build": system_facts.build},
            required={"minimum_build": WINDOWS_11_MINIMUM_BUILD},
        ))
    else:
        checks.append(_check(
            "supported_windows",
            status="pass",
            severity="info",
            reason_code="windows_build_supported",
            action_code="none",
            retryable=False,
            checked_at=checked_at,
            measured={"build": system_facts.build},
            required={"minimum_build": WINDOWS_11_MINIMUM_BUILD},
        ))

    if system_facts.architecture == "unknown":
        checks.append(_check(
            "supported_architecture",
            status="unknown",
            severity="warning",
            reason_code="architecture_check_unavailable",
            action_code="retry_check",
            retryable=True,
            checked_at=checked_at,
            required={"architecture": "x64"},
        ))
    else:
        architecture_supported = system_facts.architecture == "x64"
        checks.append(_check(
            "supported_architecture",
            status="pass" if architecture_supported else "blocked",
            severity="info" if architecture_supported else "error",
            reason_code="architecture_supported" if architecture_supported else "architecture_not_supported",
            action_code="none" if architecture_supported else "view_supported_systems",
            retryable=False,
            checked_at=checked_at,
            measured={"architecture": system_facts.architecture},
            required={"architecture": "x64"},
        ))

    if system_facts.total_memory_bytes is None:
        checks.append(_check(
            "system_memory",
            status="unknown",
            severity="warning",
            reason_code="memory_check_unavailable",
            action_code="retry_check",
            retryable=True,
            checked_at=checked_at,
        ))
    else:
        checks.append(_check(
            "system_memory",
            status="pass",
            severity="info",
            reason_code="memory_measured",
            action_code="none",
            retryable=False,
            checked_at=checked_at,
            measured={"total_bytes": system_facts.total_memory_bytes},
        ))

    return {
        "schema_version": PREFLIGHT_SCHEMA_VERSION,
        "preflight_kind": HOST_PREFLIGHT_KIND,
        "run_id": run_id_factory(),
        "overall_status": _overall_status(checks),
        "checked_at": checked_at,
        "checks": checks,
    }


def _validated_byte_count(value: object, *, field_name: str) -> int | None:
    if value is None:
        return None
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise ValueError(f"{field_name} must be a non-negative integer or null")
    return value


def read_installer_preflight_request(
    request_path: str | os.PathLike[str],
    *,
    temp_root: str | os.PathLike[str] | None = None,
) -> tuple[int | None, dict[str, StorageRequirement]]:
    allowed_root = Path(temp_root or tempfile.gettempdir()).expanduser().resolve()
    resolved_request = Path(request_path).expanduser().resolve()
    if not _is_same_or_child(resolved_request, allowed_root):
        raise ValueError("Installer preflight request must stay inside the user temporary directory")
    if not resolved_request.is_file():
        raise ValueError("Installer preflight request does not exist")
    if resolved_request.stat().st_size > MAX_PREFLIGHT_REQUEST_BYTES:
        raise ValueError("Installer preflight request is too large")
    try:
        payload = json.loads(resolved_request.read_text(encoding="utf-8-sig"))
    except json.JSONDecodeError as exc:
        raise ValueError("Installer preflight request is not valid JSON") from exc
    if not isinstance(payload, dict):
        raise ValueError("Installer preflight request must be a JSON object")
    if payload.get("schema_version") != INSTALLER_PREFLIGHT_REQUEST_VERSION:
        raise ValueError("Unsupported installer preflight request version")
    if payload.get("preflight_kind") != INSTALLER_PREFLIGHT_KIND:
        raise ValueError("Installer preflight request kind is invalid")
    generation = payload.get("request_generation")
    if isinstance(generation, bool) or not isinstance(generation, int) or generation < 0:
        raise ValueError("request_generation must be a non-negative integer")
    raw_requirements = payload.get("requirements")
    if not isinstance(raw_requirements, dict):
        raise ValueError("Installer preflight requirements are missing")
    unknown_roles = set(raw_requirements) - set(INSTALLER_STORAGE_ROLES)
    if unknown_roles:
        raise ValueError("Installer preflight request contains unsupported storage roles")

    requirements: dict[str, StorageRequirement] = {}
    for role in INSTALLER_STORAGE_ROLES:
        raw_requirement = raw_requirements.get(role)
        if raw_requirement is None:
            requirements[role] = StorageRequirement(None, None)
            continue
        if not isinstance(raw_requirement, dict):
            raise ValueError(f"Installer storage requirement for {role} must be an object")
        required = _validated_byte_count(
            raw_requirement.get("required_bytes"),
            field_name=f"{role}.required_bytes",
        )
        recommended = _validated_byte_count(
            raw_requirement.get("recommended_bytes"),
            field_name=f"{role}.recommended_bytes",
        )
        if required is not None and recommended is not None and recommended < required:
            raise ValueError(f"{role}.recommended_bytes cannot be smaller than required_bytes")
        requirements[role] = StorageRequirement(required, recommended)
    return generation, requirements


def _nearest_existing_directory(path: Path) -> Path:
    candidate = Path(os.path.abspath(os.path.expanduser(str(path))))
    while True:
        if os.path.lexists(candidate):
            if not candidate.is_dir():
                raise NotADirectoryError(str(candidate))
            return candidate
        parent = candidate.parent
        if parent == candidate:
            raise FileNotFoundError(str(path))
        candidate = parent


def read_volume_space(path: Path) -> VolumeSpace:
    existing = _nearest_existing_directory(path)
    if os.name != "nt":
        usage = shutil.disk_usage(existing)
        return VolumeSpace(f"device:{existing.stat().st_dev}", int(usage.free))

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    volume_path = ctypes.create_unicode_buffer(32768)
    kernel32.GetVolumePathNameW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_wchar_p,
        ctypes.c_uint32,
    ]
    kernel32.GetVolumePathNameW.restype = ctypes.c_bool
    if not kernel32.GetVolumePathNameW(str(existing), volume_path, len(volume_path)):
        raise ctypes.WinError(ctypes.get_last_error())
    available = ctypes.c_ulonglong()
    total = ctypes.c_ulonglong()
    free = ctypes.c_ulonglong()
    kernel32.GetDiskFreeSpaceExW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.POINTER(ctypes.c_ulonglong),
        ctypes.POINTER(ctypes.c_ulonglong),
        ctypes.POINTER(ctypes.c_ulonglong),
    ]
    kernel32.GetDiskFreeSpaceExW.restype = ctypes.c_bool
    if not kernel32.GetDiskFreeSpaceExW(
        volume_path.value,
        ctypes.byref(available),
        ctypes.byref(total),
        ctypes.byref(free),
    ):
        raise ctypes.WinError(ctypes.get_last_error())
    return VolumeSpace(volume_path.value.casefold(), int(available.value))


def _unlink_with_retry(
    paths: Sequence[Path],
    *,
    attempts: int = 3,
    sleeper: Callable[[float], None] = time.sleep,
) -> tuple[bool, int]:
    attempted = 0
    for attempted in range(1, max(1, attempts) + 1):
        failed = False
        for path in paths:
            try:
                path.unlink(missing_ok=True)
            except OSError:
                failed = True
        if not failed and not any(os.path.lexists(path) for path in paths):
            return True, attempted
        if attempted < attempts:
            sleeper(0.05)
    return False, attempted


def probe_write_cleanup(
    targets: Sequence[Path],
    *,
    token_factory: Callable[[], str] = lambda: secrets.token_hex(16),
    sleeper: Callable[[float], None] = time.sleep,
) -> WriteCleanupProbe:
    bases: list[Path] = []
    seen: set[str] = set()
    try:
        for target in targets:
            base = _nearest_existing_directory(target)
            key = os.path.normcase(str(base))
            if key not in seen:
                seen.add(key)
                bases.append(base)
    except OSError:
        return WriteCleanupProbe("blocked", "unknown", 0, len(bases))
    except Exception:
        return WriteCleanupProbe("unknown", "unknown", 0, len(bases))

    delayed_cleanup = False
    cleanup_attempts = 0
    for base in bases:
        token = token_factory()
        source = base / f".barorok-preflight-{token}.tmp"
        renamed = base / f".barorok-preflight-{token}.check"
        descriptor: int | None = None
        source_owned = False
        renamed_owned = False
        write_succeeded = False
        try:
            descriptor = os.open(source, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
            source_owned = True
            content = f"barorok-installer-preflight:{token}".encode("ascii")
            offset = 0
            while offset < len(content):
                written = os.write(descriptor, content[offset:])
                if written <= 0:
                    raise OSError("Installer preflight canary write made no progress")
                offset += written
            os.fsync(descriptor)
            os.close(descriptor)
            descriptor = None
            _publish_preflight_no_replace(source, renamed)
            source_owned = False
            renamed_owned = True
            if renamed.read_bytes() != content:
                raise OSError("Installer preflight canary verification failed")
            write_succeeded = True
        except OSError:
            write_succeeded = False
        except Exception:
            return WriteCleanupProbe("unknown", "unknown", cleanup_attempts, len(bases))
        finally:
            if descriptor is not None:
                try:
                    os.close(descriptor)
                except OSError:
                    pass
            owned_paths = tuple(
                path
                for path, owned in ((source, source_owned), (renamed, renamed_owned))
                if owned
            )
            cleaned, attempts_used = (
                _unlink_with_retry(owned_paths, sleeper=sleeper)
                if owned_paths
                else (True, 0)
            )
            cleanup_attempts = max(cleanup_attempts, attempts_used)
            delayed_cleanup = delayed_cleanup or attempts_used > 1
        if not cleaned:
            return WriteCleanupProbe(
                "pass" if write_succeeded else "blocked",
                "blocked",
                cleanup_attempts,
                len(bases),
            )
        if not write_succeeded:
            return WriteCleanupProbe("blocked", "unknown", cleanup_attempts, len(bases))

    return WriteCleanupProbe(
        "pass",
        "warning" if delayed_cleanup else "pass",
        cleanup_attempts,
        len(bases),
    )


def _probe_local_engine_product(
    port: int,
    *,
    expected_product_id: str,
    timeout_seconds: float = 0.75,
) -> bool | None:
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout_seconds)
    try:
        connection.request("GET", "/api/probe")
        response = connection.getresponse()
        body = response.read(PORT_PROBE_MAX_BYTES + 1)
        if len(body) > PORT_PROBE_MAX_BYTES:
            return False
        if response.status != 200:
            return False
        payload = json.loads(body.decode("utf-8"))
        return isinstance(payload, dict) and payload.get("product_id") == expected_product_id
    except (OSError, http.client.HTTPException, UnicodeDecodeError, json.JSONDecodeError):
        return None
    finally:
        connection.close()


def inspect_fixed_port(
    *,
    port: int,
    expected_product_id: str,
    own_engine_marker: Callable[[], bool],
    product_probe: Callable[[int], bool | None] | None = None,
) -> PortInspection:
    try:
        own_engine = own_engine_marker()
    except Exception:
        return PortInspection("unknown")
    probe = product_probe or (
        lambda selected_port: _probe_local_engine_product(
            selected_port,
            expected_product_id=expected_product_id,
        )
    )
    listener = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind(("127.0.0.1", port))
        if own_engine:
            return PortInspection("local_engine")
        return PortInspection("available")
    except OSError:
        product_match = probe(port)
        if product_match is True or own_engine:
            return PortInspection("local_engine")
        return PortInspection("occupied")
    finally:
        listener.close()


def _space_check(
    role: str,
    *,
    status: str,
    reason_code: str,
    action_code: str,
    checked_at: int,
    retryable: bool,
    requirement: StorageRequirement,
    measured: Mapping[str, object] | None = None,
) -> dict[str, object]:
    required: dict[str, object] = {}
    if requirement.required_bytes is not None:
        required["required_bytes"] = requirement.required_bytes
    if requirement.recommended_bytes is not None:
        required["recommended_bytes"] = requirement.recommended_bytes
    return _check(
        INSTALLER_STORAGE_CHECK_IDS[role],
        status=status,
        severity="error" if status == "blocked" else "warning" if status in {"warning", "unknown"} else "info",
        reason_code=reason_code,
        action_code=action_code,
        retryable=retryable,
        checked_at=checked_at,
        measured=measured,
        required=required,
    )


def _installer_storage_checks(
    paths: InstallerTargetPaths,
    requirements: Mapping[str, StorageRequirement],
    *,
    checked_at: int,
    volume_reader: Callable[[Path], VolumeSpace],
) -> list[dict[str, object]]:
    role_paths = {
        "install": paths.install,
        "staging": paths.staging,
        "models": paths.models,
        "analysis_temp": paths.analysis_temp,
        "results": paths.results,
    }
    role_spaces: dict[str, VolumeSpace | None] = {}
    volume_order: list[str] = []
    volume_available: dict[str, int] = {}
    volume_roles: dict[str, list[str]] = {}
    for role in INSTALLER_STORAGE_ROLES:
        try:
            space = volume_reader(role_paths[role])
            if space.available_bytes < 0:
                raise ValueError("Available space cannot be negative")
        except Exception:
            role_spaces[role] = None
            continue
        role_spaces[role] = space
        if space.identity not in volume_roles:
            volume_order.append(space.identity)
            volume_roles[space.identity] = []
            volume_available[space.identity] = space.available_bytes
        volume_roles[space.identity].append(role)
        volume_available[space.identity] = min(
            volume_available[space.identity],
            space.available_bytes,
        )
    volume_refs = {identity: f"volume-{index + 1}" for index, identity in enumerate(volume_order)}
    checks: list[dict[str, object]] = []

    for role in INSTALLER_STORAGE_ROLES:
        requirement = requirements.get(role, StorageRequirement(None, None))
        space = role_spaces.get(role)
        if space is None:
            checks.append(_space_check(
                role,
                status="unknown",
                reason_code="space_check_unavailable",
                action_code="retry_check",
                checked_at=checked_at,
                retryable=True,
                requirement=requirement,
            ))
            continue
        grouped_roles = volume_roles[space.identity]
        relevant_roles = (
            [item for item in grouped_roles if item in INSTALLER_BLOCKING_STORAGE_ROLES]
            if role in INSTALLER_BLOCKING_STORAGE_ROLES
            else [item for item in grouped_roles if item in INSTALLER_FUTURE_STORAGE_ROLES]
        )
        group_requirements = [requirements.get(item, StorageRequirement(None, None)) for item in relevant_roles]
        if not relevant_roles or any(
            item.required_bytes is None or item.recommended_bytes is None
            for item in group_requirements
        ):
            checks.append(_space_check(
                role,
                status="unknown",
                reason_code="space_requirement_unavailable",
                action_code="retry_check",
                checked_at=checked_at,
                retryable=True,
                requirement=requirement,
                measured={"volume_ref": volume_refs[space.identity]},
            ))
            continue
        aggregate_required = sum(int(item.required_bytes or 0) for item in group_requirements)
        aggregate_recommended = sum(int(item.recommended_bytes or 0) for item in group_requirements)
        available = volume_available[space.identity]
        measured_available = available
        if role in INSTALLER_FUTURE_STORAGE_ROLES:
            persistent_requirements = [
                requirements.get(item, StorageRequirement(None, None))
                for item in grouped_roles
                if item in INSTALLER_PERSISTENT_STORAGE_ROLES
            ]
            if any(item.required_bytes is None for item in persistent_requirements):
                checks.append(_space_check(
                    role,
                    status="unknown",
                    reason_code="space_requirement_unavailable",
                    action_code="retry_check",
                    checked_at=checked_at,
                    retryable=True,
                    requirement=requirement,
                    measured={"volume_ref": volume_refs[space.identity]},
                ))
                continue
            measured_available = max(
                0,
                available - sum(int(item.required_bytes or 0) for item in persistent_requirements),
            )
        measured = {
            "volume_ref": volume_refs[space.identity],
            "available_bytes": available,
            "available_after_install_bytes": measured_available,
            "aggregate_required_bytes": aggregate_required,
            "aggregate_recommended_bytes": aggregate_recommended,
            "roles": relevant_roles,
        }
        if measured_available < aggregate_required:
            blocked = role in INSTALLER_BLOCKING_STORAGE_ROLES
            checks.append(_space_check(
                role,
                status="blocked" if blocked else "warning",
                reason_code="space_insufficient" if blocked else "space_insufficient_for_future_readiness",
                action_code="free_space_and_retry",
                checked_at=checked_at,
                retryable=True,
                requirement=requirement,
                measured=measured,
            ))
        elif measured_available < aggregate_recommended:
            checks.append(_space_check(
                role,
                status="warning",
                reason_code="space_below_recommended",
                action_code="free_space_and_retry",
                checked_at=checked_at,
                retryable=True,
                requirement=requirement,
                measured=measured,
            ))
        else:
            checks.append(_space_check(
                role,
                status="pass",
                reason_code="space_sufficient",
                action_code="none",
                checked_at=checked_at,
                retryable=False,
                requirement=requirement,
                measured=measured,
            ))
    return checks


def collect_installer_target_preflight(
    paths: InstallerTargetPaths,
    requirements: Mapping[str, StorageRequirement],
    *,
    request_generation: int,
    clock: Callable[[], float] = time.time,
    run_id_factory: Callable[[], str] = lambda: secrets.token_hex(16),
    volume_reader: Callable[[Path], VolumeSpace] = read_volume_space,
    write_cleanup_reader: Callable[[Sequence[Path]], WriteCleanupProbe] = probe_write_cleanup,
    port_reader: Callable[[], PortInspection],
) -> dict[str, object]:
    checked_at = int(clock())
    checks = _installer_storage_checks(
        paths,
        requirements,
        checked_at=checked_at,
        volume_reader=volume_reader,
    )
    access = write_cleanup_reader(paths.write_targets)
    checks.append(_check(
        "installer_local_app_data_write",
        status=access.write_status,
        severity="error" if access.write_status == "blocked" else "warning" if access.write_status == "unknown" else "info",
        reason_code=(
            "write_cleanup_succeeded"
            if access.write_status == "pass"
            else "write_denied"
            if access.write_status == "blocked"
            else "write_check_unavailable"
        ),
        action_code="none" if access.write_status == "pass" else "check_folder_permissions",
        retryable=access.write_status != "pass",
        checked_at=checked_at,
        measured={"targets_checked": access.target_count},
    ))
    checks.append(_check(
        "installer_local_app_data_cleanup",
        status=access.cleanup_status,
        severity="error" if access.cleanup_status == "blocked" else "warning" if access.cleanup_status in {"warning", "unknown"} else "info",
        reason_code=(
            "write_cleanup_succeeded"
            if access.cleanup_status == "pass"
            else "cleanup_delayed"
            if access.cleanup_status == "warning"
            else "cleanup_failed"
            if access.cleanup_status == "blocked"
            else "write_check_unavailable"
        ),
        action_code="none" if access.cleanup_status == "pass" else "check_folder_permissions",
        retryable=access.cleanup_status != "pass",
        checked_at=checked_at,
        measured={"cleanup_attempts": access.cleanup_attempts},
    ))
    try:
        port = port_reader()
    except Exception:
        port = PortInspection("unknown")
    port_contract = {
        "available": ("pass", "info", "fixed_port_available", "none", False),
        "local_engine": ("warning", "warning", "local_engine_already_running", "stop_local_engine_and_retry", True),
        "occupied": ("blocked", "error", "fixed_port_in_use", "close_conflicting_app_and_retry", True),
        "unknown": ("unknown", "warning", "port_check_unavailable", "retry_check", True),
    }[port.state]
    checks.append(_check(
        "installer_fixed_port",
        status=port_contract[0],
        severity=port_contract[1],
        reason_code=port_contract[2],
        action_code=port_contract[3],
        retryable=port_contract[4],
        checked_at=checked_at,
        measured={"port": 17863},
    ))
    payload: dict[str, object] = {
        "schema_version": PREFLIGHT_SCHEMA_VERSION,
        "preflight_kind": INSTALLER_PREFLIGHT_KIND,
        "run_id": run_id_factory(),
        "overall_status": _overall_status(checks),
        "checked_at": checked_at,
        "checks": checks,
    }
    payload["request_generation"] = request_generation
    return payload


def _is_same_or_child(path: Path, root: Path) -> bool:
    try:
        path.relative_to(root)
        return True
    except ValueError:
        return False


def write_preflight_json(
    output_path: str | os.PathLike[str],
    payload: Mapping[str, object],
    *,
    temp_root: str | os.PathLike[str] | None = None,
) -> Path:
    allowed_root = Path(temp_root or tempfile.gettempdir()).expanduser().resolve()
    resolved_output = Path(output_path).expanduser().resolve()
    if not _is_same_or_child(resolved_output, allowed_root):
        raise ValueError("Preflight JSON output must stay inside the user temporary directory")
    if not resolved_output.parent.is_dir():
        raise ValueError("Preflight JSON output directory does not exist")
    serialized = (json.dumps(payload, ensure_ascii=False, separators=(",", ":")) + "\n").encode("utf-8")
    temporary_path = resolved_output.with_name(
        f".{resolved_output.name}.{os.getpid()}.{secrets.token_hex(8)}.tmp"
    )
    descriptor = os.open(
        temporary_path,
        os.O_WRONLY | os.O_CREAT | os.O_EXCL,
        0o600,
    )
    try:
        with os.fdopen(descriptor, "wb") as output_file:
            output_file.write(serialized)
            output_file.flush()
            os.fsync(output_file.fileno())
        _publish_preflight_no_replace(temporary_path, resolved_output)
    except Exception:
        temporary_path.unlink(missing_ok=True)
        raise
    return resolved_output


def _publish_preflight_no_replace(temporary_path: Path, output_path: Path) -> None:
    if os.name == "nt":
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.MoveFileExW.argtypes = [ctypes.c_wchar_p, ctypes.c_wchar_p, ctypes.c_uint32]
        kernel32.MoveFileExW.restype = ctypes.c_bool
        if kernel32.MoveFileExW(
            str(temporary_path),
            str(output_path),
            WINDOWS_MOVEFILE_WRITE_THROUGH,
        ):
            return
        error = ctypes.get_last_error()
        if error in {WINDOWS_ERROR_ALREADY_EXISTS, WINDOWS_ERROR_FILE_EXISTS}:
            raise FileExistsError(str(output_path))
        raise ctypes.WinError(error)
    os.link(temporary_path, output_path)
    temporary_path.unlink()
