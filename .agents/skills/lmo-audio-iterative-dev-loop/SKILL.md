---
name: lmo-audio-iterative-dev-loop
description: Use in this repository when the user asks to run an iterative coding loop, 루프를 돌리자, build an unclear or exploratory feature, use agent review with big/small perspectives, decide which P2 findings to defer, or turn a rough goal and concern into implementation, verification, documentation, and commit steps.
---

# LMO Audio Iterative Dev Loop

Use this skill only inside this repository. It helps turn a rough goal into a bounded loop: implement, verify, review, decide, document, and optionally commit.

## When To Use

Use when the user says or implies:

- "루프를 돌리자", "반복해서 개선하자", "agent로 큰 관점/작은 관점 검토하자"
- The goal is exploratory or not fully defined.
- The user gives a concern rather than an exact spec.
- Review findings include P2 items and the user needs triage.

Do not use for tiny one-line fixes, pure answers, or release builds. Release builds use `lmo-audio-release-build`.

## Loop Contract

Before coding, infer and state a short contract:

1. **Goal**: what should be better after this loop.
2. **Concern**: what the user is worried about.
3. **Scope**: the smallest useful surface to change now.
4. **Guardrails**: what must not break or expand.
5. **Verification**: narrow checks that prove the loop worked.
6. **Stop condition**: when to stop instead of endlessly polishing.

Ask at most one clarifying question only if a wrong assumption would change the product direction or risk destructive work. Otherwise choose a conservative first slice.

## Default Loop

1. Read `AGENTS.md` and any directly relevant project doc:
   - UI/copy: `docs/design.md`
   - release/runtime: `docs/tauri-desktop-release-checklist.md`
   - frontend simulation: `docs/frontend-simulation-testing.md`
2. Inspect the current worktree with:
   - `git -c core.excludesFile= status --short --branch --untracked-files=all`
3. Implement the smallest coherent slice.
4. Run narrow verification:
   - frontend: `corepack pnpm --dir desktop-app typecheck`
   - backend: focused `unittest` or `py_compile`
   - UI flow: relevant `desktop-app/scripts/simulate-*.mjs` when worth the browser cost
   - always: `git -c core.excludesFile= diff --check`
5. If the user requested agents, split review into non-duplicate scopes:
   - **Large**: product flow, user understanding, ownership, docs/operations.
   - **Small**: bugs, stale state, disabled states, nulls, tests, copy mismatches.
6. Triage findings:
   - **Fix now**: P0/P1, user-visible confusion, deployment/runtime breakage, data loss, failed tests, or a P2 that directly blocks the current goal.
   - **Defer**: P2 that is real but not needed for the current goal.
   - **Ignore**: speculative, duplicate, or made obsolete by a planned redesign/refactor.
7. Record deferred items only when useful:
   - near-term work: `todo.md`
   - product roadmap: `roadmap.md`
   - repeated operational lesson: `AGENTS.md` or the relevant checklist
8. Stop after one successful loop unless the verification failed, the user explicitly asks for another pass, or a review finding blocks the goal.

## P2 Rule

Do not automatically fix every P2. P2 is a risk signal, not a command.

Fix a P2 now only when it affects this loop's goal, a user-facing flow, release reliability, saved data, or test confidence. Otherwise classify it as deferred and say where it was recorded or why it was left unrecorded.

## Commit Strategy

When the user asks to commit:

- Keep functional changes and planning/docs changes as separate commits when practical.
- Before staging, run status and make sure unrelated user edits are not included.
- If `roadmap.md` or `todo.md` contain useful next-work context, commit them separately unless the user says not to.
- Push only when the user asks to push.

## Final Summary

Keep the final answer short:

- what changed
- what was verified
- what P2 items were fixed/deferred/ignored
- commit/push state if applicable

