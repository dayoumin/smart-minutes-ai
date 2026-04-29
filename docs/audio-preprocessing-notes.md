# 오디오 전처리 현황 및 다음 작업 메모

이 문서는 현재 저장소의 오디오 전처리 상태를 기록하고, Cohere STT 품질 개선을 위해 다음에 검토할 작업을 정리하기 위한 메모이다.

기준 확인일:

- 2026-04-29
- 마지막 반영: 2026-04-29 normalize 1차 적용, auto normalization 추가

관련 코드:

- [backend/pipeline/audio_preprocess.py](D:/Projects/smart-minutes-ai/backend/pipeline/audio_preprocess.py)
- [backend/pipeline/chunk_audio.py](D:/Projects/smart-minutes-ai/backend/pipeline/chunk_audio.py)
- [backend/pipeline/transcribe.py](D:/Projects/smart-minutes-ai/backend/pipeline/transcribe.py)
- [backend/main.py](D:/Projects/smart-minutes-ai/backend/main.py)

## 1. 현재 구현된 전처리

현재 백엔드 파이프라인에서 명확히 구현된 전처리는 아래와 같다.

1. 입력 음성/영상 파일을 ffmpeg로 16kHz mono WAV로 변환
2. 긴 파일을 시간 기준으로 분할
3. 선택형 볼륨 정규화(normalize)
4. 화자 분리용 diarization은 변환된 WAV를 기준으로 별도 수행

세부 내용:

- `convert_to_wav()`는 채널 수를 mono(`ac=1`)로 맞추고 샘플레이트를 16kHz(`ar=16000`)로 맞춘다.
- `config.json`의 `preprocessing.normalize_audio=true`이면 ffmpeg normalize 필터를 적용할 수 있다.
- `normalization_mode=auto`이면 입력 파일의 `mean_volume`을 먼저 측정한 뒤 `off / loudnorm` 중 하나를 선택한다.
- `dynaudnorm`은 자동 기본 선택이 아니라 수동 실험 모드로 유지한다.
- 현재 파이프라인 결과 JSON의 `settings.preprocessing`에 요청 모드, 실제 선택 모드, 측정된 mean volume이 기록된다.
- 긴 파일은 `split_wav_by_duration()`에서 시간 기준으로 chunk를 나눈다.
- Cohere 경로는 long-form `model.transcribe(..., language="ko")`를 우선 사용한다.
- fallback faster-whisper 경로에는 `vad_filter=True`가 들어가 있어 STT 단계에서 일정 수준의 무음 필터링이 적용된다.

## 2. 현재 없는 전처리

현재 코드에는 아래 처리가 별도 구현되어 있지 않다.

- 노이즈 제거(denoise)
- 무음 제거(silence trimming / silence removal)
- 음성 강화(speech enhancement)
- AGC(automatic gain control)

중요:

- normalize를 제외한 위 기능들은 현재 Cohere 호출부에 옵션으로 붙어 있지 않다.
- 즉, 현재 Cohere STT 품질은 "포맷 변환된 원본 오디오"에 상당 부분 의존한다.
- 전처리가 필요하면 모델 내부가 아니라 파이프라인 앞단에서 구현해야 한다.

## 3. Cohere와 전처리의 역할 경계

현재 저장소 기준으로 역할을 명확히 나누면 아래와 같다.

1. 전처리 파이프라인
   - ffmpeg 변환
   - 필요 시 denoise / normalize / silence trim
   - 긴 파일 chunking

2. STT 모델
   - Cohere Transcribe 또는 fallback faster-whisper
   - 전사 결과 생성

3. 후처리 파이프라인
   - 반복 텍스트 정리
   - 추정 타임세그먼트 생성
   - 화자 구간 정렬
   - 요약 생성

주의:

- faster-whisper의 `vad_filter=True`는 전처리기라기보다 STT 단계 내부 옵션에 가깝다.
- Cohere 경로에는 같은 수준의 무음 제거 옵션이 현재 없다.

## 4. 다음에 검토할 전처리 후보

우선순위는 보수적으로 가져간다. 회의 음성은 자음 손실, 끝음절 탈락, 작은 목소리 왜곡이 생기면 한글 품질이 바로 무너질 수 있기 때문이다.

### 4.1 1차 후보: 볼륨 정규화

가장 먼저 검토할 후보는 볼륨 정규화다.

이유:

- 구현 난이도가 낮다.
- 음량 편차가 큰 회의 녹음에서 안정화 효과를 기대할 수 있다.
- denoise보다 부작용 가능성이 상대적으로 작다.

후보 방식:

- ffmpeg `loudnorm`
- 또는 보수적인 peak/RMS 정규화

원칙:

- 과도한 압축이나 리미팅은 피한다.
- diarization 성능에 악영향이 없는지 같이 본다.

### 4.2 2차 후보: 선택형 무음 제거

다음 후보는 무음 제거다.

이유:

- 회의 시작 전/후 공백, 긴 침묵 구간, 업로드 파일의 불필요한 꼬리 구간을 줄일 수 있다.
- 긴 파일 처리 시간과 저장 공간을 조금 줄일 수 있다.

주의:

- 공격적으로 자르면 발화 시작 자음이 손실될 수 있다.
- diarization alignment와 타임스탬프 계산이 틀어질 수 있다.
- "원본 시간축 유지"가 필요한 경우에는 실제 삭제보다 VAD 기반 구간 선택이 더 안전할 수 있다.

후보 방식:

- ffmpeg `silenceremove`
- 또는 별도 VAD 기반 speech region 추출

### 4.3 3차 후보: 보수적 노이즈 제거

가장 나중에 검토할 후보는 denoise다.

이유:

- 체감상 좋아 보여도 실제 STT 품질을 떨어뜨리는 경우가 흔하다.
- 특히 한국어 회의 음성에서 약한 자음, 받침, 말끝이 손상되기 쉽다.

원칙:

- 기본값으로 강한 denoise를 넣지 않는다.
- noisy 환경 샘플셋으로 전후 비교가 확보되기 전에는 옵션화 수준으로만 검토한다.

## 5. 구현 시 권장 순서

1. `convert_to_wav()` 단계의 auto normalize 선택 기준을 짧은 샘플셋과 긴 회의 샘플셋으로 전후 비교
2. 필요하면 `normalization_mode` 자동 판단 임계값을 조정
3. 결과가 좋을 때만 선택형 silence 처리 추가
4. denoise는 마지막에 별도 실험 브랜치에서 검증

## 6. 설정 항목 제안

현재 `config.json`에는 아래 항목이 반영되어 있다.

```json
{
  "preprocessing": {
    "enabled": true,
    "normalize_audio": true,
    "normalization_mode": "auto",
    "trim_silence": false,
    "denoise": false
  }
}
```

주의:

- 현재는 `enabled`, `normalize_audio`, `normalization_mode`만 실제 코드에서 사용한다.
- `normalization_mode`는 `auto`, `loudnorm`, `dynaudnorm`를 지원한다.
- 현재 `auto`는 `mean_volume <= -18 dB`일 때 `loudnorm`, 그보다 크면 `off`로 동작한다.
- `trim_silence`, `denoise`는 아직 예약 필드다.
- `trim_silence`와 `denoise`는 기본값을 `false`로 두는 편이 안전하다.
- 배포용 기본 설정은 보수적으로 유지하고, 실험 기능은 명시적으로 켜는 구조가 낫다.

## 7. 검증 기준

전처리를 넣을 때는 "소리가 더 깨끗하게 들리는가"보다 아래 기준으로 검증한다.

1. 한국어 고유명사 오인식이 줄어드는가
2. 영어/로마자식 오인식이 줄어드는가
3. 작은 목소리/멀리 있는 화자 전사가 유지되는가
4. 화자 분리 경계가 더 나빠지지 않는가
5. 처리 시간이 과하게 증가하지 않는가
6. long-form Cohere 경로와 fallback whisper 경로 모두에서 부작용이 없는가

권장 비교 산출물:

- 원본 오디오 STT 결과
- 전처리 후 오디오 STT 결과
- 화자 분리 정렬 결과
- 요약 결과 차이

## 8. 함께 관리할 관련 메모

전처리 외에도 아래 항목은 품질과 재현성에 직접 연결되므로 같이 관리한다.

- Cohere 모델 수동 배치 경로 유지
  - `backend/models/stt/cohere-transcribe-03-2026/`
- Hugging Face gated access 절차
- `download_models.py` 실제 다운로드 동작 검증
- ffmpeg 경로 및 portable 배포본 포함 전략
- 샘플 오디오 기반 품질 회귀 테스트 세트

## 9. 현재 판단 요약

2026-04-29 기준 현재 파이프라인은 아래 상태다.

- 있음: WAV 변환, chunking, 선택형 normalize, diarization, STT, 요약
- 일부 있음: faster-whisper fallback 경로의 내부 VAD 필터
- 없음: denoise, silence trim

따라서 Cohere 품질 개선 작업에서 "모델 자체 성능"과 "오디오 전처리 부족"을 구분해서 봐야 한다.
