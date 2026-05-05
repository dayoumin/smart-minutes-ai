import os
import sys
import logging
import traceback

import uvicorn

from main import app

_NULL_STREAMS = []


def ensure_standard_streams() -> None:
    for name, mode in (("stdin", "r"), ("stdout", "w"), ("stderr", "w")):
        if getattr(sys, name, None) is not None:
            continue

        stream = open(os.devnull, mode, encoding="utf-8")
        _NULL_STREAMS.append(stream)
        setattr(sys, name, stream)


def configure_file_logging() -> str:
    backend_dir = os.environ.get("MEETING_AI_BACKEND_DIR") or os.getcwd()
    app_dir = os.path.abspath(os.path.join(backend_dir, os.pardir))
    log_dir = os.path.join(app_dir, "logs")
    os.makedirs(log_dir, exist_ok=True)
    log_path = os.path.join(log_dir, "analysis.log")
    logging.basicConfig(
        filename=log_path,
        level=logging.INFO,
        format="%(asctime)s %(levelname)s %(name)s: %(message)s",
        encoding="utf-8",
    )
    return log_path


def main() -> None:
    ensure_standard_streams()
    log_path = configure_file_logging()
    os.environ.setdefault("ANALYSIS_MODE", "real")
    port = int(os.environ.get("PORT", "17863"))
    logging.info("Starting Smart Minutes AI analysis service on 127.0.0.1:%s", port)
    try:
        uvicorn.run(
            app,
            host="127.0.0.1",
            port=port,
            reload=False,
            log_level="info",
            log_config=None,
        )
    except Exception:
        with open(log_path, "a", encoding="utf-8") as log_file:
            log_file.write("\nFatal analysis service error:\n")
            log_file.write(traceback.format_exc())
        raise


if __name__ == "__main__":
    main()
