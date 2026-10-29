"""A separately owned download process lets Stop close an in-flight request."""

import argparse
import traceback


def main(argv=None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--repo", required=True)
    parser.add_argument("--target", required=True)
    parser.add_argument("--error-file")
    args = parser.parse_args(argv)
    try:
        from huggingface_hub import snapshot_download

        snapshot_download(repo_id=args.repo, local_dir=args.target)
    except Exception:
        # Windowed frozen Python must not send an unhandled exception to the
        # bootloader's modal error dialog. The parent owns this diagnostic file.
        if args.error_file:
            from pathlib import Path
            try:
                Path(args.error_file).write_text(traceback.format_exc(), encoding="utf-8")
            except OSError:
                pass
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
