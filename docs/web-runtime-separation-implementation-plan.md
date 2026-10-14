# 웹 런타임 분리 구현 계획

- 작성일: 2026-08-13
- 상태: 2단계 완료, 3단계 3C-0B host·installer target preflight 실물 검증 완료·installer 소비 소스 완료·실제 installer build/smoke 대기
- 상위 결정: `docs/web-local-engine-followup-plan.md`
- 목표 제품: HTTPS 웹 UI + 사용자 PC의 Windows 로컬 엔진
- 후속 제품: Tauri 데스크톱 앱은 웹 MVP 이후 별도 범위

## 1. 이 계획의 목적

현재 `desktop-app` 폴더의 React UI에는 로컬 엔진 연결, 모델 상태 확인,
모델 다운로드, 분석, 중지와 복구 기능이 이미 있다. 따라서 웹 버전을 위해
같은 기능을 다시 만들지 않는다.

이번 전환의 핵심은 기존 UI와 분석 기능에서 Tauri 실행 의존성을 분리하고,
웹사이트가 로컬 엔진을 안전하게 발견·연결·인증하며 로컬 기록을 다시 읽을
수 있는 경계를 만드는 것이다.

`desktop-app` 폴더명은 당장 바꾸지 않는다. 공통 React UI의 런타임 경계가
안정된 뒤 이름 변경의 이득과 빌드·스크립트 변경 비용을 별도로 판단한다.

### 1.1 문서 권한과 진행 기록

- 이 문서는 웹 MVP의 단일 실행 기준이다. 단계 상태, 다음 작업 묶음, 검증
  증거와 중단 사유는 이 문서에서 갱신한다.
- `docs/web-local-engine-followup-plan.md`는 제품 방향과 사용자 흐름을 소유한다.
- `docs/design.md`와 `docs/design-assets/barorok-production/`은 공통 UI의 디자인
  권위다. 단계별 구현이 이 기준과 충돌하면 임의로 새 스타일을 만들지 않는다.
- `docs/browser-web-version-execution-plan.md`와
  `docs/browser-local-web-version-plan.md`는 순수 브라우저 엔진 후보의 보류
  자료이며 현재 실행 순서를 지시하지 않는다.
- `todo.md`와 `roadmap.md`는 요약·후속 기록으로 사용하되, 웹 MVP의 단계
  완료 여부는 이 문서의 상태표를 기준으로 판정한다.

## 2. 범위와 제외

### 이번 계획에 포함

- 기존 데스크톱 기능의 재사용/분리 기준
- 웹과 Tauri의 실행 환경 판별 및 공통 API 클라이언트
- 로컬 엔진 연결 상태와 복구 흐름
- 실제 HTTPS origin 허용, pairing, 세션 인증
- 웹 제품의 SQLite 기준 저장소 전환
- 브라우저와 Tauri의 파일 동작 차이
- 단계별 자동 검증과 실제 PC 검증 게이트

### 이번 계획에서 제외

- UI 전면 재설계
- 순수 브라우저 WASM/WebGPU 분석
- 원격 서버로 음성·영상 업로드
- Tauri 데스크톱 릴리스 완성
- HWPX 편집기와 보도자료 생성
- 모바일·PWA와 여러 운영체제 지원

HWPX 문서 작업은 SQLite 저장 계약과 결정 데이터 구조화가 끝난 뒤 별도
계획으로 진행한다. 기록 찾기 화면은 향후 문서 생성에 사용할 근거 선택
표면이지만 편집기를 포함하지 않는다.

## 3. 현재 구현 자산

| 영역 | 현재 상태 | 웹 전환 판단 |
| --- | --- | --- |
| React 작업 화면 | 새 기록, 분석, 회의 상세, 기록 찾기, 설정 구현 | 그대로 공유 |
| API 주소 | `apiBase.ts`가 Tauri 주소, `VITE_API_BASE_URL`, `127.0.0.1:17863`을 처리 | 런타임 어댑터로 정리 |
| 엔진 상태 | 새 기록 화면이 `/api/health`, `/api/models/status` 확인 | 공통 연결 상태로 승격 |
| 분석 | 업로드, SSE 진행, 중지, 이어하기 구현 | 인증 헤더와 연결 상태만 통합 |
| 모델 관리 | 설정에서 상태, 다운로드, 중지, 재확인 구현 | 로컬 엔진 API를 그대로 재사용 |
| 백엔드 재시작 | Tauri command 사용 | 웹에서는 제공하지 않거나 엔진 자체 복구 동작으로 대체 |
| 저장 위치 열기 | Tauri command 사용 | 웹에서는 다운로드 완료와 브라우저 저장 안내로 대체 |
| 회의 저장 | IndexedDB `meetingRepository` 사용 | UI 검증용 임시 어댑터; SQLite API로 전환 |
| CORS | localhost와 Tauri origin 중심 | 실제 HTTPS origin exact allowlist 필요 |
| 인증 | Tauri action token 중심 | 웹 pairing과 짧은 세션 토큰 필요 |
| 설치·업데이트 | 데스크톱/portable 자산 중심 | 웹용 현재 사용자 단위 로컬 엔진 설치·업데이트 계약 필요 |

## 4. 흔들리지 않을 핵심 계약

### 4.1 제품 표면

- 사용자가 여는 제품은 HTTPS 웹사이트다.
- 로컬 엔진은 별도 작업 화면이 아니라 백그라운드 분석 구성요소다.
- 웹과 Tauri는 React 화면을 복제하지 않고 같은 컴포넌트와 디자인 토큰을 쓴다.
- 실행 환경 차이는 런타임 어댑터, 엔진 클라이언트, 저장소 어댑터에서 처리한다.

### 4.2 연결 상태

연결 상태를 하나의 문자열로 합치지 않고 전송과 인증 두 축으로 구분한다.

- 전송 상태(transport): `checking`, `unreachable`, `reachable`, `incompatible`, `error`
- 인증 상태(authorization): `unknown`, `unpaired`, `authenticated`, `expired`, `revoked`

`reachable`은 공개 probe의 제품 식별자와 API 계약을 확인했다는 뜻일 뿐 분석
가능 상태가 아니다. 전송이 `reachable`이고 인증이 `authenticated`이며 필요한
capability가 있을 때만 사용자에게 `연결됨`으로 표시하고 민감 기능을 연다.

브라우저는 probe 실패만으로 `미설치`와 `미실행`을 확실히 구분할 수 없다.
따라서 확인되지 않은 상태를 서로 다른 확정 문구로 표시하지 않는다.
`unreachable`에서는 `로컬 엔진 받기`, `엔진을 실행한 뒤 다시 연결`,
`문제 해결`을 같은 복구 흐름 안에서 제공한다.

`permission-required`나 `permission-denied`는 브라우저가 Permissions 상태 또는
조직 정책 거부를 명시적으로 제공할 때만 보조 원인으로 판정한다. fetch의
network error만 있으면 `unreachable`을 유지하고 권한, 엔진 실행, 방화벽과
조직 정책을 함께 점검하도록 안내한다.

### 4.3 probe와 capability

기존 `/api/health`를 웹의 공개 신뢰 계약으로 사용하지 않는다. 첫 백엔드
묶음에서 공개 `/api/probe`를 추가하고, HTTP 200뿐 아니라 다음 최소 정보를
검증한다.

- 고정된 `product_id`
- `engine_version`과 `api_contract_version`
- 지원 기능: 분석, 모델 관리, SQLite 기록, 내보내기
- `auth_state`: pairing 필요 여부만 나타내는 비민감 상태
- 업데이트 필요 여부

API 계약 버전은 양의 정수 major로 고정한다. 첫 웹 로컬 엔진 계약은
`api_contract_version: 1`이며, 필드 추가처럼 기존 소비자가 무시할 수 있는
변경은 같은 값을 유지하고 기존 필드의 의미·인증·요청·응답을 깨는 변경만 major를
올린다. 웹 UI는 자신이 지원하는 정수 목록과 정확히 일치하지 않으면
`incompatible`로 닫는다. 사람에게 보여 주는 엔진 릴리스 버전은 별도의
SemVer 문자열 `engine_version`을 사용한다.

민감한 경로, Python 실행 파일, 설치 식별자, 비밀값, 전체 설정은 인증 전
probe에 포함하지 않는다. 기존 `/api/health`의 진단 필드는 인증 뒤로 옮기거나
공개 응답에서 제거한다.

### 4.4 보안과 개인정보

- 엔진은 `127.0.0.1`에만 bind한다.
- 허용 origin은 런타임별 exact allowlist로 분리한다. 웹 로컬 엔진은 실제 배포 HTTPS origin만, Tauri sidecar는 고정 Tauri origin만 허용하고 localhost 개발 origin은 개발 모드에만 둔다.
- CORS 성공을 인증 성공으로 취급하지 않는다.
- `/api/probe`와 Origin 검증을 통과한 pairing 시작·완료 endpoint만 공개 allowlist에 둔다.
- 그 외 모든 `/api/**` 읽기·쓰기·SSE·진행률·결과·다운로드는 기본 인증(default deny)을 적용한다. 신규 endpoint도 명시적으로 공개하지 않으면 인증 대상이다.
- 음성·영상과 생성된 대화록은 기본 흐름에서 원격 웹 서버로 전송하지 않는다.
- pairing 비밀값과 세션 토큰은 로그와 오류 문구에 남기지 않는다.

### 4.5 저장 소유권

- 웹 제품의 기준 저장소(canonical storage)는 로컬 엔진 SQLite다.
- 로컬 엔진만 회의 기록을 쓰는 단일 작성자(single writer)로 둔다.
- IndexedDB는 전환 기간의 UI 어댑터나 일시 캐시에만 사용한다.
- 브라우저 캐시 삭제, 다른 브라우저 사용, 웹 origin 변경 후에도 회의 기록이 남아야 한다.
- SQLite commit을 원본으로 하고 backend 결과 JSON, HWPX와 다른 내보내기 파일은 revision을 가진 파생 산출물로 재생성할 수 있게 한다.
- `MeetingRecord`, SQLite row, 결과 JSON, 내보내기 payload 사이의 필드 의미와 revision 충돌 규칙을 하나로 유지한다.

## 5. 목표 코드 경계

정확한 파일명은 첫 구현에서 저장소 관례에 맞춰 조정할 수 있지만 책임은
다음처럼 분리한다.

### 공통 React 계층

- `runtimeEnvironment`: `web-local-engine`과 `tauri-desktop` 판별
- `localEngineClient`: 공개 probe·pairing과 인증된 HTTP·SSE·다운로드 요청을
  메서드 수준에서 분리하는 단일 엔진 요청 경계
- `LocalEngineConnectionProvider`: 연결 상태, 재확인, 세션 만료, 업데이트 필요 상태의 단일 소유자
- `meetingRepository` 인터페이스: IndexedDB와 SQLite API 구현 교체

`/api/probe`와 pairing endpoint도 화면에서 직접 호출하지 않는다.
`localEngineClient.probe/pair`처럼 인증 헤더를 붙이지 않는 명시적 공개 메서드를
사용하고, 나머지 엔진 요청은 `request/stream/download`를 통한다. 최종 전환 시
React 컴포넌트와 coordinator의 직접 API `fetch`는 0개가 되어야 한다. 웹 세션
토큰, Tauri action token, 401 발생 시 한 번만 수행하는 갱신과 `expired` 전이는
이 요청 경계의 런타임 어댑터가 책임진다.

### 웹 어댑터

- 고정 loopback 주소 또는 배포 설정으로 승인된 주소 사용
- 로컬 네트워크 접근 승인·거부 복구
- 설치 파일 다운로드 링크와 설치 후 재확인
- 웹 pairing 및 세션 토큰
- 브라우저 다운로드 기반 파일 전달

### Tauri 어댑터

- `get_backend_base_url`
- desktop action token
- backend 재시작
- 저장 폴더 열기
- 창 닫기 보호

Tauri 전용 동작을 공통 컴포넌트 곳곳에서 직접 판별하지 않는다. 사용 가능한
capability와 어댑터 동작으로 전달해 웹에서 실수로 Tauri command를 호출하지
않게 한다.

### 5.1 공통 디자인·컴포넌트 계약

각 화면을 따로 구현하더라도 다음 품질 관문은 모든 단계에 공통 적용한다.

1. 새 UI를 만들기 전에 `Button`, `IconButton`, `Input`, `StatusBanner`,
   `ProgressBar`, `AppToast`, `Layout`, `Sidebar`, `OceanBackdrop`과
   `index.css`의 공통 클래스·토큰을 먼저 확인한다.
2. 같은 의미와 상태 전이를 가진 UI가 두 화면 이상에서 반복되거나 웹과
   Tauri가 함께 사용하면 공통 컴포넌트 또는 typed prop 계약으로 승격한다.
   모양만 비슷하고 행동이 다른 UI를 억지로 하나로 합치지 않는다.
3. 화면 파일에서 원시 색상, 임의 radius·shadow·z-index를 추가하지 않는다.
   상태 색상, 표면, 포커스, 간격과 버튼 위계는 `docs/design.md`와 semantic
   token을 사용한다.
4. 시작·새 기록의 해양 배경은 `OceanBackdrop`과 공통 shell이 소유한다.
   HTML 버튼·입력·상태 문구를 배경 이미지에 합치지 않는다.
5. 로딩·성공·복구·차단·오류를 화면마다 새 배너로 만들지 않는다. 일시
   피드백은 toast, 지속 안내는 안정된 inline surface, 인증처럼 작업을
   중단시키는 결정만 dialog/full view를 사용한다.
6. 키보드 포커스, 접근 가능한 이름, disabled 이유, 오류 복구 동작과 레이아웃
   안정성을 공통 상태 계약으로 본다. 마우스로만 가능한 핵심 동작을 두지 않는다.
7. 기존 작업 화면의 정보 구조와 용어를 유지한다. 웹 전용 연결 장면 때문에
   새 기록·대화록·기록 정리·보고서·기록 찾기를 복제하거나 재설계하지 않는다.

공통화 판단은 구현 전과 agent 작은 관점 검토에서 한 번씩 확인한다. 한 화면에만
필요한 구성은 먼저 지역 컴포넌트로 두고, 실제 두 번째 사용처가 생겼을 때 공통
API를 고정한다.

### 5.2 공통 모듈·데이터 소유권 계약

- React 화면은 런타임을 직접 판별하거나 Tauri command를 직접 호출하지 않는다.
  환경 차이는 `runtimeEnvironment`와 웹/Tauri 어댑터가 소유한다.
- 공개 `/api/probe`와 pairing은 `localEngineClient`의 무인증 전용 메서드를,
  나머지는 `request/stream/download`를 사용한다. 공개 여부는 화면이 아니라
  클라이언트 메서드와 backend allowlist가 함께 소유하며 화면의 직접 API
  `fetch`는 최종 전환에서 0개여야 한다.
- `apiBase.ts`의 native 주소 결정·재시작 health 확인은 공통 client로 다시 들어가면
  주소 결정이 재귀하므로 전송 어댑터의 명시적 예외다. native 재시작이 반환한 주소만
  desktop token으로 확인하며 legacy 포트 탐색 후보에는 인증 정보를 보내지 않는다.
  이 예외와 공통 전송 구현 이외의 직접 호출은 `test:api-auth-boundary`로 차단한다.
- 연결·인증·capability 상태는 `LocalEngineConnectionProvider`가 소유한다.
  화면마다 health 결과를 별도 의미로 해석하지 않는다.
- 회의 저장·검색은 `meetingRepository` 인터페이스 뒤에 둔다. IndexedDB와
  SQLite 구현을 화면 컴포넌트가 구분하지 않는다.
- 같은 비동기 요청이 겹치면 최신 요청 우선, 취소, 재시도와 이전 정상 데이터
  보존 규칙을 명시한다. 로딩 오류를 빈 데이터로 표시하지 않는다.
- 웹/Tauri 분기는 capability로 표현하고, 지원하지 않는 동작은 숨김·대체·설명
  중 사용자 의미에 맞는 하나의 계약으로 처리한다.

## 6. 구현 단계

상위 문서의 단계는 제품 출시 게이트이고, 아래 단계는 코드 작업 순서다.
로컬 엔진 분리 PoC는 0~3단계에 걸쳐 수행하며, 실제 설치 CTA 배포는 최소
pairing/session PoC와 exact origin 검증이 통과한 뒤에만 허용한다.

현재 진행 상황(2026-08-14): 2단계의 비민감 probe, origin 분리, 민감 API 기본
거부, capability, 일회성 pairing code, 세션 갱신·폐기, 메모리 자격 증명과 프런트
연결 coordinator를 mock 및 실제 main lifecycle로 검증했다. 일반 실행의 전역
enforcement는 5단계 전환까지 끈다. 다음 단계는 실제 Windows helper·single instance,
설치·업데이트와 사용자 데이터 보존 PoC이며 운영 입력을 다시 확인한 뒤 착수한다.

### 6.1 현재 단계 상태

| 단계 | 상태 | 완료 증거 또는 남은 관문 |
| --- | --- | --- |
| 0. 계약·회귀 기준 | 완료 | 아래 inventory, `api_contract_version: 1`, 환경 변수와 simulation 기준 고정 |
| 1. 프런트엔드 런타임 경계 | 부분 완료 | `dc610b6f`; Settings coordinator는 4단계 전, authorization·capability 갱신 API는 2단계, 실제 Tauri smoke는 5단계 enforcement 전 완료 |
| 2. probe·pairing·세션 PoC | 완료 | probe·exact origin·격리 default deny·capability·일회성 code·pairing/session lifecycle·프런트 coordinator·mock 상태 전이 통과; 실제 helper는 3단계에서 닫음 |
| 3. 로컬 엔진 설치·업데이트 PoC | 부분 완료 | 3A host 경계와 3B frozen exe·실제 helper·쓰기 잠금·relocation 보존·정상 종료 통과; 3C current-user installer·실제 재설치/update·서명·rollback 필요 |
| 4. 웹 연결·복구 UX | preview 구현 진행 | 실제 Vite 화면·Mobbin 비교 기반 계약과 preview 연결 작업 레일·pairing dialog·상태 view model 구현; mock 흐름 통과, 실제 다운로드와 Chrome/Edge 권한 smoke 필요 |
| 5. 전체 API 클라이언트 전환 | 부분 구현·검증 대기 | 2026-10-14 읽기 점검: 분석·복구·상세·설정·내보내기·삭제의 공통 클라이언트 전환 소스가 있으나 미커밋 변경 포함. 음성 재생·401 갱신·전체 인증 회귀·실환경 증거는 미완료; 출시 관문은 열림 |
| 6. SQLite 기준 저장소 | 미착수 | 백업·가져오기·충돌·FTS·재실행 안전성 필요 |
| 7. 브라우저 파일 동작 | 미착수 | 실제 다운로드·한글 파일명·세션 만료 검증 필요 |
| 8. 웹 MVP 통합 검증 | 미착수 | 실제 HTTPS·Chrome/Edge·신규/기존 PC 증거 필요 |

`부분 완료`를 다음 단계 진행과 동일하게 보지 않는다. 의존하지 않는 작은 PoC는
병행할 수 있지만 남은 관문과 이월 사유를 상태표에서 지우지 않는다.

### 6.2 반복 실행 루프

각 단계는 하나 이상의 작은 작업 묶음으로 나누고 아래 순서를 반복한다.

1. 작업 계약: 목표, 우려, 직접 범위, 제외, 검증, 중단 조건을 짧게 고정한다.
2. 기존 자산 확인: 디자인 토큰·공통 컴포넌트·공통 모듈·관련 테스트를 먼저 찾는다.
3. 작은 구현: 한 번에 하나의 사용자 흐름 또는 하나의 공유 계약만 바꾼다.
4. 좁은 자동 검사: typecheck, focused unittest와 `git diff --check`를 실행한다.
5. 필요한 시뮬레이션: 변경된 상태 전이, 키보드, 오류·복구, 지원 창 크기를
   실제 브라우저 흐름으로 확인한다.
6. agent 검토: 큰 관점은 흐름·소유권·데이터·운영을, 작은 관점은 race·stale
   state·disabled·접근성·테스트 누락을 검토한다. 인증은 보안, 패키징은
   배포·운영 관점을 추가한다.
7. 판정: P0/P1과 현재 사용자 흐름·보안·저장·테스트 신뢰에 영향을 주는 P2만
   즉시 수정한다. 나머지는 `todo.md`, `roadmap.md` 또는 release QA에 기록한다.
8. 재검증: 수정한 범위의 검사와 시뮬레이션을 다시 실행한다. 차단 finding이
   있었을 때만 해당 agent 재검토를 수행한다.
9. 증거 갱신: 이 상태표와 단계별 증거에 명령·시뮬레이션·실환경 확인 결과를 남긴다.
10. 커밋: 관련 없는 사용자 변경을 제외하고 하나의 완결된 작업 묶음만 커밋한다.

문구·주석처럼 작은 변경에는 큰 관점 agent를 기계적으로 사용하지 않는다.
반대로 인증·저장·마이그레이션·설치·업데이트 단계는 자동 검사만 통과했다고
완료하지 않는다.

### 6.3 전역 중단 조건

- P0/P1 또는 현재 단계의 핵심 흐름을 막는 P2가 남아 있다.
- 집중 테스트나 필수 회귀 시뮬레이션이 실패한다.
- origin, token, default deny 또는 capability 계약이 불명확하다.
- 6단계 또는 저장소 변경 묶음에서 SQLite 백업, 원자성, 충돌과 재실행
  안전성을 증명하지 못했다.
- 실제 HTTPS origin, 코드 서명, 배포 위치처럼 해당 단계의 필수 운영 입력이 없다.
- 같은 명령·가정·접근이 두 번 실패했는데 새로운 증거 없이 반복하려 한다.
- 실제 PC나 실제 브라우저에서만 확인할 항목을 mock만으로 완료 처리하려 한다.

### 6.4 실행 증거 로그

계획 기준과 실제 통과 결과를 섞지 않는다. 각 작업 묶음은 날짜, 범위, 실행한
검사, agent 판정, 커밋과 남은 실환경 관문을 아래 표에 추가한다.

| 날짜 | 작업 묶음 | 자동·시뮬레이션 증거 | agent 판정 | 커밋·남은 관문 |
| --- | --- | --- | --- | --- |
| 2026-08-13 | 1단계 첫 런타임 경계 | `corepack pnpm --dir desktop-app typecheck`, `corepack pnpm --dir desktop-app test:runtime-boundary`, `corepack pnpm --dir desktop-app test:writer-model-readiness`, `corepack pnpm --dir desktop-app test:settings-backend-restart`, `corepack pnpm --dir desktop-app build:web`, `corepack pnpm --dir desktop-app build:desktop`, `git diff --check` 통과 | 큰/작은 관점 최종 P0·P1·현재 목표 P2 없음 | `dc610b6f`; Settings coordinator와 실제 Tauri smoke 잔여 |
| 2026-08-14 | 2단계 첫 보안 경계 | backend security 14 tests, 기존 API 대표 5 tests, `test:runtime-boundary`, typecheck, writer/settings simulation, 순차 `build:web`·`build:desktop`, `git diff --check` 통과 | 보안/회귀 agent 지적을 수정하고 최종 재검토 | pairing endpoint·nonce·mock helper와 실제 HTTPS 관문 잔여 |
| 2026-08-14 | 2단계 pairing·세션 계약 | backend security 22 tests, 실제 main lifecycle, 동시 renew/revoke, `test:runtime-boundary`, typecheck, writer/settings simulation, 순차 `build:web`·`build:desktop`, `git diff --check` 통과 | 보안/회귀 agent 최종 P0·P1·현재 목표 P2 없음 | 프런트 coordinator·mock 상태 전이, 실제 helper·HTTPS 관문 잔여 |
| 2026-08-14 | 2단계 프런트 연결 coordinator | backend security 23 tests, probe→pairing→갱신→폐기 mock, 중복·stale·만료·응답 손실, `test:runtime-boundary`, typecheck, writer/settings simulation, 순차 `build:web`·`build:desktop`, `git diff --check` 통과 | 보안/회귀 agent 최종 P0·P1·현재 목표 P2 없음 | 2단계 완료; 실제 helper·HTTPS는 3·8단계 관문 |
| 2026-08-14 | 3C-0B installer target preflight | 관련 target 68 tests, backend quick 113 tests(1 skip), Windows source smoke, `git diff --check`, 단일 frozen build와 종합 verifier 통과 | 큰/작은 관점 P1·현재 목표 P2 수정 후 좁은 재검토에서 잔여 없음 | `0.1.0-poc-stage3c0b-installer-target-preflight`; 실제 NSIS 소비·공식 용량 manifest·설치/update/reinstall 관문 잔여 |
| 2026-08-14 | 3C installer preflight 소비 소스 | installer helper/collector focused 37 tests, packaging/verifier 14 tests와 Windows source smoke 통과; closed manifest, current-user NSIS, bounded stop/readiness, same-volume stage·rollback, 선언 파일만 정리하는 복구 계약 작성 | 큰/작은 관점 agent가 readiness 오판, stop race, 중단 복구, manifest drift, 재귀 삭제와 transaction marker 순서를 지적해 수정; strict stage/transaction 회귀 테스트 보강 뒤 잔여 P0·P1·현재 목표 P2 없음 | 회사 PC에서는 helper/NSIS compile·실제 설치를 실행하지 않음. 집 PC에서 frozen payload 재사용 기반 단일 installer build와 install/update/uninstall smoke 필요 |
| 2026-08-20 | 4단계 연결·복구 UX 디자인 묶음 | 실제 Vite 웹 앱의 시작·새 회의록·설정 모델 화면과 엔진 미응답 상태를 확인하고 Mobbin companion app 연결·오류 복구·파일 입력 사례 비교; 6장면 상태표, 단일 primary 위계, 작업 레일, pairing overlay, 기존 컴포넌트 재사용표와 760/1100/1536px 검증 계약 작성 | 승인된 해양 테마와 2열 입력 구조를 보존하고 설치 여부 추측·화면별 health 재해석·사용자 대상 미검증 다운로드 CTA를 금지 | `docs/web-local-engine-connection-ux-spec.md`; mock 상태 구현·시뮬레이션, 집 PC 3C 실물 installer, 서명·manifest, 실제 HTTPS Chrome/Edge 권한 smoke와 5단계 인증 전환 필요 |
| 2026-08-20 | 4단계 연결·복구 UX preview 구현 | view model, 연결 작업 레일, pairing dialog와 preview gate 구현; 만료·거부 challenge 새 발급, focus trap·Escape 코드 삭제, provider transport 소유권 분리; runtime boundary·typecheck·760/1100/1536px mock simulation·브라우저 시각 확인 통과 | 큰/작은 관점 agent의 공통 P1과 현재 흐름 P2를 반영; 검증 가능한 권한 증거 없는 권한 장면은 만들지 않고 실제 HTTPS smoke로 보류 | 실제 installer/update URL, 낮은 높이·200% 확대·강제 색상, Chrome/Edge 권한 승인·거부·재승인, 5단계 전체 API 인증 전환 필요 |
| 2026-10-05 | 기능 인벤토리 읽기 점검 | 코드와 이 상태표 대조. 테스트·시뮬레이션은 실행하지 않음 | 회의록 6칸은 구현됨. 5~8단계는 미착수 유지. 저장 수명 결함 2건은 `todo.md`에 다음 수정으로 기록 | 상태표의 5~8단계 미착수를 바꾸지 않음. 다음 코드 수정은 저장 수명만 |
| 2026-10-05 | `c20be64` 기준 점검 | typecheck 통과, lint 6 errors, runtime-boundary 통과, backend quick 115 tests 통과, 화면 시뮬레이션 13 통과·5 실패. 상세와 재실행 범위는 아래 기준 점검 표 | 실패 5건은 제품 수정 전에 해당 시뮬레이션만 다시 연다. 통과 항목은 표의 파일이 바뀔 때만 다시 실행 | portable 검증, 실제 음성 분석, HTTPS 권한, installer build는 실행하지 않음 |

| 2026-10-14 | A1 저장 보존·린트 정리 | `corepack pnpm --dir desktop-app typecheck`, 변경 파일 `corepack pnpm exec eslint`와 diff 검사 통과. resume-draft 필터 8개·analysis-stop 7개·backend API 5개 통과. 수정 일시 손실은 보강 시나리오 실패→수정→재통과로 확인 | 저장과 복구 이벤트 수명을 분리 검토. 저장 일시 손실 1건 수정 후 같은 finding 재검토에서 잔여 차단 없음 | `c20be64` + 기존 사용자 변경을 보존한 작업 트리, 미커밋. 과거 실패 시뮬레이션 5개 재현·분류, A2 인증과 실제 HTTPS·설치 관문 잔여 |

### 2026-10-05 기준 점검 (`c20be64`)

다시 점검할 때는 바뀐 파일이 속한 행만 실행한다. 통과 행은 그 파일이 그대로면 반복하지 않는다.

| 점검 | 결과 | 실패 시 보이는 것 | 이 파일이 바뀌면 다시 실행 |
| --- | --- | --- | --- |
| `corepack pnpm --dir desktop-app typecheck` | 통과 5.8초 |  | `desktop-app/src` 타입 |
| `corepack pnpm --dir desktop-app lint` | 실패 6 errors, 1 warning | `AnalysisRecoveryCoordinator` memo 보존, `LocalEngineConnectionProvider`·`MeetingWriter` fast refresh | 같은 세 파일 |
| `test:runtime-boundary` | 통과 |  | `apiBase.ts`, `runtimeEnvironment.ts`, `localEngineClient*.ts` |
| backend quick 11개 모듈, `backend\.venv-desktop` | 통과 115 tests, 152.9초 |  | 해당 테스트 모듈과 그 대상 |
| `test:analysis-stop-flow` | 통과 84.1초 |  | 중지·취소·`MeetingWriter` 분석 수명 |
| `test:resume-draft-flow` | 통과 78.2초 | 통과가 저장 삭제·옛 완료 기록 덮어쓰기를 증명하지는 않음 | `upsertMeetingRecord`, `deleteMeetingRecordForJob`, `AnalysisRecoveryCoordinator` |
| `test:generation-flow` | 통과 |  | 기록 정리 상태 |
| `test:edit-guard-flow` | 통과 |  | 편집 가드 |
| `test:close-guard-flow` | 통과 |  | 닫기 가드 |
| `test:settings-backend-restart` | 통과 |  | 설정 재시작 |
| `test:settings-model-management` | 통과 |  | 모델 설정 |
| `test:topic-generation-ui` | 통과 |  | 주제별 정리 상태 |
| `test:start-workspace-flow` | 통과 |  | `StartWorkspace`, `startWorkspaceModel` |
| `test:meeting-archive-flow` | 통과 |  | `MeetingArchive` |
| `test:writer-model-readiness` | 통과 |  | 작성 화면 모델 준비 |
| `test:download-scope-flow` | 통과 |  | 내보내기 범위 |
| `test:report-tab-edge-flow` | 통과 |  | 보고서 탭 |
| `test:resume-flow` | 실패 | `?view=minutes`에서도 `분석 완료`가 안 열리고 `Failed to fetch` | `simulate-resume-flow.mjs`, 분석 시작 요청 |
| `test:audio-extract-ui` | 실패 | 주소에 `view`가 없어 시작 화면이 열리고 `새 회의록` 제목을 못 찾음 | `simulate-audio-extract-ui.mjs`, `appView.ts` |
| `test:meeting-detail-flow` | 실패 | 사이드바 회의 메뉴를 Enter로 열어도 `[data-sidebar-record-menu]` 안에 포커스가 안 들어감 | `Sidebar.tsx`, `simulate-meeting-detail-flow.mjs` |
| `test:local-engine-connection-ui` | 실패 | 연결 창에서 Shift+Tab 뒤 포커스가 `연결 코드 입력 닫기`에 있지 않음 | `LocalEngineConnectionSurface.tsx`, 해당 시뮬레이션 |
| `test:template-selection-flow` | 실패 | `되돌리기` 클릭이 `app-header`에 가려지고 버튼이 DOM에서 떨어짐 | `MeetingHistory.tsx` 토스트, `Header.tsx` |

실행하지 않은 항목: portable 배포 검증, 실제 음성·영상 분석, Chrome/Edge 로컬 네트워크 권한, installer build/smoke, `backend.test_api`. 이 항목은 해당 파일을 고쳐도 위 표의 통과를 대체하지 않는다.

### 6.5 2026-10-14 체계적 에이전트 점검 계획

목표는 바로록의 현재 구현, 검증된 기능과 출시 전 남은 관문을 구분하고 점검 순서·증거·완료 기준을 고정하는 것이다. 제품은 HTTPS 웹 UI + 사용자 PC의 Windows 로컬 엔진이다. 이번에는 계획 문서만 편집하며 제품 코드 수정·배포는 후속 묶음에서 진행한다.

#### 기준과 분담

- 기준: `HEAD c20be64` + 시작 시 미커밋 12개 파일. 기존 변경을 보존하고 후속 묶음마다 diff·파일 목록을 다시 고정한다.
- 주 에이전트가 초안·우선순위·최종 판정을 소유한다. 독립 에이전트 3명이 제품·배포, 연결·보안·개인정보, 저장·복구·테스트를 읽기 검토해 계획을 보완했다.
- 한 번에 사용자 흐름 또는 공유 계약 하나만 검토한다. 큰 관점은 목적·소유권·수명·운영, 작은 관점은 stale 응답·race·경계 입력·복구·테스트 누락이다. 같은 전체 검토를 중복 배정하지 않는다.
- 읽기 점검은 병렬로, 브라우저·테스트·서버·빌드·겹치는 편집·Git 작업은 순차로 실행한다. 다른 세션의 프로세스나 사용자 변경은 건드리지 않는다.
- 제외: 순수 WASM/WebGPU, 모바일·PWA, 원격 SaaS 분석, Tauri 릴리스, 전면 리디자인, 전체 장시간 성능 평가. 실제 음성 품질과 지원 사양은 대표 표본부터 점검한다.

#### 현재 상태와 증거 구분

- 실제 저장은 `meetingRepository.ts`의 IndexedDB, `analysisResumeDrafts.ts`의 localStorage와 엔진 JSON/체크포인트로 나뉜다. SQLite와 브라우저 캐시 삭제 후 기록 보존은 목표 계약이다.
- production standalone의 loopback·probe·origin·pairing·세션 코드는 있다. 전체 화면 인증 적용과 세션 만료 복구는 별도 완료 증거가 필요하다.
- 현재 installer PoC는 unsigned이며 `distributionReady=false`다. 설치 소스와 실제 설치 성공을 구분한다. 공개 HTTPS URL·서명된 installer 존재 여부는 이번 읽기 점검에서 확인하지 않았다.
- 2026-10-05 결과는 과거 기준이다. 변경된 행만 재검증하고 과거 실패 수를 최신 결함 수로 쓰지 않는다.
- 증거는 코드 대조 / mock 시뮬레이션 / 실제 엔진 API / 실제 음성 추론 / HTTPS·설치 PC로 구분한다. 하나의 통과로 다른 실행 환경의 완료를 대신하지 않는다.

#### 실행 순서와 완료 기준

| 순서 | 점검 묶음 | 직접 범위·좁은 증거 | 종료 조건 |
| --- | --- | --- | --- |
| A1 | 최신 기준·기록 보존 | HEAD/diff/문서 상태, typecheck·변경 파일 lint·diff 검사; 완료·legacy·중지·실패·편집 기록의 stale partial/이어하기 취소 필터 시뮬레이션; 관련 backend 복구 API | 사용자 결과·ID·편집 대화록 보존, 완료 JSON 우선, 최신 실패 목록·원인 분류 확보 |
| A2 | 연결·인증·개인정보 | probe 제품·버전·포트, 실제 API 목록; GET·mutation·SSE·audio HEAD/GET/Range·다운로드의 정상/무토큰/만료/변조/다른 origin; pairing·401 갱신·폐기·로그·외부 전송 | 정상 인증 흐름 성공 및 비허용 요청 거부, 폐기 token 부활 없음, 민감 로그·원격 음성 전송 없음 |
| A3 | 저장·생성·내보내기 | IndexedDB/엔진 JSON과 목표 SQLite; A 회의 생성 중 B 이동·재생성 실패·빈 speakerLabels·수정→재열기→scope별 실제 파일; SQLite 백업·revision·원자성·중복 가져오기 | 회의 간 결과 침투 없음, 정상 결과 보존, 화면/저장/JSON/내보내기 일치; SQLite 미완이면 캐시 독립 보존 출시 관문 유지 |
| A4 | 사용자 흐름·접근성·모델 품질 | 시작→새 기록→분석→중지/이어하기→대화록→정리/보고서→기록 찾기→설정/내보내기; loading/empty/disabled/error/recovery·키보드·지원 폭; 실제 짧은 WAV/video·모델 미준비 | 다음 행동·복구 일관, overflow·포커스 유실 없음, 실패 계층 분류, 생성 결과 근거·출처 확인 |
| A5 | 설치·업데이트·다른 PC | frozen payload/manifest 재사용 후 필요한 단일 installer build; fresh install/update/중단 복구/rollback/uninstall-reinstall·data sentinel·실제 분석; 서명·모델 다운로드 중단/재개 | 데이터 보존·복구, 실행·모델·분석·내보내기 실물 성공, 서명·manifest 검증 |
| A6 | 실제 HTTPS 출시 판정 | 확정 origin + Chrome/Edge + 신규/기존 Windows PC; 설치→권한 승인/거부/재승인→pairing→모델→분석→재생→저장/검색/다운로드; 네트워크 기록·회사 정책 | 지원 환경·외부 전송 경계 실물 증거, A1~A5 출시 차단 종료, 기존 8단계 완료 정의 충족 |

이 표는 기존 구현 0~8단계를 대체하는 기능 로드맵이 아니라 현재 상태를 판정하는 점검 순서다. 발견된 구현 작업은 기존 해당 단계에 연결한다.

#### 첫 실행 묶음과 우선 확인

1. A1에서는 저장 수명 diff와 최신 검사를 고정한다. `test:resume-draft-flow`의 `completed-meeting-rejects-stale-partial`, `legacy-saved-meeting-rejects-stale-partial`, `stopped-meeting-keeps-generated-sections`, `failed-meeting-keeps-generated-sections`, `resume-moves-settled-meeting-to-in-progress`, `completed-result-clears-outdated-summary`, `edited-transcript-skips-outdated-note`, `resume-cancel-keeps-user-result`만 필터 실행한 뒤 `test:analysis-stop-flow`를 순차 실행한다.
2. backend `AnalyzeApiTest`의 draft-status, partial-result, recoverable 손상 fallback, cancel cleanup 관련 메서드만 검증한다. 전체 API/Playwright/portable 빌드는 포함하지 않는다.
3. 이전 실패 5개는 변경 파일과 원인별로 집중 재현한다. 도구 기동·초기 page.goto 실패, 변경된 요구에 따른 stale assertion, 실제 제품 결함을 구분한다.
4. A2 코드상 불일치: `MeetingHistory.tsx`의 인증 audio HEAD에 대해 `main.py` CORS 메서드에 HEAD가 없다. audio HEAD/GET의 `_require_save_copy_origin`은 localhost/Tauri 목록을 검사하고 standalone은 `LMO_WEB_ALLOWED_ORIGINS`만 설정한다. `<audio src>`는 Bearer 없는 직접 GET이다. 정상 HTTPS 인증 재생 계약과 불일치하며 실제 재현이 필요하다. 무단 접근 결함으로 판정한 것은 아니다.
5. A2 코드상 누락: `localEngineClientCore.ts`에는 5단계의 401 1회 갱신·재시도가 아직 연결되지 않았다. 요청 종류별 복구와 업로드 중복 실행 방지를 검증한다.
6. A3 가설: A 생성 응답이 B 화면의 탭·검색·스크롤·알림에 영향을 주는지, 내보내기 실패 시 이전 파일 fallback이 현재 revision과 맞거나 명확히 안내되는지 확인한다. 아직 실행 재현된 결함으로 분류하지 않는다.

#### 이번 계획 수립의 검사와 기록

- `corepack pnpm --dir desktop-app typecheck`: 통과.
- 변경 파일 lint: `desktop-app`에서 `node node_modules/eslint/bin/eslint.js src/AnalysisRecoveryCoordinator.tsx src/MeetingDownloadControl.tsx src/MeetingHistory.tsx src/MeetingWriter.tsx src/Settings.tsx src/Sidebar.tsx src/localEngineClient.ts scripts/simulate-analysis-stop-flow.mjs scripts/simulate-resume-draft-flow.mjs` 실행. 샌드박스에서 결과 없이 대기해 같은 프로젝트 도구를 권한 경계 밖에서 실행했다.
- 결과: 5 errors·1 warning. `AnalysisRecoveryCoordinator.tsx`의 `react-hooks/preserve-manual-memoization` 1건, `MeetingWriter.tsx`의 `react-refresh/only-export-components` 4건과 `react-hooks/exhaustive-deps` warning 1건. A1 수정 후보이며 전체 저장소 lint 오류 수는 아니다.
- 시뮬레이션·실제 분석·installer build·HTTPS·다른 PC 검증은 이번에 실행하지 않았다. 계획 수립을 전체 점검 통과로 표시하지 않는다.
- 결과는 기존 실행 증거 로그에 날짜·소스 기준·정확한 명령·관찰 결과·환경·agent 판정·남은 관문으로 남긴다. P0/P1 및 흐름·인증·저장·배포·검증 신뢰를 막는 P2는 해당 묶음의 차단 항목이다. 가설/미확인은 실패와 분리한다.
- 실제 PC·회사 정책·HTTPS·서명 등 현재 닫지 못한 항목은 기존 3단계 release QA 위험 표의 같은 행에 상태·필요 증거·종료 조건·마지막 확인일을 유지한다. 반복 항목을 복제하지 않는다.
- `todo.md`에는 다음 실행 묶음과 이 절 링크만 둔다. 새 프로젝트 연결·배포 확대는 출시 관문 판정 뒤 진행한다.

#### A1 저장 보존 실행 결과 — 2026-10-14

- 수행 범위: 저장·복구 함수 및 결과 타입을 `analysisMeetingPersistence.ts`로 이동하고 작성 화면과 복구 coordinator가 공유한다. 기존 미커밋 저장 규칙을 보존했으며, 복구 동기화는 mount effect 내부에서 기존 잠금·queued retry·이벤트·cleanup을 유지한다. 분석 준비 함수에는 안정 callback과 실제 의존성을 연결했다.
- 수정한 실제 결함: 중지/실패 기록의 수정 일시가 오래된 복구 초안으로 덮였다. 보강된 stopped 시나리오에서 저장값 `2026-05-14 11:00`이 draft 값 `2026-05-13 09:30`으로 돌아가는 실패를 먼저 확인했다. 병합 시 저장된 회의 일시를 우선하고, 공통 생성 결과 보존 시나리오에 날짜가 다른 fixture·보존 assertion을 넣었다.
- 타입 검사: `corepack pnpm --dir desktop-app typecheck` 통과.
- 린트: `desktop-app`에서 `corepack pnpm exec eslint src/analysisMeetingPersistence.ts src/AnalysisRecoveryCoordinator.tsx src/MeetingWriter.tsx scripts/simulate-resume-draft-flow.mjs scripts/simulate-analysis-stop-flow.mjs` 통과. 기존 A1 대상의 나머지 변경 파일도 집중 검사에서 오류가 없었다. 전체 저장소 lint 완료로 표시하지 않는다.
- UI 계약: 위 첫 실행 묶음의 resume-draft 필터 8개와 `corepack pnpm --dir desktop-app test:analysis-stop-flow`의 7개가 통과했다. 수정 일시 보존, 완료/legacy에 대한 stale partial 차단, 중지·실패 생성 결과, 편집 대화록, 이전 기준 표시 해제, 이어하기 취소를 확인했다.
- API 계약: `backend\.venv-desktop\Scripts\python.exe -B -X utf8 -m unittest`로 `backend.test_api.AnalyzeApiTest`의 `test_draft_statuses_returns_backend_truth_for_active_and_completed_jobs`, `test_partial_result_endpoint_returns_saved_transcript_for_ui`, `test_recoverable_result_falls_back_when_final_json_is_corrupt`, `test_delete_analysis_draft_removes_resume_artifacts_without_outputs`, `test_delete_analysis_draft_rejects_active_analysis_job`을 검증했다. 4개는 첫 실행 통과, 초안 정리 1개는 샌드박스의 임시 jobs 폴더 생성 WinError 5 때문에 차단돼 그 메서드만 권한 경계 밖에서 재실행해 통과했다.
- 검증 환경: Windows, Vite `corepack pnpm --dir desktop-app dev --host 127.0.0.1 --port 5187 --strictPort`, 작업 폴더 프로젝트 루트, `APP_URL=http://127.0.0.1:5187/?view=minutes`. HTML 제목 `바로록`으로 대상 프로젝트를 확인했다. 실제 캐시는 `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`이며 예전 문서의 `D:\Projects\LMO_audio` 경로는 이 PC에 없었다. 기존 서버를 재사용하거나 종료하지 않았다.
- 독립 검토: 저장 관점은 일시 손실을 발견·재검토했고, 복구 이벤트 관점은 함수 이동 후 단일 실행 잠금·retry·cleanup과 readiness effect 수명이 유지됨을 확인했다. 같은 finding 기준 A1 저장 보존 차단은 남지 않았다.
- 검증 종료 후 이번 세션의 Vite PID와 프로젝트 명령줄을 확인해 5187 서버만 종료했고 포트 해제를 확인했다. 기존 세션의 서버는 종료하거나 변경하지 않았다.
- 잔여: A1의 과거 시뮬레이션 실패 5개는 아직 최신 소스로 재현하지 않았다. 다음 묶음에서 영향 파일과 원인별로 분류한다. A2 인증 재생·401 복구, SQLite, 서명된 installer와 실제 HTTPS 검증도 열린 상태다. 이번 통과는 mock UI/로컬 API 계약이며 실제 음성 추론·설치 PC·외부 배포 검증을 대체하지 않는다.

#### A1 과거 실패 시뮬레이션 후속 — 2026-10-14

저장 보존 묶음 뒤의 후속 점검이다. 디자인은 다른 AI가 변경 중이므로 그 소스·스타일·디자인 문서는 수정하지 않았고, 현재 기능 계약과 검증 신뢰만 다뤘다. `c20be64`에 기존 미커밋 변경이 있는 작업 트리 기준이며 원격의 후속 2개 커밋은 이 묶음에서 병합하지 않았다.

| 대상 | 관찰·분류와 조치 | 수정 후 결과 |
| --- | --- | --- |
| `test:resume-flow` | 시작 직전 설정 조회에 mock이 없어 실제 backend 상태에 의존했다. `/api/settings`를 명시하고 재사용·fallback multipart 및 완료 단언은 유지 | 통과 |
| `test:audio-extract-ui` | 현재 첫 화면 진입 및 숨겨진 독립 음성 추출 도구와 테스트 요구가 달랐다. `?view=minutes`로 진입하고 privacy·응답 역전·조회 실패 검사를 유지하며 숨겨진 버튼·입력 없음과 추출 요청 0건을 확인 | 통과 |
| `test:meeting-detail-flow` | 사이드바 메뉴가 숨겨진 상태에서 포커스되는 실제 경합을 재현했다. 위치 반영 뒤 최신 panel ref에 포커스하는 effect로 분리했다. 마지막 Tab은 기존의 메뉴 밖 포커스 조건을 기다린 뒤 같은 단언 수행 | 통과 |
| `test:local-engine-connection-ui` | 이 묶음에서 기존 검사도 통과했으나 입력 표시와 포커스 완료는 별도 시점이다. 최초·재진입의 실제 입력 포커스를 기다리고 기존 키 순환 단언 유지 | 통과 |
| `test:template-selection-flow` | DB 복원과 select의 화면 반영 사이 경합을 확인했다. 화면 값까지 기다리고 현재 report tabpanel을 기준으로 확인한다. 일반 클릭·복원 데이터·다른 회의 보존 단언 유지 | 통과 |

- 실행 환경: Windows, 이 세션에서 프로젝트 루트의 `corepack pnpm --dir desktop-app dev --host 127.0.0.1 --port 5187 --strictPort`로 띄운 Vite와 `APP_URL=http://127.0.0.1:5187/?view=minutes`. 연결 preview 검사는 `&localEngineConnection=1`을 추가했다. `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`를 사용하고 시뮬레이션 모듈을 순차 실행했다. mock UI 검증이지 실제 HTTPS·설치·음성 추론의 증거는 아니다.
- 타입 검사: `corepack pnpm --dir desktop-app typecheck` 통과 후 실행 shim이 사라졌다. 당시 존재하는 TypeScript 본체를 `desktop-app`에서 `node node_modules/typescript/bin/tsc --noEmit`으로 실행해 통과했다.
- 린트: 마지막 2개 테스트 대기 보강 이전의 변경 파일 집중 검사는 통과했다. 최종 `node node_modules/eslint/bin/eslint.js src/Sidebar.tsx scripts/simulate-resume-flow.mjs scripts/simulate-audio-extract-ui.mjs scripts/simulate-local-engine-connection-ui.mjs scripts/simulate-template-selection-flow.mjs scripts/simulate-meeting-detail-flow.mjs`는 `@eslint-community/eslint-utils`를 찾지 못해 실행 차단됐다. 제품 코드 오류로 판정하지 않는다.
- 환경 상태: 사용자 제공 작업 화면으로 다른 AI가 worktree 정리 후 손상된 `node_modules`를 lockfile 기준 재설치 중임을 확인했다. 중복 설치·다른 AI의 서버 종료·디자인 덮어쓰기는 하지 않는다. 5187 listener는 이후 확인에서 없었다.
- 독립 agent 검토: 설정 mock·숨겨진 도구 요구, 복원·보고서 테스트 계약, 메뉴·pairing 포커스 수명의 세 범위로 나눴다. 테스트 단언을 약화하지 않았고 수정 후 검토에서 현재 A1 차단 사항은 없었다. `AGENTS.md`에 구현 후 집중 검사와 독립 agent 검토 규칙을 추가했다.
- 최종 보류 해소: 의존성 복구 후 `corepack pnpm --dir desktop-app typecheck` 통과. `corepack pnpm exec eslint`는 실행 링크 검색 오류로 시작되지 않아, `desktop-app`에서 위 파일 목록의 `node node_modules/eslint/bin/eslint.js ...`를 실행해 통과했다. `git -c core.excludesFile= diff --check`도 통과했다. A1의 이 수정 범위는 종료하며 5개 시뮬레이션 전체를 반복하지 않았다. 이후 다른 AI가 커밋·편집한 디자인의 증거는 별도로 유지한다.

#### A2 인증된 음성 조회 백엔드 — 2026-10-14

- 범위: `backend/main.py`의 audio GET/HEAD와 실제 CORS 구성만 수정했다. 공통 인증 미들웨어, 공개 endpoint, save-copy·음성 추출 쓰기 조건, 프런트 디자인은 바꾸지 않았다. 작업 시작 HEAD는 `bdeadad`였으며 병렬 디자인 작업으로 HEAD가 바뀌어도 이 backend 변경은 미커밋으로 남겨 두었다. 원격 병합·커밋·push·빌드는 수행하지 않았다.
- 실패 재현: 새 `test_main_audio_https_head_get_and_range_require_valid_session`이 수정 전 `Disallowed CORS method` 400으로 실패했다. CORS에 HEAD를 추가하고 audio 전용 origin 검사로 GET/HEAD를 연결했다. 인증 강제 상태에서는 `configured_exact_origins()`만 사용하며 legacy save-copy override는 이 경계를 넓히지 못한다. 인증을 끈 개발·데스크톱 실행은 기존 save-copy origin 검사에 그대로 위임한다.
- 정상 계약: 허용 HTTPS origin과 유효 `export` 세션에서 HEAD 200·빈 본문·길이/타입, GET 200·기대 바이트, Range GET 206·구간 바이트와 `Content-Range`를 확인했다. 테스트는 실제 main route와 middleware 옵션을 복제하되 origin·세션 저장소만 격리하고 실제 파일 응답을 사용한다. 테스트용 HTTPS origin은 배포 주소가 아니다.
- 거부 계약: GET/HEAD의 토큰 없음·변조·만료·폐기·origin 불일치·권한 부족을 거부한다. 다른 origin 및 legacy override로 발급한 세션도 production 허용 목록을 우회하지 못한다. 잘못된 경로형 작업 번호 400과 파일 없음 404, 정상 웹 읽기 권한만으로는 save-copy 403을 유지한다.
- 검사: `backend\.venv-desktop\Scripts\python.exe -B -X utf8 -m unittest backend.test_local_engine_security` 27개 통과. 같은 interpreter로 `backend.test_api.AnalyzeApiTest`의 `test_audio_output_accepts_allowed_origin`, `test_audio_output_rejects_missing_origin`, `test_save_copy_rejects_missing_origin`, `test_save_copy_rejects_disallowed_origin`, `test_save_copy_accepts_allowed_origin`, `test_save_copy_accepts_env_configured_origin`을 집중 실행해 6개 통과했다. localhost/Tauri는 GET·HEAD·본문/길이까지 보강했다.
- 테스트 보정: 첫 집중 실행에서 `invalid!job`를 잘못된 작업 번호라고 가정한 새 assertion 1개가 실패했다. 기존 검증은 경로 탈출·`..`를 거부하므로 fixture를 `invalid..job`로 바로잡고 재통과했다. 제품의 ID 계약을 불필요하게 제한하지 않았다. Starlette의 TestClient/httpx 폐기 예정 경고는 기존 도구 경고이며 이 범위에서 의존성을 변경하지 않았다.
- 구현 후 독립 agent 검토: 보안의 큰 관점은 출처·권한·파일쓰기 분리를, 테스트의 작은 관점은 실제 route/CORS 설정, Range 응답·거부·legacy 호환 단언을 확인했다. 현재 범위의 차단 사항은 남지 않았다.
- 잔여: 이것은 backend HTTP 계약의 완료이지 A2 전체 완료가 아니다. 브라우저 `<audio src>`의 Bearer 처리, 공통 클라이언트 401 1회 복구·만료 전이·중복 분석 방지, 실제 HTTPS Chrome/Edge와 설치 PC 검증은 열려 있다. 다음은 디자인 소스와 겹치지 않는 공통 인증 복구 묶음이며, 이후 음성 플레이어 연결은 디자인 작업과 조율한다. 운영 인증 강제 플래그나 배포 설정은 켜지 않았다.

#### A2 공통 401 복구 — 2026-10-14

- 수행 범위: 공통 client가 요청을 보내기 전에 인증 작업·사용자 의도를 캡처하고, 런타임 웹 Bearer 요청이 `401` + `WWW-Authenticate: Bearer`를 받은 경우만 갱신·재전송을 1회 시도한다. Provider가 복구를 등록하고 해제 시 옛 작업을 무효화한다. 공개 probe/pair, 명시적 session 관리, Tauri action token은 자동 웹 복구에 들어가지 않는다. 브라우저가 거부 헤더를 읽도록 기존 CORS의 응답 헤더 공개에 `WWW-Authenticate`만 추가했다.
- 중복 실행 방지: 동일 갱신은 공유하고 갱신/실패 정리는 5초로 제한한다. FormData·검색 매개변수·바이너리 본문은 전송 전에 복사하며 재전송 내용과 작업 번호를 유지한다. 스트리밍 업로드는 재전송하지 않는다. 이미 시작된 200 SSE의 본문 오류, 네트워크 실패, 일반 401·403·500은 자동 재실행하지 않는다. 갱신 실패나 재시도한 인증의 재거부는 해당 현재 세션만 만료시킨다.
- agent 수정: 두 독립 검토가 지연된 최초 401의 복구 누락과 사용자 pairing/revoke보다 늦게 시작한 복구가 사용자 작업을 밀어내는 경합을 발견했다. 사용자 의도와 자동 갱신 작업 세대를 구분해 같은 연결의 완료된 갱신만 재사용한다. 새 연결·폐기·dispose 및 다른 엔진 주소로의 재전송은 차단한다. 두 반대 응답 순서 회귀를 추가하고 같은 finding 재검토에서 차단 없음으로 종료했다.
- 린트 정리: 변경한 Provider의 기존 component/hook 혼합 export 오류를 해소하려고 Context·공용 hook·타입을 `LocalEngineConnectionContext.ts`로 이동했다. 소비자 두 곳은 import만 바꿨다. 화면 배치·스타일·복사 문구는 수정하지 않았다.
- 자동 검사: `corepack pnpm --dir desktop-app test:auth-recovery` 22개, `corepack pnpm --dir desktop-app test:runtime-boundary`, `corepack pnpm --dir desktop-app typecheck` 통과. `desktop-app`에서 `node node_modules/eslint/bin/eslint.js src/localEngineClientCore.ts src/localEngineClient.ts src/localEngineConnectionCoordinator.ts src/LocalEngineConnectionProvider.tsx src/LocalEngineConnectionContext.ts src/LocalEngineConnectionSurface.tsx src/MeetingWriter.tsx scripts/test-auth-recovery.mjs scripts/simulate-local-engine-connection-ui.mjs` 통과. `backend/.venv-desktop/Scripts/python.exe -B -X utf8 -m unittest backend.test_local_engine_security` 27개도 공개 헤더 단언을 보강한 뒤 통과했다.
- 브라우저 검사: 프로젝트 루트의 `corepack pnpm --dir desktop-app dev --host 127.0.0.1 --port 5191 --strictPort`, `APP_URL=http://127.0.0.1:5191/?view=minutes&localEngineConnection=1`, `PLAYWRIGHT_BROWSERS_PATH=D:/Projects/audio/.cache/ms-playwright`에서 `corepack pnpm --dir desktop-app test:local-engine-connection-ui` 통과. HTML 제목 `바로록`으로 대상을 확인했다. 성공은 갱신 1회/API 2회와 준비 완료, 실패는 추가 갱신 1회/API 1회와 만료 표시·분석 버튼 비활성화·제목/목적/파일 보존을 확인했다. 760/1100/1536px의 기존 키보드·넘침 검사도 유지했다.
- 증거 한계·실패 분류: 첫 회귀는 수정 전 401 반환으로 실패했다. 테스트 전용 `timeoutMs`가 native fetch까지 전달된다고 가정한 단언은 실제 5초 제한 동작을 검증하는 것으로 교체했다. 브라우저 초기 health 요청 수 검사는 배경 readiness 요청이 섞여 실패해 전용 산출물 경로로 격리했다. 실제 페이지에서 module API를 호출한 scripted 통합 검사이며 실제 backend handler 실행 횟수·음성 추론·HTTPS 배포 성공을 증명하지 않는다.
- 잔여: 다음은 인증된 브라우저 음성 재생이다. 실제 HTTPS Chrome/Edge, 사용자 설치 PC와 배포 인증 강제 관문은 계속 열려 있다. 다른 AI의 디자인·커밋을 보존했고 이 묶음에서 원격 병합·커밋·push·전체 빌드·의존성 설치는 하지 않았다. 검증용 5191의 PID 2360과 프로젝트 Vite 명령줄을 확인해 해당 서버만 종료하고 포트 해제를 확인했다. 기존 디자인 서버는 변경하지 않았다.

#### A2 인증된 브라우저 음성 재생 — 2026-10-15

- 범위: 시작 HEAD `57ebb09`와 진행 중인 미커밋 변경 위에서 음성 전송·수명만 연결했다. 다른 AI의 디자인 편집·커밋을 보존했으며 기존 native 플레이어의 배치·스타일은 바꾸지 않았다. 원격 병합·커밋·push·portable 빌드·의존성 설치는 하지 않았다.
- 결정: `<audio src>`에 Bearer를 직접 붙일 수 없으므로 같은 출처의 서비스 워커(Service Worker)를 음성 중계에만 사용한다. 워커는 실제 요청 창에 임의 UUID 식별자를 전달하고, 창의 메모리에서 해당 작업의 고정 audio 경로로 해석한다. 기존 공통 client가 인증·401 복구를 처리하며 응답 스트림을 워커에 전달한다. 인증 토큰은 URL·워커 메시지·저장소에 넣지 않는다. 전체 Blob 다운로드, 쿠키·음성 접근 토큰 발급, PWA·오프라인·Cache API는 추가하지 않았다.
- 경계: GET/HEAD와 단일 byte Range만 전달하고 응답의 타입·길이·구간 헤더만 공개한다. 기존 다른 워커가 있으면 덮어쓰지 않는다. 음성 이외의 요청은 중계하지 않으며 워커 자체는 로컬 엔진을 호출하지 않는다. backend CORS에 Range 요청과 `Content-Range`·`Accept-Ranges` 읽기를 허용하되 origin·세션·파일쓰기 권한은 넓히지 않았다. Tauri의 기존 직접 재생 경로는 유지한다.
- 수명·오류: 회의·원본 변경, 인증 만료·폐기, 화면 종료에 기존 식별자를 폐기하고 진행 중 본문 reader를 취소한다. 헤더 수신 후에도 취소가 연결되도록 별도 스트림 래퍼를 사용한다. 오래된 비동기 결과는 새 회의에 노출하지 않는다. 404만 원본 없음으로 분류하고 인증·네트워크·워커 준비 실패는 재시도 가능한 재생 오류로 구분한다.
- 근거: [WHATWG transferable streams 설명](https://github.com/whatwg/streams/blob/main/explainers/transferable-streams.md)의 워커 응답 스트림 전달 방식을 사용한다. [Chrome Local Network Access 안내](https://developer.chrome.com/blog/local-network-access)에 따른 권한·관리 정책은 실제 HTTPS에서 별도 검증해야 하며 워커를 사용한다고 권한 검증을 통과한 것은 아니다.
- 자동 검사: `corepack pnpm --dir desktop-app test:audio-playback-transport` 9개·`corepack pnpm --dir desktop-app typecheck` 통과. `desktop-app`에서 `node node_modules/eslint/bin/eslint.js src/audioPlaybackTransport.ts src/localAudioPlayback.ts src/useMeetingAudioPlayback.ts src/MeetingHistory.tsx public/local-audio-worker.js scripts/test-audio-playback-transport.mjs scripts/simulate-audio-playback.mjs` 통과. `backend/.venv-desktop/Scripts/python.exe -B -X utf8 -m unittest backend.test_local_engine_security.LocalEngineSecurityTest.test_main_audio_https_head_get_and_range_require_valid_session`도 Range 사전 요청 허용 단언까지 보강한 뒤 통과했다. 실제 HEAD·206/416 및 CORS를 검사한다. 기존 Starlette/httpx 폐기 예정 경고는 의존성 변경 없이 기록만 유지한다.
- 브라우저: 루트의 `corepack pnpm --dir desktop-app dev --host 127.0.0.1 --port 5194 --strictPort`, `APP_URL=http://127.0.0.1:5194/?view=minutes`, `PLAYWRIGHT_BROWSERS_PATH=D:/Projects/audio/.cache/ms-playwright`에서 `corepack pnpm --dir desktop-app test:audio-playback`과 `test:meeting-detail-flow` 통과. 제목 `바로록`으로 대상을 확인했다. 새 검사는 유효 20초 WAV의 실제 native 재생, seeked 완료·12.2초 이후 재생 진행, 모든 GET의 Bearer와 Range, 회의 전환·이전 URL 404·빈 CacheStorage·워커 소유권 충돌 거부를 확인한다. API와 인증 세션은 fixture다.
- 빌드: 정적 워커의 배포 포함 경계만 확인하기 위해 `corepack pnpm --dir desktop-app build:web`을 실행해 통과했고 `dist/local-audio-worker.js`가 원본과 같은 바이트임을 확인했다. 500 kB 초과 chunk 경고가 있었으나 빌드 오류는 아니다. 이번 목적과 무관한 코드 분할은 추가하지 않았다.
- 실패·검토: 첫 회의 선택 실패는 fixture의 갱신 이벤트를 실제 `meetings:updated`로 고쳐 해소했다. 이어진 초기 플레이어 표시 대기 1회 timeout은 원인 미확정으로 남기고 재실행을 구분 기록한다. 이후 warmed 서버에서 원래 검증과 강화 검증이 각각 통과했다. 보안·테스트의 독립 agent가 구현을 검토했으며 seek 검증과 416 fixture 보강 2개를 반영하고 재검토에서 차단 없음으로 종료했다. 통과를 장시간 스트리밍 성능이나 실제 HTTPS 성공으로 확대하지 않는다.
- 다음: 전체 API 인증 목록의 잔여 경로 점검을 진행한다. 실제 HTTPS·설치 PC·stable Chrome/Edge·장시간 파일의 native 재생과 취소는 아래 출시 위험 표에서 계속 열린 상태로 관리한다. 검증 서버 5194는 이 작업이 시작한 PID 18924와 저장소 Vite 명령줄을 확인해 종료했다. 종료 직후 포트 조회에는 해제 지연이 있었으나 재조회에서 프로세스·listener가 모두 없음을 확인했다. 다른 디자인 서버는 변경하지 않았다. 최종 `git -c core.excludesFile= diff --check` 통과.

#### A2 남은 API 인증 경로 점검 — 2026-10-15

- 범위: 최신 `desktop-app/src`와 음성 워커의 직접 전송, native media/download 경로, `main.py`의 실제 API와 `local_engine_security.py` 권한 분류를 대조했다. 검증 시 HEAD는 다른 AI의 디자인 커밋 `ac5bc21`이며 기존 미커밋 변경을 보존했다. 디자인·모델/추론·저장 스키마·배포 설정은 변경하지 않았고 커밋·push·원격 병합도 하지 않았다.

| 호출 범위 | 대조 결과 | 이번 조치·남은 예외 |
| --- | --- | --- |
| 분석·복구·진행·중지 | Writer/Recovery/History의 공통 request/stream 사용 | 추가 전환 없음 |
| 모델·설정 | Settings의 timeout 래퍼도 공통 request에 위임 | 추가 전환 없음 |
| 결과·저장 동기화·삭제·내보내기 | History/Sidebar/Download의 공통 request/download 사용; 다운로드는 인증 응답 후 Blob 저장 | 추가 전환 없음 |
| 연결·pairing·갱신·폐기 | probe/pair/session 전용 공통 메서드 | 공개 경로 확대 없음 |
| 개발용 결과 목록·상세·seed | AsrBenchmark 2개 + App helper 1개가 직접 fetch | 공통 request로 전환, ID 인코딩·기존 오류 처리 유지 |
| native bootstrap health | 공통 client의 주소 결정자 내부이므로 독립 전송 필요 | native restart 반환 주소에만 desktop header; 탐색은 무인증 유지 |
| 음성 자동 GET/Range | 웹은 앞 묶음의 인증 중계; Tauri는 기존 직접 API src | Tauri 포함 강제 활성화 전 인증 전달·실물 검증 필요 |

- 재발 방지: `test-api-auth-boundary.mjs`가 현재 TS/TSX와 음성 워커를 AST로 확인한다. 화면의 직접 fetch는 0개이며 전체 소스의 전송 호출은 `localEngineClient.ts` adapter 1개, `localEngineClientCore.ts` injected transport 1개, `apiBase.ts` native bootstrap 1개뿐이다. 새 transport constructor도 검토 없이 추가할 수 없게 한다. 별칭·임의 동적 호출까지 증명하는 완전한 데이터 흐름 분석은 아니며 native src는 별도로 읽기 점검했다.
- backend inventory: 실제 API route 45개 중 명시 공개는 GET probe와 POST pair/start·pair/complete 3개다. 나머지 42개는 분석·모델관리·내보내기·기록저장·세션관리 권한으로 분류된다. 실제 route의 분류 누락 guard를 추가했으며 정책 코드와 caller를 함께 대조했다. 분류됨 자체가 모든 handler의 실환경 성공 증거는 아니다.
- 발견·수정한 현재 목표 P2: 권한 판정이 전체 outputs URL의 `/generate-`·`/generation-` 문자열을 검사해 유효한 사용자 지정 job ID가 결과 조회 권한을 바꿨다. `generate-private` ID의 JSON/audio는 제한된 analysis 세션이 export 권한 없이 통과할 수 있었다. ID를 분리한 실제 operation/action만 판별하도록 고쳤고 `sync-record`도 operation 정확일치로 제한했다. 운영 enforcement는 이번에 변경하지 않았다.
- 재현·회귀: 새 2개 테스트가 수정 전 17개 하위 조건에서 실패했다. 수정 후 실제 route 분류 guard, 유효 ID별 권한 불변 표, 제한 analysis/export 세션의 반대 방향 허용·403을 포함해 `backend/.venv-desktop/Scripts/python.exe -B -X utf8 -m unittest backend.test_local_engine_security` 30개가 통과했다. 기존 Starlette/httpx 폐기 예정 경고만 있으며 의존성을 바꾸지 않았다.
- frontend 검사: `corepack pnpm --dir desktop-app test:api-auth-boundary` 6개, `test:runtime-boundary`, `test:auth-recovery` 22개, `typecheck` 통과. 실제 `apiBase.ts`를 격리 VM으로 실행해 재시작 후 같은 base/token 사용, 탐색 중 token getter 미호출, 자격 정보 없음의 401 미준비, 웹의 무탐색을 확인한다. 실제 App helper를 공통 client와 실행해 Bearer·경로 인코딩·403 실패를 검사한다. `desktop-app`에서 `node node_modules/eslint/bin/eslint.js src/App.tsx src/AsrBenchmark.tsx src/apiBase.ts scripts/test-api-auth-boundary.mjs` 통과.
- 독립 agent 검토: backend 권한/route와 frontend 전송/bootstrap·테스트를 두 관점으로 나눴다. 원 권한 finding은 수정 후 재검토에서 해소됐고 이번 수정의 차단 사항은 남지 않았다. Rust restart가 고정 loopback 주소와 같은 token을 유지하는 것도 소스로 확인했다. 브라우저·실제 엔진·Tauri 실행·전체 빌드는 이번 좁은 전송 계약 검증에 포함하지 않았다.
- 확정 잔여·활성화 차단: Tauri에서는 인증된 HEAD 뒤 native `<audio>`가 직접 API 주소로 GET/Range를 보내므로 인증 강제를 켜면 해당 요청은 401이 된다. 현재 flag off와 웹 worker 경로에는 이 즉시 회귀가 없다. 후속 Tauri 호환 작업을 `todo.md`에 올렸으며 인증 전달 구현 + 실제 WebView의 재생/탐색/취소를 완료하기 전에는 Tauri 포함 활성화를 허용하지 않는다. 인증 우회·token URL·전체 음성 Blob 다운로드로 덮지 않는다.
- 다음·한계: 격리 인증 강제 환경에서 핵심 웹 흐름의 mutation/SSE/download 허용·거부 통합 회귀를 진행한다. 실제 HTTPS Chrome/Edge/LNA·설치 관문은 기존 출시 위험 표와 A6에 남아 있다. 이번 결과는 A2 전체 또는 운영 배포 완료 판정이 아니다. 기존 개발 서버는 재사용하거나 종료하지 않았고 새 서버·브라우저·설치 작업도 시작하지 않았다.

#### A2 인증 강제 격리 API 통합 회귀 — 2026-10-15

- 범위: `backend/test_authenticated_web_flow.py`에 실제 main route·middleware 구성과 테스트용 HTTPS origin·새 세션 저장소를 연결한 ASGI/TestClient 검사 6개를 추가했다. 기존 audio 테스트용 helper는 전체 route를 재사용하는 역할에 맞게 `build_isolated_main_app`으로 이름만 바꾸고 기존 호출 3곳도 갱신했다. 제품 코드 결함은 추가 발견되지 않아 제품 코드·운영 설정·사용자 파일·디자인을 변경하지 않았다.
- 격리: 각 테스트의 환경 변수는 Python 프로세스 안에서만 patch하고 설정 파일은 쓰지 않는다. 임시 절대 경로의 config·출력·업로드·다운로드, 별도 작업 목록/잠금 사전, 새 pairing/session을 사용하고 cleanup으로 복원한다. save-copy 경계가 잘못 열리더라도 사용자 Downloads로 쓰지 않게 경로를 격리했다. 모델 존재/경로 확인과 AI 추론을 테스트 대역으로 바꾸며 실제 모델 실행·외부 서버 호출·실제 파일 분석은 하지 않는다.
- 성공 계약: 공개 probe→실제 pairing start/complete→인증된 저장공간 preflight→real 모드 multipart 업로드/SSE 진행·단일 result·done→세션 갱신→sync-record→JSON/TXT/음성 HEAD·Range→삭제를 실행한다. SSE JSON의 meeting/output 작업 번호를 대조하고 응답이 제공한 JSON/audio URL을 그대로 사용한다. 수정 제목·발언이 저장 JSON과 TXT export에 반영되고, 음성 구간 바이트·206·첨부 헤더·삭제 후 404 및 무관한 임시 파일 보존을 확인한다.
- 거부 계약: 무토큰·변조·만료·폐기·다른 origin·origin 없음은 업로드/동기화/export/삭제/JSON/음성 요청에서 401이며 파일 트리와 작업 목록을 바꾸거나 추론을 시작하지 않는다. 허용 CORS preflight가 인증 허용을 뜻하지 않는 것도 확인한다. analysis/export/storage/model-management 제한 세션의 403과 해당 최소 권한의 실제 경로 허용을 확인한다. 웹의 모든 capability를 가진 세션도 Downloads save-copy는 403으로 유지된다.
- 수명 계약: revoke 뒤 옛 token의 갱신·새 분석·동기화·조회가 401이며 기존 파일과 분석 실행 횟수는 유지된다. 새 pairing은 기존 파일을 다시 조회할 수 있다. 이미 입장한 SSE 도중의 폐기는 현재 응답을 중복 실행시키지 않으며 후속 요청은 거부한다. 이는 백엔드 요청 경계의 결과이고 frontend 자동 재시도를 검증한 것은 아니다.
- 검사: `backend/.venv-desktop/Scripts/python.exe -B -X utf8 -m unittest backend.test_authenticated_web_flow` 6개 통과. 자체 검토에서 SSE 작업 번호·반환 URL 연계 단언을 보강한 뒤 같은 interpreter로 `-m unittest backend.test_authenticated_web_flow backend.test_local_engine_security` 총36개 재통과했다. 기존 Starlette/httpx 폐기 예정 경고만 있었다. frontend 제품 코드가 바뀌지 않아 타입 검사·린트·전체 브라우저 suite·빌드를 반복하지 않았다.
- 독립 agent 검토: fixture의 사용자 경로/세션 격리, 인증 전에 부작용이 차단되는지, 실제 endpoint/serializer 및 helper rename, SSE 반환 경로 연결과 테스트 증거 과장을 집중 검토했다. P0/P1·현재 목표 P2 차단은 없었다. agent의 지적대로 MD/DOCX/HWPX는 serializer 실행 증거이지 해당 다운로드 API나 문서 레이아웃 검증으로 보고하지 않는다.
- 증거 한계: 실제 main handler·인증·파일 계약을 통합했지만 TCP/TLS·브라우저·실제 JS client·사용자 설치 엔진·STT 품질의 통합은 아니다. 실제 HTTPS Chrome/Edge/LNA와 Tauri native 음성 인증은 기존 TODO/출시 관문에 남으며 운영 enforcement는 켜지 않았다. 기존 개발 서버에 접속하거나 종료하지 않았고 새 서버·브라우저·모델 설치·커밋·push도 시작하지 않았다.
- 다음: A3의 MeetingRecord↔backend result JSON↔sync-record↔생성/내보내기 최신 내용 및 fallback 일관성을 점검한다. A2의 웹 코드·격리 API 관문 통과와 운영 활성화/실환경 출시 판정은 구분한다.

#### A3 편집·저장·payload 복원과 내보내기 일관성 1차 — 2026-10-15

- 범위: `main.py`의 sync·생성 성공 후 산출물 갱신과 상태 정규화, `MeetingDownloadControl`의 로컬 TXT builder, `meetingRepository` 읽기 정규화만 수정했다. 검증 기준 HEAD `ac5bc21`과 다른 AI의 디자인·기존 미커밋 변경은 보존했다. SQLite·새 API·UI 재설계·모델/추론·배포 설정은 범위 밖이다.
- 확정 결함 1: sync 및 summary/topic/custom-topic/speaker/report 생성의 성공 경로 6곳은 JSON 편집을 반영하고 MD/DOCX/HWPX만 갱신해 저장된 TXT가 오래되거나 없었다. 이미 있는 `_refresh_transcript_and_summary_exports`를 사용해 같은 최신 result_data로 TXT도 갱신한다. 실패/409 경로의 정상 내용 보존과 다운로드 갱신 실패 안내는 유지한다.
- 확정 결함 2: backend JSON 없는 frontend payload 복원 시 camel 생성 상태가 남은 채 backend의 snake 완료 상태가 추가돼 frontend가 오래된 상태를 우선했다. payload 변환과 `_ensure_generation_status`에서 canonical snake로 통일하고 alias를 제거한다. 둘이 모순되면 기존 backend 키를 우선하며, 이미 소유한 상태 dict의 참조는 유지한다.
- 확정 결함 3: 로컬 대체 TXT가 명시적으로 지운 이름 대신 segment.displaySpeaker/structured summary의 옛 표시 이름을 사용했다. 현재 label set을 우선하고, 명시적 `{}`/부분 매핑의 미지정 항목은 기본 참석자명으로 표시한다. label set 자체가 없는 legacy는 원래 이름을 보존한다. 본문 속 임의 이름을 익명화하는 기능은 아니다.
- agent 추가 수정: 첫 구현의 builder-only legacy 검사는 실제 읽기 정규화가 누락된 labels를 `{}`로 채우는 점을 놓쳤다. 누락과 명시적 삭제를 읽기에서 구분하도록 default를 제거하고, 실제 normalizer→builder→export payload를 거치는 직렬화/재읽기 형태로 재현·수정했다. 저장된 모든 행을 자동 변경하거나 데이터베이스 스키마를 바꾼 것은 아니다.
- 실패 재현: 수정 전 backend의 stored-TXT/원본 없는 sync/원본 없는 주제 생성 3개가 2개 assertion 실패와 canonical key 누락으로 실패했다. frontend builder 6개 중 3개가 옛 이름 사용으로 실패했다. agent가 지적한 정규화 legacy 경우도 별도 실패 후 수정했다. 새 실패 시나리오의 context-manager tuple 구성 오류 1회는 fixture만 바로잡아 제품 결함과 구분했다.
- backend 증거: 실제 인증 API·임시 JSON/TXT와 실제 serializers로 sync 후 다운로드, 원본 없는 payload 복원·주제 생성 완료, 파생 참석자 결과 초기화, 기존 정상 내용 보존/실패 시 신규 JSON 미생성, TXT 쓰기 실패 시 최신 JSON 보존·재시도를 확인했다. `backend/.venv-desktop/Scripts/python.exe -B -X utf8 -m unittest backend.test_authenticated_web_flow backend.test_local_engine_security` 총41개 통과. 추론은 테스트 대역이며 전체 생성 경로/파일 형식의 endpoint를 전부 실행한 증거는 아니다.
- frontend 증거: `corepack pnpm --dir desktop-app test:export-consistency` 7개는 실제 TSX pure builder와 repository normalizer를 AST/VM으로 실행한다. 명시적 빈/부분 labels, 누락 legacy, stale snake label보다 camel `{}` 우선, 편집/되돌리기/원본 우선순위, frontend-only scope payload·대체 텍스트를 확인한다. `test:generation-flow`, `typecheck`, `desktop-app`의 `node node_modules/eslint/bin/eslint.js src/MeetingDownloadControl.tsx src/meetingRepository.ts scripts/test-export-consistency.mjs` 통과.
- 독립 검토: backend 저장/생성/상태 계약과 frontend fallback/legacy 호환의 두 범위로 나눴다. 원 finding과 추가 legacy 회귀를 각각 수정 후 재검토했으며 현재 묶음의 차단 사항은 남지 않았다. 기존 `test_api` 전체는 실행하지 않았고 새 검사는 임시 경로만 사용해 TXT 추가 생성이 기존 테스트의 repository outputs에 파일을 남기지 않았다.
- 잔여·다음: A3 전체 완료는 아니다. A 회의 생성 중 B 이동/편집, 실제 IndexedDB 재열기·scope별 실제 파일 API/내용을 대표 UI 경로로 이어서 확인한다. MD/DOCX/HWPX 레이아웃, 실제 HTTPS/설치 엔진, Tauri, SQLite 전환과 브라우저 캐시 독립 보존은 이 증거로 완료하지 않는다. SQLite는 기존 6단계 미착수 상태를 유지한다. 새 서버·브라우저·모델 설치·전체 빌드·커밋·push는 실행하지 않았다.

#### A3 교차 회의·재열기·실제 파일 후속 — 2026-10-15

- 범위: 회의별 생성 결과와 화면 부수효과의 귀속, UI 편집 후 IndexedDB 재열기, 실제 내보내기 파일 내용만 확인했다. 다른 AI의 디자인 변경·기존 dirty 변경은 보존했다. 새 저장소·SQLite·모델 추론·운영 인증 강제·설치·전체 빌드·커밋·push는 범위 밖이다.
- 재현·수정 1: A 주제 생성 중 B로 이동해 참석자별 정리를 보고 있어도 A 완료가 B의 하위 탭을 주제별로 바꾸고 A 완료 toast를 표시했다. 데이터는 A에 저장됐지만 현재 화면 귀속이 잘못됐다. 5개 생성 handler는 대상 ID로 저장한 뒤 현재 선택 ID가 같을 때만 검색·모드·알림을 바꾸고, 지연 scroll도 실행 직전에 다시 확인한다. 조기 return에도 finally가 실행되어 전역 생성 잠금은 해제된다.
- 화면 증거: `test:meeting-detail-flow`가 B에 머문 채 A 응답을 완료해 A 저장·B 데이터/검색/모드 불변·오표시 toast 없음과 A 복귀 결과를 확인한다. 실제 UI에서 대화록·제목·목적 수정→저장→B 이동→reload→A 재열기 후 IndexedDB 보존과 최신 export payload를 확인했다. 본 시나리오의 sync/export는 mock이며 실제 파일 증거와 구분한다. 나머지 4개 생성 경로는 같은 패턴의 독립 코드 검토이지 각각의 브라우저 재현은 아니다.
- 재현·수정 2: 실제 인증 API 다운로드 11조합 중 `full × txt`만 정리·보고서를 누락했다. 명시적 전체 TXT는 기존 문서 serializer의 plain-text 모드를 사용해 정리·보고서·대화록을 함께 쓴다. 생성 heading/bold 표식만 생략하고 사용자 본문은 그대로 보존한다. scope 미지정·대화록 TXT의 기존 형식은 유지한다. agent가 발견한 대소문자/공백 및 camel null+snake fallback 분기 차이도 정규화 결과 기준으로 수정·재검증했다.
- 파일 증거: 대화록 TXT 1개, 기록 정리·보고서 MD/DOCX/HWPX 6개, 전체 TXT/MD/DOCX/HWPX 4개를 실제 response bytes로 확인했다. UTF-8·ZIP CRC·필수 entry·XML·HWPX preview, 최신 수정 내용 우선, 범위별 포함/제외, 명시적 빈 label set, 고정 보고 양식, MIME·한글 attachment filename·Content-Length, 기존 저장 JSON 불변을 검사한다. API 13개+보안30개 총43개 통과. legacy TXT·본문 마크업·scope 표기 회귀도 포함한다.
- 추가 검증: `corepack pnpm --dir desktop-app typecheck`, `test:generation-flow`, `test:export-consistency` 7개, 변경 파일 lint 및 `git diff --check` 통과. Corepack exec의 ESLint launcher가 인식되지 않아 설치를 바꾸지 않고 기존 실제 본체를 사용했다: `desktop-app`에서 `node node_modules/eslint/bin/eslint.js src/MeetingHistory.tsx scripts/simulate-meeting-detail-flow.mjs`. 기존 Starlette/httpx deprecation warning은 제품 실패와 구분했다.
- 독립 검토: 화면/저장 귀속과 export/파일 회귀를 별도 agent가 구현 후 검토했다. scope 정규화 finding 수정 후 재검토에서도 현재 묶음 차단 사항은 없다. 문서 내용·구조 검사가 Word/한컴 시각 렌더링을 증명하지 않는다.
- 실행 환경·정리: `D:\Projects\audio`에서 `corepack pnpm --dir desktop-app dev --host 127.0.0.1 --port 5195 --strictPort`로 별도 Vite를 띄우고 `APP_URL=http://127.0.0.1:5195`, 프로젝트 Playwright cache로 검사했다. 본 세션 서버만 종료하며 기존 디자인 서버는 건드리지 않는다.
- 잔여·다음: A3의 현재 UI/파일 회귀 묶음은 완료했다. 다음은 A4 사용자 흐름·접근성 및 대표 모델 품질 점검이며, 실제 Word/한컴 파일 열기·HTTPS 브라우저 다운로드는 아래 출시 위험 표와 A6에 남긴다. SQLite 기준 저장소·revision/백업·캐시 독립 보존은 기존 6단계 미완이며 이번 reload 결과로 닫지 않는다.

#### A4 대표 사용자 흐름·키보드 접근성 1차 — 2026-10-15

- 범위: 새 기록의 파일 선택/실패 복구/취소 대기, 설정 modal·모델 작업 메뉴, 회의 상세 주·하위 탭과 편집 보호를 대표 경로로 점검했다. 다른 AI의 시각 디자인, 모델 추론, 저장소 전환, 설치/배포/인증 강제는 바꾸지 않았다. 시각 재설계가 아닌 상호작용 점검이므로 디자인 문서를 준수하되 별도 디자인 생성 흐름은 사용하지 않았다.
- 재현·수정: 설정의 모델 작업 메뉴는 `menu/menuitem` 역할을 선언해도 키보드로 열 때 항목에 초점이 가지 않았고 방향키 처리가 없었다. 두 렌더 분기에 첫/마지막 활성 항목 진입, 위/아래 순환·Home/End, Escape 복귀, Tab/Shift+Tab 이탈을 공통 적용했다. 비활성 항목만 있으면 메뉴 자체에 초점을 두고 안전하게 빠져나오게 한다. 다운로드/삭제 권한이나 요청 내용은 변경하지 않았다.
- agent 추가 수정: 항목 실행 후 등록 해제 확인을 취소하면 초점이 제거된 menuitem에서 body로 빠지는 경계도 회귀 검사로 재현했다. 실행 전에 원래 버튼으로 복귀시키고, 실제 삭제가 그 버튼도 제거한 경우에만 살아 있는 모델 선택란(없으면 닫기)으로 돌아온다. 요청 중 사용자가 다른 control로 이동했으면 초점을 빼앗지 않는다.
- 검증: `corepack pnpm --dir desktop-app test:settings-model-management`는 수정 전 첫 항목 focus 단언 실패, 추가 취소 단언도 실패했다가 수정 후 전체 통과했다. 기존 modal 진입/Tab 가두기/닫고 원래 버튼 복귀·일반/모델 방향키·1024×720 닫기/넘침 검사를 유지했다. 활성/비활성 메뉴, 두 메뉴 분기, 취소와 실제 목록 제거의 대체 초점을 추가했다. API는 mock이며 실제 모델 설치·삭제는 하지 않았다.
- 대표 흐름: `test:edit-guard-flow`에 주 탭·정리 하위 모드의 방향키/Home/End, 단일 Tab 진입점과 panel 이름 연결을 추가해 통과했다. 저장하지 않은 대화록의 생성/내보내기 차단과 stale 응답 복구도 유지했다. `test:analysis-stop-flow failure-recovery`와 `pending-cancellation-transition`을 각각 통과해 파일 선택 Enter, 지원하지 않는 교체의 기존 값 보존, 오래된 메타데이터 차단, 취소 처리 중 잠금, 실패 후 제목·파일 보존·제목 초점·재시도를 확인했다. 새 failure filter는 기존 시나리오만 좁혀 실행한다.
- 기본 검사·독립 검토: `typecheck`, `desktop-app`의 `node node_modules/eslint/bin/eslint.js src/Settings.tsx scripts/simulate-settings-model-management.mjs scripts/simulate-analysis-stop-flow.mjs scripts/simulate-edit-guard-flow.mjs`, `git diff --check` 통과. 선행 agent는 탭/modal/menu를 읽기 점검했고 구현 후 다른 agent가 초점·이벤트 경계와 회귀 검사를 독립 검토했다. 취소/삭제 finding 수정 후 재검토에서 현재 묶음 차단 사항 없음.
- 환경: `D:\Projects\audio`에서 `corepack pnpm --dir desktop-app dev --host 127.0.0.1 --port 5196 --strictPort`, 프로젝트 Playwright cache와 별도 browser context로 검사했다. 실제 앱 제목 `바로록` 및 UI 경로로 대상을 확인한다. 검사 후 이 세션 Vite만 정리하며 기존 디자인 서버와 사용자 데이터는 건드리지 않는다.
- 한계·다음: 현재 대표 화면/키보드 묶음은 완료했지만 A4 전체 완료나 접근성 인증은 아니다. 실제 NVDA/Narrator 읽기·native 200% 확대·강제 색상/낮은 높이 조합은 출시 위험 표에 열어 두고, 다음 A4 실제 짧은 WAV/video·모델 미준비·생성 근거/출처 품질을 별도 수행한다. 실제 HTTPS·설치 엔진과 A5/A6 관문도 유지한다. 전체 suite·빌드·커밋·push는 실행하지 않았다.

### 0단계: 현재 계약 고정과 회귀 기준

코드 변경 전에 다음을 기준으로 고정한다.

- 기존 API 호출과 Tauri command 사용 위치 목록
- 기존 모델 다운로드·분석·복구 시뮬레이션 목록
- 웹 빌드에서 허용할 환경 변수
- 로컬 엔진 API 계약 버전 형식
- 실제 배포 HTTPS origin은 환경 설정으로 주입하며 소스에 임의 도메인을 고정하지 않음

2026-08-14 inventory 기준:

- 화면·coordinator 직접 `fetch`의 lexical boundary 후보는 34개다:
  `AnalysisRecoveryCoordinator` 3, `apiBase` 1, `App` 1, `AsrBenchmark` 2,
  `MeetingDownloadControl` 3, `MeetingHistory` 13, `MeetingWriter` 9,
  `Settings` 1, `Sidebar` 1. `localEngineClient`와 `localEngineClientCore`의
  실제 전송 구현 2개는 최종 0개 판정에서 제외한다.
- `Settings.tsx`의 lexical boundary 1개는 `fetchWithTimeout` 래퍼이며 실제
  호출 지점 18개를 소유한다. 5단계에서는 lexical 개수뿐 아니라 모델 상태,
  모델 다운로드·중지, Ollama runtime·pull·삭제, 설정 조회·저장 endpoint를
  별도 목록으로 대조한다.
- Tauri 전역·invoke 참조는 `apiBase.ts`와 `runtimeEnvironment.ts` 경계 안에 있다.
- 웹 빌드 입력은 `VITE_API_BASE_URL`, `VITE_ANALYSIS_MODE`,
  `VITE_ENABLE_ASR_BENCHMARK`이며 `DEV`는 Vite 실행 모드다.
- 기존 UI 회귀 목록과 실행 방법은 `docs/frontend-simulation-testing.md`와
  `desktop-app/scripts/simulate-*.mjs`를 기준으로 한다.

inventory는 5단계 시작과 완료 시 같은 검색 기준으로 다시 기록한다. 새 직접
호출이 추가되면 해당 작업 묶음에서 공통 클라이언트로 되돌린다.

완료 기준:

- 재사용, Tauri 전용, 웹 신규 항목이 표로 구분된다.
- 첫 코드 변경의 파일 범위와 테스트가 정해진다.
- 설치 UI나 보안이 준비된 것처럼 보이는 임시 화면을 만들지 않는다.

### 1단계: 프런트엔드 런타임 경계 분리

- `apiBase.ts`의 주소 발견과 Tauri command 책임을 런타임 어댑터로 분리한다.
- 공통 `localEngineClient`에 timeout, 응답 파싱, 오류 분류와 mock probe를 모은다.
- 앱 수준 연결 coordinator가 전송·인증·capability 상태를 소유한다.
- MeetingWriter와 Settings는 직접 연결 상태를 각각 추측하지 않고 coordinator 결과를 사용한다.
- 기존 Tauri 동작은 같은 어댑터 뒤에서 유지한다.

완료 기준:

- `build:web`에서 Tauri invoke 없이 앱이 시작된다.
- Tauri 빌드의 주소 발견과 재시작 기능이 깨지지 않는다.
- `unreachable`, `reachable`, `incompatible`과 인증 상태가 mock으로 재현된다.
- pairing 전 `reachable`을 `연결됨` 또는 분석 가능 상태로 표시하지 않는다.
- 아직 실제 설치 파일이 없으면 다운로드 CTA를 활성화하지 않는다.

### 2단계: 공개 probe·pairing·세션 최소 PoC

- 비민감 `/api/probe`와 개발용 exact origin allowlist를 구현한다.
- backend 인증 미들웨어와 공개 endpoint allowlist를 구현한다. 2단계에서는
  격리된 test 설정에서 대표 민감 GET, mutation, SSE, 다운로드가 default deny로
  닫히는 것을 검증하되, 기존 프런트 호출 전환 전 일반 개발·Tauri 실행에 전역
  enforcement를 켜지 않는다.
- 최초 pairing은 사용자가 직접 연 로컬 pairing helper가 origin과 6~8자리
  일회성 코드를 보여 주고, 사용자가 웹에 코드를 입력하는 방식을 기준으로 한다.
- 설치 완료 화면은 첫 pairing helper를 열 수 있고, 이후 새 브라우저 추가나
  재pairing은 시작 메뉴의 `바로록 연결` helper에서 시작한다.
- `pair/start`는 exact Origin 검사, 짧은 nonce 만료, rate limit을 적용하며
  자동으로 로컬 창을 띄워 알림 스팸을 만들지 않는다.
- `pair/complete`는 origin, 엔진 인스턴스, 권한 범위에 묶인 짧은 세션 토큰을 발급한다.
- `LocalEngineConnectionProvider`에 authorization과 capability를 최신 pairing·probe
  결과로 갱신하고 만료·폐기 시 비우는 API를 추가한다. 이 작업은 1단계 기반의
  2단계 의존성이며 Settings 연결 UX 전에 완료한다.
- 일회성 코드와 장기 비밀값은 URL, 로그, `localStorage`, 회의 기록에 저장하지 않는다.
- 자동 재연결에 쓰는 자격 증명은 메모리 토큰, origin-bound 브라우저 저장소, loopback HttpOnly cookie 후보를 Chrome/Edge에서 PoC한 뒤 확정한다. 저장 위치, 회전·폐기, 새로고침·브라우저 재시작, XSS·CSRF 보호를 이 단계의 설계 입력으로 고정한다.
- 새 브라우저, origin 변경, 엔진 재설치, 세션 만료, 사용자 폐기와 재pairing 수명주기를 테스트로 고정한다.

2단계는 보안 계약·mock PoC와 실제 helper 검증을 분리한다. 이 단계 구현이
통과하면 `보안 계약 완료/실제 helper 대기`로 표시하고, 3단계 helper가 준비된
뒤 실제 pairing 증거를 추가해야 전체 완료로 바꾼다.

완료 기준:

- 격리된 enforcement test에서 probe와 pairing endpoint 외의 민감 API를 사용할 수 없다.
- 대표 민감 GET, mutation, SSE와 다운로드가 token 없이는 거부된다.
- mock helper 기준의 허용 origin pairing과 세션 요청이 통과하고 다른
  origin·만료 nonce·반복 추측은 거부된다.
- 로컬 포트의 응답이 제품 식별자와 API 계약에 맞지 않으면 `incompatible` 또는 안전한 오류로 닫힌다.
- 실제 승인 helper가 준비되지 않았다면 pairing 성공을 mock 밖에서 표시하거나
  2단계를 전체 완료로 판정하지 않는다.

### 3단계: 로컬 엔진 설치·업데이트 PoC

- Windows 현재 사용자 영역에 설치되는 창 없는 로컬 엔진 패키지를 만든다.
- 고정 loopback bind, single instance, 선택형 자동 시작과 안전한 종료를 검증한다.
- 설치 완료와 시작 메뉴에서 pairing helper를 사용자가 직접 열 수 있게 한다.
- 엔진·ffmpeg·sidecar와 모델·SQLite·사용자 결과의 설치·데이터 경계를 분리한다.
- 업데이트·재설치·제거 시 사용자 데이터 보존과 명시적 삭제 범위를 고정한다.
- 코드 서명, 설치 파일과 update manifest 배포 위치가 없으면 로컬 개발 PoC까지만
  진행하고 실제 다운로드 CTA를 열지 않는다.

기존 패키징 자산을 새로 복제하지 않고 다음 기준으로 재사용한다.

| 기존 자산 | 3단계 판단 | 재사용 범위 |
| --- | --- | --- |
| `desktop-app/src-tauri/tauri.conf.json` | 참고·수정 | NSIS/current-user와 external sidecar 설정을 참고하되 웹 UI를 포함하는 Tauri installer 자체를 로컬 엔진 installer로 재사용하지 않음 |
| `scripts/package_backend_sidecar.ps1` | 재사용·수정 | Python backend sidecar 패키징 기반을 창 없는 로컬 엔진 빌드 입력으로 사용 |
| `scripts/prepare_tauri_resources.ps1` | 참고·분리 | 기존 resource 배치에서 엔진 본체와 사용자 데이터 경계를 분리하는 입력으로 사용 |
| `scripts/create_update_package.ps1` | 재사용·수정 | SHA-256 manifest와 models/config/outputs/temp 보존 규칙을 설치형 엔진 layout에 맞춤 |
| `scripts/verify_update.ps1` | 재사용·확장 | manifest·payload hash·사용자 config/model 보존 검증을 업데이트·재설치 smoke로 확장 |

3단계 첫 작업 묶음에서는 이 표를 실제 installer layout과 대조해 각 자산의
최종 `재사용/수정/폐기` 결정을 증거 로그에 남긴다.

#### 3A 구현 증거 — 2026-08-14

첫 묶음은 installer가 아니라 standalone host 기반으로 제한했다.

- `backend/web_local_engine_server.py`는 `main` import 전에 production profile,
  인증 강제, exact HTTPS origin과 engine version을 적용하고
  `127.0.0.1:17863`만 사용한다. inherited desktop action token은 제거한다.
- `backend/web_local_engine_runtime.py`는 프로그램 파일을
  `%LOCALAPPDATA%\Programs\Barorok\LocalEngine`, 사용자 config·models·database·
  results·temp·logs·Ollama runtime을 `%LOCALAPPDATA%\Barorok\LocalEngine`으로
  분리한다. config는 최초 한 번만 생성하며 기존 파일을 덮어쓰지 않는다.
- Windows named mutex로 두 번째 host 실행을 종료한다. 빈 포트 검색이나 다른
  프로세스 종료는 사용하지 않는다.
- 사용자가 `--pair` helper를 먼저 연 2분 동안만 probe가 pairing 가능 상태가
  되고, 첫 요청이 arm을 원자적으로 소비한다. code 창은 별도 thread에서
  표시해 API event loop를 막지 않으며 code·token은 파일·argv·env에 저장하지 않는다.
- `scripts/package_backend_sidecar.ps1`은 기존 desktop 기본값을 유지하면서 web
  entry point와 전용 출력 폴더를 받을 수 있게 했다. 출력은 기존 Tauri binaries와
  `releases\web-local-engine-poc\engine` 두 곳만 허용한다.
- `scripts/build_web_local_engine_poc.ps1`은 unsigned·`distributionReady=false`인
  개발 payload만 만든다. origin/version은 immutable `defaults/engine-settings.json`에
  기록하고 frozen 실행에서는 CLI·환경변수·install/data path override를 거부한다.
  PowerShell 5.1에서도 UTF-8 BOM 없이 저장하며 모델·사용자 결과는 payload에 넣지 않는다.

검증 증거:

- `$env:PYTHONPATH='backend'; backend\.venv-desktop\Scripts\python.exe -m unittest backend.test_web_local_engine_runtime backend.test_local_engine_security tests.test_web_local_engine_packaging`: 39개 통과.
- `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\run_release_checks.ps1 -Tier quick -SkipFrontend`: 111개 통과, 1개 skip.
- `corepack pnpm --dir desktop-app test:runtime-boundary`: 통과.
- source host smoke: immutable settings만으로 probe의 `product_id`, contract와
  engine version 확인, helper 전 `pairing_available=false`, 무인증 `/api/health`
  차단, 두 번째 실행 종료, 사용자 config 생성과 install root 비변경 확인.
- fixed-port 충돌 smoke: 다른 listener가 17863을 점유한 상태에서 host가 exit 1로
  종료되고 fallback port를 사용하지 않음을 확인.
- `corepack pnpm check:quick`의 typecheck는 통과했다. 전체 명령은 이번 변경과
  무관한 기존 frontend lint 8건 때문에 중단됐으므로 3A 완료 증거로 사용하지 않는다.

#### 3B 구현·실행 증거 — 2026-08-14

두 번째 묶음은 실제 PyInstaller frozen payload와 반복 가능한 Windows smoke로
제한했다.

- `scripts/build_web_local_engine_poc.ps1`은 `ffmpeg.exe`를 필수 외부 입력으로
  받고, 기존 산출물을 바꾸기 전에 경로·실행 파일 존재·`ffmpeg -version`을
  확인한다. `FfmpegPath`가 교체 대상 output 안에 있으면 거부한다.
- `backend/web_local_engine_server.py --stop`은 사용자 데이터 경로에 결합된
  Windows named event로 Uvicorn을 정상 종료한다. 시작 직후 호출도 event 생성까지
  짧게 재시도하고, 종료 뒤 mutex와 `127.0.0.1:17863`을 반환한다.
- `scripts/verify_web_local_engine_poc.py`는 manifest의 경로 이탈·중복·미기재
  추가 파일을 거부하고 모든 payload 해시를 확인한다. smoke 중 install payload
  파일은 read-only share lock으로 수정·삭제를 막고, 종료 뒤 전체 파일 집합과
  size·mtime이 같은지 다시 확인한다.
- 실제 `--pair` MessageBox에서 exact origin과 6자리 code를 읽어 session을 만들고,
  wrong origin·만료된 arm·동시 start·사용한 code 재사용을 모두 거부하는지 확인한다.
  code와 token이 user data·로그에 남지 않는 것도 검사한다.
- config·models·database·results sentinel을 만든 뒤 install root를 다른 이름으로
  옮겨 다시 실행해도 같은 사용자 데이터가 보존되는지 확인한다. 이는 실제
  installer 재설치를 대신하지 않으며, 그 관문은 3C에 남긴다.

실제 명령과 결과:

- build: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_web_local_engine_poc.ps1 -Python D:\Projects\LMO_audio\backend\.venv-desktop\Scripts\python.exe -Origin https://minutes.example -EngineVersion 0.1.0-poc-stage3b-final -FfmpegPath D:\Projects\LMO_audio\backend\ffmpeg.exe`: 성공.
- frozen smoke: `backend\.venv-desktop\Scripts\python.exe scripts\verify_web_local_engine_poc.py releases\web-local-engine-poc --verify-challenge-expiry`: 성공. 일반 반복에서는 이 옵션을 생략하고, 실제 120초 code 만료는 후보 artifact 릴리스 관문에서 실행한다.
- 검증된 범위: closed manifest, read-only payload, ffmpeg, loopback-only,
  default-deny, single instance, helper arm과 실제 code expiry·재사용·동시성, startup-safe stop,
  fixed-port 충돌, install relocation 뒤 사용자 sentinel 보존.
- focused unittest 45개, backend quick 113개(1개 skip), runtime boundary와
  TypeScript typecheck를 통과했다.
- 산출물 `0.1.0-poc-stage3b-final`은 계속 `signed=false`,
  `distributionReady=false`이며 다운로드 CTA에 사용하지 않는다.

3B 이후에도 3단계 전체 완료로 판정하지 않는다. current-user installer,
Start Menu helper, 실제 install/update/uninstall-reinstall, installer ACL, 서명,
staging·rollback은 3C에서 닫는다. 실제 HTTPS의 Chrome/Edge Local Network Access
승인·거부·재승인은 4단계 release QA 관문으로 유지한다.

릴리스 전 이월 위험은 응답에서만 남기지 않고 다음 표로 관리한다.

| 항목 | 상태 | 필요한 증거 | 종료 조건 | 마지막 확인 |
| --- | --- | --- | --- | --- |
| frozen payload의 실제 STT·화자 구분 분석 | 열림 | 설치된 실제 모델과 대표 WAV·video로 분석→저장→내보내기 smoke; build 시 torchcodec·`tbb12.dll` 경고 영향 분류 | 대표 입력이 성공하고 누락 native dependency가 제품 흐름에 영향을 주지 않거나 패키징 수정 후 재검증 | 2026-08-14 |
| 공식 지원 Windows·CPU·RAM·GPU·여유 디스크 | 열림 | Windows 11 x64 저사양·일반형·NVIDIA PC에서 설치, 모델 준비, 5분·30분·60분·2시간 입력 측정; Windows 10 x64와 Windows 11 ARM64는 별도 증거가 생기기 전 미지원 후보로 분리 | 최소·권장 사양, 예상 처리시간, 최대 권장 입력 길이와 미지원 환경이 사용자 문서·설치 전 점검에 동일하게 반영 | 2026-08-14 |
| Chrome·Edge와 조직 정책의 Local Network Access | 열림·실환경 미실행 | 최신 stable Chrome·Edge의 실제 HTTPS에서 승인·거부·재승인, 브라우저 재시작, 관리 정책 사전 허용·차단 smoke; 창에서 엔진에 인증 요청하는 음성 재생과 A6 흐름을 함께 확인 | 지원 브라우저 범위와 상태별 복구 안내가 확정되고 회사 관리 브라우저의 차단을 설치 실패와 구분 | 2026-10-15 mock Chromium 재생 통과; 실제 HTTPS·관리 정책 증거 없음 |
| 브라우저 음성 중계의 배포·장시간 파일 호환 | 열림·짧은 mock WAV만 통과 | 배포 후보 HTTPS에서 worker 파일·scope·CSP, 기존 worker 충돌, transferable stream 지원 확인; stable Chrome·Edge와 실제 설치 엔진으로 긴 WAV의 최초 재생·Range 탐색·회의 전환/만료/탭 종료 시 취소 및 메모리 측정 | 지원 환경에서 구간 응답과 재생이 유지되고 전체 파일 선다운로드 없이 전달되며 취소 후 읽기가 종료됨; 미지원 환경의 오류·복구 안내 확인 | 2026-10-15 단위 9개·20초 WAV·웹 자산 포함 통과; 장시간/실배포 증거 없음 |
| 문서 다운로드의 실환경·편집기 호환 | 열림·실제 API 파일 내용/구조 11조합 통과 | 배포 후보 HTTPS·설치 엔진에서 Chrome/Edge 인증 다운로드, 한글 파일명·취소·만료 처리; 실제 Word DOCX와 한컴 HWPX 열기, 긴 한글 본문·표/문단·쪽 나눔 확인 | 지원 편집기에서 파일이 복구 경고 없이 열리고 최신 범위/내용이 보이며 잘림·중복·읽기 불가가 없고 브라우저 다운로드 완료·자원 해제가 확인됨 | 2026-10-15 ASGI 실제 파일 ZIP/XML/내용 및 mock UI 최신 payload 통과; 편집기·HTTPS 실물 증거 없음 |
| 보조기술·확대의 실제 사용자 접근성 | 열림·대표 Chromium 키보드/ARIA 회귀 통과 | 배포 후보 Chrome/Edge에서 NVDA 또는 Narrator로 새 기록 필수 오류·설정/menu·상세 탭/재생·진행/실패 읽기; native 200% 확대·강제 색상·낮은 높이 조합 확인 | 이름/역할/상태와 오류·진행이 이해 가능하게 읽히고 모든 주요 동작·복구에 키보드 접근 가능하며 초점 유실·잘린 제어가 없음 | 2026-10-15 mocked Chromium 대표 흐름·메뉴/탭/설정 1024×720 통과; 실제 보조기술·확대 증거 없음 |
| 고정 포트와 공용 PC·다중 Windows 사용자 | 열림 | `127.0.0.1:17863` 선점, 같은 PC의 두 사용자/RDP 세션, 엔진 재시작·절전 복귀 smoke | 다른 프로세스를 탐색·종료하지 않고 충돌 원인과 복구 동작을 사용자에게 제공하며 지원 범위를 명시 | 2026-08-14 |
| 설치·모델 다운로드의 오프라인·프록시·보안 제품 영향 | 열림·unsigned PoC 소스만 확인 | 일반 인터넷, 인증 프록시, 완전 오프라인, Defender·SmartScreen·대표 조직 EDR에서 실제 서명된 installer·모델 받기·업데이트 확인; A5 신규/업데이트/재설치 데이터 보존 증거 필요 | 서명·관리자 배포·오프라인 모델 준비·중단 후 재개 절차가 있고 차단 원인을 사용자 조치와 관리자 조치로 구분; 실제 배포 후보 manifest·서명 검증 성공 | 2026-10-14 계획·소스 점검; 실제 설치 증거 없음 |
| 지원용 진단과 민감정보 보호 | 열림 | 로그 회전·용량 제한, 오류 분류, token·pairing code·대화록·원본 경로 제외를 자동 검사한 진단 묶음 smoke | 사용자가 한 번에 내보낼 수 있는 비민감 진단 자료와 보존·삭제 기준이 정의되고 로그 무한 증가가 없음 | 2026-08-14 |

완료 기준:

- 신규 설치, 재설치, 업데이트, 제거 후 재설치에서 single instance와 데이터
  보존 규칙이 실제 Windows 사용자 계정에서 확인된다.
- pairing helper가 origin과 짧은 코드만 표시하며 비밀값과 사용자 경로를 노출하지 않는다.
- 서명·manifest 검증 실패를 우회하지 않으며 롤백 또는 복구 안내가 정의된다.
- 설치·업데이트·제거 smoke의 명령, 버전, 데이터 확인 결과를 증거로 남긴다.
- 기존 패키징 자산을 복제하지 않고 재사용·수정·폐기 결정과 이유가 기록된다.

### 4단계: 웹 연결·설치 복구 UX

- 첫 방문은 설명과 사용자 동작 뒤에 최초 probe를 수행하고, 이미 권한·pairing된 브라우저만 자동 재연결한다.
- 연결되지 않아도 기록 설명과 설치 안내에 접근할 수 있지만 분석 시작은 명확한 이유와 함께 제한한다.
- `unreachable`에서는 `로컬 엔진 받기`를 한 가지 주 CTA로 두고, `실행 후 다시 연결`과 `문제 해결`은 보조 동작으로 제공한다.
- 권한 거부와 엔진 미응답을 가능한 범위에서 서로 다른 복구 안내로 처리한다.
- pairing 필요, 업데이트 필요, 연결됨을 레이아웃을 밀지 않는 안정된 표면으로 표시한다.
- 코드 서명된 설치 파일과 검증된 manifest URL이 준비돼도 5단계의 전체 API
  전환과 default deny 활성화가 완료되기 전에는 실제 사용자 대상 다운로드
  CTA를 배포하지 않는다.

완료 기준:

- 처음 방문, 엔진 미응답, 권한 필요, pairing 필요, 연결됨, 버전 불일치 장면이 각각 검증된다.
- probe 실패만으로 설치 완료 여부를 단정하지 않는다.
- 키보드만으로 설치 안내와 다시 연결을 사용할 수 있다.
- 좁은 데스크톱 창에서도 주요 복구 동작이 보이고 가로 넘침이 없다.

### 5단계: 전체 엔진 API 클라이언트 전환과 인증 회귀 검증

- 개발 origin과 실제 배포 origin 설정을 분리한다. 웹 production은 exact HTTPS origin, Tauri sidecar는 고정 Tauri origin만 허용하고 localhost는 개발 모드에만 둔다.
- 인증된 프런트엔드 호출은 `localEngineClient.request/stream/download`로,
  공개 probe·pairing은 전용 `probe/pair` 메서드로 이전하고 컴포넌트 직접 API
  `fetch`를 제거한다.
- 공개 probe·pairing은 무인증 전용 메서드로 이전하고, 기존 HTTP, SSE, 진행률,
  결과 조회, 설정 조회·변경, 모델 상태·설치·삭제, 분석, 중지, 삭제, 내보내기
  endpoint의 인증 헤더 적용을 inventory로 확인한다.
- 전환과 회귀 검증이 통과한 뒤 2단계에서 만든 default deny를 일반 웹·Tauri
  실행에 활성화한다. enforcement 활성화와 호출 전환을 서로 다른 릴리스로
  분리하지 않는다.
- 세션 갱신은 401에서 한 번만 시도하고 실패하면 `expired`로 전환해 재pairing을 안내한다.
- Tauri의 native 음성 요청도 인증된 GET/Range를 전달하고 실제 WebView에서
  재생·탐색·취소가 검증돼야 Tauri 포함 강제를 활성화한다. 인증된 HEAD 성공이나
  웹 worker 통과만으로 이 조건을 완료 처리하지 않는다(`todo.md`의 후속 호환 작업).

완료 기준:

- 허용 origin의 인증된 민감 GET, mutation, SSE와 파일 다운로드가 통과한다.
- 허용되지 않은 origin, 토큰 없음, 만료·변조·다른 origin에 묶인 토큰이 각 요청 종류에서 거부된다.
- CORS 설정만으로 mutation이 허용되지 않는다.
- 비밀값이 로그, 브라우저 오류, 저장된 회의 기록에 포함되지 않는다.

### 6단계: SQLite 기준 저장소 전환

- 로컬 엔진에 schema version, revision과 함께 회의, 대화 세그먼트, 요약, 결정, 할 일, 폴더의 저장 계약을 둔다.
- React의 repository 호출을 SQLite API 어댑터로 교체한다.
- 가져오기 전에 IndexedDB의 읽기 전용 inventory와 복구 가능한 백업을 만들고 record ID와 content fingerprint로 중복 규칙을 고정한다.
- staging/transaction에서 가져온 뒤 건수, 필수 필드, 참조 무결성을 검증한 경우에만 commit한다.
- 기록 찾기는 SQLite 전문 검색(FTS)으로 교체한다.
- 결정의 회의 날짜와 실제 근거 시각을 구분할 수 있는 확장 필드를 예약한다.
- SQLite commit 이후 결과 JSON과 내보내기 산출물을 해당 revision에서 재생성하고, 실패하면 원본 commit은 유지한 채 `dirty/retry` 상태로 복구한다.

완료 기준:

- 새로고침, 브라우저 캐시 삭제, 다른 지원 브라우저에서 같은 로컬 기록을 다시 읽는다.
- 저장·수정·삭제는 revision 충돌을 감지하며 SQLite가 성공한 뒤 파생 산출물을 갱신한다.
- 실패·취소 시 staging을 폐기하고 SQLite commit과 IndexedDB 삭제를 수행하지 않는다.
- 가져오기 재실행은 idempotent하며 사용자가 확인하기 전 IndexedDB 원본을 자동 삭제하지 않는다.
- 많은 기록 검색에서 전체 대화록을 브라우저 메모리에 먼저 조합하지 않는다.

### 7단계: 브라우저 파일 동작 정리

- Tauri의 `저장 위치 열기`를 웹에서 노출하지 않는다.
- 웹 입력은 사용자가 선택한 `File`을 loopback으로 전송하고 브라우저 파일 경로를 기록하지 않는다.
- 웹 내보내기는 인증된 attachment 응답과 `Content-Disposition` 파일명을 사용하는 브라우저 다운로드로 제공한다.
- `save-copy`처럼 엔진 경로에 쓰는 동작은 웹에서 숨기거나 `로컬 엔진 보관함에 복사`로 별도 명명한다.
- 임의 폴더 열기나 브라우저의 정확한 저장 경로 확인을 지원한다고 약속하지 않는다.
- 모델 다운로드는 이미 있는 로컬 엔진 API와 설정 UI를 재사용한다.

완료 기준:

- 웹 UI에서 Tauri 전용 버튼이나 오류 문구가 나오지 않는다.
- MD/TXT/DOCX/HWPX 다운로드가 실제 브라우저에서 완료된다.
- 여기서 HWPX는 현재 회의록 내보내기만 뜻하며 새 기관 템플릿, 보도자료 생성과 편집기는 제외한다.
- 취소된 다운로드, 세션 만료, 한글 파일명과 임시 object URL 해제가 검증된다.
- 로컬 파일 경로를 웹 페이지에 불필요하게 노출하지 않는다.

### 8단계: 실제 웹 MVP 통합 검증

- 실제 HTTPS 후보 환경에서 Chrome과 Edge를 검증한다.
- 설치 전부터 설치·권한·pairing·모델 받기·분석·복구·내보내기까지 한 흐름으로 확인한다.
- 30분, 60분, 장시간 파일은 기존 성능 기준과 별도 검증한다.
- 네트워크 기록으로 음성·영상이 원격 웹 서버에 전송되지 않음을 확인한다.

완료 기준:

- 신규 PC와 기존 기록이 있는 PC에서 각각 통합 흐름이 통과한다.
- 엔진 종료·업데이트·세션 만료 후 복구가 가능하다.
- 웹 빌드 검증을 데스크톱 실행 검증으로 오인하지 않는다.
- 실패 항목은 원인 계층이 웹 UI, 권한, 인증, 엔진, 모델, 저장소 중 어디인지 구분된다.

## 7. 구현 묶음과 UI 작업선

### 7.1 완료한 첫 구현 묶음

1단계 첫 묶음은 커밋 `dc610b6f`에서 완료했다.

- 실행 환경 타입과 capability 인터페이스
- 기존 `apiBase.ts`를 감싸는 공통 엔진 클라이언트
- 전송 `checking`, `unreachable`, mock `reachable`, `incompatible`과 인증 상태 타입
- 기존 MeetingWriter readiness를 공통 상태와 연결할 수 있는 어댑터
- mock 기반의 웹/Tauri 분기 테스트와 `build:web`

첫 묶음에서 제외한 Settings coordinator 전환과 실제 Tauri smoke는 1단계 잔여
관문으로 유지한다. 다음 단계 진입을 위해 완료한 것으로 소급 처리하지 않는다.

### 7.2 다음 구현 묶음

다음 묶음은 `3C-0A 사용자 PC 호환성 계약`, `3C-0B 단계별 자동 점검`을
순서대로 고정한 뒤 3C current-user installer PoC로 진행한다. 설치 형식을
만들기 전에 누구의 PC에서 무엇을 지원하고 어느 시점에 무엇을 확인할지 정해야
설치 전 점검, 오류 문구와 검증 행렬이 흔들리지 않는다.

3C-0A에서 먼저 고정할 항목:

- 첫 공식 지원 후보는 Windows 11 x64와 최신 stable Chrome·Edge로 제한한다.
  Windows 10 x64와 Windows 11 ARM64는 실제 증거가 생기기 전 지원 대상으로
  약속하지 않는다.
- 저사양 CPU-only, 일반 CPU-only, NVIDIA GPU의 세 등급에서 CPU·RAM·GPU·여유
  디스크와 5분·30분·60분·2시간 대표 입력의 처리시간·실패 기준을 측정한다.
- 일반 인터넷, 인증 프록시, 완전 오프라인과 Defender·SmartScreen·조직 EDR,
  관리 브라우저 정책을 검증 축으로 둔다.
- 한글 사용자명·공백·긴 경로, 디스크 부족, 절전·재개, 브라우저·엔진 재시작,
  `17863` 선점과 다중 Windows 사용자 조건을 포함한다.
- 첫 MVP는 한 PC에서 한 Windows 사용자 세션만 동시에 사용하는 것으로 제한한다.
  같은 PC의 두 사용자·RDP 세션 동시 사용은 고정 포트 발견 계약을 바꾸고 다시
  검증하기 전에는 지원하지 않는다.

3C-0B는 한 번의 포괄적인 사양 검사가 아니라 실행 시점별 점검으로 나눈다.

| 시점·소유자 | 자동 확인 | 여기서 단정하지 않는 것 | 실패 시 사용자 동작 |
| --- | --- | --- | --- |
| 설치 전 웹 안내 | 지원 OS·브라우저 후보와 필요한 다운로드 안내 | RAM·디스크·GPU·포트 상태 | 지원 범위 보기, 엔진 받기 |
| installer 전 host system preflight | OS build·workstation·native architecture, 총 RAM | 디스크·쓰기·포트·SmartScreen·EDR·인증 프록시 | 지원 범위 보기, 다시 확인 |
| installer target preflight | 실제 install·models·temp·results 볼륨 여유 공간, LocalAppData 쓰기·정리, 고정 포트 상태 | SmartScreen·EDR 허용 여부, 인증 프록시 성공 여부 | 공간 확보 후 다시 확인, 충돌 앱 확인, 관리자에게 요청 |
| 설치 후 엔진 readiness | 제품·API version, data root 쓰기, ffmpeg·native dependency 실행, 모델·Ollama 상태, CUDA 가속 후보 | 실제 VRAM 충분 여부와 장시간 분석 성능 | 구성요소 다시 준비, 모델 받기, 진단 내보내기 |
| 실제 HTTPS 웹 연결 | Local Network Access 승인·거부·정책 차단, pairing, engine/API version | 설치 성공 여부 자체 | 브라우저 권한 확인, 다시 연결, 관리자에게 요청 |
| 분석 직전 | 선택 파일 길이·모델 상태에 따른 temp·results 공간, 예상 처리 부담 | PC 전체 지원 여부 | 공간 확보 후 재확인, 느린 처리 경고 후 계속 |

공통 machine-readable 결과는 최소한 `schema_version`, `check_id`, `status`, `severity`,
`reason_code`, `action_code`, `retryable`, `checked_at`, 측정값과 필요값을 갖는다.
실행 중 UI/installer 상태는 `checking`, 완료 JSON의 `status`는 `pass`, `warning`,
`blocked`, `unknown`으로 제한한다.
원시 사용자명·절대 경로·token·pairing code·대화록은 결과나 진단에 넣지 않는다.
늦게 도착한 이전 점검 결과가 최신 상태를 덮지 않도록 요청 세대 번호를 둔다.

사용자 경험 원칙:

- 확실한 미지원 OS·architecture, 쓸 수 없는 데이터 폴더, 현재 작업에 필요한
  공간 부족만 차단한다.
- RAM 부족, GPU 없음, 느린 CPU처럼 CPU fallback이 가능한 상태는 예상 지연과
  함께 경고하고 사용자가 계속할 수 있게 한다.
- 자동 확인 실패는 `unknown`으로 표시하며 실제 실패로 단정하지 않는다.
- 경고와 차단에는 현재 값·필요 값, `다시 확인`, `공간 확보`, `권한 확인`,
  `관리자에게 요청`, `진단 내보내기` 중 실제 가능한 다음 행동을 함께 제공한다.
- 보안 기능을 끄거나 다른 프로세스를 강제 종료하라고 안내하지 않는다.

3C-0B 첫 구현은 UI·installer를 동시에 만들지 않는다. versioned preflight DTO와
순수 Windows collector를 만들고 frozen host의 `--preflight-json`으로 OS·native
architecture·RAM만 비민감 JSON으로 증명한다. 실제 설치 대상과 쓰기 수명을
소유하는 installer가 install·data 볼륨 공간과 임시 쓰기·삭제 결과를 같은 DTO에
추가한다. GPU, 브라우저, 프록시와 성능 판정은 후속 점검으로 남긴다.

3C-0B 첫 구현 결과(2026-08-14):

- `backend/local_engine_preflight.py`가 `schema_version=1`, 비영구 `run_id` 결과와
  Windows build·workstation 여부, `IsWow64Process2` 기반 native architecture,
  총 RAM 점검을 소유한다. architecture 확인 불가는 차단하지 않고 `unknown`으로
  반환한다.
- 확정된 Windows 11 x64 조건만 차단 판정에 사용한다. RAM·디스크는 이번 묶음에서
  차단 수치로 사용하지 않으며 최소·권장 수치와 파일별 필요량은 실기기 증거,
  실제 설치 대상을 아는 installer와 분석 직전 기존 `/api/analyze/preflight`가
  각각 소유한다.
- frozen GUI subsystem에서 stdout에 의존하지 않도록 `--preflight-json OUTPUT_PATH`는
  사용자 임시 폴더의 신규 파일만 생성하고 기존 파일·임시 폴더 밖 경로를 거부한다.
- 점검은 layout·startup settings, 사용자 config, 로그, 모델, 네트워크, mutex보다
  먼저 종료한다. 따라서 staging 위치를 실제 설치 볼륨으로 오인하거나 응답 없는
  파일시스템 때문에 system preflight가 멈추지 않는다.
- source entrypoint와 실제 frozen GUI payload 모두에서 비민감 JSON 생성·정리,
  기존 결과 파일 비덮어쓰기, preflight 전용 실행이 사용자 data root를 만들지 않음을
  확인했다. 예상된 출력 실패는 GUI 오류창이나 내부 예외를 노출하지 않고 종료 코드로
  반환한다. verifier는 실제 Windows 계정명의 우연한 부분 문자열에 의존하지 않고
  실행마다 고유한 가짜 사용자·LocalAppData·TEMP 값을 주입해 경로·환경 유출이 없는지
  검사한다. Windows 경로는 직렬화된 JSON이 아니라 파싱된 모든 문자열 값을 재귀적으로
  비교하며, 기존 결과 거부는 정확한 종료 코드 `2`를 요구한다.
- build: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_web_local_engine_poc.ps1 -Python backend\.venv-desktop\Scripts\python.exe -Origin https://minutes.example -EngineVersion 0.1.0-poc-stage3c0b-preflight -FfmpegPath backend\ffmpeg.exe`: 성공.
- frozen smoke: `backend\.venv-desktop\Scripts\python.exe scripts\verify_web_local_engine_poc.py releases\web-local-engine-poc`: 성공. `Preflight status: pass`와 함께 closed manifest, read-only payload, loopback/default-deny, single instance, pairing, 정상 종료, 포트 충돌, relocation 보존도 재확인했다.
- Windows 실물 검증에서 GUI 출력 실패가 대기 상태로 남는 문제와 종료 직후 폴더
  손잡이가 잠깐 유지되는 문제를 발견했다. 전자는 조용한 실패 코드로, 후자는 전용
  relocation 두 경로에 한정한 5초 재시도로 보완했다.
- focused runtime/preflight unittest 21개와 verifier/packaging unittest 10개가
  통과했다. 이 첫 결과는 host system 범위만 완료했으며 installer target runner와
  실제 installer 소비는 다음 묶음으로 남겼다.

3C-0B installer target 구현 결과(2026-08-14):

- 기존 `--preflight-json`의 host-only·user-data 무생성 계약을 유지하고 별도
  `--installer-target-preflight-json REQUEST_PATH OUTPUT_PATH`를 추가했다. 요청과
  결과는 사용자 임시 폴더 안의 파일만 허용하며 기존 결과를 덮어쓰지 않는다.
- 완료 DTO에 `preflight_kind`를 두고 installer target 요청의 비음수
  `request_generation`을 필수화했다. 완료 check는 `pass`, `warning`, `blocked`,
  `unknown`만 반환하며 raw 경로·사용자명·volume label/serial·PID·process name을
  포함하지 않는다.
- 실제 설치 위치는 staging executable 위치가 아니라 current-user canonical
  `%LOCALAPPDATA%` install/data layout에서 계산한다. install·staging·models·
  analysis temp·results 필요량은 installer request가 제공하며 값이 없거나 측정할
  수 없으면 추측하지 않고 `unknown`으로 닫는다.
- 같은 실제 Windows volume의 요구량을 합산한다. 현재 설치 peak인 install+staging
  필수 공간 부족은 `blocked`, 설치 뒤 필요한 models+analysis temp+results 부족은
  installer 단계에서 `warning`으로 안내하고 실제 모델 다운로드·분석 직전에 다시
  차단 판정한다. 결과에는 run-local `volume_ref`와 byte 수치만 남긴다.
- 쓰기·정리는 가장 가까운 실제 기존 target에서 고유 canary를 exclusive-create,
  write, `fsync`, no-replace rename, read-back, delete 순서로 확인한다. 이 실행이 만든
  파일만 bounded retry로 정리하며 기존 이름 충돌·broken symlink/junction은 기존
  파일을 삭제하거나 상위 폴더로 우회해 pass하지 않는다.
- `127.0.0.1:17863`은 Windows exclusive bind, target data-root mutex와 direct
  non-proxy product probe를 조합한다. 비어 있으면 `pass`, 기존 바로록 엔진이면
  `warning`과 정상 종료 후 재검사, 다른 listener나 응답 없는 점유자는 `blocked`,
  검사 API 자체 실패만 `unknown`으로 반환한다. 어떤 프로세스도 강제 종료하지 않는다.
- JSON 결과는 sibling temp file에 write·`fsync`한 뒤 Windows no-replace atomic move로
  게시한다. 출력 실패는 기존 결과를 유지하고 부분 파일을 남기지 않으며 종료 코드
  `2`는 요청·출력 계약 실패에만 사용한다. check가 `blocked`여도 정상 JSON 생성은
  종료 코드 `0`이다.
- focused installer tests 30개, 관련 runtime/security/packaging/verifier 68개,
  `scripts\run_release_checks.ps1 -Tier quick -SkipFrontend` 113개(1개 skip),
  `scripts\verify_installer_target_preflight_source.py` Windows source smoke와
  `git diff --check`가 통과했다.
- 큰/작은 관점 agent가 응답 없는 listener 오분류, optional generation, canary
  collision, broken reparse, 개인정보 경로 검사와 smoke 단언 누락을 지적했다.
  모두 수정한 뒤 좁은 재검토에서 P0·P1·현재 목표 P2가 남지 않았다.
- 단일 build: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_web_local_engine_poc.ps1 -Python backend\.venv-desktop\Scripts\python.exe -Origin https://minutes.example -EngineVersion 0.1.0-poc-stage3c0b-installer-target-preflight -FfmpegPath backend\ffmpeg.exe`: 성공.
- frozen smoke: `backend\.venv-desktop\Scripts\python.exe scripts\verify_web_local_engine_poc.py releases\web-local-engine-poc`: 성공. host `pass`, installer target
  정상 `pass`, 기존 엔진 실행 중 `warning`, 외부 listener `blocked`, 공간 5개와
  write/cleanup `pass`, closed manifest·read-only payload·pairing·normal stop·relocation
  회귀를 한 번에 확인했다.
- 다음 installer 소비 소스 묶음에서 artifact manifest의 확정 byte 요구량과 결과 action을
  실제 current-user NSIS 흐름에 연결했다. 공식 최소·권장 용량, 실제
  install/update/uninstall-reinstall와 모델 분석은 3C installer 실물 관문으로 유지한다.

3C installer preflight 소비 소스 결과(2026-08-14):

- `backend/web_local_engine_installer_preflight.py`는 closed artifact manifest를 검증하고
  파일별 4 KiB allocation 반올림, manifest allocation과 16 MiB installer metadata
  reserve를 install·same-volume staging 각각의 필수 요구량으로 넣는다. 모델·분석 임시·
  결과 권장량은 실측 근거가 없으므로 `unknown` advisory로 유지한다.
- helper는 preflight DTO의 check set·`request_generation`·overall status를 다시 검증하고
  `ready=0`, 계약 오류 `2`, 사용자 확인 `10`, 차단 `20`, 재시도 `30`으로 NSIS에 전달한다.
  readiness는 mutex만 믿지 않고 실제 loopback probe의 product·engine·API version이 모두
  일치해야 하며, 종료 완료는 mutex 부재와 고정 포트 free를 함께 확인한다.
- `installer/web-local-engine.nsi`는 current-user 고정 경로, installer mutex, Start Menu의
  실행·`--pair`·`--stop`·제거, 최대 약 30초 readiness, same-volume stage와 rollback을
  연결한다. 중단된 transaction은 target 자체의 구버전 manifest로 먼저 복구한 뒤
  preflight를 실행한다.
- install/update/uninstall 정리는 marker와 closed manifest로 선언된 파일만 삭제하고
  reparse point·미선언 파일이 있으면 fail-closed한다. 사용자 data root는 정리 대상에
  포함하지 않는다. transaction marker는 payload와 ownership 증거보다 마지막에 삭제해
  부분 정리를 완료된 update로 오판하지 않는다.
- 현재 frozen manifest는 모델을 포함하지 않지만 4,887개 파일, 1,117,850,125 bytes
  (약 1.04 GiB)다. 주요 원인은 `torch_cpu.dll`, `ffmpeg.exe`, `llvmlite.dll`, frozen
  engine exe, `ctranslate2.dll` 등 분석 runtime/native dependency다. 외부 배포 전에는
  실제 기능 회귀를 동반한 payload slimming을 별도 관문으로 둔다.
- 회사 PC에서는 이 큰 payload를 다시 만들거나 NSIS 설치를 실행하지 않았다. source-only
  검증으로 helper/collector 37개, packaging/verifier 14개와 Windows source smoke가
  통과했다. `makensis.exe`도
  현재 환경에 없으므로 compile·설치 결과를 완료로 기록하지 않는다.
- 집 PC 관문은 기존 frozen artifact의 closed manifest/hash를 먼저 재검증하고 helper와
  unsigned installer를 한 번만 build한 뒤, 격리한 `LOCALAPPDATA`에서 fresh install,
  update, 의도적 중단 복구, readiness rollback, uninstall/reinstall, Start Menu 동작,
  외부 포트 충돌과 사용자 data sentinel 보존을 한 번의 smoke 묶음으로 확인하는 것이다.

3C installer PoC 범위:

- frozen engine·defaults·ffmpeg만 설치하는 전용 NSIS current-user layout 작성
- 엔진 실행, 연결 준비(`--pair`), 정상 종료(`--stop`) Start Menu 동작 연결
- install/update/uninstall-reinstall에서 config·models·database·results 보존과
  사용자가 명시한 전체 삭제만 허용하는지 실제 설치 경로에서 확인
- program payload staging·manifest 검증 실패 시 적용 중단과 복구 절차 정의
- 실제 코드 서명과 배포 URL이 없으므로 unsigned local installer PoC까지만 만들고
  웹 다운로드 CTA는 계속 닫아 둠
- 실제 모델을 연결한 대표 audio/video 분석 smoke로 위 이월 위험을 닫음

아직 포함하지 않는 항목:

- 사용자 배포용 설치 파일과 다운로드 링크
- production HTTPS origin 고정
- 실제 코드 서명과 installer 배포
- SQLite 마이그레이션
- 모델 다운로드 UI 재작성
- 시작 화면과 기존 회의 업무 화면의 재디자인

### 7.3 웹 전용 UI 디자인 작업선

기존 앱 셸, 시작, 새 기록, 분석 진행, 대화록, 기록 정리, 보고서, 기록 찾기와
설정은 현재 React UI와 프로덕션 시안을 재사용한다. 전체 화면을 별도 웹 UI로
복제하지 않는다.

2단계의 실제 상태·보안 계약이 확정된 뒤 4단계 구현 전에 다음 6장면만 하나의
별도 디자인 묶음으로 고정한다.

1. 최초 방문과 로컬 엔진 연결 안내
2. 엔진 미응답과 설치·실행 후 다시 연결. 이 장면은 엔진 미실행, 로컬 네트워크
   접근 권한 필요·거부, 조직 정책 차단을 같은 레이아웃의 명확한 상태 변형으로 둔다.
3. 일회성 코드 입력과 pairing 진행
4. 연결 완료와 원래 작업으로 복귀
5. 세션 만료·폐기와 재연결
6. API 버전 불일치와 업데이트 필요

각 장면은 같은 shell, 상태 컴포넌트, 버튼 위계와 용어를 사용하고, 사용자가
연결 전에 하던 작업과 연결 후 돌아갈 위치를 보존한다. 760/1100/1536px,
키보드, 확대, 강제 색상과 투명 효과 감소 상태를 필요한 범위에서 확인한다.

UI 작업 완료 조건:

- 새 전용 컴포넌트를 만들기 전에 기존 공통 컴포넌트 재사용 표를 작성한다.
- 공통 shell·토큰·상태 표면에서 벗어난 예외는 `docs/design.md`에 근거를 남긴다.
- loading, disabled 이유, 오류와 재시도, 성공 후 복귀가 mock 상태로 재현된다.
- 실제 브라우저 캡처와 승인 시안을 비교하되 기능 없는 장식·상태를 추가하지 않는다.

## 8. 검증 행렬

| 단계 | 자동 검사·시뮬레이션 | 실제 환경 증거 | 통과 기준 |
| --- | --- | --- | --- |
| 런타임 분리 | typecheck, `test:runtime-boundary`, `build:web`, `build:desktop`, writer/settings 시뮬레이션 | Tauri 개발 실행 smoke | 웹에서 invoke 없음, Tauri 주소·token 유지, 직접 경계 이탈 없음 |
| probe·pairing | backend focused unittest, 격리된 default-deny test, origin·nonce·rate limit·session 수명, 프런트 mock 상태 | 3단계 local helper가 준비된 뒤 후보 HTTPS origin pairing | 계약 PoC는 mock으로 통과하고, 단계 전체 완료는 실제 helper에서 다른 origin·만료·반복 추측 거부 |
| 설치·업데이트 | 설치/재설치/업데이트/제거 스크립트 검사와 manifest·hash 테스트 | 실제 Windows 현재 사용자 계정 smoke | single instance, 서명·manifest 검증, 사용자 데이터 보존 |
| 연결 UX | 상태별 Playwright, 키보드, 760/1100/1536px overflow·focus | Chrome/Edge 권한 승인·거부·재승인 | 6장면의 주 행동·이유·복귀가 일관되고 가로 overflow 없음 |
| 기본 인증 | 민감 GET·mutation·SSE·다운로드의 token 없음·만료·변조·origin 불일치, 직접 API fetch 목록 검사 | 세션 만료·재pairing 복구 | 공개 allowlist 외 default deny, 화면 직접 API fetch 0개 |
| SQLite | repository 계약, backup·staging·중단·중복·충돌·재실행·FTS 성능 테스트 | 캐시 삭제·브라우저 변경·기존 기록 가져오기 | 단일 writer, 원자적 commit, idempotent import, 기록·revision 보존 |
| 파일 동작 | 다운로드 이벤트·Content-Disposition·한글 파일명·object URL 해제 | 실제 DOCX/HWPX 열기 | 웹에 Tauri 동작·로컬 경로 노출 없음, 실제 파일 열림 |
| 통합 | 설치 전/후 흐름과 기존 분석·복구·검색 회귀 시뮬레이션 | 신규/기존 PC, 실제 HTTPS, 네트워크 기록 | 원격 음성 전송 없음, 설치부터 내보내기까지 Chrome/Edge 통과 |

무거운 전체 Playwright와 portable 빌드는 각 단계의 좁은 검증이 통과한 뒤
필요한 게이트에서만 수행한다.

## 9. 구현 전에 확정할 운영 입력

다음 값은 임의로 코드에 넣지 않는다. `미정`인 값은 표시된 중단 단계 전까지만
mock 또는 로컬 개발값으로 진행한다.

| 운영 입력 | 필요 시점 | 임시 진행 가능 범위 | 미정이면 중단할 단계 | 확인 증거 |
| --- | --- | --- | --- | --- |
| 실제 웹 배포 HTTPS origin | 2단계 설계, 8단계 실검증 | 개발 origin exact allowlist | production pairing 배포 | 배포 URL과 CORS/origin 테스트 |
| 설치·update manifest 배포 위치 | 3단계 | 로컬 파일 manifest | 실제 설치 CTA 공개 | 서명 URL·hash·rollback 증거 |
| Windows 코드 서명 인증서·주체 | 3단계 | unsigned 로컬 PoC | 외부 사용자 설치 배포 | 서명된 installer 검증 결과 |
| 엔진·사용자 데이터·로그 경로 | 3단계 | 프로젝트 임시 경로 | 재설치·업데이트 완료 판정 | 설치/제거 전후 데이터 목록 |
| 자동 시작 기본값·조직 정책 예외 | 3단계 | 수동 실행 | 사용자 설치 UX 확정 | 설정·정책 PC smoke |
| 공식 지원 Windows·CPU·RAM·GPU·여유 디스크 | 3C-0A | Windows 11 x64 개발 PC | installer 사용자 후보 배포 | 저사양·일반형·NVIDIA PC의 설치·대표 입력·처리시간 행렬 |
| Windows 10 x64·Windows 11 ARM64 지원 여부 | 3C-0A | 미지원 후보 | 해당 환경 지원 표기 | 실제 설치·분석·성능 증거와 native dependency 확인 |
| 고정 포트의 공용 PC·다중 사용자 정책 | 3C-0A~3단계 | 한 PC·한 활성 사용자 세션 | installer 사용자 후보 배포 | 포트 선점·두 사용자/RDP·절전 복귀 smoke와 복구 UX |
| 단계별 자동 점검 계약·runner | 3C-0B | 기존 분석 저장 공간 점검 | installer 구현 시작 | versioned DTO·CLI JSON·단위 테스트·실제 PC smoke |
| 진단 묶음·로그 회전·보존 기간 | 3C-0B~3단계 | 개발 로그 직접 확인 | 외부 사용자 지원 시작 | 민감정보 제외 자동 검사·크기 제한·내보내기·삭제 smoke |
| 최소 Chrome/Edge 버전 | 4단계 | 현재 개발 브라우저 | 웹 MVP 지원 선언 | 버전별 권한·다운로드 결과 |
| 엔진/API 호환·강제 업데이트 정책 | 2~3단계 | 단일 개발 버전 | 버전 불일치 UX 완료 | 호환 행렬·업데이트 테스트 |
| pairing helper 배포·서명·코드 UX | 2~3단계 | mock helper | 실제 pairing 완료 판정 | helper 실행·만료·origin 증거 |
| 재연결 자격 증명 저장·전달 방식 | 2단계 | 메모리 token | session PoC 완료 판정 | 새로고침·재시작·XSS/CSRF 검토 |

이 값이 없어도 1단계의 런타임 인터페이스와 mock 검증은 진행할 수 있다.
실제 설치 CTA, production origin, pairing 배포 검증은 값을 확정한 뒤 진행한다.

## 10. 완료 정의

웹 런타임 분리 작업은 다음이 모두 충족될 때 완료다.

- 공통 React UI가 웹과 Tauri에서 중복 없이 동작한다.
- 웹 사용자가 개발자용 서버 실행 안내를 보지 않는다.
- 설치·실행·권한·pairing·업데이트 상태를 과장 없이 복구할 수 있다.
- 모든 민감 API가 origin 제한과 별도의 인증을 함께 사용한다.
- SQLite가 웹 회의 기록의 기준 저장소다.
- 브라우저 캐시와 무관하게 기록이 보존된다.
- 모델 다운로드, 분석, 복구, 기록 찾기, 내보내기가 실제 HTTPS 웹 흐름에서 통과한다.
- 데스크톱 전용 기능이 웹에 노출되지 않고 기존 Tauri 동작도 회귀하지 않는다.
