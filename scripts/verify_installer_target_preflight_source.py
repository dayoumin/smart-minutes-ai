from __future__ import annotations

import json
import os
import secrets
import shutil
import socket
import sys
import tempfile
import threading
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
BACKEND = ROOT / "backend"
sys.path.insert(0, str(BACKEND))

from web_local_engine_server import main as local_engine_main  # noqa: E402


CHECK_IDS = {
    "installer_install_space",
    "installer_staging_space",
    "installer_model_space",
    "installer_analysis_temp_space",
    "installer_results_space",
    "installer_local_app_data_write",
    "installer_local_app_data_cleanup",
    "installer_fixed_port",
}


def fail(message: str) -> None:
    raise RuntimeError(message)


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


def request_payload(generation: int) -> dict[str, object]:
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


def run_preflight(runtime_temp: Path, generation: int) -> tuple[dict[str, object], Path, Path]:
    nonce = secrets.token_hex(12)
    request_path = runtime_temp / f"installer-request-{nonce}.json"
    output_path = runtime_temp / f"installer-result-{nonce}.json"
    request_path.write_text(
        json.dumps(request_payload(generation), separators=(",", ":")),
        encoding="utf-8",
    )
    exit_code = local_engine_main([
        "--installer-target-preflight-json",
        str(request_path),
        str(output_path),
    ])
    if exit_code != 0 or not output_path.is_file():
        fail(f"Source installer target preflight failed with exit code {exit_code}")
    payload = json.loads(output_path.read_text(encoding="utf-8"))
    return payload, request_path, output_path


def validate_payload(
    payload: dict[str, object],
    *,
    expected_port_status: str,
    forbidden_paths: tuple[Path, ...],
) -> None:
    if payload.get("schema_version") != 1 or payload.get("preflight_kind") != "installer_target":
        fail("Source installer target preflight emitted an invalid scope")
    checks = payload.get("checks")
    if not isinstance(checks, list):
        fail("Source installer target preflight checks are missing")
    checks_by_id = {
        str(check.get("check_id")): check
        for check in checks
        if isinstance(check, dict)
    }
    if set(checks_by_id) != CHECK_IDS:
        fail("Source installer target preflight check set is invalid")
    if checks_by_id["installer_fixed_port"].get("status") != expected_port_status:
        fail("Source installer target preflight misclassified the fixed port")
    for check_id, check in checks_by_id.items():
        if check_id != "installer_fixed_port" and check.get("status") != "pass":
            fail(f"Source installer target preflight did not pass {check_id}")
    expected_overall = {
        "pass": "pass",
        "warning": "warning",
        "blocked": "blocked",
    }[expected_port_status]
    if payload.get("overall_status") != expected_overall:
        fail("Source installer target preflight overall status is inconsistent")
    payload_strings = [value.casefold() for value in json_string_values(payload)]
    if any(
        str(path).casefold() in value
        for path in forbidden_paths
        for value in payload_strings
    ):
        fail("Source installer target preflight exposed a private path")


def foreign_listener_smoke(runtime_temp: Path, forbidden_paths: tuple[Path, ...]) -> None:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        if os.name == "nt" and hasattr(socket, "SO_EXCLUSIVEADDRUSE"):
            listener.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        listener.bind(("127.0.0.1", 17863))
        listener.listen(1)
        finished = threading.Event()

        def answer() -> None:
            try:
                connection, _address = listener.accept()
                with connection:
                    connection.settimeout(2)
                    connection.recv(4096)
                    body = b'{"product_id":"foreign-service"}'
                    connection.sendall(
                        b"HTTP/1.1 200 OK\r\n"
                        b"Content-Type: application/json\r\n"
                        + f"Content-Length: {len(body)}\r\n".encode("ascii")
                        + b"Connection: close\r\n\r\n"
                        + body
                    )
            finally:
                finished.set()

        worker = threading.Thread(target=answer, name="source-foreign-port", daemon=True)
        worker.start()
        payload, request_path, output_path = run_preflight(runtime_temp, 2)
        try:
            validate_payload(
                payload,
                expected_port_status="blocked",
                forbidden_paths=forbidden_paths,
            )
        finally:
            request_path.unlink(missing_ok=True)
            output_path.unlink(missing_ok=True)
        if not finished.wait(timeout=3):
            fail("Source installer target preflight did not inspect the foreign listener")
        worker.join(timeout=1)


def run() -> None:
    if os.name != "nt":
        fail("This smoke test is Windows-only")
    temp_parent = ROOT / ".codex-tmp"
    temp_parent.mkdir(exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="installer-target-source-한글 공간-", dir=temp_parent))
    local_app_data = root / "Local App Data 한글"
    runtime_temp = root / "Temp 공간"
    local_app_data.mkdir()
    runtime_temp.mkdir()
    install_root = local_app_data / "Programs" / "Barorok" / "LocalEngine"
    data_root = local_app_data / "Barorok" / "LocalEngine"
    old_environment = {
        name: os.environ.get(name)
        for name in ("LOCALAPPDATA", "TEMP", "TMP")
    }
    try:
        os.environ["LOCALAPPDATA"] = str(local_app_data)
        os.environ["TEMP"] = str(runtime_temp)
        os.environ["TMP"] = str(runtime_temp)
        tempfile.tempdir = None
        payload, request_path, output_path = run_preflight(runtime_temp, 1)
        try:
            validate_payload(
                payload,
                expected_port_status="pass",
                forbidden_paths=(root, local_app_data, runtime_temp, install_root, data_root),
            )
            original = output_path.read_bytes()
            repeated = local_engine_main([
                "--installer-target-preflight-json",
                str(request_path),
                str(output_path),
            ])
            if repeated != 2 or output_path.read_bytes() != original:
                fail("Source installer target preflight overwrote an existing result")
        finally:
            request_path.unlink(missing_ok=True)
            output_path.unlink(missing_ok=True)
        if install_root.exists() or data_root.exists():
            fail("Source installer target preflight created a final target directory")
        if list(root.rglob(".barorok-preflight-*")):
            fail("Source installer target preflight left a canary behind")

        foreign_listener_smoke(
            runtime_temp,
            (root, local_app_data, runtime_temp, install_root, data_root),
        )
        if list(root.rglob(".barorok-preflight-*")):
            fail("Foreign-listener smoke left a canary behind")
        print("Windows source installer target preflight smoke passed.")
        print("Verified: canonical targets, aggregate space DTO, write/fsync/cleanup, free/foreign port, privacy, no overwrite.")
    finally:
        for name, value in old_environment.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value
        tempfile.tempdir = None
        if root.exists():
            shutil.rmtree(root)


if __name__ == "__main__":
    try:
        run()
    except Exception as exc:
        print(f"Installer target source smoke failed: {exc}", file=sys.stderr)
        raise SystemExit(1)
