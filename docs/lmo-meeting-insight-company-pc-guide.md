# LMO 회의 인사이트 Portable 회사 PC 사용법

## 폴더 구조

zip을 풀면 `lmo_audio` 폴더 전체를 그대로 사용합니다. `lmo_audio.exe`만 따로 빼서 실행하지 마세요.

이 폴더는 git으로 전달되지 않습니다. 소스 코드를 `git pull`하는 것과 실행용 `lmo_audio` 폴더를 복사하는 것은 별도 작업입니다.

```text
lmo_audio\
  lmo_audio.exe
  models\
    README.txt
    faster-whisper-large-v3\        <- 슬림 전달본에서는 제외될 수 있음
      model.bin
      tokenizer.json
      config.json
    speaker-diarization-community-1\ <- 기본 포함
      config.yaml
      embedding\
      segmentation\
      plda\
  backend\
  binaries\
```

## 기본 음성 인식 모델 넣는 위치

기본 음성 인식 모델은 관리자가 지정한 파일 묶음을 받아 실행 파일 옆 `models\faster-whisper-large-v3` 폴더 아래에 넣습니다. 슬림 전달본은 용량을 줄이기 위해 이 Whisper 모델만 제외할 수 있습니다. 설정 화면의 음성 분석 모델 영역은 모델 유무와 준비 안내를 보여주는 곳이며, 현재 STT 모델 파일을 앱 안에서 자동 다운로드하지 않습니다.

Whisper 모델 링크는 참고용 출처일 뿐입니다. 현재 앱은 일반 Whisper 원본 파일이 아니라 `faster-whisper-large-v3` 전체 폴더 구조를 기대하므로, 모델 페이지에서 일부 파일만 받거나 다른 폴더명으로 풀면 앱이 모델을 찾지 못합니다. 회사 전달용은 관리자가 검증한 모델 묶음을 받아 아래 위치에 그대로 푸는 방식으로 맞춥니다.

```text
lmo_audio\models\faster-whisper-large-v3\
```

예를 들어 회사 PC에서 아래 위치에 zip을 풀었다면:

```text
D:\Apps\lmo_audio\
```

기본 음성 인식 모델 파일은 이렇게 보여야 합니다.

```text
D:\Apps\lmo_audio\models\faster-whisper-large-v3\model.bin
D:\Apps\lmo_audio\models\faster-whisper-large-v3\tokenizer.json
D:\Apps\lmo_audio\models\faster-whisper-large-v3\config.json
```

아래처럼 예전 Cohere 폴더를 넣으면 현재 기본 STT로는 사용하지 않습니다.

```text
models\
  cohere-transcribe-03-2026\
    config.json
```

Cohere는 과거 벤치마크/비교 후보로만 남기고, 새 배포 기준은 `models\faster-whisper-large-v3`입니다.

## 참석자 구분 모델

참석자 구분 모델은 `models\speaker-diarization-community-1` 아래에 둡니다. 용량이 작으므로 회사 전달용 슬림 zip에도 포함합니다. portable 패키지를 만들 때 현재 PC에 모델이 있으면 자동으로 아래 구조로 복사됩니다.

```text
lmo_audio\models\speaker-diarization-community-1\config.yaml
lmo_audio\models\speaker-diarization-community-1\embedding\pytorch_model.bin
lmo_audio\models\speaker-diarization-community-1\segmentation\pytorch_model.bin
lmo_audio\models\speaker-diarization-community-1\plda\plda.npz
```

기존처럼 `models` 바로 아래에 참석자 구분 파일을 두는 방식도 당분간 함께 인식하지만, 새 배포 기준은 모델별 폴더입니다.

## 다른 STT 모델

나중에 Whisper, Qwen ASR 같은 선택 모델을 추가할 때는 충돌을 피하려고 모델별 폴더를 사용할 수 있습니다.

```text
lmo_audio\models\faster-whisper-large-v3\
```

현재 회사 전달용 기본 음성 인식 모델은 `faster-whisper-large-v3` 하나입니다. Qwen 계열은 비교/실험 기록으로만 남기고, 이번 portable 실행 폴더와 재빌드용 모델 원본에는 넣지 않습니다.

## 실행 방법

1. `lmo_audio.exe`를 실행합니다.
2. 시스템 설정 > 모델에서 상태를 확인합니다.
3. 기본 음성 인식 모델이 없으면 `models\faster-whisper-large-v3` 아래에 모델 파일을 복사합니다. 참석자 구분 모델은 슬림 전달본에도 포함되어 있어야 합니다.
4. 상태 새로고침을 누르거나 앱을 다시 실행합니다.
5. MP4, WAV, MP3 파일을 올리고 `AI 분석 시작`을 누릅니다.

## 정리 모델과 Ollama

대화록 작성에 필요한 기본 음성 인식 모델과 참석자 구분 모델은 앱 안에서 다운로드하지 않습니다. 관리자가 준비한 파일을 `models` 폴더에 넣는 방식입니다. 설정 화면에서 `안내`가 보이면 모델 파일을 직접 받는 버튼이 아니라 준비 위치와 원본 페이지를 확인하는 안내로 보면 됩니다.

전체 요약, 주제별 정리, 참석자별 정리에 쓰는 Ollama 정리 모델은 별도입니다. 외부망이 있고 Ollama가 설치된 PC에서는 시스템 설정 > 모델에서 추천 정리 모델을 받거나 직접 입력한 모델을 선택할 수 있습니다. Ollama가 설치되어 있지 않으면 앱이 정리 모델을 받을 수 없으므로 먼저 Ollama를 설치한 뒤 다시 시도합니다. 내부망 또는 오프라인 PC에서는 이미 설치된 Ollama 모델이 감지되는지 확인하고, 모델이 없으면 대화록 작성만 먼저 사용합니다.

외부망 PC의 구체적인 순서는 아래와 같습니다.

1. [Ollama Windows 설치 페이지](https://ollama.com/download/windows)에서 Ollama를 설치합니다.
2. 설치가 끝나면 LMO 회의 인사이트를 다시 실행하거나 시스템 설정 > 모델에서 상태를 새로고침합니다.
3. 회의 요약 모델에서 `gemma4:e2b` 같은 권장 모델의 `받기`를 누릅니다.
4. 모델 받기가 완료되면 해당 모델을 사용 중 모델로 선택하고, 전체 요약/주제별 정리/참석자별 정리를 실행합니다.

## 다른 PC 실제 확인

자동 시뮬레이션은 UI 흐름과 API 계약을 확인하는 용도입니다. 회사 PC나 별도 PC에서는 아래 항목을 실제 앱으로 확인합니다.

1. `lmo_audio` 폴더 전체를 쓰기 가능한 위치에 둡니다.
2. `lmo_audio.exe` 실행 시 별도 콘솔 창 없이 앱이 열리는지 확인합니다.
3. 시스템 설정 > 모델에서 기본 음성 인식 모델, 참석자 구분 모델, Ollama 정리 모델 상태를 확인합니다.
4. 외부망 PC라면 Ollama 정리 모델 받기를 실행하고, 완료 후 사용 중 모델로 선택되는지 확인합니다.
5. 내부망/오프라인 PC라면 이미 설치된 Ollama 모델만 감지되는지 확인합니다.
6. 짧은 MP4 또는 WAV 파일로 대화록 작성을 실행합니다.
7. 회의 기록에 대화록이 저장되고 다시 열리는지 확인합니다.
8. 원본 음성이 보존된 상태에서 참석자 구분을 실행합니다.
9. Ollama 정리 모델이 준비된 경우 전체 요약, 주제별 정리, 참석자별 정리를 실행합니다.
10. HWPX/TXT/DOCX 다운로드를 실행하고, HWPX는 한글 또는 HWPX 뷰어에서 실제로 열어 봅니다.
11. 영상에서 음성 파일 저장을 실행했다면 사용자가 보는 다운로드 위치를 확인합니다.

## 주의 사항

- 기본 음성 인식 모델은 구글 드라이브, 사내 공유 드라이브, 외장 SSD 등 관리자가 지정한 위치에서 받아 `models\faster-whisper-large-v3`에 복사하세요.
- 회사 전달용 슬림 zip은 `corepack pnpm package:handoff`로 만듭니다. 이 zip은 `speaker-diarization-community-1`은 포함하고, 큰 `faster-whisper-large-v3`만 제외합니다.
- 정상 배포본에서는 별도 PowerShell 창이 뜨지 않아야 합니다.
- zip을 옮길 때는 `lmo_audio` 폴더 전체를 옮기세요.
- 분석 결과와 임시 파일은 `lmo_audio\backend\outputs`, `lmo_audio\backend\temp`에 생성됩니다. 앱 폴더는 쓰기 가능한 D 드라이브 같은 위치에 두세요.

## 프로젝트 루트 정리 기준

이 프로젝트에서 새로 만든 실행 기준 폴더는 `releases\lmo_audio` 하나입니다.

```text
<프로젝트 루트>\releases\lmo_audio\lmo_audio.exe
```

집 PC와 회사 PC의 프로젝트 폴더명은 달라도 됩니다. 소스에서 다시 빌드할 때는 프로젝트 루트에서 스크립트를 실행하고, 스크립트가 자기 위치 기준으로 필요한 경로를 계산합니다. 다만 `backend\.venv-desktop` 같은 Python 가상환경은 PC 간에 복사해서 쓰지 말고, 해당 PC의 Python으로 새로 만듭니다.

아래 항목은 빌드/테스트 중 생기는 산출물이므로, 새로 빌드하기 전에는 삭제해도 됩니다.

```text
desktop-app\src-tauri\target\
desktop-app\src-tauri\binaries\
desktop-app\src-tauri\resources\
desktop-app\dist\
backend\build\
backend\dist-sidecar\
outputs\
.codex-work\
lmo_audio*.zip
```

루트에 둔 테스트용 MP4 파일도 더 이상 테스트하지 않을 때는 삭제해도 됩니다.

삭제하면 안 되는 기본 소스 폴더는 아래입니다.

```text
backend\
desktop-app\
docs\
scripts\
models\
configs\
```

`releases\lmo_audio` 폴더는 실행용 배포 폴더입니다. 회사 PC로 옮길 때도 이 폴더 전체를 `lmo_audio` 폴더로 옮기면 됩니다. 프로젝트 루트의 `lmo_audio` 폴더가 있다면 예전 산출물일 수 있으므로 새 배포 기준으로 사용하지 않습니다.

## release-manifest.json

`release-manifest.json`은 배포본의 기준표입니다. 앱 실행 파일, 분석 실행 파일, backend 파일의 해시와 생성 커밋을 기록합니다. 문제가 생기면 `scripts\diagnose_portable.ps1`로 현재 파일이 manifest와 같은지 확인합니다.
