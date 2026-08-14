# 웹 우선 로컬 엔진 실행 계획

- 결정일: 2026-07-28
- 방향 갱신: 2026-08-13
- 상태: 현재 우선 제품 방향. 공통 React UI를 웹 제품으로 먼저 완성한다.
- 착수 조건: 데스크톱 앱 완료가 선행 조건이 아니다. 웹 UI와 로컬 엔진의 최소 연결·보안 계약부터 검증한다.
- 첫 웹 제품: HTTPS 웹 UI + 사용자가 한 번 내려받는 Windows 로컬 엔진
- 후속 제품: Windows Tauri 데스크톱 앱은 웹 MVP 이후 별도 범위로 검토한다.
- 세부 구현 순서와 완료 기준: `docs/web-runtime-separation-implementation-plan.md`

## 1. 제품 결정

첫 웹 버전은 여러 실행 방식을 동시에 제공하지 않는다.

현재 사용자에게 제공할 제품 표면은 웹사이트다. `LMO Local Engine Setup.exe`는
웹 기능을 각 PC에서 로컬로 실행하기 위한 백그라운드 분석 구성요소이며,
별도의 데스크톱 앱 화면으로 취급하지 않는다.

사용자가 웹에 접속한 뒤 LMO Local Engine Setup.exe 하나를 내려받아 현재 사용자 영역에 설치하고, 이후 음성 인식·영상 오디오 추출·참석자 구분·AI 정리는 사용자 PC에서 실행하는 구조를 선택한다.

    HTTPS 웹 UI
          |
          | Chrome/Edge Local Network Access 승인
          v
    127.0.0.1:17863 로컬 엔진
          +-- native ffmpeg
          +-- faster-whisper
          +-- 선택형 pyannote
          +-- 앱 관리 Ollama
          +-- 로컬 모델·SQLite·결과 파일

서버는 React UI, 설치 파일, 서명된 업데이트 manifest와 모델 manifest를 배포한다. 사용자가 선택한 음성·영상과 생성된 대화록은 기본적으로 원격 분석 서버로 전송하지 않는다.

## 2. 이 방향을 선택한 이유

### 현재 코드 재사용

- Tauri 앱은 이미 외부 Python 백엔드 sidecar를 포함하고 앱 시작 시 자동 실행한다.
- React UI는 VITE_API_BASE_URL과 loopback API를 사용할 수 있다.
- native ffmpeg, faster-whisper large-v3, 선택형 pyannote, 앱 관리 Ollama 경로를 그대로 발전시킬 수 있다.
- 순수 BrowserEngine을 새로 만드는 것보다 데스크톱과 결과 품질·기능을 맞추기 쉽다.

### 2026년 기술 확인

- Tauri 2는 Python API 서버 같은 외부 바이너리를 sidecar로 묶는 방식을 공식 지원한다.
- Tauri의 Windows NSIS 설치는 기본적으로 현재 사용자 영역 %LOCALAPPDATA%에 설치되어 관리자 권한이 필요하지 않는다.
- Tauri autostart 플러그인은 Windows 시작 시 앱 자동 실행을 지원한다.
- Chrome 142부터 공개 HTTPS 사이트가 loopback 주소에 연결할 때 Local Network Access 권한 승인이 필요하다. 최초 연결 안내와 권한 거부 복구 UX가 필수다.
- Ollama는 기본적으로 loopback HTTP API로 동작한다. 웹 UI가 Ollama에 직접 접근하지 않고 로컬 엔진이 인증된 프록시 역할을 맡는다.

순수 브라우저 실행도 기술적으로 가능하다. ONNX Runtime Web은 WASM과 WebGPU 실행을 제공하고 Transformers.js와 whisper.cpp는 브라우저 Whisper 예제를 제공한다. 그러나 브라우저·GPU 편차, 큰 모델 메모리, 영상 코덱, 탭 생명주기, 화자 구분 이식 비용 때문에 첫 웹 제품으로 선택하지 않는다. 기존 실측과 설계는 후순위 무설치 제품 후보의 근거로 보존한다.

## 3. 사용자 흐름

1. 사용자가 HTTPS 웹사이트에 접속한다.
2. 첫 방문에서는 연결 안내를 읽고 `로컬 엔진 연결`을 눌러 Chrome/Edge의 Local Network Access 승인을 시작한다. 이미 권한·pairing된 브라우저만 자동 재연결한다.
3. 웹 UI가 127.0.0.1:17863의 공개 probe로 제품 식별자와 API 계약을 확인한다.
4. 연결할 수 없으면 `로컬 엔진 받기`를 주 CTA로 보여 주고, 실행 후 다시 연결과 문제 해결은 보조 동작으로 제공한다. 이 상태만으로 미설치를 단정하지 않는다.
5. 사용자가 코드 서명된 NSIS 설치 파일을 내려받아 현재 사용자 영역에 설치하고 로컬 엔진을 실행한다.
6. 설치 완료 화면이나 시작 메뉴의 `바로록 연결` helper가 origin과 일회성 코드를 표시하고 사용자가 웹에 입력해 최초 pairing을 승인한다.
7. 웹 UI는 짧은 수명의 세션 토큰으로 인증하고 만료·폐기 시 재pairing을 안내한다.
8. 첫 분석 전에 필요한 STT 모델의 크기와 저장 위치를 보여 주고 기존 로컬 엔진 다운로드 기능을 사용한다.
9. 요약 기능을 처음 사용할 때만 앱 관리 Ollama runtime과 선택한 요약 모델을 별도로 받는다.
10. 음성·영상 분석, 중지·이어하기, 내보내기는 로컬 엔진에서 수행한다.

초기 Windows 웹 MVP에서는 설치형과 portable 엔진을 동시에 제공하지 않는다. 자동 시작·업데이트·장애 복구가 일관된 현재 사용자 단위 NSIS 설치형만 제공한다.

## 4. 패키지와 업데이트 원칙

- 설치 파일은 Windows 코드 서명을 적용한다. 브라우저에서 받은 서명되지 않은 실행 파일은 SmartScreen 경고와 회사 보안 차단 가능성이 크다.
- 엔진 본체, ffmpeg, Python sidecar는 설치 파일에 포함한다.
- STT·화자 구분·요약 모델은 설치 파일에서 분리하고 필요할 때만 받는다.
- 모든 엔진·모델 manifest에는 버전, 크기, SHA-256, 다운로드 URL을 고정한다.
- 대용량 다운로드는 진행률, 남은 시간, 중지, 이어받기, 해시 검증을 지원한다.
- 엔진 업데이트는 서명된 update manifest를 검증한 뒤 적용하고 모델과 사용자 데이터는 보존한다.

현재 저장 크기의 기준값은 구현 시 다시 측정한다. 2026-07-28 개발 산출물은 backend sidecar 약 72MB, backend 리소스 약 203MB이고, 현재 large-v3 STT 모델 registry 값은 약 3.1GB다. 이 값은 최종 설치 파일 용량 약속이 아니다.

## 5. 보안 경계

- 로컬 엔진은 127.0.0.1에만 bind하고 LAN이나 공인 주소에 노출하지 않는다.
- 허용 origin은 런타임별 exact allowlist로 관리한다. 웹 로컬 엔진은 실제 배포 HTTPS origin만, Tauri sidecar는 고정 Tauri origin만 허용하고 localhost는 개발 모드에만 둔다. wildcard origin은 사용하지 않는다.
- CORS는 인증이 아니다. 설치별 비밀값, 일회성 pairing, 짧은 수명의 세션 토큰을 별도로 적용한다.
- 공개 probe와 Origin 검증을 통과한 pairing endpoint 외 모든 `/api/**` 읽기·쓰기·SSE·결과·다운로드는 기본 인증한다.
- 웹 UI는 Ollama 11434 포트에 직접 연결하지 않고 로컬 엔진을 통해 제한된 생성 기능만 호출한다.
- 다운로드 manifest와 실행 파일 서명 검증 실패는 우회하지 않는다.
- 로그에는 음성 원문, 전체 대화록, pairing 비밀값을 기록하지 않는다.

## 6. 저장과 소유권

- 웹 origin별 IndexedDB만을 영구 기록의 단일 원본으로 사용하지 않는다.
- 웹 제품에서는 로컬 엔진 SQLite만 기준 저장소(canonical storage)로 두고 React UI는 API를 통해 조회·수정한다. 결과 JSON, HWPX와 다른 파일은 SQLite revision에서 재생성 가능한 파생 산출물이다.
- 데스크톱 MeetingRecord, backend 결과 JSON, /sync-record, /export-record 계약을 먼저 정리한 뒤 같은 저장 계약을 웹에서 재사용한다.
- 브라우저 캐시 삭제, 다른 브라우저 사용, 웹 origin 변경 후에도 로컬 회의 기록이 남아 있어야 한다.

## 7. 웹 우선 착수 게이트

웹 구현은 데스크톱 portable 완료를 기다리지 않는다. 다음 최소 조건을
순서대로 닫으면서 진행한다.

1. 공통 React UI의 `build:web`, typecheck와 관련 Playwright 시뮬레이션이 통과한다.
2. 웹 UI가 로컬 엔진 연결 불가·설치 안내·연결됨·업데이트 필요 상태를 과장 없이 구분한다.
3. loopback 연결, exact origin allowlist, pairing과 세션 인증의 최소 PoC가 통과한다.
4. 음성·영상 파일이 원격 서비스로 전송되지 않는 것을 네트워크 수준에서 확인한다.
5. STT 모델을 필요한 시점에 내려받고 중지·이어받기·해시 검증할 수 있다.
6. 로컬 엔진 SQLite를 웹 회의 기록의 유일한 기준 저장소로 확정하고 결과 파일은 파생 산출물로 재생성한다.

브라우저에서 React 화면이 열린다는 사실만으로 웹 MVP가 완성된 것으로 보지
않는다. 실제 로컬 엔진 설치·연결·분석·복구·다운로드까지 확인한다.

## 8. 웹 구현 순서

아래는 제품 단계의 요약이다. 코드 경계, 기존 기능 재사용 목록, 상태 모델,
검증 행렬은 `docs/web-runtime-separation-implementation-plan.md`를 기준으로 한다.
상위 단계는 제품 출시 게이트이고 세부 문서의 단계는 코드 작업 순서다.
설치·연결 UX를 실제 사용자에게 배포하기 전에 공개 probe, exact origin과
pairing/session 최소 PoC를 먼저 통과한다.

### 0단계: 로컬 엔진 분리 PoC

- 현재 Python backend와 배포 자산에서 창 없는 로컬 엔진 패키지를 분리한다.
- 고정 loopback 포트, single instance, health, 종료·재시작을 검증한다.
- 현재 데스크톱과 같은 60초 음성 파일의 결과·시간을 비교한다.

### 0.5A단계: 사용자 PC 호환성 기준

- 첫 공식 지원 후보를 Windows 11 x64와 최신 stable Chrome·Edge로 제한하고,
  Windows 10 x64·Windows 11 ARM64는 실제 설치·분석 증거 전까지 미지원 후보로 둔다.
- 저사양 CPU-only, 일반 CPU-only, NVIDIA GPU에서 최소·권장 CPU·RAM·여유 디스크와
  대표 파일 길이별 예상 처리시간을 정한다.
- 프록시·오프라인·Defender·SmartScreen·조직 EDR·관리 브라우저, 한글·긴 경로,
  디스크 부족, 포트 충돌, 절전·재개와 다중 Windows 사용자를 검증 행렬에 포함한다.
- 설치 전에 환경·모델·저장 공간·포트·브라우저 권한을 구분해 확인하고,
  지원 요청에는 token·코드·대화록을 제외한 진단 자료만 제공하도록 한다.
- 첫 MVP는 한 PC의 한 활성 Windows 사용자 세션만 지원한다. 다중 사용자·RDP
  동시 사용은 고정 포트 발견 계약을 바꾸고 별도 검증하기 전에는 지원하지 않는다.

### 0.5B단계: 단계별 자동 점검

- 웹은 설치 전에 지원 OS·브라우저 안내만 하고 RAM·디스크·GPU를 추측하지 않는다.
- host system preflight는 OS·workstation·native architecture·RAM만 확인한다.
- installer target preflight는 실제 설치·모델·임시·결과 볼륨 공간,
  LocalAppData 쓰기와 포트 상태를 확인한다.
- 엔진 시작 뒤에는 ffmpeg·native dependency·모델·Ollama와 GPU 가속 후보를,
  실제 HTTPS 웹에서는 Local Network Access·pairing·version을 확인한다.
- 분석 직전에는 현재 파일과 모델을 기준으로 temp·results 공간과 예상 처리 부담을
  다시 확인한다.
- 자동 점검은 `pass`, `warning`, `blocked`, `unknown`을 구분한다. 확실한 미지원과
  현재 작업을 수행할 수 없는 조건만 막고, 느린 환경은 예상 지연과 계속 진행을
  제공하며, 확인 불가는 실패로 단정하지 않는다.
- 모든 경고에는 다시 확인·공간 확보·권한 확인·관리자 요청·진단 내보내기 중
  가능한 다음 행동을 제공하고 보안 기능 해제나 강제 프로세스 종료를 권하지 않는다.
- 2026-08-14 현재 host system과 installer target preflight의 versioned JSON,
  Windows source·frozen 실행 검증을 완료했다. 이어서 NSIS가 artifact manifest의 확정
  byte 요구량과 결과 action을 소비하는 current-user installer 소스, Start Menu 동작,
  same-volume stage·rollback과 선언 파일 기반 정리 계약까지 작성하고 좁은 테스트를
  통과했다. 모델·temp·results 권장량은 추측하지 않고 후속 실측 전까지 `unknown`으로 둔다.
- 모델 제외 frozen payload도 Python 분석 runtime과 native dependency 때문에 현재
  1,117,850,125 bytes(4,887 files, 약 1.04 GiB)다. 회사 PC에서는 이를 다시 build하거나
  설치하지 않았으며, 실제 helper/NSIS compile과 fresh install·update·중단 복구·uninstall
  smoke는 집 PC 관문으로 남긴다. 외부 배포 전에는 기능 회귀를 동반한 payload slimming과
  코드 서명을 별도로 닫아야 한다.

### 1단계: 설치·연결·보안

- 현재 사용자 단위 NSIS 설치와 명시적 autostart 설정
- Windows 코드 서명
- HTTPS 배포 origin exact allowlist
- Local Network Access 승인·거부·재승인 UX
- 설치별 pairing과 API 인증
- 서명된 엔진 업데이트

### 2단계: 웹 회의록 MVP

- 같은 React UI의 웹 빌드
- 로컬 엔진 상태·버전·업데이트 표시
- 파일 분석 SSE, 중지·이어하기
- 모델 받기와 상태 관리
- SQLite 회의 기록 조회·편집·내보내기
- 회의·결정·할 일 통합 검색과 원래 회의록 이동
- 브라우저 새로고침·재접속 복구

### 3단계: 웹 기능 확장

- 선택형 참석자 구분
- 전체·주제별·참석자별 정리
- MD/TXT/DOCX/HWPX 내보내기
- 결정 일시·상태·근거 발언·후속 변경을 구조화한 결정 이력
- 근거 회의와 발언 시각을 함께 보여 주는 회의 간 질문
- 실제 30분·60분·장시간 영상 검증
- 회사 Chrome/Edge 정책과 백신 환경 검증

### 별도 후속: 내부망 HWPX 문서 작업

- 기록 찾기에서 사용자가 확인한 회의·결정·할 일을 보도자료, 결과보고서, 기관 회의록 초안의 입력으로 사용한다.
- HWPX 템플릿 매핑과 문서 생성부터 먼저 안정화하고, 편집기·미리보기·저장·재열기는 별도 작업으로 설계한다.
- 생성 문서에는 원 회의록과 근거 발언을 추적할 수 있는 내부 출처 정보를 유지한다.
- 이 작업은 웹 회의록 MVP와 동시에 구현하지 않으며, 로컬 SQLite 저장 계약과 결정 데이터 구조화 이후 진행한다.

## 9. 보류 항목

- 순수 WASM/WebGPU BrowserEngine
- WebLLM 기반 브라우저 요약
- remote SaaS 분석
- 모바일·PWA
- portable 로컬 엔진
- 여러 운영체제 지원
- Windows Tauri 데스크톱 앱 제품화와 portable 배포
- 내부망 HWPX 편집기와 보도자료 생성

이 항목들은 첫 웹 MVP와 병행하지 않는다. Windows 로컬 엔진 웹 제품을 검증한 뒤 별도 제품 결정을 거쳐 활성화한다.

## 10. 2026-07-28 공식 자료

- Tauri external binaries: https://v2.tauri.app/develop/sidecar/
- Tauri Windows installer: https://v2.tauri.app/distribute/windows-installer/
- Tauri autostart: https://v2.tauri.app/plugin/autostart/
- Tauri Windows code signing: https://v2.tauri.app/distribute/sign/windows/
- Tauri updater: https://v2.tauri.app/plugin/updater/
- Chrome Local Network Access: https://developer.chrome.com/blog/local-network-access
- Ollama FAQ and origins: https://docs.ollama.com/faq
- ONNX Runtime Web: https://onnxruntime.ai/docs/tutorials/web/
- Transformers.js WebGPU and Whisper: https://huggingface.co/docs/transformers.js/en/guides/webgpu
- whisper.cpp WASM: https://github.com/ggml-org/whisper.cpp
