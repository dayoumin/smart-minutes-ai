# Frontend Simulation Testing

## Purpose

Use the `desktop-app/scripts/simulate-*.mjs` scripts to verify frontend state transitions that are awkward to cover with manual clicking alone, especially:

- summary/topic/speaker regeneration flows
- unsaved-draft guard behavior
- stale generation (`409`) recovery
- export/download fallback behavior

For the broader user-facing scenario matrix across file length, file type, stop/cancel, and resume behavior, see `docs/user-scenario-test-matrix.md`.

## Current scripts

- `corepack pnpm --dir desktop-app test:generation-flow`
- `corepack pnpm --dir desktop-app test:meeting-detail-flow`
- `corepack pnpm --dir desktop-app test:analysis-stop-flow`
- `corepack pnpm --dir desktop-app test:resume-flow`
- `corepack pnpm --dir desktop-app test:resume-draft-flow`
- `corepack pnpm --dir desktop-app test:edit-guard-flow`
- `corepack pnpm --dir desktop-app test:close-guard-flow`
- `corepack pnpm --dir desktop-app test:settings-backend-restart`
- `corepack pnpm --dir desktop-app test:topic-generation-ui`

## Environment notes

- These scripts use the project `playwright` package, not the Codex in-app browser.
- On a PC that has not installed Playwright browsers yet, run:

```powershell
corepack pnpm --dir desktop-app exec playwright install chromium
```

- In Codex, Playwright browser launch may still need escalated execution even after the browser is installed. If launch fails with `spawn EPERM`, rerun the simulation command with escalation instead of rewriting the test around another browser runtime.

## Preferred debugging order

1. Run `test:generation-flow` first for pure state helpers.
2. Run the targeted Playwright simulation for the UI flow you changed.
3. Only fall back to manual browser clicking when the simulation itself is blocked by environment issues.

## Do not confuse these runtimes

- Codex in-app browser: useful for manual verification in this chat session.
- Project Playwright: used by `desktop-app/scripts/simulate-*.mjs`.

They are not interchangeable. A flow that works in the in-app browser can still fail in project Playwright if the Playwright browser runtime is missing or blocked.
