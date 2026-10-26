"""In-memory request lifetime tracking for explicit update guidance."""

import threading


class UpdateRequestActivity:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._active = 0

    def begin(self) -> None:
        with self._lock:
            self._active += 1

    def end(self) -> None:
        with self._lock:
            self._active -= 1

    def is_active(self) -> bool:
        with self._lock:
            return self._active > 0


class UpdateActivityMiddleware:
    def __init__(self, app, *, activity: UpdateRequestActivity) -> None:
        self.app = app
        self.activity = activity

    async def __call__(self, scope, receive, send) -> None:
        path = scope.get("path", "")
        excluded = path in {"/api/update-activity", "/api/health", "/api/probe"}
        excluded = excluded or path.startswith(("/api/pair/", "/api/session/"))
        if scope.get("type") != "http" or scope.get("method") == "OPTIONS" or not path.startswith("/api/") or excluded:
            await self.app(scope, receive, send)
            return
        self.activity.begin()
        try:
            # Keep the lease until streaming bodies, cleanup and background tasks finish.
            await self.app(scope, receive, send)
        finally:
            self.activity.end()
