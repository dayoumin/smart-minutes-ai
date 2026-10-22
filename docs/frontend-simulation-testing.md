# Frontend Simulation Testing

## Separate web/desktop records — 2026-10-22

`simulate-dual-runtime-isolation.mjs` requires an explicit local `APP_URL` and
does not start a server. Run from `D:\Projects\LMO_audio`:

```powershell
$env:COREPACK_HOME='D:\Projects\LMO_audio\.cache\corepack'
$env:PLAYWRIGHT_BROWSERS_PATH='D:\Projects\LMO_audio\.cache\ms-playwright'
$env:APP_URL='http://127.0.0.1:5197/'
corepack pnpm --dir desktop-app test:dual-runtime-isolation
```

The dedicated Vite command is `corepack pnpm --dir desktop-app exec vite --host
127.0.0.1 --port 5197 --strictPort --configLoader runner`, repository-root cwd.
HTTP200 and title `LMO 회의록` identify the source UI before trusting the check.
The sandboxed server listened but timed out at initial navigation; the same
command with focused elevated permissions answered immediately. This was an
environment boundary, not a product failure. Only this session's Vite was
stopped/restarted; no installed engine or other server was stopped.

| Scenario | Observed result |
| --- | --- |
| Same record/job IDs, different titles/body in two Chromium contexts | Each context shows its own record |
| Repository edit, reload and new-page reopen | Each record retains its own changed title/body |
| Web deletion while its mocked engine is offline | Only web record removed; only web cleanup queue receives the job |
| Reconnect and flush web cleanup | DELETE reaches17863 with browser session; desktop record/queue unchanged |
| Desktop deletion while web record exists again | DELETE reaches17864 with desktop token; web record persists through reload |

The scenario passed with no page errors, foreign-engine requests or mutation
credential violations. It uses the actual repository/deletion modules and
visible record reopening, with programmatic fixture edits and deletion calls;
it does not claim an end-to-end test of editing/deletion UI controls. The native
bridge and both engines are mocked, and Chromium contexts model storage profiles.
Separate Chromium contexts never share IndexedDB, so the store-separation rows
cannot fail on their own; the routing and credential checks are what this run
can catch. A later same-day rerun through the `web-ui-sim` launch entry
(port 5196, HTTP200 and title checked) passed again: 42 web calls only to 17863,
25 desktop calls only to 17864 with the desktop token, and the three DELETEs
matched the table.
Real WebView persistence, process termination, installed-engine processing and
updates remain executable QA gates.

Rust's actual socket tests cover web-first coexistence, desktop-first while the
web port is idle, skipping an occupied desktop port and exhausting all100
preferred ports before OS fallback. All4 pass; output explicitly confirmed the
desktop-first branch was exercised on this run. Existing external port owners
are never stopped. These tests do not replace native executable startup tests.

## Collapsible app menu — 2026-10-22

Approved editable Figma states are linked from `docs/design.md` (E board
`49:1740`). The source uses one Sidebar instance, a permanent sidebar slot and
an unchanged main element. Wide windows remember 240px/56px navigation;
windows under 1200px use a 56px rail with a 240px overlay and scrim. The
overlay makes the workspace inert, cycles Tab focus, and closes on selection,
Escape or the scrim. Settings opens from a connected rail button so closing
the settings dialog restores focus. Resume dots have an accessible description.

Commands run serially from `D:\Projects\LMO_audio` using
`COREPACK_HOME=D:\Projects\LMO_audio\.cache\corepack`,
`PLAYWRIGHT_BROWSERS_PATH=D:\Projects\LMO_audio\.cache\ms-playwright`,
and `APP_URL=http://127.0.0.1:5196/`. The dedicated server command is
`corepack pnpm --dir desktop-app exec vite --host 127.0.0.1 --port 5196
--strictPort --configLoader runner`. It is stopped after checks; the same
command and working directory restore it.

- `corepack pnpm --dir desktop-app typecheck` and changed-file ESLint pass.
- `corepack pnpm --dir desktop-app test:sidebar-collapse` covers remembered wide
  preference/reload, denied preference storage, 1024px columns, overlay geometry,
  Tab/Shift+Tab/Escape, scrim, record/new-record navigation, both resize preference
  cases, main/audio node identity, seek position, uninterrupted playback,
  unsaved title preservation, Settings focus return and the resume description.
  The final expanded narrow assertions were additionally run with `narrow`.
  Settings resize checks cover both rail→expanded and expanded→rail while the
  dialog is open; a persistent focus scope selects the currently visible button.
- `simulate-meeting-detail-layout.mjs` passes the existing metadata, transcript,
  audio/error placement and long-topic scenarios at the relevant widths.
- `simulate-analysis-stop-flow.mjs detail-continuity` passes all four scenarios,
  including the 760px progress entrance and disabled new-record action.
- `simulate-analysis-stop-flow.mjs diarization-continuity` passes at 1280/760px.
- `corepack pnpm --dir desktop-app exec node --experimental-strip-types scripts/simulate-meeting-detail-flow.mjs`
  passes the full module, including the 800px overlay row/folder menus, keyboard
  move/unpin, cross-meeting generation, edit/reopen and latest export payload.

Test fixture/recovery lessons: audio mocks must support Range, HEAD and CORS
headers to prove seeking/playback. Scope title-edit locators to the visible detail
surface because the writer is retained. The back-to-top check retains the
negative threshold assertion but clicks at 1.5 viewports instead of only 30px
past the threshold: diagnostic scroll anchoring moved 750px to 695px during
layout settling and legitimately removed the button below the 720px threshold.
No force-click or threshold change in product code was needed.
The detail-flow module also contained older folder assertions: a row moved into
a closed folder must focus a remaining row, while a row moved back to the
unfiled list keeps its own menu focus. Its empty-folder check now uses the current
paragraph and `회의록이 없습니다.` copy. Storage-preservation checks remain intact.
Unpinning retains the record in the complete unfiled list, checks persisted
`pinned: false` and its new sort position, and retains focus on the current node.
Progress assertions now use the current information-column progressbar, timing
and stop control; accepted stops remove that control rather than retaining an
older disabled button. Existing stop request bodies and preserved results are
still checked.

Independent behavior and test reviewers checked the implementation. The identified
Settings opener-lifetime and resume-description gaps were fixed and rechecked;
targeted final review found no remaining blocker. Original Figma frames, unrelated
work, and prior P2 fixes were preserved. After verification, user approval saved
the source/tests as `b37a990f`; these records are committed separately. No push,
build or deployment ran.

Screenshots are in `.tmp/sidebar-collapse/` (`wide-expanded`, `narrow-rail`,
`narrow-overlay`, plus Figma reference images). These are source-UI Chromium
simulations with isolated storage, synthetic audio and mocked engine APIs;
they do not verify installed-engine inference or a deployed HTTPS build.

## Two-column detail review fixes — 2026-10-22

The meeting information column now stacks stop/cancel explanations above their
wrapping actions, for both analysis and on-demand speaker separation. Detail
scroll targets reserve 8rem above the destination in the workspace so long-topic
jumps and generated-section navigation clear the sticky tabs and padded inset.

The layout simulation now measures the sticky navigation wrapper against the
workspace's padding edge, rather than expecting its inner tabs at viewport zero.
Records with a complete output list without audio retain the `음성 없음` row,
keep the tabs stable, and make no audio request, matching `docs/design.md`.
Long-topic navigation runs at 1280/760px and checks the focused heading below the
navigation; both stop flows check readable text width and contained buttons.

Passed serially from `D:\Projects\LMO_audio`, with Node 22.22.2,
`COREPACK_HOME=D:\Projects\LMO_audio\.cache\corepack`,
`PLAYWRIGHT_BROWSERS_PATH=D:\Projects\LMO_audio\.cache\ms-playwright`, and
`APP_URL=http://127.0.0.1:5196/`:

| Command after `corepack pnpm --dir desktop-app` | Evidence |
| --- | --- |
| `typecheck` | TypeScript passes |
| `exec eslint scripts/simulate-meeting-detail-layout.mjs scripts/simulate-analysis-stop-flow.mjs` | Changed scripts pass |
| `exec node --experimental-strip-types scripts/simulate-meeting-detail-layout.mjs columns` | 1280/1440px columns, sticky navigation and audio visibility |
| `exec node --experimental-strip-types scripts/simulate-meeting-detail-layout.mjs` | Long-topic jumps at 1280/760px, narrow metadata, transcript rows, audio state and error placement |
| `exec node --experimental-strip-types scripts/simulate-analysis-stop-flow.mjs diarization-continuity` | 1280/760px stop choice, focus return, completion and reopen |
| `exec node --experimental-strip-types scripts/simulate-analysis-stop-flow.mjs stop-actions` | Analysis stop and cancel, including readable choices and partial-result preservation |

These are Chromium source-UI checks with mocked APIs and isolated storage; they
do not prove actual engine processing, production HTTPS or packaged runtime.
The session-owned Vite command is `corepack pnpm --dir desktop-app exec vite
--host 127.0.0.1 --port 5196 --strictPort --configLoader runner`, from the repository
root. It is stopped after verification; this command restores it if needed.
Screenshots are kept under `.tmp/merge-review-20261022/`.
The 1280px long-topic destination and 1280/760px stop panels were visually
inspected. Two independent read-only agent reviews covered behavior/scope and
test contracts after the passing checks; neither found a remaining blocker.

## Full local-processing notice — 2026-10-21

Removed the compact intro and its expand/collapse control. Intro and help show
the same four detail rows; only the web intro explains first-use preparation.
The footer stays visible while the body scrolls. Independent review found a
keyboard access gap in the new scroll body; a named focusable region and focus
ring resolved it, and source re-review found no remaining blocker.

Follow-up copy review matched the local-processing, internet and setting-aware
storage claims to the relevant source. Deletion now includes deferred cleanup
when disconnected and separately saved files (including automatic copies).
Detail labels align with the first line of their descriptions, including the
longer deletion row; measured top offsets were0px at1280px and760px. The
`intro-dismissal` and `processing-help` scenarios cover the updated layout.

Passed from `D:\Projects\audio` using `corepack pnpm --dir desktop-app`:

- `typecheck`
- `exec eslint src/LocalProcessingNotice.tsx scripts/simulate-local-engine-connection-ui.mjs scripts/simulate-new-record-home-flow.mjs`
- `exec node --experimental-strip-types scripts/simulate-local-engine-connection-ui.mjs`
  with `LOCAL_ENGINE_UI_SCENARIO=intro-dismissal` and
  `APP_URL=http://127.0.0.1:5202/?view=minutes&localEngineConnection=1`
- `exec node scripts/simulate-new-record-home-flow.mjs` with
  `NEW_RECORD_HOME_SCENARIO=processing-help` and `APP_URL=http://127.0.0.1:5202/`

Both browser checks use `PLAYWRIGHT_BROWSERS_PATH=D:/Projects/audio/.cache/ms-playwright`
and mocked/unavailable engine APIs. They cover full details on arrival,
1280×720 and760×720 fit,760×420 scrolling and persistent action, keyboard
scroll to the last row, focus containment/return, all three dismissal paths,
reload suppression, and help without first-use preparation. These checks do
not verify a deployed build or actual local-engine processing.
Screenshots: `.tmp/local-processing-20261021/` (set `LOCAL_PROCESSING_SCREENSHOTS`
to capture them). Preview server: `corepack pnpm --dir desktop-app exec vite
--host 127.0.0.1 --port 5202 --strictPort`, cwd `D:\Projects\audio`; left running
for review. `git diff --check` passed.

## Folder move focus and resume checks — 2026-10-21

The folder scenario now deterministically delays the meetings+folders readonly
IndexedDB transaction after `meetings:updated` while allowing the folders-only
transaction to complete and render first. Before the source fix, the moved row
disappeared and the final keyboard-focus assertion failed. With the fix, focus
returns to the remaining row's menu after the refreshed meeting list commits.
The temporary transaction hook is restored after release. Existing content,
folder assignment, reopen, removal and independent pagination checks remain.

The resume scripts used a removed `.meeting-analysis-complete` class and timed
out even though analysis had completed. They now wait on the current analysis
status; the selected fresh-start scenario also waits for meeting detail. Existing
resume job ID/request flags and final transcript checks remain intact.

Passed serially using `corepack pnpm --dir desktop-app`:

| Command suffix | Verified scope |
| --- | --- |
| `test:meeting-archive-flow` (`ARCHIVE_FLOW_SCENARIO=folders`) | 2 folder scenarios, including controlled focus race |
| `test:resume-flow` | 2 reuse/fallback scenarios |
| `test:resume-draft-flow -- suppressed-resume-candidate selected-resume-fresh-start` | 2 draft/fresh-start scenarios |
| `exec node node_modules/typescript/bin/tsc --noEmit` | TypeScript |
| `exec node node_modules/eslint/bin/eslint.js src/Sidebar.tsx scripts/simulate-meeting-archive-flow.mjs scripts/simulate-resume-flow.mjs scripts/simulate-resume-draft-flow.mjs` | Changed source/scripts |

The existing `.bin` shims, TypeScript, ESLint and Babel package were present on
this PC; no dependency install or lockfile change was needed. Independent review
found no blocking issue in the source change or the updated resume assertions.

Environment: `COREPACK_HOME=D:\Projects\LMO_audio\.cache\corepack`,
`PLAYWRIGHT_BROWSERS_PATH=D:\Projects\LMO_audio\.cache\ms-playwright`,
`APP_URL=http://127.0.0.1:5198/`. The session-owned server command from
`D:\Projects\LMO_audio` was `corepack pnpm --dir desktop-app exec vite
--host 127.0.0.1 --port 5198 --strictPort --configLoader runner`.
The first sandboxed server announced readiness but was unreachable from separate
checks; the simulation timed out before entering its scenario. That server was
stopped and a focused elevated start made HTML, main module and CSS return 200.
Only the replacement session-owned server is used for the passing runs.
After verification, that server was stopped through its own terminal session;
the selected URL was confirmed unreachable. The same command restores it when needed.

These are Chromium source-UI simulations with mocked APIs and isolated browser
storage. They do not prove real local-engine inference, installed-engine behavior,
production HTTPS permissions or other-PC installation.

## Merged-source browser verification and startup timeout — 2026-10-21

Verified merged source `8451d701` in `D:\Projects\LMO_audio` after the earlier
engine-update simulation timed out at its first `page.goto(..., networkidle)` with
zero scenarios executed. The earlier report had no request-level trace, so the
exact request responsible for that timeout cannot be identified retrospectively.

The fresh diagnostic Vite server needed 21,598ms to become ready. An initial
`/src/index.css` request exceeded a 15-second HTTP deadline; after loading, HTML,
`/src/main.jsx`, and CSS returned 200 in 834ms, 58ms, and 26ms respectively. This
establishes slow initial development-server loading, while the initial HTML-only
readiness check does not establish that the UI modules/styles are ready. Available
physical memory was 14.2% during the check; this alone does not establish memory
pressure as the cause. No dependency reinstall, product change, test assertion
change, or timeout increase was needed.

The unchanged engine-update script passed all seven scenarios against the prepared
server, with no page errors. A second run without `APP_URL` also passed all seven
scenarios through its original automatic-server startup and cleanup path
(`cleanupExit: 0`). The original failure did not recur in these runs.

The following checks ran serially with `COREPACK_HOME=D:\Projects\LMO_audio\.cache\corepack`,
`PLAYWRIGHT_BROWSERS_PATH=D:\Projects\LMO_audio\.cache\ms-playwright`, Node 22.22.2,
and Corepack pnpm 10.33.2. The session-owned server command, from the repository
root, was `corepack pnpm --dir desktop-app exec vite --host 127.0.0.1 --port 5197
--strictPort --configLoader runner`. Its title was confirmed as `LMO 회의록`.
`APP_URL` used this server's root, `/?view=minutes`, or
`/?view=minutes&localEngineConnection=1` as appropriate.

| Command after `corepack pnpm --dir desktop-app` | Passed scenarios |
| --- | --- |
| `exec node scripts/simulate-local-engine-update.mjs` | 7: old/unpaired/latest/newer engines, missing metadata, engine off, browser block; download/model priority and stable 1280/760px controls |
| `test:analysis-stop-flow detail-continuity` | 4: preparation/running/completion/reopen at 1280/760px, background completion, narrow-window audio-source failure |
| `test:analysis-stop-flow diarization-continuity` | 2: participant progress, stop choice, completion and reopen at 1280/760px |
| `test:meeting-archive-flow` with `ARCHIVE_FLOW_SCENARIO=folders` | 2: keyboard move/reopen/removal and folder pagination/content preservation |
| `test:folder-recovery` | 3: initial read failure, refresh failure/focus recovery, explicit retry and stored assignment preservation |
| `test:meeting-cleanup-flow` | 3: selected cleanup, unresponsive record deletion, unresponsive PC-file deletion and settings unlock |

All 21 distinct scenarios passed; the seven update scenarios additionally passed
the automatic-server rerun. Evidence is under `.tmp/browser-verification-20261021/`:
`engine-update/simulation-report.json`, `engine-update-auto/simulation-report.json`,
update screenshots, and the `analysis/` screenshots. The 760px update and completed
detail screenshots were also visually inspected. The dedicated server was stopped
after verification; the automatic run stopped only its own server.

These checks use isolated Chromium storage and mocked engine/download responses.
They do not analyze user audio, execute an installer, or delete user files. Actual
HTTPS Chrome/Edge permission prompts, organization policy, other-PC installation,
and the existing long-summary failure remain in the existing release QA table in
`docs/web-runtime-separation-implementation-plan.md`; these source UI passes do not
close those gates.

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

## Analysis detail continuity — 2026-10-21

Run `corepack pnpm --dir desktop-app test:analysis-stop-flow detail-continuity` with
`PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`. It checks that preparation,
running, completion, and reopening use the same detail element and keep the title, tabs,
search, and transcript controls at the same coordinates. It also verifies that a temporary
preview is not saved, meeting input/report choice survives, unsaved result edits remain guarded,
and background completion does not replace another open meeting. Set
`ANALYSIS_CONTINUITY_SCREENSHOT_DIR` to an existing folder for 1280px/760px screenshots.
Run the existing stop/cancel cases narrowly with `test:analysis-stop-flow stop-actions`;
`preparation` covers stopping before the engine accepts a job. These use mocked API responses
and isolated browser storage, and do not prove installed-engine analysis quality.

The same focused scenario also checks the bordered information group, metadata-only source row,
persisted elapsed time, the full participant list, and the conditional back-to-top control.
The control must stay absent before one viewport of scrolling and on short records, appear on
long records after that threshold, and restore the title's keyboard focus when returning.
Both 1280px and 760px cases exercise this against the actual workspace scroll container.

### Actual speech verification — 2026-10-21

The real-input run used the registered `real_detail_continuity_wav_3m_20261021` sample:
180.001125 seconds of genuine speech, mono 16kHz WAV, 5,760,184 bytes. The source Windows
engine ran actual speech recognition and speaker separation without API mocks, producing
37 raw segments / 6 display segments in 172,854ms. Job ID:
`02a0fe52-84cd-49d4-ba0b-a02091d709bb`. Automatic summary generation was disabled; this
does not assess transcript/speaker accuracy or summary quality.

The initial run captured preparation/running at 1280×720 and 760×720 and saved the real
result, then correctly failed its coordinate assertion: the audio-check error's retry button
expanded a 36px row to 40px, moving the tabs/search/actions down 4px. The audio row now
reserves 40px in every state, with a 32px retry control. The focused
`corepack pnpm --dir desktop-app test:analysis-stop-flow detail-continuity` regression passed
all four mocked cases: foreground 1280/760, background 1280, and audio failure 760.
`corepack pnpm --dir desktop-app typecheck` and independent review also passed.

After the correction, the same real saved result was reopened against the real source engine,
without another transcription or response mocks. Native audio playback advanced, with HEAD
200 / GET 206. Reload and sidebar reopening preserved the stored meeting fields, report
template, segments, elapsed time and source metadata, and kept the title/tabs/search/actions
at identical coordinates in both widths. Fonts and resize rendering were allowed to settle
before measuring. The long-content threshold was met by the actual unmodified transcript:
1445px / 1986px of detail content against a 720px workspace at 1280px / 760px respectively.
The back-to-top control was absent at the top and before one viewport of scrolling, appeared
after that threshold, stayed inside the viewport, returned to scroll position zero, disappeared,
and focused the meeting title. Reduced-motion operation and absence of horizontal overflow
also passed. Reopening made zero new `/api/analyze` POST requests.

Evidence is under `.tmp/real-detail-continuity-20261021`: `verify.mjs`, `continue.mjs`,
`serve.py`, initial `evidence/report.json` (the retained 4px failure), actual SSE/record and
running screenshots, plus `evidence/followup/report.json` (`status: passed`) and saved,
reopened and scrolled screenshots. The focused mock regression verifies the corrected full
state transition; the real-result follow-up verifies playback/storage/reopening/scrolling.
The full three-minute recognition was not repeated after the CSS-only correction.

Commands were `node .tmp/real-detail-continuity-20261021/verify.mjs` and then
`node .tmp/real-detail-continuity-20261021/continue.mjs`, with
`PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`. These helpers launched
Vite from `desktop-app` on `127.0.0.1:54352` and the isolated source engine from the repository
root on `127.0.0.1:54351`, using `backend/.venv-desktop/Scripts/python.exe`; exact child
commands are retained in `runtime.json`. Both helpers cleaned up their own servers/browser.
The existing installed engine on port 17863 was left running. This verifies current Vite UI
with actual local processing, not the public HTTPS UI or an updated installed executable.

### Production HTTPS and installed engine — 2026-10-21

The approved meeting-detail changes are deployed at `https://barorok.ecomarin.workers.dev`,
Worker version `507b5d5c-e2d2-42da-8ccf-90773272e448`. The build snapshot starts from
`02e30d3` and includes only the detail workflow, its dependencies and related Sidebar/CSS
changes. Unrelated in-progress font/folder/menu changes are excluded. Candidate typecheck,
changed-file ESLint, the four `test:analysis-stop-flow detail-continuity` cases, production
web build, dry run and independent review passed. All six public files matched their local
SHA256 values, and the existing 0.1.9 installer metadata, HEAD/Range and three old download
redirects remained valid. No installer/backend update or Git commit/push was performed.

The actual browser used the public HTTPS origin and the existing installed
`barorok-local-engine-x86_64-pc-windows-msvc.exe`, PID 13700, version
`0.1.9-beta-20261020`, with backend configuration in
`C:\Users\MS\AppData\Local\Barorok\LocalEngine\config`. Existing settings were retained:
CPU speech recognition, with speaker separation deferred until requested from the result.
There were no API mocks. The isolated Chromium profile received an automated
`local-network-access` grant; this is not evidence for a human permission dialog or Edge.

The first real three-minute result completed in 76,744ms and preserved completion/reopening
anchors and playback, but its 1392px detail was below the 1440px long-content threshold at
1280×720. A registered genuine five-minute derivative then exercised the long threshold.
Visual inspection of that first long run found the deferred-speaker and audio guidance
clipped inside the 96px status reservation. All states now reserve 144px, and the four
focused continuity cases passed again. The final deployed build was tested with a new
actual five-minute analysis, not just a replay of the old result:

- Input: `production_detail_continuity_wav_5m_20261021`, 300s mono 16kHz WAV,
  9,600,148 bytes, SHA256 `6a068d76486baf2649d4422680fec9a06cc1ee27745545a30cdd54a8be7662ff`.
- Job: `ccf8fdaa-a0f4-4abc-9dc8-ec3499f2caf0`; 128,975ms; 64 raw / 8 display segments,
  2170 transcript characters. Speaker separation remained deferred; accuracy/summary quality
  were not assessed.
- At 1280×720 and 760×720, preparation, actual STT progress, completion and reload/sidebar
  reopening retained the title/tab/search/action coordinates. The same detail DOM survived
  completion. The completed guidance fit without internal clipping in both widths.
- Reload/reopening preserved the complete tested record snapshot, including report template,
  segments, purpose, elapsed time and source metadata. Saved backend text and timestamps
  (normalized to the frontend format), job, purpose, report template and deferral state agreed.
  There was exactly one analysis POST in the final journey; all API/write requests used
  `http://127.0.0.1:17863`.
- Genuine detail heights were 2016px / 2792px against a 720px workspace. The top button was
  absent initially/before one viewport of scrolling, appeared beyond it, remained in view,
  returned to position zero, disappeared and focused the title. Reduced motion and no
  horizontal overflow passed. Native audio playback also advanced through the real HTTPS
  browser bridge.

Evidence root: `.tmp/production-detail-20261021`. Read `source-manifest-r2.json`,
`deploy-r2.log`, `public-verification-r2.json`, `final-audit.json`, and
`evidence/final-5m/{actual-report.json,completed-record.json,analysis-sse.txt,*-1280.png,*-760.png}`.
The retained earlier reports include an unnecessary settings-200 wait before connection,
an incorrect expectation of immediate speaker separation, and the below-threshold short
record; these test assumptions are separate from product failures. The initial long-run
captures and first deployment are retained to show the corrected guidance clipping.

Execution used `node .tmp/production-detail-20261021/final.mjs` with the project-local
`PLAYWRIGHT_BROWSERS_PATH`. Deployment used `node deploy/cloudflare/wrangler.mjs deploy
--config D:/Projects/audio/.tmp/production-detail-20261021/wrangler-r2.jsonc`; exact build
source/assets and rollback to `09a485ac-a9a0-45d7-9335-22d0fa7fd62c` are recorded in the
manifests. The helper closed only its own browser and left the original installed engine
running. No Vite/source engine was used in the final journey.

### Short actions and actual speaker completion — 2026-10-21

The next production revision, `78920e1e-5898-4fdd-8592-70825d30b3d0`, changes the visible
transcript actions to `복사`, `대화록`, and `편집`. The download control retains its descriptive
accessible name. Its isolated build extends the preceding approved snapshot; unrelated
font/folder/menu changes remain excluded. All six public assets matched local SHA256 values,
and the existing installer metadata, three download redirects and HEAD/Range checks passed.
The installed engine and its settings were not updated.

Actual on-demand speaker separation first completed for the existing five-minute job
`ccf8fdaa-a0f4-4abc-9dc8-ec3499f2caf0`: 64 raw / 10 display segments, two model speaker IDs,
`diarizationApplied=true`, `diarizationDeferred=false`. This exposed a running-state defect:
the separate progress panel pushed shared navigation down. Progress now occupies the existing
144px status reservation, with one icon-only stop control. Explicit stop choices can expand
the region. Keyboard focus follows execute → stop → choice → continue; completion restores
the title only if progress still owned focus, preserving the reading position otherwise.

The final deployed revision then ran actual speaker separation on the existing three-minute
job `ad1bae08-a4e2-440d-87a4-386e85f99395`, without new transcription or API mocks:

- Real installed-engine progress changed from processing 30% to completed 100%; the result
  contains 37 raw / 6 display segments and two model speaker IDs. The native progress interval
  was about 43 seconds; the measured browser journey to result was 49,991ms.
- At 1280×720 and 760×720, before/running/completed/reopened title, information group,
  tabs, search and transcript actions retained their coordinates. Progress had one stop
  control and fit inside the status region. Completion feedback used an overlay toast.
- Reload/sidebar reopening preserved the entire canonical stored record, including speaker
  segments/flags, source metadata, purpose, report template and original analysis elapsed
  time; SHA256 `f75f450645d860fcf1a5a22cb6b0a71550ecb61db47411409c99073a850abe2c`.
  Transcript text was unchanged after whitespace normalization.
- The earlier five-minute speaker result also survived the final deployment unchanged
  (record SHA256 `b0cad271c771747d80f0bdec4aa6e89c2891f061cc398f3f302a4f607040eceb`).
  Its actual long transcript passed conditional top-button visibility, return-to-top and
  title focus at both widths. All API/write traffic remained on `127.0.0.1:17863`.

Focused checks passed: `corepack pnpm --dir desktop-app typecheck`, changed-component
ESLint, `test:edit-guard-flow`, `test:analysis-stop-flow diarization-continuity` (both widths,
including stop choices and completion focus/reading-position preservation), and the four
`test:analysis-stop-flow detail-continuity` cases. These simulation cases use mocks and are
distinct from the actual installed-engine runs above. Candidate web build, dry run and
independent review passed. No new transcription POST occurred in either speaker-only run.
These results verify execution and persistence, not human-reference speaker accuracy.

Evidence root: `.tmp/participant-completion-20261021`. Deployment and source isolation are
recorded in `source-manifest-r2.json`, `deploy-r2.log` and `public-verification-r2.json`.
`actual.mjs` / `evidence/report.json` retain the first five-minute run;
`final.mjs` / `evidence/final-3m/report.json` record the corrected production flow and both
stored results, with running/completed/reopened/scrolled PNGs. `final-audit.json` summarizes
the deployed revision and persisted backend results. Execution used the existing isolated
Chromium profile with an automated local-network-access grant; Edge and human permission
dialogs remain outside this evidence. Only the test browser was closed; original engine
PID 13700 was left running. No Git commit/push or installer build was performed.

### Transcript badges beside the speaker — 2026-10-21

Production revision `0a0c4837-967b-495e-b3d8-f47467719fd6` moves `시간 추정` and
`참석자 확인 필요` beside the speaker name. Only four transcript CSS rules differ from
the preceding approved production snapshot; narrow layout wraps when needed. A candidate
browser check at 1280/760 used the saved real five-minute transcript with mocked API replies,
plus a synthetic long-name/two-badge boundary. Single badges shared the name line; names and
badges did not overlap or overflow, including edit mode. Independent review and web build
passed. The deployed six files matched local SHA256 values and installer links stayed valid.

The public HTTPS UI then reopened both actual three/five-minute two-speaker records without
API mocks. Badge placement passed at 1280/760, reload preserved both complete JSON-normalized
records, and no new transcription/speaker generation was requested. The first check compared
raw IndexedDB objects against JSON and stopped on extra `undefined` optional fields; the
retained retry normalizes that serialization difference without removing substantive fields.
Evidence: `.tmp/speaker-badges-20261021/{source-manifest.json,deploy.log,public-verification.json}`,
`evidence/report.json` (candidate) and `production/report.json` (actual saved results), with
screenshots. The helper closed its own browser/server; installed engine PID 13700 stayed running.

### Precise review intervals and playback — 2026-10-21

The installed/production follow-up is `.tmp/release-review-20261021/verify-actual.mjs`.
It ran the genuine three-minute WAV through deployed HTTPS and installed engine
`0.1.10-beta-20261021`, then on-demand native speaker separation (job
`9e7f4212-a493-4d9b-b32e-282075098460`, 37 raw / 6 display, two speaker IDs).
Both 1280/760 widths retained detail anchors, the 54.72–60.00 review interval/reason,
native seek/play/end stop, full-record reload/reopen and long-transcript top navigation.
The actual TXT note contains the same interval and reason; installed four-format exports
were also checked with the earlier actual speech record payload. Backend result metadata
matches browser storage and its SHA did not change after playback/export. Existing three
test-profile records remain identical. Read the report, completed record and screenshots in
`evidence/`, installer/public manifests and `final-preservation.json`. The latter distinguishes
installer-time full preservation from an unattributed later change to a different existing
meeting's five output files; no write to that job occurred in this browser trace. Do not
claim the entire shared output directory stayed immutable during concurrent use.
The helper records submission provenance and refuses duplicate inference or reuse without
the matching input SHA, generating engine version and job ID. No API or media mocks were
used. Chromium local-network permission was granted to the task profile; human Chrome/Edge
permission prompts, naturally unassigned speakers and human accuracy calibration remain
separate QA. The installed engine remains running; temporary uploader credentials/Worker
and the verification browser were removed.

`corepack pnpm --dir desktop-app test:meeting-detail-layout review` runs only the
1280/760 review scenarios. It checks precise ranges/reasons after grouping, UNKNOWN with
an explicit empty issue list, tiny-correction suppression, keyboard details, reload, and a
held old-meeting play rejection while the next meeting plays/stops a fixture WAV. The audio
endpoint is mocked; this does not assess native speaker accuracy. New-meeting details/audio
are keyed to their owner, and source changes invalidate old playback requests before paint.
`corepack pnpm --dir desktop-app exec node --experimental-strip-types scripts/test-transcript-review.mjs`
checks pure adapters, including old/new mixed metadata, and `test:export-consistency` checks
local text/payload parity. Both retained legacy flags and explicit v1 empty issue lists are
covered. New records preserve numeric original `reviewIssues` through API, storage and export.

The actual run `.tmp/review-intervals-native-20261021/verify.mjs` used isolated source engine
51801 and Vite 51802 with the genuine registered three-minute sample. Job
`0957c11c-237c-4b0f-a175-3beb11d0060c` completed real STT + speaker separation: 37 raw / 6 display
segments, two speaker IDs, 208,296ms. The actual 40ms chunk correction did not create a badge;
the 2.04s correction retained one `timestamp_adjusted` issue at 54.72–60.00 seconds. Both widths
passed native seek/play/automatic stop, details fit, complete/reopen record preservation,
stable shared controls, actual long-transcript top navigation and TXT review-note export.
`followup.mjs` reran playback/reopening/export with the final UI and the same saved result,
with zero new inference requests. The first follow-up used a different origin port and could
not see the existing IndexedDB record; the retained `port-origin-attempt1.json` documents that
test setup mistake. The helper then reused the verified-free original ports and passed.

Read `evidence/report.json`, `evidence/followup/report.json`, completed JSON, actual SSE,
`review-reasons-1280.png` / `review-reasons-760.png` and `actual-export.txt`. The backend and
browser settings are isolated; only task-owned servers/browser were closed. The installed
engine PID 13700 was unchanged. This is source-engine evidence; no installed binary update
or public deployment was performed for this change. Human-reference speaker accuracy remains
unassessed; the genuine sample has no unassigned turns, so that path has separate boundary
and mocked UI evidence rather than an invented actual-audio case.

On this Windows PC, some scenario assertions finish while browser-context shutdown remains
pending. Keep the logged assertion results separate from the process exit status; inspect the
test's own PID and Vite port before cleaning up only that run. If native `taskkill.exe` reports
`Access denied` for the verified test tree, treat shutdown as a sandbox permission boundary:
use a focused elevated cleanup/retry instead of changing product code or repeatedly rerunning
the same sandboxed scenario. The scripts close inherited
server output pipes during normal cleanup so exited launchers do not retain those handles.

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

## Folder list preservation — 2026-10-18

`test:meeting-archive-flow` includes folder creation with other folders expanded or collapsed,
later assignment/movement/removal through the record menu, persistent visibility of unfiled records,
reload persistence and a failed move after another window deletes the target folder. The move
submenu is exercised with mouse hover/click and keyboard Right/Up/Down/Enter, Left/Escape return,
and focus restoration. It compares
actual IndexedDB records to check content preservation; backend responses are mocked. Run only
this scenario with `ARCHIVE_FLOW_SCENARIO=folders`, the intended Vite `APP_URL`, and the existing
project-local `PLAYWRIGHT_BROWSERS_PATH`. This checks browser UI/storage, not the packaged engine.

The folder scenario also checks independent expansion, 5/10/12 and 5/7 item batches,
keyboard focus when the last `더 보기` disappears, an empty folder, all 11 unfiled records,
and shared vertical scrolling above fixed settings at 760×480 (2026-10-19).

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
