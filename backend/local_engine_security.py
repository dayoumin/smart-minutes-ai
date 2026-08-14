from __future__ import annotations

import hashlib
import hmac
import os
import secrets
import threading
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Mapping
from urllib.parse import urlsplit

from starlette.responses import JSONResponse


PRODUCT_ID = "barorok-local-engine"
API_CONTRACT_VERSION = 1
DEFAULT_SESSION_TTL_SECONDS = 15 * 60
DESKTOP_ACTION_TOKEN_HEADER = "x-lmo-desktop-action-token"
PUBLIC_PROBE_ROUTE = ("GET", "/api/probe")
PUBLIC_PAIRING_ROUTES = frozenset({
    ("POST", "/api/pair/start"),
    ("POST", "/api/pair/complete"),
})
LOCAL_ENGINE_CAPABILITIES = frozenset({
    "analysis",
    "model-management",
    "meeting-storage",
    "export",
})
DEFAULT_ALLOWED_ORIGINS = (
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:5174",
    "http://127.0.0.1:5174",
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://tauri.localhost",
    "https://tauri.localhost",
    "tauri://localhost",
)


def parse_exact_origins(
    configured: str | None = None,
    *,
    include_development_defaults: bool = True,
) -> tuple[str, ...]:
    candidates = list(DEFAULT_ALLOWED_ORIGINS if include_development_defaults else ())
    if configured is None:
        configured = os.environ.get("LMO_WEB_ALLOWED_ORIGINS", "")
    candidates.extend(item.strip() for item in configured.split(",") if item.strip())

    normalized: list[str] = []
    for candidate in candidates:
        parts = urlsplit(candidate)
        if parts.scheme not in {"http", "https", "tauri"} or not parts.netloc:
            raise ValueError(f"Invalid allowed origin: {candidate}")
        if parts.path not in {"", "/"} or parts.query or parts.fragment or parts.username or parts.password:
            raise ValueError(f"Allowed origins must not contain paths or credentials: {candidate}")
        origin = f"{parts.scheme}://{parts.netloc}"
        if origin not in normalized:
            normalized.append(origin)
    return tuple(normalized)


def configured_exact_origins() -> tuple[str, ...]:
    runtime_profile = os.environ.get("LMO_RUNTIME_PROFILE", "development").strip().lower()
    include_development_defaults = runtime_profile not in {"production", "release"}
    origins = parse_exact_origins(include_development_defaults=include_development_defaults)
    if not include_development_defaults:
        insecure_origins = [origin for origin in origins if not origin.startswith("https://")]
        if insecure_origins:
            raise ValueError("Production web origins must use HTTPS")
    return origins


def api_auth_enforcement_enabled() -> bool:
    return os.environ.get("LMO_API_AUTH_ENFORCEMENT", "").strip().lower() in {
        "1",
        "true",
        "on",
        "enabled",
    }


def build_probe_payload(*, pairing_available: bool) -> dict:
    return {
        "product_id": PRODUCT_ID,
        "engine_version": os.environ.get("LMO_ENGINE_VERSION", "0.0.0-dev").strip() or "0.0.0-dev",
        "api_contract_version": API_CONTRACT_VERSION,
        "capabilities": sorted(LOCAL_ENGINE_CAPABILITIES),
        "auth_state": "pairing-required",
        "pairing_available": bool(pairing_available),
        "update_required": False,
    }


@dataclass(frozen=True)
class SessionGrant:
    origin: str
    capabilities: frozenset[str]
    expires_at: float


class LocalEngineSessionStore:
    def __init__(self, *, ttl_seconds: int = DEFAULT_SESSION_TTL_SECONDS) -> None:
        if ttl_seconds <= 0:
            raise ValueError("Session TTL must be positive")
        self._ttl_seconds = ttl_seconds
        self._grants: dict[str, SessionGrant] = {}
        self._lock = threading.RLock()

    @staticmethod
    def _token_digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def issue(
        self,
        *,
        origin: str,
        capabilities: Iterable[str],
        now: float | None = None,
    ) -> tuple[str, SessionGrant]:
        normalized_origin = parse_exact_origins(origin, include_development_defaults=False)[0]
        issued_at = time.time() if now is None else now
        token = secrets.token_urlsafe(32)
        grant = SessionGrant(
            origin=normalized_origin,
            capabilities=frozenset(
                str(item) for item in capabilities if str(item) in LOCAL_ENGINE_CAPABILITIES
            ),
            expires_at=issued_at + self._ttl_seconds,
        )
        with self._lock:
            self._grants[self._token_digest(token)] = grant
        return token, grant

    def validate(self, token: str, *, origin: str, now: float | None = None) -> SessionGrant | None:
        if not token or not origin:
            return None
        try:
            normalized_origin = parse_exact_origins(origin, include_development_defaults=False)[0]
        except ValueError:
            return None
        checked_at = time.time() if now is None else now
        digest = self._token_digest(token)
        with self._lock:
            grant = self._grants.get(digest)
            if grant is None:
                return None
            if grant.expires_at <= checked_at:
                self._grants.pop(digest, None)
                return None
            if not hmac.compare_digest(grant.origin, normalized_origin):
                return None
            return grant

    def revoke(self, token: str) -> None:
        if not token:
            return
        with self._lock:
            self._grants.pop(self._token_digest(token), None)


def _header_map(scope: dict) -> dict[str, str]:
    return {
        key.decode("latin-1").lower(): value.decode("latin-1")
        for key, value in scope.get("headers", [])
    }


def _bearer_token(headers: Mapping[str, str]) -> str:
    authorization = headers.get("authorization", "").strip()
    scheme, separator, token = authorization.partition(" ")
    if not separator or scheme.lower() != "bearer":
        return ""
    return token.strip()


def required_capability_for_request(method: str, path: str) -> str | None:
    normalized_method = method.upper()
    if path == "/api/health" or path.startswith("/api/analyze"):
        return "analysis"
    if path.startswith("/api/tools/extract-audio"):
        return "analysis"
    if path.startswith("/api/models") or path.startswith("/api/settings"):
        return "model-management"
    if path == "/api/export-record" or path.startswith("/api/export-record/"):
        return "export"
    if path.startswith("/api/outputs/"):
        if path.endswith("/sync-record") or normalized_method == "DELETE":
            return "meeting-storage"
        if any(
            marker in path
            for marker in (
                "/generate-",
                "/generation-",
                "/stop-generation",
            )
        ):
            return "analysis"
        return "export"
    if path.startswith("/api/dev/asr-benchmarks"):
        return "model-management"
    return None


def request_authorization_status(
    headers: Mapping[str, str],
    *,
    desktop_token: str,
    session_store: LocalEngineSessionStore,
    required_capability: str | None,
) -> str:
    provided_desktop_token = headers.get(DESKTOP_ACTION_TOKEN_HEADER, "").strip()
    if desktop_token and provided_desktop_token and hmac.compare_digest(provided_desktop_token, desktop_token):
        return "authorized"
    session_token = _bearer_token(headers)
    origin = headers.get("origin", "").strip()
    grant = session_store.validate(session_token, origin=origin)
    if grant is None:
        return "unauthorized"
    if required_capability is None or required_capability not in grant.capabilities:
        return "forbidden"
    return "authorized"


class LocalEngineAuthMiddleware:
    def __init__(
        self,
        app,
        *,
        enforcement_enabled: Callable[[], bool],
        desktop_token: Callable[[], str],
        session_store: LocalEngineSessionStore,
        allowed_origins: Iterable[str],
        public_pairing_routes: Iterable[tuple[str, str]] = PUBLIC_PAIRING_ROUTES,
    ) -> None:
        self.app = app
        self.enforcement_enabled = enforcement_enabled
        self.desktop_token = desktop_token
        self.session_store = session_store
        self.allowed_origins = frozenset(allowed_origins)
        self.public_pairing_routes = frozenset(
            (method.upper(), path) for method, path in public_pairing_routes
        )

    async def __call__(self, scope, receive, send) -> None:
        if scope.get("type") != "http":
            await self.app(scope, receive, send)
            return
        path = scope.get("path", "")
        method = scope.get("method", "GET").upper()
        route = (method, path)
        if method == "OPTIONS" or not path.startswith("/api/"):
            await self.app(scope, receive, send)
            return

        headers = _header_map(scope)
        if route == PUBLIC_PROBE_ROUTE:
            await self.app(scope, receive, send)
            return
        if route in self.public_pairing_routes:
            if headers.get("origin", "").strip() in self.allowed_origins:
                await self.app(scope, receive, send)
                return
            response = JSONResponse({"detail": "pairing origin is not allowed"}, status_code=403)
            await response(scope, receive, send)
            return
        if not self.enforcement_enabled():
            await self.app(scope, receive, send)
            return

        authorization_status = request_authorization_status(
            headers,
            desktop_token=self.desktop_token(),
            session_store=self.session_store,
            required_capability=required_capability_for_request(method, path),
        )
        if authorization_status == "authorized":
            await self.app(scope, receive, send)
            return

        if authorization_status == "forbidden":
            response = JSONResponse(
                {"detail": "local engine capability required"},
                status_code=403,
            )
            await response(scope, receive, send)
            return

        response = JSONResponse(
            {"detail": "local engine authorization required"},
            status_code=401,
            headers={"WWW-Authenticate": "Bearer"},
        )
        await response(scope, receive, send)
