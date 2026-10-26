import json
import os
import subprocess
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_pre_push.ps1"


def run_powershell(source: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
         "$ErrorActionPreference = 'Stop'; " + source],
        cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=30,
    )


@unittest.skipUnless(os.name == "nt", "The repository pre-push checks use Windows PowerShell.")
class PrePushHookTest(unittest.TestCase):
    def test_git_hook_reads_the_actual_push_ref_input(self):
        other = subprocess.check_output(["git", "rev-parse", "HEAD^"], cwd=ROOT, text=True).strip()
        temporary_root = (ROOT / ".tmp").resolve()
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="pre-push-refs-", dir=temporary_root) as directory:
            fixture = Path(directory).resolve()
            self.assertTrue(fixture.is_relative_to(temporary_root))
            ref_input = fixture / "refs.txt"
            ref_input.write_text(f"refs/heads/other {other} refs/heads/main {'0' * 40}\n", encoding="utf-8")
            result = subprocess.run(
                ["git", "-c", "core.hooksPath=.githooks", "hook", "run", f"--to-stdin={ref_input}", "pre-push"],
                cwd=ROOT, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=15,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Push target must match", result.stderr)

    def test_push_ref_must_match_the_checked_out_commit(self):
        head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
        other = subprocess.check_output(["git", "rev-parse", "HEAD^"], cwd=ROOT, text=True).strip()
        for target, accepted in ((head, True), (other, False)):
            with self.subTest(accepted=accepted):
                ref_update = f"refs/heads/other {target} refs/heads/main {'0' * 40}"
                result = run_powershell(
                    f". '{SCRIPT}'; try {{ Assert-PrePushRefUpdates '{ref_update}'; "
                    "[Console]::WriteLine('accepted') } catch { "
                    "[Console]::Error.WriteLine($_.Exception.Message); exit 1 }"
                )
                self.assertEqual(result.returncode == 0, accepted, result.stderr)
                if not accepted:
                    self.assertIn("Push target must match", result.stderr)

    def test_modified_and_untracked_configs_block_push(self):
        temporary_root = (ROOT / ".tmp").resolve()
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="pre-push-config-", dir=temporary_root) as directory:
            fixture = Path(directory).resolve()
            self.assertTrue(fixture.is_relative_to(temporary_root))

            def git(*args):
                subprocess.run(
                    ["git", "-c", "core.excludesFile=", "-c", "user.name=Hook Test",
                     "-c", "user.email=hook-test@example.invalid", *args],
                    cwd=fixture, check=True, capture_output=True, timeout=15,
                )

            configs = fixture / "configs"
            configs.mkdir()
            config = configs / "brand.json"
            config.write_text('{"name":"committed"}', encoding="utf-8")
            git("init", "-q")
            git("add", "configs/brand.json")
            git("commit", "-qm", "Seed config fixture")

            def check_sources():
                return run_powershell(
                    f". '{SCRIPT}'; Set-Location '{fixture}'; Assert-PrePushSourcesCommitted"
                )

            self.assertEqual(check_sources().returncode, 0)
            config.write_text('{"name":"local masking value"}', encoding="utf-8")
            self.assertNotEqual(check_sources().returncode, 0)
            git("restore", "--", "configs/brand.json")
            (configs / "local.json").write_text("{}", encoding="utf-8")
            self.assertNotEqual(check_sources().returncode, 0)

    def test_failed_command_blocks_push(self):
        result = run_powershell(
            f". '{SCRIPT}'; "
            "try { Invoke-PrePushCommand powershell @('-NoProfile', '-Command', 'exit 7'); exit 99 } "
            "catch { [Console]::WriteLine($_.Exception.Message); exit 0 }"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("exit 7", result.stdout)

    def test_check_failure_stops_later_checks_and_restores_environment(self):
        for failing_call in (1, 2, 3):
            with self.subTest(failing_call=failing_call):
                result = run_powershell(
                    f". '{SCRIPT}'; "
                    "$env:PYTHONPATH = 'preserved-check-path'; $before = (Get-Location).Path; "
                    "$script:checkCalls = 0; "
                    "function Get-PrePushPython { 'qa-python' }; "
                    "function Invoke-PrePushCommand($FilePath, $ArgumentList) { "
                    f"$script:checkCalls++; if ($script:checkCalls -eq {failing_call}) {{ throw 'check failure' }} "
                    "}; "
                    "try { Invoke-PrePushChecks; exit 99 } catch { "
                    "if ($_.Exception.Message -ne 'check failure') { throw } }; "
                    "@{ calls=$script:checkCalls; restoredPath=$env:PYTHONPATH; "
                    "restoredDirectory=((Get-Location).Path -eq $before) } | ConvertTo-Json -Compress"
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                state = json.loads(result.stdout.strip().splitlines()[-1])
                self.assertEqual(state["calls"], failing_call)
                self.assertEqual(state["restoredPath"], "preserved-check-path")
                self.assertTrue(state["restoredDirectory"])

    def test_success_requires_all_check_groups(self):
        result = run_powershell(
            f". '{SCRIPT}'; $script:checks = @(); "
            "function Get-PrePushPython { 'qa-python' }; "
            "function Invoke-PrePushCommand($FilePath, $ArgumentList) { "
            "$script:checks += @{ program=$FilePath; arguments=$ArgumentList } }; "
            "Invoke-PrePushChecks; ConvertTo-Json -InputObject $script:checks -Compress"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        checks = json.loads(result.stdout.strip().splitlines()[-1])
        self.assertEqual(len(checks), 3)
        self.assertIn("typecheck", checks[0]["arguments"])
        self.assertIn("--test-concurrency=1", checks[1]["arguments"])
        self.assertEqual(checks[2]["program"], "qa-python")
        self.assertIn("backend.test_update_activity", checks[2]["arguments"])


if __name__ == "__main__":
    unittest.main()
