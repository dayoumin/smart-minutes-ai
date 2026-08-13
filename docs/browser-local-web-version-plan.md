# 브라우저 온디바이스 웹 버전 설계

> 상태 변경(2026-08-13): 이 문서는 순수 WASM/WebGPU 무설치 후보의 기술 조사 기록으로 보존한다. 첫 제품 구현은 docs/web-local-engine-plan.md의 사용자 다운로드형 Windows 로컬 엔진을 사용하는 웹 MVP를 우선하며, 데스크톱 portable 완성을 선행 조건으로 두지 않는다.

- 문서 상태: 후순위 순수 BrowserEngine 기술 조사 기록
- 작성 기준일: 2026-07-17
- 대상 제품: LMO 회의 인사이트

## 1. 결론

웹 버전은 현재 데스크톱 앱의 분석 순서를 새로 만드는 프로젝트가 아니다.

현재 제품은 이미 다음처럼 단계를 나누어 실행한다.

1. 음성 파일을 분석해 대화록을 먼저 만든다.
2. 참석자 구분은 사용자가 필요할 때 회의 기록에서 별도로 실행한다.
3. 전체 요약, 주제별 정리, 참석자별 정리도 대화록을 확인한 뒤 별도로 생성한다.

브라우저 버전도 이 흐름을 유지한다. 차이는 Python 백엔드와 로컬 실행 프로그램이 담당하던 연산을 브라우저 Worker와 WebGPU 엔진이 담당한다는 점이다.

따라서 1차 목표는 다음과 같다.

> 기존 React 화면과 회의 기록 구조를 유지하면서, 설치 없이 브라우저 안에서 음성 인식과 AI 정리를 실행할 수 있는 `BrowserEngine`을 추가한다.

웹 버전의 1차 범위에 참석자 자동 구분은 포함하지 않는다. 현재 데스크톱 앱도 pyannote를 기본 분석 중에 실행하지 않으므로, 이 기능이 없다는 이유만으로 웹 대화록·정리 버전을 막지 않는다.

## 2. 현재 구현 기준

### 2-1. 프런트엔드

- `desktop-app`은 React, Vite, TypeScript, Tailwind CSS 기반이다.
- `desktop-app/package.json`에 이미 `build:web`이 있다.
- 같은 화면을 웹 개발 서버와 Tauri 데스크톱에서 함께 사용한다.
- 회의 기록은 `desktop-app/src/meetingRepository.ts`의 IndexedDB 저장소를 사용한다.

현재 `build:web`은 브라우저 전용 AI 버전을 의미하지 않는다. 화면만 웹으로 빌드할 수 있고, 실제 분석 요청은 `desktop-app/src/apiBase.ts`를 통해 로컬 FastAPI 백엔드로 전달한다.

### 2-2. 기본 분석

기본 분석 완료 기준은 대화록 저장이다.

- STT: 분석 중 실행
- 참석자 구분: 분석 중 실행하지 않음
- AI 정리: 분석 중 실행하지 않음

현재 `backend/config.json`의 주요 기본값은 다음과 같다.

```json
{
  "diarization": {
    "enabled": true,
    "generate_during_analysis": false
  },
  "summary": {
    "enabled": true,
    "generate_during_analysis": false
  }
}
```

`enabled=true`는 기능을 사용할 수 있다는 뜻이다. `generate_during_analysis=false`이므로 최초 파일 분석에서 자동 실행되는 것은 아니다.

### 2-3. 참석자 구분

pyannote 기반 참석자 구분은 선택형 후속 기능이다.

- 최초 분석이 끝난 뒤 회의 기록에서 별도로 실행한다.
- 백엔드 API는 `POST /api/outputs/{job_id}/generate-diarization`이다.
- 보존된 원본 음성 또는 복구 가능한 음성이 있어야 실행할 수 있다.
- 긴 파일에서는 전체 WAV 처리 비용 때문에 별도 자원 제한과 자동 우회 정책을 적용한다.

따라서 웹 버전의 핵심 대체 대상은 pyannote가 아니라 다음 두 경로다.

1. faster-whisper 기반 STT
2. Ollama 기반 AI 정리

### 2-4. AI 정리

AI 정리도 단계별로 분리되어 있다.

- 전체 요약: `generate-summary`
- 주제별 정리: `generate-topic-sections`
- 특정 주제 추가 정리: `generate-topic-section`
- 참석자별 맥락 정리: `generate-speaker-context`

웹 버전은 이 실행 시점을 유지하되, Ollama 요청을 WebLLM 요청으로 교체한다.

## 3. 제품 방향

### 3-1. 데스크톱과 웹의 관계

웹 버전을 위해 기존 데스크톱 제품을 폐기하거나 화면을 별도로 복제하지 않는다.

| 영역 | 데스크톱 실행 | 브라우저 실행 |
| --- | --- | --- |
| 공통 화면 | React UI | 같은 React UI |
| 회의 기록 | IndexedDB + 백엔드 결과 | IndexedDB + 브라우저 결과 |
| 음성 인식 | FastAPI + faster-whisper | Transformers.js + WebGPU |
| AI 정리 | Ollama | WebLLM + WebGPU |
| 참석자 구분 | 필요 시 pyannote 별도 실행 | 1차 미지원 |
| 파일 저장 | 백엔드 내보내기 + 저장 위치 선택 | 브라우저 다운로드 |
| 설치 | 포터블 앱 | 설치 없음 |

### 3-2. Next.js 도입 여부

1차 구현에서는 Next.js로 프런트엔드를 다시 만들지 않는다.

이유:

- 현재 화면과 상태 구조를 재사용할 수 있다.
- 브라우저 AI 연산은 모두 Client Component 성격이며 Next.js 서버 기능을 사용하지 않는다.
- Vite가 Worker와 브라우저 전용 모듈을 구성하기에 충분하다.
- 프레임워크 전환과 AI 런타임 전환을 동시에 하면 회귀 원인 분리가 어려워진다.

향후 소개 페이지, 검색 노출, 계정 기능 또는 서버 동기화가 필요할 때 Next.js 셸을 별도 검토한다.

## 4. 목표 아키텍처

### 4-1. 공통 실행 인터페이스

화면 컴포넌트가 FastAPI 주소나 WebLLM 엔진을 직접 알지 않도록 실행 계층을 분리한다.

```text
공통 React UI
    |
    +-- DesktopEngine
    |     +-- 현재 FastAPI API
    |     +-- faster-whisper
    |     +-- 선택형 pyannote
    |     +-- Ollama
    |
    +-- BrowserEngine
          +-- Audio Worker
          +-- Transformers.js STT Worker
          +-- WebLLM Summary Worker
          +-- IndexedDB / Cache / OPFS
```

예상 인터페이스:

```ts
interface MeetingAnalysisEngine {
    analyzeAudio(input: File, options: AnalyzeOptions): Promise<TranscriptResult>;
    cancelAnalysis(): Promise<void>;
    generateSummary(record: MeetingRecord): AsyncIterable<GenerationUpdate>;
    generateTopicSections(record: MeetingRecord): AsyncIterable<GenerationUpdate>;
    dispose(): Promise<void>;
}
```

`DesktopEngine`은 현재 API 호출을 감싸고, `BrowserEngine`은 Worker 메시지를 감싼다.

### 4-2. 브라우저 분석 흐름

```text
[파일 선택]
    ↓
[지원 형식·WebGPU·저장 공간 확인]
    ↓
[오디오 디코딩 및 16kHz mono 변환]
    ↓
[STT Worker: Whisper 로드]
    ↓
[청크별 음성 인식 및 대화록 임시 저장]
    ↓
[Whisper dispose + STT Worker 종료]
    ↓
[대화록 완료 및 회의 기록 저장]
    ↓ 사용자 선택
[WebLLM Worker 로드]
    ↓
[전체 요약 또는 주제별 정리 스트리밍]
    ↓
[정리 결과 저장]
```

현재 제품과 동일하게 대화록이 먼저 저장되어야 한다. AI 정리가 실패하거나 사용자가 실행하지 않아도 대화록은 정상 완료 상태로 남는다.

## 5. 메모리와 Worker 원칙

Whisper와 요약 모델을 같은 시점에 GPU에 올리지 않는다.

### STT 종료 순서

1. 남은 추론 요청이 없는지 확인한다.
2. Transformers.js pipeline의 `dispose()`를 호출한다.
3. Worker가 완료 응답을 보낸다.
4. 메인 스레드가 STT Worker를 종료한다.
5. 오디오 청크와 중간 tensor 참조를 제거한다.
6. 그다음 WebLLM Worker를 만든다.

객체를 `null`로 바꾸고 일정 시간 기다리는 방식만으로 GPU 메모리 해제를 보장하지 않는다. 명시적 `dispose()`와 Worker 종료를 기준으로 삼고, 짧은 대기 시간은 보조 수단으로만 사용한다.

### UI 응답성

- 오디오 변환, STT, AI 생성은 메인 스레드에서 실행하지 않는다.
- 다운로드 진행률과 추론 진행률은 Worker 이벤트로 전달한다.
- Worker 오류와 `device lost`는 사용자 데이터 손실이 아니라 해당 단계 실패로 처리한다.
- 대화록 임시 결과는 청크가 끝날 때마다 IndexedDB에 저장한다.

## 6. 모델 전략

### 6-1. STT

1차 후보:

- Transformers.js가 지원하는 다국어 Whisper ONNX 모델
- WebGPU용 `fp16` 또는 지원되는 양자화 형식
- 한국어 품질과 브라우저 메모리를 비교해 small급부터 검증

모델 이름과 실제 다운로드 크기는 구현 시점의 Transformers.js 지원 목록과 모델 저장소를 기준으로 고정한다. 기존 문서에 적힌 `Xenova/whisper-small`과 약 480MB 수치를 그대로 확정값으로 사용하지 않는다.

현재 faster-whisper-large-v3 결과와 비교할 항목:

- 한국어 고유명사
- 숫자와 날짜
- 문장 누락
- 반복 문장
- 타임스탬프
- 10분·30분 처리 시간
- 최대 메모리

### 6-2. AI 정리

현재 데스크톱 기본 모델은 Ollama의 `gemma4:e2b`다.

웹 버전에서는 WebLLM이 실제로 제공하는 prebuilt model ID 중 하나를 선택한다. 문서에 예시로 적힌 `gemma-2-2b-it-q4f16_1-MLC`는 Gemma 2 모델이므로 Gemma 4로 표기하지 않는다.

선정 원칙:

1. 2B급을 기본 후보로 검증한다.
2. GPU 기능과 메모리 한도를 확인한 뒤 모델을 제안한다.
3. 9B급을 8GB GPU의 기본 선택지로 제공하지 않는다.
4. 모델 이름보다 한국어 회의록 출력 품질과 장문 안정성을 우선한다.
5. 모델 ID와 WebLLM 버전을 함께 고정한다.

### 6-3. 긴 대화록 정리

전체 대화록을 한 번에 모델에 넣지 않는다.

```text
대화록
  → 시간 또는 토큰 기준 청크
  → 청크별 핵심 논의·결정·할 일 추출
  → 중간 결과 병합
  → 최종 회의록 생성
```

중간 결과는 자유 형식 Markdown보다 구조화된 데이터로 저장한다.

```ts
interface SummaryChunkResult {
    topics: string[];
    decisions: string[];
    actions: Array<{
        owner?: string;
        task: string;
        due?: string;
    }>;
    needsCheck: string[];
}
```
### 6-4. 모델 공개 범위와 다운로드 방식

Whisper와 pyannote는 둘 다 공개 소프트웨어 생태계에 속하지만 웹에서 배포하는 조건과 실행 방식은 같지 않다.

| 구분 | Whisper 웹 후보 | pyannote Community-1 |
| --- | --- | --- |
| 주 실행 환경 | Transformers.js + ONNX | Python + PyTorch + pyannote.audio |
| Hugging Face 접근 | 공개 ONNX 모델은 토큰 없이 가능 | gated 모델, 사용자 조건 동의와 개인 토큰 필요 |
| 브라우저 직접 실행 | 지원되는 ONNX 모델이면 가능 | 현재 공식 파이프라인 그대로는 불가 |
| 모델 라이선스 | 선택한 모델 카드 확인 필요 | CC BY 4.0 |
| 코드 라이선스 | Transformers.js/각 런타임 확인 | pyannote.audio MIT |
| 오프라인 사용 | 최초 캐시 후 가능 | 승인·다운로드 후 Python에서 가능 |

#### Whisper

Transformers.js가 지원하는 공개 ONNX Whisper 모델은 model ID로 직접 내려받고 브라우저 캐시에 저장할 수 있다.

운영 시에는 다음을 고정한다.

- 정확한 model ID
- revision 또는 commit hash
- dtype
- 파일별 크기와 무결성 정보
- 원본 모델·변환 모델 라이선스 고지

#### pyannote Community-1

`pyannote.audio` 코드는 MIT 라이선스이며 공개되어 있다. 하지만 현재 사용하는 `pyannote/speaker-diarization-community-1` 모델은 CC BY 4.0인 동시에 Hugging Face gated 모델이다.

공식 다운로드 절차:

1. 사용자가 Hugging Face에 로그인한다.
2. 모델 페이지에서 연락처 공유와 사용자 조건에 동의한다.
3. 개인 access token을 만든다.
4. token으로 모델 저장소를 내려받는다.
5. 내려받은 폴더를 `Pipeline.from_pretrained(local_path)`로 오프라인 실행한다.

따라서 공개 Whisper 모델처럼 익명 URL만 연결해 모든 웹 사용자가 바로 받게 할 수 없다. 사용자의 Hugging Face token을 브라우저 앱에 입력받는 방식도 다음 이유로 1차 제품에 사용하지 않는다.

- 사용자별 조건 동의가 선행되어야 한다.
- 브라우저에 token을 보관하거나 전달하는 보안 문제가 생긴다.
- token으로 파일을 받아도 현재 Community-1은 PyTorch 가중치와 Python/VBx 파이프라인이므로 브라우저에서 곧바로 실행되지 않는다.

서비스 운영자의 Hugging Face token을 프런트엔드 코드나 정적 환경 변수에 넣지 않는다. 브라우저에 전달된 token은 사용자에게 노출된 것으로 간주한다.

#### 자체 호스팅 가능성

CC BY 4.0은 일반적으로 저작자 표시와 라이선스 고지를 전제로 복제·재배포를 허용한다. 그러나 Community-1은 gated 접근 조건을 함께 사용하고 내부 구성 요소의 고지 사항도 있으므로, 자체 CDN에 모델을 올리기 전 다음을 확인한다.

- pyannote 및 모델 저작자 표시
- CC BY 4.0 전문 또는 링크
- 모델 변경·변환 여부 표시
- embedding·segmentation·PLDA 구성 요소별 고지
- gated 사용자 조건과 자체 재배포 방식의 정합성
- 공개 서비스에 필요한 법무·라이선스 검토

현재 포터블 앱처럼 모델 폴더와 고지 문서를 함께 전달하는 방식과, 불특정 웹 사용자에게 CDN으로 배포하는 방식은 배포 범위가 다르다. 기존 포터블 포함 사실만으로 웹 자체 호스팅을 자동 승인하지 않는다.

#### 브라우저 화자 분리 결론

현재 Community-1 모델 폴더에는 PyTorch 가중치가 들어 있고 공식 `pyannote.audio`는 Python/PyTorch 기반이다. Transformers.js는 ONNX 가중치를 요구하며 공식 지원 작업 목록에 speaker diarization pipeline이 없다.

브라우저에서 동일 기능을 제공하려면 단숔 파일 링크가 아니라 다음 별도 프로젝트가 필요하다.

1. segmentation·embedding 모델의 ONNX 변환 가능성 검증
2. 브라우저 추론 결과의 수치 일치 검증
3. VBx/PLDA clustering과 후처리의 TypeScript 또는 WASM 구현
4. Whisper 타임스탬프 정렬 구현
5. 긴 파일 메모리와 성능 검증
6. 변환·재배포 라이선스 고지

따라서 1차 웹 버전은 다음으로 확정한다.

- Whisper STT는 브라우저에서 직접 실행한다.
- pyannote Community-1을 브라우저에서 직접 다운로드·실행하지 않는다.
- 화자 분리는 웹 1차 범위에서 제외한다.
- pyannoteAI cloud는 음성을 외부 서버로 보내므로 `100% 로컬` 제품 경로에 사용하지 않는다.
- 화자 분리가 반드시 필요하면 현재 데스톱 로컬 기능을 사용한다.

References:
- https://huggingface.co/pyannote/speaker-diarization-community-1
- https://github.com/pyannote/pyannote-audio
- https://huggingface.co/docs/hub/models-gated
- https://huggingface.co/docs/transformers.js/main/pipelines
- https://creativecommons.org/licenses/by/4.0/

## 7. 참석자 구분 정책

### 7-1. 웹 1차 범위

- 자동 참석자 구분을 제공하지 않는다.
- 대화록은 시간순 세그먼트로 표시한다.
- 참석자 관련 화면은 숨기거나 `참석자 구분 없음` 상태로 표시한다.
- 참석자 구분 미지원 상태를 분석 실패로 취급하지 않는다.

### 7-2. 후속 후보

다음 조건을 충족할 때만 브라우저 참석자 구분을 별도 실험한다.

- 모델 다운로드 크기가 제품 허용 범위 안에 있음
- STT 모델과 동시에 로드하지 않아도 동작함
- 30분 회의에서 메모리와 시간이 실용적임
- 브라우저에서 화자 라벨 병합 품질을 검증할 수 있음

웹 참석자 구분은 1차 출시 조건이 아니다.

### 7-3. 현재 pyannote 상태와 Whisper의 한계

현재 제품의 기본 분석 경로에서는 pyannote를 실행하지 않는다. 다만 설정만 남은 완전한 미사용 코드는 아니다. 회의 기록 화면의 별도 실행 버튼, `POST /api/outputs/{job_id}/generate-diarization` API, `pipeline/diarize.py`의 실제 `pyannote.audio.Pipeline` 호출, 포터블 배포 모델이 남아 있다. 개발 체크포인트에도 2026년 5월 화자 구분 완료 기록이 있으나, 이는 개발·검증 실행 흔적이며 일반 사용자가 지속적으로 사용한다는 증거는 아니다.

기본 Whisper와 faster-whisper는 음성 인식과 번역을 제공하지만 발화자를 `SPEAKER_00`, `SPEAKER_01`처럼 나누는 화자 분리를 제공하지 않는다.

- Whisper segment와 word timestamp: 언제 어떤 말이 나왔는지 표시
- Voice Activity Detection: 음성이 있는 구간 탐지
- Speaker diarization: 각 구간을 누가 말했는지 구분

따라서 현재 대화록의 speaker 정보는 Whisper가 직접 생성한 값이 아니다. pyannote 화자 구간과 Whisper 타임스탬프를 정렬한 결과이거나, 화자 구분을 실행하지 않았을 때 적용한 기본 표식이다. Whisper 특징에 별도 화자 분류기를 결합한 외부 구현은 가능하지만 기본 Whisper 내장 기능으로 보지 않는다.

웹 버전은 pyannote 유지 여부와 무관하게 설계한다. 데스크톱에서 이 기능을 실제 제품 기능으로 유지할지, 개발 시절 부가기능으로 보고 제거할지는 별도 정리 작업에서 결정한다.

## 8. 오디오 처리

### 8-1. 기본 입력

1차 공식 지원 후보:

- WAV
- MP3
- 브라우저가 직접 디코딩할 수 있는 M4A

MP4를 포함한 영상 컨테이너는 브라우저와 코덱 조합에 따라 실패할 수 있다. UI의 확장자 허용만으로 지원을 선언하지 않고 실제 디코딩 성공 여부를 확인한다.

### 8-2. 변환 결과

- sample rate: 16,000Hz
- channel: mono
- data type: `Float32Array`

스테레오 입력은 좌우 채널 평균으로 mono 변환한다.

### 8-3. 긴 파일

Web Audio API의 전체 파일 디코딩은 원본과 PCM을 동시에 메모리에 둘 수 있다. 1차 구현은 파일 크기와 길이에 상한을 두고, 장시간 파일 지원은 별도 검증 후 확대한다.

후속 후보:

- ffmpeg.wasm Worker
- OPFS 임시 파일
- 스트리밍 또는 구간 디코딩
- STT 청크 완료 즉시 PCM 해제

## 9. 저장과 개인정보 보호

### 9-1. 로컬 처리의 정의

웹 버전의 `로컬 처리`는 다음을 의미한다.

- 사용자의 음성 파일을 서비스 서버에 업로드하지 않는다.
- STT와 AI 정리를 사용자 브라우저에서 실행한다.
- 대화록과 정리 결과를 기본적으로 브라우저 저장소에 보관한다.

최초 모델 다운로드에는 인터넷 연결이 필요할 수 있다. 따라서 사용자 문구는 `항상 완전 오프라인`이 아니라 다음처럼 설명한다.

> 모델을 처음 준비할 때 인터넷 연결이 필요할 수 있으며, 음성 파일과 회의 내용은 외부 분석 서버로 전송하지 않습니다.

### 9-2. 저장 위치

- 회의 메타데이터·대화록·정리: IndexedDB
- 모델 캐시: 라이브러리가 지원하는 Cache API, IndexedDB 또는 OPFS
- 대형 임시 오디오: 필요 시 OPFS
- 사용자 다운로드: 브라우저 다운로드

`navigator.storage.persist()`를 요청하되 브라우저가 허용하지 않을 수 있음을 상태로 보여준다.

### 9-3. 네트워크 검증

배포 전 다음을 확인한다.

- 분석 시작 후 모델 호스트 외부로 음성 데이터 요청이 나가지 않음
- 대화록과 프롬프트가 원격 로그·분석 도구로 전송되지 않음
- 오류 보고에 회의 원문을 포함하지 않음

## 10. UI 원칙

현재 `docs/design.md`의 용어와 상태 표시 규칙을 유지한다.

사용자 화면에서는 다음 표현을 사용한다.

- 음성 파일
- 음성 인식
- 대화록
- 회의 요약
- 주제별 정리
- 분석 준비

일반 화면에는 `Transformers.js`, `WebLLM`, `ONNX`, `WebGPU tensor`, `VRAM swap` 같은 구현 용어를 노출하지 않는다.

### 필수 상태

- 브라우저 분석 지원 여부
- 모델 준비 전
- 모델 받는 중
- 음성 인식 중
- 대화록 저장 완료
- AI 정리 준비 전
- AI 정리 중
- 완료
- 중지됨
- 복구 가능한 실패

WebGPU 지원 배지는 `navigator.gpu` 존재 여부만 보지 않는다. 실제 adapter/device 요청, 필요한 GPU 기능, 모델 로드 사전 점검까지 통과해야 `지원`으로 표시한다.

## 11. 구현 단계

### 0단계: 기술 검증

현재 UI와 분리된 작은 실험 화면에서 다음 한 줄 흐름만 검증한다.

```text
한국어 음성 파일 → Whisper 대화록 → 모델 해제 → WebLLM 요약
```

확인 항목:

- Chrome/Edge WebGPU 실행
- 모델 최초 다운로드와 재사용
- STT 종료 후 GPU 메모리 회수
- 2B급 모델의 한국어 회의록 품질
- 10분 샘플의 처리 시간과 최대 메모리
- 중지와 Worker 재시작

### 1단계: BrowserEngine MVP

- 실행 인터페이스 정의
- Audio Worker
- STT Worker
- 모델 다운로드 진행률
- 대화록 IndexedDB 저장
- 분석 중지
- TXT·JSON 다운로드

### 2단계: AI 정리

- WebLLM Worker
- 전체 요약 스트리밍
- 긴 대화록 청크 요약
- 주제별 정리
- 정리 결과 IndexedDB 저장
- Markdown 다운로드

### 3단계: 현재 화면 통합

- 데스크톱/브라우저 런타임 자동 선택
- 회의 기록 화면 재사용
- 브라우저에서 지원하지 않는 액션 정리
- 설정 화면의 모델 준비 상태 분리
- 기존 데스크톱 흐름 회귀 테스트

### 4단계: 장시간·호환성 확대

- 30분 이상 파일
- MP4/코덱 fallback
- 저장 공간 부족 복구
- GPU device lost 복구
- 저사양 모델 자동 추천
- 필요 시 PWA와 오프라인 셸

## 12. 1차 제공 범위

### 포함

- 설치 없는 브라우저 실행
- 음성 파일 업로드
- WebGPU 지원 확인
- 로컬 STT
- 타임스탬프 대화록
- 전체 요약
- 주제별 정리
- Action Item
- 회의 기록
- TXT·JSON·Markdown 다운로드
- 분석 중지
- 모델 캐시 상태

### 제외

- 브라우저 pyannote
- 참석자별 자동 발언 정리
- 9B 모델 기본 제공
- 모든 브라우저 지원
- 모든 영상·오디오 코덱 지원
- 계정과 서버 동기화
- 데스크톱 앱 제거
- Next.js 재작성

## 13. 완료 기준

### 기능

- 지원되는 한국어 음성 파일로 대화록을 만들 수 있다.
- STT 결과가 저장된 뒤 요약을 별도로 실행할 수 있다.
- 요약 실패가 저장된 대화록을 손상하지 않는다.
- 새로고침 후 회의 기록과 완료된 결과가 복원된다.
- 사용자가 STT와 AI 정리를 각각 중지할 수 있다.

### 자원

- Whisper와 WebLLM이 동시에 GPU에 상주하지 않는다.
- Worker 종료 후 다음 모델을 로드할 수 있다.
- GPU 장치 손실 후 새 Worker로 다시 시작할 수 있다.
- 지원하지 않는 장치에서는 모델 다운로드 전에 이유를 안내한다.

### 개인정보

- 음성 데이터가 외부 분석 서버로 전송되지 않는다.
- 회의 원문이 원격 로그나 분석 도구로 전송되지 않는다.
- 저장된 회의 기록을 사용자가 삭제할 수 있다.

### 품질

- 고정 한국어 샘플로 현재 faster-whisper 결과와 비교 기록을 남긴다.
- AI 정리 결과에 근거 없는 담당자와 기한을 만들지 않는다.
- 긴 입력은 단일 프롬프트가 아니라 청크 병합 경로를 사용한다.

## 14. 구현 전 확정할 결정

다음 항목은 0단계 결과를 보고 확정한다.

1. 지원 브라우저를 Chrome/Edge로 제한할지
2. 기본 Whisper 모델과 dtype
3. 기본 WebLLM 모델
4. 1차 파일 길이·크기 상한
5. M4A와 MP4의 공식 지원 범위
6. 모델 파일을 외부 저장소에서 받을지 자체 호스팅할지
7. 웹 버전에서 기존 회의 기록 내보내기 형식을 어디까지 제공할지

## 15. 관련 구현과 문서

- `desktop-app/package.json`
- `desktop-app/src/apiBase.ts`
- `desktop-app/src/meetingRepository.ts`
- `desktop-app/src/MeetingWriter.tsx`
- `desktop-app/src/MeetingHistory.tsx`
- `backend/config.json`
- `backend/main.py`
- `docs/design.md`
- `docs/audio-long-file-processing-plan.md`
- `docs/audio-performance-improvement-log.md`
