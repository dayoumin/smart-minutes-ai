# 장시간 파일 처리 계획

기준일:

- 2026-05-13

목표:

- 1시간, 2시간 이상 파일에서 "처리 중단 시 처음부터 다시"를 줄인다.
- 이미 끝난 STT 구간은 재사용할 수 있게 만든다.
- 화자 분리 단계의 메모리/시간 리스크를 분리해서 다룬다.
- UI는 실제 파이프라인 상태와 복구 가능 상태를 구분해서 보여준다.
- 2~5시간 회의에서는 전체 대화록을 한 번에 요약 모델에 넣지 않고, 시간대별/주제별 중간 산출물을 만든 뒤 최종 정리로 합친다.

## 1. 현재 구조 요약

현재 `process_audio_pipeline()` 흐름:

1. 입력 파일 -> 단일 WAV 변환
2. WAV -> 장시간 외부 청크 분할 (`processing.long_audio_chunk_seconds`)
3. 각 청크를 STT 실행 후 offset 보정
4. 전체 STT 결과를 한 번에 메모리로 보유
5. 전체 WAV를 pyannote diarization에 한 번에 입력
6. 화자 정렬
7. display segment 생성
8. 요약 생성
9. 마지막에만 결과 JSON/TXT/MD/DOCX/HWPX 저장

핵심 특징:

- STT는 이미 외부 청크 단위 처리다.
- diarization은 아직 전체 WAV 단위 처리다.
- 중간 결과는 최종 성공 시점 전까지 공식 output JSON으로 남지 않는다.
- 취소 시 이미 끝난 STT 청크도 재사용되지 않는다.

## 2. 가장 큰 리스크

### 2-1. STT보다 diarization이 먼저 무너질 수 있음

`backend/pipeline/diarize.py`는 현재 `soundfile.read(..., always_2d=True)`로 전체 WAV를 한 번에 읽는다.

영향:

- 1시간, 2시간, 5시간 파일에서 메모리 피크 증가
- 긴 구간에서 처리 시간 급증
- 실패 시 STT 완료분까지 같이 버려짐

### 2-2. 중간 저장 부재

현재는 최종 성공 전까지 다음이 저장되지 않는다.

- chunk별 STT 산출물
- diarization 전 상태
- resume 기준 checkpoint

영향:

- 80% 지점 실패 시 처음부터 재실행
- 취소 후 재개 불가
- 장시간 파일 디버깅이 어려움

### 2-3. job 상태와 복구 상태가 분리돼 있지 않음

현재 job registry는 cancel event만 관리한다.

부족한 정보:

- 어느 단계까지 완료됐는지
- 어떤 파일이 재사용 가능한지
- resume 가능한 job인지

## 3. 이번 계획의 범위

### 포함

1. STT chunk 결과의 중간 저장
2. STT 완료 후 resume 가능 구조
3. diarization 전/후 checkpoint 분리
4. 장시간 처리용 job state 메타데이터
5. 실패/취소 후 재개 정책

### 이번 1차에서 제외

1. pyannote diarization 자체의 정확도 개선
2. diarization 장문 분할/병합 알고리즘 구현
3. summary 품질 개선
4. UI 전면 개편
5. 멀티프로세스 worker 분산

즉, 1차 목표는 "품질 개선"이 아니라 "다시 시작 비용 축소와 실패 복구 구조 확보"다.

## 4. 설계 원칙

1. 공식 최종 output JSON과 작업 중 checkpoint는 분리한다.
2. chunk 단위 산출물은 append가 아니라 파일 단위 재사용이 가능해야 한다.
3. resume은 "같은 입력 파일 + 같은 설정 fingerprint"에서만 허용한다.
4. 사용자가 설정을 바꾸면 기존 checkpoint를 자동 재사용하지 않는다.
5. diarization은 1차에서 전체 WAV 유지 가능하더라도, 최소한 STT 완료분은 보존해야 한다.
6. checkpoint 파일은 atomic write와 손상 감지 규칙을 가져야 한다.
7. 같은 job에 대한 중복 실행/재개 경합은 명시적으로 거부하거나 승계 규칙을 가져야 한다.

## 4-1. 1차 전제조건

agent 리뷰 기준으로, 아래 항목은 "나중에"가 아니라 1차 범위에 포함한다.

1. 같은 입력/설정의 미완료 job 탐지 방식
2. 취소 시 checkpoint/원본 보존 정책
3. stage heartbeat / liveness 갱신 방식
4. job-scoped path resolver
5. atomic `job_state.json` / chunk json write 규칙
6. input/config fingerprint 기준

이 전제조건 없이 STT chunk checkpoint만 먼저 넣으면 resume보다 정합성 문제가 먼저 생긴다.

## 5. 저장 구조 제안

작업 디렉터리 예시:

```text
backend/temp/jobs/{job_id}/
  job_state.json
  source.wav
  chunks/
    chunk_001.wav
    chunk_002.wav
  stt/
    chunk_001.json
    chunk_002.json
    merged_segments.json
  diarization/
    speaker_segments.json
  transcript/
    aligned_segments.json
    display_segments.json
  summaries/
    time_block_001.json
    time_block_002.json
    topic_seed_sections.json
    final_summary.json
```

`job_state.json` 필수 필드 제안:

- `job_id`
- `source_file`
- `created_at`
- `updated_at`
- `pipeline_version`
- `config_fingerprint`
- `input_fingerprint`
- `stage`
- `chunk_count`
- `completed_chunk_indices`
- `stt_completed`
- `diarization_completed`
- `summary_completed`
- `partial_summary_completed`
- `cancelled`
- `resume_supported`
- `owner_run_id`
- `last_heartbeat_at`
- `cleanup_policy`
- `checkpoint_version`

원자성 규칙:

- 모든 JSON checkpoint는 `*.tmp`에 먼저 쓰고 rename으로 교체한다.
- 읽을 때 JSON decode 실패면 손상 checkpoint로 표시하고 재사용하지 않는다.
- `merged_segments.json`은 chunk json 목록으로 재구성 가능해야 한다.

보존 정책:

- `cancelled`는 기본적으로 checkpoint를 유지한다.
- `completed`는 설정 또는 정리 작업이 돌기 전까지 STT checkpoint를 짧게 유지할 수 있다.
- 최종 산출물과 checkpoint의 TTL은 분리한다.

긴 회의 요약/정리 checkpoint:

- `summaries/time_block_*.json`은 시간대별 부분 요약, 주요 발언, 후보 주제, 결정/할 일을 담는다.
- `summaries/topic_seed_sections.json`은 시간대별 부분 요약을 합쳐 만든 주제 후보 구조다.
- `summaries/final_summary.json`은 최종 전체 요약이며, 가능하면 `topic_seed_sections.json` 또는 최종 `topicSections`와 정합성을 맞춘다.
- 요약 모델 실패 시에도 `stt/merged_segments.json` 또는 `transcript/display_segments.json`은 먼저 사용할 수 있어야 한다.

## 6. 단계별 구현 순서

### 0단계: 경계조건 고정

목표:

- resume 자산이 cleanup으로 즉시 사라지지 않게 함
- 같은 job 경합과 파일 손상 위험을 먼저 줄임

구현:

- job-scoped path resolver 도입
- atomic JSON write/read 유틸 추가
- cleanup 정책을 `failed/cancelled/completed`별로 재정의
- input/config fingerprint 기준 확정
- 같은 입력/설정의 미완료 job 탐지 규칙 추가
- long-running stage heartbeat 필드 추가

완료 기준:

- checkpoint를 저장해도 다음 단계 cleanup과 충돌하지 않음
- 같은 job 재개/중복 실행 규칙이 문서와 코드에서 일치함

### 1단계: STT checkpoint

목표:

- chunk별 STT 결과를 저장
- 취소/실패 후 이미 끝난 chunk는 재사용

구현:

- chunk loop 안에서 `chunk_{n}.json` 저장
- 모든 chunk 완료 시 `merged_segments.json` 저장
- resume 시 이미 있는 chunk 결과는 건너뜀

완료 기준:

- 긴 파일 STT 중간 실패 후 재실행 시 완료된 chunk는 다시 돌지 않음

### 2단계: pipeline state checkpoint

목표:

- 현재 단계와 재개 가능 여부를 명시

구현:

- `job_state.json` 갱신 함수 추가
- `preprocessing`, `stt`, `diarization`, `summary`, `completed`, `failed`, `cancelled` 단계 기록
- 설정/입력 fingerprint 불일치 시 resume 거부

완료 기준:

- job 디렉터리만 봐도 어디까지 끝났는지 판단 가능

### 3단계: diarization 앞 분리

목표:

- diarization 실패가 STT 완료분을 무효화하지 않게 함

구현:

- diarization 실행 전에 `merged_segments.json`을 공식 checkpoint로 저장
- diarization 실패 시 stage를 `stt_completed` 상태로 남김
- 재실행 시 STT 건너뛰고 diarization부터 시작

완료 기준:

- diarization만 실패한 경우 STT 재실행 없음

### 4단계: 사용자 재개 흐름

목표:

- UI/API에서 "다시 분석"과 "이어서 분석"을 구분

구현 후보:

- 동일 job 재개 endpoint
- 또는 analyze 시작 시 자동 resume 탐지

1차 권장:

- 백엔드는 같은 입력/설정의 미완료 job을 탐지한다.
- 프론트는 자동 재개보다 "이어서 분석" 선택을 우선 노출한다.
- 이유: 사용자가 설정을 바꾸고 처음부터 다시 돌리고 싶을 수 있다.

## 7. diarization 장문 분할은 왜 1차에서 미루는가

이 부분은 별도 난제가 있다.

- speaker ID가 chunk 사이에서 바뀔 수 있음
- 인접 chunk 병합 시 동일 화자 재식별이 필요함
- overlap 구간 처리 규칙이 추가로 필요함

따라서 1차에서는:

- diarization을 아직 전체 WAV에 두더라도
- STT 완료분을 보호하고
- diarization만 다시 돌릴 수 있게 만드는 것이 우선이다

그 다음 2차에서:

- diarization window 분할
- speaker relabel merge
- overlap 보정

순으로 간다.

## 8. API / UI 영향 범위

### backend

- `process_audio_pipeline()`
- job-scoped path resolver
- checkpoint state read/write 유틸
- job state 저장/로드 유틸
- resume 판단 유틸
- 취소 후 checkpoint 유지 정책

### frontend

1차에서는 큰 UI 개편보다 아래만 우선:

- "처리 중" / "재개 가능" 상태 구분
- 취소 후 "처음부터 다시"가 아니라 "이어서 분석" 가능 여부 표시

## 9. 테스트 계획

### 단위 테스트

1. job path resolver
2. atomic state write/read
3. 손상된 checkpoint 감지
4. config fingerprint mismatch 시 resume 거부
5. diarization 실패 후 STT 재사용
6. cancelled 상태에서 checkpoint 유지

### 통합 테스트

1. 30분 샘플에서 chunk 일부 완료 후 중단 -> 재실행
2. STT 완료 후 diarization 실패 -> 재실행
3. 설정 변경 후 기존 checkpoint 무시 확인
4. 같은 입력 재업로드 시 기존 미완료 job 탐지 확인
5. stage heartbeat가 stall watchdog와 충돌하지 않는지 확인

### 수동 확인

1. 짧은 샘플에서 기존 결과와 동일성 확인
2. 1시간 이상 파일에서 chunk 재사용 확인
3. 취소 후 재개 UX 확인

## 10. 첫 구현 슬라이스

가장 먼저 할 일:

1. `backend/temp/jobs/{job_id}` 구조와 path resolver 도입
2. atomic `job_state.json` write/read 유틸 도입
3. cleanup 정책과 cancelled 보존 정책 고정
4. input/config fingerprint 기준 확정
5. 그 다음에 STT chunk 결과 저장과 `merged_segments.json` 저장
6. diarization 이전까지의 재개만 먼저 지원

이 슬라이스는 장시간 파일의 가장 큰 불만인 "이미 끝난 음성 인식을 또 처음부터 돌린다"를 먼저 줄인다.

## 11. 1차 제약을 사용자에게 어떻게 설명할지

1차가 끝나도 아래는 즉시 해결되지 않을 수 있다.

- 긴 diarization 단계는 여전히 한 번에 오래 걸릴 수 있음
- diarization 중 취소 즉시 반영은 보장되지 않음
- "이어서 분석"은 먼저 STT 재사용 중심으로 시작됨

따라서 사용자 메시지는 "모든 단계 완전 재개"가 아니라 "이미 끝난 음성 인식은 다시 하지 않음"을 중심으로 설명한다.

## 12. 화자 분리 장시간 대응 계획

화자 분리는 현재 checkpoint/export 작업과 분리해서 진행한다. 첫 목표는 정확도 향상이 아니라 긴 파일에서 메모리와 실패 지점을 측정하고, 실패해도 STT 결과를 회수할 수 있게 하는 것이다.

### 12-1. 구현 전 확인 질문

1. 우선 보장할 길이는 30분, 1시간, 2시간, 5시간 중 어디까지인가?
2. 기준 PC는 CPU 중심인가, GPU를 기본으로 믿을 수 있는가?
3. 화자 분리가 실패해도 STT-only 회의록을 완료로 둘 것인가?
4. `화자00/01` 수준의 근사 라벨이면 충분한가, 긴 회의 전체에서 같은 사람 라벨 안정성이 필요한가?
5. 보존되는 `source.wav`, chunk, STT, diarization checkpoint를 얼마 동안 유지할 것인가?

### 12-2. 먼저 측정할 지표

- diarization-only 시간, 전체 분석 시간
- backend peak memory
- speaker count, speaker switch 빈도, 과분할 여부
- STT segment와 speaker segment의 overlap 품질
- 실패/취소 후 partial transcript와 STT checkpoint 회수 가능 여부
- 보존 파일 용량과 cleanup 영향

### 12-3. 단계별 게이트

1. 5분, 15분, 30분, 60분 순서로 diarization off/on baseline을 측정한다.
2. 첫 실패 길이와 peak memory를 확인하기 전에는 windowed diarization을 구현하지 않는다.

3. 먼저 pyannote에 파일 경로 입력 등 더 낮은 메모리 경로가 가능한지 확인한다.
4. 그 방법이 부족할 때만 10~15분 window와 30~60초 overlap prototype을 만든다.
5. window prototype은 raw speaker label을 저장하고, 짧은 파일에서 whole-file diarization과 비교한 뒤 merge 설계를 진행한다.

### 12-4. window/merge 원칙

- 모든 window 결과는 절대 timestamp를 유지한다.
- overlap 구간은 중복을 제거하되 speech를 지우지 않는 쪽을 우선한다.
- window 내부 label은 `window03:SPEAKER_01`처럼 보존한다.
- 인접 window의 label merge는 overlap 시간 매칭을 1차 기준으로 한다.
- 확신이 낮으면 잘못 합치기보다 새 화자 라벨을 유지한다.
- 최종 global speaker timeline을 만든 뒤 transcript alignment를 한 번 다시 수행한다.

### 12-5. 같이 하지 말 것

- denoise, silence trim, AGC 기본값 변경
- STT 모델/청크 길이 변경
- 요약 프롬프트 개편
- speaker identity naming
- UI 전면 개편

화자 분리의 첫 실행 게이트는 30분 diarization-on baseline이다. 기록해야 할 값은 peak memory, diarization 시간, speaker count, segment count, 실패 시 STT partial 회수 가능 여부다.

## 13. 긴 회의 AI 정리 대응 계획

2~5시간 회의는 STT/화자 분리 안정성만의 문제가 아니다. 요약 모델 입력도 길어지므로 중간 쟁점이 앞/뒤 요약에 밀려 사라질 수 있다.

기본 방향:

- 시간대별 부분 요약을 먼저 만든다.
- 부분 요약마다 주요 주제, 근거 발언, 결정 사항, 할 일, 확인 필요 항목을 구조화한다.
- 부분 요약을 합쳐 주제 후보를 만들고, 그 주제 후보를 기준으로 최종 `topicSections`를 만든다.
- 전체 요약은 최종 `topicSections`와 어긋나지 않게 생성하거나 검증한다.
- 참석자별 정리는 참석자 발언만 모으지 않고, 시간대/주제/앞뒤 발언 맥락을 함께 입력한다.

검증 기준:

- 30분, 1시간, 2시간, 5시간 샘플에서 중간 주제가 누락되지 않는지 확인한다.
- 요약 실패 시에도 대화록과 부분 요약 checkpoint가 남아 다시 실행할 수 있어야 한다.
- 주제별 정리와 전체 요약이 서로 다른 결론을 내지 않아야 한다.
- 참석자별 정리는 "누가 어떤 말을 많이 했는지"가 아니라 "어떤 주제에서 어떤 역할을 했는지"를 설명해야 한다.
