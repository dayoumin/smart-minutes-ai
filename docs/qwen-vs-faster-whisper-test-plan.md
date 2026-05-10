# Qwen3-ASR vs faster-whisper 테스트 계획

작성일: 2026-05-07

## 목적

포터블 데스크톱 앱의 기본 STT 모델 후보를 `Qwen3-ASR-1.7B`와 `faster-whisper-large-v3` 중에서 결정하기 위한 테스트 계획이다.

현재 판단:

- Cohere는 같은 샘플에서 로마자식 한국어 오인식이 많아 기본 후보에서 제외한다.
- Qwen3-ASR은 품질과 속도 균형이 좋지만 기본 출력이 긴 텍스트 1개라 timestamp 정렬 작업이 필요하다.
- faster-whisper는 timestamp segment가 바로 나오지만 CPU 처리 속도가 느리다.

## 왜 Qwen3-ASR에는 ForcedAligner와 문장 병합이 필요한가

faster-whisper는 전사 결과를 다음 형태로 바로 제공한다.

```json
[
  {"start": 3.12, "end": 6.72, "text": "5개의 정당 대선 후보가 TV 스탠딩 토론을 마쳤습니다."},
  {"start": 6.88, "end": 10.92, "text": "우리나라 대선에서 처음으로 진행된 스탠딩 토론이었는데 어떻게 보셨습니까?"}
]
```

이 구조는 기존 화자 분리 결과와 시간 구간으로 바로 맞출 수 있다.

Qwen3-ASR 기본 출력은 현재 테스트에서 다음처럼 전체 텍스트 1개 segment로 나왔다.

```json
[
  {"start": 0.0, "end": 0.0, "text": "다섯 개 정당 대선 후보가 TV 스탠딩 토론을 마쳤습니다. ..."}
]
```

이 상태에서는 화자 분리 결과와 결합할 수 없다. 예를 들어 90초 동안 5명이 말했는데 STT segment가 1개면, 어떤 문장이 어느 화자에게 속하는지 시간 기준으로 나눌 수 없다.

Qwen3-ForcedAligner를 붙이면 timestamp는 나온다. 다만 현재 30초 테스트에서는 75개 segment가 생성됐고, 대부분 단어 또는 짧은 단위였다.

```json
[
  {"start": 3.44, "end": 3.68, "text": "다섯"},
  {"start": 3.68, "end": 3.92, "text": "개"},
  {"start": 3.92, "end": 4.16, "text": "정당"}
]
```

이 구조는 너무 잘게 쪼개져 있어 발화 기록과 회의록 UI에는 그대로 쓰기 어렵다. 따라서 단어 단위 timestamp를 문장 또는 발화 단위로 병합해야 한다.

## Qwen 문장 병합 작업 난이도

난이도는 중간이다. 모델 자체를 바꾸는 작업은 아니고 후처리 로직이다.

필요한 작업:

1. ForcedAligner의 단어/짧은 segment를 입력으로 받는다.
2. 문장 부호, 시간 간격, 최대 글자 수, 최대 길이를 기준으로 병합한다.
3. 병합 segment의 `start`는 첫 단어 시작, `end`는 마지막 단어 끝으로 잡는다.
4. 너무 긴 문장은 15~25초 또는 120~180자 기준으로 다시 나눈다.
5. 병합 결과를 기존 `align_segments_with_speakers()`에 넣어 화자 분리 결과와 맞춘다.

예상 구현 단위:

- 순수 함수: `merge_aligner_segments_to_utterances(segments, options)`
- 입력: `[{start, end, text}]`
- 출력: `[{start, end, text, timing_approximate: false}]`
- 테스트: Node나 Python 단위 테스트로 상태 전이 검증

이 작업은 Qwen vs faster-whisper 비교 전에 최소 버전이 필요하다. 그래야 두 모델을 같은 기준으로 비교할 수 있다.

## faster-whisper와 Whisper의 차이

`faster-whisper`는 Whisper 모델을 CTranslate2 런타임으로 더 빠르고 가볍게 실행하기 위한 구현이다. “faster가 없는 Whisper”는 보통 OpenAI Whisper 원본 PyTorch 구현을 말한다.

현재 로컬 모델 크기:

| 모델 폴더 | 크기 |
| --- | ---: |
| `cohere-transcribe-03-2026` | 3.85 GB |
| `faster-whisper-large-v3` | 2.88 GB |
| `Qwen3-ASR-1.7B` | 4.38 GB |
| `Qwen3-ForcedAligner-0.6B` | 1.71 GB |

판단:

- faster-whisper가 원본 Whisper보다 용량이 커서 쓰는 것은 아니다.
- 같은 large-v3 계열이라면 모델 크기는 대략 비슷하거나 faster-whisper 쪽이 더 작을 수 있다.
- faster-whisper를 쓰는 이유는 배포와 추론 효율, CPU int8 같은 실행 옵션, segment/timestamp 사용 편의성 때문이다.
- 원본 Whisper를 별도 후보로 넣을 수는 있지만, 현재 의사결정에는 우선순위가 낮다.

## 테스트 전 선행 작업

Qwen3-ASR을 공정하게 비교하려면 최소 문장 병합 구현이 필요하다.

2026-05-07 준비 상태:

- `backend/pipeline/qwen_segments.py`에 `merge_aligner_segments_to_utterances()` 초안을 추가했다.
- `scripts/run_asr_benchmark.py`의 Qwen aligner 경로에서 `merge_aligner_segments=true`일 때 병합 결과를 저장하도록 연결했다.
- 단위 테스트: `tests/test_qwen_segments.py`
- 실제 Qwen aligner 30초 결과:
  - 원본 aligner segment: 75개
  - 병합 후 발화 segment: 6개
  - 결과 JSON: `backend/temp/asr_benchmark/qwen3_asr_aligner_30s_merged_cpu.json`
  - 주의: Qwen aligner 출력은 단어/형태소처럼 쪼개진 텍스트가 있어, 띄어쓰기/문장 복원 품질은 추가 확인이 필요하다.

2026-05-07 1차 구조 검증:

- 같은 TV 토론 샘플 앞 90초로 `faster-whisper-large-v3`와 `Qwen3-ASR + ForcedAligner + 병합`을 비교했다.
- faster-whisper 결과 파일: `backend/temp/asr_benchmark/faster_whisper_large_v3_90s_cpu_int8.json`
- Qwen 병합 결과 파일: `backend/temp/asr_benchmark/qwen3_aligner_90s_merged_compare.json`

| 후보 | 처리 시간 | 글자 수 | 한글 비율 | segment 수 | 관찰 |
| --- | ---: | ---: | ---: | ---: | --- |
| faster-whisper-large-v3 | 213.86초 | 963자 | 99.7% | 38개 | segment 경계는 자연스럽지만 90초 후반 반복 문장 발생 |
| Qwen3-ASR + ForcedAligner + 병합 | 263.10초 | 610자 | 99.6% | 19개 | 반복 붕괴는 없지만 `후보 가`, `마쳤 습니다`처럼 단어/형태소 분리 텍스트가 보임 |

판단:

- Qwen 병합은 화자 정렬에 필요한 시간 구간을 만들 수 있다는 점을 확인했다.
- 다만 ForcedAligner segment의 `text`를 그대로 이어붙이면 발화 기록 UI 품질이 낮다.
- Qwen의 최종 후보 가능성을 보려면, timestamp는 aligner에서 가져오되 텍스트는 Qwen 전체 전사 원문을 기준으로 복원하는 방식이 필요할 수 있다.
- faster-whisper는 읽기 좋은 segment를 바로 제공하지만, 긴 구간에서 반복 문장 리스크와 CPU 속도 리스크가 있다.

2026-05-07 2차 구조 검증:

- Qwen 병합 로직을 수정해 timestamp 그룹은 ForcedAligner에서 가져오고, 표시 텍스트는 Qwen 전체 전사 원문에서 복원하도록 했다.
- 결과 파일: `backend/temp/asr_benchmark/qwen3_aligner_90s_restored_compare.json`

| 후보 | 처리 시간 | 글자 수 | 한글 비율 | segment 수 | 관찰 |
| --- | ---: | ---: | ---: | ---: | --- |
| Qwen3-ASR + ForcedAligner + 원문 복원 병합 | 209.38초 | 610자 | 99.6% | 19개 | `마쳤 습니다` 같은 형태소 분리 표시는 사라짐. 시간 구간 때문에 문장이 중간에서 끊기는 segment는 남음 |

판단:

- Qwen segment를 발화 기록에 보여줄 최소 조건은 상당히 개선됐다.
- 화자 정렬에는 19개 segment가 이전 1개 segment보다 훨씬 유리하다.
- UI 표시용 발화 기록에서는 문장 중간 끊김이 어색할 수 있으므로, 내부 정렬 segment와 사용자 표시 segment를 분리할지 검토한다.

2026-05-07 3차 구조 검증:

- 벤치마크 결과에 `display_segments`를 별도로 저장하도록 했다.
- `segments`: 화자 정렬과 내부 처리용. ForcedAligner 시간 그룹을 기준으로 한다.
- `display_segments`: 사용자 발화 기록 표시용. Qwen 전체 전사 원문을 문장 단위로 나누고 시간은 근사로 배분한다.
- 30초 결과 파일: `backend/temp/asr_benchmark/qwen3_aligner_30s_display_compare.json`
- 90초 결과 파일: `backend/temp/asr_benchmark/qwen3_aligner_90s_display_compare.json`

| 길이 | 처리 시간 | 내부 segment | 표시 segment | 관찰 |
| ---: | ---: | ---: | ---: | --- |
| 30초 | 126.47초 | 6개 | 6개 | 표시 문장이 자연스럽게 복원됨 |
| 90초 | 306.30초 | 19개 | 15개 | 표시 문장은 자연스럽지만 90초 구간 끝에서 원문이 미완으로 끊김 |

판단:

- Qwen 통합 시 `segments` 하나만 쓰기보다 내부 정렬용과 사용자 표시용을 분리하는 구조가 더 적합하다.
- 회의록 요약과 화자 정렬은 내부 segment를 사용하고, 발화 기록 UI는 `display_segments`를 우선 보여주는 방향을 검토한다.
- 다만 `display_segments`의 시간은 근사값이므로, 정확한 화자 attribution에는 쓰지 않는다.

2026-05-07 4차 구조 검증:

- Qwen 내부 segment를 pyannote 화자 분리 결과와 실제로 정렬했다.
- 결과 파일: `backend/temp/asr_benchmark/qwen3_aligner_90s_speaker_alignment_compare.json`

| 항목 | 결과 |
| --- | ---: |
| diarization + alignment 처리 시간 | 18.76초 |
| diarization speaker 수 | 2명 |
| diarization raw segment 수 | 22개 |
| Qwen 내부 segment 수 | 19개 |
| 표시용 display segment 수 | 15개 |
| aligned segment 수 | 19개 |

관찰:

- 진행자 도입 구간은 대체로 `SPEAKER_00`, 후보 측 발언 구간은 대체로 `SPEAKER_01`로 분리됐다.
- Qwen 내부 segment는 화자 정렬에 사용할 수 있는 시간 구조를 제공한다.
- 75~82초처럼 진행자가 짧게 끼어드는 구간에서는 한 segment 안에 앞 발언자 문장과 다음 진행자 문장이 섞일 수 있다.
- 이 문제는 Qwen만의 문제라기보다 segment가 화자 전환보다 길 때 생기는 일반적인 정렬 문제다.

판단:

- Qwen 통합 방향은 가능하다.
- 다음 개선은 "화자 전환 지점 근처에서 내부 segment를 더 잘게 나누기" 또는 "정렬 후 speaker overlap 기준으로 segment를 재분할하기"다.
- 사용자 UI에는 `display_segments`를 보여주되, 화자별 정리와 요약에는 speaker-aligned 내부 segment를 쓰는 구조가 적합하다.

2026-05-07 5차 구조 검증:

- Qwen 내부 segment에 `split_on_speaker_change` 플래그를 추가했다.
- `align_segments_with_speakers()`가 이 플래그를 보면 speaker overlap이 2개 이상인 segment를 재분할하도록 했다.
- 단위 테스트: `tests/test_align_speakers.py`
- 결과 파일: `backend/temp/asr_benchmark/qwen3_aligner_90s_speaker_alignment_split_compare.json`

검증 결과:

- 이번 90초 샘플에서는 Qwen 내부 segment가 이미 5초 안팎으로 나뉘어 있어 추가 재분할은 거의 발생하지 않았다.
- `75.84-80.00` 구간의 `토론이었다 생각합니다. 알겠습니다. 다음은 자유한국당`처럼 텍스트 배분상 두 발화가 섞인 사례는 남았다.
- 이 문제는 speaker overlap 재분할만으로는 해결되지 않는다. 전체 전사 원문을 시간 그룹에 분배할 때 speaker boundary도 같이 고려해야 한다.

다음 판단:

- 지금 구조는 1차 테스트에는 충분하다.
- 더 정밀하게 하려면 `transcript_text -> timing groups` 분배 단계에서 speaker boundary를 입력으로 받아 문장을 speaker 구간에 맞춰 나누는 알고리즘이 필요하다.
- 이 작업은 실제 회의 샘플에서 같은 문제가 반복될 때 우선순위를 올린다.

2026-05-07 6차 구조 검증:

- 추가 샘플: `Smart Minutes AI/video/test (4).mp4`
- 길이: 약 6분 5초
- 비교 구간: 앞 90초
- Qwen 결과 파일: `backend/temp/asr_benchmark/qwen3_test4_90s_display_compare.json`
- Qwen 화자 정렬 파일: `backend/temp/asr_benchmark/qwen3_test4_90s_speaker_alignment_compare.json`
- faster-whisper 결과 파일: `backend/temp/asr_benchmark/faster_whisper_test4_90s_compare.json`
- faster-whisper 화자 정렬 파일: `backend/temp/asr_benchmark/faster_whisper_test4_90s_speaker_alignment_compare.json`

| 후보 | 처리 시간 | 한글 비율 | 내부 segment | 표시 segment | 화자 수 | 관찰 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Qwen3-ASR + ForcedAligner | 224.76초 | 100.0% | 17개 | 36개 | 3명 | 전사 품질은 좋지만 내부 segment가 길어 여러 문장이 한 덩어리로 묶임 |
| faster-whisper-large-v3 | 62.56초 | 99.2% | 38개 | 없음 | 3명 | 훨씬 빠르고 발화 단위가 자연스러움 |

관찰:

- 이 샘플에서는 faster-whisper가 Qwen보다 훨씬 빠르고 발화 경계도 더 촘촘했다.
- Qwen은 표시용 문장은 자연스럽지만, 내부 정렬용 segment가 길어 화자별 발화로 쓰기에는 다소 뭉친다.
- 화자 분리는 3명으로 잡혔고, faster-whisper segment는 speaker boundary와 더 잘 맞았다.
- Qwen은 실제 회의/대화 샘플에서 `merge_max_seconds`를 더 낮추거나 speaker boundary 기반 분배가 필요할 수 있다.

임시 판단:

- Qwen은 품질 후보로 계속 유지한다.
- 다만 현재 CPU 환경과 이 샘플 기준으로는 faster-whisper가 기본 후보로 더 실용적이다.
- 다음 실제 샘플 1~2개에서도 faster-whisper가 같은 경향이면, Qwen은 품질 우선/실험 후보로 두고 faster-whisper를 우선 통합하는 방향을 검토한다.

2026-05-07 7차 구조 검증:

- 추가 샘플: `Smart Minutes AI/video/test (1).mp4`
- 길이: 약 8분 5초
- 비교 구간: 앞 90초
- Qwen 결과 파일: `backend/temp/asr_benchmark/qwen3_test1_90s_display_compare.json`
- faster-whisper 결과 파일: `backend/temp/asr_benchmark/faster_whisper_test1_90s_compare.json`
- 공통 화자 정렬 비교 파일: `backend/temp/asr_benchmark/test1_90s_qwen_faster_speaker_alignment_compare.json`

| 후보 | 처리 시간 | 한글 비율 | 내부 segment | 표시 segment | 화자 수 | 관찰 |
| --- | ---: | ---: | ---: | ---: | ---: | --- |
| Qwen3-ASR + ForcedAligner | 276.10초 | 99.8% | 23개 | 47개 | 4명 | 전사 품질은 좋지만 여러 짧은 발화가 한 segment에 묶임 |
| faster-whisper-large-v3 | 70초대 | 99%대 | 41개 | 없음 | 4명 | 더 빠르고 발화 단위가 촘촘함 |

관찰:

- `test (4).mp4`에 이어 `test (1).mp4`에서도 faster-whisper가 CPU에서 더 빠르고 발화 경계가 자연스럽다.
- Qwen은 표시용 문장 수는 많지만 내부 정렬 segment가 상대적으로 길다.
- 실제 대화처럼 짧은 대사가 빠르게 오가는 샘플에서는 faster-whisper segment가 화자 분리와 더 잘 맞는다.

임시 판단:

- 현재 CPU 기준 기본 후보는 faster-whisper 쪽으로 기운다.
- Qwen은 GPU/vLLM 환경 또는 더 정교한 speaker-boundary 기반 문장 분배가 준비될 때 다시 우선순위를 올린다.

### 1단계: Qwen segment 병합

목표:

- ForcedAligner word segment를 회의록에 적합한 문장/발화 segment로 바꾼다.

병합 규칙 초안:

| 규칙 | 기준 |
| --- | --- |
| 문장 부호 | `.`, `?`, `!`, `。`, `？`, `！` 뒤에서 우선 분리 |
| 시간 간격 | 이전 단어와 다음 단어 사이가 0.8초 이상이면 분리 후보 |
| 최대 길이 | 90자 이상이면 강제 분리 |
| 최대 시간 | 8초 이상이면 강제 분리 |
| 최소 길이 | 너무 짧은 조각은 다음 segment와 병합 |

검증:

- 30초 샘플에서 75개 word segment가 6~10개 발화 segment로 줄어드는지 확인한다.
- 병합 후 텍스트가 원문과 같은 순서를 유지하는지 확인한다.
- 병합 segment의 시간이 원본 단어 범위를 벗어나지 않는지 확인한다.

### 2단계: 화자 정렬 연결

목표:

- 병합된 Qwen segment를 기존 화자 분리 결과와 시간 overlap으로 연결한다.

확인 항목:

- 실제 화자 수와 diarization speaker 수 차이
- 한 사람 발언이 여러 사람으로 쪼개지는지
- 발언자 전환 구간에서 텍스트가 섞이는지
- 짧은 맞장구가 누락되거나 잘못 붙는지

## 테스트 샘플셋

최소 5개 샘플을 고정한다.

| 샘플 유형 | 길이 | 목적 |
| --- | ---: | --- |
| 깨끗한 1인 발화 | 3~5분 | 기본 STT 정확도 기준 |
| 실제 회의실 다화자 | 10~20분 | 최종 사용 환경 검증 |
| 작은 목소리/먼 거리 녹음 | 5~10분 | 저음량 내성 확인 |
| 겹침 발화/맞장구 많은 회의 | 5~10분 | 화자 분리와 문장 경계 확인 |
| 긴 파일 | 30분 이상 | 속도, 메모리, 안정성 확인 |

가능하면 다음 두 파일을 반드시 포함한다.

- 예전에는 괜찮았다고 느낀 파일
- 최근 품질 저하를 느낀 파일

## 비교 매트릭스

각 샘플마다 아래 조합을 실행한다.

| 후보 | 실행 조건 | 비고 |
| --- | --- | --- |
| faster-whisper-large-v3 | CPU int8, beam size 1, VAD on | 현재 동작 확인 완료 |
| Qwen3-ASR-1.7B + ForcedAligner | CPU float32, batch 1 | 문장 병합 후 비교 |

GPU 장비가 있으면 추가한다.

| 후보 | 실행 조건 | 비고 |
| --- | --- | --- |
| Qwen3-ASR-1.7B + ForcedAligner | GPU bfloat16 | 공식 권장 계열 조건 |
| Qwen3-ASR vLLM | GPU/vLLM server | 장기 후보 |

## 평가 항목

### STT 원문 품질

- 한글 비율
- 로마자식 한국어 오인식
- 고유명사 정확도
- 숫자/날짜/기관명 정확도
- 반복 문장 여부
- 누락 여부

### Segment 품질

- 문장 단위가 자연스러운지
- 너무 길거나 짧은 segment가 많은지
- 발언자 전환 지점과 시간이 맞는지
- UI의 발화 기록으로 읽기 좋은지

### 화자 분리 정합성

- 실제 화자 수와 추정 화자 수 차이
- 같은 사람이 여러 speaker로 쪼개지는지
- 다른 사람이 한 speaker로 합쳐지는지
- 짧은 맞장구/끼어들기 처리

### 회의록 생성 품질

- 회의 요약
- 주요 내용 및 결정사항
- 할 일
- 주제별 정리
- 발언자별 맥락 정리

### 성능과 배포

- 처리 시간
- 메모리 사용량
- 임시 파일 용량
- 포터블 앱 모델 폴더 크기
- 다른 PC 복사 후 실행 가능성

## 판정 기준

기본 모델 후보는 아래 조건을 만족해야 한다.

1. 실제 회의 샘플에서 로마자식 한국어 오인식이 거의 없어야 한다.
2. 화자별 발화 기록이 사용자가 읽을 수 있는 문장 단위로 나와야 한다.
3. 30분 파일 처리 시간이 사용자 기대 범위 안에 있어야 한다.
4. 포터블 폴더 복사 방식으로 실행 가능해야 한다.
5. 실패 시 대체 모델 또는 재시도 전략이 있어야 한다.

## 작업 순서

1. Qwen ForcedAligner segment 병합 함수 구현
2. 병합 함수 단위 테스트 작성
3. Qwen 병합 segment와 화자 분리 연결 테스트
4. 샘플셋 5개 고정
5. Qwen vs faster-whisper STT 비교 실행
6. 화자 분리와 회의록 생성까지 end-to-end 비교
7. 기본 모델과 대체 모델 결정

## 현재 임시 결론

- 지금 당장 기본 모델을 바꾸기보다는 Qwen 문장 병합을 먼저 구현하고 비교해야 한다.
- Qwen이 실제 회의 샘플에서도 faster-whisper와 비슷하거나 더 좋으면 Qwen을 기본 후보로 본다.
- faster-whisper는 속도가 느리지만 segment 구조가 안정적이므로 fallback 또는 품질 우선 모드 후보로 유지한다.
