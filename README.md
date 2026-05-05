# Smart Minutes AI

음성/영상 회의 자료를 로컬에서 분석해 회의록을 만드는 데스크탑 앱입니다.

## 폴더 구조

```text
D:\Projects\audio\
  backend\                         # FastAPI 분석 서버 소스
  desktop-app\                     # React/Tauri 데스크탑 앱 소스
  docs\                            # 설계/테스트/배포 문서
  scripts\                         # 빌드, 패키징, 검증 스크립트
  Smart Minutes AI\                # 실행용 portable 배포 폴더, 커밋 제외
  .hf_modules\                     # 모델 실행 코드 캐시, 커밋 제외
  todo.md
  roadmap.md
```

## 실행 폴더

실행할 때는 루트의 portable 폴더를 사용합니다.

```text
D:\Projects\audio\Smart Minutes AI\Smart Minutes AI.exe
```

`Smart Minutes AI.exe`만 따로 옮기면 안 됩니다. 아래 폴더들이 같은 위치에 있어야 합니다.

```text
Smart Minutes AI\
  Smart Minutes AI.exe
  backend\
  binaries\
  models\
```

`models`에는 기본 음성 인식 모델과 화자 분리 모델 파일이 들어갑니다. 모델은 단일 파일 하나가 아니라 `config.json`, `model.safetensors`, `tokenizer_config.json`, `embedding`, `segmentation`, `plda` 같은 파일/폴더 묶음입니다.

## 소스 폴더

`desktop-app`은 실행본이 아니라 앱 소스입니다. UI 수정, 설정 화면 수정, Tauri 빌드, 배포 파일 재생성이 필요하면 지우면 안 됩니다.

`backend`는 분석 서버 소스입니다. FastAPI, STT, 화자 분리, 요약, 내보내기 로직이 들어 있습니다.

## 캐시와 생성물

아래 항목은 커밋하지 않습니다.

```text
Smart Minutes AI\
.hf_modules\
.codex-work\
outputs\
backend\models\
backend\build\
backend\dist-sidecar\
desktop-app\dist\
desktop-app\src-tauri\target\
Smart_Minutes_AI_Portable*.zip
*.mp4
```

`.hf_modules`는 음성 인식 모델처럼 추가 실행 코드가 필요한 모델의 코드 캐시입니다. 지워도 필요하면 다시 생성됩니다.

## 회사 PC 이관

회사 PC에는 실행용이면 `Smart Minutes AI` 폴더 전체를 옮기면 됩니다. 기본 음성 인식 모델은 로그인 권한 문제로 자동 다운로드가 막힐 수 있으므로, 구글 드라이브/웹하드/사내 공유 저장소에 올린 모델 파일을 받아 `Smart Minutes AI\models` 바로 아래에 복사하는 방식을 우선 사용합니다.

자세한 내용은 [Smart_Minutes_AI_Portable_회사_PC_사용법.md](Smart_Minutes_AI_Portable_회사_PC_사용법.md)를 봅니다.

## 배포 정리 기준

헷갈리지 않도록 새 배포본은 한 명령으로 만들고 검증합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release_portable.ps1 -RequireCohere -ClearWebViewCache
```

이미 Tauri exe와 sidecar를 새로 빌드한 직후라면 빠른 동기화/검증만 할 수 있습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release_portable.ps1 -SkipSidecarBuild -SkipTauriBuild -RequireCohere
```

배포 후 기준 실행 폴더는 항상 `D:\Projects\audio\Smart Minutes AI`입니다. `desktop-app\src-tauri\target\release\portable\Smart Minutes AI`는 빌드 중간 산출물로 보고 직접 실행 기준으로 삼지 않습니다.

상태가 이상하면 먼저 아래 진단 스크립트를 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose_portable.ps1
```
