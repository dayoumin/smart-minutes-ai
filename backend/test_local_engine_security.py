import os
import sys
import threading
import unittest
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import PlainTextResponse, StreamingResponse
from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

from local_engine_security import (
    API_CONTRACT_VERSION,
    PRODUCT_ID,
    LocalEngineAuthMiddleware,
    LocalEnginePairingCoordinator,
    LocalEngineSessionStore,
    PairingRateLimitError,
    PairingRejectedError,
    PairingUnavailableError,
    api_auth_enforcement_enabled,
    build_probe_payload,
    configured_exact_origins,
    parse_exact_origins,
)
import main


def build_test_app(
    *,
    enforcement_enabled=lambda: True,
    desktop_token=lambda: "desktop-secret",
) -> tuple[FastAPI, LocalEngineSessionStore]:
    app = FastAPI()
    sessions = LocalEngineSessionStore(ttl_seconds=60)
    app.add_middleware(
        LocalEngineAuthMiddleware,
        enforcement_enabled=enforcement_enabled,
        desktop_token=desktop_token,
        session_store=sessions,
        allowed_origins=("https://web.example",),
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["https://web.example"],
        allow_credentials=True,
        allow_methods=["GET", "POST", "OPTIONS"],
        allow_headers=["Authorization", "Content-Type", "X-LMO-Desktop-Action-Token"],
    )

    @app.get("/api/probe")
    async def probe():
        return build_probe_payload(pairing_available=False)

    @app.get("/api/analyze/status")
    async def private_read():
        return {"ok": True}

    @app.post("/api/models/download")
    async def private_write():
        return {"ok": True}

    @app.get("/api/analyze/job/events")
    async def private_stream():
        async def events():
            yield "data: ok\n\n"

        return StreamingResponse(events(), media_type="text/event-stream")

    @app.get("/api/outputs/job/meeting-record")
    async def private_download():
        return PlainTextResponse(
            "download",
            headers={"Content-Disposition": 'attachment; filename="result.txt"'},
        )

    @app.post("/api/pair/start")
    async def pair_start():
        return {"ok": True}

    @app.get("/api/pair/start")
    async def pair_start_wrong_method():
        return {"ok": True}

    @app.get("/status")
    async def public_non_api_status():
        return {"ok": True}

    return app, sessions


class LocalEngineSecurityTest(unittest.TestCase):
    def test_probe_contract_is_non_sensitive_and_versioned(self) -> None:
        payload = build_probe_payload(pairing_available=False)

        self.assertEqual(payload["product_id"], PRODUCT_ID)
        self.assertEqual(payload["api_contract_version"], API_CONTRACT_VERSION)
        self.assertEqual(payload["auth_state"], "pairing-required")
        self.assertFalse(payload["pairing_available"])
        self.assertNotIn("backend_dir", payload)
        self.assertNotIn("python_executable", payload)
        self.assertNotIn("token", payload)

    def test_allowed_origins_are_exact_and_configurable(self) -> None:
        origins = parse_exact_origins(
            "https://web.example,https://web.example",
            include_development_defaults=False,
        )

        self.assertEqual(origins, ("https://web.example",))
        with self.assertRaises(ValueError):
            parse_exact_origins("https://web.example/path", include_development_defaults=False)
        with self.assertRaises(ValueError):
            parse_exact_origins("*", include_development_defaults=False)

    def test_production_profile_does_not_include_development_origins(self) -> None:
        with patch.dict(
            os.environ,
            {
                "LMO_RUNTIME_PROFILE": "production",
                "LMO_WEB_ALLOWED_ORIGINS": "https://web.example",
            },
            clear=True,
        ):
            self.assertEqual(configured_exact_origins(), ("https://web.example",))
        for invalid_origin in ("http://web.example", "tauri://localhost"):
            with (
                patch.dict(
                    os.environ,
                    {
                        "LMO_RUNTIME_PROFILE": "production",
                        "LMO_WEB_ALLOWED_ORIGINS": invalid_origin,
                    },
                    clear=True,
                ),
                self.assertRaises(ValueError),
            ):
                configured_exact_origins()

    def test_auth_enforcement_requires_explicit_opt_in(self) -> None:
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(api_auth_enforcement_enabled())
        with patch.dict(os.environ, {"LMO_API_AUTH_ENFORCEMENT": "enabled"}, clear=True):
            self.assertTrue(api_auth_enforcement_enabled())

    def test_session_is_origin_bound_expires_and_can_be_revoked(self) -> None:
        sessions = LocalEngineSessionStore(ttl_seconds=30)
        token, grant = sessions.issue(
            origin="https://web.example",
            capabilities=["analysis"],
            now=100,
        )

        self.assertEqual(grant.capabilities, frozenset({"analysis"}))
        self.assertNotIn(token, sessions._grants)
        self.assertIsNotNone(sessions.validate(token, origin="https://web.example", now=129))
        self.assertIsNone(sessions.validate(token, origin="https://other.example", now=129))
        self.assertIsNone(sessions.validate(token, origin="https://web.example", now=130))

        token, _ = sessions.issue(origin="https://web.example", capabilities=[], now=200)
        sessions.revoke(token)
        self.assertIsNone(sessions.validate(token, origin="https://web.example", now=201))

    def test_session_rotation_revokes_previous_token(self) -> None:
        sessions = LocalEngineSessionStore(ttl_seconds=30)
        token, _ = sessions.issue(
            origin="https://web.example",
            capabilities=["analysis"],
            now=100,
        )
        rotated = sessions.rotate(token, origin="https://web.example", now=110)

        self.assertIsNotNone(rotated)
        next_token, next_grant = rotated
        self.assertNotEqual(next_token, token)
        self.assertEqual(next_grant.capabilities, frozenset({"analysis"}))
        self.assertIsNone(sessions.validate(token, origin="https://web.example", now=111))
        self.assertIsNotNone(sessions.validate(next_token, origin="https://web.example", now=111))

    def test_session_refresh_extends_same_token_without_orphan_successor(self) -> None:
        sessions = LocalEngineSessionStore(ttl_seconds=30)
        token, _ = sessions.issue(
            origin="https://web.example",
            capabilities=["analysis"],
            now=100,
        )
        refreshed = sessions.refresh_if_valid(token, origin="https://web.example", now=120)

        self.assertIsNotNone(refreshed)
        self.assertEqual(refreshed.expires_at, 150)
        self.assertIsNotNone(sessions.validate(token, origin="https://web.example", now=149))

    def test_concurrent_session_rotation_issues_only_one_successor(self) -> None:
        sessions = LocalEngineSessionStore(ttl_seconds=30)
        token, _ = sessions.issue(
            origin="https://web.example",
            capabilities=["analysis"],
            now=100,
        )
        barrier = threading.Barrier(3)
        results: list[tuple[str, object] | None] = []

        def rotate() -> None:
            barrier.wait()
            results.append(sessions.rotate(token, origin="https://web.example", now=110))

        threads = [threading.Thread(target=rotate) for _ in range(2)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join()

        successors = [result for result in results if result is not None]
        self.assertEqual(len(successors), 1)
        next_token, _ = successors[0]
        self.assertIsNotNone(sessions.validate(next_token, origin="https://web.example", now=111))

    def test_atomic_revoke_competes_with_rotation_without_leaving_two_successors(self) -> None:
        sessions = LocalEngineSessionStore(ttl_seconds=30)
        token, _ = sessions.issue(
            origin="https://web.example",
            capabilities=["analysis"],
            now=100,
        )
        barrier = threading.Barrier(3)
        results: list[object] = []

        def rotate() -> None:
            barrier.wait()
            results.append(sessions.rotate(token, origin="https://web.example", now=110))

        def revoke() -> None:
            barrier.wait()
            results.append(sessions.revoke_if_valid(token, origin="https://web.example", now=110))

        threads = [threading.Thread(target=rotate), threading.Thread(target=revoke)]
        for thread in threads:
            thread.start()
        barrier.wait()
        for thread in threads:
            thread.join()

        rotation = next((result for result in results if isinstance(result, tuple)), None)
        revoke_succeeded = any(result is True for result in results)
        self.assertNotEqual(rotation is not None, revoke_succeeded)
        if rotation is not None:
            next_token, _ = rotation
            self.assertIsNotNone(sessions.validate(next_token, origin="https://web.example", now=111))

    def test_pairing_code_is_presented_out_of_band_and_consumed_once(self) -> None:
        presented: dict[str, str | float] = {}
        sessions = LocalEngineSessionStore(ttl_seconds=30)
        pairing = LocalEnginePairingCoordinator(
            session_store=sessions,
            code_presenter=lambda pairing_id, code, expires_at: not presented.update({
                "pairing_id": pairing_id,
                "code": code,
                "expires_at": expires_at,
            }),
            ttl_seconds=20,
        )

        started = pairing.start(origin="https://web.example", now=100)
        self.assertEqual(started["pairing_id"], presented["pairing_id"])
        self.assertNotIn("code", started)
        token, grant = pairing.complete(
            pairing_id=str(presented["pairing_id"]),
            code=str(presented["code"]),
            origin="https://web.example",
            capabilities=["analysis"],
            now=101,
        )
        self.assertEqual(grant.capabilities, frozenset({"analysis"}))
        self.assertIsNotNone(sessions.validate(token, origin="https://web.example", now=102))
        with self.assertRaises(PairingRejectedError):
            pairing.complete(
                pairing_id=str(presented["pairing_id"]),
                code=str(presented["code"]),
                origin="https://web.example",
                now=102,
            )

    def test_pairing_rejects_wrong_origin_expiry_and_exhausted_attempts(self) -> None:
        codes: dict[str, str] = {}
        pairing = LocalEnginePairingCoordinator(
            session_store=LocalEngineSessionStore(),
            code_presenter=lambda pairing_id, code, _expires_at: not codes.update({pairing_id: code}),
            ttl_seconds=10,
            max_attempts=2,
        )
        started = pairing.start(origin="https://web.example", now=100)
        pairing_id = started["pairing_id"]
        with self.assertRaises(PairingRejectedError):
            pairing.complete(
                pairing_id=pairing_id,
                code=codes[pairing_id],
                origin="https://other.example",
                now=101,
            )
        with self.assertRaises(PairingRejectedError):
            pairing.complete(
                pairing_id=pairing_id,
                code="000000",
                origin="https://web.example",
                now=102,
            )
        with self.assertRaises(PairingRateLimitError):
            pairing.complete(
                pairing_id=pairing_id,
                code="111111",
                origin="https://web.example",
                now=103,
            )
        expired = pairing.start(origin="https://web.example", now=200)
        with self.assertRaises(PairingRejectedError):
            pairing.complete(
                pairing_id=expired["pairing_id"],
                code=codes[expired["pairing_id"]],
                origin="https://web.example",
                now=210,
            )

    def test_pairing_start_is_rate_limited_and_helper_is_required(self) -> None:
        unavailable = LocalEnginePairingCoordinator(
            session_store=LocalEngineSessionStore(),
        )
        with self.assertRaises(PairingUnavailableError):
            unavailable.start(origin="https://web.example", now=100)
        failing_helper = LocalEnginePairingCoordinator(
            session_store=LocalEngineSessionStore(),
            code_presenter=lambda *_args: (_ for _ in ()).throw(RuntimeError("helper failed")),
        )
        with self.assertRaises(PairingUnavailableError):
            failing_helper.start(origin="https://web.example", now=100)
        self.assertEqual(failing_helper._challenges, {})

        pairing = LocalEnginePairingCoordinator(
            session_store=LocalEngineSessionStore(),
            code_presenter=lambda *_args: True,
            start_limit=2,
            rate_window_seconds=30,
        )
        pairing.start(origin="https://web.example", now=100)
        pairing.start(origin="https://web.example", now=101)
        with self.assertRaises(PairingRateLimitError):
            pairing.start(origin="https://web.example", now=102)
        pairing.start(origin="https://web.example", now=131)

    def test_pairing_start_prunes_expired_challenges(self) -> None:
        pairing = LocalEnginePairingCoordinator(
            session_store=LocalEngineSessionStore(),
            code_presenter=lambda *_args: True,
            ttl_seconds=10,
        )
        first = pairing.start(origin="https://web.example", now=100)
        self.assertIn(first["pairing_id"], pairing._challenges)
        pairing.start(origin="https://web.example", now=111)
        self.assertNotIn(first["pairing_id"], pairing._challenges)

    def test_default_deny_covers_read_write_stream_and_download(self) -> None:
        app, _ = build_test_app()
        with TestClient(app) as client:
            for method, path in (
                ("get", "/api/analyze/status"),
                ("post", "/api/models/download"),
                ("get", "/api/analyze/job/events"),
                ("get", "/api/outputs/job/meeting-record"),
            ):
                response = getattr(client, method)(path)
                self.assertEqual(response.status_code, 401, path)
                self.assertEqual(response.headers.get("www-authenticate"), "Bearer")

            self.assertEqual(client.get("/api/probe").status_code, 200)
            self.assertEqual(client.get("/status").status_code, 200)

    def test_origin_bound_web_session_enforces_capabilities(self) -> None:
        app, sessions = build_test_app()
        token, _ = sessions.issue(
            origin="https://web.example",
            capabilities=["analysis"],
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Origin": "https://web.example",
        }

        with TestClient(app) as client:
            self.assertEqual(client.get("/api/analyze/status", headers=headers).status_code, 200)
            self.assertEqual(client.get("/api/analyze/job/events", headers=headers).status_code, 200)
            self.assertEqual(client.post("/api/models/download", headers=headers).status_code, 403)
            self.assertEqual(
                client.get("/api/outputs/job/meeting-record", headers=headers).status_code,
                403,
            )
            wrong_origin = {**headers, "Origin": "https://other.example"}
            self.assertEqual(client.get("/api/analyze/status", headers=wrong_origin).status_code, 401)

    def test_export_capability_covers_actual_export_routes(self) -> None:
        app, sessions = build_test_app()
        token, _ = sessions.issue(
            origin="https://web.example",
            capabilities=["export"],
        )
        headers = {
            "Authorization": f"Bearer {token}",
            "Origin": "https://web.example",
        }

        @app.post("/api/export-record/docx")
        async def export_record():
            return {"ok": True}

        @app.post("/api/export-record/hwpx/save-copy")
        async def save_export_copy():
            return {"ok": True}

        with TestClient(app) as client:
            self.assertEqual(client.post("/api/export-record/docx", headers=headers).status_code, 200)
            self.assertEqual(
                client.post("/api/export-record/hwpx/save-copy", headers=headers).status_code,
                200,
            )

    def test_pairing_requires_allowed_origin_and_exact_method(self) -> None:
        app, _ = build_test_app()
        with TestClient(app) as client:
            allowed = client.post(
                "/api/pair/start",
                headers={"Origin": "https://web.example"},
            )
            missing_origin = client.post("/api/pair/start")
            wrong_origin = client.post(
                "/api/pair/start",
                headers={"Origin": "https://other.example"},
            )
            wrong_method = client.get(
                "/api/pair/start",
                headers={"Origin": "https://web.example"},
            )

        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(missing_origin.status_code, 403)
        self.assertEqual(wrong_origin.status_code, 403)
        self.assertEqual(wrong_method.status_code, 401)

    def test_desktop_token_remains_supported_without_browser_origin(self) -> None:
        app, _ = build_test_app()
        with TestClient(app) as client:
            response = client.get(
                "/api/analyze/status",
                headers={"X-LMO-Desktop-Action-Token": "desktop-secret"},
            )
        self.assertEqual(response.status_code, 200)

    def test_cors_preflight_uses_exact_origin_list(self) -> None:
        app, _ = build_test_app()
        headers = {
            "Origin": "https://web.example",
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        }
        with TestClient(app) as client:
            allowed = client.options("/api/analyze/status", headers=headers)
            denied = client.options(
                "/api/analyze/status",
                headers={**headers, "Origin": "https://other.example"},
            )

        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.headers.get("access-control-allow-origin"), "https://web.example")
        self.assertEqual(denied.status_code, 400)
        self.assertNotIn("access-control-allow-origin", denied.headers)

    def test_disabled_enforcement_preserves_existing_routes(self) -> None:
        app, _ = build_test_app(enforcement_enabled=lambda: False)
        with TestClient(app) as client:
            self.assertEqual(client.get("/api/analyze/status").status_code, 200)
            self.assertEqual(client.post("/api/models/download").status_code, 200)
            self.assertEqual(client.post("/api/pair/start").status_code, 403)
            self.assertEqual(
                client.post(
                    "/api/pair/start",
                    headers={"Origin": "https://other.example"},
                ).status_code,
                403,
            )
            self.assertEqual(
                client.post(
                    "/api/pair/start",
                    headers={"Origin": "https://web.example"},
                ).status_code,
                200,
            )

    def test_main_app_probe_and_isolated_enforcement_are_wired(self) -> None:
        with (
            patch.dict(os.environ, {"LMO_API_AUTH_ENFORCEMENT": "enabled"}),
            patch.object(main, "DESKTOP_ACTION_TOKEN", "desktop-secret"),
            TestClient(main.app) as client,
        ):
            probe = client.get("/api/probe")
            pair = client.post(
                "/api/pair/start",
                headers={"Origin": "http://localhost:5173"},
            )
            denied = client.get("/api/health")
            allowed = client.get(
                "/api/health",
                headers={"X-LMO-Desktop-Action-Token": "desktop-secret"},
            )

        self.assertEqual(probe.status_code, 200)
        self.assertEqual(probe.json()["api_contract_version"], API_CONTRACT_VERSION)
        self.assertFalse(probe.json()["pairing_available"])
        self.assertEqual(pair.status_code, 503)
        self.assertEqual(denied.status_code, 401)
        self.assertEqual(allowed.status_code, 200)

    def test_main_app_pairing_session_renew_and_revoke_lifecycle(self) -> None:
        presented: dict[str, str] = {}
        sessions = main.LOCAL_ENGINE_SESSION_STORE
        sessions._grants.clear()
        pairing = LocalEnginePairingCoordinator(
            session_store=sessions,
            code_presenter=lambda pairing_id, code, _expires_at: not presented.update({
                "pairing_id": pairing_id,
                "code": code,
            }),
        )
        origin = "http://localhost:5173"

        with (
            patch.dict(os.environ, {"LMO_API_AUTH_ENFORCEMENT": "enabled"}),
            patch.object(main, "LOCAL_ENGINE_SESSION_STORE", sessions),
            patch.object(main, "LOCAL_ENGINE_PAIRING", pairing),
            TestClient(main.app) as client,
        ):
            started = client.post("/api/pair/start", headers={"Origin": origin})
            self.assertEqual(started.status_code, 200)
            self.assertNotIn("code", started.json())
            completed = client.post(
                "/api/pair/complete",
                headers={"Origin": origin},
                json={
                    "pairing_id": presented["pairing_id"],
                    "code": presented["code"],
                },
            )
            self.assertEqual(completed.status_code, 200)
            first_token = completed.json()["session_token"]
            first_headers = {
                "Origin": origin,
                "Authorization": f"Bearer {first_token}",
            }
            self.assertEqual(client.get("/api/health", headers=first_headers).status_code, 200)

            renewed = client.post("/api/session/renew", headers=first_headers)
            self.assertEqual(renewed.status_code, 200)
            next_token = renewed.json()["session_token"]
            next_headers = {
                "Origin": origin,
                "Authorization": f"Bearer {next_token}",
            }
            self.assertEqual(next_token, first_token)
            self.assertEqual(client.get("/api/health", headers=first_headers).status_code, 200)
            self.assertEqual(client.get("/api/health", headers=next_headers).status_code, 200)

            revoked = client.post("/api/session/revoke", headers=next_headers)
            self.assertEqual(revoked.status_code, 200)
            self.assertEqual(client.get("/api/health", headers=next_headers).status_code, 401)
            self.assertEqual(client.post("/api/session/revoke", headers=next_headers).status_code, 401)
        sessions._grants.clear()

    def test_main_app_cors_rejects_unlisted_development_port(self) -> None:
        request_headers = {
            "Access-Control-Request-Method": "GET",
            "Access-Control-Request-Headers": "authorization",
        }
        with TestClient(main.app) as client:
            allowed = client.options(
                "/api/probe",
                headers={**request_headers, "Origin": "http://localhost:5174"},
            )
            denied = client.options(
                "/api/probe",
                headers={**request_headers, "Origin": "http://localhost:5999"},
            )

        self.assertEqual(allowed.status_code, 200)
        self.assertEqual(allowed.headers.get("access-control-allow-origin"), "http://localhost:5174")
        self.assertEqual(denied.status_code, 400)
        self.assertNotIn("access-control-allow-origin", denied.headers)


if __name__ == "__main__":
    unittest.main()
