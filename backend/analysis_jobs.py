from __future__ import annotations

import threading


class AnalysisCancelledError(RuntimeError):
    pass


class AnalysisJobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, threading.Event] = {}
        self._lock = threading.Lock()

    def create(self, job_id: str) -> threading.Event:
        cancel_event = threading.Event()
        with self._lock:
            if job_id in self._jobs:
                raise ValueError(f"Analysis job already exists: {job_id}")
            self._jobs[job_id] = cancel_event
        return cancel_event

    def cancel(self, job_id: str) -> bool:
        with self._lock:
            cancel_event = self._jobs.get(job_id)
        if not cancel_event:
            return False
        cancel_event.set()
        return True

    def remove(self, job_id: str, cancel_event: threading.Event | None = None) -> None:
        with self._lock:
            if cancel_event is not None and self._jobs.get(job_id) is not cancel_event:
                return
            self._jobs.pop(job_id, None)
