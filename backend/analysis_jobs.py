from __future__ import annotations

import threading


class AnalysisCancelledError(RuntimeError):
    pass


class AnalysisJobRegistry:
    def __init__(self) -> None:
        self._jobs: dict[str, dict[str, object]] = {}
        self._lock = threading.Lock()

    def create(self, job_id: str, *, admission_pending: bool = False) -> threading.Event:
        cancel_event = threading.Event()
        with self._lock:
            if job_id in self._jobs:
                raise ValueError(f"Analysis job already exists: {job_id}")
            self._jobs[job_id] = {"event": cancel_event, "action": None, "admission_pending": admission_pending}
        return cancel_event

    def cancel(self, job_id: str, action: str = "stop") -> bool:
        return self.cancel_with_admission(job_id, action)[0]

    def cancel_with_admission(self, job_id: str, action: str = "stop") -> tuple[bool, bool]:
        """Accept cancellation and snapshot ownership before admission can be claimed."""
        with self._lock:
            job = self._jobs.get(job_id)
            cancel_event = job.get("event") if job else None
            if not job or not isinstance(cancel_event, threading.Event):
                return False, False
            job["action"] = action
            cancel_event.set()
            return True, bool(job.get("admission_pending"))

    def claim_admission(self, job_id: str, cancel_event: threading.Event) -> bool:
        with self._lock:
            job = self._jobs.get(job_id)
            if not job or job.get("event") is not cancel_event or job.get("action") or cancel_event.is_set():
                return False
            job["admission_pending"] = False
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

    def has_active(self) -> bool:
        """Admission, cancellation and cleanup still own the entry until remove()."""
        with self._lock:
            return bool(self._jobs)
