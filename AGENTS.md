# Project Agent Notes

## Agent Coordination

- When a task explicitly asks for agent-based review, split the work by perspective or surface when useful.
- If the active agent limit is reached, close older idle agents first, then continue with the requested review.
- Prefer clear review scopes such as product-level review, UI/UX review, implementation review, and regression-risk review.

## Audio Performance Work

When changing audio preprocessing, STT quality, diarization quality, or long-file performance:

- Read `docs/audio-performance-improvement-log.md` before changing code.
- Update `docs/audio-performance-improvement-log.md` with lessons, failed attempts, and comparison results.
- Prefer `scripts/run_audio_performance_eval.py` for repeated preprocessing comparisons so future runs use the same report shape. Include `off` in comparisons and use `--clean` when starting a fresh run.
- Use `docs/audio-testset-manifest.csv` for fixed sample comparisons. Add or replace sample rows there before changing evaluation assumptions.
- Keep detailed experiments in the docs, not in this file.
- Do not make a preprocessing mode the default based on one sample.
- Compare STT quality, diarization impact, processing time, and failure risk together.
- Treat denoise and silence trimming as late-stage experiments because they can remove Korean consonants, endings, or quiet speech.

## UI and Copy Work

- Read `docs/design.md` before changing repeated UI surfaces.
- Prefer user-facing terms such as `음성 파일`, `회의 요약`, `대화록`, and `분석 준비`.
- Avoid exposing implementation terms such as model names, server details, or pipeline names in common user flows.

## Portable Release Debugging Rules

- Before building, packaging, or verifying the portable desktop app, read `docs/tauri-desktop-release-checklist.md`; it is the single detailed source for release commands, build venv recovery, pip cache workarounds, and deploy-folder verification.
- When the user says "build" without explicitly asking for a frontend/Vite/web build, treat it as a user-ready portable release build and run from the repo root: `corepack pnpm build`. Do not substitute `corepack pnpm --dir desktop-app build`, because that only updates web assets.
- Use `backend\.venv-desktop\Scripts\python.exe` as the normal portable release build Python. Temporary venvs are emergency fallbacks only and must be called out in the work summary.
- First classify the failing layer: sidecar packaging, desktop/Tauri build, portable packaging, or deploy-folder runtime.
- Use the actual `lmo_audio` deploy folder as the runtime source of truth. Treat `dist`, `dist-sidecar`, `target`, and `target/release/portable` as intermediate artifacts unless the task explicitly asks about them.
- Before diagnosing a portable bug, record the launched executable, backend directory from `/api/health`, and whether the app is dev, sidecar, or packaged portable.
- Prefer `scripts/verify_portable.ps1` before rerunning a full portable build.
- If intermediate portable packaging is locked, verify `lmo_audio` directly and rebuild only the missing layer.
- When a new portable build lesson is learned, update `docs/tauri-desktop-release-checklist.md` instead of duplicating the detailed procedure here.

## Windows Runtime Pitfalls

- PowerShell 5.1 defaults to a legacy code page, so Korean/UTF-8 text can break when rewritten through shell output. Prefer `apply_patch` for edits and explicit UTF-8 .NET writes inside scripts.
- `Get-CimInstance Win32_Process` may fail with `Access denied` under Codex sandboxing even when ordinary file and process commands work. Use `Get-Process` when executable path is enough; request escalation only when command-line inspection is required.
- `Get-FileHash` may be unavailable in some PowerShell hosts launched through Node/npm. Release scripts should use a .NET SHA256 fallback instead of relying only on the cmdlet.
- Git may fail or misreport dirty state when the user's global ignore file is inaccessible. For release manifest checks, use `git -c core.excludesFile= status --short --untracked-files=all`.
- `ProcessStartInfo.EnvironmentVariables[...]` can fail under Python-driven Windows PowerShell subprocesses. For sidecar smoke tests, fall back to temporarily setting process-level environment variables and let the child inherit them.
- After an interrupted build, check for leftover `corepack pnpm build`, `scripts\build_user_release.ps1`, Tauri, PyInstaller, or sidecar processes before retrying. Stop only processes whose command line or executable path clearly belongs to this project.
- Keep release scripts resilient to process-inspection failures. They should warn and fall back when possible instead of failing before the actual build starts.

## Analysis Hang Debugging Rules

- Separate three cases before changing code: native STT/chunk hang, backend SSE/progress delivery issue, frontend state/rendering issue.
- If progress text stays unchanged for a long time, check backend logs and SSE events before changing UI copy or ETA logic.
- Do not treat stalled UI text as the fix for a native STT hang.
- Reproduce long-file stalls with a short clipped sample first. If short clips pass and long files fail, prioritize chunking, timeout, and STT runtime settings before UI changes.
- When possible, confirm whether backend CPU usage, temp chunk creation, or chunk counters are still moving before declaring the pipeline stuck.

## Backend Output Contract Rules

- Treat backend output JSON as separate from the frontend meeting record.
- Before enabling or debugging `/api/outputs/{job_id}/...`, verify `MeetingRecord.jobId`, `MeetingRecord.outputFiles.job_id` when present, the active backend `output_dir`, and the existence of `{job_id}_result.json`.
- If the frontend record exists but backend output JSON does not, use a payload-based fallback path or treat the record as ineligible for output-based generation.
- Topic/speaker generation buttons should not rely on `jobId` alone; check transcript segments and generation state too.
- When changing summary, topic, speaker-context, or speaker-label generation, keep backend result JSON, frontend `MeetingRecord`, `/sync-record`, `/export-record`, and generated download files aligned. Regenerating topic sections invalidates speaker-context and participant summaries.
- Treat explicit empty `speakerLabels` / `speaker_labels` payloads as a user-cleared label set. Do not fall back to stale legacy labels or stale speaker display names in exports or saved result JSON.
- A single concrete topic section can be a completed topic result; reject only generic one-topic outputs such as broad "핵심 주제" style summaries.
- Never expose raw backend JSON errors such as `Output result not found` directly in the UI when a user-facing recovery message is possible.

## Verification Scope Rules

- For release or runtime issues, verify the narrowest suspected layer first.
- Prefer this order: deploy folder structure, backend health/config, specific API endpoint, frontend state/UI behavior, then full portable release build only when packaging is the proven failing layer or the user explicitly asks.
- Do not rely on a full production build to diagnose an issue that can be isolated with a backend endpoint, deploy-folder inspection, or targeted script.
- When reading line ranges in PowerShell, do not use `Select-Object -Index 600..650`; PowerShell treats that as a string in this context. Use `$lines = Get-Content path; $lines[600..650]` or `Select-Object -Skip 600 -First 51` instead.

## Frontend Simulation Rules

- Treat `desktop-app/scripts/simulate-*.mjs` as project Playwright tests, not as Codex in-app browser checks.
- Before rewriting a simulation to avoid Playwright, confirm whether the missing piece is simply the Playwright browser install or launch permission.
- Keep detailed setup and recovery notes in `docs/frontend-simulation-testing.md`, not in this file.

Related docs:

- `docs/audio-performance-improvement-log.md`
- `docs/audio-preprocessing-notes.md`
- `docs/audio-preprocessing-test-plan.md`
- `docs/audio-testset-manifest.csv`
- `docs/audio-preprocessing-eval-template.csv`
- `docs/design.md`
- `docs/frontend-simulation-testing.md`
- `docs/tauri-desktop-release-checklist.md`
- `todo.md`
