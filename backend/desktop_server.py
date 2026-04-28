import os
import sys

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


def main() -> None:
    ensure_standard_streams()
    os.environ.setdefault("ANALYSIS_MODE", "real")
    uvicorn.run(
        app,
        host="127.0.0.1",
        port=8000,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
