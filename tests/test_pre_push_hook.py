import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest
from contextlib import contextmanager
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts" / "check_pre_push.ps1"


def isolated_git_environment() -> dict[str, str]:
    # A hook exports repository/worktree variables; fixture Git must use its own cwd.
    return {key: value for key, value in os.environ.items() if not key.upper().startswith("GIT_")}


def run_powershell(source: str, *, cwd=ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["powershell", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command",
         "$ErrorActionPreference = 'Stop'; " + source],
        cwd=cwd, env=isolated_git_environment(), capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=30,
    )


@contextmanager
def fixture_repository():
    temporary_root = (ROOT / ".tmp").resolve()
    temporary_root.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="pre-push-scope-", dir=temporary_root) as directory:
        fixture = Path(directory).resolve()
        if not fixture.is_relative_to(temporary_root):
            raise AssertionError("Fixture must stay inside the project temporary directory")

        def git(*args):
            return subprocess.check_output(
                ["git", "-c", "core.excludesFile=", "-c", "user.name=Hook Test",
                 "-c", "user.email=hook-test@example.invalid", *args],
                cwd=fixture, env=isolated_git_environment(), text=True,
                encoding="utf-8", errors="replace", stderr=subprocess.PIPE, timeout=15,
            ).strip()

        for relative, text in {
            ".gitignore": ".tmp/\n", "README.md": "Initial documentation\n",
            "docs/notes.md": "Initial notes\n", "backend/sample.py": "VALUE = 1\n",
            "configs/brand.json": '{"name":"initial"}\n',
        }.items():
            target = fixture / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_text(text, encoding="utf-8")
        for relative in ("scripts/check_pre_push.ps1", ".githooks/pre-push"):
            target = fixture / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(ROOT / relative, target)
        git("init", "-q")
        git("add", ".")
        git("update-index", "--chmod=+x", ".githooks/pre-push")
        git("commit", "-qm", "Initial fixture")
        yield fixture, git


def read_scope(fixture: Path, ref_updates: str):
    result = run_powershell(
        f". '{SCRIPT}'; Get-PrePushScope '{ref_updates}' | ConvertTo-Json -Compress", cwd=fixture,
    )
    if result.returncode:
        raise AssertionError(result.stderr)
    return json.loads(result.stdout.strip().splitlines()[-1])


def run_fixture_hook(fixture: Path, ref_updates: str):
    ref_file = fixture / ".tmp" / "refs.txt"
    ref_file.parent.mkdir(exist_ok=True)
    ref_file.write_text(ref_updates, encoding="utf-8")
    return subprocess.run(
        ["git", "-c", "core.hooksPath=.githooks", "hook", "run", f"--to-stdin={ref_file}", "pre-push"],
        cwd=fixture, env=isolated_git_environment(), capture_output=True,
        text=True, encoding="utf-8", errors="replace", timeout=15,
    )


@unittest.skipUnless(os.name == "nt", "The repository pre-push checks use Windows PowerShell.")
class PrePushHookTest(unittest.TestCase):
    def test_actual_hook_dispatches_selected_groups_in_isolated_repositories(self):
        for changed, expected in (
            ("desktop-app/src/Layout.tsx", ["types", "node"]),
            ("backend/analysis_errors.py", ["backend"]),
            ("configs/brand.json", ["types", "node", "backend"]),
            ("AGENTS.md", ["types", "node", "backend", "hook"]),
        ):
            with self.subTest(changed=changed), fixture_repository() as (fixture, git):
                record = fixture / ".tmp" / "commands.txt"
                record.parent.mkdir()
                script = fixture / "scripts" / "check_pre_push.ps1"
                marker = 'if ($MyInvocation.InvocationName -ne ".") {'
                source = script.read_text(encoding="utf-8")
                self.assertEqual(source.count(marker), 1)
                # Stub tool execution only inside the disposable fixture, never in the real hook.
                recorder = (
                    "function Get-PrePushPython { 'qa-python' }\n"
                    "function Invoke-PrePushCommand([string]$FilePath, [string[]]$ArgumentList) {\n"
                    f"[IO.File]::AppendAllText('{record}', ($FilePath + '|' + ($ArgumentList -join ' ')) + [Environment]::NewLine)\n"
                    "}\n"
                )
                script.write_text(source.replace(marker, recorder + marker), encoding="utf-8")
                git("add", ".")
                git("commit", "-qm", "Fixture command recorder")
                base = git("rev-parse", "HEAD")
                target = fixture / changed
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_text("Changed owned input\n", encoding="utf-8")
                git("add", ".")
                git("commit", "-qm", "Input change")
                head = git("rev-parse", "HEAD")
                result = run_fixture_hook(fixture, f"refs/heads/main {head} refs/heads/main {base}\n")
                self.assertEqual(result.returncode, 0, result.stderr)
                actual = []
                for line in record.read_text(encoding="utf-8").splitlines():
                    if "tests.test_pre_push_hook" in line:
                        actual.append("hook")
                    elif line.startswith("qa-python|"):
                        actual.append("backend")
                    elif "typecheck" in line:
                        actual.append("types")
                    else:
                        actual.append("node")
                self.assertEqual(actual, expected)

    def test_selected_groups_execute_only_their_commands_without_recursive_hook_calls(self):
        for frontend, backend, hook, expected in (
            (True, False, False, ["types", "node"]),
            (False, True, False, ["backend"]),
            (True, True, True, ["types", "node", "backend", "hook"]),
        ):
            with self.subTest(frontend=frontend, backend=backend, hook=hook):
                python_lookup = "'qa-python'" if backend or hook else "throw 'Unexpected Python lookup'"
                result = run_powershell(
                    f". '{SCRIPT}'; $script:calls = @(); "
                    f"function Get-PrePushPython {{ {python_lookup} }}; "
                    "function Invoke-PrePushCommand($FilePath, $ArgumentList) { "
                    "if ($ArgumentList -contains 'tests.test_pre_push_hook') { $script:calls += 'hook' } "
                    "elseif ($FilePath -eq 'qa-python') { $script:calls += 'backend' } "
                    "elseif ($ArgumentList -contains 'typecheck') { $script:calls += 'types' } "
                    "else { $script:calls += 'node' } }; "
                    f"Invoke-PrePushChecks -Frontend ${str(frontend).lower()} -Backend ${str(backend).lower()} -Hook ${str(hook).lower()}; "
                    "ConvertTo-Json -InputObject @($script:calls) -Compress"
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(json.loads(result.stdout.strip().splitlines()[-1]), expected)

    def test_check_plan_uses_owned_paths_and_unions_all_groups(self):
        cases = (
            (["docs/notes.md"], False, (False, False, False)),
            (["desktop-app/src/Layout.tsx"], False, (True, False, False)),
            (["desktop-app/src/index.css"], False, (True, False, False)),
            (["desktop-app/scripts/test-update-activity.mjs"], False, (True, False, False)),
            (["backend/analysis_errors.py"], False, (False, True, False)),
            (["backend/test_storage_preflight.py"], False, (False, True, False)),
            (["desktop-app/src/Layout.tsx", "backend/job_checkpoints.py"], False, (True, True, False)),
            (["configs/brand.json"], False, (True, True, False)),
            (["desktop-app/src/localEngineClientCore.ts"], False, (True, True, False)),
            (["desktop-app/src/meetingRepository.ts"], False, (True, True, False)),
            (["desktop-app/src/UpdateProvider.tsx"], False, (True, True, False)),
            (["desktop-app/src-tauri/tauri.conf.json"], False, (True, True, False)),
            (["backend/main.py"], False, (True, True, False)),
            (["backend/new_module.py"], False, (True, True, False)),
            (["scripts/new_tool.ps1"], False, (True, True, False)),
            (["AGENTS.md", "backend/analysis_errors.py"], False, (True, True, True)),
            (["docs/AGENTS.md"], False, (True, True, True)),
            ([".agents/README.md"], False, (True, True, True)),
            (["scripts/check_pre_push.ps1"], False, (True, True, True)),
            (["tests/test_pre_push_hook.py"], False, (True, True, True)),
            (["docs/notes.md"], True, (True, True, True)),
            ([], True, (True, True, True)),
        )
        # One shell process keeps the matrix cheap; all production classification runs in PowerShell.
        payload = json.dumps([{"paths": paths, "force": force} for paths, force, _ in cases])
        result = run_powershell(
            f". '{SCRIPT}'; $cases = ConvertFrom-Json '{payload}'; $plans = @(); "
            "foreach ($case in $cases) { $scope = [pscustomobject]@{ "
            "DocumentationOnly=((-not $case.force) -and $case.paths.Count -eq 1 -and $case.paths[0] -eq 'docs/notes.md'); "
            "Paths=@($case.paths); ForceCore=$case.force; Reason='matrix' }; "
            "$plans += Get-PrePushCheckPlan $scope }; ConvertTo-Json -InputObject $plans -Compress"
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        for (paths, force, expected), plan in zip(cases, json.loads(result.stdout), strict=True):
            with self.subTest(paths=paths, force=force):
                self.assertEqual(tuple(plan[name] for name in ("Frontend", "Backend", "Hook")), expected)

    def test_scope_collects_frontend_backend_and_hook_changes_across_refs(self):
        with fixture_repository() as (fixture, git):
            base = git("rev-parse", "HEAD")
            frontend = fixture / "desktop-app" / "src" / "Layout.tsx"
            frontend.parent.mkdir(parents=True)
            frontend.write_text("export const layout = 1;\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Frontend")
            frontend_head = git("rev-parse", "HEAD")
            (fixture / "backend" / "job_checkpoints.py").write_text("VALUE = 2\n", encoding="utf-8")
            (fixture / "AGENTS.md").write_text("Workflow guidance\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Backend and workflow")
            head = git("rev-parse", "HEAD")
            refs = (f"refs/heads/main {head} refs/heads/main {frontend_head}\n"
                    f"refs/heads/other {head} refs/heads/other {base}")
            scope = read_scope(fixture, refs)
            self.assertEqual(set(scope["Paths"]), {
                "desktop-app/src/Layout.tsx", "backend/job_checkpoints.py", "AGENTS.md",
            })
            result = run_powershell(
                f". '{SCRIPT}'; Get-PrePushCheckPlan (Get-PrePushScope '{refs}') | ConvertTo-Json -Compress",
                cwd=fixture,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            plan = json.loads(result.stdout)
            self.assertTrue(all(plan[name] for name in ("Frontend", "Backend", "Hook")))

    def test_release_checks_include_the_push_contract_tests(self):
        push = SCRIPT.read_text(encoding="utf-8")
        release = (ROOT / "scripts" / "run_release_checks.ps1").read_text(encoding="utf-8")
        for pattern in (r'"(scripts/test-[^"\n]+\.mjs)"', r'"((?:backend|tests)\.test_[^"\n]+)"'):
            required = set(re.findall(pattern, push))
            self.assertTrue(required, "The parity check must inspect an actual push test list")
            self.assertLessEqual(required, set(re.findall(pattern, release)))

    def test_hook_git_environment_cannot_redirect_fixture_operations(self):
        with patch.dict(os.environ, {
            "GIT_DIR": str(ROOT / ".git"), "GIT_WORK_TREE": str(ROOT),
            "GIT_INDEX_FILE": str(ROOT / ".tmp" / "must-not-write-index"),
            "GIT_CONFIG_COUNT": "1", "GIT_CONFIG_KEY_0": "core.bare", "GIT_CONFIG_VALUE_0": "true",
        }):
            self.assertFalse(any(key.upper().startswith("GIT_") for key in isolated_git_environment()))
            with fixture_repository() as (fixture, git):
                self.assertEqual(Path(git("rev-parse", "--show-toplevel")).resolve(), fixture)
                base = git("rev-parse", "HEAD")
                (fixture / "README.md").write_text("Isolated documentation\n", encoding="utf-8")
                git("add", "README.md")
                git("commit", "-qm", "Isolated docs")
                head = git("rev-parse", "HEAD")
                result = run_fixture_hook(fixture, f"refs/heads/main {head} refs/heads/main {base}\n")
                self.assertEqual(result.returncode, 0, result.stderr)

    def test_documentation_only_range_still_requires_the_checked_out_head(self):
        with fixture_repository() as (fixture, git):
            base = git("rev-parse", "HEAD")
            (fixture / "README.md").write_text("First docs change\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "First docs")
            previous_head = git("rev-parse", "HEAD")
            (fixture / "docs/notes.md").write_text("Second docs change\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Second docs")
            result = run_fixture_hook(fixture, f"refs/heads/main {previous_head} refs/heads/main {base}\n")
            self.assertNotEqual(result.returncode, 0)
            self.assertIn("Push target must match", result.stderr)

    def test_documentation_push_skips_tools_even_with_uncommitted_code(self):
        with fixture_repository() as (fixture, git):
            base = git("rev-parse", "HEAD")
            (fixture / "docs/notes.md").write_text("New documentation\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Documentation only")
            head = git("rev-parse", "HEAD")
            (fixture / "backend/sample.py").write_text("VALUE = 'local work'\n", encoding="utf-8")
            (fixture / "backend/local.py").write_text("# Untracked work\n", encoding="utf-8")
            result = run_fixture_hook(fixture, f"refs/heads/main {head} refs/heads/main {base}\n")
            # The fixture has no frontend install or Python venv: invoking either group would fail.
            self.assertEqual(result.returncode, 0, result.stderr)
            output = result.stdout + result.stderr
            self.assertIn("documentation-only push", output)
            self.assertNotIn("frontend types", output)
            self.assertIn("local work", (fixture / "backend/sample.py").read_text(encoding="utf-8"))

    def test_code_changes_before_last_docs_commit_and_reverts_require_checks(self):
        for revert in (False, True):
            with self.subTest(revert=revert), fixture_repository() as (fixture, git):
                base = git("rev-parse", "HEAD")
                (fixture / "backend/sample.py").write_text("VALUE = 2\n", encoding="utf-8")
                git("add", ".")
                git("commit", "-qm", "Code change")
                if revert:
                    git("restore", "--source", base, "--", "backend/sample.py")
                (fixture / "README.md").write_text("New documentation\n", encoding="utf-8")
                git("add", ".")
                git("commit", "-qm", "Revert or documentation")
                head = git("rev-parse", "HEAD")
                scope = read_scope(fixture, f"refs/heads/main {head} refs/heads/main {base}")
                self.assertFalse(scope["DocumentationOnly"])
                (fixture / "backend/sample.py").write_text("VALUE = 'local work'\n", encoding="utf-8")
                result = run_fixture_hook(fixture, f"refs/heads/main {head} refs/heads/main {base}\n")
                self.assertNotEqual(result.returncode, 0)
                self.assertIn("Commit source changes", result.stderr)

    def test_code_renames_modes_and_automation_are_not_plain_documentation(self):
        cases = ("code_to_doc", "doc_to_code", "executable_doc", "symlink_doc", "config", "agent_readme", "nested_agents", "html", "prompt")
        for case in cases:
            with self.subTest(case=case), fixture_repository() as (fixture, git):
                base = git("rev-parse", "HEAD")
                if case == "code_to_doc":
                    git("mv", "backend/sample.py", "docs/sample.md")
                elif case == "doc_to_code":
                    git("mv", "docs/notes.md", "backend/from-doc.py")
                elif case == "executable_doc":
                    git("update-index", "--chmod=+x", "docs/notes.md")
                elif case == "symlink_doc":
                    blob = git("hash-object", "-w", "docs/notes.md")
                    git("update-index", "--add", "--cacheinfo", f"120000,{blob},docs/link.md")
                else:
                    relative = {
                        "config": "configs/brand.json", "agent_readme": ".agents/README.md",
                        "nested_agents": "docs/AGENTS.md", "html": "docs/index.html", "prompt": "backend/prompt.md",
                    }[case]
                    target = fixture / relative
                    target.parent.mkdir(parents=True, exist_ok=True)
                    target.write_text("Changed input\n", encoding="utf-8")
                    git("add", ".")
                git("commit", "-qm", case)
                head = git("rev-parse", "HEAD")
                scope = read_scope(fixture, f"refs/heads/main {head} refs/heads/main {base}")
                self.assertFalse(scope["DocumentationOnly"])
                if case in ("executable_doc", "symlink_doc"):
                    self.assertTrue(scope["ForceCore"])

    def test_ambiguous_or_mixed_ref_ranges_require_checks(self):
        with fixture_repository() as (fixture, git):
            base = git("rev-parse", "HEAD")
            (fixture / "backend/sample.py").write_text("VALUE = 2\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Code change")
            code_head = git("rev-parse", "HEAD")
            (fixture / "README.md").write_text("Documentation only\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Documentation")
            head = git("rev-parse", "HEAD")
            docs_ref = f"refs/heads/main {head} refs/heads/main {code_head}"
            self.assertTrue(read_scope(fixture, docs_ref)["DocumentationOnly"])
            for updates in (
                "", f"refs/heads/main {head} refs/heads/main {'0' * 40}",
                f"refs/heads/main {head} refs/heads/main {'f' * 40}",
                docs_ref + f"\nrefs/heads/other {head} refs/heads/other {base}",
            ):
                with self.subTest(updates=updates):
                    self.assertFalse(read_scope(fixture, updates)["DocumentationOnly"])
            deletion = f"refs/heads/main {'0' * 40} refs/heads/main {base}"
            self.assertTrue(read_scope(fixture, deletion)["DocumentationOnly"])

    def test_merge_commit_code_changes_require_checks(self):
        with fixture_repository() as (fixture, git):
            original_branch = git("symbolic-ref", "--short", "HEAD")
            git("checkout", "-qb", "docs-side")
            (fixture / "docs/notes.md").write_text("Side documentation\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Side docs")
            git("checkout", "-q", original_branch)
            (fixture / "README.md").write_text("Main documentation\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Main docs")
            base = git("rev-parse", "HEAD")
            git("merge", "--no-ff", "--no-commit", "docs-side")
            (fixture / "backend/sample.py").write_text("VALUE = 'merge resolution'\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Merge with code resolution")
            head = git("rev-parse", "HEAD")
            self.assertFalse(read_scope(fixture, f"refs/heads/main {head} refs/heads/main {base}")["DocumentationOnly"])

    def test_docs_merges_do_not_recheck_code_already_on_the_remote(self):
        for case in ("remote_first", "docs_first", "doc_conflict"):
            with self.subTest(case=case), fixture_repository() as (fixture, git):
                original_branch = git("symbolic-ref", "--short", "HEAD")
                git("checkout", "-qb", "docs-side")
                doc = fixture / ("README.md" if case == "doc_conflict" else "docs/notes.md")
                doc.write_text("Side documentation\n", encoding="utf-8")
                git("add", ".")
                git("commit", "-qm", "Side docs")
                git("checkout", "-q", original_branch)
                (fixture / "backend/sample.py").write_text("VALUE = 'already on remote'\n", encoding="utf-8")
                if case == "doc_conflict":
                    doc.write_text("Main documentation\n", encoding="utf-8")
                git("add", ".")
                git("commit", "-qm", "Existing remote code")
                remote = git("rev-parse", "HEAD")
                merge_branch = "docs-side"
                if case == "docs_first":
                    git("checkout", "-q", "docs-side")
                    merge_branch = original_branch
                if case == "doc_conflict":
                    merge = subprocess.run(
                        ["git", "merge", "--no-ff", "--no-commit", merge_branch],
                        cwd=fixture, env=isolated_git_environment(), capture_output=True, timeout=15,
                    )
                    self.assertEqual(merge.returncode, 1)
                    doc.write_text("Resolved documentation\n", encoding="utf-8")
                    git("add", ".")
                    git("commit", "-qm", "Resolve docs only")
                else:
                    git("merge", "-q", "--no-ff", merge_branch, "-m", "Merge docs with existing remote code")
                head = git("rev-parse", "HEAD")
                scope = read_scope(fixture, f"refs/heads/main {head} refs/heads/main {remote}")
                self.assertTrue(scope["DocumentationOnly"])

    def test_ours_merge_does_not_hide_a_remote_code_regression(self):
        with fixture_repository() as (fixture, git):
            original_branch = git("symbolic-ref", "--short", "HEAD")
            git("checkout", "-qb", "docs-side")
            (fixture / "docs/notes.md").write_text("Side documentation\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Side docs")
            git("checkout", "-q", original_branch)
            (fixture / "backend/sample.py").write_text("VALUE = 'new remote code'\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Remote code change")
            remote = git("rev-parse", "HEAD")
            git("checkout", "-q", "docs-side")
            git("merge", "-q", "--no-ff", "-s", "ours", original_branch, "-m", "Retain earlier parent code")
            head = git("rev-parse", "HEAD")
            self.assertEqual((fixture / "backend/sample.py").read_text(encoding="utf-8"), "VALUE = 1\n")
            self.assertFalse(read_scope(fixture, f"refs/heads/main {head} refs/heads/main {remote}")["DocumentationOnly"])

    def test_failed_or_unrecognized_git_change_output_does_not_skip_checks(self):
        with fixture_repository() as (fixture, git):
            base = git("rev-parse", "HEAD")
            (fixture / "README.md").write_text("New documentation\n", encoding="utf-8")
            git("add", ".")
            git("commit", "-qm", "Documentation")
            head = git("rev-parse", "HEAD")
            for operation, output, exit_code in (("log", "", 1), ("log", "unrecognized output", 0), ("diff", "", 1)):
                with self.subTest(operation=operation, exit_code=exit_code):
                    result = run_powershell(
                        f". '{SCRIPT}'; function git {{ "
                        f"if ($args -contains '{operation}') {{ '{output}'; $global:LASTEXITCODE = {exit_code}; return }}; "
                        "& git.exe @args }; "
                        f"Get-PrePushScope 'refs/heads/main {head} refs/heads/main {base}' | ConvertTo-Json -Compress",
                        cwd=fixture,
                    )
                    self.assertEqual(result.returncode, 0, result.stderr)
                    self.assertFalse(json.loads(result.stdout.strip().splitlines()[-1])["DocumentationOnly"])

    def test_git_hook_reads_the_actual_push_ref_input(self):
        other = subprocess.check_output(
            ["git", "rev-parse", "HEAD^"], cwd=ROOT, env=isolated_git_environment(), text=True,
        ).strip()
        temporary_root = (ROOT / ".tmp").resolve()
        temporary_root.mkdir(exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="pre-push-refs-", dir=temporary_root) as directory:
            fixture = Path(directory).resolve()
            self.assertTrue(fixture.is_relative_to(temporary_root))
            ref_input = fixture / "refs.txt"
            ref_input.write_text(f"refs/heads/other {other} refs/heads/main {'0' * 40}\n", encoding="utf-8")
            result = subprocess.run(
                ["git", "-c", "core.hooksPath=.githooks", "hook", "run", f"--to-stdin={ref_input}", "pre-push"],
                cwd=ROOT, env=isolated_git_environment(), capture_output=True,
                text=True, encoding="utf-8", errors="replace", timeout=15,
            )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Push target must match", result.stderr)

    def test_push_ref_must_match_the_checked_out_commit(self):
        head = subprocess.check_output(
            ["git", "rev-parse", "HEAD"], cwd=ROOT, env=isolated_git_environment(), text=True,
        ).strip()
        other = subprocess.check_output(
            ["git", "rev-parse", "HEAD^"], cwd=ROOT, env=isolated_git_environment(), text=True,
        ).strip()
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
                    cwd=fixture, env=isolated_git_environment(), check=True, capture_output=True, timeout=15,
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
