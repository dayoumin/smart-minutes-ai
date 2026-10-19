"""Opt-in advisory review of selected saved partials; no extraction, merge or edits.

Run on the same explicit loopback model as the saved replay. Diagnostic output is
restricted to ignored .tmp directories with user/SYSTEM-only Windows ACLs.
"""

import argparse
from datetime import datetime, timezone
import json
from pathlib import Path
import subprocess
import sys
import urllib.request

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO))
sys.path.insert(0, str(REPO / "backend"))

from pipeline.summary_review import build_probes, validate_verdict
from scripts.replay_summary_diagnostics import digest, local_base_url, local_opener, private_run_directory, runtime_identity, write_json


def review_saved(run_path, output_parent, stages, note_ids, model, ollama_url, *, max_calls=32, prepare_only=False, schedule_mode="legacy"):
    base = local_base_url(ollama_url)
    run_path, output_parent = Path(run_path).resolve(), Path(output_parent).resolve()
    if (not output_parent.is_relative_to((REPO / ".tmp").resolve())
            or output_parent == run_path or output_parent.is_relative_to(run_path)):
        raise ValueError("Use a separate ignored project .tmp directory")
    ignored = subprocess.run(["git", "-c", "core.excludesFile=", "check-ignore", "-q", "--",
                              str(output_parent / "review-private-probe")], cwd=REPO, capture_output=True)
    if ignored.returncode != 0:
        raise ValueError("Diagnostic output must be ignored by Git")
    inputs = {name: (run_path / name).read_bytes() for name in
              ("manifest.json", "events.jsonl", "source-result.json", "final-summary.json")}
    original = json.loads(inputs["manifest.json"])
    if digest(inputs["source-result.json"]) != original["source_sha256"] or original["model"] != model:
        raise ValueError("Source hash/model does not match the saved replay")
    probes = build_probes([json.loads(line) for line in inputs["events.jsonl"].decode("utf-8").splitlines()], stages, note_ids, schedule_mode=schedule_mode)
    if not 1 <= max_calls <= 64 or not probes or len(probes) > max_calls:
        raise ValueError("Review exceeds the call budget; select fewer stages/notes before running")
    run = private_run_directory(output_parent)
    manifest = {
        "status": "prepared", "scope": "selected_saved_partials_advisory_only", "source_run": str(run_path),
        "source_sha256": original["source_sha256"], "job_id": original["job_id"],
        "input_sha256": {name: digest(data) for name, data in inputs.items()},
        "source_code_sha256": {name: digest((REPO / name).read_bytes()) for name in
                               ("backend/pipeline/summary_review.py", "scripts/review_summary_diagnostics.py",
                                "scripts/replay_summary_diagnostics.py")},
        "model": model, "ollama_url": base, "python": sys.executable, "python_version": sys.version,
        "selected_stages": stages, "selected_note_ids": note_ids, "probe_ids": [probe["id"] for probe in probes],
        "schedule_mode": schedule_mode,
        "planned_calls": len(probes), "max_calls": max_calls, "new_model_calls": 0,
        "reused_partial_responses": len(stages), "summary_rewritten": False, "semantic_quality": "not_evaluated",
    }
    outcomes = []
    write_json(run / "manifest.json", manifest)
    write_json(run / "final-summary.json", {"advisory_only": True, "summary_rewritten": False, "results": outcomes})
    with (run / "events.jsonl").open("x", encoding="utf-8") as log:
        def record(event, **values):
            log.write(json.dumps({"time_utc": datetime.now(timezone.utc).isoformat(), "event": event, **values}, ensure_ascii=False) + "\n")
            log.flush()
        try:
            if not prepare_only:
                runtime = runtime_identity(base, model)
                previous_digest = original.get("runtime", {}).get("model", {}).get("digest")
                if not previous_digest or runtime["model"]["digest"] != previous_digest:
                    raise ValueError("Same model digest is required for this saved-partial comparison")
                manifest["runtime"] = runtime
                for probe in probes:
                    record("request", probe=probe)
                    request = urllib.request.Request(base + "/api/generate", data=json.dumps({
                        "model": model, "prompt": probe["prompt"], "format": probe["schema"], "stream": False,
                    }).encode("utf-8"), headers={"Content-Type": "application/json"})
                    manifest["new_model_calls"] += 1
                    with local_opener().open(request, timeout=600) as response:
                        body = response.read()
                    # Preserve the full provider response before parsing either JSON layer.
                    record("raw_response", probe_id=probe["id"], body=body.decode("utf-8", errors="replace"))
                    provider = json.loads(body)
                    record("provider_metadata", probe_id=probe["id"], metadata={key: provider.get(key) for key in
                           ("model", "done", "done_reason", "prompt_eval_count", "eval_count", "total_duration")})
                    try:
                        if provider.get("done") is not True or provider.get("done_reason") != "stop":
                            raise ValueError("Incomplete model response")
                        value = validate_verdict(probe, json.loads(provider["response"]))
                        outcome = {"probe_id": probe["id"], "status": "advisory_unreviewed", "verdict": value}
                    except (ValueError, KeyError, TypeError):
                        outcome = {"probe_id": probe["id"], "status": "invalid_response"}
                    outcomes.append(outcome)
                    record("advisory_result", **outcome)
                manifest["status"] = "completed_advisory" if all(outcome["status"] == "advisory_unreviewed" for outcome in outcomes) else "invalid_review_response"
                # This snapshot records the actual loaded context; text length is
                # never used to infer token/context headroom.
                with local_opener().open(base + "/api/ps", timeout=10) as response:
                    manifest["loaded_models_after"] = json.load(response)
        except Exception as error:
            manifest["status"] = "failed"
            manifest["error_type"] = type(error).__name__
            raise
        finally:
            manifest["saved_inputs_unchanged"] = all((run_path / name).read_bytes() == data for name, data in inputs.items())
            write_json(run / "final-summary.json", {"advisory_only": True, "summary_rewritten": False, "results": outcomes})
            write_json(run / "manifest.json", manifest)
    return run


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--run", type=Path, required=True)
    parser.add_argument("--output-parent", type=Path, required=True)
    parser.add_argument("--stage", action="append", required=True)
    parser.add_argument("--note-id", action="append", default=[])
    parser.add_argument("--model", required=True)
    parser.add_argument("--ollama-url", required=True)
    parser.add_argument("--max-calls", type=int, default=32)
    parser.add_argument("--prepare-only", action="store_true")
    parser.add_argument("--schedule-mode", choices=("legacy", "state"), default="legacy",
                        help="Advisory only; state is experimental and never applies corrections")
    args = parser.parse_args()
    print(review_saved(args.run, args.output_parent, args.stage, args.note_id, args.model, args.ollama_url,
                       max_calls=args.max_calls, prepare_only=args.prepare_only, schedule_mode=args.schedule_mode))
