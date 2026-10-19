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
from ollama_utils import stop_embedded_ollama_server
from web_local_engine_runtime import (
    WindowsNamedEvent,
    WindowsNamedMutex,
    apply_web_local_engine_environment,
    approve_browser_connection,
    build_web_local_engine_environment,
    engine_stop_event_name,
    load_web_local_engine_settings,
    make_pairing_code_presenter,
    pairing_helper_is_armed,
    pairing_mutex_name,
    prepare_web_local_engine_data,
    resolve_web_local_engine_layout,
    signal_engine_stop,
    validate_production_web_origin,
    windows_named_mutex_exists,
)


LOCAL_ENGINE_PORT = 17863
LOCAL_ENGINE_GRACEFUL_SHUTDOWN_SECONDS = 5


def _create_server(app) -> uvicorn.Server:
    return uvicorn.Server(uvicorn.Config(
        app=app,
        host="127.0.0.1",
        port=LOCAL_ENGINE_PORT,
        reload=False,
        log_level="info",
        log_config=None,
        timeout_graceful_shutdown=LOCAL_ENGINE_GRACEFUL_SHUTDOWN_SECONDS,
    ))


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
        # Signal acknowledgement only; installers also probe the mutex and port.
        return 0 if signal_engine_stop(layout) else 3
    origin, engine_version = _resolve_startup_settings(
        layout,
        args,
        frozen=frozen,
    )

    # --pair remains an alias for older installed shortcuts. Starting the engine
    # is sufficient: the configured web app connects without a code or dialog.
    default_config = args.default_config or str(layout.defaults_dir / "config.json")
    prepare_web_local_engine_data(layout, default_config_path=default_config)
    # Windows app virtualization can resolve a newly created data root differently.
    # Derive runtime paths and helper identities from the now-existing directory.
    layout = _resolve_startup_layout(args, frozen=frozen)
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
        from main import LOCAL_ENGINE_PAIRING, LOCAL_ENGINE_BROWSER_APPROVAL, app

        if stop_event.wait(timeout_seconds=0):
            return 0

        try:
            LOCAL_ENGINE_BROWSER_APPROVAL.configure(
                layout.config_dir / "browser-approvals.json", origin, approve_browser_connection,
            )
        except (OSError, ValueError):
            logging.error("Saved browser approvals could not be loaded")

        LOCAL_ENGINE_PAIRING.code_presenter = make_pairing_code_presenter(
            layout,
            origin=origin,
        )
        LOCAL_ENGINE_PAIRING.availability_check = lambda: pairing_helper_is_armed(
            layout,
            origin=origin,
        )
        server = _create_server(app)

        def wait_for_stop() -> None:
            if stop_event.wait():
                logging.info("Local-engine stop requested; waiting for server shutdown")
                server.should_exit = True

        stop_watcher = threading.Thread(
            target=wait_for_stop,
            name="barorok-local-engine-stop",
            daemon=True,
        )
        stop_watcher.start()
        logging.info("Starting Barorok local engine on loopback port %s", LOCAL_ENGINE_PORT)
        server.run()
        logging.info("Local-engine server shutdown completed")
        return 0
    finally:
        try:
            stop_event.signal()
            if stop_watcher is not None:
                stop_watcher.join(timeout=2)
        finally:
            try:
                stop_embedded_ollama_server()
            finally:
                stop_event.close()
                mutex.release()


if __name__ == "__main__":
    raise SystemExit(main())
