# 0. 다음 우선순위
- [ ] 0-0순위: `faster-whisper` CPU 비정상 지연 원인 복구
  - 현재 15초 샘플이 600초대까지 늘어나는 현상은 정상 동작이 아니므로, 더 작은 모델로 우회하지 말고 원인을 먼저 복구한다.
  - 빌드 전 게이트는 `로컬 웹 /api/analyze`가 `faster-whisper-large-v3 + cpu + diarization off` 기준으로 다시 실용 속도로 끝나는지로 잡는다.
  - 우선 확인 범위:
    - `ctranslate2` / `faster_whisper` import 지연
    - Python 3.11 앱 런타임과 별도 ASR 런타임 차이
    - Windows OpenMP / DLL 충돌 가능성
    - 손상된 venv 또는 패키지 설치 상태
  - 전체 앱을 새로 만들기 전에, ASR 런타임(venv/패키지)만 분리 재구성해서 재현 여부를 먼저 확인한다.
- [ ] 0-0-1순위: 푸시 안전 기준 정리
  - 현재처럼 워크트리가 많이 더러운 상태에서는 `main`에 바로 푸시하지 않는다.
  - 내가 작업한 파일만 별도 브랜치에서 선별 커밋 후 푸시한다.
  - 빌드 전 검증 작업과 기능 개발 변경이 섞여 있으면 푸시 단위를 먼저 분리한다.
- [ ] 0순위: 배포 혼돈 방지 기준 유지
  - 새 portable 배포는 `scripts\release_portable.ps1`로만 갱신한다.
  - 실제 실행 기준은 루트 `Smart Minutes AI` 폴더 하나로 고정한다.
  - `desktop-app\src-tauri\target\release\portable\Smart Minutes AI`는 중간 산출물로만 본다.
  - 이상 상태가 보이면 `scripts\diagnose_portable.ps1` 결과와 `release-manifest.json` 해시를 먼저 확인한다.
  - `release-manifest.json`은 배포본의 신분증이다. verify/diagnose에서 해시 불일치를 확인한다.
  - WebView 캐시는 필요할 때 렌더 캐시만 지우고 IndexedDB 회의 기록은 보존한다.
- [ ] 1순위: 회사 PC 기준 portable 폴더 테스트
  - `Smart Minutes AI` 폴더 전체를 옮긴 뒤 실행한다. `Smart Minutes AI.exe`만 따로 빼서 실행하지 않는다.
  - 기본 음성 인식 모델은 `Smart Minutes AI\models` 바로 아래에 복사한다.
  - 복사 후 `models\config.json`, `models\model.safetensors`, `models\preprocessor_config.json`, `models\tokenizer_config.json`가 바로 보여야 한다.
  - 화자 분리 모델은 `models\config.yaml`, `models\embedding`, `models\segmentation`, `models\plda`가 있으면 된다.
- [ ] 2순위: 긴 파일 실전 테스트
  - 30분, 1시간, 2시간, 5시간 파일로 처리 시간, 임시 파일 용량, 메모리, 실패 여부를 기록한다.
  - 결과는 `Smart Minutes AI\backend\outputs`, 임시 파일은 `Smart Minutes AI\backend\temp`에 생성된다.
  - 실패 시 `Smart Minutes AI\logs\analysis.log`, `sidecar.stderr.log`를 확인해 원인을 남긴다.
- [ ] 3순위: 품질 기준 샘플셋 만들기
  - 6~10개 샘플을 구성한다: 깨끗한 음성, 잡음 많은 음성, 작은 목소리, 다화자, 긴 회의, 영상 MP4.
  - STT 정확도, 화자 분리 정합성, 요약 품질, 처리 시간을 같은 표로 비교한다.
- [ ] 3-1순위: 내보내기 파일 실사용 검증
  - HWPX는 zip/XML 생성 smoke test뿐 아니라 한글 또는 HWPX 뷰어에서 실제 열기 검증을 한다.
  - Codex 자동 테스트로는 HWPX 구조와 XML 파싱까지만 확인했다. 한글/뷰어에서 직접 열기, 본문 표시, 서식 깨짐 여부는 사람이 확인해야 한다.
  - 화면에서 제목/일시/참석자를 수정한 뒤 HWPX, MD, TXT, DOCX 다운로드 내용도 같은 값으로 반영되는지 확인한다.
- [ ] 4순위: 전처리 품질 개선 순서대로 검증
  - 이미 적용됨: WAV 표준화, 긴 파일 청크, 자동 볼륨 정규화.
  - 다음 후보: AGC/`speechnorm` 자동 게인 보정, 무음 제거, 음성 강화, denoise.
  - denoise는 한국어 자음/말끝 손실 위험이 있어 마지막에 별도 검증한다.
- [ ] 5순위: 실패/취소 UX 개선
  - 분석 중 취소, 실패한 청크만 재시도, partial result 저장, 임시 파일 정리를 추가한다.
- [ ] 6순위: 최종 배포 zip 재생성
  - 모델 미포함/포함 기준을 명확히 하고, 회사 PC용 설명 md와 함께 다시 묶는다.

# 0-1. 회사 PC에서 가장 먼저 할 일
- [ ] `Smart Minutes AI` 폴더 전체를 그대로 둔다. `Smart Minutes AI.exe`만 따로 빼서 실행하지 않는다.
- [ ] 기본 음성 인식 모델은 별도로 받아서 `Smart Minutes AI\models` 바로 아래에 복사한다.
- [ ] 복사 후 아래 파일들이 바로 보여야 한다: `models\config.json`, `models\model.safetensors`, `models\preprocessor_config.json`, `models\tokenizer_config.json`.
- [ ] 화자 분리 모델은 portable zip에 포함되어 있으므로 별도 다운로드하지 않는다. `models\config.yaml`, `models\embedding`, `models\segmentation`, `models\plda`가 있으면 된다.
- [ ] 앱 실행 후 시스템 설정 > 모델에서 누락 모델이 있는지 확인하고, 모델 복사 후 상태 새로고침을 누른다.
- [x] 앱 안의 사용자용 모델 자동 다운로드 흐름을 제거하고, 관리자가 지정한 모델 파일을 `models`에 넣는 방식으로 정리한다.
- [ ] 루트 정리 기준을 유지한다: 실제 실행 폴더는 `Smart Minutes AI` 하나이고, `target`, `dist`, `build`, `dist-sidecar`, `outputs`, 테스트 MP4, 임시 zip은 빌드/테스트 후 삭제 가능하다.

# 📝 스마트 회의록 시스템 TO-DO (Next Steps)

## 1. 프론트엔드 연동 및 메타데이터 지원
- [x] 파일 업로드 시 회의록 메타데이터(회의 제목, 날짜, 참석자 등) 입력 폼 추가
- [x] 입력받은 메타데이터를 백엔드 API로 전달하고 최종 결과에 반영 (API Fetch/FormData 연동 완료)
- [x] 백엔드의 진행률(progress) 데이터를 실시간으로 UI의 프로그레스 바에 연동 (SSE 스트리밍 적용 완료)
- [x] 분석 모드 선택 추가: 빠른 테스트(Mock)와 실제 로컬 분석(mode=real) API 계약 분리

## 2. 모델 및 환경 자동화 (오프라인 배포 준비)
- [x] 사용자용 자동 모델 다운로드 흐름 제거
- [ ] 관리자가 준비한 모델 묶음을 `Smart Minutes AI\models`에 복사하는 배포 절차 확정
- [ ] 내부망 이관 후 모델 묶음 배포 위치와 파일 검증 절차 정리

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

## 4-1. 오디오 전처리 품질 개선
- [ ] 0순위: STT 품질 회귀 재현 및 원인 분리
  - 사용자가 품질 저하를 느낀 실제 파일 1개를 기준 샘플에 추가한다.
  - 현재 기본값, 전처리 off, `noise_gate=false`, 청크 60초/90초를 같은 파일로 비교한다.
  - STT 원문 문제와 화자 정렬 문제를 분리해서 본다.
  - 2026-05-07 1차 확인: `noise_gate=false`, 긴 파일 STT 청크 90초가 같은 샘플에서 더 안정적이었다.
  - 2026-05-07 추가 확인: Cohere 전처리 제거 90초 비교에서 raw/off 한글 비율 47.4%, `auto_no_gate` 54.3%, `noise_gate_on` 45.8%. 전처리 제거만으로 Cohere 품질 문제는 해결되지 않음.
- [ ] 0순위: `noise_gate` 기본 적용 여부 재검토
  - 방송 오프닝 샘플에는 효과가 있었지만 실제 회의/작은 목소리에서 회귀 가능성이 있다.
  - 비교가 끝날 때까지 기본 회의 인식에서는 끄는 방향을 우선 검토한다. 2026-05-07 설정 기본값은 `false`로 변경했다.
- [x] 현재 전처리 현황 문서화 (`docs/audio-preprocessing-notes.md`)
- [x] 오디오 전처리 테스트 계획 문서화 (`docs/audio-preprocessing-test-plan.md`)
- [x] 성능 개선 작업 로그와 시행착오 기록 문서화 (`docs/audio-performance-improvement-log.md`)
- [x] `backend/pipeline/audio_preprocess.py`에 선택형 볼륨 정규화(normalize) 1차 적용
- [x] 입력 음량 측정 기반 `auto normalization` 1차 적용
- [x] 테스트셋 1차 manifest 구성 (`docs/audio-testset-manifest.csv`, 현재 4개 영상)
- [ ] 테스트셋 보강 (6~10개, 실제 작은 목소리/잡음/기기/길이 편차 포함)
- [ ] `off / auto / loudnorm` 기준 Cohere STT / diarization / summary 비교 검증
- [x] `speechnorm` 선택형 모드 추가
- [x] `speechnorm` 60초 샘플 1차 비교
- [x] `Smart Minutes AI\video` 폴더 4개 영상 60초 비교
- [x] 성능 비교 자동화 스크립트 추가 (`scripts/run_audio_performance_eval.py`)
- [x] 성능 비교 스크립트에 `off` 기준, portable 모델 경로 탐색, 긴 파일 전체 후보 선택, `--clean` 옵션 반영
- [x] 성능 비교 스크립트에 manifest 기반 테스트셋 실행 옵션 추가 (`--manifest docs\audio-testset-manifest.csv`)
- [x] `speechnorm` 작은 목소리/잡음 변형 샘플 1차 비교
- [ ] 실제 작은 목소리/잡음 원본 샘플 추가 비교
- [ ] AGC 자동 게인 보정 후보 검토
  - ffmpeg `speechnorm` 선택형 모드 추가 완료, 샘플 비교 필요
  - ffmpeg `dynaudnorm`
  - 작은 목소리 보정 효과와 잡음 증폭 부작용 비교
- [ ] 대체 STT 모델 비교 검토
  - faster-whisper-large-v3
  - Qwen3-ASR 계열
  - WhisperX 계열
  - 비교 기준: timestamp 구조, diarization 정합성, 한국어 회의 정확도, 처리시간, 로컬 배포 난이도
  - 2026-05-07 확인: 현재 로컬에는 faster-whisper 라이브러리만 있고 `large-v3` 모델 파일은 없음. Cohere는 90초 샘플 후반부에서 로마자식 한국어 전사가 남음.
  - 2026-05-07 추가 확인: `faster-whisper-large-v3` 모델 파일을 받았고 CPU int8/beam1 30초 테스트는 15.45초, 한글 비율 98.8%로 성공.
  - 2026-05-07 추가 확인: 같은 조건의 90초 테스트는 213.86초, 한글 비율 99.7%로 품질은 좋지만 처리 속도가 느림.
  - 2026-05-07 추가 확인: `Qwen3-ASR-1.7B` CPU 90초 테스트는 123.64초, 한글 비율 99.6%로 성공. 기본 결과는 1개 텍스트 세그먼트라 화자 정렬에는 ForcedAligner/문장 병합 검토가 필요.
  - 2026-05-07 추가 확인: `Qwen3-ASR-1.7B + Qwen3-ForcedAligner-0.6B` CPU 30초 테스트는 58.07초, 75개 timestamp segment 생성.
- [ ] 포터블 앱 모델 폴더 구조 정리
  - `models/stt/cohere-transcribe-03-2026`
  - `models/stt/faster-whisper-large-v3`
  - `models/stt/Qwen3-ASR-1.7B`
  - `models/aligner/Qwen3-ForcedAligner-0.6B`
  - 사용자에게 보이는 포터블 폴더와 백엔드 설정 경로를 일치시킨다.
- [ ] Qwen3-ASR vs faster-whisper 최종 후보 테스트
  - 테스트 계획: `docs/qwen-vs-faster-whisper-test-plan.md`
  - 먼저 Qwen ForcedAligner 결과를 문장/발화 단위로 병합하는 최소 구현이 필요하다.
  - 2026-05-07 준비: `merge_aligner_segments_to_utterances()` 초안과 단위 테스트 추가. Qwen aligner 30초 결과는 75개 raw segment에서 6개 발화 segment로 병합됨.
  - 남은 확인: Qwen aligner 텍스트가 단어/형태소처럼 쪼개지는 문제를 회의록 UI에서 허용할지, 원문 텍스트 기반으로 문장 복원할지 결정한다.
  - 2026-05-07 90초 구조 검증: Qwen 병합은 213개 raw segment를 19개 발화 segment로 병합. faster-whisper는 38개 segment로 자연스럽지만 후반 반복 문장이 보임. Qwen은 반복은 적지만 띄어쓰기/형태소 분리 텍스트가 UI 리스크.
  - 2026-05-07 원문 복원 병합 확인: Qwen timestamp 그룹에 전체 전사 원문을 분배해 `마쳤 습니다` 같은 형태소 분리 표시는 해소. 90초 결과는 19개 segment, 한글 비율 99.6%, 처리 시간 209.38초.
  - 남은 확인: Qwen 내부 정렬용 segment와 사용자 표시용 문장 segment를 분리할지 검토한다.
  - 2026-05-07 표시용 segment 준비: Qwen 벤치마크 결과에 `display_segments` 추가. 90초 결과는 내부 19개, 표시 15개 segment. 표시용 시간은 근사값이므로 화자 정렬에는 쓰지 않는다.
  - 2026-05-07 화자 정렬 확인: Qwen 내부 19개 segment를 pyannote 22개 speaker segment와 정렬. 진행자/발언자 구간은 대체로 분리됐지만 짧은 끼어들기 구간에서는 한 segment 안에 화자가 섞일 수 있음.
  - 2026-05-07 speaker overlap 재분할 플래그 추가. 이번 90초 샘플은 내부 segment가 이미 짧아 추가 분할은 거의 없었고, 남은 문제는 원문 텍스트를 시간 그룹에 배분할 때 speaker boundary를 고려해야 하는 쪽으로 확인됨.
  - 2026-05-07 `test (4).mp4` 90초 비교: Qwen은 224.76초/한글 100%/내부 17개/표시 36개, faster-whisper는 62.56초/한글 99.2%/segment 38개. 이 샘플에서는 faster-whisper가 더 빠르고 발화 경계가 자연스러움.
  - 2026-05-07 `test (1).mp4` 90초 비교: Qwen은 약 276초/내부 23개/표시 47개, faster-whisper는 약 71초/segment 41개. 두 번째 실제 대화 샘플에서도 faster-whisper가 더 실용적.
- [x] 무음 제거는 ffmpeg `silenceremove` 후보로 60초 샘플 1차 비교
- [ ] 무음 제거 청취 검증 및 실제 회의 샘플 추가 비교
- [ ] 음성 강화(speech enhancement)는 별도 후보 모델/라이브러리 조사 후 실험 여부 결정
- [x] denoise는 ffmpeg `afftdn` 후보로 60초 샘플 1차 비교
- [ ] denoise 청취 검증 및 실제 잡음 샘플 추가 비교
- [ ] 전처리 on/off에 따른 Cohere STT / diarization / summary 품질 비교 샘플셋 정리
- [ ] 사용자 설정 UI에 전처리 옵션 추가
  - 자동
  - 끔
  - 표준 정규화(`loudnorm`)
  - 동적 정규화(`dynaudnorm`)
  - 고급 옵션은 기본 숨김 처리 검토
- [ ] 사용자에게 현재 적용된 전처리 모드와 자동 선택 결과를 분석 화면/결과 메타데이터에 표시

## 5. 대용량 음성/영상 처리
- [x] 영상 파일 업로드 시 ffmpeg로 음성 트랙만 추출하고 원본 영상은 설정에 따라 보관/삭제
- [x] 긴 음성 파일을 시간 기준 청크(예: 10~15분)로 분할해 STT 메모리 사용량을 제한하는 백엔드 뼈대 추가
- [x] 청크별 STT 결과를 타임스탬프 오프셋으로 병합하는 기본 유틸 추가
- [x] 청크별 진행률을 SSE로 전송해 사용자가 긴 파일 처리 상태를 확인할 수 있게 개선
- [x] 30분 파일 전처리/청크 생성 시간과 임시 용량 기록
- [ ] 1시간/2시간/5시간 파일 실전 테스트로 처리 시간과 임시 용량 기록
- [ ] 실패한 청크만 재시도할 수 있도록 임시 작업 상태와 partial result 저장

## 6. 2026-04-26 Agent Review Notes
- [x] Cohere Transcribe, Pyannote Community-1, Ollama Gemma 준비 상태 확인 및 Cohere 데모 음성 STT 검증
- [x] Ollama 실행 파일을 PATH 없이도 찾도록 백엔드 자동 탐색 추가
- [x] 모델 폴더가 일부만 다운로드된 상태를 설치 완료로 오판하지 않도록 모델 payload 검사 강화
- [x] 1순위: Cohere STT 결과를 화자 분리와 맞게 더 작은 시간 조각으로 만들기
  - 공식 `model.transcribe()` long-form 경로로 장문 한국어 품질을 개선
  - Cohere가 정확한 단어 타임스탬프를 제공하지 않으므로 텍스트 길이 기반 추정 세그먼트를 생성
  - 추정 세그먼트가 여러 화자 구간과 겹치면 overlap 비중에 따라 텍스트를 나눠 화자 정렬
  - API/UI에 `timingApproximate`를 전달해 시간표가 추정값임을 표시
- [ ] Cohere 장문 STT 품질 후속 개선
  - 현재 일부 구간에서 로마자/영어식 오인식이 남는다.
  - 공식 문서, 모델 옵션, 언어 프롬프트, 후처리 전략을 추가 검토한다.
  - 필요하면 faster-whisper/Whisper 계열과 품질 비교 테스트 세트를 만든다.
- [ ] 모델/의존성 설치 재현성 개선
  - requirements.txt에 Cohere 실행에 필요한 librosa, soundfile, sentencepiece, protobuf 반영
  - Python venv 런처와 네이티브 패키지 버전 정리 필요
- [x] 데스크탑 패키징 설계 1차 정리
  - 내부 분석 기능은 빈 로컬 포트를 자동 할당하고 Tauri command로 UI에 전달
  - sidecar 터미널 노출 방지, 로그 파일 저장, ffmpeg/model 경로 기준 정리
- [ ] 데스크탑 패키징 후속 안정화
  - 새 portable zip 생성 후 회사 PC와 유사한 경로에서 재검증
  - 모델 미포함 배포와 모델 포함 배포 기준을 문서화
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
