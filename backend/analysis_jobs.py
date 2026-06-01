from __future__ import annotations

import threading


class AnalysisCancelledError(RuntimeError):
    pass


class AnalysisJobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, dict[str, object]] = {}
        self._lock = threading.Lock()

    def create(self, job_id: str) -> threading.Event:
        cancel_event = threading.Event()
        with self._lock:
            if job_id in self._jobs:
                raise ValueError(f"Analysis job already exists: {job_id}")
            self._jobs[job_id] = {"event": cancel_event, "action": None}
        return cancel_event

    def cancel(self, job_id: str, action: str = "stop") -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            cancel_event = job.get("event") if job else None
            if job:
                job["action"] = action
        if not cancel_event:
            return False
        if not isinstance(cancel_event, threading.Event):
            return False
        cancel_event.set()
        return True

    def get_action(self, job_id: str) -> str | None:
        with self._lock:
            job = self._jobs.get(job_id)
            action = job.get("action") if job else None
        return action if isinstance(action, str) else None

    def remove(self, job_id: str, cancel_event: threading.Event | None = None) -> None:
        with self._lock:
            job = self._jobs.get(job_id)
            if cancel_event is not None and (not job or job.get("event") is not cancel_event):
                return
            self._jobs.pop(job_id, None)

    def has(self, job_id: str) -> bool:
        with self._lock:
            return job_id in self._jobs
