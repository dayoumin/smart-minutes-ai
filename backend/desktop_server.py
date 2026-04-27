import os

import uvicorn

from main import app


def main() -> None:
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
