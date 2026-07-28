# 브라우저 온디바이스 웹 버전 실행 계획

> 상태 변경(2026-07-28): 이 실행안은 후순위 순수 BrowserEngine 후보로 보류한다. 첫 웹 제품은 docs/web-local-engine-followup-plan.md의 사용자 다운로드형 Windows 로컬 엔진 한 경로만 추진하며, 데스크톱 앱 검증 완료 후 착수한다.

- 확정일: 2026-07-17
- 상태: 후순위 보류. 첫 웹 제품은 docs/web-local-engine-followup-plan.md를 따르고, 순수 BrowserEngine은 별도 재결정 전까지 구현하지 않는다.
- 대상: 기존 데스크톱 제품을 유지하면서 같은 React UI로 제공하는 별도 웹 빌드
- 관련 문서:
  - `docs/browser-local-web-version-plan.md`
  - `docs/browser-webgpu-diarization-evaluation.md`
  - `docs/model-download-distribution-evaluation.md`
  - `docs/speaker-diarization-model-evaluation.md`

## 1. 확정 결정

1. 데스크톱 버전은 현재 구조와 배포 방식을 유지한다.
2. 웹 버전은 별도 제품 코드를 복제하지 않고 같은 저장소와 React UI를
   사용한다.
3. 구현 중에는 별도 브랜치와 가능하면 별도 worktree를 사용한다.
4. 검증이 끝나면 main에 병합해 `build:web`과 `build:desktop`을 함께
   유지한다. 장기 웹 전용 브랜치는 두지 않는다.
5. 웹 기본 STT는 다국어 Whisper small q8 ONNX를 WASM CPU로 실행한다.
   WebGPU는 기본 요구사항이 아니라 사용 가능한 PC의 선택적 가속 경로다.
6. 사용자 PC에서 첫 30~60초를 실제 처리해 RTF와 예상 완료 시간을
   계산한다. 큰 모델은 사용자가 선택하기 전에는 다운로드하지 않는다.
7. 음성, 대화록, 요약 입력은 기본적으로 사용자 브라우저 밖으로 보내지
   않는다.
8. 모델은 R2에서 최초 1회 또는 버전 변경 시 다운로드하고 브라우저에
   캐시한다.
9. 화자분리는 Community-1 계열 ONNX WASM CPU PoC를 먼저 통과한 뒤
   선택형으로 제공하고, WebGPU는 보조 가속으로 검증한다.
10. 긴 파일은 30초 작업 창, 5초 겹침, 청크별 checkpoint로 처리한다.
    파일 길이만으로 데스크톱을 강제하지 않고 실제 예상 시간과 품질 요구를
    기준으로 선택을 안내한다.

## 2. 브랜치와 코드베이스 전략

### 구현 브랜치

첫 구현 브랜치는 다음 이름을 사용한다.

`codex/browser-engine-poc`

현재 main 작업 폴더에는 미커밋 문서와 실험 아티팩트가 있으므로 새 브랜치를
만들 때 기존 변경을 무심코 포함하지 않는다. 깨끗한 main 기준 worktree를
만들고, 확정된 계획 문서만 의도적으로 가져오는 방식이 안전하다.

### 병합 후 구조

```text
main
  ├─ 공통 React UI
  ├─ DesktopEngine
  │    └─ 현재 FastAPI / faster-whisper / pyannote / Ollama
  ├─ BrowserEngine
  │    └─ Web Worker / WASM CPU / 선택적 WebGPU / IndexedDB / OPFS
  ├─ build:desktop
  └─ build:web
```

웹과 데스크톱이 서로 다른 장기 브랜치에 남으면 UI 수정, 데이터 구조,
버그 수정이 계속 갈라지므로 허용하지 않는다.

## 3. 모델 선택 정책

### 사용자에게 보이는 선택지

| 표시 이름 | 내부 후보 | 기본 정책 |
|---|---|---|
| 빠른 처리 | Whisper small q8 ONNX | 업무용 CPU PC를 포함한 웹 기본값 |
| 높은 품질 | Whisper medium급 양자화 후보 | 별도 CPU PoC와 실측 진단 통과 후 직접 선택 |
| 최고 품질 | faster-whisper large-v3 | 현재 데스크톱 앱 사용 권장 |

일반 화면에는 모델 ID, ONNX, dtype 같은 구현 용어를 기본 노출하지 않는다.
세부 정보 화면에서만 실제 모델과 다운로드 크기를 제공한다.

### 환경 진단

다음 정보를 조합해 추천한다.

- 브라우저 종류와 버전
- `navigator.hardwareConcurrency`
- `navigator.deviceMemory`가 제공되는 경우의 참고값
- `navigator.storage.estimate()`의 사용 가능 저장공간
- Cross-Origin Isolation과 실제 WASM thread 수
- small 모델로 첫 30~60초를 처리한 RTF
- 선택한 음성 파일 길이와 계산된 예상 완료 시간
- WebGPU adapter/device 생성 성공 여부는 선택적 가속 판단에만 사용

CPU 이름만으로 성능 등급을 단정하지 않는다. `예상 전사 시간 = 음성 길이
× 실측 RTF`로 계산하고 다음 임시 기준을 사용한다.

- RTF 0.75 이하: 웹 사용 권장
- RTF 0.75 초과 1.5 이하: 웹 사용 가능, 예상 시간을 명확히 표시
- RTF 1.5 초과: 웹 실행을 막지는 않지만 데스크톱 앱도 함께 안내

이 임계값은 현재 PoC 기준이며 실제 기관 PC 표본으로 다시 보정한다. medium
추천은 small RTF가 0.5 이하이고 medium 자체 진단도 통과할 때만 검토한다.

### 2026년 업무용 PC 메모리 기준

신규 구매 PC는 16GB를 권장 기준으로 잡되, 기관에 남아 있는 구형 장비를
위해 8GB를 지원 하한으로 검증한다. 32GB는 상위 모델 후보군이다.

| 메모리 | 웹 정책 |
|---|---|
| 8GB | small q8만 제공, STT·화자분리·요약을 반드시 순차 실행, 30초 오디오 작업 창 외 대용량 음성 배열을 유지하지 않음 |
| 16GB | small q8 기본, WASM 최대 4 threads, 일반 권장 환경 |
| 32GB 이상 | small 기본 유지, medium은 별도 실측 통과 후 사용자 선택으로만 제공 |

8GB에서는 이번 PoC의 약 1.15GB 브라우저 working set도 Windows, 보안
프로그램, Office와 함께 사용할 때 압박이 될 수 있다. 따라서 실제 8GB와
16GB 기관 PC에서 브라우저 전체 메모리, swap, 탭 종료 여부를 다시 측정하기
전에는 8GB 지원을 확정 완료로 표시하지 않는다. `navigator.deviceMemory`는
근사값이고 지원 범위도 제한되므로 참고값으로만 사용하고, 모델 초기화와
첫 청크 실제 실행 성공 여부를 최종 기준으로 삼는다.

### 다운로드 정책

- small 모델은 첫 분석 시 다운로드 동의를 받은 뒤 준비한다.
- medium/large 모델은 추천만 하고 사용자가 선택해야 다운로드한다.
- 다운로드 전에 크기, 예상 준비 시간, 로컬 저장공간 사용량을 보여 준다.
- 모델별 버전, 파일 크기, SHA-256을 manifest에 고정한다.
- 중단 재개와 무결성 검증을 지원한다.
- 사용자가 모델 캐시를 확인하고 삭제할 수 있게 한다.

### 2026-07-17 CPU/WASM PoC 결과

- Ryzen 7 9800X3D, Chrome 147, WASM 4 threads에서 60초 한국어 두
  샘플은 각각 23.72초와 16.75초였다.
- 캐시된 small q8 모델 초기화는 8.62초, 브라우저 프로필 사용량은 약
  302.7MB였다.
- 토론 10분은 1분 작업 단위 10개로 227.22초에 완주했고, 관찰 최대
  브라우저 working set은 약 1.15GB였다.
- Chrome CPU 4배 제한에서는 60초가 89.72초와 59.16초였다.
- 60초 바깥 청크의 내부 자동 분할은 후반 발화를 누락했다. 30초 작업 창을
  5초 겹쳐 직접 처리하자 누락 구간이 복구됐으므로 이 방식을 제품 기준으로
  삼는다. 겹침 구간은 타임스탬프와 텍스트 비교로 중복 제거해야 한다.

## 4. 브라우저 실행 구조

```text
[정적 React/PWA]
      |
      +-- Model Manager
      |     +-- R2 manifest
      |     +-- Cache Storage / OPFS
      |
      +-- Audio Worker
      |     +-- 디코딩
      |     +-- 16kHz mono
      |
      +-- STT Worker
      |     +-- Transformers.js Whisper
      |     +-- WebGPU / WASM
      |
      +-- Diarization Worker
      |     +-- segmentation ONNX
      |     +-- speaker embedding ONNX
      |     +-- AHC + VBx/PLDA
      |
      +-- Summary Worker
            +-- WebLLM
```

GPU 메모리 충돌을 줄이기 위해 기본 순서는 다음과 같다.

```text
STT 완료
→ 결과 저장
→ STT 모델 dispose
→ STT Worker 종료
→ 화자분리 실행
→ 화자분리 Worker 종료
→ 사용자가 요청할 때만 요약 모델 로드
```

## 5. 단계별 구현

### 0단계: 기술 PoC

제품 UI를 크게 변경하지 않고 실행 가능성부터 검증한다.

- BrowserEngine 최소 인터페이스
- Whisper small q8 다국어 WASM CPU와 Cross-Origin Isolation 4 threads
- 30초 작업 창, 5초 겹침, 타임스탬프 기반 중복 제거
- `diarization-js` 또는 재현 가능한 Community-1 ONNX CPU 경로
- 기존 한국어 60초 샘플 2개
- 10분·30분 장문 샘플
- 10명 이상 화자 샘플
- Chrome·Edge WASM과 실제 기관 PC 8/16GB 표본
- 선택적 WebGPU 가속
- 처리 시간, 최대 메모리, 결과 품질 기록

통과하지 못한 기능은 제품 UI에 연결하지 않는다.

### 1단계: 웹 대화록 MVP

- 파일 선택과 지원 형식 검사
- small 모델 다운로드·캐시·무결성 검증
- 30초/5초 겹침 청크 STT, 중복 제거와 진행률
- 취소와 실패 복구
- 각 청크 완료 직후 중간 대화록 IndexedDB 저장
- 회의 기록 조회와 내보내기
- 기존 데스크톱 MeetingRecord 계약 유지
- 설치 가능한 PWA

### 2단계: 선택형 화자분리

- 분석 완료 후 사용자가 별도로 실행
- Community-1 WebGPU/WASM
- 단어 타임스탬프 또는 화자 전환점 기반 대화록 재분할
- 자동 화자 수와 `max_speakers` 상한 선택
- 10명 이상 회의 품질 경고와 검증 결과 반영

### 3단계: AI 정리

- STT와 화자분리 모델을 해제한 뒤 WebLLM 로드
- 전체 요약, 주제별 정리, 참석자별 정리
- 장문 청크 요약과 구조화된 중간 결과
- 모델 추천과 사용자 선택

### 4단계: 배포 강화

- 정적 웹 호스팅
- R2 custom domain과 모델 manifest
- Cache-Control, CORS, Range 요청
- COOP/COEP 헤더와 Cross-Origin Isolation 검증
- 오프라인 재실행
- 네트워크 유출 검사
- 브라우저별 호환성 안내
- 업무망용 오프라인 모델 패키지 또는 내부 미러

## 6. 품질 게이트

### STT

- 현재 faster-whisper-large-v3와 한국어 문장 누락·고유명사·숫자 비교
- 30초/5초 겹침 경계에서 누락과 중복 제거 확인
- 10분과 30분 파일 완주
- 반복 문장과 타임스탬프 오류 확인
- small 품질이 제품 최소 기준에 미달하면 기본 모델을 확정하지 않는다.

### 화자분리

- Python Community-1과 브라우저 결과 비교
- 10명 이상 화자 수 추정
- 같은 화자 분할과 다른 화자 병합 확인
- 짧은 발화와 겹침 발화 확인
- 현재 Whisper 정렬기의 짧은 화자 전환 손실 해결

### 브라우저 안정성

- 모델 다운로드 중단 재개
- 새로고침 후 캐시 재사용
- 저장공간 부족 처리
- GPU device lost 처리
- 탭 종료 후 중간 결과 복구
- WebGPU와 관계없이 small WASM CPU 경로 제공
- 첫 30~60초 RTF로 전체 예상 시간 표시
- 청크별 checkpoint 저장과 새로고침 후 마지막 완료 청크부터 재개
- RTF가 높거나 large-v3급 품질을 요구하면 데스크톱도 함께 안내

### 데스크톱 회귀 방지

- `build:web` 성공
- 공통 TypeScript 검사 성공
- 데스크톱 API 경로의 기존 집중 테스트 성공
- 웹 코드가 데스크톱 번들에 불필요하게 포함되지 않음
- 데스크톱 포터블 전체 빌드는 배포 경계가 변경되거나 사용자가 요청할 때만
  실행

## 7. 배포 판단

웹 버전은 설치가 없고 자동 업데이트가 쉬우며 모델과 음성 처리를 사용자
PC에 유지할 수 있어 제품 방향으로 적합하다.

다만 다음 환경에는 데스크톱을 계속 제공한다.

- 외부 모델 호스트와 내부 미러 모두 접근할 수 없는 업무망
- 브라우저 저장공간이 부족한 PC
- 실제 RTF 기준 예상 시간이 사용자가 기다릴 수 있는 범위를 넘는 경우
- 브라우저를 장시간 열어둘 수 없는 업무 환경
- large-v3급 최고 품질이 반드시 필요한 경우

따라서 웹은 데스크톱을 폐기하는 대체물이 아니라 같은 데이터 계약과 UI를
공유하는 추가 실행 대상이다.

## 8. 첫 구현 완료 기준

다음이 모두 확인되면 `codex/browser-engine-poc`을 제품 브랜치로 발전시킨다.

1. 한국어 60초 샘플 2개가 small WASM CPU 4 threads에서 완주한다.
2. 30초/5초 겹침 방식의 10분 샘플이 누락·중복 검사와 함께 완주한다.
3. Community-1 WASM CPU 결과가 Python 기준과 비교 가능한 형식으로 나오고, WebGPU는 선택적 가속으로 별도 확인한다.
4. 모델이 재접속 시 다시 다운로드되지 않는다.
5. 음성과 대화록이 외부 요청에 포함되지 않는다.
6. 기존 데스크톱 경로에 변경이 없다.
