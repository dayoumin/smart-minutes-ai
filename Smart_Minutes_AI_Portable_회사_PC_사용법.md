# Smart Minutes AI Portable 회사 PC 사용법

## 폴더 구조

zip을 풀면 `Smart Minutes AI` 폴더 전체를 그대로 사용합니다. `Smart Minutes AI.exe`만 따로 빼서 실행하지 마세요.

```text
Smart Minutes AI\
  Smart Minutes AI.exe
  models\
    README.txt
    config.json
    model.safetensors
    preprocessor_config.json
    tokenizer_config.json
    config.yaml
    embedding\
    segmentation\
    plda\
  backend\
  binaries\
```

## Cohere 음성 인식 모델 넣는 위치

Cohere 모델은 실행 파일 옆 `models` 폴더 바로 아래에 넣습니다.

```text
Smart Minutes AI\models\
```

예를 들어 회사 PC에서 아래 위치에 zip을 풀었다면:

```text
D:\Apps\Smart Minutes AI\
```

Cohere 모델 파일은 이렇게 보여야 합니다.

```text
D:\Apps\Smart Minutes AI\models\config.json
D:\Apps\Smart Minutes AI\models\model.safetensors
D:\Apps\Smart Minutes AI\models\preprocessor_config.json
D:\Apps\Smart Minutes AI\models\tokenizer_config.json
```

아래처럼 한 단계 더 중첩되면 기본 위치로는 인식하지 않습니다.

```text
models\
  cohere-transcribe-03-2026\
    config.json
```

기존 호환을 위해 위 중첩 구조도 일부 인식하지만, 새 배포 기준은 `models` 바로 아래입니다.

## Pyannote 화자 분리 모델

Pyannote 모델도 `models` 바로 아래에 둘 수 있습니다. portable 패키지를 만들 때 현재 PC에 Pyannote 모델이 있으면 자동으로 아래 구조로 복사됩니다.

```text
Smart Minutes AI\models\config.yaml
Smart Minutes AI\models\embedding\pytorch_model.bin
Smart Minutes AI\models\segmentation\pytorch_model.bin
Smart Minutes AI\models\plda\plda.npz
```

기존 `models\speaker-diarization-community-1` 폴더 방식도 당분간 함께 인식합니다.

## 다른 STT 모델

나중에 Whisper, Qwen ASR 같은 선택 모델을 추가할 때는 충돌을 피하려고 모델별 폴더를 사용할 수 있습니다.

```text
Smart Minutes AI\models\faster-whisper-large-v3\
Smart Minutes AI\models\qwen-asr\
```

현재 기본 음성 인식은 Cohere입니다. 모델 선택 UI가 완성되기 전까지는 Cohere 모델을 `models` 바로 아래에 두는 방식을 우선 사용합니다.

## 실행 방법

1. `Smart Minutes AI.exe`를 실행합니다.
2. 시스템 설정 > 모델에서 상태를 확인합니다.
3. Cohere 모델이 없으면 `models` 바로 아래에 모델 파일을 복사합니다.
4. 상태 새로고침을 누르거나 앱을 다시 실행합니다.
5. MP4, WAV, MP3 파일을 올리고 `AI 분석 시작`을 누릅니다.

## 주의 사항

- Cohere 모델은 Hugging Face 로그인 권한이나 토큰이 필요할 수 있어 회사 PC에서 자동 다운로드가 막힐 수 있습니다.
- 그 경우 구글 드라이브, 사내 공유 드라이브, 외장 SSD 등으로 모델 파일을 전달해서 `models`에 복사하세요.
- 정상 배포본에서는 별도 PowerShell 창이 뜨지 않아야 합니다.
- zip을 옮길 때는 `Smart Minutes AI` 폴더 전체를 옮기세요.
