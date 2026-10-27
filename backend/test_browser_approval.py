import json
from pathlib import Path
import stat
import tempfile
import threading
import time
import unittest
from unittest.mock import Mock, patch

from fastapi.testclient import TestClient
from local_engine_browser_approval import BrowserApprovalCoordinator
from local_engine_security import LocalEngineSessionStore, PairingRejectedError, PairingRateLimitError
import main

ORIGIN = "http://localhost:5173"


class BrowserApprovalTest(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.addCleanup(self.directory.cleanup)
        self.path = Path(self.directory.name) / "approvals.json"
        self.now = [1000.0]
        self.sessions = LocalEngineSessionStore(ttl_seconds=60)
        self.release = threading.Event()
        self.addCleanup(self.release.set)
        self.decision = True
        self.browser_token = "b" * 43
        self.coordinator = BrowserApprovalCoordinator(self.sessions, clock=lambda: self.now[0])
        self.coordinator.configure(self.path, ORIGIN, self.prompt)

    def prompt(self, origin):
        self.assertEqual(origin, ORIGIN)
        self.release.wait(2)
        return self.decision

    def approve(self, browser_token=None):
        browser_token = browser_token or self.browser_token
        challenge = self.coordinator.start(ORIGIN, browser_token)
        self.release.set()
        deadline = time.monotonic() + 2
        while time.monotonic() < deadline:
            result = self.coordinator.complete(challenge["pairing_id"], ORIGIN)
            if result:
                return {**result, "browser_token": browser_token}
            time.sleep(.001)
        self.fail("Approval callback did not finish")

    def test_pending_requires_native_approval_and_cannot_be_replayed(self):
        challenge = self.coordinator.start(ORIGIN, self.browser_token)
        self.assertIsNone(self.coordinator.complete(challenge["pairing_id"], ORIGIN))
        self.assertFalse(self.path.exists())
        with self.assertRaises(PairingRateLimitError):
            self.coordinator.start(ORIGIN, self.browser_token)
        self.release.set()
        for _ in range(100):
            if self.coordinator.complete(challenge["pairing_id"], ORIGIN):
                break
            time.sleep(.001)
        else:
            self.fail("Consent not delivered")
        with self.assertRaises(PairingRejectedError):
            self.coordinator.complete(challenge["pairing_id"], ORIGIN)

    def test_saved_hash_restores_after_restart_and_revoke_invalidates_all_sessions(self):
        result = self.approve()
        saved = self.path.read_text()
        self.assertNotIn(result["browser_token"], saved)
        self.assertNotIn(result["session_token"], saved)
        # Existing short sessions are separate from browser trust and remain short lived.
        one = self.coordinator.restore(result["browser_token"], ORIGIN)
        grant = self.sessions.validate(one["session_token"], origin=ORIGIN)
        self.assertIsNotNone(grant)
        fresh_sessions = LocalEngineSessionStore()
        restarted = BrowserApprovalCoordinator(fresh_sessions)
        restarted.configure(self.path, ORIGIN, lambda _origin: self.fail("Unexpected consent prompt"))
        two = restarted.restore(result["browser_token"], ORIGIN)
        self.assertTrue(restarted.revoke(result["browser_token"], ORIGIN))
        self.assertIsNone(fresh_sessions.validate(two["session_token"], origin=ORIGIN))
        with self.assertRaises(PairingRejectedError):
            restarted.restore(result["browser_token"], ORIGIN)
        again = BrowserApprovalCoordinator(LocalEngineSessionStore())
        again.configure(self.path, ORIGIN, lambda _origin: True)
        with self.assertRaises(PairingRejectedError):
            again.restore(result["browser_token"], ORIGIN)

    def test_other_origin_cannot_start_complete_restore_or_revoke(self):
        result = self.approve()
        for operation in (
            lambda: self.coordinator.start("https://evil.example", self.browser_token),
            lambda: self.coordinator.complete("unknown", "https://evil.example"),
            lambda: self.coordinator.restore(result["browser_token"], "https://evil.example"),
            lambda: self.coordinator.revoke(result["browser_token"], "https://evil.example"),
        ):
            with self.assertRaises(PairingRejectedError):
                operation()
        self.assertIn("session_token", self.coordinator.restore(result["browser_token"], ORIGIN))

    def test_expired_approval_cannot_issue_a_credential(self):
        challenge = self.coordinator.start(ORIGIN, self.browser_token)
        self.now[0] += 121
        self.release.set()
        with self.assertRaises(PairingRejectedError):
            self.coordinator.complete(challenge["pairing_id"], ORIGIN)
        self.assertFalse(self.path.exists())

    def test_cancelling_a_pending_request_prevents_a_late_native_approval(self):
        challenge = self.coordinator.start(ORIGIN, self.browser_token)
        self.assertFalse(self.coordinator.revoke(self.browser_token, ORIGIN))
        self.release.set()
        with self.assertRaises(PairingRejectedError):
            self.coordinator.complete(challenge["pairing_id"], ORIGIN)
        self.assertFalse(self.path.exists())

    def test_denial_creates_no_saved_grant(self):
        self.decision = False
        with self.assertRaises(PairingRejectedError):
            self.approve()
        self.assertFalse(self.path.exists())

    def test_write_failure_does_not_claim_revocation_succeeded(self):
        result = self.approve()
        with patch.object(self.coordinator, "_persist", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.coordinator.revoke(result["browser_token"], ORIGIN)
        self.assertIn("session_token", self.coordinator.restore(result["browser_token"], ORIGIN))

    def test_corrupt_saved_grants_fail_closed(self):
        self.path.write_text(json.dumps({"format": 1, "grants": {"a" * 64: "https://evil.example"}}))
        new = BrowserApprovalCoordinator(LocalEngineSessionStore())
        with self.assertRaises(ValueError):
            new.configure(self.path, ORIGIN, lambda _origin: True)
        self.assertFalse(new.available)

    def test_damaged_records_remain_blocked_until_local_recovery_is_accepted(self):
        for data in (b"{broken", b"\xff", b"x" * 65537, b"[" * 1100 + b"]" * 1100,
                     b'{"format": 2, "grants": {}}',
                     json.dumps({"format": 1, "grants": {"a" * 64: "https://evil.example"}}).encode()):
            with self.subTest(data=data[:40]):
                self.path.write_bytes(data)
                for _restart in range(2):
                    new = BrowserApprovalCoordinator(LocalEngineSessionStore())
                    consent = Mock(return_value=False)
                    with self.assertRaises(ValueError):
                        new.configure(self.path, ORIGIN, self.prompt, recovery_prompt=consent)
                    consent.assert_called_once_with(ORIGIN)
                    self.assertFalse(new.available)
                    self.assertEqual(self.path.read_bytes(), data)
                    self.assertEqual(list(self.path.parent.glob("*.damaged-*")), [])

    def test_recovery_preserves_each_invalid_record_without_loading_any_grants(self):
        for data in (b"{broken", b"\xff", b"x" * 65537, b"[" * 1100 + b"]" * 1100,
                     json.dumps({"format": 1, "grants": {"a" * 64: "https://evil.example"}}).encode()):
            with self.subTest(data=data[:40]):
                self.path.write_bytes(data)
                new = BrowserApprovalCoordinator(LocalEngineSessionStore())
                before = set(self.path.parent.glob("*.damaged-*"))
                new.configure(self.path, ORIGIN, self.prompt, recovery_prompt=lambda _origin: True)
                backups = set(self.path.parent.glob("*.damaged-*")) - before
                self.assertEqual(len(backups), 1)
                self.assertEqual(backups.pop().read_bytes(), data)
                self.assertFalse(self.path.exists())
                self.assertTrue(new.available)
                with self.assertRaises(PairingRejectedError):
                    new.restore(self.browser_token, ORIGIN)

    def test_recovery_reregisters_restarts_and_revokes_without_touching_user_files(self):
        original = self.approve()
        damaged = b'{"format": 1, "grants":'
        self.path.write_bytes(damaged)
        siblings = {self.path.parent / name: name.encode() for name in ("config.json", "meeting.json", "model.bin")}
        for path, data in siblings.items():
            path.write_bytes(data)
        new_sessions = LocalEngineSessionStore()
        new = BrowserApprovalCoordinator(new_sessions)
        new.configure(self.path, ORIGIN, self.prompt, recovery_prompt=lambda _origin: True)
        with self.assertRaises(PairingRejectedError):
            new.restore(original["browser_token"], ORIGIN)
        with self.assertRaises(PairingRejectedError):
            new.start("https://evil.example", self.browser_token)
        self.coordinator = new
        fresh = self.approve()
        restarted_sessions = LocalEngineSessionStore()
        restarted = BrowserApprovalCoordinator(restarted_sessions)
        unexpected_prompt = Mock(side_effect=AssertionError("Healthy records must not prompt"))
        restarted.configure(self.path, ORIGIN, self.prompt, recovery_prompt=unexpected_prompt)
        restored = restarted.restore(fresh["browser_token"], ORIGIN)
        self.assertIsNotNone(restarted_sessions.validate(restored["session_token"], origin=ORIGIN))
        self.assertTrue(restarted.revoke(fresh["browser_token"], ORIGIN))
        self.assertIsNone(restarted_sessions.validate(restored["session_token"], origin=ORIGIN))
        unexpected_prompt.assert_not_called()
        self.assertEqual(next(self.path.parent.glob("*.damaged-*")).read_bytes(), damaged)
        for path, data in siblings.items():
            self.assertEqual(path.read_bytes(), data)

    def test_failed_backup_keeps_original_and_connection_blocked(self):
        damaged = b"{broken"
        self.path.write_bytes(damaged)
        new = BrowserApprovalCoordinator(LocalEngineSessionStore())
        with patch.object(Path, "rename", side_effect=PermissionError("locked")), self.assertRaises(PermissionError):
            new.configure(self.path, ORIGIN, self.prompt, recovery_prompt=lambda _origin: True)
        self.assertFalse(new.available)
        self.assertEqual(self.path.read_bytes(), damaged)
        self.assertEqual(list(self.path.parent.glob("*.damaged-*")), [])

    def test_changed_file_during_recovery_is_preserved_and_not_loaded(self):
        self.path.write_bytes(b"{broken")
        replacement = json.dumps({"format": 1, "grants": {}}).encode()
        def consent(_origin):
            self.path.write_bytes(replacement)
            return True
        new = BrowserApprovalCoordinator(LocalEngineSessionStore())
        with self.assertRaisesRegex(ValueError, "changed during recovery"):
            new.configure(self.path, ORIGIN, self.prompt, recovery_prompt=consent)
        self.assertFalse(new.available)
        self.assertEqual(self.path.read_bytes(), replacement)
        self.assertEqual(list(self.path.parent.glob("*.damaged-*")), [])

    def test_recovery_does_not_move_links_directories_or_invalid_configured_origins(self):
        consent = Mock(return_value=True)
        for info in (Mock(st_mode=stat.S_IFLNK),
                     Mock(st_mode=stat.S_IFREG, st_file_attributes=stat.FILE_ATTRIBUTE_REPARSE_POINT)):
            new = BrowserApprovalCoordinator(LocalEngineSessionStore())
            with patch.object(Path, "lstat", return_value=info), self.assertRaises(ValueError):
                new.configure(self.path, ORIGIN, self.prompt, recovery_prompt=consent)
            self.assertFalse(new.available)
        self.path.mkdir()
        for path, origin in ((self.path, ORIGIN), (self.path, "*")):
            with self.assertRaises(ValueError):
                BrowserApprovalCoordinator(LocalEngineSessionStore()).configure(
                    path, origin, self.prompt, recovery_prompt=consent,
                )
        consent.assert_not_called()

    def test_multiple_pending_approvals_cannot_overflow_saved_browser_limit(self):
        self.coordinator._grants = {f"{index:064x}": ORIGIN for index in range(15)}
        self.release.set()
        first = self.coordinator.start(ORIGIN, self.browser_token)
        for _ in range(100):
            if not self.coordinator._dialog_open:
                break
            time.sleep(.001)
        second = self.coordinator.start(ORIGIN, "c" * 43)
        for _ in range(100):
            if not self.coordinator._dialog_open:
                break
            time.sleep(.001)
        self.coordinator.complete(first["pairing_id"], ORIGIN)
        self.assertIn("session_token", self.coordinator.complete(second["pairing_id"], ORIGIN))
        restarted = BrowserApprovalCoordinator(LocalEngineSessionStore())
        restarted.configure(self.path, ORIGIN, lambda _origin: True)
        self.assertEqual(len(restarted._grants), 16)
        for token in (self.browser_token, "c" * 43):
            self.assertIn("session_token", restarted.restore(token, ORIGIN))

    def test_lost_browser_credentials_do_not_permanently_block_new_connections(self):
        first = self.approve()
        second_session = self.coordinator.restore(first["browser_token"], ORIGIN)
        for index in range(1, 20):
            # New private visits/site-data resets lose their old browser token.
            self.now[0] += 61
            last_token = str(index).zfill(43)
            self.approve(last_token)
        self.assertEqual(len(json.loads(self.path.read_text())["grants"]), 16)
        # Forgetting a remembered browser must not interrupt an already running job.
        for session in (first, second_session):
            self.assertIsNotNone(self.sessions.validate(session["session_token"], origin=ORIGIN))
        # Explicit disconnect still revokes all sessions even after its durable
        # registration has been reclaimed and revoke reports it was not saved.
        self.assertFalse(self.coordinator.revoke(first["browser_token"], ORIGIN))
        for session in (first, second_session):
            self.assertIsNone(self.sessions.validate(session["session_token"], origin=ORIGIN))
        restarted = BrowserApprovalCoordinator(LocalEngineSessionStore())
        restarted.configure(self.path, ORIGIN, lambda _origin: True)
        with self.assertRaises(PairingRejectedError):
            restarted.restore(first["browser_token"], ORIGIN)
        self.assertIn("session_token", restarted.restore(last_token, ORIGIN))
        self.now[0] += 61
        self.assertIn("session_token", self.approve("z" * 43))

    def test_restore_persists_recency_before_reclaiming_a_browser(self):
        tokens = [str(index).zfill(43) for index in range(16)]
        for token in tokens:
            self.now[0] += 61
            self.approve(token)
        self.coordinator.restore(tokens[0], ORIGIN)
        restarted = BrowserApprovalCoordinator(self.sessions, clock=lambda: self.now[0])
        restarted.configure(self.path, ORIGIN, self.prompt)
        self.coordinator = restarted
        self.now[0] += 61
        self.approve("z" * 43)
        with self.assertRaises(PairingRejectedError):
            restarted.restore(tokens[1], ORIGIN)
        retained = restarted.restore(tokens[0], ORIGIN)
        self.assertTrue(restarted.revoke(tokens[0], ORIGIN))
        self.assertIsNone(self.sessions.validate(retained["session_token"], origin=ORIGIN))

    def test_reclaim_only_happens_after_approval_and_successful_persistence(self):
        for index in range(16):
            self.now[0] += 61
            self.approve(str(index).zfill(43))
        before = self.path.read_bytes()
        self.now[0] += 61
        self.decision = False
        with self.assertRaises(PairingRejectedError):
            self.approve("x" * 43)
        self.assertEqual(self.path.read_bytes(), before)
        self.decision = True
        with patch.object(self.coordinator, "_persist", side_effect=OSError("disk unavailable")):
            with self.assertRaises(OSError):
                self.approve("y" * 43)
        self.assertEqual(self.path.read_bytes(), before)
        self.assertEqual(len(self.coordinator._grants), 16)
        self.assertIn("session_token", self.coordinator.restore(str(0).zfill(43), ORIGIN))

    def test_api_wait_restore_and_forget_with_origin_gate(self):
        headers = {"Origin": ORIGIN}
        with patch.object(main, "LOCAL_ENGINE_BROWSER_APPROVAL", self.coordinator), TestClient(main.app) as client:
            response = client.post("/api/pair/start", json={"mode": "browser-connection", "browser_token": self.browser_token}, headers=headers)
            self.assertEqual(response.status_code, 200, response.text)
            payload = {"mode": "browser-connection", "pairing_id": response.json()["pairing_id"]}
            self.assertEqual(client.post("/api/pair/complete", json=payload, headers=headers).status_code, 202)
            self.release.set()
            for _ in range(100):
                response = client.post("/api/pair/complete", json=payload, headers=headers)
                if response.status_code != 202:
                    break
                time.sleep(.001)
            self.assertEqual(response.status_code, 200, response.text)
            browser = {"browser_token": self.browser_token}
            self.assertEqual(client.post("/api/pair/restore", json=browser, headers=headers).status_code, 200)
            self.assertEqual(client.post("/api/pair/restore", json=browser, headers={"Origin": "https://evil.example"}).status_code, 403)
            self.assertEqual(client.post("/api/pair/forget", json=browser, headers=headers).status_code, 200)
            self.assertEqual(client.post("/api/pair/restore", json=browser, headers=headers).status_code, 401)


if __name__ == "__main__":
    unittest.main()
