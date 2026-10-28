from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import math
import os
import re
import secrets
import shutil
import socket
import stat as stat_module
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "backend"))
from web_local_engine_installer_preflight import storage_requirements_from_manifest  # noqa: E402


ENGINE_EXE_NAME = "barorok-local-engine-x86_64-pc-windows-msvc.exe"
# Window titles carry the product display name, which is written only in configs/brand.json.
BRAND_NAME = json.loads(
    (Path(__file__).resolve().parents[1] / "configs" / "brand.json").read_text(encoding="utf-8-sig")
)["brandName"]
ENGINE_URL = "http://127.0.0.1:17863"
CREATE_NO_WINDOW = 0x08000000
PREFLIGHT_PROCESS_TIMEOUT_SECONDS = 60
INSTALLER_TARGET_CHECK_IDS = {
    "installer_install_space",
    "installer_staging_space",
    "installer_model_space",
    "installer_analysis_temp_space",
    "installer_results_space",
    "installer_local_app_data_write",
    "installer_local_app_data_cleanup",
    "installer_fixed_port",
}
WM_CLOSE = 0x0010
GENERIC_READ = 0x80000000
GENERIC_WRITE = 0x40000000
FILE_SHARE_READ = 0x00000001
FILE_SHARE_WRITE = 0x00000002
OPEN_EXISTING = 3
INVALID_HANDLE_VALUE = ctypes.c_void_p(-1).value


def fail(message: str) -> None:
    raise RuntimeError(message)


def rename_directory_with_retry(
    source: Path,
    target: Path,
    *,
    timeout_seconds: float = 5,
) -> None:
    deadline = time.monotonic() + timeout_seconds
    while True:
        try:
            source.rename(target)
            return
        except PermissionError:
            if target.exists() or not source.exists() or time.monotonic() >= deadline:
                raise
            time.sleep(0.1)


def json_string_values(value: object):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for key, item in value.items():
            yield str(key)
            yield from json_string_values(item)
    elif isinstance(value, list):
        for item in value:
            yield from json_string_values(item)


def parse_arguments() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Verify a frozen Barorok local-engine PoC payload")
    parser.add_argument("artifact", type=Path)
    parser.add_argument("--local-app-data", type=Path)
    parser.add_argument("--keep-data", action="store_true")
    parser.add_argument("--verify-challenge-expiry", action="store_true", help="Also wait for a real automatic browser-connection request to expire (about two minutes)")
    parser.add_argument("--manifest-only", action="store_true")
    return parser.parse_args()


def request_json(
    path: str,
    *,
    origin: str,
    method: str = "GET",
    payload: dict[str, object] | None = None,
    token: str | None = None,
    timeout: float = 5,
) -> tuple[int, dict[str, object]]:
    headers = {"Origin": origin}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    data = None
    if payload is not None:
        headers["Content-Type"] = "application/json"
        data = json.dumps(payload).encode("utf-8")
    request = urllib.request.Request(
        ENGINE_URL + path,
        data=data,
        headers=headers,
        method=method,
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            body = json.loads(response.read().decode("utf-8"))
            return response.status, body
    except urllib.error.HTTPError as exc:
        try:
            body = json.loads(exc.read().decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            body = {}
        return exc.code, body


def wait_for_probe(origin: str, *, timeout: float = 30) -> dict[str, object]:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        try:
            status, body = request_json("/api/probe", origin=origin, timeout=2)
            if status == 200:
                return body
        except (OSError, urllib.error.URLError):
            pass
        time.sleep(0.25)
    fail("The frozen engine did not become ready")


def listener_rows() -> list[str]:
    output = subprocess.check_output(
        ["netstat", "-ano"],
        text=True,
        encoding="utf-8",
        errors="replace",
        creationflags=CREATE_NO_WINDOW,
    )
    return [line.strip() for line in output.splitlines() if ":17863" in line and "LISTENING" in line]


def assert_loopback_listener(engine_pid: int) -> None:
    rows = listener_rows()
    expected = [row for row in rows if re.search(r"TCP\s+127\.0\.0\.1:17863\s+", row)]
    if len(expected) != 1 or not expected[0].endswith(str(engine_pid)):
        fail("The frozen engine does not own exactly one IPv4 loopback listener")
    if any("0.0.0.0:17863" in row or "[::]:17863" in row for row in rows):
        fail("The frozen engine exposed a non-loopback listener")


if os.name == "nt":
    user32 = ctypes.WinDLL("user32", use_last_error=True)
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    enum_proc_type = ctypes.WINFUNCTYPE(ctypes.c_bool, ctypes.c_void_p, ctypes.c_void_p)
    user32.EnumWindows.argtypes = [enum_proc_type, ctypes.c_void_p]
    user32.EnumChildWindows.argtypes = [ctypes.c_void_p, enum_proc_type, ctypes.c_void_p]
    user32.GetWindowThreadProcessId.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_uint32)]
    user32.GetWindowTextW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p, ctypes.c_int]
    user32.IsWindowVisible.argtypes = [ctypes.c_void_p]
    user32.PostMessageW.argtypes = [ctypes.c_void_p, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_void_p]
    kernel32.CreateFileW.argtypes = [
        ctypes.c_wchar_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
        ctypes.c_uint32,
        ctypes.c_uint32,
        ctypes.c_void_p,
    ]
    kernel32.CreateFileW.restype = ctypes.c_void_p
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_bool


def find_window(process_id: int, title: str) -> int:
    found = 0

    @enum_proc_type
    def visit(handle: int, _parameter: int) -> bool:
        nonlocal found
        owner = ctypes.c_uint32()
        user32.GetWindowThreadProcessId(handle, ctypes.byref(owner))
        if owner.value == process_id and user32.IsWindowVisible(handle):
            buffer = ctypes.create_unicode_buffer(512)
            user32.GetWindowTextW(handle, buffer, len(buffer))
            if buffer.value == title:
                found = int(handle)
                return False
        return True

    user32.EnumWindows(visit, None)
    return found


def wait_for_window(process_id: int, title: str, *, timeout: float = 10) -> int:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        handle = find_window(process_id, title)
        if handle:
            return handle
        time.sleep(0.1)
    fail(f"Expected Windows dialog did not appear: {title}")


def child_window_text(parent: int) -> str:
    parts: list[str] = []

    @enum_proc_type
    def visit(handle: int, _parameter: int) -> bool:
        buffer = ctypes.create_unicode_buffer(2048)
        user32.GetWindowTextW(handle, buffer, len(buffer))
        if buffer.value:
            parts.append(buffer.value)
        return True

    user32.EnumChildWindows(parent, visit, None)
    return "\n".join(parts)


def close_window(handle: int) -> None:
    if handle:
        user32.PostMessageW(handle, WM_CLOSE, None, None)


def start_process(executable: Path, environment: dict[str, str], *arguments: str) -> subprocess.Popen[bytes]:
    return subprocess.Popen(
        [str(executable), *arguments],
        cwd=executable.parent.parent,
        env=environment,
        creationflags=CREATE_NO_WINDOW,
    )


def exercise_preflight_json(
    executable: Path,
    environment: dict[str, str],
    *,
    temp_root: Path | None = None,
) -> dict[str, object]:
    base_temp_root = (temp_root or Path(tempfile.gettempdir())).resolve()
    base_temp_root.mkdir(parents=True, exist_ok=True)
    privacy_nonce = secrets.token_hex(16)
    output_root = Path(tempfile.mkdtemp(prefix="barorok-preflight-env-", dir=base_temp_root))
    output_path = output_root / f"barorok-preflight-smoke-{privacy_nonce}.json"
    child_environment = environment.copy()
    child_environment["USERNAME"] = f"barorok-preflight-user-{privacy_nonce}"
    child_environment["LOCALAPPDATA"] = str(output_root / f"local-app-data-{privacy_nonce}")
    child_environment["TEMP"] = str(output_root)
    child_environment["TMP"] = str(output_root)
    try:
        completed = subprocess.run(
            [str(executable), "--preflight-json", str(output_path)],
            cwd=executable.parent.parent,
            env=child_environment,
            creationflags=CREATE_NO_WINDOW,
            timeout=PREFLIGHT_PROCESS_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0 or not output_path.is_file():
            fail("The frozen --preflight-json command did not create a result")
        original_bytes = output_path.read_bytes()
        try:
            payload = json.loads(original_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail("The frozen preflight result is not valid UTF-8 JSON")
        if payload.get("schema_version") != 1:
            fail("The frozen preflight schema version is invalid")
        if payload.get("preflight_kind") != "host_system":
            fail("The frozen host preflight kind is invalid")
        run_id = str(payload.get("run_id") or "")
        if re.fullmatch(r"[0-9a-f]{32}", run_id) is None:
            fail("The frozen preflight run identifier is invalid")
        if payload.get("overall_status") not in {"pass", "warning", "blocked", "unknown"}:
            fail("The frozen preflight overall status is invalid")
        checks = payload.get("checks")
        if not isinstance(checks, list):
            fail("The frozen preflight checks are missing")
        check_ids = {
            str(check.get("check_id"))
            for check in checks
            if isinstance(check, dict)
        }
        if check_ids != {"supported_windows", "supported_architecture", "system_memory"}:
            fail("The frozen preflight check set is invalid")
        payload_strings = [value.casefold() for value in json_string_values(payload)]
        forbidden = (
            child_environment["USERNAME"].casefold(),
            child_environment["LOCALAPPDATA"].casefold(),
            str(output_root).casefold(),
            str(executable.parent.parent.resolve()).casefold(),
            "authorization",
            "pairing",
            "session_token",
            "transcript",
        )
        if any(
            value and value in payload_value
            for value in forbidden
            for payload_value in payload_strings
        ):
            fail("The frozen preflight result exposed private runtime data")

        repeated = subprocess.run(
            [str(executable), "--preflight-json", str(output_path)],
            cwd=executable.parent.parent,
            env=child_environment,
            creationflags=CREATE_NO_WINDOW,
            timeout=PREFLIGHT_PROCESS_TIMEOUT_SECONDS,
            check=False,
        )
        if repeated.returncode != 2 or output_path.read_bytes() != original_bytes:
            fail("The frozen preflight command overwrote an existing result")
        return payload
    finally:
        output_path.unlink(missing_ok=True)
        output_root.rmdir()


def installer_preflight_request(generation: int) -> dict[str, object]:
    return {
        "schema_version": 1,
        "preflight_kind": "installer_target",
        "request_generation": generation,
        "requirements": {
            role: {
                "required_bytes": 1024 * 1024,
                "recommended_bytes": 2 * 1024 * 1024,
            }
            for role in ("install", "staging", "models", "analysis_temp", "results")
        },
    }


def exercise_installer_target_preflight(
    executable: Path,
    environment: dict[str, str],
    *,
    expected_port_status: str,
) -> dict[str, object]:
    base_temp_root = Path(environment["TEMP"]).resolve()
    base_temp_root.mkdir(parents=True, exist_ok=True)
    nonce = secrets.token_hex(16)
    output_root = Path(tempfile.mkdtemp(prefix="barorok-installer-preflight-", dir=base_temp_root))
    request_path = output_root / f"request-{nonce}.json"
    output_path = output_root / f"result-{nonce}.json"
    request_path.write_text(
        json.dumps(installer_preflight_request(41), separators=(",", ":")),
        encoding="utf-8",
    )
    try:
        completed = subprocess.run(
            [
                str(executable),
                "--installer-target-preflight-json",
                str(request_path),
                str(output_path),
            ],
            cwd=executable.parent.parent,
            env=environment,
            creationflags=CREATE_NO_WINDOW,
            timeout=PREFLIGHT_PROCESS_TIMEOUT_SECONDS,
            check=False,
        )
        if completed.returncode != 0 or not output_path.is_file():
            fail("The frozen installer target preflight did not create a result")
        original_bytes = output_path.read_bytes()
        try:
            payload = json.loads(original_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            fail("The frozen installer target preflight result is not valid UTF-8 JSON")
        if payload.get("schema_version") != 1 or payload.get("preflight_kind") != "installer_target":
            fail("The frozen installer target preflight scope is invalid")
        if payload.get("request_generation") != 41:
            fail("The frozen installer target preflight lost its request generation")
        if payload.get("overall_status") not in {"pass", "warning", "blocked", "unknown"}:
            fail("The frozen installer target preflight overall status is invalid")
        checks = payload.get("checks")
        if not isinstance(checks, list):
            fail("The frozen installer target preflight checks are missing")
        checks_by_id = {
            str(check.get("check_id")): check
            for check in checks
            if isinstance(check, dict)
        }
        if set(checks_by_id) != INSTALLER_TARGET_CHECK_IDS:
            fail("The frozen installer target preflight check set is invalid")
        if checks_by_id["installer_fixed_port"].get("status") != expected_port_status:
            fail("The frozen installer target preflight misclassified the fixed port")
        for check_id, check in checks_by_id.items():
            if check_id != "installer_fixed_port" and check.get("status") != "pass":
                fail(f"The frozen installer target preflight did not pass {check_id}")
        expected_overall = {
            "pass": "pass",
            "warning": "warning",
            "blocked": "blocked",
        }[expected_port_status]
        if payload.get("overall_status") != expected_overall:
            fail("The frozen installer target preflight overall status is inconsistent")
        if any(
            check.get("status") not in {"pass", "warning", "blocked", "unknown"}
            for check in checks_by_id.values()
        ):
            fail("The frozen installer target preflight emitted a non-terminal status")
        payload_strings = [value.casefold() for value in json_string_values(payload)]
        forbidden = (
            str(environment.get("USERNAME") or "").casefold(),
            str(environment.get("LOCALAPPDATA") or "").casefold(),
            str(environment.get("TEMP") or "").casefold(),
            str(output_root).casefold(),
            str(executable.parent.parent.resolve()).casefold(),
            "session_token",
            "pairing",
            "transcript",
        )
        if any(
            value and value in payload_value
            for value in forbidden
            for payload_value in payload_strings
        ):
            fail("The frozen installer target preflight exposed private runtime data")
        if list(Path(environment["LOCALAPPDATA"]).rglob(".barorok-preflight-*")):
            fail("The frozen installer target preflight left a write canary behind")

        repeated = subprocess.run(
            [
                str(executable),
                "--installer-target-preflight-json",
                str(request_path),
                str(output_path),
            ],
            cwd=executable.parent.parent,
            env=environment,
            creationflags=CREATE_NO_WINDOW,
            timeout=PREFLIGHT_PROCESS_TIMEOUT_SECONDS,
            check=False,
        )
        if repeated.returncode != 2 or output_path.read_bytes() != original_bytes:
            fail("The frozen installer target preflight overwrote an existing result")
        return payload
    finally:
        request_path.unlink(missing_ok=True)
        output_path.unlink(missing_ok=True)
        if output_root.exists():
            output_root.rmdir()


def stop_engine(executable: Path, environment: dict[str, str], engine: subprocess.Popen[bytes]) -> None:
    stopped = subprocess.run(
        [str(executable), "--stop"],
        cwd=executable.parent.parent,
        env=environment,
        creationflags=CREATE_NO_WINDOW,
        timeout=10,
        check=False,
    )
    if stopped.returncode != 0:
        fail("The packaged --stop command could not signal the running engine")
    if engine.wait(timeout=15) != 0:
        fail("The engine did not exit cleanly after --stop")
    if listener_rows():
        fail("The engine listener remained after normal shutdown")


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as source:
        for block in iter(lambda: source.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def verify_manifest(artifact: Path) -> tuple[dict[str, object], dict[str, tuple[int, int]]]:
    manifest = json.loads((artifact / "poc-manifest.json").read_text(encoding="utf-8-sig"))
    if manifest.get("distributionReady") is not False or manifest.get("signed") is not False:
        fail("The PoC manifest must remain unsigned and non-distributable")
    if manifest.get("bind") != "127.0.0.1:17863":
        fail("The PoC manifest does not declare the fixed loopback listener")
    try:
        storage = storage_requirements_from_manifest(manifest)
    except ValueError:
        fail("The PoC manifest storage requirements are invalid")
    if any(item.required_bytes is None for item in storage.values()):
        # Without these sizes every installer run asks the user to confirm.
        fail("The PoC manifest does not declare post-install storage requirements")
    artifact_root = artifact.resolve()
    for candidate in artifact_root.rglob("*"):
        attributes = getattr(candidate.lstat(), "st_file_attributes", 0)
        if attributes & getattr(stat_module, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400):
            fail(f"Artifact payload cannot contain a reparse point: {candidate.name}")
    snapshot: dict[str, tuple[int, int]] = {}
    listed_paths: dict[str, str] = {}
    for entry in manifest.get("payloadFiles", []):
        relative = str(entry["path"]).replace("\\", "/")
        parts = Path(relative).parts
        if not relative or Path(relative).is_absolute() or any(part in ("", ".", "..") for part in parts):
            fail(f"Manifest payload path is unsafe: {relative}")
        normalized = Path(*parts).as_posix()
        identity = normalized.casefold()
        if identity in listed_paths:
            fail(f"Manifest payload path is duplicated: {relative}")
        candidate = artifact_root / Path(*parts)
        if candidate.is_symlink():
            fail(f"Manifest payload cannot be a symbolic link: {relative}")
        path = candidate.resolve(strict=True)
        try:
            path.relative_to(artifact_root)
        except ValueError:
            fail(f"Manifest payload path escaped the artifact: {relative}")
        if not path.is_file():
            fail(f"Manifest payload is not a regular file: {relative}")
        listed_paths[identity] = normalized
        stat = path.stat()
        if stat.st_size != entry["bytes"] or sha256(path) != entry["sha256"]:
            fail(f"Payload hash verification failed: {normalized}")
        snapshot[normalized] = (stat.st_size, stat.st_mtime_ns)
    actual_paths = {
        path.relative_to(artifact_root).as_posix().casefold()
        for path in artifact_root.rglob("*")
        if path.is_file() and path.resolve() != (artifact_root / "poc-manifest.json").resolve()
    }
    if actual_paths != set(listed_paths):
        missing = sorted(set(listed_paths) - actual_paths)
        unlisted = sorted(actual_paths - set(listed_paths))
        fail(f"Manifest file set mismatch (missing={missing[:3]}, unlisted={unlisted[:3]})")
    if "engine/ffmpeg.exe" not in listed_paths:
        fail("The frozen payload does not include the required ffmpeg.exe")
    return manifest, snapshot


def assert_install_tree_unchanged(artifact: Path, snapshot: dict[str, tuple[int, int]]) -> None:
    actual_paths = {
        path.relative_to(artifact).as_posix().casefold()
        for path in artifact.rglob("*")
        if path.is_file() and path.resolve() != (artifact.resolve() / "poc-manifest.json").resolve()
    }
    if actual_paths != {relative.casefold() for relative in snapshot}:
        fail("The runtime added or removed an install payload file")
    for relative, expected in snapshot.items():
        stat = (artifact / Path(relative)).stat()
        if (stat.st_size, stat.st_mtime_ns) != expected:
            fail(f"The runtime modified an install payload file: {relative}")


def lock_install_files_read_only(artifact: Path) -> list[int]:
    handles: list[int] = []
    try:
        for path in artifact.rglob("*"):
            if not path.is_file():
                continue
            handle = kernel32.CreateFileW(
                str(path),
                GENERIC_READ,
                FILE_SHARE_READ,
                None,
                OPEN_EXISTING,
                0,
                None,
            )
            if handle == INVALID_HANDLE_VALUE:
                raise ctypes.WinError(ctypes.get_last_error())
            handles.append(int(handle))
        settings_path = artifact / "defaults" / "engine-settings.json"
        if windows_file_write_is_denied(settings_path):
            return handles
        fail("The install payload write lock was not enforced")
    except Exception:
        close_install_read_locks(handles)
        raise


def close_install_read_locks(handles: list[int]) -> None:
    while handles:
        handle = handles.pop()
        if not kernel32.CloseHandle(ctypes.c_void_p(handle)):
            raise ctypes.WinError(ctypes.get_last_error())


def windows_file_write_is_denied(path: Path) -> bool:
    handle = kernel32.CreateFileW(
        str(path),
        GENERIC_WRITE,
        FILE_SHARE_READ | FILE_SHARE_WRITE,
        None,
        OPEN_EXISTING,
        0,
        None,
    )
    if handle == INVALID_HANDLE_VALUE:
        return True
    kernel32.CloseHandle(ctypes.c_void_p(handle))
    return False


def create_preservation_sentinels(data_root: Path) -> dict[Path, str]:
    sentinels: dict[Path, str] = {}
    for directory in ("config", "models", "database", "results"):
        path = data_root / directory / "stage3b-preservation.sentinel"
        path.parent.mkdir(parents=True, exist_ok=True)
        value = f"preserve-{directory}"
        path.write_text(value, encoding="utf-8")
        sentinels[path] = value
    return sentinels


def assert_sentinels(sentinels: dict[Path, str]) -> None:
    for path, expected in sentinels.items():
        if path.read_text(encoding="utf-8") != expected:
            fail(f"User data was not preserved: {path.parent.name}")


def scan_secret_leaks(data_root: Path, *credentials: str) -> None:
    if not credentials or any(not value for value in credentials):
        fail("Secret-leak checks require nonempty credentials")
    for path in data_root.rglob("*"):
        if not path.is_file() or path.stat().st_size > 5 * 1024 * 1024:
            continue
        try:
            content = path.read_text(encoding="utf-8", errors="ignore")
        except OSError:
            continue
        if any(value in content for value in credentials):
            fail("A connection secret was written to the local-engine user data")


def browser_completion_payload(pairing_id: str) -> dict[str, object]:
    return {"mode": "browser-connection", "pairing_id": pairing_id}


def validate_browser_start(body: dict[str, object]) -> str:
    pairing_id = body.get("pairing_id")
    ttl = body.get("expires_in_seconds")
    if (body.get("mode") != "browser-connection" or not isinstance(pairing_id, str) or not pairing_id
            or not isinstance(ttl, int) or isinstance(ttl, bool) or not 0 < ttl <= 130
            or "code" in body or "session_token" in body):
        fail("The automatic browser-connection start contract is invalid")
    return pairing_id


def validate_browser_credential(body: dict[str, object]) -> str:
    token = body.get("session_token")
    expires_at = body.get("expires_at")
    if not isinstance(token, str) or not token:
        fail("Automatic browser connection did not issue a session credential")
    if (not isinstance(expires_at, (int, float)) or isinstance(expires_at, bool)
            or not math.isfinite(expires_at) or expires_at <= time.time()):
        fail("The automatic session expiry metadata is invalid")
    return token


def wait_for_browser_credential(origin: str, pairing_id: str, *, timeout: float = 15) -> str:
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        status, body = request_json(
            "/api/pair/complete", origin=origin, method="POST",
            payload=browser_completion_payload(pairing_id), timeout=min(5, max(.01, deadline - time.monotonic())),
        )
        if status == 200:
            return validate_browser_credential(body)
        if status != 202 or body.get("pending") is not True or "session_token" in body:
            fail("The automatic browser-connection request was not completed safely")
        time.sleep(min(.1, max(0, deadline - time.monotonic())))
    fail("Automatic browser connection timed out")


def assert_browser_grants(data_root: Path, origin: str, browser_token: str | None) -> None:
    payload = json.loads((data_root / "config" / "browser-approvals.json").read_text(encoding="utf-8"))
    expected = {} if browser_token is None else {hashlib.sha256(browser_token.encode("ascii")).hexdigest(): origin}
    if payload.get("format") != 1 or payload.get("grants") != expected:
        fail("The saved browser grant does not match the expected credential digest and origin")


def assert_session_health(origin: str, token: str, *, valid: bool) -> None:
    status, body = request_json("/api/health", origin=origin, token=token)
    if valid and (status != 200 or body.get("ok") is not True):
        fail("The automatic session could not access the protected health endpoint")
    if not valid and status not in (401, 403):
        fail("An invalidated browser session could still access the protected API")


def exercise_browser_connection(origin: str, data_root: Path) -> tuple[str, tuple[str, ...]]:
    status, probe = request_json("/api/probe", origin=origin)
    if status != 200 or probe.get("pairing_available") is not True or probe.get("pairing_mode") != "browser-connection":
        fail("The frozen probe does not advertise automatic browser connection")
    browser_token = secrets.token_urlsafe(32)
    start_payload = {"mode": "browser-connection", "browser_token": browser_token}
    for foreign_origin in ("https://wrong.example", ""):
        for path, payload in (
            ("/api/pair/start", start_payload),
            ("/api/pair/complete", browser_completion_payload("unknown")),
            ("/api/pair/restore", {"browser_token": browser_token}),
            ("/api/pair/forget", {"browser_token": browser_token}),
        ):
            rejected, _ = request_json(path, origin=foreign_origin, method="POST", payload=payload)
            if rejected != 403:
                fail("Automatic browser connection did not reject a different or missing origin")
    unknown, _ = request_json("/api/pair/restore", origin=origin, method="POST", payload={"browser_token": browser_token})
    if unknown != 401:
        fail("An unknown browser credential could restore a session")

    # Automatic approval can finish before another start. The contract is a
    # five-per-minute bound, not exactly one successful concurrent request.
    with ThreadPoolExecutor(max_workers=6) as executor:
        results = list(executor.map(
            lambda _index: request_json("/api/pair/start", origin=origin, method="POST", payload=start_payload), range(6),
        ))
    successful = [body for status, body in results if status == 200]
    rejected = [status for status, _body in results if status != 200]
    if not 1 <= len(successful) <= 5 or not rejected or any(status != 429 for status in rejected):
        fail("Concurrent browser-connection starts exceeded the request limit")
    pairing_ids = [validate_browser_start(body) for body in successful]
    if len(set(pairing_ids)) != len(pairing_ids):
        fail("Automatic browser-connection requests reused an identifier")
    tokens = []
    for pairing_id in pairing_ids:
        token = wait_for_browser_credential(origin, pairing_id)
        tokens.append(token)
        assert_session_health(origin, token, valid=True)
        replay_status, _ = request_json(
            "/api/pair/complete", origin=origin, method="POST", payload=browser_completion_payload(pairing_id),
        )
        if replay_status != 403:
            fail("A consumed browser-connection request could be reused")
    assert_browser_grants(data_root, origin, browser_token)
    scan_secret_leaks(data_root, browser_token, *tokens)
    return browser_token, tuple(tokens)


def exercise_expired_browser_challenge(origin: str, data_root: Path) -> None:
    browser_token = secrets.token_urlsafe(32)
    status, started = request_json("/api/pair/start", origin=origin, method="POST", payload={
        "mode": "browser-connection", "browser_token": browser_token,
    })
    if status != 200:
        fail("The automatic request-expiry smoke could not start a request")
    pairing_id = validate_browser_start(started)
    remaining = int(started["expires_in_seconds"]) + 1
    print(f"Waiting {remaining}s for the automatic connection request to expire.", flush=True)
    while remaining:
        step = min(5, remaining)
        time.sleep(step)
        remaining -= step
        if remaining and remaining % 30 == 1:
            print(f"Automatic request expiry: {remaining}s remaining.", flush=True)
    status, _ = request_json("/api/pair/complete", origin=origin, method="POST", payload=browser_completion_payload(pairing_id))
    if status != 403:
        fail("An expired automatic browser-connection request was accepted")
    if (data_root / "config" / "browser-approvals.json").exists():
        grants = json.loads((data_root / "config" / "browser-approvals.json").read_text(encoding="utf-8"))
        if hashlib.sha256(browser_token.encode("ascii")).hexdigest() in grants.get("grants", {}):
            fail("An expired automatic connection saved a browser grant")
    scan_secret_leaks(data_root, browser_token)


def exercise_browser_restoration(origin: str, data_root: Path, browser_token: str, previous_tokens: tuple[str, ...]) -> None:
    assert_browser_grants(data_root, origin, browser_token)
    for token in previous_tokens:
        assert_session_health(origin, token, valid=False)
    restored_tokens = []
    for _ in range(2):
        status, restored = request_json("/api/pair/restore", origin=origin, method="POST", payload={"browser_token": browser_token})
        if status != 200:
            fail("The remembered browser connection could not be restored after restart")
        restored_token = validate_browser_credential(restored)
        if restored_token in (*previous_tokens, *restored_tokens):
            fail("Browser restoration reused a session credential")
        restored_tokens.append(restored_token)
        assert_session_health(origin, restored_token, valid=True)
    # Foreign attempts must neither use nor erase the live grant.
    for path in ("/api/pair/restore", "/api/pair/forget"):
        status, _ = request_json(path, origin="https://wrong.example", method="POST", payload={"browser_token": browser_token})
        if status != 403:
            fail("A foreign origin could restore or revoke the remembered browser")
    for token in restored_tokens:
        assert_session_health(origin, token, valid=True)
    status, revoked = request_json("/api/pair/forget", origin=origin, method="POST", payload={"browser_token": browser_token})
    if status != 200 or revoked.get("revoked") is not True:
        fail("The remembered browser connection could not be revoked")
    for token in (*previous_tokens, *restored_tokens):
        assert_session_health(origin, token, valid=False)
    status, _ = request_json("/api/pair/restore", origin=origin, method="POST", payload={"browser_token": browser_token})
    if status != 401:
        fail("A revoked browser connection could still be restored")
    assert_browser_grants(data_root, origin, None)
    scan_secret_leaks(data_root, browser_token, *previous_tokens, *restored_tokens)


def exercise_port_collision(executable: Path, environment: dict[str, str]) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        occupied.bind(("127.0.0.1", 17863))
        occupied.listen(1)
        collision = start_process(executable, environment)
        try:
            if collision.wait(timeout=20) == 0:
                fail("The frozen engine silently accepted a fixed-port collision")
        finally:
            if collision.poll() is None:
                collision.kill()
                collision.wait(timeout=3)


def exercise_installer_target_foreign_port(
    executable: Path,
    environment: dict[str, str],
) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as occupied:
        occupied.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
        occupied.bind(("127.0.0.1", 17863))
        occupied.listen(1)
        finished = threading.Event()

        def answer_probe() -> None:
            try:
                connection, _address = occupied.accept()
                with connection:
                    connection.settimeout(2)
                    connection.recv(4096)
                    body = b'{"product_id":"another-product"}'
                    connection.sendall(
                        b"HTTP/1.1 200 OK\r\n"
                        b"Content-Type: application/json\r\n"
                        + f"Content-Length: {len(body)}\r\n".encode("ascii")
                        + b"Connection: close\r\n\r\n"
                        + body
                    )
            finally:
                finished.set()

        worker = threading.Thread(target=answer_probe, name="foreign-port-probe", daemon=True)
        worker.start()
        exercise_installer_target_preflight(
            executable,
            environment,
            expected_port_status="blocked",
        )
        if not finished.wait(timeout=3):
            fail("The installer target preflight did not inspect the foreign listener")
        worker.join(timeout=1)


def exercise_startup_stop_race(executable: Path, environment: dict[str, str]) -> None:
    engine = start_process(executable, environment)
    stopper = start_process(executable, environment, "--stop")
    try:
        if stopper.wait(timeout=15) != 0:
            fail("The --stop command lost the engine-startup race")
        if engine.wait(timeout=20) != 0:
            fail("The engine did not exit cleanly during the startup-stop race")
        if listener_rows():
            fail("The startup-stop race left the fixed port open")
    finally:
        for process in (stopper, engine):
            if process.poll() is None:
                process.kill()
                process.wait(timeout=3)


def start_and_probe(executable: Path, environment: dict[str, str], origin: str) -> subprocess.Popen[bytes]:
    engine = start_process(executable, environment)
    try:
        probe = wait_for_probe(origin)
        if probe.get("product_id") != "barorok-local-engine" or probe.get("api_contract_version") != 1:
            fail("The frozen probe contract is invalid")
        assert_loopback_listener(engine.pid)
        return engine
    except Exception:
        if engine.poll() is None:
            engine.kill()
        engine.wait(timeout=5)
        raise


def run() -> None:
    if os.name != "nt":
        fail("This verifier is Windows-only")
    arguments = parse_arguments()
    artifact = arguments.artifact.resolve()
    executable = artifact / "engine" / ENGINE_EXE_NAME
    if not executable.is_file():
        fail(f"Frozen engine executable not found: {executable}")
    manifest, install_snapshot = verify_manifest(artifact)
    if arguments.manifest_only:
        print("Frozen web local-engine closed manifest verification passed.")
        print(f"Engine version: {manifest['engineVersion']}")
        return
    if listener_rows():
        fail("The fixed engine port is already occupied; stop no existing installation for this smoke")
    origin = str(manifest["allowedOrigin"])
    install_handles: list[int] = []

    owned_temp_root = arguments.local_app_data is None
    if owned_temp_root:
        temp_parent = Path(__file__).resolve().parents[1] / ".codex-tmp"
        temp_parent.mkdir(exist_ok=True)
        local_app_data = Path(tempfile.mkdtemp(prefix="web-engine-stage3b-", dir=temp_parent))
    else:
        local_app_data = arguments.local_app_data.resolve()
        local_app_data.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    environment["LOCALAPPDATA"] = str(local_app_data)
    smoke_temp = local_app_data / "smoke-temp"
    smoke_temp.mkdir(parents=True, exist_ok=True)
    environment["TEMP"] = str(smoke_temp)
    environment["TMP"] = str(smoke_temp)
    data_root = local_app_data / "Barorok" / "LocalEngine"
    engine: subprocess.Popen[bytes] | None = None
    relocated = artifact.with_name(artifact.name + "-relocated-smoke")
    try:
        preflight = exercise_preflight_json(executable, environment)
        if data_root.exists():
            fail("The frozen preflight created local-engine user data")
        installer_preflight = exercise_installer_target_preflight(
            executable,
            environment,
            expected_port_status="pass",
        )
        if data_root.exists():
            fail("The frozen installer target preflight created local-engine user data")
        install_handles = lock_install_files_read_only(artifact)
        exercise_startup_stop_race(executable, environment)
        engine = start_and_probe(executable, environment, origin)
        running_installer_preflight = exercise_installer_target_preflight(
            executable,
            environment,
            expected_port_status="warning",
        )
        status, _body = request_json("/api/health", origin=origin)
        if status not in (401, 403):
            fail("The frozen engine exposed a protected API without a session")

        # Old shortcuts use --pair. It must now behave as an ordinary start
        # alias, returning without a numeric-code/helper window.
        second = start_process(executable, environment, "--pair")
        try:
            if second.wait(timeout=10) != 0 or engine.poll() is not None:
                fail("The packaged --pair start alias did not preserve the first engine")
        finally:
            if second.poll() is None:
                second.kill()
                second.wait(timeout=3)

        if arguments.verify_challenge_expiry:
            exercise_expired_browser_challenge(origin, data_root)
        browser_token, session_tokens = exercise_browser_connection(origin, data_root)
        sentinels = create_preservation_sentinels(data_root)
        stop_engine(executable, environment, engine)
        engine = None
        close_install_read_locks(install_handles)

        exercise_installer_target_foreign_port(executable, environment)
        exercise_port_collision(executable, environment)

        if relocated.exists():
            fail(f"Relocation smoke target already exists: {relocated}")
        rename_directory_with_retry(artifact, relocated)
        relocated_executable = relocated / "engine" / ENGINE_EXE_NAME
        try:
            engine = start_and_probe(relocated_executable, environment, origin)
            assert_sentinels(sentinels)
            exercise_browser_restoration(origin, data_root, browser_token, session_tokens)
            stop_engine(relocated_executable, environment, engine)
            engine = None
        finally:
            if engine is not None and engine.poll() is None:
                engine.kill()
                engine.wait(timeout=5)
                engine = None
            if relocated.exists():
                rename_directory_with_retry(relocated, artifact)

        assert_sentinels(sentinels)
        assert_install_tree_unchanged(artifact, install_snapshot)
        print("Frozen web local-engine Stage 3B smoke passed.")
        print(f"Engine version: {manifest['engineVersion']}")
        print(f"Preflight status: {preflight['overall_status']}")
        print(f"Installer preflight status: {installer_preflight['overall_status']}")
        print(f"Running-engine installer preflight status: {running_installer_preflight['overall_status']}")
        print(
            "Verified: host and installer-target preflight JSON, closed manifest, read-only payload, ffmpeg, "
            "loopback, default-deny, --pair start alias, automatic connection/replay/rate limit, "
            "restart session invalidation, browser restoration/revocation, no raw credentials, startup-safe stop, "
            "own/foreign fixed-port classification, port collision, relocation preservation"
        )
        print("Automatic request expiry: " + ("verified" if arguments.verify_challenge_expiry else "not exercised (use --verify-challenge-expiry)"))
        print("Session expiry: future expiry metadata checked; wall-clock session expiration not exercised.")
        print("Legacy numeric-code pairing and native installer execution are outside this smoke.")
    finally:
        if engine is not None and engine.poll() is None:
            engine.kill()
            engine.wait(timeout=5)
        if relocated.exists() and not artifact.exists():
            rename_directory_with_retry(relocated, artifact)
        if install_handles:
            close_install_read_locks(install_handles)
        if owned_temp_root and not arguments.keep_data and local_app_data.exists():
            shutil.rmtree(local_app_data)


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:
        print(f"Stage 3B smoke failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
