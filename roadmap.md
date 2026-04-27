# 🚀 스마트 회의록 시스템 로드맵 (Roadmap)

## 🎯 Phase 1: 기반 구축 (현재)
- [x] AI 기반 음성/영상 오디오 추출 및 텍스트 변환 (STT)
- [x] 핵심 요약 및 결정 사항 자동 추출
- [x] 프리미엄 디자인 시스템 (Tailwind v4, Glassmorphism) 적용
- [x] 라이트/다크 모드 및 멀티 포맷 다운로드 지원

## 🔥 Phase 2: 실시간 지능 고도화 (Next)
- [ ] **실시간 음성 인식 (Live Transcription)**: 회의 진행 중 실시간으로 대화 내용이 텍스트로 노출
- [ ] **실시간 요약 및 인사이트**: 회의 중 실시간으로 논의 주제를 파악하고 중간 요약 제공
- [ ] **참여자 감정 분석**: 회의 분위기와 참여자들의 긍정/부정 뉘앙스 파악
- [ ] **멀티 디바이스 연동**: 모바일과 데스크탑 간의 실시간 회의 동기화

## 💎 Phase 3: 엔터프라이즈 확장 & 지능형 아카이브
- [ ] **회의록 데이터베이스(DB) 구축**: 과거 모든 회의 데이터를 체계적으로 저장 및 관리
- [ ] **RAG (Retrieval-Augmented Generation)**: "지난번 회의에서 A에 대해 뭐라고 했지?"와 같은 질문에 AI가 과거 기록을 찾아 답변
- [ ] **팀 프로젝트 및 히스토리 관리**: 팀 단위 권한 관리 및 히스토리 추적
- [ ] **외부 협업 툴 연동**: Notion, Slack, Jira 자동 연동

## 🖥️ Desktop Packaging Notes
- [x] **Portable 배포 채택**: Cohere 모델의 대용량 파일 때문에 MSI/NSIS 설치 파일 대신 portable 폴더 배포를 기본으로 사용한다.
- [x] **회사 전달용 no-Cohere 패키지 생성**: 앱, 백엔드 sidecar, Pyannote 모델은 포함하고 Cohere STT 모델은 회사 PC에서 별도 다운로드한다.
- [ ] **no-Cohere 패키지 재생성 주의**: 최신 PyInstaller 백엔드 sidecar 자체가 약 3.45GB라 Cohere 모델을 제외해도 메일 첨부용으로는 부적합하다. 회사 전달은 USB, 사내 파일 공유, 외장 저장소를 기본 경로로 잡는다.
- [ ] **Portable 압축 해제 위치 안내**: `Program Files`처럼 쓰기 권한이 엄격한 위치가 아니라 `문서\Smart Minutes AI`, 바탕화면, 또는 사용자 쓰기 가능한 업무 폴더에 압축 해제한다.
- [ ] **Cohere 모델 배치 안내 유지**: 회사 PC에서 `Smart Minutes AI\backend\models\stt\cohere-transcribe-03-2026\model.safetensors` 경로가 존재해야 실제 분석이 가능하다.
- [ ] **AppData 저장소 분리**: 향후 설치형 배포를 지원하려면 `config.json`, `outputs`, `temp`를 앱 리소스 폴더가 아니라 사용자 쓰기 가능한 AppData/localData 경로로 분리한다.
- [ ] **로컬 API 보안 개선**: 현재는 `127.0.0.1:8000` 고정 포트를 사용한다. 포트 충돌과 로컬 호출 오용을 줄이기 위해 랜덤 포트와 세션 토큰 구조를 검토한다.
- [ ] **라이선스/고지 정리**: Cohere, Pyannote, Gemma/Ollama, FFmpeg 및 Python/npm/cargo 의존성에 대한 배포 고지와 라이선스 문서를 릴리스 전에 정리한다.
- [ ] **SQLite 저장소 전환**: IndexedDB 히스토리는 MVP용이다. 데스크탑 앱에서는 SQLite 기반의 영구 저장소로 이전한다.
