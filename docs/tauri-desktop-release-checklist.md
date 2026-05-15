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

정식 배포 갱신:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release_portable.ps1 -ClearWebViewCache
```

이미 exe와 sidecar를 새로 만든 뒤 복사/검증만 다시 할 때:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release_portable.ps1 -SkipSidecarBuild -SkipTauriBuild
```

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

운영 기준:

- 사용자가 앱 안에서 모델을 개별 다운로드하지 않는다.
- 기본 STT 모델은 관리자가 지정한 공유 위치에서 받아 `releases\lmo_audio\models\faster-whisper-large-v3` 아래에 둔다.
- `release-manifest.json`은 배포본의 신분증이며, verify/diagnose가 파일 해시 불일치를 잡아야 한다.
- 분석 결과와 임시 파일은 portable 실행 폴더 하위 `backend\outputs`, `backend\temp`에 생성된다.
- 회사 PC에서는 portable 폴더를 쓰기 가능한 위치에 둔다.
- 회사 PC에서 Ollama 설치/모델 준비가 확실하지 않으면 요약 AI를 필수 조건으로 보지 않는다.
  - STT, 화자 구분, 대화록 TXT/JSON 생성은 계속 완료되어야 한다.
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
  - 더 빠르게는 수정된 `START_HERE.txt`만 `desktop-app\src-tauri\target\release\portable\lmo_audio`와 `releases\lmo_audio`에 복사한 뒤 `verify_portable.ps1`를 실행해도 된다.
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
