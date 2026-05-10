# ASR 모델 벤치마크 운영 메모

이 문서는 음성 인식 모델을 계속 교체하며 같은 샘플로 비교하기 위한 실행 기준이다.
앱의 실제 분석 파이프라인을 바로 바꾸지 않고, 먼저 별도 벤치마크 환경에서 STT 원문 품질과 timestamp 품질을 비교한다.

## 원칙

- 같은 manifest, 같은 시작 지점, 같은 길이로 비교한다.
- STT 원문 품질, 처리 시간, timestamp/화자 정렬 가능성, 로컬 배포 난이도를 같이 본다.
- 앱 기본 모델은 비교 결과가 누적된 뒤에만 바꾼다.
- Qwen3-ASR처럼 의존성이 큰 모델은 앱 백엔드 가상환경에 바로 섞지 않고 별도 테스트 환경에서 먼저 검증한다.

## 설정 파일

- 모델 후보 설정: `configs/asr-models.json`
- 기준 샘플: `docs/audio-regression-manifest.csv`
- 결과 폴더: `backend/temp/asr_benchmark`
- 개발용 결과 화면: 웹 UI의 `ASR 테스트 결과`

후보 모델은 `configs/asr-models.json`의 `engines` 배열에 추가한다.
`enabled=false`로 두면 `--engines all`에서 제외된다.

## 웹 UI 표시 기준

- 개발 중에는 Vite `DEV` 모드에서 `ASR 테스트 결과` 메뉴를 보여준다.
- 데스크톱 빌드에서는 `desktop-app/.env.desktop`의 `VITE_ENABLE_ASR_BENCHMARK=false`로 메뉴를 숨긴다.
- 릴리스 빌드에 포함해야 하는 특별한 경우에만 `VITE_ENABLE_ASR_BENCHMARK=true`로 바꾼다.
- 화면은 `backend/temp/asr_benchmark`, `backend/temp/api_quality_test`, `backend/temp/audio_performance_eval`의 JSON 결과를 읽어 보여준다.

## 지원할 엔진 유형

- `cohere`: 현재 앱의 Cohere Transcribe 경로를 그대로 호출한다.
- `faster_whisper`: `faster-whisper` Python 패키지로 CTranslate2 모델을 호출한다.
- `qwen_asr`: `qwen-asr` Python 패키지로 Qwen3-ASR을 호출한다.
- `openai_audio_server`: vLLM 같은 OpenAI 호환 서버를 띄운 뒤 HTTP로 호출한다.
- `external_command`: GGUF/llama-server/Ollama/LM Studio처럼 별도 실행 도구가 필요한 모델을 명령어로 감싼다.

## 환경 준비

faster-whisper:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_asr_benchmark_env.ps1 -Engine faster-whisper
```

Qwen3-ASR:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\setup_asr_benchmark_env.ps1 -Engine qwen3-asr
```

Qwen3-ASR 공식 문서는 깨끗한 Python 3.12 환경을 권장한다.
Qwen3-ASR + Qwen3-ForcedAligner는 timestamp 비교까지 할 때 사용한다.

## 실행 예시

후보 목록:

```powershell
python scripts\run_asr_benchmark.py --list
```

현재 앱 Cohere만 비교:

```powershell
python scripts\run_asr_benchmark.py --engines cohere-current --sample-seconds 90 --output backend\temp\asr_benchmark\cohere_90s.json
```

faster-whisper 전용 환경에서 비교:

```powershell
backend\.venv-asr-faster-whisper\Scripts\python.exe scripts\run_asr_benchmark.py --engines faster-whisper-large-v3 --sample-seconds 90 --output backend\temp\asr_benchmark\faster_whisper_90s.json
```

Qwen3-ASR + ForcedAligner 비교:

```powershell
backend\.venv-asr-qwen3\Scripts\python.exe scripts\run_asr_benchmark.py --engines qwen3-asr-1.7b-transformers-aligner --sample-seconds 90 --output backend\temp\asr_benchmark\qwen3_aligner_90s.json
```

## Qwen3-ASR 후보

공식 모델 카드 기준:

- Qwen3-ASR-1.7B는 한국어를 포함한 여러 언어 ASR을 지원한다.
- Qwen3-ForcedAligner-0.6B는 한국어 포함 11개 언어에서 word/character timestamp 예측을 지원한다.
- `qwen-asr` 패키지는 transformers backend와 vLLM backend를 제공한다.
- GGUF 변환 모델은 Ollama, llama-server, LM Studio 같은 외부 런타임으로 붙이는 후보로 본다.

2026-05-07 로컬 CPU 테스트:

| 모델 | 길이 | 처리 시간 | 전사 글자 수 | 한글 비율 | 비고 |
| --- | ---: | ---: | ---: | ---: | --- |
| Qwen3-ASR-1.7B | 30초 | 51.16초 | 226자 | 98.8% | 텍스트 품질 smoke 성공 |
| Qwen3-ASR-1.7B | 90초 | 123.64초 | 610자 | 99.6% | Cohere의 로마자식 붕괴 미재현 |
| Qwen3-ASR-1.7B + ForcedAligner | 30초 | 58.07초 | 226자 | 98.8% | 75개 timestamp segment 생성 |

현재 판단:

- Qwen3-ASR는 STT 후보 모델로 계속 비교한다.
- ForcedAligner는 timestamp 보조 모델로 분리한다. 발화 기록과 화자별 정리에 쓰려면 단어 단위 결과를 문장 단위로 병합해야 한다.
- 현재 PC는 CUDA가 없어 `dtype=float32`, `device_map=cpu`, `max_inference_batch_size=1`로 테스트한다. GPU 장비에서는 공식 예시처럼 `bfloat16`/vLLM을 별도 비교한다.

## 판정 기준

최소 기록 항목:

- 한글 비율
- 로마자식 한국어 오인식 여부
- 고유명사/약어 인식
- 세그먼트/timestamp 품질
- 처리 시간
- GPU/CPU 메모리 부담
- 앱 포터블 배포 난이도

Qwen3-ASR가 Cohere보다 원문 품질이 좋더라도, ForcedAligner timestamp 품질이 낮으면 화자별 정리 품질이 흔들릴 수 있다.
따라서 최종 채택 전에는 `STT 원문만 비교`와 `STT + alignment 비교`를 분리해서 본다.
