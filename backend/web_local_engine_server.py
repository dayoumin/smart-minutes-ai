from __future__ import annotations

import argparse
import logging
import os
import sys
import tempfile
import threading
from pathlib import Path
from typing import Mapping

import uvicorn

from local_engine_preflight import (
    InstallerTargetPaths,
    collect_installer_target_preflight,
    collect_windows_preflight,
    inspect_fixed_port,
    read_installer_preflight_request,
    write_preflight_json,
)
from local_engine_security import PRODUCT_ID
from web_local_engine_runtime import (
    PAIRING_ARM_TTL_SECONDS,
    WindowsNamedEvent,
    WindowsNamedMutex,
    apply_web_local_engine_environment,
    arm_pairing_helper,
    build_web_local_engine_environment,
    engine_stop_event_name,
    load_web_local_engine_settings,
    make_pairing_code_presenter,
    pairing_helper_is_armed,
    pairing_mutex_name,
    prepare_web_local_engine_data,
    resolve_web_local_engine_layout,
    signal_engine_stop,
    show_windows_message,
    validate_production_web_origin,
    windows_named_mutex_exists,
)


LOCAL_ENGINE_PORT = 17863


def _default_install_root() -> Path:
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent.parent
    return Path(__file__).resolve().parent.parent


def _configure_logging(log_path: Path) -> None:
    log_path.parent.mkdir(parents=True, exist_ok=True)
    logging.basicConfig(
        filename=log_path,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        encoding="utf-8",
    )


def _arguments(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Barorok Windows local engine")
    parser.add_argument("--origin", default=None)
    parser.add_argument("--engine-version", default=None)
    parser.add_argument("--install-root", default=str(_default_install_root()))
    parser.add_argument("--data-root", default=None)
    parser.add_argument("--default-config", default=None)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument("--pair", action="store_true")
    mode.add_argument("--stop", action="store_true")
    mode.add_argument("--preflight-json", metavar="OUTPUT_PATH")
    mode.add_argument(
        "--installer-target-preflight-json",
        nargs=2,
        metavar=("REQUEST_PATH", "OUTPUT_PATH"),
    )
    return parser.parse_args(argv)


def _resolve_startup_settings(
    layout,
    args: argparse.Namespace,
    *,
    frozen: bool,
    environment: Mapping[str, str] = os.environ,
) -> tuple[str, str]:
    if frozen:
        return load_web_local_engine_settings(layout)
    configured_origin = args.origin or environment.get("LMO_WEB_ALLOWED_ORIGINS")
    configured_version = args.engine_version or environment.get("LMO_ENGINE_VERSION")
    if configured_origin and configured_version:
        return validate_production_web_origin(configured_origin), configured_version
    file_origin, file_version = load_web_local_engine_settings(layout)
    return (
        validate_production_web_origin(configured_origin or file_origin),
        configured_version or file_version,
    )


def _resolve_startup_layout(
    args: argparse.Namespace,
    *,
    frozen: bool,
    default_install_root: str | None = None,
):
    resolved_default_install_root = default_install_root or str(_default_install_root())
    if frozen and (
        args.install_root != resolved_default_install_root
        or args.data_root is not None
        or args.default_config is not None
    ):
        raise ValueError("Packaged local-engine paths cannot be overridden")
    return resolve_web_local_engine_layout(
        install_root=resolved_default_install_root if frozen else args.install_root,
        data_root=None if frozen else args.data_root,
    )


def main(argv: list[str] | None = None) -> int:
    args = _arguments(argv)
    frozen = bool(getattr(sys, "frozen", False))
    if args.preflight_json:
        try:
            payload = collect_windows_preflight()
            write_preflight_json(args.preflight_json, payload)
        except (OSError, ValueError):
            return 2
        return 0
    if args.installer_target_preflight_json:
        request_path, output_path = args.installer_target_preflight_json
        try:
            request_generation, requirements = read_installer_preflight_request(request_path)
            layout = resolve_web_local_engine_layout()
            paths = InstallerTargetPaths(
                install=layout.install_root,
                staging=Path(tempfile.gettempdir()).resolve(),
                models=layout.models_dir,
                analysis_temp=layout.temp_dir,
                results=layout.results_dir,
                write_targets=(layout.install_root, layout.data_root),
            )
            payload = collect_installer_target_preflight(
                paths,
                requirements,
                request_generation=request_generation,
                port_reader=lambda: inspect_fixed_port(
                    port=LOCAL_ENGINE_PORT,
                    expected_product_id=PRODUCT_ID,
                    own_engine_marker=lambda: windows_named_mutex_exists(
                        pairing_mutex_name(layout)
                    ),
                ),
            )
            write_preflight_json(output_path, payload)
        except (OSError, RuntimeError, ValueError):
            return 2
        return 0
    layout = _resolve_startup_layout(args, frozen=frozen)
    if args.stop:
        return 0 if signal_engine_stop(layout) else 3
    origin, engine_version = _resolve_startup_settings(
        layout,
        args,
        frozen=frozen,
    )

    if args.pair:
        layout.runtime_dir.mkdir(parents=True, exist_ok=True)
        if not windows_named_mutex_exists(pairing_mutex_name(layout)):
            show_windows_message(
                "바로록 연결",
                "로컬 엔진이 실행 중이지 않습니다. 로컬 엔진을 먼저 실행한 뒤 다시 시도해 주세요.",
            )
            return 3
        arm_pairing_helper(layout, origin=origin)
        shown = show_windows_message(
            "바로록 연결 준비",
            f"{origin}\n\n웹 화면으로 돌아가 연결을 눌러주세요. "
            f"연결 준비는 {PAIRING_ARM_TTL_SECONDS // 60}분 동안만 유지됩니다.",
        )
        if not shown:
            layout.pairing_arm_path.unlink(missing_ok=True)
            return 2
        return 0

    default_config = args.default_config or str(layout.defaults_dir / "config.json")
    prepare_web_local_engine_data(layout, default_config_path=default_config)
    runtime_environment = build_web_local_engine_environment(
        layout,
        origin=origin,
        engine_version=engine_version,
    )
    apply_web_local_engine_environment(runtime_environment)
    _configure_logging(layout.logs_dir / "engine.log")

    mutex = WindowsNamedMutex(pairing_mutex_name(layout))
    if not mutex.acquire():
        return 0

    stop_event = WindowsNamedEvent(engine_stop_event_name(layout))
    stop_watcher: threading.Thread | None = None
    try:
        stop_event.create()
        from main import LOCAL_ENGINE_PAIRING, app

        if stop_event.wait(timeout_seconds=0):
            return 0

        LOCAL_ENGINE_PAIRING.code_presenter = make_pairing_code_presenter(
            layout,
            origin=origin,
        )
        LOCAL_ENGINE_PAIRING.availability_check = lambda: pairing_helper_is_armed(
            layout,
            origin=origin,
        )
        server = uvicorn.Server(uvicorn.Config(
            app=app,
            host="127.0.0.1",
            port=LOCAL_ENGINE_PORT,
            reload=False,
            log_level="info",
            log_config=None,
        ))

        def wait_for_stop() -> None:
            if stop_event.wait():
                server.should_exit = True

        stop_watcher = threading.Thread(
            target=wait_for_stop,
            name="barorok-local-engine-stop",
            daemon=True,
        )
        stop_watcher.start()
        logging.info("Starting Barorok local engine on loopback port %s", LOCAL_ENGINE_PORT)
        server.run()
        return 0
    finally:
        stop_event.signal()
        if stop_watcher is not None:
            stop_watcher.join(timeout=2)
        stop_event.close()
        mutex.release()


if __name__ == "__main__":
    raise SystemExit(main())
