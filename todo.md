# 📝 스마트 회의록 시스템 TO-DO (Next Steps)

## 1. 프론트엔드 연동 및 메타데이터 지원
- [x] 파일 업로드 시 회의록 메타데이터(회의 제목, 날짜, 참석자 등) 입력 폼 추가
- [x] 입력받은 메타데이터를 백엔드 API로 전달하고 최종 결과에 반영 (API Fetch/FormData 연동 완료)
- [x] 백엔드의 진행률(progress) 데이터를 실시간으로 UI의 프로그레스 바에 연동 (SSE 스트리밍 적용 완료)
- [x] 분석 모드 선택 추가: 빠른 테스트(Mock)와 실제 로컬 분석(mode=real) API 계약 분리

## 2. 모델 및 환경 자동화 (오프라인 배포 준비)
- [x] `download_models.py` 등 모델/의존성 오프라인 다운로드 스크립트 초안 작성
- [ ] `download_models.py`에 실제 라이브러리 연동 및 다운로드 테스트 수행
- [ ] 내부망 이관 후 클릭 한 번으로 `models/` 디렉토리 자동 배치 (Tauri/Electron 윈도우 인스톨러 패키징 시 포함)

## 3. 회의록 DB화 및 이력 관리
- [x] 회의 단위 DB 스키마 설계 (IndexedDB 임시 적용 완료): 제목, 날짜, 참석자, 요약 데이터 저장
- [x] 발화 세그먼트 스키마 추가 및 상세 모달 스크립트 탭 UI 구현 완료
- [x] 발화 세그먼트 DB 저장(백엔드 연동 확정 시): 원문 텍스트 연계 로직 추가 완료
- [ ] 요약 결과 DB 저장: 핵심 요약, 주요 토픽, 결정 사항, 할 일, 후속 액션을 구조화해서 보관 (현재는 단일 요약 텍스트로 보관 중)
- [x] 회의록 목록/상세 UI 추가: 최근 회의록 조회, 검색, 삭제, MD 결과 다운로드 기능 구현
- [x] IndexedDB 저장소 로직을 `meetingRepository.ts`로 분리해 SQLite 마이그레이션 준비
- [ ] 데스크톱 앱(Tauri/Electron) 패키징 시점에 로컬 영구 저장을 위한 SQLite 연동 (현재는 UI 테스트용 IndexedDB 사용 중)

## 4. 요약 프롬프트 및 문서 내보내기 고도화
- [ ] `backend/pipeline/summarize.py`의 Gemma 프롬프트 세밀 튜닝 (결정사항, 할 일 추출 정확도 향상)
- [ ] 한글(HWPX) 템플릿 지원 (미리 지정된 사내 회의록 양식에 맞게 결과 매핑)
- [ ] 표 형식을 포함한 깔끔한 DOCX 내보내기 스타일(python-docx) 개선

## 5. 대용량 음성/영상 처리
- [x] 영상 파일 업로드 시 ffmpeg로 음성 트랙만 추출하고 원본 영상은 설정에 따라 보관/삭제
- [x] 긴 음성 파일을 시간 기준 청크(예: 10~15분)로 분할해 STT 메모리 사용량을 제한하는 백엔드 뼈대 추가
- [x] 청크별 STT 결과를 타임스탬프 오프셋으로 병합하는 기본 유틸 추가
- [x] 청크별 진행률을 SSE로 전송해 사용자가 긴 파일 처리 상태를 확인할 수 있게 개선
- [ ] 실패한 청크만 재시도할 수 있도록 임시 작업 상태와 partial result 저장

## 6. 2026-04-26 Agent Review Notes
- [x] Cohere Transcribe, Pyannote Community-1, Ollama Gemma 준비 상태 확인 및 Cohere 데모 음성 STT 검증
- [x] Ollama 실행 파일을 PATH 없이도 찾도록 백엔드 자동 탐색 추가
- [x] 모델 폴더가 일부만 다운로드된 상태를 설치 완료로 오판하지 않도록 모델 payload 검사 강화
- [ ] 1순위: Cohere STT 결과를 화자 분리와 맞게 더 작은 시간 조각으로 만들기
  - 현재 위험: Cohere가 청크당 1개 세그먼트를 반환하면 긴 청크 전체가 한 화자에게 붙을 수 있음
  - 단기 개선: 기본 STT 청크를 30초 수준으로 줄여 화자 정렬 품질 확보
  - 중기 개선: 문장 단위 분할 또는 Cohere/대체 STT의 안정적인 타임스탬프 전략 검토
- [ ] 모델/의존성 설치 재현성 개선
  - requirements.txt에 Cohere 실행에 필요한 librosa, soundfile, sentencepiece, protobuf 반영
  - Python venv 런처와 네이티브 패키지 버전 정리 필요
- [ ] 데스크탑 패키징 설계
  - FastAPI sidecar 시작/종료, 포트 충돌, ffmpeg/model 경로, Python 런타임 포함 전략 결정
- [ ] 저장소 기준 정리
  - 백엔드 JSON/MD/DOCX 결과와 UI IndexedDB 저장 구조를 SQLite 전환 전에 단일 기준으로 정리

## 7. Immediate Priority: Real E2E Smoke Test
- [x] 짧은 실제 음성 파일로 전체 파이프라인 검증
  - 입력 파일 저장
  - ffmpeg WAV 변환
  - Cohere STT 30초 청크 분석
  - Pyannote 화자 분리
  - Ollama Gemma 요약
  - JSON/TXT/MD/DOCX 결과 파일 생성 확인
- [x] E2E 실패 지점이 있으면 원인을 `환경/모델/파이프라인/UI` 중 하나로 분류해서 다음 수정 항목으로 올리기
  - 환경: 기존 `.venv`가 Python 3.11 네이티브 패키지와 섞여 있어 Python 3.12 런타임에서 여러 import 실패 발생
  - 파이프라인: Pyannote가 torchcodec으로 파일을 직접 읽지 않도록 waveform 메모리 입력 방식으로 수정
  - 파이프라인: Ollama CLI 출력 제어문자 문제를 피하기 위해 요약은 Ollama HTTP API JSON 모드 우선 사용
- [x] E2E 성공 후 같은 흐름을 프론트엔드 업로드 화면에서 재검증
  - Playwright smoke test로 파일 선택, real `/api/analyze` SSE 완료, IndexedDB 기록 저장 확인
