# Smart Minutes AI Portable 회사 PC 사용법

## 포함된 것

- `Smart Minutes AI.exe`: 데스크탑 앱 실행 파일
- `binaries/meeting-backend-x86_64-pc-windows-msvc.exe`: 로컬 FastAPI 분석 서버
- `backend/ffmpeg.exe`: MP4/MOV 같은 영상에서 음성 추출
- `backend/models/diarization/speaker-diarization-community-1`: Pyannote 화자 분리 모델

## 별도로 준비할 것

Portable zip에는 Cohere 음성 인식 모델이 포함되어 있지 않습니다.

- 모델명: `CohereLabs/cohere-transcribe-03-2026`
- 저장 위치:

```text
Smart Minutes AI\backend\models\stt\cohere-transcribe-03-2026\
```

앱에서 음성/영상 분석을 시작했을 때 모델이 없으면 확인/취소 안내창이 뜹니다. 확인을 누르면 위 폴더가 프로그램 하위에 생성되고 모델 다운로드가 시작됩니다. 취소하면 분석을 시작하지 않습니다.

회사 PC에서 인터넷 또는 Hugging Face 접근이 막혀 있으면, 모델을 수동으로 받아서 같은 위치에 복사하면 됩니다.

```text
D:\Apps\Smart Minutes AI\backend\models\stt\cohere-transcribe-03-2026\
```

최소한 아래 파일들이 보여야 합니다.

```text
config.json
model.safetensors
preprocessor_config.json
```

## 설치 위치

zip을 원하는 폴더에 풀면 됩니다. 예시는 아래와 같습니다.

```text
D:\Apps\Smart Minutes AI\
```

`Smart Minutes AI.exe`만 따로 빼서 실행하지 말고, zip을 푼 폴더 전체를 유지해야 합니다. 앱은 같은 폴더 아래의 `backend`, `binaries`, `backend\models`를 기준으로 서버와 모델을 찾습니다.

## 실행 방법

1. `Smart Minutes AI.exe`를 실행합니다.
2. 앱이 내부 로컬 분석 서버를 준비할 때까지 잠시 기다립니다.
3. MP4, WAV, MP3 파일을 올리고 `AI 분석 시작`을 누릅니다.
4. Cohere 모델이 없으면 안내창에서 다운로드를 확인하거나 취소합니다.
5. 분석이 끝나면 이전 회의 기록에서 결과를 확인하고 다운로드할 수 있습니다.

## 주의 사항

- 정상 배포본에서는 별도 PowerShell 창이 뜨지 않아야 합니다.
- 첫 실행은 백엔드 압축 해제와 모델 확인 때문에 시간이 걸릴 수 있습니다.
- Cohere 모델 다운로드에는 Hugging Face 토큰 또는 접근 권한이 필요할 수 있습니다.
- Pyannote 화자 분리 모델과 ffmpeg는 portable 폴더에 포함되어 있습니다.
- Ollama/Gemma 요약은 회사 PC에 Ollama와 해당 모델이 준비되어 있어야 정상 동작합니다.
- 문제가 생기면 앱 화면의 오류 메시지를 먼저 확인하고, 필요하면 실행 중인 다른 Smart Minutes AI 또는 Python/FastAPI 서버를 모두 종료한 뒤 다시 실행합니다.
