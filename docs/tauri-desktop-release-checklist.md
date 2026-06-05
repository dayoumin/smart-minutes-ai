# Tauri Desktop Release Checklist

## 0. 문서 운영 원칙

- 이 파일을 portable release, sidecar packaging, build venv, deploy folder 검증의 단일 상세 원본으로 둔다.
- `AGENTS.md`에는 이 파일을 먼저 읽으라는 짧은 운영 규칙만 남기고, venv 복구 절차나 pip cache 우회처럼 긴 해결 절차를 중복 기록하지 않는다.
- 새 빌드 시행착오, 재발 방지책, 검증 명령은 이 파일의 날짜 섹션에 추가한다.
- 과거 실험 로그나 성능 비교 문서에 남은 release 언급은 당시 맥락 기록으로만 보고, 현재 배포 절차 판단은 이 파일을 기준으로 한다.

## 2026-05-05 UI 정리 결정

- 사용자 설정 화면에는 필수 모델, 분석 옵션, 다운로드 형식처럼 사용자가 직접 판단해야 하는 항목만 둔다.
- Whisper, Qwen ASR, fallback STT 같은 대체 모델 후보는 사용자 설정에 노출하지 않고 개발 문서와 `todo.md`에만 남긴다.
- Python, FastAPI, sidecar 같은 구현 용어는 사용자 UI에 노출하지 않는다.
- 포터블 앱은 실행 시 빈 로컬 포트를 잡아 내부 분석 기능에 전달한다. 포트 충돌이 있으면 사용자에게는 "분석 기능을 준비하지 못했습니다" 수준으로 안내한다.

이 체크리스트는 Tauri 앱이 로컬 백엔드 sidecar, 모델, ffmpeg 같은 리소스를 함께 배포할 때 사용한다.

## 0-1. 데스크탑앱 한계 체크

웹에서 잘 동작해도 데스크탑앱에서는 아래 조건 때문에 실패할 수 있다. 앱 수정 후 배포 여부를 판단할 때 이 항목을 먼저 확인한다.

- 실행 단위: 사용자는 `lmo_audio.exe` 하나가 아니라 `releases\lmo_audio` 폴더 전체를 사용해야 한다. exe만 이동하면 sidecar, ffmpeg, 모델, 설정 파일을 찾지 못할 수 있다.
- 쓰기 권한: 회사 PC의 portable 폴더는 쓰기 가능한 위치에 있어야 한다. 결과는 `backend\outputs`, 임시 파일은 `backend\temp`, 로그는 `logs` 또는 `backend\logs`에 생긴다.
- 로컬 백엔드: 앱은 내부 sidecar를 띄워 로컬 포트로 통신한다. 개발 서버가 켜져 있거나 포트 충돌이 있어도 앱이 자기 sidecar에 붙는지 확인한다.
- 모델 의존성: STT 모델과 참석자 구분 모델은 `models` 폴더에 있어야 한다. Ollama 정리 모델이 없더라도 대화록 작성은 완료되어야 하며, 정리 기능만 준비 필요 상태로 남아야 한다.
- 긴 파일 자원 한계: 긴 영상은 임시 WAV와 중간 산출물이 커질 수 있다. 시작 전 저장 공간을 확인하고, 2시간 이상 파일은 참석자 구분이 오래 걸리거나 제외될 수 있음을 UI에서 안내한다.
- 이어하기 한계: 중간 진행분을 재사용하려면 같은 파일과 같은 설정이 필요하다. 원본 음성 파일을 보관하지 않은 경우 결과 화면에서 참석자 구분을 다시 실행하지 못할 수 있다.
- 저장/다운로드 위치: 자동 저장, 내보내기, 내부 결과 폴더를 구분한다. 사용자가 다운로드한 파일과 앱 내부 결과 파일이 어디에 남는지 혼동되지 않아야 한다.
- 외부망/내부망: 회사 PC가 외부망이 아니면 Ollama 모델 다운로드나 추가 설치를 앱 안에서 즉시 처리할 수 없을 수 있다. 이 경우 관리자가 모델을 준비하는 절차를 문서에 남긴다.
- 백신/권한 정책: sidecar 실행, ffmpeg, 대용량 임시 파일 생성이 보안 정책에 막힐 수 있다. 실패 시 사용자에게 내부 구현 용어가 아니라 "분석 기능을 준비하지 못했습니다", "저장 공간 또는 권한을 확인해 주세요"처럼 안내한다.

## 1. 실행 파일 형태

- Windows 릴리즈 앱에는 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`가 있어야 한다.
- 앱 exe의 PE Subsystem은 `Windows GUI`여야 한다.
- 백엔드 sidecar도 콘솔 창이 뜨지 않는 형태여야 한다.
- 앱 실행 시 `PowerShell`, `WindowsTerminal`, `cmd`, 새 콘솔 창이 뜨지 않아야 한다.

## 2. 백엔드 sidecar

- 고정 포트만 사용하지 않는다. 가능한 경우 Tauri/Rust가 빈 포트를 잡아 sidecar에 전달한다.
- 프론트엔드는 하드코딩된 `8000`이 아니라 Tauri command로 받은 실제 API base URL을 사용한다.
- `/api/health`와 `/api/models/status`가 같은 sidecar에서 응답하는지 확인한다.
- 다른 Python/FastAPI 개발 서버가 켜져 있어도 앱이 자기 sidecar에 붙는지 확인한다.
- sidecar 시작 실패를 사용자가 볼 수 있는 메시지나 로그로 남긴다.

## 3. 리소스와 모델 경로

- portable 배포에서는 exe 하나만 옮기는 것이 아니라 앱 폴더 전체를 유지해야 한다.
- 모델 경로는 `실행 폴더/models/...` 기준으로 안내한다.
- 현재 앱 설정 화면은 필수 모델 준비 상태와 `models` 폴더 기준 안내를 보여준다. 절대 경로 표시/복사 버튼은 후속 UX 개선으로 다루되, 배포 문서에는 실제 배치 위치를 반드시 명시한다.
- 필수 모델이 없으면 분석 버튼 클릭 후 즉시 원인과 조치 방법을 보여준다.
- 큰 모델을 zip에서 제외하는 경우, 제외한 모델명과 넣을 위치를 문서에 명시한다.

## 4. 패키징 산출물

- 이전 portable/zip 산출물을 삭제한 뒤 새로 만든다.
- zip을 빈 폴더에 풀어서 실행하는 clean-room 테스트를 한다.
- zip 안의 exe와 현재 release exe가 같은 최신 빌드인지 확인한다.
- sidecar 재빌드가 필요한 Python 코드 변경 후에는 반드시 sidecar를 다시 만든다.

## 5. 사용자 시나리오

- 앱 실행 후 콘솔 창이 뜨지 않는지 확인한다.
- 모델이 없는 상태에서 분석 시작 시 즉시 안내가 나오는지 확인한다.
- 모델이 있는 상태에서 MP4/WAV 분석이 시작되는지 확인한다.
- 분석 실패 시 진행 영역에서 실패 원인이 보이는지 확인한다.
- 회의 기록 저장과 HWPX/TXT/DOCX 다운로드가 동작하는지 확인한다.
- HWPX는 zip/XML smoke만으로 완료 처리하지 않는다. 회사 PC에서 실제 한글 또는 HWPX 뷰어로 열어 제목, 일시, 참석자, 본문이 표시되는지 확인한다.
- 설정은 `일반`과 `모델` 탭 기준으로 확인한다. 더 이상 일반 사용자 흐름에서 `분석 준비` 탭명을 기대하지 않는다.
- 설정 `일반` 탭에서 참석자 구분 사용 여부와 분석 중 참석자 구분 실행 옵션이 저장되고 `/api/models/status`에 반영되는지 확인한다.
- 설정 `모델` 탭에서 추천 모델, 직접 입력 모델, 설치된 Ollama 모델, 사용 중 모델 표시가 서로 일관되는지 확인한다.
- Ollama 모델 받기/상태 확인/삭제 기능은 사용자 입력 모델명 검증, 받는 중 표시, 완료/실패 안내, 사용 중 모델 삭제 차단, 받는 중 모델 삭제 차단을 함께 확인한다.
- 결과 화면에서 요약 모델이 없을 때는 `모델 필요` 수준의 사용자 문구와 `모델` 탭 이동이 동작해야 한다.
- 결과 화면에서 원본 음성이 없을 때 참석자 구분 상태를 구분한다. 기존 참석자 표식이 1명뿐이면 `표식 1명`, 표식 자체가 없으면 `재실행 불가` 안내가 나와야 한다.

## 6. 배포 전 자동 점검

프로젝트별로 `scripts/verify_portable.ps1` 같은 스크립트를 두고 아래 항목을 자동화한다.

- portable 폴더 존재 여부
- 앱 exe와 sidecar exe 존재 여부
- 앱 exe와 sidecar exe의 PE Subsystem
- 백엔드 모델/ffmpeg 폴더 구조
- 앱 실행 후 sidecar listen 포트 탐지
- `/api/health`, `/api/settings`, `/api/models/status` 응답 확인
- `/api/models/ollama/pull`, `/api/models/ollama/pull-status`, `/api/models/ollama/model` 응답 확인
- 필수 모델 누락 목록 출력
- 테스트 후 앱/sidecar 프로세스 종료

현재 루트 점검 명령:

```powershell
corepack pnpm check:quick
corepack pnpm check:release
corepack pnpm check:portable
```

- `check:quick`: 수정 중 반복 실행한다. 프론트 타입체크/린트, 가벼운 백엔드 unittest, 배포 스크립트 계약 테스트를 실행한다.
- `check:release`: 배포 후보에서 실행한다. `check:quick` 범위에 백엔드 API unittest, 업데이트 패키지 테스트, 프론트 사용자 흐름 시뮬레이션을 추가한다.
- `check:portable`: 이미 `releases\lmo_audio`를 만든 뒤 실행한다. `check:release` 범위에 portable 폴더 검증을 추가한다.
- 실제 모델을 사용하는 STT smoke는 기본 자동 게이트에서 제외한다. 필요할 때 `scripts\run_release_checks.ps1 -Tier release -IncludeModelSmoke`로 별도 실행한다.
- 현재 `check:release`의 백엔드 API unittest는 Ollama 모델 받기/상태/삭제, 직접 입력 모델 저장, 참석자 구분 분석 중 실행 옵션을 포함한다. 프론트 시뮬레이션은 모델 탭 진입, 추천/직접 입력 표시, 참석자 구분 재실행 상태를 일부 확인한다.

## 7. 이 프로젝트의 단일 배포 흐름

혼돈을 줄이기 위해 실제 배포 기준은 `releases\lmo_audio` 폴더 하나로 고정한다. Tauri target 폴더는 중간 산출물이며 사용자가 직접 실행할 기준 폴더가 아니다.

### 고정 작업 순서

배포가 필요한 변경은 아래 순서를 기본으로 한다. 순서를 바꾸는 경우에는 final summary에 이유를 남긴다.

배포 필요 여부는 다음 기준으로 판단한다.

- 문구, 아이콘, 단순 배치만 바뀌고 저장/분석/내보내기/설정/모델/sidecar에 영향이 없으면 좁은 프론트 검증까지만 할 수 있다.
- 분석 시작, 진행 상태, 중지/취소, 이어하기, 참석자 구분, 기록 정리, 저장/다운로드, 설정, 모델 상태, 경로, Tauri command, sidecar API가 바뀌면 데스크탑앱 한계 체크를 함께 한다.
- 백엔드 Python, 패키징 리소스, 모델 경로, ffmpeg, Tauri/Rust, release script가 바뀌면 최종 portable 빌드와 `verify_portable.ps1` 검증 대상이다.
- 회사 전달, 실행 파일 재생성, zip/update package 생성, "빌드" 요청은 항상 사용자용 portable 배포 흐름으로 본다.

1. 변경 범위를 분류한다: 웹 UI, 데스크탑/Tauri, 백엔드, 배포 스크립트, 모델/성능.
2. 변경 범위에 맞는 좁은 검증을 먼저 실행한다.
   - 공통 빠른 점검: `corepack pnpm check:quick`.
   - 프론트엔드: `corepack pnpm --dir desktop-app run typecheck`, `corepack pnpm --dir desktop-app run lint`, 필요한 `desktop-app/scripts/simulate-*.mjs`.
   - Tauri/Rust: `cargo check` in `desktop-app\src-tauri`.
   - 백엔드: 관련 Python unittest 또는 `py_compile`.
3. 서버 재시작, 취소/삭제, 이어하기, 저장/내보내기, 배포, 긴 파일 처리처럼 사용자 작업 손실이나 운영 위험이 있으면 큰 관점/작은 관점 리뷰를 실행한다. 리뷰에는 0-1의 데스크탑앱 한계 체크를 포함한다.
4. 리뷰 지적을 반영하고 다시 좁은 검증을 통과시킨다.
5. 배포 빌드 전에 변경 사항을 커밋한다. 최종 사용자용 manifest는 커밋된 HEAD를 가리켜야 한다.
6. 루트에서 `corepack pnpm build`를 실행한다.
7. 실패하면 레이어를 나눠 확인한다: sidecar packaging, Tauri exe build, portable packaging, deploy-folder verify.
8. `scripts\verify_portable.ps1 -PortableDir releases\lmo_audio`가 통과하는지 확인한다.
   - 전체 자동 게이트로는 `corepack pnpm check:portable`을 사용한다.
9. `releases\lmo_audio\release-manifest.json`의 `commit`이 `git rev-parse HEAD`와 같고 `dirty=false`인지 확인한다.
10. `git fetch origin` 후 behind가 없을 때 `git push origin main`을 실행한다.

단순 문구/아이콘 변경처럼 배포가 필요 없는 경우에는 5~10번을 생략할 수 있다. 사용자가 "빌드" 또는 "전달"을 요청한 경우에는 5~10번을 생략하지 않는다.

정식 배포 갱신:

```powershell
corepack pnpm build
```

위 명령은 루트 `package.json`의 `build` 스크립트이며, 내부적으로 `scripts\build_user_release.ps1`를 실행한다. 이 프로젝트에서 사용자가 단순히 "빌드"라고 하면 Vite 웹 자산 빌드가 아니라 이 포터블 배포 빌드를 기본값으로 해석한다.

동일한 작업을 PowerShell로 직접 실행할 때:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_user_release.ps1
```

이미 exe와 sidecar를 새로 만든 뒤 복사/검증만 다시 할 때:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_user_release.ps1 -SkipSidecarBuild -SkipTauriBuild
```

`desktop-app` 안의 `pnpm build`는 `desktop-app\dist`의 Vite 웹 자산만 만든다. 사용자에게 전달할 실행 폴더를 갱신했다는 의미로 사용하지 않는다.

배포 스크립트가 하는 일:

- 실행 중인 앱, sidecar, 관련 WebView 프로세스를 종료한다.
- 필요 시 WebView 렌더 캐시만 지우고 IndexedDB 회의 기록은 보존한다.
- Tauri 리소스와 portable 폴더를 다시 구성한다.
- `releases\lmo_audio` 폴더로 동기화한다.
- `release-manifest.json`에 exe, sidecar, backend 파일 해시를 기록한다.
- `scripts\verify_portable.ps1`로 manifest 해시와 실행 smoke test를 확인한다.

문제가 반복될 때는 먼저 진단 스크립트로 실제 실행 파일, 프로세스, 포트, 모델, manifest를 확인한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose_portable.ps1
```

### 기존 설치본용 수동 업데이트 패키지

이미 사용자 PC에 `lmo_audio\models`가 준비되어 있으면 전체 모델을 다시 전달하지 않고 업데이트 패키지만 만들 수 있다. 이 패키지는 새 코드와 실행 파일만 포함하고, 대상 PC의 `models`, `backend\config.json`, `backend\outputs`, `backend\temp`는 보존한다.

업데이트 패키지는 변경 사항을 커밋하고 깨끗한 portable 빌드가 끝난 뒤 만든다. `create_update_package.ps1`는 기본적으로 `release-manifest.json`의 commit이 현재 `HEAD`와 같은지 확인한다. 로컬 테스트에서만 `-AllowStale`을 쓴다.

```powershell
corepack pnpm package:update
```

직접 실행할 때:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create_update_package.ps1
```

기본 산출물은 `releases\updates\lmo_audio_update_<commit>`이다. 이 폴더 안에는 `payload`, `update-manifest.json`, `update_lmo_audio.ps1`, `verify_update.ps1`가 들어간다. `payload\models`와 `payload\backend\config.json`이 있으면 잘못 만든 패키지로 본다.

사용자 PC에서 적용할 때는 업데이트 패키지 폴더에서 대상 `lmo_audio` 폴더를 지정한다. 이 작업은 일반 사용자가 앱 사용 중에 누르는 자동 업데이트가 아니라 관리자/운영자가 유지보수 시간에 실행하는 수동 절차다. 적용 전 앱을 닫고 분석 작업이 진행 중이 아닌지 확인한다. 중요한 결과물이 있으면 `backend\outputs`를 먼저 백업한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File update_lmo_audio.ps1 -TargetDir D:\Apps\lmo_audio
```

검증만 다시 실행할 때:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File verify_update.ps1 -TargetDir D:\Apps\lmo_audio
```

루트 package script로 검증할 때는 인자를 넘긴다.

```powershell
corepack pnpm verify:update -- -TargetDir D:\Apps\lmo_audio -PackageDir releases\updates\lmo_audio_update_<commit>
```

`update_lmo_audio.ps1`는 대상 폴더를 수정하기 전에 package payload 해시를 먼저 확인한다. 업데이트 검증은 payload 파일 해시, 앱 exe, sidecar, ffmpeg, 기존 모델 marker, 기존 설정 파일 보존 여부를 확인한다. 기존 설정과 모델을 보존하므로 적용 후 대상 `release-manifest.json`의 `backendConfig` 해시와 model marker 크기는 현재 대상 PC 파일 기준으로 다시 맞춘다.

운영 기준:

- STT와 참석자 구분 모델은 관리자가 준비해 `models` 폴더에 배치한다. 앱 안에서 이 모델들을 개별 다운로드하지 않는다.
- Ollama 정리 모델은 외부망과 Ollama가 준비된 PC에서 설정 화면으로 받거나 선택할 수 있다. 내부망/오프라인 PC에서는 이미 설치된 모델 감지와 관리자 준비 절차를 기준으로 한다.
- 기본 STT 모델은 관리자가 지정한 공유 위치에서 받아 `releases\lmo_audio\models\faster-whisper-large-v3` 아래에 둔다.
- `release-manifest.json`은 배포본의 신분증이며, verify/diagnose가 파일 해시 불일치를 잡아야 한다.
- 일반 사용자에게 전달할 배포본은 manifest의 `dirty`가 `false`여야 한다. dirty 배포본은 로컬 테스트용이며, 필요한 경우에만 `-AllowDirty`로 명시한다.
- 분석 결과와 임시 파일은 portable 실행 폴더 하위 `backend\outputs`, `backend\temp`에 생성된다.
- 회사 PC에서는 portable 폴더를 쓰기 가능한 위치에 둔다.
- 회사 PC에서 Ollama 설치/모델 준비가 확실하지 않으면 요약 AI를 필수 조건으로 보지 않는다.
  - STT, 참석자 구분, 대화록 TXT/JSON 생성은 계속 완료되어야 한다.
  - 요약 AI가 준비되지 않으면 결과의 `generation_status.summary`는 `skipped`로 남기고, 사용자는 대화록을 먼저 사용한다.
  - Ollama와 요약 모델은 준비된 PC에서 전체 요약, 주제별 정리, 참석자별 정리를 다시 실행하는 선택 기능으로 다룬다.
- `backend\.venv-desktop`는 PC 간에 복사해서 쓰는 공용 자산이 아니다.
  - 이 폴더는 생성 당시의 로컬 Python 설치 경로를 내부에 기록한다.
  - 회사 PC에서 만든 `venv`를 집 PC로 가져오거나, 기준 Python을 삭제/교체하면 같은 경로 오류가 다시 난다.
  - 새 PC에서는 먼저 아래 스크립트로 build venv를 새로 만든다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure_backend_build_env.ps1 -Python <실제로 설치된 python.exe 경로> -RecreateBroken
```

- portable/sidecar 빌드는 가능하면 항상 repo-local build venv를 명시적으로 사용한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release_portable.ps1 -Python backend\.venv-desktop\Scripts\python.exe
```

## 8. 2026-05-12 빌드 시행착오 기록

- 최상단 안내 파일명은 ASCII로 둔다: `START_HERE.txt`.
  - `START_HERE_먼저읽기.txt`처럼 한글 파일명을 PowerShell 스크립트 안에 직접 쓰면 Windows PowerShell 실행 인코딩에 따라 깨질 수 있다.
  - 안내 파일 내용은 `[System.IO.File]::WriteAllText(..., [System.Text.UTF8Encoding]::new($false))`로 저장한다.
- 안내 파일만 실패한 경우에는 sidecar/Tauri를 다시 빌드할 필요가 없다.
  - 이미 `Created sidecar`와 `Built application at`이 끝난 뒤라면 `release_portable.ps1 -SkipSidecarBuild -SkipTauriBuild`로 패키징/검증만 다시 한다.
  - `START_HERE.txt`는 manifest 해시 대상이다. 손으로 복사하지 말고 `build_user_release.ps1 -SkipSidecarBuild -SkipTauriBuild`로 manifest와 검증을 함께 갱신한다.
- `verify_portable.ps1`의 `/api/models/status` 호출은 첫 실행에서 모델/라이브러리 초기화 때문에 5초를 넘을 수 있다.
  - health/settings가 PASS인데 runtime smoke가 timeout이면 모델 상태 요청 timeout을 먼저 의심한다.
  - 현재 검증 스크립트는 모델 상태 요청에 최소 60초 timeout을 사용한다.
- Python 런타임은 PATH의 `python`에 기대지 않는다.
  - 이 PC에서는 `python` 명령이 없고 `py`도 설치 Python을 찾지 못할 수 있다.
  - `backend\.venv-desktop\Scripts\python.exe`가 존재해도, 내부 기준 Python이 삭제된 경로를 가리키면 `Unable to create process ... Python311\python.exe`로 실패한다.
  - 이 경우는 build script를 다시 돌리는 것으로 해결되지 않는다. 먼저 `scripts\ensure_backend_build_env.ps1 -Python <python.exe> -RecreateBroken`으로 venv를 재생성해야 한다.
  - sidecar를 다시 빌드할 때는 `release_portable.ps1 -Python <실제로 실행 가능한 python.exe>`를 사용하고, 스크립트의 runtime probe가 통과하는지 먼저 확인한다.
  - 상대 경로 Python 인자는 repo 기준 절대 경로로 바꿔 전달한다. `backend\.venv-desktop\Scripts\python.exe`가 PowerShell에서 모듈명처럼 해석되는 실패를 피하기 위해서다.
- 포터블 smoke test는 `Get-NetTCPConnection`만 믿지 않는다.
  - 일부 환경에서는 프로세스/포트 조회가 불안정하거나 권한 영향을 받는다.
  - 실제 기준은 sidecar의 `/api/health` 응답이며, 검증 스크립트도 health 응답을 먼저 기다린다.
- 루트 `lmo_audio` 폴더는 과거 산출물이다.
  - 새 배포 기준은 `releases\lmo_audio`이며, `release_portable.ps1`와 `diagnose_portable.ps1`는 루트 `lmo_audio`가 남아 있으면 경고한다.

## 9. 2026-05-13 빌드 venv 재발 방지

- `backend\.venv-desktop`가 존재해도 완성된 build venv라고 판단하지 않는다.
  - `pyvenv.cfg`가 현재 실행 가능한 Python을 가리키는지 확인한다.
  - `PyInstaller`, `fastapi`, `faster_whisper`, `torch`가 설치되어 있는지 확인한다.
  - venv 생성과 pip 업그레이드만 끝난 상태는 불완전한 venv다.
- `ensure_backend_build_env.ps1 -RecreateBroken`를 실행하다가 중단했다면 다음 release를 바로 시작하지 않는다.
  - 먼저 아래 probe가 통과하는지 확인한다.

```powershell
backend\.venv-desktop\Scripts\python.exe -c "import importlib.util; required=['PyInstaller','fastapi','faster_whisper','torch']; missing=[name for name in required if importlib.util.find_spec(name) is None]; print('missing=' + ','.join(missing)); raise SystemExit(1 if missing else 0)"
```

- `release_portable.ps1`와 `package_backend_sidecar.ps1`는 sidecar 빌드 전에 위 필수 패키지를 선검사한다.
  - 실패하면 앱 프로세스 종료, WebView cache 삭제, sidecar 산출물 제거 같은 작업으로 넘어가지 않는다.
  - 해결은 `scripts\ensure_backend_build_env.ps1 -Python <실제로 실행 가능한 python.exe> -RecreateBroken`를 끝까지 완료하는 것이다.
- `backend\.venv-test312` 같은 임시 venv는 응급 빌드에는 사용할 수 있지만, 반복 가능한 배포 기준은 아니다.
  - 임시 venv를 사용했다면 final summary와 manifest dirty 상태에 반드시 남긴다.
  - 다음 정식 배포 전에는 `.venv-desktop`를 정상 복구하는 것을 우선한다.
- pip install이 사용자 프로필 cache 권한 문제로 실패하면 repo 내부 임시 경로를 사용한다.
  - 예: `$env:TMP=(Resolve-Path .codex-work\tmp).Path`, `$env:TEMP=$env:TMP`, `$env:PIP_NO_CACHE_DIR='1'`.
  - `C:\Users\...\pip\cache`나 권한이 불확실한 `C:\tmp`에 의존하지 않는다.
- `-SkipSidecarBuild`는 backend 변경을 이번 배포에 반영할 필요가 없고, 기존 sidecar가 의도한 버전임을 확인한 경우에만 사용한다.

## 10. 2026-05-21 빌드 명령 혼동 방지

- 루트 `package.json`를 추가해 `corepack pnpm build`가 항상 사용자 배포용 포터블 릴리스 흐름을 실행하게 했다.
  - 실행 스크립트: `scripts\build_user_release.ps1`
  - 내부 기준: `scripts\release_portable.ps1 -Python backend\.venv-desktop\Scripts\python.exe -ClearWebViewCache`
  - 최종 검증: `scripts\verify_portable.ps1 -PortableDir releases\lmo_audio`
- `scripts\release_portable.ps1`의 기본 Python도 `backend\.venv-desktop\Scripts\python.exe`로 바꿨다. 전역 `python`이나 설치 상태가 다른 PC의 PATH에 의존하지 않는다.
- `desktop-app\package.json`에는 `build:web`와 `build:portable`를 분리해 두었다.
  - `desktop-app`의 `build`와 `build:web`는 웹 자산만 만든다.
  - 사용자에게 전달할 실행 폴더를 만들 때는 루트에서 `corepack pnpm build`를 사용한다.
- Codex가 "빌드" 요청을 받으면 명시적으로 웹/Vite 빌드를 요청한 경우가 아닌 한 `corepack pnpm build`를 선택해야 한다.
- `verify_portable.ps1`는 manifest `dirty=true`를 기본 실패로 처리한다.
  - 로컬 점검 중 dirty 배포본을 확인해야 할 때만 `build_user_release.ps1 -AllowDirty` 또는 `verify_portable.ps1 -AllowDirty`를 사용한다.
  - 사용자에게 전달할 최종 배포본은 변경 사항을 커밋한 뒤 다시 빌드해 `manifest clean`이 PASS여야 한다.

## 11. 2026-05-21 Windows/Codex 프로세스 조회 문제

- Codex 샌드박스에서는 `Get-CimInstance Win32_Process`가 `Access denied`로 실패할 수 있다.
  - 명령줄 확인이 꼭 필요하면 권한 상승으로 다시 실행한다.
  - 실행 파일 경로만 필요하면 `Get-Process` 기반 fallback을 먼저 사용한다.
- `release_portable.ps1`는 앱/WebView 프로세스 조회가 CIM 권한 문제로 실패해도 즉시 중단하지 않고, portable 폴더 아래 실행 파일만 `Get-Process`로 정리하도록 fallback한다.
- `diagnose_portable.ps1`도 CIM 실패 시 실행 파일 경로 기반 목록으로 fallback한다.
- Node/npm을 통해 실행된 Windows PowerShell에서는 `Get-FileHash` cmdlet이 로드되지 않는 경우가 있었다.
  - release/verify/diagnose 스크립트는 `Get-FileHash`가 없으면 .NET `SHA256`으로 해시를 계산한다.
- Git 전역 ignore 파일 권한 문제로 `git status --short`가 실패해 manifest의 `dirty` 값이 틀릴 수 있었다.
  - release 스크립트는 manifest용 git 명령에 `-c core.excludesFile=`를 붙여 전역 ignore 파일 권한 문제를 우회한다.
  - `dirty` 계산은 `status --short --untracked-files=all` 기준으로 한다.
  - manifest용 git 명령이 실패하면 clean으로 간주하지 않고 release를 실패시킨다.
- Python unittest의 `subprocess.run(..., capture_output=True)`에서 Windows PowerShell로 `verify_portable.ps1`를 실행할 때 `ProcessStartInfo.EnvironmentVariables[...]`가 `Cannot index into a null array`로 실패했다.
  - verify 스크립트는 현재 PowerShell 프로세스 환경변수를 임시 설정하고 sidecar 자식 프로세스가 상속하게 한다. `ProcessStartInfo.EnvironmentVariables[...]` 직접 인덱싱에 의존하지 않는다.
- 사용자가 빌드를 중단하면 재시도 전에 남은 `corepack pnpm build`, `scripts\build_user_release.ps1`, Tauri, PyInstaller, sidecar 프로세스를 확인한다. 다른 Codex 세션이나 다른 프로젝트 프로세스를 종료하지 않도록 명령줄 또는 실행 경로를 먼저 확인한다.
- 프로젝트 전용 Codex 스킬은 전역 `C:\Users\User\.codex\skills`가 아니라 저장소의 `.agents\skills` 아래에 둔다.

## 12. 2026-05-21 배포 폴더 잔여 파일 정리

- `binaries\_internal`의 Python 패키지, `.pyd`, DLL은 PyInstaller sidecar 런타임 의존성이므로 손으로 선별 삭제하지 않는다.
- 분석 실행 중 생기는 파일은 `backend\temp`, 결과물은 `backend\outputs`, 실행 로그는 `backend\logs`에 모은다. 이 폴더들은 사용자 PC에서 주기적으로 정리하기 쉬운 런타임 데이터 위치다.
- `robocopy /MIR /XD outputs temp __pycache__`는 제외 폴더를 새로 복사하지는 않지만, 대상 배포 폴더에 이미 남아 있는 제외 폴더를 삭제하지 않는다.
  - `release_portable.ps1`는 `releases\lmo_audio` 동기화 전에 `backend\outputs`, `backend\temp`, `backend\logs`, `backend\__pycache__`와 허용 목록 밖의 최상위 잔여 파일을 제거한다.
  - `verify_portable.ps1`는 최상위 배포 폴더와 런타임 폴더가 깨끗한지 검사하고, 저장소의 `releases\lmo_audio` 산출물을 검증할 때만 smoke test가 만든 `logs`, `backend\outputs`, `backend\temp`, `backend\logs`, `backend\__pycache__`를 종료 후 정리한다. 실제 사용자 설치 폴더를 직접 검증할 때는 사용자 결과물 삭제를 피하기 위해 후처리 삭제를 건너뛴다.
- 포터블 루트에 회의 원본 MP4/WAV 같은 입력 파일을 보관하지 않는다. 분석 파일은 사용자가 선택한 원본 위치에 두고, 앱은 필요한 임시 복사본만 `backend\temp` 아래에 만든다.
