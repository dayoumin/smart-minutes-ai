import asyncio
import os
import sys
import unittest
from contextlib import ExitStack
from unittest.mock import patch

from fastapi.testclient import TestClient

sys.path.insert(0, os.path.dirname(__file__))

import main
from analysis_jobs import AnalysisJobRegistry
from test_local_engine_security import build_isolated_main_app
from update_activity import UpdateActivityMiddleware, UpdateRequestActivity


class UpdateActivityApiTest(unittest.TestCase):
    def setUp(self) -> None:
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        self.stack.enter_context(patch.dict(os.environ, {
            "LMO_RUNTIME_PROFILE": "production", "LMO_API_AUTH_ENFORCEMENT": "enabled",
            "LMO_WEB_ALLOWED_ORIGINS": "https://update.example",
        }))
        for name, value in (
            ("ANALYSIS_JOBS", AnalysisJobRegistry()), ("ACTIVE_GENERATIONS", set()),
            ("MODEL_DOWNLOAD_STATUS", {}), ("OLLAMA_RUNTIME_DOWNLOAD_STATUS", {}), ("OLLAMA_PULL_STATUS", {}),
        ):
            self.stack.enter_context(patch.object(main, name, value))
        app, sessions = build_isolated_main_app()
        self.sessions = sessions
        token, _ = sessions.issue(origin="https://update.example", capabilities=["analysis"])
        self.client = TestClient(app)
        self.headers = {"Authorization": f"Bearer {token}", "Origin": "https://update.example"}

    def get_activity(self) -> dict:
        response = self.client.get("/api/update-activity", headers=self.headers)
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["cache-control"], "no-store")
        self.assertEqual(set(response.json()), {"busy"})
        return response.json()

    def test_idle_reads_do_not_count_their_own_activity(self) -> None:
        self.assertEqual(self.get_activity(), {"busy": False})
        self.assertEqual(self.get_activity(), {"busy": False})

    def test_admission_and_cancelled_analysis_remain_busy_until_cleanup_finishes(self) -> None:
        event = main.ANALYSIS_JOBS.create("private-job-id", admission_pending=True)
        self.assertEqual(self.get_activity(), {"busy": True})
        main.ANALYSIS_JOBS.cancel("private-job-id")
        self.assertEqual(self.get_activity(), {"busy": True})
        main.ANALYSIS_JOBS.remove("private-job-id", event)
        self.assertEqual(self.get_activity(), {"busy": False})

    def test_generation_and_downloads_outlive_settings_dialog(self) -> None:
        main.ACTIVE_GENERATIONS.add(("private-job-id", "summary"))
        self.assertEqual(self.get_activity(), {"busy": True})
        main.ACTIVE_GENERATIONS.clear()
        for statuses in (main.MODEL_DOWNLOAD_STATUS, main.OLLAMA_RUNTIME_DOWNLOAD_STATUS, main.OLLAMA_PULL_STATUS):
            with self.subTest(statuses=id(statuses)):
                statuses["private-custom-model"] = {"active": True, "status": "cancelling", "target_path": "private-path"}
                self.assertEqual(self.get_activity(), {"busy": True})
                statuses["private-custom-model"]["active"] = False
                self.assertEqual(self.get_activity(), {"busy": False})
                statuses.clear()

    def test_pending_http_work_blocks_until_request_finishes(self) -> None:
        main.UPDATE_REQUEST_ACTIVITY.begin()
        try:
            self.assertEqual(self.get_activity(), {"busy": True})
        finally:
            main.UPDATE_REQUEST_ACTIVITY.end()
        self.assertEqual(self.get_activity(), {"busy": False})

    def test_unauthorized_request_cannot_read_activity(self) -> None:
        self.assertEqual(self.client.get("/api/update-activity").status_code, 401)
        token, _ = self.sessions.issue(origin="https://update.example", capabilities=["export"])
        self.assertEqual(self.client.get("/api/update-activity", headers={
            "Authorization": f"Bearer {token}", "Origin": "https://update.example",
        }).status_code, 403)


class UpdateActivityMiddlewareTest(unittest.IsolatedAsyncioTestCase):
    async def test_streamed_cached_result_keeps_activity_until_body_finishes(self) -> None:
        activity = UpdateRequestActivity()
        body_waiting = asyncio.Event()
        finish_body = asyncio.Event()

        async def app(scope, receive, send):
            await send({"type": "http.response.start", "status": 200, "headers": []})
            body_waiting.set()
            await finish_body.wait()
            await send({"type": "http.response.body", "body": b"private audio"})

        async def noop(*args):
            return None

        middleware = UpdateActivityMiddleware(app, activity=activity)
        task = asyncio.create_task(middleware({"type": "http", "method": "GET", "path": "/api/outputs/private/audio"}, noop, noop))
        await body_waiting.wait()
        self.assertTrue(activity.is_active())
        finish_body.set()
        await task
        self.assertFalse(activity.is_active())

    async def test_failed_requests_release_activity(self) -> None:
        activity = UpdateRequestActivity()

        async def failing(*args):
            raise RuntimeError("request stopped")

        with self.assertRaises(RuntimeError):
            await UpdateActivityMiddleware(failing, activity=activity)(
                {"type": "http", "method": "PATCH", "path": "/api/settings"}, None, None,
            )
        self.assertFalse(activity.is_active())


if __name__ == "__main__":
    unittest.main()
