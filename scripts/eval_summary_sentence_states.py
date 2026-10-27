"""Opt-in synthetic-only Ollama diagnostic; never writes meeting outputs or settings."""
import argparse
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import sys
import time
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
sys.path[:0] = [str(ROOT), str(ROOT / "backend")]
from scripts.replay_summary_diagnostics import local_opener, runtime_identity
from pipeline.summary_sentence_selection import (
    checked_role_prompt, checked_schema, decode_fact_labels, fact_check_prompt, normalize_checked_roles, parse_model_labels,
    normalize_selections, selection_prompt, selection_schema, sentence_windows, validate_checked, validate_states,
)

FIXTURE = ROOT / "tests/fixtures/summary-sentence-states-20261021.json"
BASE = "http://127.0.0.1:11434"
MODEL = "qwen3.5:4b"
TRACKED = [Path(__file__), ROOT / "backend/pipeline/summary_sentence_selection.py", FIXTURE]


def digest(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def dump(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def snapshot():
    return {str(p.relative_to(ROOT)): digest(p) for p in TRACKED}


def validate_case(case):
    ids = set(selection_schema(case["source"])["required"])
    if set(case["expected_states"]) - ids:
        raise ValueError("unknown_expected_id")
    for sid, allowed in case["expected_states"].items():
        if not allowed:
            raise ValueError("empty_expected_states")
        for state in allowed:
            validate_states({sid: state}, [s for s in case["source"] if s["id"] == sid])
    for kind in ("core", "constraints"):
        for group in case[kind]:
            if group["role"] not in ("problems", "goals", "conditions") or not group["any"] or set(group["any"]) - ids:
                raise ValueError("invalid_required_group")


def prepare(out, strategy="states"):
    fixture = json.loads(FIXTURE.read_text(encoding="utf-8"))
    if fixture.get("origin") != "newly_written_synthetic_only":
        raise ValueError("synthetic_only")
    if digest(ROOT / "tests/fixtures/summary-model-comparison-20261021.json") != fixture["baseline_fixture_sha256"]:
        raise ValueError("baseline_fixture_changed")
    if (out / "frozen.json").exists():
        raise ValueError("already_frozen")
    out.mkdir(parents=True, exist_ok=True)
    cases = {}
    for name, case in fixture["cases"].items():
        validate_case(case)
        windows = sentence_windows(case["source"])
        requests = []
        for w in windows:
            if strategy == "checked_roles":
                requests.extend([
                    {"stage": "roles", "source": w, "prompt": checked_role_prompt(w), "schema": checked_schema(w)},
                    {"stage": "facts", "source": w, "prompt": fact_check_prompt(w), "schema": checked_schema(w, fact_check=True)},
                ])
            else:
                requests.append({"stage": "states", "source": w, "prompt": selection_prompt(w), "schema": selection_schema(w)})
        cases[name] = {**case, "requests": requests}
    dump(out / "frozen.json", {"snapshot": snapshot(), "cases": cases, "strategy": strategy, "method_version": "20261021-J",
         "controls": {"num_ctx": 16384, "temperature": 0, "seed": 42, "num_predict": 2048},
         "gate": "No wrong observed problems, no missing true problems; core/constraints/state labels and quote retention scored separately. Conflicts do not count as correct classification."})
    print(json.dumps({"prepared": True, "calls": {n: len(c["requests"]) for n,c in cases.items()}}), flush=True)


def evaluate(case, predictions, result):
    labels = {s["id"]: s["states"] for s in result["sentences"]}
    expected = case["expected_states"]
    correct_problems = {sid for sid, states in expected.items() if states == ["observed_problem"]}
    raw_wrong = sorted({sid for row in predictions for sid,state in row.items()
                        if state == "observed_problem" and sid not in correct_problems})
    state_errors = [{"id": sid, "expected": allowed, "actual": labels[sid]}
                    for sid,allowed in expected.items()
                    if len(labels[sid]) != 1 or labels[sid][0] not in allowed]
    accepted_problems = {s["id"] for s in result["problems"]}
    missing_problems = sorted(sid for sid in correct_problems if sid not in accepted_problems or labels[sid] != ["observed_problem"])
    roles = {r: {s["id"] for s in result[r]} for r in ("problems", "goals", "conditions")}
    missing = {kind: [g for g in case[kind] if not roles[g["role"]].intersection(g["any"])]
               for kind in ("core", "constraints")}
    exact = [{k: s[k] for k in original} for s, original in zip(result["sentences"], case["source"])] == case["source"]
    preserved = exact and len(result["sentences"]) == len(case["source"])
    return {"core_retained": len(case["core"])-len(missing["core"]), "core_total": len(case["core"]),
            "constraints_retained": len(case["constraints"])-len(missing["constraints"]),
            "constraints_total": len(case["constraints"]), "missing_roles": missing,
            "wrong_observed_problem_ids": raw_wrong, "missing_observed_problem_ids": missing_problems,
            "state_errors": state_errors, "state_correct": len(expected)-len(state_errors), "state_total": len(expected),
            "conflict_ids": [s["id"] for s in result["needs_check"]],
            "all_source_quotes_preserved": preserved,
            "semantic_gate_passed": not raw_wrong and not missing_problems and not state_errors
                                    and not missing["core"] and not missing["constraints"]
                                    and not result["needs_check"] and preserved}


def replay(out, name):
    """Re-evaluate saved raw responses without changing the original run or making requests."""
    frozen = json.loads((out / "frozen.json").read_text(encoding="utf-8"))
    case = frozen["cases"][name]
    predictions, role_predictions = [], []
    for index, task in enumerate(case["requests"], 1):
        raw = json.loads((out / name / f"window-{index:02}.provider.json").read_text(encoding="utf-8"))
        if raw.get("done") is not True or raw.get("done_reason") != "stop" or raw.get("model") != MODEL:
            raise ValueError("incomplete_saved_response")
        value = parse_model_labels(raw["response"])
        if frozen.get("strategy", "states") == "checked_roles":
            if task["stage"] == "roles":
                role_predictions.append(validate_checked(value, task["source"]))
            else:
                enum = next(iter(task["schema"]["properties"].values()))["enum"]
                predictions.append(decode_fact_labels(value, task["source"]) if "실제결함" in enum
                                   else validate_checked(value, task["source"], fact_check=True))
        else:
            predictions.append(validate_states(value, task["source"]))
    result = (normalize_checked_roles(case["source"], role_predictions, predictions)
              if frozen.get("strategy", "states") == "checked_roles" else normalize_selections(case["source"], predictions))
    target = out / name / ("replay-" + digest(ROOT / "backend/pipeline/summary_sentence_selection.py")[:10]
                           + "-" + digest(Path(__file__))[:10])
    target.mkdir(exist_ok=False)
    dump(target / "selected.json", result)
    report = evaluate(case, predictions, result)
    dump(target / "evaluation.json", report)
    dump(target / "provenance.json", {"frozen_sha256": digest(out / "frozen.json"), "snapshot": snapshot(),
         "provider_files_sha256": {p.name: digest(p) for p in (out / name).glob("*.provider.json")}, "new_calls": 0})
    print(json.dumps({"replay": str(target), **{k: report[k] for k in ("core_retained", "core_total", "constraints_retained", "constraints_total", "conflict_ids", "semantic_gate_passed")}}))


def run(out, name):
    frozen = json.loads((out / "frozen.json").read_text(encoding="utf-8"))
    if snapshot() != frozen["snapshot"]:
        raise ValueError("frozen_source_changed")
    case = frozen["cases"][name]
    folder = out / name
    folder.mkdir(exist_ok=False)
    manifest = {"case": name, "model": MODEL, "started": datetime.now(timezone.utc).isoformat(),
                "status": "running", "calls": 0, "frozen_sha256": digest(out / "frozen.json")}
    started = time.monotonic()
    predictions = []
    role_predictions = []
    try:
        identity = runtime_identity(BASE, MODEL)
        if identity["model"].get("remote_model") or identity["model"].get("remote_host"):
            raise ValueError("remote_model_rejected")
        manifest["runtime"] = identity
        dump(folder / "manifest.json", manifest)
        opener = local_opener()
        for index, task in enumerate(case["requests"], 1):
            if index > 64:
                raise ValueError("diagnostic_call_limit")
            body = {"model": MODEL, "prompt": task["prompt"], "stream": False, "think": False,
                    "format": task["schema"], "options": frozen["controls"]}
            prefix = folder / f"window-{index:02}"
            dump(prefix.with_suffix(".request.json"), body)
            manifest["calls"] += 1
            dump(folder / "manifest.json", manifest)
            request = urllib.request.Request(BASE + "/api/generate", data=json.dumps(body, ensure_ascii=False).encode(),
                                             headers={"Content-Type": "application/json"}, method="POST")
            with opener.open(request, timeout=180) as response:
                raw = json.load(response)
            dump(prefix.with_suffix(".provider.json"), raw)
            if raw.get("model") != MODEL or raw.get("done") is not True or raw.get("done_reason") != "stop":
                raise ValueError("incomplete_response")
            value = parse_model_labels(raw["response"])
            if frozen["strategy"] == "checked_roles":
                is_facts = task["stage"] == "facts"
                value = decode_fact_labels(value, task["source"]) if is_facts else validate_checked(value, task["source"])
                (predictions if is_facts else role_predictions).append(value)
            else:
                predictions.append(validate_states(value, task["source"]))
            print(json.dumps({"case": name, "window": index, "status": "accepted"}), flush=True)
        result = (normalize_checked_roles(case["source"], role_predictions, predictions)
                  if frozen["strategy"] == "checked_roles" else normalize_selections(case["source"], predictions))
        dump(folder / "selected.json", result)
        evaluation = evaluate(case, predictions, result)
        dump(folder / "evaluation.json", evaluation)
        manifest["status"] = "evaluated"
        manifest["scores"] = {k: evaluation[k] for k in (
            "core_retained", "core_total", "constraints_retained", "constraints_total", "state_correct", "state_total",
            "wrong_observed_problem_ids", "missing_observed_problem_ids", "conflict_ids", "semantic_gate_passed")}
    except Exception as error:
        manifest["status"] = "failed"
        manifest["error_type"] = type(error).__name__
        manifest["error"] = str(error)[:200] if isinstance(error, ValueError) else "request_or_runtime_failed"
    finally:
        manifest["seconds"] = round(time.monotonic()-started, 3)
        manifest["snapshot_unchanged"] = snapshot() == frozen["snapshot"]
        dump(folder / "manifest.json", manifest)
        print(json.dumps({k:v for k,v in manifest.items() if k != "runtime"}, ensure_ascii=False), flush=True)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["prepare", "run", "replay"])
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--case", choices=["screen", "long", "heldout", "stress"])
    parser.add_argument("--strategy", choices=["states", "checked_roles"], default="states")
    args = parser.parse_args()
    if args.action == "prepare": prepare(args.out, args.strategy)
    elif args.case:
        (replay if args.action == "replay" else run)(args.out, args.case)
    else: parser.error("--case is required for run")
