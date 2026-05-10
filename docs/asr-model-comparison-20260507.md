# ASR 모델 비교 결과

작성일: 2026-05-07

## 목적

최근 Cohere 기반 음성 인식 결과가 이전보다 낮아졌다는 피드백을 기준으로, 같은 샘플에서 세 가지 STT 후보를 비교했다.

비교 대상:

- Cohere Transcribe 현재 앱 모델
- faster-whisper-large-v3
- Qwen3-ASR-1.7B

## 공통 샘플

- 원본: `Smart Minutes AI/backend/temp/20260506_072159_upload.mp4`
- 비교 구간: 파일 앞 90초
- 샘플 성격: 한국어 TV 토론 영상
- 주요 관찰 지표:
  - 한글 비율
  - 로마자식 한국어 오인식 여부
  - 처리 시간
  - timestamp/화자 정렬 연결 가능성
  - 포터블 앱 배포 난이도

한글 비율은 전사 텍스트에서 한글 문자와 라틴 문자의 비율을 단순 계산한 보조 지표다. 실제 정확도 판단은 미리보기 문장과 반복/누락 여부를 함께 본다.

## 비교 요약

| 모델 | 테스트 조건 | 처리 시간 | 전사 글자 수 | 한글 비율 | 세그먼트 | 판단 |
| --- | --- | ---: | ---: | ---: | ---: | --- |
| Cohere current | raw/off, 90초 | 10.02초 | 721자 | 47.4% | 2개 | 빠르지만 초반 로마자식 한국어가 많음 |
| Cohere current | loudnorm, noise gate off, 90초 | 0.99초 | 767자 | 54.3% | 3개 | Cohere 조건 중 가장 낫지만 충분하지 않음 |
| Cohere current | loudnorm, noise gate on, 90초 | 1.07초 | 796자 | 45.8% | 3개 | noise gate가 이 샘플에서는 악화 요인 |
| faster-whisper-large-v3 | CPU int8, beam size 1, 90초 | 213.86초 | 963자 | 99.7% | 38개 | 품질은 안정적이나 CPU 처리 속도가 느림 |
| Qwen3-ASR-1.7B | CPU float32, batch 1, 90초 | 123.64초 | 610자 | 99.6% | 1개 | 품질과 속도 균형 후보. timestamp 연결은 별도 작업 필요 |
| Qwen3-ASR-1.7B + ForcedAligner | CPU float32, batch 1, 30초 | 58.07초 | 226자 | 98.8% | 75개 | timestamp 생성 확인. 문장 단위 병합 필요 |

## 모델별 결과

### Cohere Transcribe 현재 앱 모델

모델 위치:

- `Smart Minutes AI/models`

테스트 파일:

- `backend/temp/api_quality_test/cohere_no_processing_compare_tv_90s.json`
- `backend/temp/asr_benchmark/cohere_raw_no_preprocess_90s.json`

조건별 결과:

| 조건 | 처리 내용 | 글자 수 | 한글 비율 | 판단 |
| --- | --- | ---: | ---: | --- |
| `raw_no_preprocess` | 기본 WAV 변환만 수행 | 721자 | 47.4% | 초반 로마자식 한국어가 매우 많음 |
| `off_convert_only` | 전처리 off 변환 | 721자 | 47.4% | raw와 동일 |
| `auto_no_gate` | loudnorm, noise gate 없음 | 767자 | 54.3% | 가장 낫지만 초반 로마자식 오인식이 남음 |
| `noise_gate_on` | loudnorm + noise gate | 796자 | 45.8% | 오히려 나쁨 |

관찰:

- 전처리를 완전히 빼도 `standing toron`, `hubo`, `tasopunel` 같은 로마자식 한국어가 남는다.
- `noise_gate_on`은 이 샘플에서 악화 요인이므로 기본값에서 제외하는 판단이 맞다.
- `auto_no_gate`는 raw보다 낫지만, 모델 자체의 초반/저음량/방송 오프닝 취약성을 해결하지 못했다.

판정:

- 속도는 빠르지만 현재 품질 기준으로는 기본 모델 후보에서 제외한다.
- 당장 유지한다면 품질 경고와 대체 모델 선택 UI가 필요하다.

### faster-whisper-large-v3

모델 위치:

- `backend/models/stt/faster-whisper-large-v3`

테스트 환경:

- 전용 가상환경: `backend/.venv-asr-faster-whisper`
- 실행 조건: CPU, int8, beam size 1

테스트 파일:

- `backend/temp/asr_benchmark/faster_whisper_large_v3_30s_cpu_int8.json`
- `backend/temp/asr_benchmark/faster_whisper_large_v3_90s_cpu_int8.json`

결과:

| 길이 | 처리 시간 | 전사 글자 수 | 한글 비율 | 세그먼트 |
| ---: | ---: | ---: | ---: | ---: |
| 30초 | 15.45초 | 221자 | 98.8% | 8개 |
| 90초 | 213.86초 | 963자 | 99.7% | 38개 |

관찰:

- Cohere에서 보이던 로마자식 한국어 오인식이 거의 사라졌다.
- timestamp segment가 바로 나와 화자 정렬과 연결하기 쉽다.
- 다만 90초 처리에 213.86초가 걸려 CPU에서는 긴 파일 기본값으로 쓰기 어렵다.
- 90초 후반에는 일부 반복 문장이 보였으므로 긴 파일과 여러 샘플에서 추가 확인이 필요하다.

판정:

- 품질 우선 후보로는 강력하다.
- CPU 기본 모델로 쓰려면 속도 개선, 더 작은 모델, GPU, 병렬 처리, chunk 전략 검토가 필요하다.

### Qwen3-ASR-1.7B

모델 위치:

- `backend/models/stt/Qwen3-ASR-1.7B`

보조 모델 위치:

- `backend/models/stt/Qwen3-ForcedAligner-0.6B`

테스트 환경:

- 전용 가상환경: `backend/.venv-asr-qwen3`
- `qwen-asr`: `0.0.6`
- 실행 조건: CPU, `dtype=float32`, `device_map=cpu`, `max_inference_batch_size=1`
- 현재 PC에서는 CUDA가 감지되지 않아 공식 예시의 `bfloat16`/GPU 조건이 아니라 CPU 조건으로 테스트했다.

테스트 파일:

- `backend/temp/asr_benchmark/qwen3_asr_30s_cpu.json`
- `backend/temp/asr_benchmark/qwen3_asr_90s_cpu.json`
- `backend/temp/asr_benchmark/qwen3_asr_aligner_30s_cpu.json`

결과:

| 조건 | 길이 | 처리 시간 | 전사 글자 수 | 한글 비율 | 세그먼트 |
| --- | ---: | ---: | ---: | ---: | ---: |
| Qwen3-ASR-1.7B | 30초 | 51.16초 | 226자 | 98.8% | 1개 |
| Qwen3-ASR-1.7B | 90초 | 123.64초 | 610자 | 99.6% | 1개 |
| Qwen3-ASR-1.7B + ForcedAligner | 30초 | 58.07초 | 226자 | 98.8% | 75개 |

관찰:

- Cohere의 후반부 로마자식 한국어 붕괴가 재현되지 않았다.
- CPU 90초 실행은 faster-whisper CPU int8보다 빨랐다.
- 기본 Qwen3-ASR 결과는 전체 텍스트 1개 세그먼트라 화자 정렬에 바로 쓰기 어렵다.
- ForcedAligner를 붙이면 timestamp가 생성되지만, 단어/짧은 단위라 회의록용 문장 단위 병합 로직이 필요하다.

판정:

- 품질과 속도 균형 기준으로 가장 유력한 후보.
- 제품 통합 전 필수 작업은 `Qwen3-ASR + ForcedAligner + 문장 병합 + 화자 정렬` 흐름이다.

## 현재 결론

1. Cohere는 전처리 제거만으로 품질 문제가 해결되지 않는다.
2. `noise_gate`는 이 샘플에서 악화 요인이므로 기본값에서 제외한다.
3. faster-whisper는 품질과 timestamp 구조가 좋지만 CPU 속도가 느리다.
4. Qwen3-ASR은 품질과 처리 시간 균형이 좋지만 ForcedAligner와 문장 병합 작업이 필요하다.
5. 포터블 앱은 모델별 폴더 구조를 명시적으로 분리해야 한다.

## 전처리 효과 추가 비교

요청에 따라 Cohere 외의 두 후보 모델에도 같은 전처리 조건을 적용해 비교했다.

결과 파일:

- `backend/temp/asr_benchmark/preprocessing_effect_fw_qwen_20260507.json`

공통 조건:

- 원본: `Smart Minutes AI/backend/temp/20260506_072159_upload.mp4`
- 비교 구간: 파일 앞 30초
- 비교 조건:
  - `raw_no_preprocess`: 원본에서 16kHz mono WAV만 추출
  - `off_convert_only`: 전처리 off 변환
  - `auto_no_gate`: loudnorm, noise gate 없음
  - `noise_gate_on`: loudnorm + noise gate

### faster-whisper-large-v3 전처리 효과

실행 조건:

- 모델: `backend/models/stt/faster-whisper-large-v3`
- 런타임: CPU int8, beam size 1, VAD on

| 조건 | 입력 평균 음량 | 처리 시간 | 글자 수 | 한글 비율 | 세그먼트 | 판단 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `raw_no_preprocess` | -27.5 dB | 10.15초 | 221자 | 98.8% | 8개 | 안정적 |
| `off_convert_only` | -27.5 dB | 9.78초 | 221자 | 98.8% | 8개 | raw와 동일 |
| `auto_no_gate` | -17.2 dB | 9.81초 | 224자 | 98.8% | 8개 | 의미 있는 변화 없음 |
| `noise_gate_on` | -20.1 dB | 9.99초 | 221자 | 98.8% | 8개 | 의미 있는 변화 없음 |

판단:

- 이 샘플에서는 전처리 효과가 거의 없다.
- raw 상태에서도 한국어 전사가 안정적이다.
- faster-whisper는 전처리보다 모델 자체가 Cohere보다 안정적으로 보인다.

### Qwen3-ASR-1.7B 전처리 효과

실행 조건:

- 모델: `backend/models/stt/Qwen3-ASR-1.7B`
- 런타임: CPU, `dtype=float32`, `device_map=cpu`, `max_inference_batch_size=1`

| 조건 | 입력 평균 음량 | 처리 시간 | 글자 수 | 한글 비율 | 세그먼트 | 판단 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| `raw_no_preprocess` | -27.5 dB | 67.52초 | 226자 | 98.8% | 1개 | 안정적 |
| `off_convert_only` | -27.5 dB | 45.80초 | 226자 | 98.8% | 1개 | raw와 텍스트 동일 |
| `auto_no_gate` | -17.2 dB | 43.77초 | 226자 | 98.8% | 1개 | 텍스트 동일 |
| `noise_gate_on` | -20.1 dB | 43.34초 | 226자 | 98.8% | 1개 | 텍스트 동일 |

판단:

- 이 샘플에서는 전처리 유무와 관계없이 Qwen3-ASR 전사 결과가 동일하다.
- Qwen3-ASR도 전처리보다 모델 선택 효과가 더 크다.
- Qwen3-ASR 기본 출력은 여전히 1개 텍스트 세그먼트라, 제품 통합에는 ForcedAligner와 문장 병합이 필요하다.

### 전처리 비교 결론

| 모델 | 전처리 영향 | 기본 방향 |
| --- | --- | --- |
| Cohere | 큼. `auto_no_gate`는 약간 개선, `noise_gate_on`은 악화 | Cohere 유지 시 noise gate는 끄고 품질 경고 필요 |
| faster-whisper-large-v3 | 거의 없음 | 전처리보다 속도/배포 최적화가 핵심 |
| Qwen3-ASR-1.7B | 거의 없음 | 전처리보다 ForcedAligner/문장 병합이 핵심 |

따라서 현재 품질 문제의 핵심은 전처리 튜닝보다 STT 모델 선택이다. 전처리는 기본적으로 보수적으로 유지하고, `noise_gate`는 선택 옵션으로 남긴다.

## 포터블 모델 폴더 제안

```text
models/
  stt/
    cohere-transcribe-03-2026/
    faster-whisper-large-v3/
    Qwen3-ASR-1.7B/
  aligner/
    Qwen3-ForcedAligner-0.6B/
```

현재 테스트용 Qwen3-ForcedAligner는 `backend/models/stt/Qwen3-ForcedAligner-0.6B`에 받았지만, 포터블 앱 통합 시에는 `models/aligner/Qwen3-ForcedAligner-0.6B`로 분리하는 편이 낫다.

## 다음 작업

1. Qwen3-ASR + ForcedAligner 결과를 문장 단위 segment로 병합하는 순수 함수 작성.
2. 병합 segment를 기존 화자 분리 결과와 연결하는 테스트 작성.
3. 포터블 앱 설정에서 STT 모델을 선택할 수 있게 구조화.
4. 동일 샘플 3개 이상으로 Qwen3-ASR과 faster-whisper를 재비교.
5. GPU 환경이 있으면 Qwen3-ASR `bfloat16`/vLLM 조건을 별도 비교.
