# 화자분리 모델 평가 및 적용 판단

- 작성일: 2026-07-17
- 적용 대상: 기관 내부에서 사용하는 로컬 음성·회의 분석
- 핵심 요구사항: 한국어, 장문 녹음, 오프라인 실행, 10명 이상 참여 가능

## 결론

현재 요구사항에서는 `faster-whisper + pyannote Community-1`을 주 경로로
유지한다.

NVIDIA Streaming Sortformer v2.1은 최대 4명으로 제한되므로 10명 이상이
참여할 수 있는 회의의 주 화자분리 모델로 사용할 수 없다. 최대 4명이
확실한 통화나 소규모 회의에 한해서만 실험적 보조 경로로 검토한다.

MOSS-Transcribe-Diarize는 짧은 한국어 샘플에서 유망했지만, 테스트한
CrispASR 런타임은 장문 출력이 중간에 잘리므로 현재 제품 경로로 채택하지
않는다.

## 화자 수 요구사항

### pyannote Community-1

- 전체 녹음의 화자 수에 NVIDIA Sortformer와 같은 고정된 4명 상한이 없다.
- 현재 설치된 pyannote 4.0 파이프라인은 화자 수를 지정하지 않으면
  `max_speakers`를 무한대로 두고 VBx 클러스터링으로 전체 화자 수를
  추정한다.
- `num_speakers`, `min_speakers`, `max_speakers`를 입력할 수도 있다.
- 현재 로컬 segmentation 모델은 한 짧은 분석 구간에서 3개의 로컬 화자
  스트림을 출력하지만, 이후 구간별 임베딩을 전역 클러스터링하므로 전체
  녹음의 참가자가 3명으로 제한되는 것은 아니다.
- 따라서 10명 이상 회의도 구조적으로 처리할 수 있다. 다만 참가자가
  많아질수록 음성이 비슷한 사람의 병합, 같은 사람의 분할, 짧은 발화 누락,
  겹침 발화 오류가 늘 수 있으므로 실제 다인 회의 검증이 필요하다.

### NVIDIA Streaming Sortformer v2.1

- 모델 출력 자체가 화자 4개 채널로 고정되어 있다.
- 공식 설명도 최대 4명이며 5명 이상에서 성능이 저하된다고 명시한다.
- 여러 개의 4인 청크로 자르는 것만으로는 10명 회의를 해결할 수 없다.
  청크 사이에서 같은 사람을 재식별하는 별도 전역 임베딩·클러스터링이
  필요하며, 그렇게 하면 pyannote와 유사한 복합 파이프라인이 된다.

## 기관 내부 사용과 배포

### pyannote Community-1

- `pyannote.audio` 코드는 MIT 라이선스다.
- Community-1 모델은 CC BY 4.0이다. 상업적 사용과 재배포도 허용되지만
  모델 출처, 라이선스 링크, 변경 여부를 표시해야 한다.
- 최초 다운로드에는 Hugging Face 개인 계정으로 접근 조건에 동의하고
  연락처를 공유해야 한다. gated 모델 접근 권한은 조직이 아니라 개인
  사용자에게 부여된다.
- 승인 후 모델을 기관 내부 서버나 포터블 패키지에 저장해 인터넷 연결
  없이 로컬로 실행할 수 있다.
- 기관 내부 배포에서도 `THIRD_PARTY_NOTICES`에 모델명, 원본 주소,
  CC BY 4.0 링크, 변경 여부를 포함하는 것을 기본 정책으로 한다.
- 민감한 회의 음성이 외부로 나가지 않도록 로컬 모델 경로만 사용하고
  Hugging Face 또는 pyannoteAI 클라우드 fallback을 사용하지 않는다.
- pyannote의 선택적 익명 텔레메트리는
  `PYANNOTE_METRICS_ENABLED=0`으로 명시적으로 끈다.
- 녹음 파일과 결과 JSON의 접근 권한, 보존 기간, 삭제 정책은 모델
  라이선스와 별도로 기관의 개인정보·보안 규정에 맞춰야 한다.

이 문서는 공식 라이선스와 모델 카드에 근거한 기술 검토이며 법률 자문은
아니다. 기관 전체 배포 전에는 내부 보안·법무 담당자가 고지문과 녹음
보존 정책을 확인한다.

## 2026-07-17 실행 비교

| 모델·구성 | 샘플 | 장치 | 처리 시간 | 결과 |
|---|---|---:|---:|---|
| NVIDIA Sortformer GGUF | 한국어 토론 60초 | RTX 5080 Vulkan | 34.57초 | 원시 화자 4명 |
| NVIDIA Sortformer GGUF | 한국어 토론 60초 | CPU | 26.84초 | GPU 결과와 동일 |
| NVIDIA Sortformer GGUF | 한국어 등장인물 대화 60초 | RTX 5080 Vulkan | 27.63초 | 원시 화자 3명 |
| NVIDIA Sortformer GGUF | 한국어 토론 10분 | CPU | 109.85초 | 102개 구간, 09:59.990까지 처리 |
| MOSS Q4/CrispASR | 한국어 토론 10분 | RTX 5080 Vulkan | 62.47초 | 02:33.820에서 출력 중단 |

Sortformer 원시 결과와 Whisper 대화록을 현재 정렬기로 결합했을 때,
토론 샘플의 원시 화자 4명이 최종 대화록에서 2명으로 합쳐졌다. 짧은
단체 인사와 겹침 발화가 하나의 Whisper 세그먼트에 들어간 것이
원인이다. 향후 다른 화자분리 모델을 붙이더라도 단어 타임스탬프 또는
화자 전환점 기반 세그먼트 재분할이 필요하다.

MOSS 10분 입력은 정확히 1,024개의 출력 토큰을 생성한 뒤 중단됐다.
CrispASR의 MOSS 구현이 `max_new = 1024`를 고정해 CLI 설정을 무시하는
것을 소스에서 확인했다. 같은 원인이 확정되어 30분·60분 단일 패스는
실행하지 않았다.

## 다음 검증

1. 실제 또는 비식별화된 한국어 10~15인 회의 샘플을 고정 테스트셋에
   추가한다.
2. pyannote에 `max_speakers=15`를 주는 경우와 자동 추정하는 경우를
   비교한다.
3. 전체 화자 수 오차, 화자별 병합·분할, 짧은 발화, 겹침 발화, 처리
   시간을 함께 기록한다.
4. 단어 단위 Whisper 정렬을 적용한 뒤 최종 대화록의 화자 정확도를 다시
   비교한다.
5. 10명 이상 조건을 통과하기 전에는 Sortformer나 MOSS로 기본 경로를
   변경하지 않는다.

## 참고 자료

- pyannote Community-1:
  https://huggingface.co/pyannote/speaker-diarization-community-1
- pyannote.audio:
  https://github.com/pyannote/pyannote-audio
- Hugging Face gated 모델:
  https://huggingface.co/docs/hub/models-gated
- CC BY 4.0:
  https://creativecommons.org/licenses/by/4.0/
- NVIDIA Streaming Sortformer v2.1:
  https://huggingface.co/nvidia/diar_streaming_sortformer_4spk-v2.1
- NVIDIA Open Model License:
  https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/
- CrispASR MOSS 구현:
  https://github.com/CrispStrobe/CrispASR/blob/main/src/moss_transcribe_diarize.cpp
