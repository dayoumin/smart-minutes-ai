# lmo_audio Portable 회사 PC 사용법

## 폴더 구조

zip을 풀면 `lmo_audio` 폴더 전체를 그대로 사용합니다. `lmo_audio.exe`만 따로 빼서 실행하지 마세요.

```text
lmo_audio\
  lmo_audio.exe
  models\
    README.txt
    faster-whisper-large-v3\
      model.bin
      tokenizer.json
      config.json
    speaker-diarization-community-1\
      config.yaml
      embedding\
      segmentation\
      plda\
  backend\
  binaries\
```

## 기본 음성 인식 모델 넣는 위치

기본 음성 인식 모델은 관리자가 지정한 파일 묶음을 받아 실행 파일 옆 `models\faster-whisper-large-v3` 폴더 아래에 넣습니다. 앱에서 사용자가 개별적으로 모델을 내려받지는 않습니다.

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

## 화자 분리 모델

화자 분리 모델은 `models\speaker-diarization-community-1` 아래에 둡니다. portable 패키지를 만들 때 현재 PC에 모델이 있으면 자동으로 아래 구조로 복사됩니다.

```text
lmo_audio\models\speaker-diarization-community-1\config.yaml
lmo_audio\models\speaker-diarization-community-1\embedding\pytorch_model.bin
lmo_audio\models\speaker-diarization-community-1\segmentation\pytorch_model.bin
lmo_audio\models\speaker-diarization-community-1\plda\plda.npz
```

기존처럼 `models` 바로 아래에 화자 분리 파일을 두는 방식도 당분간 함께 인식하지만, 새 배포 기준은 모델별 폴더입니다.

## 다른 STT 모델

나중에 Whisper, Qwen ASR 같은 선택 모델을 추가할 때는 충돌을 피하려고 모델별 폴더를 사용할 수 있습니다.

```text
lmo_audio\models\faster-whisper-large-v3\
```

현재 회사 전달용 기본 음성 인식 모델은 `faster-whisper-large-v3` 하나입니다. Qwen 계열은 비교/실험 기록으로만 남기고, 이번 portable 실행 폴더와 재빌드용 모델 원본에는 넣지 않습니다.

## 실행 방법

1. `lmo_audio.exe`를 실행합니다.
2. 시스템 설정 > 모델에서 상태를 확인합니다.
3. 기본 음성 인식 모델이 없으면 `models\faster-whisper-large-v3` 아래에 모델 파일을 복사합니다.
4. 상태 새로고침을 누르거나 앱을 다시 실행합니다.
5. MP4, WAV, MP3 파일을 올리고 `AI 분석 시작`을 누릅니다.

## 주의 사항

- 기본 음성 인식 모델은 구글 드라이브, 사내 공유 드라이브, 외장 SSD 등 관리자가 지정한 위치에서 받아 `models\faster-whisper-large-v3`에 복사하세요.
- 정상 배포본에서는 별도 PowerShell 창이 뜨지 않아야 합니다.
- zip을 옮길 때는 `lmo_audio` 폴더 전체를 옮기세요.
- 분석 결과와 임시 파일은 `lmo_audio\backend\outputs`, `lmo_audio\backend\temp`에 생성됩니다. 앱 폴더는 쓰기 가능한 D 드라이브 같은 위치에 두세요.

## 프로젝트 루트 정리 기준

이 프로젝트에서 새로 만든 실행 기준 폴더는 `releases\lmo_audio` 하나입니다.

```text
D:\Projects\audio\releases\lmo_audio\lmo_audio.exe
```

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
lmo_audio\
```

`lmo_audio` 폴더는 실행용 배포 폴더입니다. 회사 PC로 옮길 때도 이 폴더 전체를 옮기면 됩니다.

## release-manifest.json

`release-manifest.json`은 배포본의 기준표입니다. 앱 실행 파일, 분석 실행 파일, backend 파일의 해시와 생성 커밋을 기록합니다. 문제가 생기면 `scripts\diagnose_portable.ps1`로 현재 파일이 manifest와 같은지 확인합니다.
