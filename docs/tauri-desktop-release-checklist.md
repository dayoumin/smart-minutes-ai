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
- 앱 설정 화면에서 실제 모델 배치 경로를 보여주고 복사할 수 있어야 한다.
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

## 6. 배포 전 자동 점검

프로젝트별로 `scripts/verify_portable.ps1` 같은 스크립트를 두고 아래 항목을 자동화한다.

- portable 폴더 존재 여부
- 앱 exe와 sidecar exe 존재 여부
- 앱 exe와 sidecar exe의 PE Subsystem
- 백엔드 모델/ffmpeg 폴더 구조
- 앱 실행 후 sidecar listen 포트 탐지
- `/api/health`, `/api/settings`, `/api/models/status` 응답 확인
- 필수 모델 누락 목록 출력
- 테스트 후 앱/sidecar 프로세스 종료

## 7. 이 프로젝트의 단일 배포 흐름

혼돈을 줄이기 위해 실제 배포 기준은 `releases\lmo_audio` 폴더 하나로 고정한다. Tauri target 폴더는 중간 산출물이며 사용자가 직접 실행할 기준 폴더가 아니다.

### 고정 작업 순서

배포가 필요한 변경은 아래 순서를 기본으로 한다. 순서를 바꾸는 경우에는 final summary에 이유를 남긴다.

1. 변경 범위를 분류한다: 웹 UI, 데스크탑/Tauri, 백엔드, 배포 스크립트, 모델/성능.
2. 변경 범위에 맞는 좁은 검증을 먼저 실행한다.
   - 프론트엔드: `corepack pnpm --dir desktop-app run typecheck`, `corepack pnpm --dir desktop-app run lint`, 필요한 `desktop-app/scripts/simulate-*.mjs`.
   - Tauri/Rust: `cargo check` in `desktop-app\src-tauri`.
   - 백엔드: 관련 Python unittest 또는 `py_compile`.
3. 서버 재시작, 취소/삭제, 이어하기, 저장/내보내기, 배포, 긴 파일 처리처럼 사용자 작업 손실이나 운영 위험이 있으면 큰 관점/작은 관점 리뷰를 실행한다.
4. 리뷰 지적을 반영하고 다시 좁은 검증을 통과시킨다.
5. 배포 빌드 전에 변경 사항을 커밋한다. 최종 사용자용 manifest는 커밋된 HEAD를 가리켜야 한다.
6. 루트에서 `corepack pnpm build`를 실행한다.
7. 실패하면 레이어를 나눠 확인한다: sidecar packaging, Tauri exe build, portable packaging, deploy-folder verify.
8. `scripts\verify_portable.ps1 -PortableDir releases\lmo_audio`가 통과하는지 확인한다.
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

- 사용자가 앱 안에서 모델을 개별 다운로드하지 않는다.
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
