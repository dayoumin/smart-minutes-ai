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
| 4. 웹 연결·복구 UX | 미착수 | 웹 전용 6장면 설계와 상태별 시뮬레이션 필요 |
| 5. 전체 API 클라이언트 전환 | 미착수 | 직접 API fetch 0개와 인증 회귀 행렬 필요 |
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
| Chrome·Edge와 조직 정책의 Local Network Access | 열림 | 최신 stable Chrome·Edge에서 승인·거부·재승인, 브라우저 재시작, 관리 정책 사전 허용·차단 smoke | 지원 브라우저 범위와 상태별 복구 안내가 확정되고 회사 관리 브라우저의 차단을 설치 실패와 구분 | 2026-08-14 |
| 고정 포트와 공용 PC·다중 Windows 사용자 | 열림 | `127.0.0.1:17863` 선점, 같은 PC의 두 사용자/RDP 세션, 엔진 재시작·절전 복귀 smoke | 다른 프로세스를 탐색·종료하지 않고 충돌 원인과 복구 동작을 사용자에게 제공하며 지원 범위를 명시 | 2026-08-14 |
| 설치·모델 다운로드의 오프라인·프록시·보안 제품 영향 | 열림 | 일반 인터넷, 인증 프록시, 완전 오프라인, Defender·SmartScreen·대표 조직 EDR에서 설치·모델 받기·업데이트 확인 | 서명·관리자 배포·오프라인 모델 준비·중단 후 재개 절차가 있고 차단 원인을 사용자 조치와 관리자 조치로 구분 | 2026-08-14 |
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
