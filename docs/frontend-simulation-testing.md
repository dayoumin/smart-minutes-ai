# Frontend Simulation Testing

## 원격 병합 후 통합 검증 — 2026-10-26

`main`을 `93b4ea7`에서 원격 `0c4e1a4`로 fast-forward하고 기존 미커밋 작업을 복원했다. 설정의 설치·재설치 경로가 작업 보호를 우회하던 직접 다운로드를 공통 안내로 연결하고, 설정 위 안내 창의 Tab 처리가 배경 설정 창으로 전파되지 않도록 고쳤다. 새 요약 프로그램 연결 요청도 시작부터 종료까지 작업 상태에 포함한다. 공개 버전 조회는 인증 경계 검사에 고정 주소·경로, 인증정보 미전송, 리디렉션 거부 조건을 추가했다.

- 통과: `corepack pnpm --dir desktop-app typecheck`, 변경 파일의 `corepack pnpm --dir desktop-app exec eslint ...`, `node --check desktop-app/scripts/simulate-update-guide.mjs`, `git diff --check`.
- 통과: `corepack pnpm --dir desktop-app exec node --experimental-strip-types --test --test-concurrency=1 scripts/test-desktop-release.mjs scripts/test-update-activity.mjs scripts/test-finite-engine-json.mjs scripts/test-desktop-startup-read.mjs scripts/test-runtime-boundary.mjs scripts/test-api-auth-boundary.mjs`의39개, `backend`에서 `.\.venv-desktop\Scripts\python.exe -X utf8 -B -m unittest test_update_activity test_local_engine_security.LocalEngineSecurityTest.test_main_api_routes_have_explicit_auth_policy`의8개, `corepack pnpm --dir deploy/cloudflare test`.
- 통과: `corepack pnpm --dir desktop-app test:update-guide`의 웹·모의 Tauri 두 환경. 앞선 기록에서 미실행이었던 인증 만료·재연결 회귀를 이번에 실행했다. 안내만 열 때 요청 없음, 작업 중 차단, 취소·재열기, 수동 확인, 오류 시 작성 내용 보존, Tab/Shift+Tab과 배경 키보드 처리 차단을 확인했다. 실제 설치 파일이나 모델은 받지 않았다.

시험 서버는 저장소 루트에서 `corepack pnpm --dir desktop-app exec vite --host 127.0.0.1 --port 5188 --strictPort --configLoader runner`로 시작했다. `APP_URL=http://127.0.0.1:5188`, `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`, `QA_OUTPUT_DIR=D:\Projects\audio\.tmp\remote-merge-20261026\update-guide`를 검사 프로세스에만 지정했다. 페이지 제목으로 대상 fixture를 확인했으며, 검사 후 소유 Vite PID6564를 종료해 시작 전 상태로 복원했다. 실제 공개 다운로드·설치·재시작·사용자 자료 보존은 릴리스 QA의 별도 대기 항목이다.

## Explicit update guidance — 2026-10-26

`simulate-update-guide.mjs` mounts the production update provider and buttons in a focused fixture for web and mocked Tauri runtimes. Start an owned Vite server after checking the port; this run used `corepack pnpm --dir desktop-app exec vite --host 127.0.0.1 --port 5188 --strictPort --configLoader runner` from the repository root. Set `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\LMO_audio\.cache\ms-playwright` and `APP_URL=http://127.0.0.1:5188`, then run `corepack pnpm --dir desktop-app test:update-guide`. Optional `QA_OUTPUT_DIR` writes screenshots.

The test owns a temporary HTTP proxy on an OS-assigned free loopback port and closes it with the browser. It serves actual artifact200/503 responses: Chromium's `a[download]` requests bypass Playwright page routing, so a page route counter alone does not prove whether a download occurred. The first sandboxed Vite process listened without responding to HTTP on this PC; verifying its PID/command, stopping that owned process and restarting the same command outside the sandbox restored HTTP readiness. Do not classify initial `page.goto` timeouts as UI failures.

Passed scenarios include no file request before a receive click, busy and preflight races, cancel/reopen invalidation, older-engine unknown-status confirmation, explicit download,503 preserving the original tab/input, native browser-action failure, first install, required update, unavailable desktop publication, keyboard/focus and stable work-surface position. This fixture is not a real installed engine or packaged EXE test; release follow-up belongs in `docs/release-checklist.md`.

### 다음 업데이트 흐름 변경 시 재사용 기준

| 확인할 사용자 상황 | 현재 자동 검사 | 집에서 실제 설치본으로 추가할 증거 |
| --- | --- | --- |
| 안내만 보기·나중에 하기 | 받기 클릭 전 파일 요청 없음, 닫기·초점 복귀·작업면 위치 보존 | 실제 웹·EXE에서 작업을 유지하며 안내 진입 |
| 작업 중 새 버전 발견 | 모의 작업 상태와 다운로드 직전 작업 시작으로 받기 차단 | 실제 분석·요약, 설정 창을 닫아도 계속되는 모델 받기·다른 창 작업 |
| 안내 취소·다시 열기 | 이전 클릭 무효화, 이전 수동 확인 재사용 금지 | 느린 실제 연결에서도 취소 후 다운로드가 시작되지 않음 |
| 구버전·상태 미확인 | 확인 체크 전 차단, 명시적 확인 후에도 새 작업 감지 시 차단 | 이전 설치 엔진과 첫 설치의 연결·권한·수동 확인 절차 |
| 안내 중 인증 만료·재연결 | 요청 중 만료·이전 busy 뒤 만료·재연결 시나리오 통과, 2026-10-26 병합 후 모의 검사 | 실제 연결 인증 변경 후 확인 상태 복구와 작업 차단 유지 |
| 파일 받기·오류·복구 | 로컬 HTTP200/503, 기존 탭·입력 보존, 모의 Tauri의 브라우저 열기 실패 | 공개 HTTPS·실제 Windows 기본 브라우저의 파일·해시·저장 위치, 오류 후 재시도 |
| 데스크톱 공개 버전·첫 기능 배포 | 별도 계약 검사에서 같은/이전 빌드·잘못된 공개 정보 거부, UI에서 미공개 안내 | 기존 앱 최초 수동 업데이트, 실제 새 EXE의 버전 비교·수동 적용·자료 보존 |

시뮬레이션(simulation)은 웹과 모의 Tauri 환경에서 공통 컴포넌트의 동작을 확인한다. Tauri 명령·엔진 응답을 모사하므로 실제 설치본의 전역 작업 상태 전달, 공개 배포 파일, 설치·업데이트 스크립트, 재시작 후 자료 보존을 입증하지 않는다. `test:desktop-release`·`test:update-activity`는 별도의 계약·작업 상태 검사이며 브라우저 시뮬레이션과 구분한다.

2026-10-26 추가 에이전트 검토·수정: 인증을 고정했던 기존 fixture가 놓친 `activityChecking`·이전 `busy` 잔류 P2를 수정했다. 인증이 바뀌면 안내의 이전 조회·다운로드 요청·수동 확인을 무효화하고 미확인 상태로 초기화한다. 인증 없는 웹에서는 조회를 시작하지 않고 재연결하면 새로 확인한다. fixture에 인증 전환 제어를 넣고 요청 중 인증 만료·이전 busy 뒤 만료·재연결 회귀 시나리오를 추가했다. 회사 PC·핫스팟의 당시 작업에서는 타입 검사·변경 파일 린트·스크립트 문법 검사와 독립 검토까지만 진행하고 서버·브라우저·실제 다운로드·전체 빌드는 실행하지 않았다. 이후 같은 날 원격 병합 후 웹·모의 Tauri 전체 집중 시뮬레이션을 실행해 추가 인증 회귀까지 통과했다. 최신 명령·범위는 이 문서 첫머리의 원격 병합 후 통합 검증을 따른다.

이번 가벼운 검사는 로컬 캐시를 재사용하도록 `COREPACK_HOME=D:\Projects\LMO_audio\.cache\corepack`, `COREPACK_ENABLE_NETWORK=0`을 해당 프로세스에만 설정하고 `corepack pnpm --dir desktop-app typecheck`, `corepack pnpm --dir desktop-app exec eslint src/UpdateProvider.tsx`, `node --check desktop-app/scripts/simulate-update-guide.mjs`, `git diff --check`로 실행했다. 문법 검사 통과는 브라우저 동작 통과를 뜻하지 않는다.

회사 PC·핫스팟에서 이어갈 때는 기존 결과가 적용 가능한지 소스·설정 변경을 먼저 확인하고, 네트워크 다운로드나 전체 빌드를 반복하지 않는다. 실제 파일 다운로드·적용·실행은 `todo.md`의 「집에서 업데이트 안내의 실제 다운로드·적용·재시작 검증」을 따른다. 결과의 정본은 `docs/release-checklist.md`의 해당 QA 행이며, 반복 발견 원인·재현법은 이 절에 보완한다.
## 공통 연결 우선 점검 — 2026-10-25

서버 미실행·무응답 진단, 검사 중단 조건과 병렬 실행 기준의 기준 문서는 [release-checklist.md의 서버 미실행·무응답·복구 QA](release-checklist.md#서버-미실행무응답복구-출시-전-qa-2026-10-25)다. 정상 경로에서는 대상/화면 준비→공통 연결→요청 방식별 대표 검사→필요한 실모델→복구·보존 순서로 좁힌다. 실제 연결이 실패하면 그 연결에 의존하는 검사는 멈추지만, 의도적인 서버 미실행 UI 시험과 서버 없는 모의 검사는 별도 실행할 수 있다.

브라우저는 기본1개씩 실행한다. 같은 서버·프로필·설정·모델을 바꾸는 검사를 병렬로 띄우지 않는다. 개발 화면의 HTTP200만으로 초기 모듈/CSS 준비나 실제 설치형 엔진의 연결을 입증하지 않는다. `page.goto`에서 첫 진입이 실패하면 해당 시나리오를 실행한 것으로 세지 않는다. 이전 세션의 준비 완료 기록도 현재 응답을 확인한 뒤 재사용한다.

현재 소스 집중 검사: 저장소 루트에서 `corepack pnpm --dir desktop-app exec node --experimental-strip-types --test --test-concurrency=1 scripts/test-desktop-startup-read.mjs scripts/test-runtime-boundary.mjs` 통과(초기 회복12검사+실행 환경/공통 클라이언트 검사1묶음). 실제 브라우저·엔진·모델은 실행하지 않았다. 이전 개발 주소5183/17863의 연결 거부 관찰과 최종 배포본의 남은 QA는 기준 문서에 기록했다. 이전 초기 상태 수정 증거는 이 문서의 `Native startup read recovery — 2026-10-23`, 첫 진입 지연 이력은 `Merged-source browser verification and startup timeout — 2026-10-21`을 참조한다.

독립 에이전트 검토 후속: 두 유한 조회 wrapper가 헤더 후 시간 제한을 해제하던 결함을 `requestFiniteEngineJson`으로 수정했다. 작성 준비15초/설정20초 기한에 성공·오류 본문 완료와 취소를 포함하며, 401/403은 상태·헤더만 즉시 반환한다. 기존 초기 회복12검사에 유한 본문 정체·취소·인증 오류·오류 상세 보존·SSE 기본 동작5검사를 추가했다. `corepack pnpm --dir desktop-app exec node --experimental-strip-types --test --test-concurrency=1 scripts/test-desktop-startup-read.mjs scripts/test-runtime-boundary.mjs scripts/test-api-auth-boundary.mjs`의28개와 `corepack pnpm --dir desktop-app typecheck`가 통과했다. 추가 취소 검사는 스트림 자동 선읽기 시점이 아닌 실제 reader 획득 후 취소하도록 동기화해 본문 단계의 해제를 확인한다. 최종 브라우저/배포 실행 파일에서 실패 안내·취소·복구 시간은 기준 문서의 시험별 기한을 고정한 뒤 별도 확인한다.

`corepack pnpm --dir desktop-app exec eslint src/localEngineClientCore.ts src/MeetingWriter.tsx src/Settings.tsx scripts/test-desktop-startup-read.mjs`와 변경 범위 diff 검사가 통과했다. 수정 후 독립 코드·배포 에이전트 재검토에서 차단 없음. 앞선 소스 검증 단계에서는 브라우저/서버/모델을 시작하지 않았으며 실제 배포본 QA 상태를 변경하지 않았다.

### 후속 브라우저·화면 확인 — 2026-10-25

화면 서버 하나와 Chromium 하나로 `scripts/simulate-finite-request-recovery.mjs`를 실행했다. 네이티브 연결/모든 API를 모의하고 매 경로마다 독립 브라우저 컨텍스트를 사용했다. health200 본문 정체, models500 본문 정체, settings200 본문 정체를 순차 확인했다. 작성 요청15초/설정20초의 본문 취소, 무한 준비 대신 복구 안내, 설정 오류 중 Esc 닫기, 재열기/응답 회복 후 표시 갱신을 통과했다. 페이지 예외0·분석 POST0이다. 가상 시간을 사용한 기능 검증이며 실제 PC의 기동 성능이나 최종 설치본 합격 증거가 아니다.

저장소 루트의 서버 명령: `corepack pnpm --dir desktop-app exec vite --host 127.0.0.1 --port 5198 --strictPort --configLoader runner`. 기존 포트를 재사용하지 않고 `--strictPort`로 시작했으며 PID16712·HTTP200·LMO 회의록 제목을 확인했다. `Get-NetTCPConnection`은 권한 경계로 실패해 `netstat -ano -p tcp`로 PID를 확인했다. `APP_URL=http://127.0.0.1:5198/`, `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`를 명령 프로세스에만 지정하고 `corepack pnpm --dir desktop-app exec node scripts/simulate-finite-request-recovery.mjs`를 실행했다. 스크립트는 서버를 자동 시작하지 않고 모든 경우 브라우저를 닫는다.

초기 시나리오는 본문 정체를 완료된500 응답의 `readiness-error`로 기대해 실패했다. 실제 UI와 `writerStatusRow.ts` 계약은 본문이 완료되지 않은 경우 `no-response`이며, 해당 복구 안내와15초 본문 취소를 관측한 뒤 기대 상태를 수정했다. 시간 제한이나 제품 코드를 완화하지 않았다. 최종3경로는 통과했다. 캡처 `.tmp/finite-request-ui-20261025/{health,models-error,settings}-{failure,recovered}.png`6개와 `result.json`을 남겼고 실패·복구 화면3장을 직접 확인했다. 이 검사는 실제 모델 준비나 사용자 기록 보존을 입증하지 않는다.

종료 확인: 브라우저는 스크립트의 `finally`에서 닫혔다. 사용자에게 정리 대상을 알린 뒤5198의 소유 PID16712를 다시 대조해 이 세션의 Vite만 종료했고, 해당 포트가 더 이상 LISTENING이 아님을 확인했다. 점검 전 서버가 없던 상태로 복원했다. 재실행은 위 서버 명령과 APP_URL을 사용한다. 새 스크립트의 ESLint·diff 검사도 통과했다.

추가 시뮬레이션의 독립 에이전트 재검토에서 차단 없음. 작성 화면은 복구 안내/문제해결 버튼 표시와 focus 이벤트 후 상태 회복을 확인했으며 버튼 클릭 목적지까지 검증한 것은 아니다. 설정은 실제 Esc 닫기·재열기를 확인했다. 이를 전체 화면 반응성이나 최종 설치본 동작 통과로 확대하지 않는다.

후속 실제 EXE 검증(2026-10-25)은 [배포 체크리스트의 실제 EXE 결과](release-checklist.md#실제-exe-장애복구-점검-결과--2026-10-25)에 기록했다. 격리된 clean `1ebd2d9` 후보에서 응답 모의·가상 시간 없이 서버 미실행/지연/끊김/화면 재시작/시험 기록 보존을 확인했다. 네이티브 입력은 Windows computer-use로 하고, CDP는 상태 관측·전용 프로필의 시험 기록 준비/비교에만 사용했다. 실제 분석·자동 저장·HTTPS+설치 엔진·다른 PC 검증은 이 결과에 포함하지 않는다. 현재 작업 폴더의 다른 미커밋 UI/백엔드 변경 전체를 이 EXE가 포함한 것도 아니다.

## Stable summary model positions — 2026-10-24

Model selection no longer sorts the chosen/recommended model ahead of the catalog. Default and registered input order is preserved; a configured-only fallback is appended rather than prepended. Selection/readiness change controls only. The selection-focus effect also stops restoring a target page when the user navigated elsewhere during a delayed save. Explicit search-result return still navigates to the requested model.

Actual IAB860×720 E2B→E4B selection kept every model name and x/y coordinate identical, and closing/reopening Settings preserved that order with E4B checked in its original right-hand slot. At1360×900 restoring the original E2B selection also left coordinates unchanged. The viewport override was reset. Evidence `.tmp/settings-fixed-model-order-20261024/{actual-selected-e4b-860.jpg,actual-verification.json}`. Typecheck, changed Settings ESLint and independent source review passed; the review's late-save page-jump finding was fixed. The focused simulation includes first/later-page mouse and keyboard choice, unchanged order/coordinates/page, delayed-save user navigation and full-order persistence after reopening, while retaining prior delete/update/save races.

Final `corepack pnpm --dir desktop-app test:settings-model-management` passed (exit0), as did Node syntax/diff checks. Test browser processes were confirmed closed. Latest mock evidence: `.tmp/settings-model-order-20261024/mock`.

## Save feedback, automatic volume correction and taller Settings — 2026-10-24

The header displays only `저장 중`; normal `저장됨` is hidden and save-error handling is retained. The former `음성 정리` switch becomes a read-only `음량 자동 보정` row: the current enabled/normalize settings show `자동` or `꺼짐`, with loading shown before settings arrive. Audio processing/defaults are unchanged. The hidden processing value is removed from general-save keys and PATCH payloads so unrelated settings changes cannot overwrite it. Dialog height is `min(760px, 100dvh - 32px)` with a vh fallback and existing body overflow recovery.

Passed `corepack pnpm --dir desktop-app typecheck`, changed Settings ESLint, diff checks, independent source review and `corepack pnpm --dir desktop-app test:settings-model-management`. The simulation checks visible in-flight save feedback and no saved-completion text, read-only correction/no switch, no preprocessing key in any PATCH, preserved disabled/normalize/mode fixture values, height cap/window margins, and existing selection/delete/update/late-save cases. Mock screenshots: `.tmp/settings-auto-audio-height-20261024/mock`. Actual IAB at the intended5183 project showed1360×900→760px dialog/top-bottom70px, 860×720→688px dialog/top-bottom16px; both had no horizontal/Settings-body overflow, no saved-completion text, no correction switch and current correction `자동`. Evidence `.tmp/settings-auto-audio-height-20261024/{actual-settings-1360.jpg,actual-settings-860.jpg,actual-verification.json}`. The viewport override was reset, original selection/settings were preserved, and the test browser was closed. No actual audio conversion or quality change is claimed.

## Ollama compatibility update and download retry — 2026-10-24

Model pull failures distinguish `runtime_update_required`, permission, disk space, missing model, network and unknown failure. Version refusal is one adjacent recovery row with `요약 프로그램 업데이트`, not a company-network diagnosis. The managed-runtime update is explicit `POST /api/models/ollama/runtime/download?update=true`; existing download/auth remain compatible. Runtime0.40.10 Windows AMD64 is pinned to the official release ZIP (1586229413bytes, SHA256 `d52aea2d323bdd324bf66a4b1226844aa5fb665cc5974fbcceceda1ce3d934eb`; source `https://api.github.com/repos/ollama/ollama/releases/tags/v0.40.10`). Staging/version verification precedes owned-process shutdown and whole-bundle rename. Replacement/start failure or cancellation rolls back; system Ollama and model/config/data folders are outside the replacement target. Analysis, generation, pull and delete admissions cannot race an update. Successful update clears stale compatibility failures without starting model downloads or choosing a model.

Focused backend evidence: from `backend`, `.\.venv\Scripts\python.exe -m unittest test_ollama_runtime_update` (21 fixtures) plus13 existing download/auth/ZIP/cancel tests passed. Re-running the34 with `main.save_config` forbidden also passed with zero calls. The fixtures cover complete bundle/rollback/cancellation, path redirection and user-data rejection, ownership/shutdown failure retaining references, operation admission and error classification. Windows file replacement/rollback failures are simulated, not forced on the user's installation. Independent review's ownership-loss defect was fixed and re-reviewed with no remaining source blockers.

`corepack pnpm --dir desktop-app test:settings-model-management` passed with version refusal→explicit update→cancel/retry/failure→installing lock→completion/reopen→explicit model retry→explicit selection. It checks no automatic update/pull/selection, one version notice, disabled controls during update, disabled stop during installation, and old inactive pull status not reactivating the update notice after reopening. Typecheck, changed Settings ESLint, Node syntax and diff checks passed. Mock screenshots: `.tmp/settings-runtime-update-20261024/mock/settings-runtime-update-{required,failed,installing,model-selected}-860.png`.

Actual IAB completed the same flow at `http://127.0.0.1:5183/`: official search/register of `gemma4:e4b-it-q4_K_M` (no automatic pull/selection), managed0.30.6 pull refusal with the new adjacent update action, explicit official ZIP download/update to0.40.10, then explicit same-tag model pull completed with exit0/progress100. Existing E4B blobs were reused; this is an actual registry/pull/hash-validation request, not a claim of retransferring6.6GB. Explicit selection persisted across closing/reopening Settings; the original E2B choice was then restored. At860×720 and1360×900 the complete Settings body had zero horizontal/vertical overflow; viewport override was reset. The original two model manifests retained SHA256 and all original blob sizes remained unchanged; the update itself left config values unchanged, and after the intentional new model registration/download/selection only that new membership differs. System Ollama11434 was left running and unmodified. No real model deletion or forced real rollback was performed. The updated Vite/backend test does not prove a rebuilt portable executable or deployed HTTPS/installed-engine release.

Actual evidence is `.tmp/ollama-update-20261024`: `actual-update-required-860.jpg`, `actual-model-selected-reopened-860.jpg`, `actual-restored-original-1360.jpg`, `actual-failure.json`, `runtime-result.json`, `model-pull-result.json`, `selected-result.json`, `final-verification.json`. Only the session-owned backend/managed child were restarted; current backend command is `.\.venv\Scripts\python.exe -m uvicorn main:app --host 127.0.0.1 --port 17863`, working directory `D:\Projects\audio\backend`, `ANALYSIS_MODE=real`, exact5183 origin added, PID42272/session38315. Frontend5183 remains the original Vite command; both services remain ready.

Latest user refinement: the shared two-column gap is32px (analysis, model list and storage). Model-description help icons/tooltips and their display-only metadata cache are removed from both list/search results; remaining analysis/storage/search guidance is retained. Actual IAB1360×900/860×720 measured both paired/model column gaps32px, zero model-description icons and zero horizontal/Settings-body overflow. Evidence `actual-gap32-no-model-tooltip-{1360,860}.jpg` in the same directory. The focused simulation retires only obsolete model-info/cache assertions, verifies the icons are absent, and retains common help interactions plus selection/delete/update coverage. Independent source review found no additional blockers.

## Summary model button audit and recovery — 2026-10-24

The current group label and accessible model selection label are `요약 모델`. The focused `corepack pnpm --dir desktop-app test:settings-model-management` simulation passed after adding cancellation completion assertions and replacing every native-confirm test stub with explicit DOM confirmation. It covers selection/save/reopen; search/add/list return; download/stop through cancelled polling with no automatic restart or selection change; pagination; tooltips; and existing late-response membership/selection races. A delete menu alone sends zero DELETE requests. Cancel, Escape, default-focused Enter and Settings X send zero DELETE requests; X closes Settings. Only the explicit model-specific confirmation button sends DELETE. Node syntax, Settings typecheck/ESLint, diff checks and independent review passed. The review's X-only-cancels defect was fixed and the suite passed again. Mock screenshots (24 files): `.tmp/settings-buttons-20261024/mock`. These fixtures do not prove actual model transfer or inference.

Actual IAB verification at the intended `http://127.0.0.1:5183/` confirmed program start, E2B→E4B selection persisted across closing/reopening, and restoration of the original E2B choice. Official `gemma4` search returned results; `목록에서 보기` moved focus to the correct model action and search help appeared. At1360×900 and860×720 the title was `요약 모델`, CPU/HWPX controls measured148×32px and both horizontal and Settings-body overflow were zero. The viewport override was reset. Evidence: `.tmp/settings-buttons-live-20261024` (use `actual-settings-restored-860.jpg`, `actual-delete-confirmation-860.jpg` and `actual-verification.json`; the earlier clipped search image has an incorrect capture origin and is not visual proof).

Incident: while attempting to inspect and cancel the old native confirmation in the actual IAB, clicking the E4B file-delete menu executed DELETE without an exposed JS dialog. The user was immediately informed and the original E2B choice remained unchanged. Actual app restoration failed with Ollama412 (`requires a newer version of Ollama`), while the UI incorrectly described an internet/company-network failure. The already installed system Ollama0.40.10 was temporarily served on11479 with the original app model store, and official `gemma4:e4b` was pulled successfully (SHA verification, manifest write, CLI exit0). This restored the same tag; the previous manifest digest was not backed up, so byte-for-byte identity is not claimed. The original backend then listed E2B/E4B with inventory checked and E2B selected, including after terminating only the recovery server PID29860. The actual updated React confirmation screen opened with Cancel focused; Cancel returned to the list and E4B remained available. Actual final file deletion was not repeated. Recovery evidence: `.tmp/settings-recovery-20261024/{server.json,restore-pull.log,verification.json}`. The app's old managed-runtime download incompatibility and wrong failure guidance remain a specific TODO/release QA defect, not a passing download test; the temporary recovery runtime does not prove product download or inference.

## Pin discoverability and unverified inventory — 2026-10-24

Pin controls now remain visible with text, including disabled controls before inventory confirmation or download. Unknown inventory shows 확인 필요 instead of download buttons. 받은 모델 확인 explicitly starts only the existing runtime through POST /api/models/ollama/connect, then reads the existing status API. Failure/retry preserves pin preferences; an ongoing download can still be stopped. The four-pin/persistence/async-save/tooltip regressions remain covered. Model management simulation, TypeScript/changed-file lint, backend4 focused cases (connect/no downloads/failure/token/passive status), and independent agent review passed. Optional SETTINGS_SCREENSHOT_DIR captures the1360/860px fixture views during the existing simulation.

Actual IAB observation before the change confirmed that unknown inventory hid every pin; the browser tool subsequently timed out, so updated screenshots use the project simulation and mocked model inventories. Actual engine preparation returned503; after server restoration status answered in4.26s and reported managed_starting/inventory_checked=false after explicit preparation. Earlier model-status lookups timed out. Do not count the simulation as proof of actual model discovery. Screenshots .tmp/settings-pins-visible-20261024/settings-pins-{1360,860}.png use fixtures. The first screenshot pass caught a6px first-row padding conflict, fixed locally; one rerun hit a disabled-menu focus timeout, while the final full simulation passed unchanged with respect to that focus path. No models were downloaded or deleted. Follow-up is tracked in the existing first-preparation item in todo.md.

## Four received-model pins and paired model rows — 2026-10-24

This refinement supersedes the earlier fixed gemma4:e4b default pin. The v2 preference starts as null until an inventory is confirmed, then pins up to4 currently installed app-managed/registered summary models, preferring the active installed model. Explicit [] remains empty on reopen; later downloads are not automatically pinned. Confirmed removed models release their pin slots. A fifth pin is disabled while every pinned item remains removable. Model rows now share a two-column divided list like storage at1360/860px, stacking at560px. Before inventory confirmation the header states 최대 4개 고정 instead of suggesting an ongoing check.

Passed corepack pnpm --dir desktop-app test:settings-model-management with pending status/inventory_checked=false not seeding, first confirmed inventory defaults,4-pin limit/5th disabled, release and re-pin, selection independence and explicit-empty persistence. Mock inventory now matches the backend fallback meaning of installed=true: configured e4b absent with installed_model=e2b must only seed actually installed e2b/user-ready. The independent review found and closed this missing-configured-model pin defect. A delayed viewport resize event after tooltip focus was also handled by comparing the captured dimensions, while the existing tooltip and late-save regressions remain covered. Typecheck, changed-file lint and diff checks passed. Actual IAB1440×900/860×720 screenshots are .tmp/browser-home-check-20261024/settings-model-grid-{wide,narrow}.png; installed-model combinations use mocked API fixtures and no real models were downloaded or deleted.

## Visible model downloads, pins and tooltip density — 2026-10-24

This user-approved refinement supersedes the collapsed choices/search and900px storage breakpoint in the earlier one-screen entry. The heading is 회의 요약 모델; model download rows and the search input are always visible. App-managed/registered downloaded summary models can be pinned independently of the active model. Pinned rows precede other installed rows; the initial gemma4:e4b pin can be removed even before installation. The smart-minutes-summary-model-pins browser preference preserves an explicit empty list after reopening. The shared Ollama inventory is not automatically added as summary candidates, avoiding embedding-only models from other apps.

Passed corepack pnpm --dir desktop-app test:settings-model-management, typecheck, changed-file ESLint and diff checks. The model suite covers pin/unpin order and selection independence, default-pin removal, [] persistence, still-visible downloads/search, keyboard/hover tooltip display, Escape keeping Settings open, stable work-surface size, 1360/860px storage2columns and560px1column. Existing download/stop/delete/late-response/save/reopen cases remain covered. A focus-scroll tooltip regression and hover-Escape dismissal defect were fixed, then independently re-reviewed with no blockers. Actual IAB1440×900/860×720 evidence: .tmp/browser-home-check-20261024/settings-pins-{wide,narrow}.png and settings-storage-tooltip.png. Layout/help were checked against the real local backend; model transfer and pin combinations with downloaded fixtures are mocked UI verification. No real model was downloaded or deleted during this change.

## One-screen Settings integration — 2026-10-24

Settings uses one #settings-general-panel with analysis, #settings-summary-models and storage. Tabs and the cleanup entry are removed. The old initialTab=models entry still focuses/highlights #settings-analysis-models. Installed summary models use a select row; optional model choices/search expand on request. Missing models and active downloads remain actionable. Status refresh and download polling no longer depend on a tab.

Passed: corepack pnpm --dir desktop-app test:settings-model-management, the full test:writer-model-readiness simulation, typecheck and changed Settings ESLint. The model suite passed again after the save-ownership fix, including delayed model PATCH and post-delete GET snapshots, edits before the600ms debounce/during the response, actual mocked saves and reopening. Independent review found the model response could overwrite unsaved analysis/storage edits; model responses now update only summary fields and general saves preserve summary selection. The focused settings-targets rerun also passed after the ownership fix.

Actual IAB checked1440×900 and860×720 against project UI5183/backend17863. Header and close stay fixed; narrow storage controls stack and remain reachable by internal scrolling. Search expansion has0px page/content horizontal overflow. Evidence: .tmp/browser-home-check-20261024/settings-integrated-{wide,narrow-top,narrow-storage}.png. Real user settings were preserved; download/deletion/delayed-response cases use mocked APIs, not new installer or portable-runtime evidence.

## Fixed narrow promise and first-visit-only details — 2026-10-23

The persistent processing/storage link and its help-only dialog mode are removed.
The full notice remains only for first visits to the web connection surface, using
the existing `localProcessingIntroSeen` key/session fallback. Closing with the primary
button, Escape or backdrop remembers the visit. Returning browsers do not get it again.
The default Vite UI does not show the web intro automatically.

Narrow guidance uses a content-width heading,24px gap and224px laptop, anchored to
the work column's left edge. Live860↔1024 resizing preserved picture x523.546875/y579
and the24px text-to-picture gap, with no horizontal overflow. Wide guidance uses a
fixed22px heading-to-picture gap and natural illustration height, preserving its
approved y169 position after link removal and preventing status-height-driven movement.
Screenshots: `.tmp/browser-home-check-20261023/fixed-promise-{860,1024,wide}.png`.

Passed with `corepack pnpm --dir desktop-app`: i-layout (now16 combinations including
860px, fixed-gap/top alignment and link absence), processing-help (remaining guidance
and optional-input stability), local-engine-connection-ui intro-dismissal (all close
methods, keyboard containment, reload/revisit and no re-open link), typecheck and
changed-file ESLint. Home tests used `APP_URL=http://127.0.0.1:5196/`; the intro scenario
used the same server with `?view=minutes&localEngineConnection=1`. Playwright used the
existing project-local browser cache. These are UI simulations, not deployed HTTPS
or actual engine-analysis verification.

Actual in-app browser follow-up: a fresh isolated origin on127.0.0.1:5197 showed
the complete first-visit notice. Clicking 시작하기 closed it. A full page reload
showed zero notice dialogs; closing that tab and opening the same URL in a new tab
also showed zero. The removed details link stayed absent. The URL used
`/?view=minutes&localEngineConnection=1`; existing5196 records/storage were untouched.
The temporary server command was `corepack pnpm --dir desktop-app exec vite --host
127.0.0.1 --port 5197 --strictPort --configLoader runner`, cwd `D:\Projects\audio`.
The test tabs and temporary server were closed after verification. Evidence:
`.tmp/browser-home-check-20261023/first-visit-{notice,after-reload,revisit}-live.png`.

## Approved laptop proposal without subtitle — 2026-10-23

The later approved image proposal replaces the simple PC frame with a code-native
laptop bezel/camera and SVG keyboard deck, trackpad and front lip. The user removed
the subtitle; the headline, processing steps, external-AI boundary and full-help
action remain. On the1440px live screen both upload/action and guidance groups span
y125–491 (366px), and the heading rows align. At1024px the guidance stacks below the
actions with a compact laptop. No horizontal overflow or overlapping controls was
observed. Screenshots: `.tmp/browser-home-check-20261023/laptop-layout-{wide,narrow}.png`.
The existing i-layout12 combinations and processing-help scenarios passed after
updating both obsolete subtitle assertions. Typecheck/changed-file ESLint and
independent scoped source/visual review passed, with no required findings remaining.

Later refinement raises only the wide illustration content8px (screen y185→177),
preserving both groups'125–491 anchors. The full-help link uses13px normal muted
text while retaining underline/focus and dialog behavior. The no-response message
now requests launching the connection program and pressing the actual retry action;
the help names its Windows Start-menu entry. Runtime-boundary checks and type/lint
passed. Live1440px/860px checks cover the copy, overflow and both help surfaces.
Screenshot: `.tmp/browser-home-check-20261023/laptop-refined-wide.png`.

The subsequently approved status/action spacing uses a44px minimum status block
(20px title,4px gap,20px message), then12px before the right-aligned40px buttons.
Single-line/ready states reserve the same minimum space. At1440px the title/message
share x568, status y403–447, buttons y459–499 and the start button ends exactly at
the upload edge x1064. The12 layout combinations, help/recovery stability at
1440/1024/860px and changed-script ESLint passed. Screenshot:
`.tmp/browser-home-check-20261023/status-actions-aligned-wide.png`.

## Required inputs and balanced local-benefit layout — 2026-10-23

The three required fields show their requirement before submission while retaining
their accessible names and required attributes. The pre-selection format row shows
the two-hour limit from the same constant used for validation. The PC illustration
uses three equal columns: input, processing on this PC, and transcript/meeting summary.
Its lighter frame supports the upload action. Narrow layouts group the text/link
and shorten the illustration instead of spreading the text across its height.

Validation passed using `corepack pnpm --dir desktop-app`:
`NEW_RECORD_HOME_SCENARIO=i-layout test:new-record-home-flow` (12 combinations),
`NEW_RECORD_HOME_SCENARIO=processing-help test:new-record-home-flow`, and
`WRITER_READINESS_SCENARIO=help-stability test:writer-model-readiness`
(1440/1024/860px). Scenario selectors were set as environment variables, with
`APP_URL=http://127.0.0.1:5196/` and
`PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`.
Typecheck, changed-file ESLint and independent visual/source review passed.
The 1440px live screen has equal28px icon-to-screen edge margins and86px icon
center gaps, with no horizontal overflow. Screenshots:
`.tmp/browser-home-check-20261023/balanced-layout-{wide,narrow}.png`.
Capture after viewport settlement; an immediate capture after resizing can retain
the previous frame. This verifies Vite UI behavior, not an HTTPS/local-engine run.

## Help-popup stability and local-processing illustration — 2026-10-23

The live connection-error help reproduced a46px downward movement of the local
promise and recent records while the start button stayed still. Prior checks
covered only the button. `WriterActionRow` now renders supplementary help as a
positioned popup with outside/Escape dismissal and modal-Escape priority.
`WRITER_READINESS_SCENARIO=help-stability` checks exact rectangles for the header,
upload, start, local promise and recent records before/after help and readiness
recovery at1440/1024/860px. It also checks Settings opened with the keyboard:
Escape stays owned by Settings and returns focus to its opener. These cases pass.

The local benefit now has a responsive PC-boundary illustration on the right:
520px upload vs288px supporting illustration at the widest work column, with
a32px gap. Narrower containers stack the benefit below the actions. The illustration
uses existing icons and CSS with reserved geometry, no external image loading.
The16px heading, external-AI non-transmission sentence and full-help action remain
visible. `NEW_RECORD_HOME_SCENARIO=i-layout` passed12 width/file/record combinations;
`processing-help`, typecheck, changed-file ESLint and independent source review passed.
The popup modal-priority issue found in review was fixed and independently rechecked.
Commands use `corepack pnpm --dir desktop-app`, the existing5196 server and the
project-local Playwright cache. Live-browser screenshots:
`.tmp/browser-home-check-20261023/local-advantage-{wide,narrow}.png`.

## Approved layout implementation — 2026-10-23

Current source uses fixed208px wide navigation and a64px narrow header with
the explicit `메뉴` button. The240px overlay retains Escape/outside dismissal,
Tab cycling, inert workspace, settings focus restoration, unsaved edits and
audio continuity. Legacy sidebar collapse storage is ignored. The sidebar
simulation now checks these contracts, including focus returning to the brand
after widening the header. Independent source review caught that missing
expanded-mode focus target; it was fixed and reviewed again.

The home source now shares a1120px heading/body width, uses248px for metadata
(224px inputs+24px padding), and keeps upload/action/local-processing promise
in one work column. The local-processing title, external-AI non-transmission
sentence and full-help action remain visible. The permanent flow picture and
large empty-recent-record box were removed from this surface only.

Validation used the existing5196 server and `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`:
`corepack pnpm --dir desktop-app typecheck`, changed-source/script ESLint,
`test:sidebar-collapse wide`, and `test:new-record-home-flow` with
`NEW_RECORD_HOME_SCENARIO=i-layout`, `processing-help`, `term-overflow`.
The home layout passed12 width/file/record combinations (1440/1024/2044px),
full help/optional fields, and40-character terms with reachable remove actions.
The sidebar test initially expected a seeded recovery draft to remain after
opening the menu despite its empty backend-status mock. It now preserves the
original notification assertion before opening, while independently checking
the menu and retention contracts. Actual browser screenshots are in
`.tmp/browser-home-check-20261023/approved-layout-{wide,narrow}.png`.
These are frontend checks, with mocked APIs in simulations. The live browser
still reports no engine response; actual analysis/HTTPS/release remain separate.

## Live browser home-screen check — 2026-10-23

Visual follow-up: the upload area now has a light brand tint and a filled file
selection control; guidance has a white background. The upload column places
status copy above recovery/start actions in both ready and blocked states.
`NEW_RECORD_HOME_SCENARIO=i-layout` passed all 12 width/file/recent-record
combinations (1440/1024/2044px), including long filenames and the new status-above-action
contract. `NEW_RECORD_HOME_SCENARIO=processing-help` passed guidance/dialog and
optional-field position checks. Commands used `corepack pnpm --dir desktop-app
test:new-record-home-flow`, `APP_URL=http://127.0.0.1:5196/` and
`PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`.
Typecheck, changed-script ESLint and scoped independent review passed.
In the live browser's actual connection-error state at1440px, the title fits
one line in the400px upload column; opening help leaves the start button at
y=451, height40px. The1024px view was also inspected. Screenshots:
`.tmp/browser-home-check-20261023/home-refined-{1440,1024}.png`.
Engine readiness/real analysis remains unverified in this browser session.

Follow-up after user feedback: the rail reopen button now precedes the brand
button, keeping collapse/reopen on the same top row. Section headings and the
unfiled-list empty note are 13px; primary navigation remains 14px. Typecheck,
changed-file ESLint and `test:sidebar-collapse wide` passed (the latter runs
wide, narrow overlay/focus/audio and denied-storage scenarios). Independent
scoped source review found no required fixes. This supersedes the prior
logo-first rail placement; it does not claim the deferred visual proposals
are implemented.

Checked current `b83225f` frontend source in the Codex in-app browser at
`http://127.0.0.1:5196/` (title `LMO 회의록`), without engine mocks.
Session server: repository-root `corepack pnpm --dir desktop-app exec vite --host 127.0.0.1 --port 5196 --strictPort --configLoader runner`.
The server and deliverable browser tab remain open for follow-up.

- 1440×900: upload and processing/storage guidance appear side by side;
  expanding optional participants/terms leaves the analysis button at y=403.
- 1024×768: menu collapses to the icon rail; expand, Escape dismissal with
  focus return, list-icon reopening and collapse work. Upload and analysis
  button remain visible; guidance stacks below the upload controls.
- 860×720: fields and upload stack vertically without document horizontal
  overflow; analysis controls and guidance require scrolling. The guidance
  dialog opens and closes through its confirmation button.
- Processing/storage guidance text and dialog were inspected visually.
  No audio file was selected or submitted, and no analysis was started.
- The connection check eventually displayed `LMO 회의록 연결이 응답하지 않습니다`
  with recovery controls. This run verifies the source UI only; it does not
  establish engine readiness, production HTTPS behavior or Chrome/Edge permissions.

Screenshots: `.tmp/browser-home-check-20261023/{home-1440,home-1024,menu-1024}.png`.
Temporary viewport overrides were reset after checking.

## Native startup read recovery — 2026-10-23

`corepack pnpm --dir desktop-app test:desktop-startup-read` checks bounded native read recovery, caller cancellation, stalled JSON bodies, authentication responses and transient readiness answers (12 cases). `test:desktop-startup-ui` uses the caller's `APP_URL` and native bridge mocks: initial connection refusal must recover summary/audio without a refresh; background checks preserve the audio source. Run the default scenario, `--completed --preparing`, and `--completed --managed` serially. The completed-summary scenario failed before the initial status gate was added. Missing models and browser permission requests are not retried. These are mocked UI checks; the actual EXE restart/generation evidence is in the existing release checklist and release QA row, with `.tmp/native-startup-fix/final-report.json` recording the local result.

Dedicated server: repository-root `corepack pnpm --dir desktop-app exec vite --host 127.0.0.1 --port 5198 --strictPort --configLoader runner`; `APP_URL=http://127.0.0.1:5198/`, `COREPACK_HOME=D:\Projects\LMO_audio\.cache\corepack`, `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\LMO_audio\.cache\ms-playwright`. HTTP200 and the LMO 회의록 title were verified. The session-owned server was stopped after checks; the same command restores it.

## Remote integration with local work preserved — 2026-10-22

Integrated `4320cec..77555e3` (14 origin/main commits) in `D:\Projects\audio`.
The original local edits remain uncommitted and the recovery stash is retained.
Independent deployment, update/data-protection and UI reviewers found one UI
merge defect: the local column direction overrode the wide information panel's
label/action rows. The wide container now explicitly restores row alignment;
`columns` checks the actual label/action positions. Conflicting design and QA
records retain the newer remote UI decisions and the local experiment/release
history; an old deploy status is explicitly marked historical.

Checks passed, run serially with the installed dependencies:

- `corepack pnpm --dir desktop-app typecheck` and affected TSX/JS ESLint.
- `corepack pnpm --dir desktop-app test:meeting-detail-layout columns`, `meta`,
  and `summary-review`: two column sizes, one narrow metadata case and two
  guidance/keyboard/reopen cases.
- `corepack pnpm --dir desktop-app test:analysis-stop-flow detail-continuity`:
  all four foreground/background/audio-error cases. The first narrow run sent
  Escape before menu focus was ready. The final test waits for automatic focus
  and the scrim to disappear; it does not force focus or bypass pointer blocking.
- `corepack pnpm --dir desktop-app test:sidebar-collapse narrow`: passed after
  its mode helper also waited for automatic focus inside the overlay, including
  Escape, Settings focus return, resizing, unsaved edits and audio continuity.
- Seven selected `tests.test_portable_release_scripts` cases and four selected
  `tests.test_update_package_scripts` cases passed with
  `backend/.venv-desktop/Scripts/python.exe -B -X utf8 -m unittest` and
  `TEMP`/`TMP=D:\Projects\audio\.tmp\merge-origin-20261022\temp`.
  They cover manifest trust, preserved data, Ollama replacement/guide recovery,
  live-target refusal and untrusted update lists. Rust's four actual port/socket
  tests also passed (`.tmp/merge-origin-20261022/backend-port-tests.exe`).

The dedicated server was started from the repository root with
`corepack pnpm --dir desktop-app exec vite --host 127.0.0.1 --port 5197
--strictPort --configLoader runner`; HTTP200 and title `LMO 회의록` identified it.
`APP_URL=http://127.0.0.1:5197/` and
`PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright` were used.
Only this session's server is cleaned up after checks; the same command restores
it. Browser checks mock the engine. Native executable/update/handoff QA remains
open in the existing release checklist and release QA table. No build, push or
production deployment was performed.

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

## Processing status alignment — 2026-10-21

The analysis, transcript and participant-separation items now share a three-column
layout with each status below its label. Verified with `corepack pnpm --dir
desktop-app typecheck`, changed-file ESLint, the layout simulation's `meta`
scenario at760px, and the analysis-stop simulation's `detail-continuity` selection
(four preparation/completion/reopen/background/audio-error scenarios at1280px
and760px). All passed; independent source review found no blockers.
These are mocked browser checks. The verification server used port5201 in
`D:\Projects\audio` and was stopped after checks.

## Summary review guidance — 2026-10-21

The focused `summary-review` scenario in `simulate-meeting-detail-layout.mjs`
verifies the persistent accuracy notice across summary/topic/speaker views,
keyboard activation of `대화록 확인` and focus on the transcript tab, empty
summary and saved-record reopen states, and stable tab positions/no notice
overflow at1280px and860px. It uses synthetic records and mocked APIs; it does
not verify model accuracy or the installed app. Unsaved-edit round trips were
reviewed in source, not exercised by this scenario.

Commands from `D:\Projects\audio`:

```powershell
$env:APP_URL='http://127.0.0.1:5199/'
$env:PLAYWRIGHT_BROWSERS_PATH='D:/Projects/audio/.cache/ms-playwright'
$env:SUMMARY_REVIEW_SCREENSHOTS='D:/Projects/audio/.tmp/summary-review-ui-20261021'
corepack pnpm --dir desktop-app exec node --experimental-strip-types scripts/simulate-meeting-detail-layout.mjs summary-review
corepack pnpm --dir desktop-app typecheck
corepack pnpm --dir desktop-app exec eslint src/MeetingHistory.tsx scripts/simulate-meeting-detail-layout.mjs
```

The documented older `D:\Projects\LMO_audio\.cache\ms-playwright` path had no
browser on this checkout. The matching1217 browser already existed under the
current project's `.cache`; no download or dependency reinstall was needed.
Port5198 was occupied and its unknown owner was left untouched. The session
started `corepack pnpm --dir desktop-app exec vite --host 127.0.0.1 --port 5199
--strictPort --configLoader runner`
and confirmed `/`, `/src/main.jsx` and `/src/index.css` return200. The UI server
is left running at the user's request. Typecheck, changed-file ESLint and both
focused browser scenarios pass; independent review found no blocking defect.

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

## 2026-10-24 local-processing emphasis and recovery

On the session-owned Vite server at `http://127.0.0.1:5183/`, the actual in-app browser showed the requested `보안 걱정 NO, 외부 AI 전송 없음` heading, no text beneath the laptop, and the narrow header's menu at the left. Screenshots: `.tmp/browser-home-check-20261024/wide.png` and `narrow.png` (860×900). The viewport override was reset afterward.

The backend on17863 was healthy but initially omitted5183 from its allowed origins. Restarting only the session-owned backend with the exact origin appended to process-local `LMO_WEB_ALLOWED_ORIGINS` restored browser access automatically. The origin response and health were verified; no backend source, authentication, stored data or models changed. Commands, working directories and server identifiers are recorded in `.tmp/dev-servers-20261024.json`.

Focused verification used `APP_URL=http://127.0.0.1:5183/` and `PLAYWRIGHT_BROWSERS_PATH=D:/Projects/audio/.cache/ms-playwright`:

- `NEW_RECORD_HOME_SCENARIO=i-layout corepack pnpm --dir desktop-app test:new-record-home-flow`:16 combinations at1440/1024/860/2044px passed.
- `corepack pnpm --dir desktop-app test:sidebar-collapse`:3 navigation/focus/audio-continuity cases passed, including left menu placement.
- `WRITER_READINESS_SCENARIO=help-stability corepack pnpm --dir desktop-app test:writer-model-readiness`: recovery destination, focus return, persistent-error actions, automatic recovery and stable layout anchors passed at1440/1024/860px.
- With `APP_URL=http://127.0.0.1:5183/?view=minutes&localEngineConnection=1`, `LOCAL_ENGINE_UI_SCENARIO=missing-models`, `no-response`, `browser-blocked`, `permission-prompt` and `connection-flow` each passed via `corepack pnpm --dir desktop-app test:local-engine-connection-ui`. These cover automatic readiness after model installation, timeout/server-error recovery, permission/extension guidance, explicit first-use permission and native approval/session-expiry preservation. `writer-guidance` also passed at the default URL.
- `corepack pnpm --dir desktop-app test:runtime-boundary`, `corepack pnpm --dir desktop-app typecheck`, changed-file ESLint and `git diff --check` passed. Independent source review found a persistent-error action regression; it was fixed and the affected three-width check passed. No remaining confirmed P1/P2 findings in this scope.

Scripted connection/model replies are mocked. Actual browser evidence confirms the running local UI and connection, not a new packaged release, model download or inference run.

### Same-day user review: show only the next useful action

Independent user-flow and implementation reviews agreed to hide start/resume before file selection or while a blocking issue requires recovery. Required metadata validation stays available after selecting a file; optional updates do not block start. A later user decision also removes the normal `이 PC와 연결됨` text and success icon. The status live region and40px action reservation remain mounted to keep the work surface steady.

`NEW_RECORD_HOME_SCENARIO=start-visibility corepack pnpm --dir desktop-app test:new-record-home-flow` passed at1440/860px: file selection/removal, required-field focus, model settings recovery, automatic server recovery, removed-button focus and stable guidance/recent/action bounds. The16 `i-layout` combinations also passed with no normal connection notice. `LOCAL_ENGINE_UI_SCENARIO=input-stage` covered duration, duplicate analysis and resume recovery; `missing-models`, `no-response` and `connection-flow` passed after hiding the blocked start button. The full writer-model-readiness script passed across web/desktop model, GPU, diarization, validation and recovery paths. Typecheck, changed-file ESLint and diff checks passed. These use the same5183 server and project-local browser cache above; no analysis was submitted by the new start-visibility test. Actual browser screenshots are `.tmp/browser-home-check-20261024/quiet-home-wide.png` and `quiet-home-narrow.png`.

## Preferred debugging order

The quiet-model/search slice also passed the full `test:writer-model-readiness` and its focused `WRITER_READINESS_SCENARIO=reinstall`, including Settings return refresh, delayed model responses and repair-guidance retention. Typecheck, changed-file ESLint, the two-component detector (0findings), diff check and independent source review passed. Normal actual model-screen capture: `.tmp/browser-home-check-20261024/settings-models-quiet-search.png`.

2026-10-24 quiet model status and reusable search UI: normal model checks and the managed-stopped explanation/retry banner were removed. Returning focus/visibility to the models tab refreshes inventory quietly; real read failures retain retry. `test:settings-model-management` passed automatic-return refresh, no background polling/download, normal-notice absence, official-search-open failure preserving search, delayed old open completion after query changes, pull failure, installed-model use/save, explicit runtime installation and STT prepared-state detection. The search is the official catalog in a separate tab, not an in-app catalog or existence validation. Actual IAB entry `qwen3:0.6b` opened `https://ollama.com/search?q=qwen3%3A0.6b`; its query/results were visible while5183 retained Settings/input and switched to explicit 받기. No actual model pull was submitted. Screenshots `.tmp/browser-home-check-20261024/ollama-search-official-live.png` and `summary-model-search-after-open.png` capture both sides. New `OllamaModelSearch.tsx` receives operation/state callbacks; platform-specific navigation remains in `apiBase.ts` and Settings. Search uses native safe new-tab navigation on web to avoid same-page fallback when noopener returns no window handle.

2026-10-24 shared Settings rail and single-model de-duplication: horizontal tabs and content now share the768px rail and stable scrollbar gutters. `corepack pnpm --dir desktop-app test:settings-model-management` passed with added tab/content x/width checks, equal general/model bounds after switching, a single prepared-model title and no duplicate download action. Keyboard checks now wait for the implementation's scheduled focus before sending the next arrow key. Existing download/stop/progress/runtime-install checks remain. Typecheck, changed-file ESLint, `git diff --check`, the single-file design detector (0findings) and independent source review passed. Actual screenshots: `.tmp/browser-home-check-20261024/settings-general-aligned.png` and `settings-models-aligned.png`, captured from the running5183 app without changing settings or downloading models.

2026-10-24 compact Settings and target emphasis: shared Settings spacing was tightened while text sizes, wrapping and control targets remain. `WRITER_READINESS_SCENARIO=settings-targets` with `SETTINGS_TARGET_SCREENSHOTS=D:/Projects/audio/.tmp/settings-density-20261024` passed1440/860px and860px reduced-motion cases. It clicks the GPU recovery shortcut, checks the correct target's transient emphasis, unchanged bounds after expiry, no target overflow and preserved keyboard focus, then saves CPU and reaches ready. `recovery-completion`6paths also passed with highlight checks on internal device/diarization/model navigation. `test:settings-model-management`, typecheck, changed-file ESLint and independent scoped review passed. Actual IAB captures are `.tmp/browser-home-check-20261024/settings-{general,models}-compact.png`; target screenshots use mocked GPU failure. No model installation or analysis was submitted.

2026-10-24 recovery completion implementation: the preceding three destination-audit items are now implemented. Missing installer/update URLs open the existing support contact with a real mail link; recommended app-managed summary installation is distinguished from the external Ollama alternative; a connected engine with remaining model/device/diarization conditions shows the next relevant action, and only confirmed preparation enables return to the writer. `WRITER_READINESS_SCENARIO=recovery-completion` passed6 mocked paths including actual CPU/diarization settings saves and recovery return. The diarization response is held after saving off to prove stale required-model flags never recommend reinstalling. Focused `reinstall` passed503 retention, contact opened while automatic repair removes its opener, focus fallback to recovery and ready-state return. Full `test:writer-model-readiness` and `test:settings-model-management` passed. The latter verifies no automatic runtime download, official external install navigation, one explicit app-runtime request and existing-Ollama reuse. Typecheck, changed-file ESLint and independent user/implementation review passed. Existing12-case gallery was recaptured. Actual IAB Settings on5183 also showed the existing managed runtime without installation actions; screenshot `.tmp/browser-home-check-20261024/settings-existing-ollama-live.png`. Browser tests retain the mock/actual-install distinction above.

2026-10-24 destination audit: `corepack pnpm --dir desktop-app test:writer-model-readiness` passed, exercising GPU→CPU save, diarization setting→off, readiness recovery and missing-field focus. The local-engine `connection-flow`, `input-stage`, `missing-models`, `browser-blocked` and `no-response` scenarios passed with `APP_URL=http://127.0.0.1:5183/?view=minutes&localEngineConnection=1` and `PLAYWRIGHT_BROWSERS_PATH=D:/Projects/audio/.cache/ms-playwright`. The query is required for connection scenarios; the normal Vite root intentionally omits the first-visit web connection dialog. `connection-flow` now actually clicks the expired connection's recovery action, checks a fresh pairing and ready-state return, and verifies title/purpose and filename display remain. Independent source review and changed-script ESLint passed. These are mocked browser flows, not OS installation, model inference or a native restart. Three remaining user-guidance improvements are recorded in `todo.md` under the destination-audit P2 item.

2026-10-24 alignment and Settings cleanup: the home `start-visibility` scenario verifies actual problem-title/button center alignment within1px at1440/860px. `corepack pnpm --dir desktop-app test:settings-model-management` passed with the repeated introduction removed and installed-model selection/download behavior retained. The full `test:writer-model-readiness` passed, including a held automatic Settings retry that keeps the durable error and panel position until success. Its focused `WRITER_READINESS_SCENARIO=reinstall` passed: a failed model refresh retains repair guidance and a successful installed-model response clears it. `LOCAL_ENGINE_UI_SCENARIO=browser-blocked` passed with one recovery explanation instead of the repeated start-menu row. Typecheck, affected-file ESLint and diff checks passed. Independent product/implementation review found and resolved duplicate read-error presentation, retry flicker and repair-guidance loss; successful payload warnings are not labeled read failures, and response-blocking extensions retain an available installer link while browser permission refusal does not recommend reinstalling. These remain mocked UI checks using5183 and the project-local browser cache.

2026-10-24 common recovery follow-up: problem rows now show no secondary message/help and one Settings icon with `문제해결`, while retaining their action kind and destination. First-use connection permission and optional updates keep their setup copy. The missing-field list remains sr-only with its original aria-describedby ID; recovery focuses the next missing field. Original resume filenames remain in the upload area. The full writer-model-readiness simulation, local-engine `input-stage`, `connection-flow`, `browser-blocked`, `permission-prompt`, `missing-models`, `no-response`, and home `start-visibility` at1440/860px passed. The dedicated `WRITER_READINESS_SCENARIO=reinstall` also passed with an authenticated engine and a missing non-downloadable model: recovery shows reinstall guidance and no model-settings loop. Two agent perspectives identified the expired-session disabled-action risk and connected-reinstall loop; these were fixed and rechecked. The12-case gallery was recaptured and each recovery/picker destination checked without downloading or analyzing. Typecheck, affected-file ESLint and runtime-boundary tests passed. Actual installation and packaged-runtime verification remain separate.

2026-10-24 adjacency follow-up: recovery controls moved into `.writer-issue-row` beside their own status, with12px horizontal/8px wrapped gaps. Primary start/resume remains in the reserved `.writer-action-buttons` row. The `start-visibility` scenario now checks adjacent bounds and zero overflow at1440/860px, in addition to focus, navigation and stable primary/guidance/recent anchors. The actual12-case gallery (`.tmp/error-guide-20261024`, local preview URL in `server.json`) was recaptured; model/GPU/diarization/connection buttons still open their existing destinations and file recovery still opens the picker. This is mocked UI evidence, not inference or installation.

1. Run `test:generation-flow` first for pure state helpers.
2. Run the targeted Playwright simulation for the UI flow you changed.
3. Only fall back to manual browser clicking when the simulation itself is blocked by environment issues.

## Do not confuse these runtimes

- Codex in-app browser: useful for manual verification in this chat session.
- Project Playwright: used by `desktop-app/scripts/simulate-*.mjs`.

They are not interchangeable. A flow that works in the in-app browser can still fail in project Playwright if the Playwright browser runtime is missing or blocked.


### 2026-10-23 first-screen columns before portable build

The H first-screen design uses the same 280px information rail and 50rem content breakpoint as meeting details. Title/date/purpose precede file selection in reading order. The file, start controls, processing guidance and recent meetings remain in the work column. Optional fields only expand the information column on supported desktop widths.

Verification used the session-owned Vite server at http://127.0.0.1:5199/, started from the repository with `corepack pnpm --dir desktop-app dev --host 127.0.0.1 --port 5199 --strictPort --configLoader runner`. Set `APP_URL` to that URL and `PLAYWRIGHT_BROWSERS_PATH=D:/Projects/audio/.cache/ms-playwright`. `corepack pnpm --dir desktop-app test:new-record-home-flow` passed all home scenes after the two-column update. It covers 1440/1024 placement, 880px fallback, date input bounds, required-field focus order, optional expansion keeping file/start position, recent/recovery/cancellation behavior and the actual meeting-title heading when returning to analysis. The 40-character ASCII term regression initially overflowed the field by118px and hid its delete button; after bounding and wrapping chips, field/rail overflow are0 and the delete control remains reachable at both widths.

`NEW_RECORD_HOME_SCENARIO=capture` with `NEW_RECORD_HOME_SCREENSHOTS=D:/Projects/audio/.tmp/home-release-20261023/screenshots` records empty and selected-file screens at1440x900 and1024x768. Product text stays Pretendard; labels14px/600 and section headings16px/600 were observed. Typecheck, changed-file ESLint and diff checks passed. These are mocked Vite UI checks; final packaged-runtime, actual summary and restart checks remain separate release gates.

### 2026-10-23 adopted I layout

The adopted Figma I board `86:2237` keeps the H header/information rail. At actual work-content widths >=800px, upload/actions share a row with312px processing guidance and a24px gap. The existing common workspace padding remains:1440px gives824px work content,488px upload;1024px gives608px upload with actions and guidance below it. Normal readiness says `이 PC와 연결됨`16px before start. Recent meetings always have a heading and distinguish loading, failed/retry, confirmed empty and populated states independently of file selection. Existing date grouping and recovery behavior remain.

Using the same5199 server and local browser cache, `corepack pnpm --dir desktop-app test:new-record-home-flow` passed all prior scenes plus the8 I combinations (1440/1024 × selected/empty file ×0/2 saved records). `NEW_RECORD_HOME_SCENARIO=i-layout` and `NEW_RECORD_HOME_SCREENSHOTS=D:/Projects/audio/.tmp/home-release-20261023/screenshots-i` capture those8 states. Long filenames retain one-line ellipsis/full-name help; optional input preserves the action position. The optional refold assertion measures the owning workspace scroll offset: a5px focus scroll is not a layout movement.

`corepack pnpm --dir desktop-app test:writer-model-readiness` and `LOCAL_ENGINE_UI_SCENARIO=writer-guidance corepack pnpm --dir desktop-app test:local-engine-connection-ui` passed. The desktop readiness-error case specifically uses1440px/488px upload width: two recovery buttons and start remain in view, and status/action/document overflow is0. Screenshot `screenshots-i/desktop-readiness-error-1440.png` records the multiline status. `corepack pnpm --dir desktop-app test:runtime-boundary`, typecheck, changed-file ESLint and diff checks passed. Independent source/interaction review found no remaining current-scope blockers. These still use mocked API replies; the actual packaged engine/model/save/restart gates are recorded in the release checklist.

Later user-approved refinement supersedes those initial I widths: equal upload/guidance columns with upload capped504px, one processing/storage guidance panel and a text help action, and the rail expand button below the logo. On the design chat's existing5183 server,1440/1024/2044px gave12 file/record combinations; home processing-help, all3 sidebar-collapse cases, connection intro-dismissal and writer-guidance passed alongside typecheck/changed-file lint and independent review. Evidence: `.tmp/i-guidance-refinement-20261023/screenshots`. No model inference or subsequent full build was run for this final refinement; company follow-up is the single item at the top of the Immediate queue in `todo.md`.

## Public finite JSON body deadline — 2026-10-25

공개 소스 `e796ea3`의 실제 부분 HTTP 본문200/500 시뮬레이션은 약20초 실패 안내, Esc 닫기, 입력 보존·정상 응답 회복과 분석 POST0을 통과했다. 이전 공개 번들은 같은 시험에서24초 안에 안내를 찾지 못해 실패했다. 가상 시간이 아닌 실제20초 설정 기한을 사용했으며 설치 엔진 장애 시험과 구분한다. 명령·캐시·증거·실제 공개 배포 후 재열기/재생은 [배포 체크리스트](release-checklist.md#공개-웹-json-본문-기한-수정배포--2026-10-25)를 따른다.

### 2026-10-24 승인 모델 관리 시안 구현 · 검증 제한

- 고정·외부 검색·중복 선택창 검증은 최신 계약으로 대체했다. 검색→목록 등록(다운로드·사용 선택 없음)→행에서 받기·단일 선택·휴지통 옵션,4개 단위 목록, 저장 응답 경합·받기 중지·불명확한 목록 상태 복구·재진입 저장 검증을 유지한다.
- 통과: `corepack pnpm --dir desktop-app typecheck`, 시뮬레이션 `node --check`, `git -c core.excludesFile= diff --check`, 독립 소스 검토. 백엔드 catalog/API 집중 검사18개와 공식 목록 실조회·manifest 확인은 통과했으며 설정 저장·실제 모델 다운로드는 하지 않았다.
- 초기 환경 실패: Node의5183 fetch/http 요청은 시간 초과였고 PowerShell HTTP는200이었다. 테스트 전용 Vite52504도30초 준비 한도를 넘겼다. 테스트 프로세스·전용 서버는 정리하고5183 UI 서버를 유지했다. 이후 의존성 로딩과 Node HTTP가 회복된 증거를 확인한 뒤 같은 모의 시뮬레이션을 재실행했다.
- 최종 통과: `corepack pnpm --dir desktop-app test:settings-model-management`(APP_URL=http://127.0.0.1:5183/, PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright).1360×900/860×720 두 열·스크롤 없음, 초점/도움말/설치 목록 미확인 복구, 검색 실패·빈 결과·4개 단위 검색 결과·오래된 응답 무시·추가만 수행, 다운로드·선택·중지·삭제 취소/목록 제거/파일 삭제, 늦은 선택 응답과 추가 목록 보존, 일반 설정 저장·삭제 후 GET 경합, 닫기·재진입을 확인했다. 모든 모델/설정 API는 모의 데이터이며 실제 파일 다운로드·삭제는 없다. 캡처 `.tmp/settings-approved-20261024/settings-model-flow-1360.png`, `settings-model-flow-860.png`.
- 레이아웃 검사에서 정상 상태의 기존 재시작 footer(99px 초과)와 그룹 간격(3px 초과)을 찾아 고쳤다. 재시작 영역은 복구 맥락에서만 보이고, 알려진 설정 읽기 오류는 재시도 중에도 유지한다. 그룹 제목-본문 간격은 승인 피그마와 같은6px다.
- ESLint 초기 Corepack 경유·직접 CLI는 설정/의존성 로딩이 길어 중단했다. 직접 설정 import 완료 후 재검사에서 검색 컴포넌트의 ref props 접근 오류를 고쳤다. 최종 `node node_modules/eslint/bin/eslint.js src/Settings.tsx src/OllamaModelSearch.tsx`와 `corepack pnpm typecheck`(cwd `desktop-app`)는 통과했다. 종료한 것은 이번 검사 작업뿐이며 다른 프로젝트 프로세스는 손대지 않았다.
- 실제 인앱 브라우저 접근은 도구의 URL 보안 정책이 거부했다. 다른 브라우저나 직접 프로토콜로 우회하지 않았다. 이 기록은 실제 화면 확인을 대체하지 않는다.
- 남은 확인: 실제 인앱 브라우저 정책이 허용된 뒤 사용자 설치 목록으로 화면을 확인하고, 최신 설치형 엔진에서 공개 검색·등록을 재확인한다. 모의 검사는 실제 모델 다운로드 복구나 설치형 실행까지 증명하지 않는다. 현재 서버 정보는 `.tmp/dev-servers-20261024.json`이며 연결 서버는17863에서 새 API를 가동한다.


2026-10-24 모델 버튼 일관성 후속: 모델 선택·사용 중도 받기·휴지통과 같은32px 사각형/공유 모서리/1px 테두리/16px 아이콘으로 통일했다. 선택은 청록 체크, 현재 모델은 청록 바탕·흰 체크와 행 강조로 구분하며 단일 선택·저장 동작은 유지한다. 독립 검토, typecheck, 변경 파일 ESLint, `corepack pnpm --dir desktop-app test:settings-model-management`와 diff 검사를 통과했다.1360×900/860×720 정렬·스크롤 없음과 선택/저장/삭제 흐름을 모의 API로 검증했다. 재진입 검사는 모델 목록이 표시된 뒤 페이지를 찾도록 기다린다. 최신 캡처는 `.tmp/settings-square-actions-20261024/settings-model-flow-1360.png`, `settings-model-flow-860.png`이며 실제 설치 모델 검증은 아니다.


2026-10-24 실제 첨부 화면과 시안 차이 보완: 준비 완료 fixture만으로 확인했던 범위를 확장해 두 모델·managed_stopped·inventory_checked=false를 재현했다. 저장된 선택 체크를 준비 확인과 분리해 유지하고 변경은 막는다. 상단의 추가 안내 행과 모델마다 반복하던 확인 필요 문구를 없애고 공통 하단32px 줄에서 확인 조치를 제공한다. 두 모델일 때 빈 두 번째 행을 예약하지 않으며 세 모델 이상은 마지막 페이지 높이를 유지한다.917×627/860×720/1360×900에서 모델 카드160px 이하·설정 세로 넘침 없음·저장 영역 전체 표시·현재 모델 첫 행·미확인 변경/다운로드 차단을 통과했다. 기존 전체 모델 관리 모의 시뮬레이션, typecheck, ESLint와 독립 검토도 통과했다. 캡처 `.tmp/settings-figma-state-parity-20261024/settings-unconfirmed-two-models-{917,860,1360}.png`는 첨부 상태를 재현한 모의 데이터이며 실제 사용자 설치 목록의 직접 캡처는 아니다. 기존 인앱 브라우저 URL 접근 정책 제한은 유지한다.


2026-10-24 선택·삭제 응답 경합 및 초점 회귀 수정: 삭제 후 GET은 해당 대상의 목록 포함 여부만 반영하고, 등록 응답도 요청한 모델 한 항목만 병합한다. 늦은 응답이 다른 모델의 선택·등록·삭제를 되돌리지 않게 했다. 선택 완료 후 대상 페이지와 단일 선택 조작으로 초점을 옮기되 다른 조작을 시작했으면 빼앗지 않는다. 검색 복귀도 목록 렌더 중 취소되지 않는 대기 상태로 대상 페이지를 기다린다. 자동 실행 가능한 정지 상태의 안내는 `받은 모델을 확인해 주세요.`로 통일했다.

- 통과: `corepack pnpm --dir desktop-app test:settings-model-management`(APP_URL=http://127.0.0.1:5183/, PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright), `corepack pnpm --dir desktop-app typecheck`, 변경 Settings ESLint, 시뮬레이션 `node --check`, diff 검사와 독립 에이전트 소스 검토.
- 새 검증: 설치·등록 모델5개 이상에서 두 번째 페이지 모델을 Space·클릭으로 선택한 뒤 수동 페이지 이동 없이 체크·초점 확인. 삭제 후 GET 응답을 지연시킨 사이 다른 모델 선택·등록을 완료하고 이전 응답이 이를 보존하는지 검사. 반대 순서의 늦은 등록 응답도 이미 삭제한 다른 모델을 복원하지 않는지 확인. 검색 복귀는 검사 도우미가 페이지를 찾아주지 않고 앱 자체의 자동 페이지·초점을 검증한다.
- 기존 일반 설정 저장 경합,917×627/860×720/1360×900 배치, 다운로드·중지·삭제 취소/확인·연결 복구·닫기/재진입도 통과했다. 모의 API이며 실제 모델 설치·다운로드·삭제는 없다.
- 모의 DELETE가 파일 삭제 때 사용자 등록을 남기던 차이를 실제 backend/main.py 계약에 맞게 수정했다. 사용자 등록 모델은 파일과 등록이 제거되고 기본 추천 후보는 남는다. 재진입 검사는 고정된 예시 모델명이 아니라 닫기 직전의 실제 선택을 보존하는지 검사한다.


2026-10-24 검색 등록 후 다음 조작·모델 도움말 보완: 검색 결과의 등록 완료 표시는 `목록에서 보기`로 바뀌며 해당 모델 페이지와 다음 조작으로 이동한다. 모델 이름 옆 도움말은 실제 검색 특성과 확인된 용량만 사용하고, 같은 설정창 안에서는 다른 검색 후에도 유지한다. 음성 보관이 꺼져 자동 저장이 잠겼을 때는 켜야 하는 선행 조건을 안내한다.

- 집중 시뮬레이션에서 받기 완료 시 설치 상태 정렬 때문에 모델이 다른 페이지로 이동하던 문제를 발견했다. 설치 확인·받기 완료는 순서를 바꾸지 않고 명시적 선택만 맨 앞으로 이동하도록 수정했다. 검사는 다운로드 후 수동 페이지 이동 없이 바로 선택할 수 있는지 확인한다.
- 통과: `corepack pnpm --dir desktop-app test:settings-model-management`(APP_URL=http://127.0.0.1:5183/, PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright), `corepack pnpm --dir desktop-app typecheck`, Settings 변경 파일 ESLint와 독립 소스 검토. 검색→추가→목록에서 보기→받기→선택, 기존 등록 모델로 바로 이동(중복 등록 없음), 모델 특성·실제 제공 용량/미제공 구분, 검색 후 목록 도움말, 자동 저장 선행 조건, 도움말 초점·hover·Esc와 레이아웃 불변을 검사했다. 기존 선택·삭제 경합 회귀도 유지한다.
- 캡처: `.tmp/settings-ux-handoff-20261024`의 `settings-search-before-add-{917,860,1360}.png`, `settings-search-after-add-{917,860,1360}.png`, `settings-search-model-info-{917,860,1360}.png`, `settings-list-model-info-{917,860,1360}.png`, `settings-audio-save-disabled-help.png`.917×627/860×720/1360×900에서 모의 API로 앱 UI를 실행했다. 실제 사용자 브라우저의 설치 목록·모델 다운로드 결과가 아니다. 정상 배치 검사는 오류를 의도적으로 발생시키기 전에 수행하며, 오류 상황에서는 필요한 조치를 위한 본문 스크롤을 허용한다.
- 실제5183 인앱 탭 관찰은 자동 승인 검토가 거부했다. 앞선 origin 접근 거부 뒤 같은 주소의 권한을 다시 요청하는 것을 우회로 판정했으며 다른 브라우저·직접 프로토콜로 재시도하지 않았다. 실제 설치 목록과 설치형 엔진 확인은 기존 release QA 행에 미완료로 유지한다.


2026-10-24 CPU/HWPX 정렬·상태 표시 후속: 첨부 화면의 분석 장치·다운로드 형식 선택 상자를124px로 통일해 시작선과 오른쪽 기준선을 맞췄다. 음성 인식 모델의 최초·수동 확인은 제목 오른쪽32px행의 `확인 중`→`준비됨`으로 바뀌며 별도 아래 로딩행은 제거했다. 사용 중 모델의 행 배경을 없애고 채워진 사각형 체크는 유지한다.

- 정지 상태의 `받은 모델 확인`은 실제 동작인 `요약 프로그램 실행`으로 변경했다. 확인 실패 뒤에는 `연결 다시 확인`, 이미 준비 중이면 안내만 한 번 표시하고5초 뒤 상태를 조회한다. 조회는 실행·다운로드를 요청하지 않으며 준비 종료/설정 닫기/재시작 때 예약을 정리한다. 별개 장치 오류는 준비 조회를 막지 않고 조회 실패의 기존 재시도와 구분한다.
- 집중 시뮬레이션은917×627/860×720/1360×900의 선택 상자 폭·오른쪽 정렬, 로딩/준비 상태 슬롯, 같은 모델 행 배경·현재 체크, 정지→실행·실패→재확인, 두 종류 준비 상태와 자동 정상 복귀를 검사한다. 기존 검색·추가·받기·선택·삭제 경합 검사도 유지한다. `corepack pnpm --dir desktop-app test:settings-model-management`(APP_URL=http://127.0.0.1:5183/, PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright)와 타입·변경 파일 ESLint를 통과했다.
- 캡처는 `.tmp/settings-alignment-20261024/settings-unconfirmed-two-models-{917,860,1360}.png`, `settings-speech-checking-{917,860,1360}.png`, `settings-speech-manual-checking.png`, `settings-summary-preparing-{managed_starting,runtime_preparing}.png`다. 모든 모델/설정 API는 모의 데이터다. 사용자 첨부 화면은 상태·정렬 문제의 근거로 읽었으며 실제 인앱 탭 접근 제한을 우회하지 않았다. 실제 설치 목록·다운로드·삭제 확인은 기존 release QA의 미완료 범위다.


2026-10-24 설정 제목 위계·항목 구분: 분석·회의 요약 모델·저장 제목을 공통14px/600·진한 색으로 통일했다. 제목 줄 높이는16px로 유지하고 분석 장치와 음성 인식 모델 사이에 옅은 세로 구분선을 추가했다. 초기14px 기본 줄높이에서는 정상 화면5px넘침을 발견해 기존 줄 높이를 유지하도록 수정했다. `corepack pnpm --dir desktop-app test:settings-model-management`(APP_URL=http://127.0.0.1:5183/, PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright), 독립 소스 검토와 diff 검사를 통과했다.917×627/860×720/1360×900 배치·정상 상태 스크롤과 기존 설정 흐름을 모의 API로 확인했다. 캡처는 `.tmp/settings-hierarchy-20261024`이며 실제 인앱 탭 검증을 대신하지 않는다.


2026-10-24 설정 두 열 간격·기준선 통일: 시각적 구성과 사용자 조작 연결을 나눈 두 에이전트 검토에서 gap0 때문에 왼쪽 조작이 오른쪽 항목명에 붙고, 첫 줄만 세로선이 있으며, 모델 목록은 패널·행 여백이 겹쳐8px더 들어가는 문제를 확인했다. 분석·모델·저장에 공통24px열간격을 적용하고 세로선을 제거했다. 모델 그리드는 패널의 중복 안쪽 여백을 상쇄해 이름·조작 기준선을 맞췄다.

`corepack pnpm --dir desktop-app test:settings-model-management`(APP_URL=http://127.0.0.1:5183/, PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright), 타입 검사와 diff 검사 통과.917×627/860×720/1360×900 정상 배치·스크롤·CPU/HWPX 정렬과 기존 검색/추가/받기/선택/삭제 응답 경합을 모의 API로 검증했다. 독립 후속 검토는917/860px 캡처에서 항목 구분·기준선·새로운 가림/잘림이 없음을 확인했다. 근거 `.tmp/settings-column-gap-20261024`; 실제 인앱 탭·설치 모델 검증은 아니며 기존 release QA의 직접 확인 미완료 범위를 유지한다.


2026-10-24 실제 인앱 브라우저 재연결·설정 배치 확인: 앞선 주소 승인 거부가 계속 유지된다는 판단을 다시 점검했다. 브라우저 목록에서 기존 LMO 회의록 탭을 확인했고, 5183 서버도 기존 PID26476으로 유지됐다. 확인한 사용자 config에는 명시적인 browser_use 규칙이 없었다. 사용자가 해당 주소의 허용 상태를 확인한 뒤, 기존 인앱 브라우저의 정상 getTab API로 같은 주소에 연결하는 데 성공했다. 이전 거부의 정확한 계기(승인 만료·관리 정책·일시 판정)는 확정하지 않았다. 다른 브라우저·직접 프로토콜·보안 설정 변경은 사용하지 않았다.

기존 사용자 설정이 열린 실제 탭에서 1360×900과 860×720을 직접 확인했다. 네 paired-row와 모델 열 간격은24px, 모델 조작은32×32px, CPU/HWPX 선택은124px·같은 오른쪽 기준선, 세 제목은14px/600이다. 두 크기 모두 가로 넘침0·설정 본문 세로 넘침0이며 저장 영역 전체가 보인다. 프로그램 정지·설치 목록 미확인 상태의 현재 선택 표시와 실행 조치를 확인했으며, 설정 변경·모델 실행/받기/삭제는 수행하지 않았다. viewport 임시 override는 reset해 원래 크기로 복원했다. 캡처와 수치 근거는 `.tmp/settings-live-20261024/{settings-wide-1360.jpg,settings-narrow-860.jpg,verification.json}`이다. 이 직접 배치 확인은 앞선 접근 제한 기록의 현재 상태를 대체하지만, 실제 모델 검색·등록·다운로드 복구/선택 흐름의 검증까지 대신하지 않는다.


2026-10-24 설정 카드 내부 좌우 여백 통일: 분석·음성 인식 모델·저장 셀, 모델 검색·목록·하단 안내의 좌우 안쪽 여백을 공통16px로 맞췄다. 열 간격24px와 행 높이는 유지한다. 실제 인앱 탭에서1360×900/860×720을 직접 측정해 모든 항목의 좌우 padding16px, 검색·모델 이름·안내·분석·저장의 시작선 일치, CPU/HWPX 오른쪽 차이0, 가로/설정 본문 세로 넘침0을 확인했다. 소스 변경 직후 실제 페이지가 이전 스타일을 유지해 정상 새로고침 뒤 설정을 다시 열어 최신 계산 스타일을 확인했다. 임시 창 크기는 reset했다.

`corepack pnpm --dir desktop-app typecheck`와 diff 검사 통과. 코드 동작 변경 없이 수평 여백만 바꿨으므로 전체 모델 흐름 검사를 반복하지 않고 실제 화면 배치로 집중 검증했다. 근거 `.tmp/settings-inset-20261024/{settings-wide-1360.jpg,settings-narrow-860.jpg,verification.json}`. 실제 모델 실행/다운로드/삭제는 수행하지 않았다.


2026-10-24 선택 상자 글자 잘림·모델 윤곽 보완: 높이32px 선택 상자에 기존 위아래8px 여백이 남아 실제 내부 표시 높이가14px였고,124px폭도 CPU 문구와 화살표에 빠듯했다. CPU/HWPX를148px폭·위아래4px 여백으로 맞춰 내부 높이22px를 확보했다. 모델의 선택 가능한 동작은 청록 윤곽(삭제는 빨강), 실제 비활성 동작은 전체 opacity를 낮추지 않고 회색 테두리·아이콘·옅은 배경으로 구분한다. 저장된 선택의 청록 채움과 선택 차단 조건은 유지한다.

실제1360×900/860×720에서 CPU 기본 사용 전체 표시, 글자14px·선택상자148×32px·안쪽 높이22px, CPU/HWPX오른쪽차이0, 가로/설정세로넘침0을 확인했다. 현재 실제 탭은 요약 프로그램 정지·설치 목록 미확인으로 다른 모델 선택도 잠겨 있다. 이 비활성을 강제로 해제하지 않았다. 활성 미선택 모델의 윤곽은 기존 모의 API 시뮬레이션으로 따로 확인한다. 근거 `.tmp/settings-text-outline-20261024`의 실제 JPG2개·verification.json과 `mock/` 캡처. `corepack pnpm --dir desktop-app test:settings-model-management`(APP_URL=http://127.0.0.1:5183/, PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright), 타입 검사와 독립 소스/실제·모의 캡처 검토를 통과했으며 임시 창 크기는 복원했다.

### 2026-10-27 로컬 변경 전체의 집중 회귀

브라우저 승인 정보 복구는 `481b0c5`, 설정·모델 관리와 GPU 감지는 `4578583`, 요약 근거·문장 상태 실험 도구는 `c15c3ad`로 분리했다. 실제 회의 자료 대신 합성 fixture만 포함하며 개인 모델 목록·자동 저장 옵션과 runtime 파일은 커밋에서 제외한다. 보류된 장문·요약 품질 실험은 실행하지 않았다.

- `corepack pnpm --dir desktop-app test:settings-model-management`: 검색·목록 추가·받기·선택·삭제, 늦은 설정/목록 응답과 선택 경합, 요약 프로그램 업데이트 후 명시적 재시도까지 모의 API로 통과.
- `LOCAL_ENGINE_UI_SCENARIO=automatic`과 `input-stage`의 `corepack pnpm --dir desktop-app test:local-engine-connection-ui`: 코드/추가 승인 없는 연결·reload 복원과 입력·길이·다른 작업·이어하기 안내 통과.
- `corepack pnpm --dir desktop-app exec node scripts/simulate-finite-request-recovery.mjs`: health·모델 오류·settings의 열린 JSON 본문을 유한 시간에 취소하고 UI와 재시도를 복구하는3장면 통과. 최초 실행은 기존 `.tmp/finite-request-ui-20261025/health-failure.png` 쓰기 권한 때문에 중단됐고 권한 확보 후 같은 검사 전체를 통과했다.
- 변경 `.mjs`7파일은 `node --check` 통과. 같은 소스의 타입 검사·변경 TS/TSX11파일 ESLint·runtime 경계 검사는 이 작업의 앞선 단계에서 통과했으며 소스·의존성 변경 없이 증거를 재사용했다.
- 프로젝트 Python `backend/.venv-desktop/Scripts/python.exe -B -X utf8`로 모델 catalog/update·STT 장치·생성 gateway·요약 제한/의미/문장 상태·브라우저 승인·Windows runtime·보안 경계 모듈과 관련 API11메서드, 총220검사 통과. 기존 `.tmp/agent-review`의 권한 경계는 집중 실행 권한으로 검증했고 실제 모델 호출·다운로드는 하지 않았다.

실행 환경은 저장소 루트 `D:/Projects/audio`, 전용 Vite `corepack pnpm --dir desktop-app exec vite --host 127.0.0.1 --port 60271 --strictPort --configLoader runner`, `APP_URL=http://127.0.0.1:60271/`(연결 검사는 `?view=minutes&localEngineConnection=1`), `PLAYWRIGHT_BROWSERS_PATH=D:/Projects/audio/.cache/ms-playwright`다. HTML 제목 `LMO 회의록`으로 대상 프로젝트를 확인했고 이 작업에서 시작한60271서버만 검사 뒤 종료했다. 실제 설치형 엔진·공개 HTTPS·설치본 승인 복구를 검증한 것이 아니며 해당 QA는 `todo.md`와 `docs/release-checklist.md`에 미완료로 유지한다.
