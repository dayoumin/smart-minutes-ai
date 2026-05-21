# LMO 회의 인사이트

음성/영상 회의 자료를 로컬에서 분석해 회의록을 만드는 데스크탑 앱입니다.

## 폴더 구조

```text
D:\Projects\smart-minutes-ai\
  backend\                         # FastAPI 분석 서버 소스
  desktop-app\                     # React/Tauri 데스크탑 앱 소스
  docs\                            # 설계/테스트/배포 문서
  scripts\                         # 빌드, 패키징, 검증 스크립트
  releases\lmo_audio\              # 실행용 portable 배포 폴더, 커밋 제외
  video\                           # 성능/품질 평가용 샘플, 커밋 제외
  .hf_modules\                     # 모델 실행 코드 캐시, 커밋 제외
  todo.md
  roadmap.md
```

## 실행 폴더

실행할 때는 루트의 portable 폴더를 사용합니다.

```text
D:\Projects\smart-minutes-ai\releases\lmo_audio\lmo_audio.exe
```

`lmo_audio.exe`만 따로 옮기면 안 됩니다. 아래 폴더들이 같은 위치에 있어야 합니다.

```text
releases\lmo_audio\
  lmo_audio.exe
  backend\
  binaries\
  models\
```

`models`에는 기본 음성 인식 모델과 화자 분리 모델 파일이 들어갑니다. 현재 기본 음성 인식 모델은 `faster-whisper-large-v3`이며, `models\faster-whisper-large-v3` 폴더 안에 `model.bin`, `tokenizer.json`, `config.json` 같은 파일 묶음이 있어야 합니다.

## 소스 폴더

`desktop-app`은 실행본이 아니라 앱 소스입니다. UI 수정, 설정 화면 수정, Tauri 빌드, 배포 파일 재생성이 필요하면 지우면 안 됩니다.

`backend`는 분석 서버 소스입니다. FastAPI, STT, 화자 분리, 요약, 내보내기 로직이 들어 있습니다.

개발 중 웹 UI에서 실제 분석 서버를 쓸 때는 전역 Python이 아니라 백엔드 가상환경으로 실행합니다.

개발 중에는 프론트와 백엔드를 각각 띄웁니다.

```powershell
.\scripts\start_dev_backend.ps1
cd desktop-app
corepack pnpm run dev
```

백엔드 스크립트는 `backend\.venv`에서 `fastapi`, `uvicorn`, `faster_whisper` import를 먼저 확인한 뒤 `http://127.0.0.1:17863` 백엔드를 시작합니다. `npm run dev` 또는 `pnpm run dev`만 실행하면 프론트만 뜨고 실제 분석 백엔드는 시작되지 않습니다.

요약 기본 경로는 Ollama입니다. `llama-cpp-python`은 GGUF 파일을 Python에서 직접 실행할 때만 필요한 선택 의존성이라 기본 `backend\.venv`에는 넣지 않습니다. 필요하면 Windows 긴 경로 문제를 피하기 위해 짧은 경로에 별도 환경을 만듭니다.
현재 PC에서 `llama-cpp-python`을 소스 설치하려면 Windows 긴 경로 설정(`LongPathsEnabled=1`)이 필요합니다. 이 값이 꺼져 있으면 아래 스크립트는 시작 전에 실패 이유를 알려줍니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\setup_llama_cpp_env.ps1 -Python <python.exe 경로>
```

## 캐시와 생성물

아래 항목은 커밋하지 않습니다.

```text
lmo_audio\
video\
.hf_modules\
.codex-work\
outputs\
models\
backend\models\
backend\build\
backend\dist-sidecar\
desktop-app\dist\
desktop-app\src-tauri\target\
lmo_audio*.zip
*.mp4
```

`.hf_modules`는 음성 인식 모델처럼 추가 실행 코드가 필요한 모델의 코드 캐시입니다. 지워도 필요하면 다시 생성됩니다.

## 회사 PC 이관

회사 PC에는 실행용이면 프로젝트의 `releases\lmo_audio` 폴더 전체를 `lmo_audio` 폴더로 옮기면 됩니다. 기본 음성 인식 모델은 관리자가 지정한 공유 저장소나 외장 저장장치에서 받아 `releases\lmo_audio\models\faster-whisper-large-v3` 아래에 복사합니다. 앱 안에서 사용자가 개별적으로 모델을 내려받는 흐름은 사용하지 않습니다.

자세한 내용은 [LMO 회의 인사이트 portable 회사 PC 사용법](docs/lmo-meeting-insight-company-pc-guide.md)을 봅니다.

회사 PC에서 실행 파일을 다시 만들 때는 먼저 빌드 도구와 모델 원본 위치를 확인합니다.

- Python/venv: `backend\.venv-desktop\Scripts\python.exe` 또는 `scripts\release_portable.ps1 -Python <python.exe 경로>`로 지정할 수 있는 Python
- Python 패키지: `backend\requirements-desktop.txt` 기준 설치, `PyInstaller` 사용 가능
- Node/Tauri: `corepack`, `pnpm`, Rust/Cargo, Tauri 빌드 도구 사용 가능
- 모델 원본 위치: `models\faster-whisper-large-v3`, `models\speaker-diarization-community-1`
- 최종 실행 위치: `releases\lmo_audio\models\faster-whisper-large-v3`, `releases\lmo_audio\models\speaker-diarization-community-1`

Qwen/Cohere는 회사 PC 실행 경로의 STT 후보가 아닙니다. 관련 기록과 벤치마크 설정은 남기지만, 기본 앱 빌드와 portable 모델 묶음에는 `faster-whisper-large-v3`와 화자 분리 모델만 사용합니다.

## 배포 정리 기준

헷갈리지 않도록 새 배포본은 루트에서 한 명령으로 만들고 검증합니다. 이 프로젝트에서 `빌드`라고 하면 일반 사용자 PC에 옮겨 실행할 수 있는 `releases\lmo_audio` 포터블 배포본을 뜻합니다.

```powershell
corepack pnpm build
```

동일한 작업을 스크립트로 직접 실행할 수도 있습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_user_release.ps1
```

`desktop-app` 안의 `pnpm build`는 Tauri가 사용하는 Vite 웹 자산만 생성합니다. 사용자에게 전달할 실행본을 만들 때는 루트의 `corepack pnpm build` 또는 `scripts\build_user_release.ps1`를 사용합니다.

이미 Tauri exe와 sidecar를 새로 빌드한 직후라면 빠른 동기화/검증만 할 수 있습니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_user_release.ps1 -SkipSidecarBuild -SkipTauriBuild
```

이미 사용자 PC에 `lmo_audio\models`가 준비되어 있으면 모델을 제외한 업데이트 패키지만 만들 수 있습니다.

```powershell
corepack pnpm package:update
```

업데이트 패키지는 커밋 후 깨끗한 portable 빌드가 끝난 상태에서 만듭니다. 기존 빌드가 현재 `HEAD`와 다르면 기본적으로 실패합니다.

기본 산출물은 `releases\updates\lmo_audio_update_<commit>`입니다. 이 절차는 자동 업데이트가 아니라 관리자/운영자가 앱을 닫은 유지보수 시간에 실행하는 수동 업데이트입니다. 사용자 PC에서는 그 폴더 안에서 기존 `lmo_audio` 폴더를 대상으로 적용합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File update_lmo_audio.ps1 -TargetDir D:\Apps\lmo_audio
```

이 업데이트는 기존 `models`, `backend\config.json`, `backend\outputs`, `backend\temp`를 보존합니다. 새 PC나 모델이 없는 PC에는 업데이트 패키지가 아니라 전체 `releases\lmo_audio` 폴더를 전달합니다.

프로젝트 안의 배포 기준 실행 폴더는 항상 `releases\lmo_audio`입니다. `desktop-app\src-tauri\target\release\portable\lmo_audio`는 빌드 중간 산출물로 보고 직접 실행 기준으로 삼지 않습니다.

`release-manifest.json`은 배포본의 신분증입니다. 어떤 커밋에서 만들었는지, 앱 exe/분석 실행 파일/backend 설정 파일의 해시가 무엇인지 기록합니다. `verify_portable.ps1`과 `diagnose_portable.ps1`은 이 값을 다시 계산해 구버전 파일이나 손으로 바뀐 파일이 섞였는지 확인합니다.

분석 결과는 portable 실행 폴더 하위에 저장됩니다.

```text
lmo_audio\backend\outputs\
lmo_audio\backend\temp\
```

따라서 회사 PC에서는 `lmo_audio` 폴더를 쓰기 가능한 위치에 둡니다. 예: `D:\lmo_audio`, `D:\Apps\lmo_audio`.

상태가 이상하면 먼저 아래 진단 스크립트를 실행합니다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose_portable.ps1
```
