import os

import uvicorn


def main() -> None:
    os.environ.setdefault("ANALYSIS_MODE", "real")
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8000,
        reload=False,
        log_level="info",
    )


if __name__ == "__main__":
    main()
