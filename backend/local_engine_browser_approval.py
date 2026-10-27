"""Revocable exact-origin browser grants; bearer secrets are never saved by the engine."""
from __future__ import annotations

import hashlib
import hmac
import json
import os
from pathlib import Path
import re
import secrets
import stat
import threading
import time
from typing import Callable

from local_engine_security import (
    LOCAL_ENGINE_CAPABILITIES, LocalEngineSessionStore, PairingRateLimitError,
    PairingRejectedError, PairingUnavailableError, parse_exact_origins,
)

MAX_REMEMBERED_BROWSERS = 16


class BrowserApprovalDataError(ValueError):
    """Saved grants are invalid; recovery still requires local user consent."""


class BrowserApprovalCoordinator:
    def __init__(self, sessions: LocalEngineSessionStore, *, clock=time.time) -> None:
        self.sessions = sessions
        self.clock = clock
        self._lock = threading.RLock()
        self._path: Path | None = None
        self._origin = ""
        self._prompt: Callable[[str], bool] | None = None
        self._grants: dict[str, str] = {}
        self._pending: dict[str, tuple[str, float, str, str]] = {}
        self._dialog_open = False
        self._starts: list[float] = []

    @property
    def available(self) -> bool:
        return self._path is not None and self._prompt is not None

    @staticmethod
    def _file_identity(path: Path) -> tuple[int, int, int, int] | None:
        try:
            info = path.lstat()
        except FileNotFoundError:
            return None
        if (not stat.S_ISREG(info.st_mode)
                or getattr(info, "st_file_attributes", 0) & stat.FILE_ATTRIBUTE_REPARSE_POINT):
            raise ValueError("Browser approval file must be a regular file, not a link")
        return info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns

    @staticmethod
    def _load_grants(path: Path, origin: str, identity: tuple[int, int, int, int] | None) -> dict[str, str]:
        if identity is None:
            return {}
        if identity[2] > 65536:
            raise BrowserApprovalDataError("Browser approval file is too large")
        with path.open("rb") as stream:
            content = stream.read(65537)
        if len(content) > 65536:
            raise BrowserApprovalDataError("Browser approval file is too large")
        try:
            payload = json.loads(content.decode("utf-8"))
        except (ValueError, RecursionError) as exc:
            raise BrowserApprovalDataError("Invalid browser approval JSON") from exc
        if not isinstance(payload, dict) or payload.get("format") != 1:
            raise BrowserApprovalDataError("Invalid browser approval format")
        raw = payload.get("grants")
        if not isinstance(raw, dict) or len(raw) > MAX_REMEMBERED_BROWSERS:
            raise BrowserApprovalDataError("Invalid browser approval grants")
        for digest, grant_origin in raw.items():
            if not isinstance(digest, str) or not re.fullmatch(r"[a-f0-9]{64}", digest):
                raise BrowserApprovalDataError("Invalid browser approval digest")
            if grant_origin != origin:
                raise BrowserApprovalDataError("Browser approval origin changed")
        return raw

    def configure(
        self, path: Path, origin: str, prompt: Callable[[str], bool], *,
        recovery_prompt: Callable[[str], bool] | None = None,
    ) -> None:
        origin = parse_exact_origins(origin, include_development_defaults=False)[0]
        identity = self._file_identity(path)
        try:
            grants = self._load_grants(path, origin, identity)
        except BrowserApprovalDataError:
            if recovery_prompt is None or not recovery_prompt(origin):
                raise
            # A native dialog may stay open while the file is replaced. Never
            # move a different file or accept grants written during that time.
            if self._file_identity(path) != identity:
                raise ValueError("Browser approval file changed during recovery")
            backup = path.with_name(f"{path.name}.damaged-{secrets.token_hex(16)}")
            path.rename(backup)
            # Renaming preserves the entire original (including oversized data).
            # New grants are persisted only through the normal pairing flow.
            grants = {}
        with self._lock:
            self._path, self._origin, self._prompt, self._grants = path, origin, prompt, grants

    def _check_origin(self, origin: str) -> None:
        if not self.available:
            raise PairingUnavailableError("Native approval unavailable")
        if not hmac.compare_digest(origin, self._origin):
            raise PairingRejectedError("Browser origin is not allowed")

    @staticmethod
    def _digest(token: str) -> str:
        if not re.fullmatch(r"[A-Za-z0-9_-]{43}", token):
            raise PairingRejectedError("Invalid browser credential")
        return hashlib.sha256(token.encode("ascii")).hexdigest()

    def _persist(self, grants: dict[str, str]) -> None:
        if self._path is None or self._path.is_symlink():
            raise PairingUnavailableError("Browser approvals cannot be saved")
        self._path.parent.mkdir(parents=True, exist_ok=True)
        temporary = self._path.with_name(f".{self._path.name}.{secrets.token_hex(8)}.tmp")
        try:
            with os.fdopen(os.open(temporary, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600), "w", encoding="utf-8") as stream:
                json.dump({"format": 1, "grants": grants}, stream)
                stream.flush()
                os.fsync(stream.fileno())
            os.replace(temporary, self._path)
        finally:
            temporary.unlink(missing_ok=True)

    def start(self, origin: str, browser_token: str) -> dict:
        self._check_origin(origin)
        digest = self._digest(browser_token)
        now = self.clock()
        with self._lock:
            self._pending = {key: value for key, value in self._pending.items() if value[1] > now}
            self._starts = [stamp for stamp in self._starts if stamp > now - 60]
            if self._dialog_open or len(self._starts) >= 5:
                raise PairingRateLimitError("Native approval already pending")
            pairing_id = secrets.token_urlsafe(24)
            self._pending[pairing_id] = (origin, now + 120, "pending", digest)
            self._starts.append(now)
            self._dialog_open = True
            prompt = self._prompt

        def approve() -> None:
            accepted = False
            try:
                accepted = bool(prompt and prompt(origin))
            except Exception:
                accepted = False
            finally:
                with self._lock:
                    pending = self._pending.get(pairing_id)
                    if pending and pending[1] > self.clock():
                        self._pending[pairing_id] = (origin, pending[1], "approved" if accepted else "denied", digest)
                    self._dialog_open = False
        try:
            threading.Thread(target=approve, daemon=True, name="barorok-browser-approval").start()
        except RuntimeError as exc:
            with self._lock:
                self._pending.pop(pairing_id, None)
                self._dialog_open = False
            raise PairingUnavailableError("Native approval could not start") from exc
        return {"pairing_id": pairing_id, "expires_in_seconds": 120, "mode": "browser-connection"}

    def complete(self, pairing_id: str, origin: str) -> dict | None:
        self._check_origin(origin)
        with self._lock:
            pending = self._pending.get(pairing_id)
            if pending is None or pending[0] != origin or pending[1] <= self.clock():
                raise PairingRejectedError("Approval expired or unavailable")
            if pending[2] == "pending":
                return None
            self._pending.pop(pairing_id, None)
            if pending[2] != "approved":
                raise PairingRejectedError("Approval declined")
            digest = pending[3]
            self._remember(digest, origin)
            return self._issue(origin, digest)

    def _remember(self, digest: str, origin: str) -> None:
        # Called under _lock. JSON object order preserves least-recently-used order
        # across restarts without changing the existing on-disk format.
        updated = {key: value for key, value in self._grants.items() if key != digest}
        while len(updated) >= MAX_REMEMBERED_BROWSERS:
            del updated[next(iter(updated))]
        updated[digest] = origin
        self._persist(updated)
        self._grants = updated
        # This bounds remembered credentials, not live API sessions: reclaiming a
        # lost private-visit token must not interrupt another browser's active job.
        # Explicit revoke still invalidates every session for its browser digest.

    def _issue(self, origin: str, digest: str) -> dict:
        token, grant = self.sessions.issue(origin=origin, capabilities=LOCAL_ENGINE_CAPABILITIES, browser_id=digest)
        return {"session_token": token, "expires_at": grant.expires_at, "capabilities": sorted(grant.capabilities)}

    def restore(self, browser_token: str, origin: str) -> dict:
        self._check_origin(origin)
        digest = self._digest(browser_token)
        with self._lock:
            if self._grants.get(digest) != origin:
                raise PairingRejectedError("Browser approval no longer valid")
            if next(reversed(self._grants)) != digest:
                self._remember(digest, origin)
            return self._issue(origin, digest)

    def revoke(self, browser_token: str, origin: str) -> bool:
        self._check_origin(origin)
        digest = self._digest(browser_token)
        with self._lock:
            self._pending = {key: value for key, value in self._pending.items() if value[3] != digest}
            if self._grants.get(digest) != origin:
                self.sessions.revoke_browser(digest)
                return False
            updated = {key: value for key, value in self._grants.items() if key != digest}
            self._persist(updated)
            self._grants = updated
            self.sessions.revoke_browser(digest)
            return True
