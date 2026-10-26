# Project Agent Notes

## Agent Coordination

- When a task explicitly asks for agent-based review, split the work by perspective or surface when useful.
- If the active agent limit is reached, close older idle agents first, then continue with the requested review.
- Prefer clear review scopes such as product-level review, UI/UX review, implementation review, and regression-risk review.
- After each implementation slice, run focused validation and then an independent agent review under the project iterative-dev-loop and engineering-reviewer procedures. Match review scope to the actual risk, fix blockers, and revalidate affected paths before proceeding. Documentation-only changes need a focused self-review; do not spawn duplicate broad reviews.
- For exploratory work where the user says "루프를 돌리자", gives a rough goal, or asks to decide which P2 findings matter now, use the project skill `.agents/skills/lmo-audio-iterative-dev-loop`. Keep the loop bounded: smallest useful slice, narrow verification, big/small review only when useful, then fix only blockers and current-goal P2s.
- Treat P2 findings as triage items, not automatic work. Fix P2s that affect the current user flow, release/runtime reliability, saved data, or test confidence. Defer or ignore speculative P2s, and record useful deferred items in `todo.md` or `roadmap.md`.

<!-- BEGIN:release-rules v2 · 정본: playbook/stack/release-flow.md -->
## 브랜치·배포 공통 규칙
1. 장기 브랜치는 `main` 하나다. 작업 브랜치·worktree는 짧게 쓰고 병합 후 지운다.
2. 검증(저장소 지침이 정한 검사, 없으면 타입 검사와 관련 테스트)을 마친 작업은 AI가 `main`에 직접 push한다. 단, push 전 hook이 실제로 도는 환경(`git config core.hooksPath`가 저장소 hook 폴더를 가리키고 pre-push가 있음)이어야 하고, `git revert`로 다 되돌아가지 않는 변경(DB·데이터 스크립트, 인증·권한·비밀값, 사용자 기록, 배포·빌드·CI, AI 지침·hook)은 사용자 확인 후 push한다. 조건이 안 되면 커밋까지만 하고 묻는다. `--no-verify`·force-push는 쓰지 않는다.
3. push는 운영 트래픽·데이터를 바꾸지 않는다. 미리 빌드해 트래픽 없는 버전으로 올리는 것까지만 된다.
4. 배포·롤백·DB 구조 변경·비밀값 변경은 사용자가 요청할 때만 `pnpm release`로 한다. `pnpm release`가 없으면 그 저장소 배포 문서의 기존 경로를 쓰고, 그것도 없으면 묻는다. 맨 `wrangler deploy`·`wrangler secret put`과 대시보드 직접 변경은 하지 않는다.
5. 클라우드 세션은 4의 작업을 실행하지 않고, PC에서 실행할 명령과 대상 SHA만 안내한다. Cloudflare 토큰을 저장소·`.env*`·`.dev.vars`·클라우드 작업 공간에 두거나 요청하지 않는다.
6. DB migration은 추가만 하고 새 버전 승격 전에 적용한다. 삭제·이름 변경은 다음 릴리스에서, Durable Object 생성·삭제·이름 변경은 단독 릴리스로 한다. 원격 데이터 쓰기는 승인된 예약 작업이나 사용자가 요청한 스크립트로, 복원 지점을 남긴 뒤에만 한다.
7. 운영 릴리스와 롤백마다 annotated 태그 `prod-YYYY-MM-DD.N`(UTC 날짜)을 남긴다. 데스크톱 앱은 `vX.Y.Z`(설치 파일 버전)를 쓴다.
8. GitHub Actions는 push·pull_request 때 돌지 않는다. 예약 데이터 작업과 수동 실행만 둔다.
<!-- END:release-rules -->

이 저장소 메모: Windows에서는 `git config core.hooksPath .githooks`로 pre-push hook을 활성화한다. `scripts/check_pre_push.ps1`은 실제 push 대상과 HEAD 일치를 먼저 확인하고, 원격 tip 이후 모든 전송 커밋·최종 상태의 변경 경로를 모아 영향별 최소 검사를 선택한다. 일반 문서만이면 앱 검사를 생략한다. 일반 프론트 소스는 타입·Node 계약 검사, 확인된 독립 백엔드 모듈은 빠른 Python 검사만 실행한다. 공통 계약·설정·미분류 코드는 양쪽을 유지하며, hook·AI 지침·검사기 변경은 hook 자체 회귀도 추가한다. 신규 ref·범위 판정 실패·실행 권한·링크는 보수적으로 양쪽과 hook 회귀를 실행한다. 구체적 경로표와 문서 허용 범위는 `docs/release-checklist.md` 6절을 따른다. 코드 검사 전에는 미커밋·미추적 소스가 있으면 멈추며, 자동 최소 검사가 변경 영역의 추가 전용 검증을 대신하지 않는다. 전체 빌드·브라우저·실모델 검사는 별도다. PowerShell이 없는 클라우드 세션에서는 커밋까지만 하며, hook·AI 지침 등 규칙 2의 확인 대상 변경은 hook 통과 뒤에도 사용자 확인 후 push한다. 웹 Worker `barorok`에는 `pnpm release`가 없어 규칙 4의 기존 경로(`corepack pnpm --dir deploy/cloudflare run deploy`, `docs/web-local-engine-followup-plan.md`)를 임시로 쓴다. 규칙 7의 `vX.Y.Z`는 버전이 붙는 유일한 설치 파일인 웹 연결용 설치 엔진(`Barorok-Local-Engine-Setup-<engineVersion>.exe`)의 `engineVersion` 그대로다(예: `v0.1.10-beta-20261021`). 포터블 데스크톱(`lmo_audio`)은 버전 없이 `release-manifest.json`의 commit으로 식별하므로 태그를 따로 만들지 않는다. `tauri.conf.json`의 `0.1.0`은 릴리스 버전이 아니다. 상세 순서는 `docs/release-checklist.md` 7절, 후속은 `todo.md`의 「브랜치·배포 공통 규칙 v2 적용 후속」.

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
- Prefer user-facing terms such as `음성 파일`, `회의 요약`, and `대화록`.
- Do not add redundant eyebrow labels, decorative section markers, or repeated helper text to the first meeting-writing screen when the title/control already explains the purpose.
- Refer to the user product as `LMO 회의록` (the brand name in `configs/brand.json`) or the web app. Use desktop app only for the Windows Tauri executable, and use portable release only for the copied or zipped `lmo_audio` folder used on another PC.
- When explaining Ollama, distinguish system Ollama from app-managed Ollama. Do not describe either as a Python virtual environment.
- Distinguish the Vite development UI, the deployed HTTPS web app, the downloaded Windows local engine, and the Tauri desktop executable. They share UI or backend code, but verification of one runtime does not prove the others.
- Default product and UI scope is the HTTPS web app connected to a user-downloaded Windows local engine. Optimize wide desktop browsers and the supported narrow desktop browser window; do not turn narrow-width QA into mobile navigation, PWA, remote SaaS processing, or a mobile product unless the user explicitly asks for that scope.
- Treat browser, Vite, and Playwright runs as verification surfaces for the web UI by default. They do not by themselves prove local-engine connection, local processing, persistent local storage, model download recovery, or desktop executable behavior.
- Avoid exposing implementation terms such as model names, server details, or pipeline names in common user flows.
- Do not render temporary success/info notices as inline banners that push page content down or resize the current work surface. Transient feedback such as "saved" or "completed" should use a toast, overlay, inline chip with stable reserved space, or another non-layout-shifting pattern.
- Keep durable guidance inline only when the user must read it to decide the next action, such as errors, warnings, skipped/partial results, required setup, or recovery instructions.
- Before adding any status or notice UI, classify it by user meaning: transient toast, durable banner, inline follow-up action, or blocking error. Do not choose the surface based only on an existing state variable name.
- Keep repeated work surfaces layout-stable. Switching tabs, toggles, or modes should not make shared headers, tab bars, action buttons, search fields, or surrounding panels jump; reserve stable space, use consistent containers, or isolate variable-height content inside the active content area.
- This does not prohibit legitimate content-height changes. It is acceptable for the active tab body, expandable details, or a newly opened panel to grow when the user explicitly changes context, but persistent controls and navigation anchors should remain visually steady.

## Portable Release Debugging Rules

- In user-facing text and documentation, use `업데이트 패키지` for updating an existing installation and `신규 설치 패키지` for starting on a new PC or in a new folder. State ZIP separately as the archive format; do not call the latter `전달 ZIP`, `전달용 슬림 zip`, or `handoff zip`. Keep existing command, script, path, and schema identifiers such as `package:handoff` unchanged. Explain that core program files overlap: updates preserve existing settings/models/data, while a new-install package adds default settings and the diarization model; Whisper, Ollama executable, and Ollama summary models require separate preparation in the current slim package.

- Before building, packaging, or verifying the portable desktop app, read `docs/release-checklist.md`; it is the single detailed source for release commands, build venv recovery, pip cache workarounds, and deploy-folder verification.
- For user-ready release work, follow the fixed sequence in `docs/release-checklist.md`: classify scope, run narrow checks, review risky changes, commit, build, verify manifest, then push only as the 브랜치·배포 공통 규칙 block allows (rule 2).
- Before changing desktop release, update, verify, or handoff scripts, the web deploy or local engine installer, where the app stores files, the stored-record format, or the web/engine contract version, check section 6-1 (data safety) of `docs/release-checklist.md`.
- When the user says "build" without explicitly asking for a frontend/Vite/web build, treat it as a user-ready portable release build and run from the repo root: `corepack pnpm build`. Do not substitute `corepack pnpm --dir desktop-app build`, because that only updates web assets.
- When the user asks for a build intended to share, deliver, hand off, or run on another PC, create and report the new-install package (`신규 설치 패키지`, ZIP) after the clean portable build: `corepack pnpm package:handoff`. Do not present the full `releases\lmo_audio` folder size as the normal transfer artifact unless the user explicitly wants all embedded models.
- Use `backend\.venv-desktop\Scripts\python.exe` as the normal portable release build Python. Temporary venvs are emergency fallbacks only and must be called out in the work summary.
- First classify the failing layer: sidecar packaging, desktop/Tauri build, portable packaging, or deploy-folder runtime.
- Use the actual `lmo_audio` deploy folder as the runtime source of truth. Treat `dist`, `dist-sidecar`, `target`, and `target/release/portable` as intermediate artifacts unless the task explicitly asks about them.
- Before diagnosing a portable bug, record the launched executable, backend directory from `/api/health`, and whether the app is dev, sidecar, or packaged portable.
- Prefer `scripts/verify_portable.ps1 -PortableDir releases\lmo_audio -ExistingInstallation` (read-only) before rerunning a full portable build. The default mode launches the app and refuses a deploy folder that holds records or logs; never delete them to make it pass.
- If intermediate portable packaging is locked, verify `lmo_audio` directly and rebuild only the missing layer.
- When a new portable build lesson is learned, update `docs/release-checklist.md` instead of duplicating the detailed procedure here.

## Windows Runtime Pitfalls

- If sandboxed Corepack or Python temporary files fail under the user profile, use task-scoped `COREPACK_HOME=D:\Projects\LMO_audio\.cache\corepack` and `TEMP`/`TMP=D:\Projects\LMO_audio\.tmp\<task>\temp` (create the temp directory first). Do not change global environment variables. For dependency repair, keep the lockfile fixed and use `--store-dir D:\Projects\LMO_audio\.cache\pnpm-store`; a sandbox denial while creating Windows links requires a focused elevated retry, not repeated installs.
- PowerShell 5.1 defaults to a legacy code page, so Korean/UTF-8 text can break when rewritten through shell output. Prefer `apply_patch` for edits and explicit UTF-8 .NET writes inside scripts.
- If `Get-Content`, `cat`, or wrapped PowerShell output shows mojibake for Korean/UTF-8 text, do not treat that terminal output as source of truth. Re-check with `git diff`, targeted search, or another UTF-8-safe path before editing.
- `Get-CimInstance Win32_Process` may fail with `Access denied` under Codex sandboxing even when ordinary file and process commands work. Use `Get-Process` when executable path is enough; request escalation only when command-line inspection is required.
- `Get-FileHash` may be unavailable in some PowerShell hosts launched through Node/npm. Release scripts should use a .NET SHA256 fallback instead of relying only on the cmdlet.
- Git may fail or misreport dirty state when the user's global ignore file is inaccessible. For release manifest checks, use `git -c core.excludesFile= status --short --untracked-files=all`.
- `ProcessStartInfo.EnvironmentVariables[...]` can fail under Python-driven Windows PowerShell subprocesses. For sidecar smoke tests, fall back to temporarily setting process-level environment variables and let the child inherit them.
- Windows sandboxing can surface `EPERM`, `Access denied`, or cache-write failures under folders such as `.next`, `.next\\cache`, `.next\\trace`, or other generated caches even when the app code is fine. Classify these as environment or permission boundary issues first, then decide whether escalation, cleanup, or a different cache path is the right fix.
- A command that exits quietly or produces no output is not automatically a failure in Codex on Windows. Check the exit code, expected side effects, and the next observable state before retrying or rewriting code just because the console stayed silent.
- After an interrupted build, check for leftover `corepack pnpm build`, `scripts\build_user_release.ps1`, Tauri, PyInstaller, or sidecar processes before retrying. Stop only processes whose command line or executable path clearly belongs to this project.
- Keep release scripts resilient to process-inspection failures. They should warn and fall back when possible instead of failing before the actual build starts.

## Agent Maintenance Rules

- Revisit Windows/Codex-specific guidance in this file at least once every 3 months.
- During that review, remove guidance that is no longer reproducible on the current toolchain, keep guidance that still reproduces, and add any newly repeated failure modes from recent work.
- Record the outcome of that review in `todo.md` or the most relevant existing project log instead of creating a separate planning file unless the audit itself becomes a multi-surface project.

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
- For release/update PowerShell script changes, prefer affected unittest methods first, then the single relevant test module. Avoid combining update-package and portable-release script suites unless the full packaging boundary changed, because they can be slow on this Windows PC and may time out.
- When reading line ranges in PowerShell, do not use `Select-Object -Index 600..650`; PowerShell treats that as a string in this context. Use `$lines = Get-Content path; $lines[600..650]` or `Select-Object -Skip 600 -First 51` instead.

## Frontend Simulation Rules

- Treat `desktop-app/scripts/simulate-*.mjs` as project Playwright tests, not as Codex in-app browser checks.
- Before rewriting a simulation to avoid Playwright, confirm whether the missing piece is simply the Playwright browser install or launch permission.
- On this Windows PC, use a project-local Playwright browser cache for simulations: set `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\LMO_audio\.cache\ms-playwright` before `playwright install` and before running `desktop-app/scripts/simulate-*.mjs`.
- If a Playwright simulation times out at the initial `page.goto` before any mocked API calls occur, treat it first as a dev-server/browser-entry issue. Check the Vite port, direct HTTP response, and this session's simulation processes before changing product code.
- Keep detailed setup and recovery notes in `docs/frontend-simulation-testing.md`, not in this file.

Related docs:

- `docs/audio-performance-improvement-log.md`
- `docs/audio-preprocessing-notes.md`
- `docs/audio-preprocessing-test-plan.md`
- `docs/audio-testset-manifest.csv`
- `docs/audio-preprocessing-eval-template.csv`
- `docs/design.md`
- `docs/frontend-simulation-testing.md`
- `docs/release-checklist.md`
- `todo.md`
