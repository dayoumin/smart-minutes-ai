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

## 11. Cloudflare 배포 준비 — 2026-10-18

사용자는 Cloudflare를 배포 대상으로 선택했다. 목표는 **HTTPS 웹 접속 → 로컬 엔진 받기 → 설치 → 웹 연결 → 모델 준비 → 분석·저장·내보내기**다. GitHub push, Vite 화면 열기, 로컬 검사 설치 파일 생성은 이 배포 완료를 뜻하지 않는다.

### 준비한 구성과 명령

- 웹: `deploy/cloudflare/wrangler.jsonc`의 Workers Static Assets. 사용자 요청으로 Worker 이름에서 `-web`을 제거했다. `barorok` 이름의 기존 배포가 없는 것을 확인한 뒤 같은 계정·웹 자산으로 배포했다. 현재 검사 사이트는 `https://barorok.ecomarin.workers.dev`다.
- 웹 빌드: `corepack pnpm --dir deploy/cloudflare prepare:web`. 기존 디자인 작업의 `desktop-app/dist` 대신 `.tmp/cloudflare-web/dist`에 생성한다. 이 명령은 업로드하지 않는다.
- 연결 화면은 켜고, API는 사용자 PC의 `http://127.0.0.1:17863`으로 고정한다. 다운로드 주소를 생략하면 기존 `.env` 값도 덮어써 검사본 링크가 노출되지 않게 한다.
- 배포용 설치 파일 검증이 끝나면 `powershell -NoProfile -ExecutionPolicy Bypass -File scripts/prepare_cloudflare_web.ps1 -InstallerUrl <검증된-HTTPS-설치파일-주소>`로 다시 빌드한다. 업데이트 주소는 검증된 경로가 있을 때만 `-UpdateUrl`로 별도 지정한다. 이 인자는 서명 검증을 대신하지 않는다.
- 설치 파일은 웹 자산 폴더에 넣지 않는다. 비공개 R2에 버전별 파일명으로 보관하고 같은 웹 Worker의 `/downloads/`에서 지정한 파일만 전달한다. 사용자용 HTTPS 다운로드 주소, 파일 크기, SHA-256을 release manifest와 맞추며 `r2.dev` 공개나 별도 custom domain은 사용하지 않는다.
- 현재 약 443MB인 검사 설치 파일은 Wrangler 단일 업로드 한도(315MB)를 넘는다. 이번에는 별도 S3 키 없이 인증·만료·고정 key·크기 제한을 적용한 임시 Worker로 분할 업로드(multipart upload)하고 전체를 다시 읽어 해시를 확인한다. 확인 후 임시 Worker는 삭제한다. [공식 업로드 기준](https://developers.cloudflare.com/r2/objects/upload-objects/)
- 계정 확인: `corepack pnpm --dir deploy/cloudflare whoami`.
- 계정 로그인: `corepack pnpm --dir deploy/cloudflare login`. 사용자가 브라우저에서 계정 인증을 완료한다. 토큰을 채팅이나 소스에 붙여 넣지 않는다.
- 로컬 배포 검사: `corepack pnpm --dir deploy/cloudflare check` (`wrangler deploy --dry-run`). 실제 배포: `corepack pnpm --dir deploy/cloudflare run deploy` (`deploy`는 pnpm 내장 명령과 구분해 반드시 `run`을 붙인다).

Wrangler `4.151.1`은 별도 의존성으로 고정했다. 설치는 저장소 루트에서 `corepack pnpm --dir deploy/cloudflare install --store-dir .cache/pnpm-cloudflare`로 한다. Windows 인증 저장소 모듈이 없으면 `.cache/cloudflare-auth/.wrangler/native/keyring` 폴더를 만든 뒤 `corepack pnpm --dir .cache/cloudflare-auth/.wrangler/native/keyring add @napi-rs/keyring@1.3.0 --store-dir .cache/pnpm-cloudflare`로 준비한다. 전역 설치나 인증 저장소 비활성화로 우회하지 않는다.

`wrangler.mjs`는 `XDG_CONFIG_HOME=<저장소>/.cache/cloudflare-auth`, `XDG_CACHE_HOME=<저장소>/.cache/cloudflare-auth/cache`, `WRANGLER_LOG_PATH=<저장소>/.tmp/cloudflare-web/wrangler.log`, `WRANGLER_SEND_METRICS=false`, `CLOUDFLARE_AUTH_USE_KEYRING=true`를 적용한다. 인증 파일·로그·캐시는 Git에 포함하지 않는다. 사용자의 기존 `~/.wrangler`가 있으면 Wrangler의 legacy 우선순위가 적용될 수 있으므로 계정 확인 결과를 확인한다.

### 일반 사용자 배포까지의 상태와 남은 일

1. Cloudflare 로그인·계정 확인과 웹 최초 배포는 완료했다. 배포 version은 `905f8ae3-c3d6-43b8-a637-be8810f399e5`이며 실제 HTTPS에서 웹 자산 6개를 다시 받아 SHA-256 일치를 확인했다(`.tmp/cloudflare-web/deployment-verification.json`). 타입 검사·변경 ESLint·URL 경계 8개·HTTP URL 빌드 전 거부·Vite 웹 빌드·Wrangler dry run·독립 agent 검토도 통과했다. 실제 분석 모드를 명시적으로 고정한다. 웹 공개 자체가 설치·분석 전체 흐름 통과를 뜻하지 않는다.
   - 2026-10-18 주소 변경: `https://barorok.ecomarin.workers.dev`, version `7cf3a964-c2ac-4f1d-bf0a-cf1a3e806a74`. 새 이름의 dry run·독립 agent 검토와 실제 HTTPS 자산 6개 SHA-256 일치를 확인했다(`.tmp/cloudflare-web/barorok-deployment-verification.json`). 기존 `barorok-web` 사이트는 삭제하거나 리디렉션하지 않았다. 두 주소의 브라우저 저장 영역은 다르므로 기존 IndexedDB 기록이 새 주소로 자동 이전됐다고 안내하지 않는다.
   - 다운로드 저장소 `barorok-releases`는 비공개로 유지한다. 별도 S3 키 없이 인증된 임시 Worker로 0.1.4-beta 설치 파일을 고정 key에 전송하고 전체 442,772,630 bytes의 read-back SHA 일치를 확인했다. `complete()` 응답에 custom metadata가 빠져 첫 완료 단언이 409였지만 후속 실제 객체와 전체 내용은 정상이다. 임시 Worker `barorok-upload-qa-20261018`은 즉시 삭제했다. 일반 웹 Worker는 지정 EXE와 공개 beta metadata의 GET·HEAD·Range만 허용한다. 다른 프로젝트 버킷은 변경하지 않았다.
   - 사용자가 서명 설명 후 새 주소용 엔진 제작·다운로드·설치·연결 검증을 요청해 2026-10-18 미서명 테스트 배포를 진행한다. 웹의 기존 연결 안내 자리에 테스트 파일·Windows 경고 가능성을 표시하고 `signed=false`, `testRelease=true`를 유지한다. 일반 사용자 출시의 서명 기준은 폐기하지 않는다. 인증서 구매나 서명 검증 실패 우회는 하지 않는다.
2. 정확히 `https://barorok.ecomarin.workers.dev`를 허용하는 `0.1.4-beta-20261018` 설치 파일 제작과 전체 manifest 전후 검증·frozen Stage3B 기본 검사가 통과했다. 442,772,630 bytes, SHA-256 `ba1c858251468cbfb6bc80d4a0fd83933033b0db104a61c32acc666ef7a4f177`이다. r3 실행 파일·helper를 재사용하고 외부 설정 한 파일만 바꿨으며 4,955개 payload는 동일하다. 최신 `models_status` 실패 안내 문구 한 줄만 재사용 바이너리에 미포함이고 기능·보안 로직의 기록된 source hash는 일치한다. 원본 두 JSON·기존 설치 파일과 manifest는 보존했다. 새 설치 파일 manifest는 `installer-0.1.4-beta-20261018-manifest.json`이고 기존 `installer-poc-manifest.json`은 0.1.3 이력이다. `distributionReady=false`를 정식 출시 완료로 바꾸지 않는다. 근거는 `.tmp/public-engine-audit-20261018/{source-reuse-provenance.json,repackage-result.json}`이다.
3. 최초 전송·전체 read-back SHA 검증 후 사이트의 다운로드 주소를 연결했다. 당시 배포 version은 `dd072cdb-817d-49a7-934e-23314c3687d6`이며 실제 공개 주소의 metadata·HEAD·206 Range·416·알 수 없는 파일 404·쓰기 405 검사가 통과했다. 다운로드 Worker 타입·HTTP/Range 검사와 미서명 안내의 독립 agent 검토도 통과했다. 당시 공개 파일은 `Barorok-Local-Engine-Setup-0.1.4-beta-20261018.exe`였고 현재 다운로드는 아래 5항의 0.1.5다. 근거는 `.tmp/public-engine-audit-20261018/{public-deployment.json,public-download-http.json,remote-uploader/upload-result.json}`이다. 일반 사용자용으로 서명됐다고 안내하지 않는다.
4. 실제 stable Chrome의 새 프로필에서 사이트의 미서명 안내·받기 링크·정확한 HTTPS GET·실제 다운로드 완료와 SHA/크기 일치를 확인했고 독립 agent도 증거 일치를 확인했다. 받은 파일을 실제 GUI로 설치했고 NSIS의 native OS exit code `0`, 등록·설정 버전 `0.1.4-beta-20261018`, 새 origin과 설치/제거 미완료 표시 없음이 확인됐다. 설치 뒤 기존 기록/설정 9개 SHA·모델 73개 크기 불변, 새 origin의 probe 200·무인증 health 401·이전/다른 origin pairing 403도 통과했다. 근거는 `.tmp/public-engine-audit-20261018/installation-interactive.json`, `user-data-after-install.json`, `installed-boundary.json`과 `evidence/download-2026-10-18T03-24-37-172Z-48000/{manifest.json,network.json}`이다.
   - 초기 실행 대기 진단: `/S`·숨김 실행 요청이 반환되지 않았고, 사용자가 창이 없다고 확인한 뒤 일반 GUI 실행을 요청했다. runtime agent가 검사 프로세스 `39824`의 `MainWindowTitle='파일 열기 - 보안 경고'`, 창 핸들·UserRequest 대기를 확인했다. 파일은 `ZoneId=3`, `NotSigned`이며 일반 Computer Use 목록에는 이 Shell 경고 창이 없었다. 이후 실제 NSIS `47788`가 시작됐고 보안 대기 해제 원인·사람의 승인 동작은 직접 관측하지 못했다. Computer Use 앱 제어 승인 후 일반 설치의 계속·마침을 진행했다. Windows 보안 창 입력·차단 해제·보안 설정 변경은 하지 않았다. 초기 대기 이력 `windows-launch-pending.json`, `Windows-launch-followup.json`은 설치 완료 증거와 구분해 보존한다.
   - 공개 HTTPS·실제 설치 엔진 검사 진행: 같은 30초 WAV는 STT·참석자 구분·요약·저장·reload·TXT/MD/DOCX/HWPX 4개 내보내기를 통과했다. 최초 요약 503 뒤 재시도로 성공했으며 초기 모델 적재 중 CPU·읽기·상주 메모리 이동을 관측했다. 화자 검토 표시 3개와 저장 전후 기록·backend 계약 일치도 agent가 확인했다. 모호한 인물 평가를 특정 사람에게 붙이지 않았지만 평가 누락/확인 항목 비어 있음의 기존 P2는 유지한다. 15초 MP4는 STT·참석자 구분 뒤 요약이 HTTP 409 `model_missing`으로 실패했고 실패 상태는 저장됐다. 직전 상태 조회는 `summary_ready=true`여서 전체 흐름은 완료 판정하지 않는다. 최신 근거는 `evidence/resume-2026-10-18T05-19-56-958Z-46344`다.
   - 모델 목록 오판 경로를 재현했다. 같은 자체 Ollama에서 `/api/tags`는 약 0.05초에 두 모델을 반환했지만 `ollama list`는 12.876초가 걸렸고 기존 `model_manager.list_ollama_models`는 5초에 중단해 빈 목록을 반환한다. 목록을 같은 runtime의 HTTP API로 조회하도록 수정 중이며 소스 집중 7개 검사·실제 API 조회(0.07초)를 통과했다. 영상 409가 이 경로였는지는 provider 404 가능성과 구분되지 않으므로 새 frozen 설치본 재검증 전 확정하지 않는다. 새 PC 최초 모델 준비, 사람의 LNA 승인/거부, 실모델 후 전체 소유 프로세스 종료·재시작은 별도 관문이다. 브라우저 검사는 통제된 테스트 권한 승인을 사용했다.
5. 모델 목록을 별도 CLI 대신 같은 runtime의 `/api/tags`로 조회하도록 수정했다. 활성/수동 조회·중복/잘못된 응답·타임아웃 집중 4개와 기존 API 3개 검사, 실제 두 모델 0.07초 확인, 독립 backend agent 검토를 통과했다. 수정 소스를 포함한 `0.1.5-beta-20261018`을 새로 frozen 빌드해 42개 입력의 source drift 0·closed manifest·전체 격리 Stage3B·NSIS를 통과했다. 이전 설치본의 DLL/PYD 473개·822,272,735 bytes 및 FFmpeg는 새 manifest와 동일하며 기존 설치 파일 8개를 보존했다. 새 설치 파일은 442,772,108 bytes, SHA-256 `dcf08c15467ac7cf9accdbd600d6821c86e1020eaf545ce68a33fa1855e23aec`다.
   - 비공개 R2 전송·전체 read-back SHA 일치 후 임시 `barorok-upload-qa-015-20261018`을 삭제했고, 새 배포 version `bdc8bba6-c837-4650-9578-86561135e2ff`를 적용했다. 현재 공개 주소는 `https://barorok.ecomarin.workers.dev/downloads/Barorok-Local-Engine-Setup-0.1.5-beta-20261018.exe`다. metadata/HEAD/206/416/404/405 및 실제 Chrome 받기 버튼의 전체 파일 크기/SHA·미서명 안내 검사가 통과했다. 근거는 `.tmp/public-engine-audit-20261018/{build-015/build-result.json,build-015/native-dependency-comparison.json,remote-uploader-015/upload-result.json,public-015-deployment.json,public-015-boundary.json,evidence/download-2026-10-18T06-02-34-891Z-38428/manifest.json}`이다.
   - 사용자가 Windows 보안 경고의 실행을 승인한 뒤, 재개 시점에는 설치 프로그램이 이미 사라지고 실제 0.1.5가 실행 중이었다. 등록/설정 버전·origin·설치 EXE SHA의 frozen manifest 일치·pending 둘 다 false·실제 loopback/auth 경계를 확인했다. launcher의 `$process.Path.Equals`는 경로가 null인 상태에서 실패해 **설치 프로그램 exit 코드는 미관측**이며 0으로 보정하지 않는다. 설치 전 기존 기록/설정9개 SHA·모델73개 크기·추가 실제 기록2개 SHA는 모두 유지됐다. `installed-015-runtime-state.json`, `installed-015-boundary.json`, `user-data-after-015-install.json`, `after-015-extra-records.json`을 따른다.
   - 실제 공개 HTTPS에서 영상 기존 기록의 요약 재시도가 성공했고 저장/reload·TXT/MD/DOCX/HWPX 4개를 통과했다. 음성은 이미 완료된 0.1.4 요약을 새로 만들지 않고 원본 보존·검토 배지3개·reload·4개 파일을 확인했다. 독립 데이터 agent가 두 기록의 backend/frontend/내보내기 본문·화자·시간·표시와 파일8개의 SHA/ZIP/XML을 확인했고 신규 차단 없음이다. **0.1.5에서 STT/화자 구분을 새로 수행한 검사는 아니다.** 기존 두 실처리 결과와 동일한 관련 소스·native473개/FFmpeg 증거를 재사용했다. 영상 성공은 `evidence/resume-2026-10-18T07-20-15-118Z-28068`, 음성 보존은 `evidence/resume-2026-10-18T07-29-56-644Z-45364`다.
   - 실제 적재된 `gemma4:e2b`를 확인한 직후 일반 stop으로 본체 실제 exit0·약6.37초·소유 본체/Ollama/runner/conhost 5개 모두 소멸·포트/mutex 해제·foreign Ollama36096 보존을 통과했다. 강제 정리 없이 같은 설치본/환경/17863을 PID48712로 복원하고 두 기록을 읽기 전용으로 다시 열었다. 재열기 전후 전체 기록·화면 해시·검토 배지가 동일하며 생성/추론/export 요청은0건이다. 독립 runtime agent도 확인해 이 PC의 이전 하위 프로세스 잔류 P2를 닫았다. `loaded-015-before-stop.json`, `shutdown-015-after-summary.json`, `restart-015-ready.json`, `evidence/reopen-2026-10-18T07-33-08-233Z-42872`와 최종 `user-data-after-015-restart.json`을 따른다.
   - 남은 실제 문제는 **첫 준비 지연과 첫 요청503**이다. 0.1.5 자체 Ollama 시작07:15:36Z 뒤 첫 영상 요청은07:16:23Z에 `server_unreachable` 503·retryable=true로 실패했고 실패 상태도 저장됐다. API200/두 모델 확인은07:19:43Z로 관측돼 약4분이 걸렸다. 그 뒤 재시도에서도 native health가 `Loading model` 503인 기간을 거쳐 실제 요약 완료까지 추가 약8분이 걸렸다. 완료 뒤 재시도/파일/종료는 통과했지만 이 초기 지연은 해소한 것으로 보고하지 않는다. 원인은 미확정이며 `todo.md`의 별도 P2에서 초기 상태·준비 중 요청·재시도/취소·대표 PC 시간 측정으로 추적한다. 기존 전체 검사를 처음부터 반복하지 않고 이 경로를 다음 범위로 고정한다. 실패 근거 `evidence/resume-2026-10-18T07-15-21-116Z-36364/summary-http-failure.json`와 startup/live-runner 관측 JSON을 보존한다. `signed=false`, `distributionReady=false`와 다른 PC/최초 모델 다운로드/사람 LNA 승인·거부/Word·한컴 실제 렌더링 관문은 유지한다.
6. 일반 사용자 MVP 전 SQLite 기준 저장소 전환과 다른 PC 검증을 끝낸다. 기존 출시 위험표의 서명·원격 origin/LNA·최초 모델 다운로드·편집기 호환 관문을 유지한다.

공식 설정 근거: [Workers 정적 자산](https://developers.cloudflare.com/workers/static-assets/), [단일 페이지 앱 라우팅](https://developers.cloudflare.com/workers/static-assets/routing/single-page-application/), [R2 공개 버킷](https://developers.cloudflare.com/r2/buckets/public-buckets/).

### R2·웹 사용 한도와 100명 기준 비용 — 2026-10-18

공식 가격표와 현재 배포 경계를 대조했다. R2 버킷 `barorok-releases`의 기본 저장 등급은 실제 `wrangler r2 bucket info` 조회에서도 `Standard`다. 공개 설치 파일 HEAD는 HTTP 200, 442,772,630 bytes와 release SHA ETag가 일치했다. 같은 버킷의 집계 응답은 `object_count=0`, `bucket_size=16.8 MB`로 실제 객체 HEAD와 달랐으므로 이 집계를 현재 전체 보관량이나 청구량의 확정값으로 사용하지 않는다. 계정 전체 누적 사용량·Workers 구독 플랜·실제 청구서는 이번 조회에 포함하지 않았다.

| 항목 | 무료 포함량 또는 요금 | 이 프로젝트의 100명·각 1회 다운로드 가정 |
| --- | --- | --- |
| R2 Standard 저장 | 월 10 GB-month; 초과 $0.015/GB-month | 설치 파일 한 개 약 0.443 GB를 보관. 다운로드 수만큼 서버 사본이 늘지 않음 |
| R2 쓰기·업로드(Class A) | 월 100만 회; 초과 $4.50/100만 회 | 버전 업로드 시에 발생. 사용자의 설치·분석마다 R2 쓰기가 발생하지 않음 |
| R2 읽기(Class B) | 월 1,000만 회; 초과 $0.36/100만 회 | GET 100회가 기본이며 HEAD·분할·재시도는 추가 요청 |
| R2 인터넷 전송 | 전송량 요금 없음, Workers binding 경유도 동일 | 약 44.277 GB 전송이지만 R2 전송량 요금 $0 |
| HTML·JS·CSS 등 정적 웹 자산 | Static Assets 요청 무료·무제한 | 현재 설정은 `/downloads/*`만 Worker를 먼저 실행 |
| 다운로드 Worker | Free는 계정 합산 하루 10만 요청; Paid는 기본 월 $5와 포함량/초과 요금 별도 | 파일 GET·HEAD·metadata마다 Worker 호출. 일반적인 100회 다운로드는 무료 요청 한도보다 매우 적음 |
| 음성·영상 분석·요약·기록 저장 | 사용자 PC의 로컬 엔진·브라우저 저장소 | Cloudflare AI 추론·R2 녹음 저장을 사용하지 않음 |

이것은 해당 프로젝트의 추가 사용량 계산이며 계정 전체 청구액 $0 보장은 아니다. 무료량은 같은 계정의 다른 사용량과 함께 확인해야 한다. R2는 포함량을 넘으면 종량 요금이 발생하고, Workers Free의 요청 한도 초과는 자동 유료 전환과 구분한다. 현재 `run_worker_first`의 다운로드 경로는 Free 요청 한도 초과 시 429를 받을 수 있다. R2 저장/요청의 과금 단위 올림도 적용된다. Infrequent Access는 무료량과 별도 읽기 처리 비용이 달라 이번 파일 배포 기준으로 사용하지 않는다.

향후 모델·옛 설치 버전을 R2에 추가하거나 공개 반복 요청이 증가하면 재계산한다. 공개 운영 전 계정의 Billable Usage와 구독 플랜을 확인하고 예산 알림을 결정한다. 예산 알림은 통지 기능이며 사용량·요금을 자동 차단하는 상한이 아니다. 이번 확인에서는 플랜·결제·알림 설정을 변경하지 않았다.

근거: [R2 가격·무료량·전송·단위 올림](https://developers.cloudflare.com/r2/pricing/), [Workers 가격](https://developers.cloudflare.com/workers/platform/pricing/), [정적 자산 과금·Free 초과 동작](https://developers.cloudflare.com/workers/static-assets/billing-and-limitations/), [예산 알림](https://developers.cloudflare.com/billing/manage/budget-alerts/).

### 긴 입력의 검증 범위 재확인 — 2026-10-18

이 절은 첫 기동·첫 요약 수정과 별도로 실시한 읽기 검토다. 장시간 실처리를 이번 수정의 통과 조건으로 추가하지 않는다.

이번 수정은 첫 기동·첫 요약 준비·503에 한정한다. 장시간 입력은 agent가 읽기 전용으로 검토했으며, 짧은 실제 표본의 통과를 긴 영상 전체 흐름의 통과로 확대하지 않는다. 현재 파일 입력은 음성·영상이며 PDF/PPT/DOCX 자료 업로드는 지원하지 않는다.

| 구분 | 확인한 범위 | 남은 확인 |
| --- | --- | --- |
| 짧은 실제 입력 | 30초 WAV·15초 MP4 및 과거 104.6초 영상의 청크 처리 | 30분 이상 전체 흐름과 정확도는 입증하지 않음 |
| 과거 약87분 영상 | STT 174/174, partial TXT/JSON 완료 | 당시 요약 단계 180초 stall 취소 이력이 있음. 이후 대화록/정리 분리·checkpoint 복구 수정은 기록됐지만 현재 배포본의 장시간 전체 재검증을 대신하지 않음 |
| 30·60분 검사 | 변환·분할(prep)만 완료 | STT·참석자 구분·요약·저장·내보내기 전체 검사가 아님 |

현실적인 위험은 개별 추론 호출 전후에 확인되는 취소의 반응 시간, 참석자 구분의 전체 WAV float32 메모리, 긴 대화록의 부분 요약을 한 번에 합치는 마지막 단계의 길이·내용 보존이다. 일부 후속 정리의 앞뒤 절단은 중간 발언을 제외할 수 있다. 이는 코드상 검토 결과이며 모든 긴 입력에서 실패한다는 뜻은 아니다.

장시간 출시 검증은 기존 공식 지원 사양 위험표에서 계속 **열림**으로 관리한다. 다음 최소 표본은 실제 발언이 이어지는 30분 다화자 영상 1건이다. STT 중지→같은 파일 재개(완료 청크 재사용·중복/누락·시간), 참석자 구분/요약의 단계 시간·최대 메모리/디스크·처음/중간/끝 발언 보존, 저장→재열기→4종 파일 일치를 확인한다. 30분 통과 뒤에만 60분·2시간 범위를 확대한다. 사람 기준 대화록이 없는 실행 완료 검사는 정확도 검사와 구분한다. 확인일: 2026-10-18.

### 첫 준비·첫 요약의 기능 복구와 단계 측정 — 2026-10-18

기존 기능·배포 소스는 디자인 커밋 `c4bbca5`를 보존한 `main`에 `20b4fdd`, 검증 기록은 `2d1202c`로 커밋·푸시했다. 최초 분리에 사용한 임시 브랜치/체크아웃은 main 보존 확인 뒤 정리했다. Git 푸시 자체는 사이트 재배포나 설치 파일 갱신이 아니다.

- 명시적 전체 요약은 단일 준비 예산300초 → 성공 여부가 구분되는 모델 목록1회 → 선택한 모델로 생성한다. 같은 작업·모델의 준비 상태만 context에 전달해 재확인/재기동을 생략하며, 준비 후 연결 실패를 CLI로 자동 재실행하지 않는다. 기존 호환 경로의 짧은 확인 및 생성600초 제한은 유지한다.
- 실행 중인 관리 프로세스는 `managed_starting`, 준비/목록 미확인은 재시도 가능한 `runtime_preparing`으로 구분한다. 정상 목록에서 실제 부재가 확인돼야 `model_missing`이다. 상태 조회는 기동하지 않고, 실패 시 기존 대화록·화자 이름·요약/파생 결과를 유지한다. 전체 요약에 새 취소 기능은 추가하지 않았다.
- Settings·History·오류 매핑은 같은 기존 영역에서 준비 중/미확인 안내와 재시도 가능 상태만 보완했다. JSX 배치·CSS·디자인은 바꾸지 않았다.
- 생성 로그에는 시작/완료/오류 코드와 검증된 숫자 시간만 기록한다. 프롬프트·응답·모델 경로·환경변수와 원시 stderr는 제품 로그에 추가하지 않았다.
- 집중 검증: runtime 신규10개와 기존 호환4개, backend 준비/모델/API/보존/인증 고유52개, frontend `corepack pnpm --dir desktop-app test:generation-flow`, `typecheck`, 변경4파일 ESLint 및 diffcheck 통과. 독립 runtime agent가 backend 계약을, root가 runtime·frontend 변경을 검토해 차단 없음. GPU와 무관한 상태 테스트의 실제 GPU 조회 및 상태 초기화 테스트의 무관한 export는 명시적으로 격리했다.

실제 모델 검사는 기존 영상 대화록으로 **수정 소스의 준비 helper·strict 목록·gateway·요약 pipeline**을 새 소유 프로세스/12481에서 첫1회·즉시반복1회 실행했다. API 경로는 별도 집중 검사 근거이며, 이번 실모델 실행 자체는 main HTTP endpoint·설치본·공개 브라우저 검사가 아니다. STT/화자 구분·기존 파일8개 전체 검사는 반복하지 않았다.

| 실측 구간 | 첫 실행 | 즉시 반복 |
| --- | ---: | ---: |
| 준비 전체(목록 포함) | 78.890초 | 0.219초 |
| 생성 요청 | 166.516초 | 1.188초 |
| 생성 중 모델 적재 | 159.316초 | 0.549초 |
| 작업 전체 | 245.578초 | 1.422초 |

둘 다 실제 내용이 있는 JSON 요약이며 오류 코드가 없다. 관리 API 준비 로그는76.844초, GPU 탐색→CUDA13/RTX5080 선택은 약63.075초다. 이는 준비 전 실패를 피한 실증이지만 이전 실행과 OS 파일 캐시·동시 부하가 같지 않아 native 성능 향상 수치로 쓰지 않는다. 모델 적재가 첫 생성의 대부분을 차지하며 수분 지연 자체는 아직 제거하지 않았다. AMD 경고만으로 원인을 확정하거나 GPU 설정·보안 제품·드라이버를 임의 변경하지 않았다. [해당 런타임의 GPU 탐색 소스](https://github.com/ollama/ollama/blob/v0.30.6/discover/runner.go)는 Windows에서 라이브러리별 초기 탐색 시간을 별도로 허용한다.

원시 QA 로그는 GGUF6816.54MiB, CUDA model1397.54MiB, CUDA_Host4480MiB 등을 보여 준다. `/api/ps` 약1.7GB를 전체 RAM 사용량으로 해석하면 안 된다. 실행 중 한 시점의 runner 상주 약5.4GB/읽기 약6.4GB와 여유 메모리 약2.65GB는 snapshot이며 최대치가 아니다. 모델 적재/멀티모달 초기화 최적화와 지원 사양 확정은 별도 비교가 필요하다.

검사 후 기존 기록/설정9개 SHA와 모델73개 크기가 그대로이고 원본 영상 기록 증거도 불변이다. QA 소유 프로세스는 정리했으며 설치 엔진48712/17863과 외부 Ollama36096은 유지했다. 근거: `.tmp/cold-start-20261018/{native-startup.json,source-summary.json,source-summary.log,summary-native-stderr.log}`와 `public-engine-audit-20261018/user-data-{before,after}-cold-source.json`. 공개 설치 파일은 여전히0.1.5이며 새 설치본 반영/공개 HTTPS의 첫 요청 검증 전에는 설치본 문제가 닫혔다고 보고하지 않는다.
