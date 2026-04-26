# 내부망용 로컬 AI 회의록 데스크탑앱 설계서

## 0. 문서 목적

이 문서는 다른 AI, 개발자, Codex, Claude Code 등에 전달하기 위한 프로젝트 설계서이다.

목표는 **Windows 내부망에서 실행 가능한 로컬 AI 회의록 데스크탑앱**을 만드는 것이다.

사용자는 회의 음성 또는 영상 파일을 선택하고, 앱은 로컬 PC에서 다음 작업을 수행한다.

1. 음성/영상 파일 전처리
2. 음성 활동 감지(VAD)
3. 한국어 음성 인식(STT)
4. 화자 분리 및 화자구분
5. STT 문장과 화자구간 매칭
6. 화자별 원문 회의록 생성
7. 로컬 LLM으로 회의록 정리
8. TXT / Markdown / DOCX 저장

모든 처리는 로컬 PC에서 수행해야 하며, 외부 서버로 음성, 텍스트, 회의록, 로그를 전송하지 않는다.

---

## 0.1. 향후 로드맵 및 AI 협업 가이드 (Roadmap & Hooks)

본 프로젝트는 향후 고도화를 위해 다음 기능을 수용할 수 있는 구조로 설계되었다. 후임 개발자나 AI 어시스턴트는 다음 가이드를 참고한다.

1. **RAG (Retrieval-Augmented Generation)**:
   - `backend/main.py` 끝부분에 RAG 인덱싱용 후크가 마련되어 있다.
   - 모든 회의 결과는 `result_data` JSON으로 표준화되어 있으므로, 이를 벡터 DB(ChromaDB 등)에 그대로 적재하면 된다.

2. **HWPX 템플릿 보고서**:
   - `config.json`의 `export_templates` 섹션에 관련 경로 설정을 추가해 두었다.
   - `pipeline/export_hwpx.py`를 신설하여 `result_data`를 한글 문서 템플릿에 매핑하는 기능을 구현할 수 있다.

3. **AI 보고서 작성 고도화**:
   - `summarize.py`의 프롬프트를 수정하거나, 특정 양식 전용 요약 모드를 추가하여 원클릭 보고서 작성이 가능하도록 확장한다.

---

파이프파이프라인을 사용한다.

---

### 1-4. LLM: 회의록 정리

**선정 후보**

```text
Gemma 4 2B
Gemma 4 4B
```

**역할**

- 음성 인식 원문 정리
- 중복 표현 제거
- 문장 다듬기
- 회의 요약
- 결정사항 추출
- 할 일 추출
- 확인 필요 사항 정리
- 보고서형 회의록 초안 생성

**운영 방식**

초기 MVP에서는 다음 방식을 권장한다.

```text
앱 → 로컬 Ollama 또는 llama.cpp API → Gemma 2B/4B
```

완성형 내부망 배포에서는 다음 방식을 검토한다.

```text
앱 내부에 llama.cpp 기반 로컬 LLM 실행 파일 포함
또는
별도 로컬 LLM worker.exe 포함
```

**주의사항**

- LLM은 없는 내용을 만들어낼 수 있으므로, 원문과 요약본을 반드시 함께 저장한다.
- 담당자와 기한은 명확히 언급된 경우에만 추출한다.
- 불명확한 내용은 "확인 필요"로 표시한다.

---

## 2. 전체 시스템 구조

### 2-1. 전체 흐름

```text
음성/영상 파일
↓
ffmpeg 전처리
↓
16kHz mono wav 변환
↓
VAD / segmentation
↓
Cohere Transcribe STT
↓
pyannote speaker diarization
↓
STT 문장과 화자구간 매칭
↓
화자별 원문 회의록 생성
↓
Gemma 2B/4B 회의록 정리
↓
TXT / MD / DOCX 저장
```

---

### 2-2. 앱 구조

```text
LocalMeetingAI/
├─ desktop-app/
│  ├─ Tauri 또는 Electron UI
│  └─ React 화면
│
├─ backend/
│  ├─ main.py
│  ├─ app_api.py
│  ├─ config.json
│  ├─ requirements.txt
│  │
│  ├─ pipeline/
│  │  ├─ audio_preprocess.py
│  │  ├─ vad.py
│  │  ├─ transcribe.py
│  │  ├─ diarize.py
│  │  ├─ align_speakers.py
│  │  ├─ clean_text.py
│  │  ├─ summarize.py
│  │  ├─ export_txt.py
│  │  ├─ export_markdown.py
│  │  └─ export_docx.py
│  │
│  ├─ models/
│  │  ├─ stt/
│  │  │  └─ cohere-transcribe-03-2026/
│  │  ├─ diarization/
│  │  │  └─ speaker-diarization-3.1/
│  │  ├─ segmentation/
│  │  │  └─ segmentation-3.0/
│  │  └─ llm/
│  │     ├─ gemma-4-2b/
│  │     └─ gemma-4-4b/
│  │
│  ├─ outputs/
│  ├─ temp/
│  ├─ logs/
│  └─ data/
│     └─ jobs/
│
├─ ffmpeg/
│  └─ ffmpeg.exe
│
├─ installer/
└─ README.md
```

---

## 3. 개발 단계

### 3-1. 1단계: Python CLI MVP

목표는 데스크탑앱 없이 Python만으로 핵심 파이프라인을 검증하는 것이다.

**목표**

```text
음성 파일 → STT → TXT 저장
```

**명령 예시**

```bash
python main.py --input meeting.mp3 --mode standard
```

**구현 기능**

- 입력 파일 확인
- ffmpeg로 wav 변환
- STT 수행
- TXT 저장

**완료 기준**

- Windows에서 mp3, wav 파일 입력 가능
- 한국어 회의 음성이 텍스트로 변환됨
- 결과가 `outputs/` 폴더에 저장됨

---

### 3-2. 2단계: 화자구분 추가

**목표**

```text
음성 파일 → STT → 화자구분 → 화자별 TXT 저장
```

**구현 기능**

- pyannote speaker diarization 로컬 모델 로딩
- 화자 구간 추출
- STT segment와 speaker segment 시간 겹침 계산
- 화자별 원문 생성

**완료 기준**

```text
[00:00:00] 화자1: 안녕하세요. 회의를 시작하겠습니다.
[00:00:04] 화자2: 네, 오늘 안건부터 확인하겠습니다.
```

형태로 저장되어야 한다.

---

### 3-3. 3단계: LLM 회의록 정리 추가

**목표**

```text
화자별 원문 → Gemma 2B/4B → 회의록 요약
```

**구현 기능**

- 로컬 LLM 호출
- 회의 요약 생성
- 주요 논의사항 생성
- 결정사항 생성
- 할 일 목록 생성
- 확인 필요 사항 생성

**완료 기준**

Markdown 결과가 다음 형식으로 생성되어야 한다.

```markdown
# 회의록

## 1. 회의 요약

## 2. 주요 논의사항

## 3. 결정사항

## 4. 할 일

## 5. 확인 필요 사항

## 6. 화자별 원문
```

---

### 3-4. 4단계: DOCX 저장

**목표**

```text
result.json → 회의록.docx
```

**구현 기능**

- python-docx 사용
- 제목, 회의정보, 요약, 결정사항, 할 일, 원문 포함
- 한글 문서 스타일 고려
- 표 형식의 할 일 목록 지원

---

### 3-5. 5단계: Gradio 또는 FastAPI UI

처음부터 데스크탑앱을 만들지 말고, 개발 검증용 UI를 먼저 만든다.

**권장**

- 빠른 테스트: Gradio
- 데스크탑앱 연동 예정: FastAPI

**기능**

- 파일 업로드
- 변환 시작
- 진행률 표시
- 결과 미리보기
- TXT/MD/DOCX 다운로드

---

### 3-6. 6단계: 데스크탑앱 포장

**권장 구조**

```text
Tauri + React + Python worker sidecar
```

또는

```text
Electron + React + Python child process
```

**Windows 내부망 배포를 고려하면 권장 방식**

```text
Tauri + React UI
Python worker.exe
ffmpeg.exe
models/ 폴더
config.json
```

---

## 4. 모듈별 상세 설계

### 4-1. audio_preprocess.py

**역할**

- 입력 파일을 wav로 변환
- 16kHz
- mono
- ffmpeg 사용
- 임시 폴더에 저장

**함수 예시**

```python
def convert_to_wav(input_path: str, output_path: str, ffmpeg_path: str) -> str:
    """
    입력 음성/영상 파일을 16kHz mono wav로 변환한다.
    """
```

**ffmpeg 명령 예시**

```bash
ffmpeg -y -i input.mp3 -ac 1 -ar 16000 output.wav
```

---

### 4-2. transcribe.py

**역할**

- Cohere Transcribe 모델로 STT 수행
- 한국어 기본 설정
- 긴 파일 chunk 처리
- segment 단위 결과 반환

**함수 예시**

```python
def transcribe_audio(
    wav_path: str,
    model_path: str,
    language: str = "ko",
    device: str = "auto",
    chunk_seconds: int = 30
) -> list[dict]:
    """
    반환 예:
    [
      {
        "start": 0.0,
        "end": 4.2,
        "text": "안녕하세요. 회의를 시작하겠습니다."
      }
    ]
    """
```

**대체 구현**

Cohere Transcribe 적용 전에는 `faster-whisper` 기반 대체 함수를 유지한다.

```python
def transcribe_audio_fallback_whisper(
    wav_path: str,
    model_path: str,
    language: str = "ko",
    device: str = "auto"
) -> list[dict]:
    """
    Cohere Transcribe가 실패하거나 미설치인 경우 faster-whisper로 대체한다.
    """
```

---

### 4-3. diarize.py

**역할**

- pyannote speaker diarization 3.1 로컬 모델 사용
- 화자별 시간 구간 추출
- min_speakers / max_speakers 옵션 지원

**함수 예시**

```python
def diarize_audio(
    wav_path: str,
    diarization_model_path: str,
    min_speakers: int | None = None,
    max_speakers: int | None = None
) -> list[dict]:
    """
    반환 예:
    [
      {
        "start": 0.0,
        "end": 3.5,
        "speaker": "SPEAKER_00"
      },
      {
        "start": 3.6,
        "end": 8.0,
        "speaker": "SPEAKER_01"
      }
    ]
    """
```

---

### 4-4. align_speakers.py

**역할**

- STT 문장 구간과 화자 구간의 overlap 계산
- overlap이 가장 큰 speaker를 해당 STT segment에 할당

**함수 예시**

```python
def align_segments_with_speakers(
    transcript_segments: list[dict],
    speaker_segments: list[dict]
) -> list[dict]:
    """
    반환 예:
    [
      {
        "start": 0.0,
        "end": 4.2,
        "speaker": "SPEAKER_00",
        "speaker_name": "화자1",
        "text": "안녕하세요. 회의를 시작하겠습니다."
      }
    ]
    """
```

**매칭 규칙**

```text
1. 각 STT segment의 start/end와 각 speaker segment의 start/end를 비교한다.
2. 겹치는 시간이 가장 긴 speaker를 선택한다.
3. 겹침이 없으면 UNKNOWN으로 표시한다.
4. 너무 짧은 segment는 앞뒤 화자 정보를 참조해 보정할 수 있다.
```

---

### 4-5. summarize.py

**역할**

- 화자별 원문을 로컬 LLM에 전달
- 회의록 양식으로 정리
- 없는 내용 추가 방지
- 불명확한 항목은 확인 필요로 표시

**함수 예시**

```python
def summarize_meeting(
    transcript_text: str,
    model_name_or_path: str,
    mode: str = "meeting_minutes"
) -> dict:
    """
    반환 예:
    {
      "title": "회의록",
      "overview": "...",
      "topics": ["..."],
      "decisions": ["..."],
      "actions": [
        {
          "owner": "화자2",
          "task": "예산 자료 확인",
          "due": "다음 주"
        }
      ],
      "needs_check": ["..."]
    }
    """
```

**프롬프트 예시**

```text
당신은 회의록 정리 담당자입니다.
아래 원문은 음성 인식 결과라서 중복, 말더듬, 불완전한 문장이 포함되어 있습니다.

규칙:
1. 원래 의미를 바꾸지 마세요.
2. 없는 내용을 추가하지 마세요.
3. 담당자와 기한은 명확히 언급된 경우만 적으세요.
4. 불확실한 내용은 "확인 필요"로 표시하세요.
5. 결과는 회의록 형식으로 정리하세요.
6. 원문에 없는 참석자명, 날짜, 기관명은 만들어내지 마세요.

출력 형식:
# 회의록

## 1. 회의 요약

## 2. 주요 논의사항

## 3. 결정사항

## 4. 할 일

## 5. 확인 필요 사항

원문:
{transcript}
```

---

### 4-6. export_docx.py

**역할**

- result.json을 DOCX 파일로 변환
- 회의록 템플릿 적용 가능
- 한글 문서 스타일 지원

**함수 예시**

```python
def export_docx(
    result: dict,
    output_path: str,
    template_path: str | None = None
) -> str:
    """
    result.json 기반으로 DOCX 파일을 생성한다.
    """
```

**DOCX 구성**

```text
회의록 제목
회의 일시
원본 파일명
처리 일시
화자 목록

1. 회의 요약
2. 주요 논의사항
3. 결정사항
4. 할 일
5. 확인 필요 사항
6. 화자별 원문
```

---

## 5. 중간 결과 JSON 표준

모든 처리 결과는 `result.json`으로 저장한다.

```json
{
  "job_id": "20260426_001",
  "source_file": "meeting.mp3",
  "created_at": "2026-04-26T10:00:00",
  "language": "ko",
  "settings": {
    "stt_model": "CohereLabs/cohere-transcribe-03-2026",
    "diarization_model": "pyannote/speaker-diarization-3.1",
    "vad_model": "pyannote/segmentation-3.0",
    "summary_model": "gemma-4b",
    "diarization": true,
    "summary": true
  },
  "segments": [
    {
      "start": 0.0,
      "end": 4.2,
      "speaker": "SPEAKER_00",
      "speaker_name": "화자1",
      "text": "안녕하세요. 회의를 시작하겠습니다."
    }
  ],
  "summary": {
    "title": "회의록",
    "overview": "예산 집행 현황을 논의함.",
    "topics": [],
    "decisions": [],
    "actions": [],
    "needs_check": []
  }
}
```

---

## 6. 설정 파일 예시

```json
{
  "app_name": "Local Meeting AI",
  "offline_mode": true,
  "paths": {
    "ffmpeg": "./ffmpeg/ffmpeg.exe",
    "stt_model": "./models/stt/cohere-transcribe-03-2026",
    "diarization_model": "./models/diarization/speaker-diarization-3.1",
    "segmentation_model": "./models/segmentation/segmentation-3.0",
    "llm_model": "./models/llm/gemma-4b",
    "output_dir": "./outputs",
    "temp_dir": "./temp",
    "log_dir": "./logs"
  },
  "stt": {
    "language": "ko",
    "default_model": "cohere-transcribe-03-2026",
    "fallback_model": "faster-whisper-large-v3",
    "device": "auto",
    "chunk_seconds": 30
  },
  "diarization": {
    "enabled": true,
    "min_speakers": null,
    "max_speakers": null
  },
  "summary": {
    "enabled": true,
    "mode": "meeting_minutes",
    "model": "gemma-4b"
  },
  "privacy": {
    "send_data_to_server": false,
    "auto_delete_temp_audio": true,
    "save_logs": true,
    "save_original_audio_copy": false
  }
}
```

---

## 7. UI 요구사항

### 7-1. 첫 화면

```text
- 파일 선택 또는 드래그 앤 드롭
- 변환 모드 선택
  - 빠름
  - 표준
  - 정확도 우선
- 화자구분 사용 여부
- AI 회의록 정리 사용 여부
- 출력 형식 선택
  - TXT
  - MD
  - DOCX
- 변환 시작 버튼
```

---

### 7-2. 진행 화면

```text
- 현재 처리 단계 표시
- 진행률 표시
- 간단 로그 표시
- 취소 버튼
```

처리 단계 예:

```text
1. 파일 확인
2. wav 변환
3. 음성 활동 감지
4. 음성 인식
5. 화자구분
6. 화자 매칭
7. 회의록 정리
8. 파일 저장
```

---

### 7-3. 결과 화면

```text
- 화자별 원문 보기
- 화자 이름 수정
- 요약본 보기
- 결정사항 보기
- 할 일 목록 보기
- 확인 필요 사항 보기
- DOCX/TXT/MD 저장 버튼
```

---

## 8. 내부망/오프라인 요구사항

반드시 지켜야 한다.

```text
외부 API 호출 금지
자동 업데이트 금지
원격 로그 전송 금지
Hugging Face 토큰 앱에 포함 금지
음성/텍스트/회의록 외부 전송 금지
모델은 사전 다운로드 후 로컬 폴더에서 로딩
ffmpeg.exe 포함
임시 wav 파일 자동 삭제 옵션 제공
오류 로그에는 원문 회의 내용이 들어가지 않도록 주의
```

---

## 9. 모델 준비 방식

### 9-1. 온라인 준비 PC

인터넷이 되는 PC에서 다음 작업을 수행한다.

```text
1. pyannote 모델 사용조건 확인
2. Hugging Face 토큰으로 모델 다운로드
3. Cohere Transcribe 모델 다운로드
4. Gemma 2B/4B 모델 다운로드
5. 샘플 음성으로 정상 동작 확인
6. models/ 폴더를 내부망 배포용으로 압축
```

---

### 9-2. 내부망 PC

내부망 PC에서는 다음 구조로 모델을 배치한다.

```text
models/
├─ stt/
│  └─ cohere-transcribe-03-2026/
├─ diarization/
│  └─ speaker-diarization-3.1/
├─ segmentation/
│  └─ segmentation-3.0/
└─ llm/
   └─ gemma-4b/
```

실행 중에는 Hugging Face 로그인이나 토큰 입력이 없어야 한다.

---

## 10. 성능 모드

### 빠름

```text
STT: faster-whisper small 또는 Cohere Transcribe 경량 설정
Diarization: 끄기 가능
LLM: Gemma 2B
용도: 간단한 녹취
```

### 표준

```text
STT: Cohere Transcribe
Diarization: pyannote/speaker-diarization-3.1
LLM: Gemma 4B
용도: 일반 회의
```

### 정확도 우선

```text
STT: Cohere Transcribe 또는 Whisper large-v3 계열 비교
Diarization: pyannote/speaker-diarization-3.1
LLM: Gemma 4B
추가: 긴 문맥 정리, 원문 보존
용도: 중요 회의
```

---

## 11. 테스트 기준

### 11-1. 기능 테스트

- mp3 입력 가능
- m4a 입력 가능
- mp4 입력 가능
- wav 입력 가능
- STT 결과 생성
- 화자구분 결과 생성
- STT와 화자구간 매칭
- TXT 저장
- MD 저장
- DOCX 저장
- 외부 네트워크 없이 실행

---

### 11-2. 품질 테스트

사내 샘플 회의 음성으로 다음 항목을 평가한다.

```text
한국어 인식 정확도
고유명사 인식률
화자 수 추정 정확도
화자 변경점 정확도
겹침 발화 처리
요약의 사실성
결정사항/할 일 추출 정확도
DOCX 가독성
```

---

## 12. 주요 리스크와 대응

### 리스크 1. 화자구분이 완벽하지 않음

**대응**

- 화자 이름 수정 기능 제공
- segment별 speaker 수동 변경 기능 제공
- 원문과 시간 정보 유지

---

### 리스크 2. LLM이 내용을 만들어냄

**대응**

- 원문 기반 정리 프롬프트 사용
- 없는 내용 추가 금지
- 불확실한 내용은 확인 필요 표시
- 원문과 요약본 함께 저장

---

### 리스크 3. 내부망 모델 경로 문제

**대응**

- config.json에서 모델 경로 지정
- 앱 시작 시 모델 존재 여부 검사
- 누락 모델을 사용자에게 명확히 안내

---

### 리스크 4. GPU 없는 PC에서 속도 저하

**대응**

- CPU 모드 제공
- 빠름 모드 제공
- 긴 파일 chunk 처리
- 중간 결과 저장
- 작업 취소 기능 제공

---

### 리스크 5. 라이선스와 사용조건

**대응**

- 각 모델의 라이선스와 사용조건을 별도 문서로 정리
- pyannote 모델은 Hugging Face 사용 동의 조건 확인
- Cohere Transcribe Apache 2.0 라이선스 확인
- 사내 배포 전 법무/보안 검토

---

## 13. MVP 완료 기준

1차 MVP 완료 기준은 다음과 같다.

```text
Windows에서 실행 가능
mp3 또는 wav 파일 입력 가능
ffmpeg로 wav 변환 가능
Cohere Transcribe 또는 fallback STT로 한국어 텍스트 생성 가능
pyannote로 화자구분 가능
화자별 TXT 저장 가능
Gemma로 회의록 Markdown 생성 가능
DOCX 저장 가능
외부 서버 호출 없이 실행 가능
```

---

## 14. 다른 AI에게 줄 구현 지시문

아래 문장을 Codex, Claude Code, Gemini CLI 등에 전달한다.

```text
먼저 전체 구현 계획을 세우고, 1단계 Python CLI MVP부터 구현하세요.
처음부터 데스크탑앱을 만들지 말고, 각 모듈을 테스트 가능하게 분리하세요.

Windows 내부망에서 실행 가능한 로컬 AI 회의록 앱을 만드는 것이 목표입니다.
STT는 CohereLabs/cohere-transcribe-03-2026을 우선 검토하고, 실패 시 faster-whisper fallback을 유지하세요.
화자구분은 pyannote/speaker-diarization-3.1을 사용하고, VAD/segmentation은 Pyannote Segmentation 3.0 기반으로 처리하세요.
회의록 정리는 로컬 Gemma 2B/4B 모델을 사용하세요.

모든 처리는 로컬 PC에서 수행되어야 하며, 외부 서버로 음성, 텍스트, 회의록, 로그를 전송하면 안 됩니다.
모델은 사전에 다운로드하여 models/ 폴더에 배치하고, 내부망 실행 중 Hugging Face 토큰이나 인터넷 연결이 필요하지 않게 설계하세요.

우선 다음 순서로 구현하세요.

1. ffmpeg 전처리
2. STT
3. 화자구분
4. STT segment와 speaker segment 매칭
5. result.json 저장
6. TXT/MD 출력
7. Gemma 회의록 정리
8. DOCX 출력
9. Gradio 또는 FastAPI UI
10. Tauri/Electron 데스크탑앱 포장
```

---

## 15. 참고 링크

모델과 라이선스, 사용조건은 개발 시작 전 다시 확인해야 한다.

- CohereLabs/cohere-transcribe-03-2026  
  https://huggingface.co/CohereLabs/cohere-transcribe-03-2026

- Cohere Transcribe release blog  
  https://huggingface.co/blog/CohereLabs/cohere-transcribe-03-2026-release

- pyannote/speaker-diarization-3.1  
  https://huggingface.co/pyannote/speaker-diarization-3.1

- pyannote/segmentation-3.0  
  https://huggingface.co/pyannote/segmentation-3.0

- pyannote.audio GitHub  
  https://github.com/pyannote/pyannote-audio
