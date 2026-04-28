# Smart Minutes AI Portable 사용법

## 포함된 것

- `Smart Minutes AI.exe`: 데스크톱 앱 실행 파일
- `binaries/meeting-backend-x86_64-pc-windows-msvc.exe`: 로컬 FastAPI 백엔드 sidecar
- `backend/ffmpeg.exe`: MP4/MOV 같은 영상에서 음성 추출
- `backend/models/diarization/speaker-diarization-community-1`: Pyannote 화자 분리 모델

## 포함하지 않은 것

- Cohere 음성 인식 모델: `CohereLabs/cohere-transcribe-03-2026`

Cohere 모델은 용량이 커서 portable zip에서 제외했습니다. 회사 PC에서는 이 모델만 추가로 받아서 아래 위치에 넣으면 됩니다.

```text
Smart Minutes AI\backend\models\stt\cohere-transcribe-03-2026\
```

최소한 아래 파일들이 보여야 합니다.

```text
backend\models\stt\cohere-transcribe-03-2026\config.json
backend\models\stt\cohere-transcribe-03-2026\model.safetensors
backend\models\stt\cohere-transcribe-03-2026\preprocessor_config.json
```

## 회사 PC에서 배치 위치

zip을 원하는 폴더에 풀면 됩니다. 예시는 아래와 같습니다.

```text
D:\Apps\Smart Minutes AI\
```

실행할 때는 폴더 안의 `Smart Minutes AI.exe`를 실행합니다. 단, exe 하나만 따로 빼서 실행하면 백엔드와 모델 파일을 찾지 못하므로 폴더 전체를 함께 유지해야 합니다.

## 실행 방법

1. `Smart Minutes AI.exe`를 실행합니다.
2. 앱이 내부 로컬 분석 서버를 준비할 때까지 잠시 기다립니다.
3. MP4, WAV, MP3 파일을 올려 회의록을 생성합니다.
4. 결과 화면에서 기본 HWPX 형식으로 다운로드할 수 있습니다.

## 주의 사항

- 첫 실행은 백엔드 압축 해제 때문에 시간이 걸릴 수 있습니다.
- 백엔드는 앱 내부에서 숨김 실행되도록 구성되어 있으므로 별도 PowerShell 창이 뜨지 않아야 합니다.
- Cohere 모델이 없으면 실제 음성 인식은 동작하지 않습니다.
- Pyannote 화자 분리 모델과 ffmpeg는 이미 포함되어 있습니다.
- Ollama/Gemma 요약은 회사 PC에 Ollama와 해당 모델이 준비되어 있어야 정상 동작합니다.
