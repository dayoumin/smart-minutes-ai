# Frontend Simulation Testing

## Local engine update notice — 2026-10-21

Run `corepack pnpm --dir desktop-app exec node --experimental-strip-types --test scripts/test-local-engine-release.mjs`
for version ordering, prereleases, unknown versions, same-origin installer validation, omitted credentials,
unavailable/invalid/cancelled metadata, and connection/model/input priority. Run
`corepack pnpm --dir desktop-app exec node scripts/simulate-local-engine-update.mjs` with
`PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright` for the focused UI simulation.
The default starts its own Vite server on an available port and records its command, directory, port,
PID and cleanup result. `APP_URL` selects an existing URL; `EVIDENCE_DIR` selects the evidence folder.

Production verification passed on Worker `1b1c30f7-5a82-4e12-9522-2feb013f71c4` from isolated source
commit `a88fcf9348281f2a40feebfb5c184c248fb15288`, based on the previously deployed `6e509fe` source.
Only the update notice changes and the already public 0.1.10 release metadata were included; unrelated
working-tree font/folder/UI changes were excluded. The six served asset SHA256 values matched the
built files; installer HEAD/Range and four previous download redirects passed.

The production UI simulation used API/installer-response mocks for seven cases: connected old engine,
old engine before browser connection, latest, newer, metadata unavailable, engine off, and browser block.
It verified the latest download target, uninterrupted compatible-engine use, model readiness priority,
notice disappearance on focus after the simulated install (without clicking `다시 확인`), retained meeting
title, no horizontal overflow, and unchanged `분석 시작` coordinates at 1280px/760px. No audio was analyzed
and the simulated installer was not executed. The pre-deploy local simulation covered six cases before
the old-unpaired case was added. Screenshots/reports: `.tmp/engine-update-20261021/{evidence,public-simulation}`.

Separate actual-runtime evidence used the public website and the installed Windows engine with no API
mocks: 0.1.10 was ready, no update notice appeared, and reload restored the connection. The isolated
Chromium test granted local-network access and revoked its own temporary browser approval afterward;
this does not close the existing human Chrome/Edge/organization-policy QA gate.

The unchanged public `0.1.10-beta-20261021` installer was actually reinstalled over the same version:
exit 0 in 51.05s, installed payload 4,957 file hashes matched, existing settings/results/database 278
observed paths retained SHA256, and models 146 observed paths retained file sizes (not full model hashes;
virtualized aliases may overlap). Restart, automatic connection, exact-Origin rejection and approval
revocation passed. The engine was left running; no inference jobs were submitted. Evidence root:
`.tmp/engine-update-20261021/{release-manifest,installed-verification,public-verification}.json`.
Rollback Worker version: `a2374e43-5d04-40e6-a24a-1be785be30f0`. The engine remains an unsigned test release;
existing signing/other-PC/policy release QA gates are unchanged.

## Folder read recovery — 2026-10-20

Run `corepack pnpm --dir desktop-app test:folder-recovery` with `APP_URL` set to a dedicated
Vite server for this checkout and `PLAYWRIGHT_BROWSERS_PATH` set to its `.cache/ms-playwright`.
The test aborts only folder-list IndexedDB reads: initial failure must expose a retry;
refresh failure must preserve saved folders/meetings; focus and explicit retry must recover
without changing the stored folder assignment or meeting text. It uses synthetic browser data
and mocked API replies, not an installed engine.

## Installed engine automatic connection — 2026-10-20

`test:browser-approval` checks automatic discovery, reload/restart recovery, explicit disconnect,
late completion cancellation, and blocked-storage revocation with the real coordinator.
`test:local-engine-connection-ui` now uses the `browser-connection` protocol without a code dialog.
For the automatic first connection/reload case alone, set `LOCAL_ENGINE_UI_SCENARIO=automatic`.
The mock engine advertises `pairing_mode=browser-connection`; no user confirmation is simulated.
Use the existing `D:\Projects\audio\.cache\ms-playwright` cache. These are UI/API mocks;
actual installed-engine/public HTTPS/browser permission evidence remains a separate release check.

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
- `corepack pnpm --dir desktop-app test:new-record-home-flow`
- `corepack pnpm --dir desktop-app test:meeting-archive-flow`
- `corepack pnpm --dir desktop-app test:runtime-boundary`
- `corepack pnpm --dir desktop-app test:auth-recovery`
- `corepack pnpm --dir desktop-app test:api-auth-boundary`
- `corepack pnpm --dir desktop-app test:export-consistency`
- `corepack pnpm --dir desktop-app test:audio-playback-transport`
- `corepack pnpm --dir desktop-app test:audio-playback`
- `corepack pnpm --dir desktop-app test:audio-back-navigation`
- `corepack pnpm --dir desktop-app test:edit-guard-flow`
- `corepack pnpm --dir desktop-app test:close-guard-flow`
- `corepack pnpm --dir desktop-app test:settings-backend-restart`
- `corepack pnpm --dir desktop-app test:settings-model-management`
- `corepack pnpm --dir desktop-app test:audio-extract-ui`
- `corepack pnpm --dir desktop-app test:template-selection-flow`
- `corepack pnpm --dir desktop-app test:download-scope-flow`
- `corepack pnpm --dir desktop-app test:report-tab-edge-flow`
- `corepack pnpm --dir desktop-app test:writer-model-readiness`
- `corepack pnpm --dir desktop-app test:topic-generation-ui`

Without `APP_URL`, browser simulations start this checkout's Vite on a free port and stop it afterwards, so a server from another worktree on 5173 is never tested by mistake; set `APP_URL` only to reuse a server started from this checkout (`test:audio-playback` always needs it).

## Backend API contract integration

Run `backend/.venv-desktop/Scripts/python.exe -B -X utf8 -m unittest backend.test_authenticated_web_flow`
for thirteen focused ASGI/TestClient and status-normalization tests using the actual main routes and middleware configuration
with enforced auth, test-only HTTPS origins and fresh pairing/session stores. They cover actual
pairing, real-mode analysis admission and SSE (AI inference replaced), sync-record, TXT export,
JSON/audio HEAD/Range and deletion, plus invalid-session/capability denial without file/registry
changes, renewal/revoke/repair and web save-copy denial. The happy path consumes the job IDs and
download URLs returned in the actual SSE result. Files, configuration and registries are isolated;
even a save-copy regression is redirected away from the user's Downloads folder.

The shared test-app helper was renamed to `build_isolated_main_app`. When it changes, also run
`backend.test_local_engine_security`; the two focused modules currently contain 43 tests total.
The A3 additions verify stored TXT after sync, payload-based rebuilding without a result JSON,
canonical generation statuses and derived-result invalidation, failure preservation/non-persistence,
and a TXT write failure followed by retry without losing the saved JSON. Successful generation/sync
paths refresh the transcript as well as document exports.
The actual export endpoints now also check eleven scope/format combinations: transcript TXT;
organized and report MD/DOCX/HWPX; full TXT/MD/DOCX/HWPX. Tests read actual response bytes,
validate UTF-8 text or ZIP CRC/XML/package entries, and check current edited content, included and
excluded sections, cleared labels, report-template snapshots, MIME/attachment filename and an
unchanged stored result JSON. Full TXT keeps all sections without generated Markdown heading/bold
markers, preserves user-authored markup and normalizes explicit scope aliases; legacy scope-free
and transcript TXT retain their prior exact format. Word/Hancom rendered layout is not checked.
These are backend contracts,
not a browser/real JavaScript client journey, HTTP/TLS transport test, real STT quality check or
proof of installed-engine/Tauri/Local Network Access support. No production auth flag is enabled.

## Cross-meeting completion and reopen regression — 2026-10-15

`test:meeting-detail-flow` now releases meeting A's delayed topic response while meeting B remains
open in speaker mode with a search query. It verifies A is saved, B's stored record/search/mode stay
unchanged and A's completion toast is not shown in B. It then returns to A and checks the result
and failure preservation. The other four generation handlers use the same ID guard and received
independent code review; the browser completion scenario directly covers topic generation only.

The final scenario edits transcript text and meeting metadata through the actual UI, saves,
switches to B, reloads and reopens A. It compares actual IndexedDB records and verifies the latest
edited text reaches the export payload. Export/sync API responses in this browser script are
mocked; actual document bytes are checked separately by the backend tests above. Reload within
the same browser context is not proof of cache-independent engine storage or browser-profile loss
recovery.

Verified in Windows with an isolated Vite server started from `D:\Projects\audio`:

```powershell
corepack pnpm --dir desktop-app dev --host 127.0.0.1 --port 5195 --strictPort
$env:APP_URL='http://127.0.0.1:5195'
$env:PLAYWRIGHT_BROWSERS_PATH='D:\Projects\audio\.cache\ms-playwright'
corepack pnpm --dir desktop-app test:meeting-detail-flow
```

The session-owned server is stopped after verification; existing design-AI servers are untouched.

## A4 interaction and keyboard regression — 2026-10-15

The focused A4 pass uses the existing simulations rather than a new end-to-end harness:

- `test:settings-model-management`: dialog focus entry/trapping/return, nested Escape handling,
  settings arrow tabs, 1024×720 overflow/close access and model error/recovery paths. Model action
  menus additionally cover Enter/ArrowDown/ArrowUp opening, enabled-item focus, wrap/Home/End,
  Escape/Tab/Shift+Tab exit, an all-disabled menu, cancelled removal focus and successful removal
  fallback when the trigger disappears. The API is mocked; no model is actually downloaded or deleted.
- `test:edit-guard-flow`: detail and organization-mode arrow/Home/End navigation, one Tab entry
  per tablist, active panel labeling, unsaved-edit generation/download guards and stale-response
  recovery. This checks actual browser focus/ARIA state, not screen-reader speech.
- `test:analysis-stop-flow failure-recovery`: preserve title/file after failure, return focus to the
  title, retry and completion. The new filter selects this existing scenario without running all cases.
- `test:analysis-stop-flow pending-cancellation-transition`: keyboard file chooser, invalid replacement
  preservation, delayed metadata ownership and cancellation-pending lock preservation.

Verified against a session-owned Vite server on `http://127.0.0.1:5196` with the same project-local
Playwright cache shown above. Use `APP_URL=http://127.0.0.1:5196/?view=minutes` for the two
analysis-stop filters and the root URL for settings/edit guard. These are mocked Chromium UI
checks; installed Chrome/Edge, real engine/model processing, native browser zoom and actual
NVDA/Narrator reading remain separate release QA.

## Environment notes

`test:export-consistency` is a focused Node test. It executes the actual pure export builders from
MeetingDownloadControl and the actual repository read normalizer through TypeScript/VM, without
copying the implementation or rendering a browser. Seven cases check explicit empty/partial labels,
legacy absence through serialized-record normalization, stale snake-case labels versus a camel-case
clear, latest/edited/reverted transcript precedence, structured participant names and frontend-only
payload/fallback scopes. This is not an IndexedDB transaction/reopen test or a real-format download.

`test:api-auth-boundary` is a focused Node test, not a browser simulation. It parses current
frontend sources with TypeScript to keep direct fetch calls inside the common transport and
the explicit native bootstrap exception; it also rejects new EventSource/WebSocket/XMLHttpRequest
constructors outside a reviewed boundary. This lexical guard is not a complete data-flow audit.
It runs the actual `apiBase.ts` through an isolated native/fetch adapter to verify authenticated
restart polling, no credential delivery during legacy discovery, failed readiness without native
credentials and no web port scan. The actual App development seed helper runs through the real
common client to check Bearer delivery, encoded IDs and failure handling. AsrBenchmark's two
calls are covered by the source guard/review, not a rendered interaction in this test. Actual
Tauri WebView playback and HTTPS engine connectivity remain separate verification surfaces.

`test:auth-recovery` is a focused Node test, not a Playwright simulation. It exercises the real
client/coordinator/session store with an injected transport: one-shot recovery, overlapping and
late 401 responses, request-body preservation, cancellation, timeout, pairing/revoke precedence,
and no automatic replay after a started SSE or network failure. The existing
`test:local-engine-connection-ui` additionally checks the mounted provider's recovery registration,
the expired UI and preservation of entered fields/files with mocked API responses.

`test:audio-playback-transport` is a focused Node test for the real transport helpers and public
worker: scoped requests, allowed response metadata, progressive delivery, cancellation after
headers, 206/416 preservation and unrelated-route isolation. It does not require a browser.
`test:audio-playback` uses actual native audio controls with a valid 20-second WAV and authenticated
mock API responses in Chromium. It checks playback, completed seeking with continued playback,
meeting transition, invalidation of the old source, no CacheStorage entries and refusal to replace
an existing foreign worker. It requires a running project Vite server; for this checkout:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH='D:\Projects\audio\.cache\ms-playwright'
$env:APP_URL='http://127.0.0.1:5194/?view=minutes'
corepack pnpm --dir desktop-app test:audio-playback
```

Start the documented Vite command on a verified free port before the browser test and use its
actual URL. These checks do not prove actual HTTPS Local Network Access permission, installed
Chrome/Edge support, real local-engine processing or long-file memory behavior.

### Audio after browser Back — 2026-10-19

`test:audio-back-navigation` bundles the actual audio transport into a small production test
document under `.tmp/audio-back-navigation`, serves that document and a separate-origin exit
page on two automatically assigned loopback ports, and closes both servers and Chromium after
the check. It needs the project-local Playwright browser cache above; no existing Vite server or
local engine is used. Its authenticated WAV endpoint is a test fixture, not a running engine.
The Chromium launch explicitly removes Playwright's default BFCache-disabling flag and uses the
full Chromium channel. No live-reload WebSocket or browser request interception is used.

The check plays audio, visits the other origin, and returns with browser Back. It asserts that
`pageshow.persisted` is true and the same document instance survives, then checks the old audio
URL, reloads the native audio element and confirms playback advances. Before the fix the genuine
restore returned 404 because `pagehide` cleared its lease. The fixed transport retains leases
for a persisted page, while explicit disposal and non-persisted `pagehide` still return 404.
The latter cleanup assertion dispatches the lifecycle event directly so its source can be checked
before the document is destroyed. This does not prove whole-app restoration, real HTTPS engine
access, system Chrome/Edge behavior or memory pressure eviction behavior.

Commit-preparation recheck on 2026-10-19 passed: `corepack pnpm@10.33.2 --dir desktop-app
typecheck`, changed-file ESLint, `test:audio-playback-transport` (9 tests), and
`test:audio-back-navigation`. The last check observed a genuine BFCache restore, the old audio
URL returning 200, resumed playback, and 404 after disposal/permanent-departure cleanup.
The existing pnpm cache was selected explicitly after Corepack's sandbox-default cache path
was missing; dependencies were not reinstalled. The same runtime scope limitations above apply.

- These scripts use the project `playwright` package, not the Codex in-app browser.
- On this Windows PC, set the project-local Playwright cache before both installation and
  simulation execution:

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH='D:\Projects\LMO_audio\.cache\ms-playwright'
```

- If a simulation times out at the initial `page.goto` before mocked API calls appear, verify the Vite server separately, check the selected port/processes, and retry with a warmed server before treating it as a product regression.
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
