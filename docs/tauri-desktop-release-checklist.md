# Tauri Desktop Release Checklist

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
- 모델 경로는 `실행 폴더/backend/models/...` 기준으로 안내한다.
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
