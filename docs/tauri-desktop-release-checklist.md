# Tauri Desktop Release Checklist

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

혼돈을 줄이기 위해 실제 배포 기준은 루트의 `Smart Minutes AI` 폴더 하나로 고정한다. Tauri target 폴더는 중간 산출물이며 사용자가 직접 실행할 기준 폴더가 아니다.

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
- 루트 `Smart Minutes AI` 폴더로 동기화한다.
- `release-manifest.json`에 exe, sidecar, backend 파일 해시를 기록한다.
- `scripts\verify_portable.ps1`로 manifest 해시와 실행 smoke test를 확인한다.

문제가 반복될 때는 먼저 진단 스크립트로 실제 실행 파일, 프로세스, 포트, 모델, manifest를 확인한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose_portable.ps1
```

운영 기준:

- 사용자가 앱 안에서 모델을 개별 다운로드하지 않는다.
- 모델은 관리자가 지정한 공유 위치에서 받아 `Smart Minutes AI\models` 바로 아래에 둔다.
- `release-manifest.json`은 배포본의 신분증이며, verify/diagnose가 파일 해시 불일치를 잡아야 한다.
- 분석 결과와 임시 파일은 portable 실행 폴더 하위 `backend\outputs`, `backend\temp`에 생성된다.
- 회사 PC에서는 portable 폴더를 쓰기 가능한 위치에 둔다.
