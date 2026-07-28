# 브라우저 WebGPU 화자분리 후속 평가

- 작성일: 2026-07-17
- 관련 문서: `docs/browser-local-web-version-plan.md`
- 상태: 기존 문서의 브라우저 화자분리 제외 판단을 갱신하는 후속 검토

## 결론

pyannote Community-1 계열 화자분리는 브라우저 WebGPU에서 구현 가능하다.
기존 웹 설계 문서의 “전체 파이프라인 이식 사례가 없어 1차 제외” 전제는
더 이상 유효하지 않다.

다만 현재 확인한 직접 구현은 `diarization-js` 0.1.0 알파 버전이므로 바로
제품에 채택하지 않고 한국어·장문·10명 이상 샘플 PoC를 먼저 수행한다.

## Hugging Face gate와 최종 사용자

Community-1 모델 페이지의 동의는 Hugging Face gated 저장소에서 파일을
받는 계정 사용자에게 적용된다. 개발자가 이 조건에 동의해 모델을 받은 뒤
CC BY 4.0 조건에 따라 앱에 포함하거나 자체 저장소에서 재배포한다면,
최종 사용자는 Hugging Face에 접속하지 않으므로 사용자별 HF 동의나
access token이 필요하지 않다.

제품에는 다음을 표시한다.

- pyannote 및 각 모델 구성 요소의 출처
- CC BY 4.0 링크
- ONNX 변환 또는 기타 변경 여부
- 포함된 코드와 모델의 개별 라이선스

이는 공식 라이선스와 공개 gate 문구에 근거한 기술적 해석이며, 기관 전체
배포 전 최종 고지문은 내부 법무 검토를 거친다.

## Bonsai WebGPU 사례

`webml-community/bonsai-webgpu-kernels`는 다음 구조의 실제 사례다.

- 약 3.8GB 모델을 브라우저로 다운로드
- WebGPU의 WGSL compute shader에서 완전 로컬 추론
- HTTP Range 요청과 `Accept-Ranges` 검증
- IndexedDB에 모델 byte range 캐시
- 모델과 대화 데이터가 분석 서버로 전송되지 않음

따라서 “정적 웹 앱이 대형 모델을 사용자 PC에 내려받고 브라우저 GPU에서
실행한다”는 제품 방식이 가능하다는 사례다. 다만 Bonsai 전용 WGSL 커널을
직접 포함한 런타임이므로 pyannote를 자동으로 실행해 주는 범용 도구는
아니다.

## Community-1에 더 직접적인 사례

2026-05-08 공개된 `diarization-js` 0.1.0은 Community-1 파이프라인을
브라우저와 Node에서 실행하도록 옮긴 구현이다.

| 구성 | 브라우저 구현 | 크기 |
|---|---|---:|
| segmentation | pyannote segmentation 3.0 ONNX | 약 6MB |
| speaker embedding | WeSpeaker ResNet34 ONNX | 약 26MB |
| clustering | AHC + VBx/PLDA TypeScript | 약 1MB |
| 추론 런타임 | ONNX Runtime WebGPU/WASM | 별도 |

모델 아티팩트 합계는 약 33.5MB다. 라이브러리는 Hugging Face를 강제하지
않고 같은 파일을 제공하는 자체 URL을 받을 수 있으므로 Cloudflare R2
배포 구조와 맞는다.

패키지 설명은 공식 Python Community-1 결과 대비 7분 녹음 한 건에서
1.73% DER를 보고한다. 이는 변환 일치 가능성을 보여 주지만 제품 품질
검증으로는 부족하다.

주의사항:

- 알파 0.1.0이며 사용·검증 사례가 적다.
- npm 메타데이터는 Apache-2.0, 모델 카드 설명은 코드 MIT로 표기가
  일치하지 않아 원본 저장소의 `LICENSE`를 확인해야 한다.
- Community-1 최신 Python 파이프라인과 결과가 계속 일치하는지 확인해야
  한다.
- 브라우저 WebGPU 미지원 또는 기관 정책상 GPU 비활성 환경을 위해 WASM
  fallback이 필요하다.

## 전체 웹 제품의 병목

화자분리 모델은 약 33.5MB라 웹 배포에 부담이 작다. 전체 웹 제품에서 더
큰 병목은 현재 데스크톱의 `faster-whisper-large-v3`를 대체할 브라우저
STT다.

- Transformers.js와 ONNX Runtime Web은 Whisper WebGPU 실행을 지원한다.
- small급 다국어 모델부터 한국어 품질과 메모리를 검증해야 한다.
- large-v3급 모델을 모든 업무용 PC의 브라우저 기본값으로 두는 것은
  다운로드, GPU 메모리, 초기화 시간 측면에서 위험하다.
- Whisper Worker를 종료하고 GPU 메모리를 해제한 다음 diarization
  Worker를 순차 실행한다.

## 권장 웹 구조

```text
정적 React 웹 앱
    |
    +-- STT Worker
    |     +-- Transformers.js Whisper ONNX
    |     +-- WebGPU / WASM
    |
    +-- Diarization Worker
    |     +-- segmentation ONNX
    |     +-- speaker embedding ONNX
    |     +-- AHC + VBx/PLDA
    |
    +-- IndexedDB / Cache Storage / OPFS
    |
    +-- R2 모델 저장소
```

음성, 대화록, 화자 구간은 기본적으로 브라우저 밖으로 보내지 않는다.
R2에는 공개 모델 파일과 manifest만 둔다.

## PoC 통과 기준

1. 기존 한국어 60초 샘플 2개에서 Python Community-1과 결과 비교
2. 10분·30분 파일 처리 시간과 최대 메모리 측정
3. 10명 이상 한국어 회의에서 화자 수, 병합·분할 오류 측정
4. Chrome·Edge WebGPU와 WASM fallback 확인
5. Whisper와 화자분리 Worker의 순차 GPU 메모리 해제 확인
6. R2 최초 다운로드, 캐시, SHA-256, 오프라인 재실행 확인
7. 외부 네트워크 요청에 음성·대화록 데이터가 포함되지 않는지 확인

## 참고 자료

- Bonsai WebGPU kernels:
  https://huggingface.co/spaces/webml-community/bonsai-webgpu-kernels
- diarization-js:
  https://www.npmjs.com/package/diarization-js
- diarization-js source:
  https://github.com/briox/diarization-js
- Community-1 ONNX artifacts:
  https://huggingface.co/briox/diarization-js-community-1
- ONNX Runtime WebGPU:
  https://onnxruntime.ai/docs/tutorials/web/ep-webgpu.html
- Transformers.js WebGPU:
  https://huggingface.co/docs/transformers.js/guides/webgpu
- pyannote Community-1:
  https://huggingface.co/pyannote/speaker-diarization-community-1
- CC BY 4.0:
  https://creativecommons.org/licenses/by/4.0/
