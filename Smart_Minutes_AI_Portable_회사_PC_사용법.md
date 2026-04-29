# Smart Minutes AI Portable 회사 PC 사용법

## 폴더 구조

zip을 풀면 `Smart Minutes AI` 폴더 전체를 그대로 사용합니다. `Smart Minutes AI.exe`만 따로 빼서 실행하지 마세요.

```text
Smart Minutes AI\
  Smart Minutes AI.exe
  models\
    README.txt
    cohere-transcribe-03-2026\
    faster-whisper-large-v3\
    qwen-asr\
    speaker-diarization-community-1\
  backend\
  binaries\
```

## 음성 인식 모델 넣는 위치

Cohere 모델은 아래처럼 실행 파일 옆 `models` 폴더에 바로 넣습니다.

```text
Smart Minutes AI\models\cohere-transcribe-03-2026\
```

예를 들어 회사 PC에서 아래 위치에 zip을 풀었다면:

```text
D:\Apps\Smart Minutes AI\
```

모델 위치는 이렇게 됩니다.

```text
D:\Apps\Smart Minutes AI\models\cohere-transcribe-03-2026\
```

`cohere-transcribe-03-2026` 폴더 안에 바로 모델 파일이 보여야 합니다.

```text
cohere-transcribe-03-2026\
  config.json
  model.safetensors
  preprocessor_config.json
  tokenizer.json
  ...
```

아래처럼 한 단계 더 중첩되면 안 됩니다.

```text
cohere-transcribe-03-2026\
  cohere-transcribe-03-2026\
    config.json
```

## 다른 STT 모델

나중에 더 좋은 음성 인식 모델이 나오면 `models` 폴더에 모델 폴더를 추가하면 됩니다.

```text
Smart Minutes AI\models\qwen-asr\
Smart Minutes AI\models\faster-whisper-large-v3\
```

이후 앱의 시스템 설정에서 사용할 모델을 선택하는 방식으로 확장할 예정입니다.

## 실행 방법

1. `Smart Minutes AI.exe`를 실행합니다.
2. 시스템 설정 > 모델에서 모델 상태를 확인합니다.
3. Cohere 모델이 없으면 `models\cohere-transcribe-03-2026`에 모델을 복사합니다.
4. 상태 새로고침을 누르거나 앱을 다시 실행합니다.
5. MP4, WAV, MP3 파일을 올리고 `AI 분석 시작`을 누릅니다.

## 주의 사항

- Cohere 모델은 Hugging Face 로그인/권한/토큰이 필요할 수 있어 회사 PC에서 자동 다운로드가 막힐 수 있습니다.
- 그런 경우 구글 드라이브, 사내 공유 드라이브, 외장 SSD 등으로 모델 폴더를 전달해서 `models`에 복사하세요.
- Pyannote 화자 분리 모델은 portable 패키지의 `models\speaker-diarization-community-1`에 포함됩니다.
- 정상 배포본에서는 별도 PowerShell 창이 뜨지 않아야 합니다.
