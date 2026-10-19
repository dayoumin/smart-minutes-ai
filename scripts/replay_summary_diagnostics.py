"""Opt-in local replay of a saved backend result; never runs STT or saves to outputs."""

import argparse
import hashlib
import io
import ipaddress
import json
import os
import re
from pathlib import Path
import subprocess
import sys
from datetime import datetime, timezone
import urllib.parse
import urllib.request
import uuid

REPO = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(REPO / "backend"))

from generation_gateway import prepared_ollama_runtime, generation_http_transport
from pipeline.summarize import summarize_meeting
from pipeline.transcript_display import get_transcript_segments


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def write_json(path: Path, value) -> None:
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2), encoding="utf-8")


def private_run_directory(parent: Path) -> Path:
    parent.mkdir(parents=True, exist_ok=True)
    run = parent / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:12])
    run.mkdir(mode=0o700)
    if os.name == "nt":
        # Python 3.12's mkdir mode does not restrict Windows ACLs. Apply the ACL
        # before writing any source, criteria, prompts or model responses.
        system32 = Path(os.environ["SystemRoot"]) / "System32"
        identity = subprocess.run([str(system32 / "whoami.exe"), "/user", "/fo", "csv", "/nh"],
                                  check=True, capture_output=True)
        # The account name can use a different code page than this Python.
        # Only the final ASCII SID field is needed to set the private ACL.
        match = re.search(rb'"(S-\d+(?:-\d+)+)"\s*$', identity.stdout)
        if match is None:
            raise RuntimeError("Could not resolve the current user's SID")
        sid = match[1].decode("ascii")
        subprocess.run([str(system32 / "icacls.exe"), str(run), "/inheritance:r", "/grant:r",
                        f"*{sid}:(OI)(CI)F", "*S-1-5-18:(OI)(CI)F"],
                       check=True, capture_output=True)
    return run


def local_base_url(value: str) -> str:
    parsed = urllib.parse.urlsplit(value)
    try:
        loopback = parsed.hostname == "localhost" or ipaddress.ip_address(parsed.hostname or "").is_loopback
    except ValueError:
        loopback = False
    if (parsed.scheme != "http" or not loopback or parsed.username or parsed.password
            or parsed.path not in ("", "/") or parsed.query or parsed.fragment):
        raise ValueError("Use an explicit HTTP loopback Ollama address, without credentials or a path")
    return f"http://{parsed.netloc}"


def local_opener():
    class NoRedirect(urllib.request.HTTPRedirectHandler):
        def redirect_request(self, *_args, **_kwargs):
            return None
    # Both metadata and private generation requests must bypass all environment
    # and Windows proxy settings, and may not follow redirects off loopback.
    return urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())


def runtime_identity(base: str, model: str) -> dict:
    def request(path, body=None):
        payload = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(base + path, data=payload, headers={"Content-Type": "application/json"})
        with local_opener().open(req, timeout=10) as response:
            return json.load(response)
    tags = request("/api/tags")
    expected = model if ":" in model else model + ":latest"
    entry = next((item for item in tags.get("models", []) if item.get("name") == expected), None)
    if not entry:
        raise ValueError("The requested model is not installed in this Ollama instance")
    show = request("/api/show", {"model": model})
    return {"base_url": base, "version": request("/api/version"), "model": entry,
            "parameters": show.get("parameters"), "model_info": show.get("model_info"),
            "loaded_models_before": request("/api/ps")}


def meeting_context(result: dict) -> dict:
    # Mirrors generate-summary's saved-result context; record the exact effective
    # value in the manifest so later baseline/candidate runs use the same input.
    return {
        "title": (result.get("summary") or {}).get("title", ""),
        "date": result.get("created_at", ""),
        "meeting_purpose": result.get("meeting_purpose", ""),
        "selected_report_template_id": result.get("selected_report_template_id", "standard-minutes"),
        "report_template": result.get("report_template", {}),
        "selected_context_template_id": result.get("selected_context_template_id", "general"),
        "context_template": result.get("context_template", {}),
        "selected_term_glossary_ids": result.get("selected_term_glossary_ids", []),
        "term_glossaries": result.get("term_glossaries", []),
    }


def replay(result_path: Path, criteria_path: Path, output_parent: Path, model: str,
           ollama_url: str, *, prepare_only: bool = False) -> Path:
    base = local_base_url(ollama_url)
    result_path, output_parent = result_path.resolve(), output_parent.resolve()
    if output_parent == result_path.parent or output_parent.is_relative_to(result_path.parent):
        raise ValueError("Diagnostics must be outside the original output directory")
    source = result_path.read_bytes()
    result = json.loads(source)
    if not isinstance(result, dict) or not isinstance(result.get("job_id"), str) or not result["job_id"]:
        raise ValueError("A backend result with job_id is required, not a frontend MeetingRecord")
    segments = get_transcript_segments(result)
    if not segments:
        raise ValueError("The saved backend result has no transcript segments")
    criteria_bytes = criteria_path.read_bytes()
    criteria = json.loads(criteria_bytes)
    if not isinstance(criteria, dict) or not criteria.get("required_topics") or not criteria.get("decision_rule") or not criteria.get("attribution_rule"):
        raise ValueError("Freeze manual topic, decision and attribution criteria before model generation")
    if criteria.get("source_sha256") and criteria["source_sha256"] != digest(source):
        raise ValueError("The manual criteria belong to a different source result")
    positions = {item.get("position") for item in criteria["required_topics"] if isinstance(item, dict)}
    if not {"beginning", "middle", "end"}.issubset(positions):
        raise ValueError("Manual criteria must cover beginning, middle and end")
    run = private_run_directory(output_parent)
    (run / "source-result.json").write_bytes(source)
    (run / "criteria.json").write_bytes(criteria_bytes)
    context = meeting_context(result)
    manifest = {
        "status": "prepared", "source_path": str(result_path), "source_sha256": digest(source),
        "job_id": result["job_id"], "source_directory": str(result_path.parent),
        "criteria_sha256": digest(criteria_bytes), "model": model, "ollama_url": base,
        "python": sys.executable, "python_version": sys.version, "meeting_context": context,
        "segments_sha256": digest(json.dumps(segments, ensure_ascii=False, sort_keys=True).encode()),
        "segment_count": len(segments),
        "source_code_sha256": {p: digest((REPO / p).read_bytes()) for p in (
            "backend/pipeline/summarize.py", "backend/pipeline/summary_evidence.py",
            "backend/generation_gateway.py", "scripts/replay_summary_diagnostics.py")},
        "semantic_quality": "not_evaluated", "inference_executed": False,
    }
    write_json(run / "manifest.json", manifest)
    write_json(run / "final-summary.json", None)
    # These are diagnostic inputs, not app logs; the caller opts in explicitly.
    with (run / "events.jsonl").open("x", encoding="utf-8") as events:
        request_context = {}
        def record(event):
            if event.get("event") == "request":
                request_context.update(stage=event["stage"], attempt=event["attempt"])
            events.write(json.dumps({"time_utc": datetime.now(timezone.utc).isoformat(), **event}, ensure_ascii=False) + "\n")
            events.flush()
        def open_generation(request, timeout):
            # Record actual provider token counts and stop reason. Character
            # budgets alone cannot establish whether a model context was full.
            with local_opener().open(request, timeout=timeout) as response:
                body = response.read()
            data = json.loads(body)
            if isinstance(data, dict):
                keys = ("model", "done", "done_reason", "prompt_eval_count", "eval_count", "total_duration",
                        "load_duration", "prompt_eval_duration", "eval_duration")
                record({"event": "provider_metadata", **request_context,
                        "metadata": {key: data[key] for key in keys if key in data}})
            return io.BytesIO(body)
        try:
            if not prepare_only:
                manifest["runtime"] = runtime_identity(base, model)
                write_json(run / "manifest.json", manifest)
                # Pin both possible runtime routes, and bypass automatic server
                # startup/CLI fallback. Never start/stop an operational engine.
                previous = {key: os.environ.get(key) for key in ("OLLAMA_HOST", "LMO_EMBEDDED_OLLAMA_HOST")}
                try:
                    for key in previous:
                        os.environ[key] = urllib.parse.urlsplit(base).netloc
                    manifest["inference_executed"] = True
                    with prepared_ollama_runtime(model), generation_http_transport(open_generation):
                        summary = summarize_meeting(segments, model, meeting_context=context, diagnostic_callback=record)
                finally:
                    for key, value in previous.items():
                        if value is None:
                            os.environ.pop(key, None)
                        else:
                            os.environ[key] = value
                write_json(run / "final-summary.json", summary)
                manifest["status"] = "generation_failed" if "generation_error" in summary else "generated_unreviewed"
        except Exception as error:
            manifest["status"] = "failed"
            manifest["error_type"] = type(error).__name__
            raise
        finally:
            manifest["source_unchanged"] = digest(result_path.read_bytes()) == manifest["source_sha256"]
            write_json(run / "manifest.json", manifest)
    return run


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--result", type=Path, required=True)
    parser.add_argument("--criteria", type=Path, required=True)
    parser.add_argument("--output-parent", type=Path, required=True)
    parser.add_argument("--model", required=True)
    parser.add_argument("--ollama-url", required=True)
    parser.add_argument("--prepare-only", action="store_true")
    args = parser.parse_args()
    print(replay(args.result, args.criteria, args.output_parent, args.model, args.ollama_url, prepare_only=args.prepare_only))
