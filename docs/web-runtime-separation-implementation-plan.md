# 웹 런타임 분리 구현 계획

- 작성일: 2026-08-13
- 상태: 2026-10-18 점검 — 웹 인증·격리 API 회귀, 설치 r1·frozen smoke 및 loopback TLS 실모델 UI 2건·다운로드 8개 확인; 요약 준비 상태·실모델 후 종료 잔류 P2와 공개 HTTPS/LNA·서명·다른 PC·SQLite 관문 열림
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
- `docs/design.md`(2026-10-17 방향 A)가 공통 UI의 디자인 권위다. 이전 시안은
  `docs/archive/design-2026-06-to-10/`에 보관했다. 단계별 구현이 이 기준과 충돌하면 임의로 새 스타일을 만들지 않는다.
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
   `ProgressBar`, `AppToast`, `Layout`, `Sidebar`와
   `index.css`의 공통 클래스·토큰을 먼저 확인한다.
2. 같은 의미와 상태 전이를 가진 UI가 두 화면 이상에서 반복되거나 웹과
   Tauri가 함께 사용하면 공통 컴포넌트 또는 typed prop 계약으로 승격한다.
   모양만 비슷하고 행동이 다른 UI를 억지로 하나로 합치지 않는다.
3. 화면 파일에서 원시 색상, 임의 radius·shadow·z-index를 추가하지 않는다.
   상태 색상, 표면, 포커스, 간격과 버튼 위계는 `docs/design.md`와 semantic
   token을 사용한다.
4. 작업면 뒤에 사진·생성 이미지 배경을 두지 않는다(2026-10-17 방향 A에서
   해양 배경 제거). HTML 버튼·입력·상태 문구를 이미지에 합치지 않는다.
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
| 5. 전체 API 클라이언트 전환 | 웹 코드·격리 회귀 통과, 실환경 대기 | 공통 클라이언트·401 갱신·웹 음성 중계·실제 API 인증 회귀를 2026-10-18 재확인. 실제 HTTPS·설치 엔진 통합은 미완료; Tauri native 재생은 별도 호환 관문 |
| 6. SQLite 기준 저장소 | 미착수 | 백업·가져오기·충돌·FTS·재실행 안전성 필요 |
| 7. 브라우저 파일 동작 | 부분 구현·실환경 대기 | 인증 다운로드·범위별 실제 API 파일·로컬 TXT 일관성 검사 구현 및 통과. 실제 HTTPS 다운로드·한글 파일명·취소·세션 만료와 Word/한컴 열기 증거 필요 |
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

### 6.6 2026-10-17 기능 점검 재개 계획 — 디자인 작업 병행

이번 목표는 현재 노출된 기능이 사용자 목적대로 작동하는지 에이전트로 점검할 실행 계획을 확정하는 것이다. 6.5의 A1~A6와 기존 증거를 이어받는다. 계획 수립 당시에는 읽기 조사와 문서 수정만 수행했다. 이후 실제 실행 증거는 이 절 마지막의 날짜별 결과에 기록한다.

#### 범위와 기준

- 조사 기준은 `HEAD eea2ab6`이다. 사용자 변경 `.claude/launch.json`은 제외한다. 실행 때마다 HEAD·미커밋 변경·대상 파일을 다시 기록하고, 검사 도중 다른 AI가 관련 파일을 바꾸면 영향을 받은 결과만 재검증한다.
- 대상은 HTTPS 웹 + Windows 로컬 엔진의 기능이다. 디자인 AI가 소유한 색상·배치·스타일은 제외하되 버튼 실행, 필수 입력, 비활성 조건, 키보드 접근, 입력 보존과 오류 복구는 기능으로 본다. 기능 결함을 고칠 때 공유 UI 파일 편집은 디자인 작업과 조율한다.
- 현재 기본 진입은 새 기록 + 최근 회의록이다. 이어하기 후보가 있으면 복구 카드가 우선한다. 숨겨진 `기록 찾기`는 개발 경로 `?view=archive`의 보조 회귀로만 다룬다. 음성만 추출하는 도구는 `SHOW_AUDIO_EXTRACT_TOOL=false`이므로 현재 노출 기능의 필수 목록에서 제외한다.
- 10/15 A1~A4 통과는 당시 증거다. `3f61250..eea2ab6`에서 화면 진입·상세·사이드바·생성/다운로드 코드뿐 아니라 backend의 `summary_display.py`와 MD/DOCX/HWPX export도 바뀌었다. main route가 그대로여도 이 의존성을 쓰는 다운로드 증거는 갱신해야 한다.
- 전체 Playwright, 실제 장시간 처리, 모델 비교 실험, 새 저장소 구현, portable/Tauri 빌드, 배포·커밋·push는 이번 기본 점검 범위에서 제외한다. 출시 전 필요한 실환경 항목은 기존 위험 표에 유지한다.

#### 에이전트 분담과 판정

| 담당 | 독립 점검 범위 | 반환할 증거 |
| --- | --- | --- |
| 사용자 흐름 에이전트 | 새 기록·파일 입력·최근/기존 기록·폴더·설정 이동·중지/취소/이어하기·조작 가능 여부 | 시작 상태 → 행동 → 기대 결과, 실제 관찰, 관련 UI 검사 |
| 데이터 에이전트 | 편집/저장/재열기·생성 실패·다른 회의 응답 격리·참석자명 삭제·내보내기 내용 | 화면·IndexedDB·엔진 JSON·다운로드의 비교, 실제 파일 또는 집중 API 검사 |
| 연결·복구 에이전트 | 엔진/모델 준비·코드 연결(pairing)·세션 만료·권한·재연결·실제 엔진 실행 조건 | 정상/거부/복구 결과, 실행 환경과 mock 여부, 미확인 경계 |
| 주 에이전트 | 기준 고정·실행 순서·중복 제거·심각도와 완료 판정 | 통합 결과 및 다음 최소 작업 묶음 |

읽기 분석만 병렬로 한다. 브라우저·테스트·추론·서버·겹치는 편집은 순차 실행한다. 각 기능은 `통과 / 재현된 결함 / 환경 차단 / 미검증 / 현재 범위 밖`으로 판정한다. 코드에 존재하거나 mock 검사만 통과한 기능을 실제 엔진 통과로 표시하지 않는다. 실패는 제품 결함, 바뀐 요구와 맞지 않는 테스트, 도구/서버 환경 문제로 먼저 분류한다.

#### 우선 시나리오

| ID | 준비 상태와 행동 | 합격 기준 | 재사용할 증거·남은 확인 |
| --- | --- | --- | --- |
| FN-01 | 빈 기록/6개 이상 기록/중지 초안/취소 정리 대기에서 새 기록·최근 기록 열기 | 최근 5개와 복구 우선순위가 맞고, 분석 잠금 중에도 기존 기록 열기 가능 | `test:new-record-home-flow`; 최신 기본 진입부터 확인 |
| FN-02 | 엔진 없음·모델 미준비 → 설정/연결 → 준비 후 작성 복귀 | 준비 전 시작 차단, 제목·목적·파일 보존, 준비 후 시작 가능; 요약/참석자 모델 부재가 가능한 작업까지 막지 않음 | `test:writer-model-readiness`, 필요 시 연결 UI·모델별 backend 검사. 기존 readiness는 미준비→모델 탭까지만 확인하므로 복귀·실사용은 별도 |
| FN-03 | 실제 모델로 짧은 WAV 1개와 영상 1개 분석·저장·재열기·재생 | mock 대화록이 아닌 실제 발언 저장, 작업 완료/파일/진행 상태 일치, 재열기 보존 | A4 실제 추론 증거 필요. 기존 manifest에서 파일 존재·길이 확인 후 선택 |
| FN-04 | 분석 중 중지/취소·실패 후 재시도·같은 파일 이어하기 | 중지 결과 재사용, 취소 후 새 실행, 중복 분석 없음, 취소 대기 잠금과 유효 기록 보존 | analysis-stop의 `failure-recovery`·`pending-cancellation-transition`, resume 및 필요한 resume-draft 필터 |
| FN-05 | 대화록 저장 후 원본/모델 있음·없음에서 참석자 구분 시작·중지·재실행 | 가능한 동작만 제공, 실패해도 대화록 보존, 준비 후 복구 가능 | `test:meeting-detail-flow` 및 실제 다화자 짧은 표본 |
| FN-06 | A 회의 정리/보고서 생성 중 B 이동, 재생성 실패, 편집→저장→재열기 | A 결과는 A에만 저장, B 내용·모드 불변, 실패 시 정상 결과 보존, 화면·저장값 일치 | meeting-detail·edit-guard·report-tab-edge; 기존 A3 교차 회의 증거는 주제 생성 대표 경로임 |
| FN-07 | 발언/이름 편집과 이름 비우기 후 대화록·정리·보고서·전체 다운로드 | 최신 내용과 범위가 맞고 지운 이름이 부활하지 않음, 주제 제목 규칙이 화면/파일에 일치 | export-consistency·download-scope와 아래 실제 API 파일 검사. Word/한컴 실열기는 별도 |
| FN-08 | 폴더 생성·이름/고정/순서 변경·기록 이동·폴더 삭제 후 재열기, 설정 저장 후 재진입 | 선택한 기록/설정이 유지되고 폴더 삭제가 회의록을 삭제하지 않음; 모델 작업 실패 후 다시 조작 가능 | meeting-detail의 폴더/고정 시나리오와 settings-model-management; 실제 설정 지속성은 별도 비교 |
| FN-09 | 긴 파일 메타데이터 경계·저장공간 부족·사전점검 실패 주입 | 안내/차단과 복구가 일관되고 파일/입력 보존 | `backend.test_storage_preflight`; 30/90/140분 UI 경계 단언은 추가 확인 대상. 실제 긴 파일 완주는 후속 |

#### 실행 순서와 최소 명령

1. **변경 영향 고정**: HEAD/diff와 현재 노출 기능을 대조한다. 기존 통과 증거의 대상 코드·의존성이 유지됐는지 확인한다. 코드 변경이 있는 후속 묶음에는 typecheck·변경 파일 lint를 포함한다.
2. **백엔드 변경 회귀**: 디자인 화면의 완료를 기다리지 않고, 최근 주요 주제 표시 변경에 해당하는 아래 7개 테스트부터 순차 실행한다. 공통 인증/route가 그대로라면 보안 전체 모듈은 반복하지 않는다.

   ```powershell
   # D:\Projects\audio
   & .\backend\.venv-desktop\Scripts\python.exe -B -X utf8 -m unittest backend.test_summary_display backend.test_authenticated_web_flow.AuthenticatedWebFlowTest.test_actual_export_files_preserve_current_content_and_scope
   corepack pnpm --dir desktop-app test:export-consistency
   ```

3. **현재 UI 기능 회귀**: FN-01 → FN-02 → FN-04를 첫 UI 묶음으로 실행한다. 이후 상세·폴더·생성·다운로드를 FN-05~08로 나눠 해당 검사만 실행한다. 기존 디자인 서버는 재사용·중지하지 않고, 확인한 빈 포트에 검사 전용 Vite를 시작해 명령·포트·작업 폴더를 기록한다.

   ```powershell
   # 실행 시 빈 포트인지 먼저 확인. 5197은 예시이며 이번에 시작하지 않았다.
   corepack pnpm --dir desktop-app dev --host 127.0.0.1 --port 5197 --strictPort
   $env:PLAYWRIGHT_BROWSERS_PATH='D:\Projects\audio\.cache\ms-playwright'
   $env:APP_URL='http://127.0.0.1:5197/'
   corepack pnpm --dir desktop-app test:new-record-home-flow
   $env:APP_URL='http://127.0.0.1:5197/?view=minutes'
   corepack pnpm --dir desktop-app test:writer-model-readiness
   corepack pnpm --dir desktop-app test:analysis-stop-flow failure-recovery
   corepack pnpm --dir desktop-app test:analysis-stop-flow pending-cancellation-transition
   ```

   상세·설정 검사는 각 스크립트의 진입 URL에 맞춰 `APP_URL`을 다시 지정한다. 연결 preview 검사는 `?view=minutes&localEngineConnection=1`을 유지한다. 자동으로 다른 서버를 재사용하지 않도록 `APP_URL`을 명시하고 앱 제목·진입 화면으로 대상을 확인한다. 검사 후 이 세션이 시작한 서버/브라우저만 정리한다.

4. **실제 처리·복구와 결과 품질**: FN-03/05를 개발 엔진과 설치 엔진으로 구분해 실행한다. 실행 파일/명령·`/api/health`의 backend 경로·실제 분석 모드·모델·출력 폴더를 기록하고 격리한 테스트 기록만 사용한다. 기존 사용자 모델을 지워 미준비를 만들지 않는다. `docs/audio-testset-manifest.csv`의 현재 행은 기준 대화록이 없으므로, 품질 판정 전에 선택 구간을 사람이 청취해 핵심 발언·참석자·결정/할 일의 비교 기준을 만든다. 발언 누락/반복·화자 혼동·근거 없는 정리 내용을 확인하고 표본 통과를 전체 품질 보장으로 확대하지 않는다. 전처리/모델 기본값은 바꾸지 않는다.
5. **실환경 관문**: A5/A6의 확정 HTTPS 주소·설치 후보·지원 Chrome/Edge·필요한 다른 PC가 준비되면 권한 승인/거부/재승인→연결→실제 분석→인증 재생/탐색→저장/다운로드를 확인한다. 준비되지 않은 관문은 미검증으로 유지한다. 실제 문서 열기, 장시간 재생, 설치/업데이트, 캐시 독립 보존은 기존 출시 위험 표와 6단계 상태를 갱신하며 중복 위험 행을 만들지 않는다.

#### 기록과 종료 조건

- 결과에는 `시나리오 ID / 소스 기준 / 환경·mock 여부 / 정확한 명령·입력 / 기대·실제 결과 / 판정 / 재현 근거 / 다음 조치`를 남긴다. 테스트 개수만으로 완료하지 않는다.
- 첫 묶음은 backend 변경 회귀와 FN-01/02/04의 증거 확보까지다. 재현된 결함은 현재 사용자 흐름·저장·인증을 막는지 분류해 수정 묶음을 정한다. 이번 계획 수립과 실제 기능 점검 통과를 구분한다.
- P0/P1과 현재 흐름·데이터·인증·검증 신뢰를 막는 P2가 남으면 해당 기능은 완료 처리하지 않는다. 나머지 유효한 후속은 기존 `todo.md`/출시 위험 표에 기록한다. 같은 범위의 검사·의존성이 유지되면 반복하지 않는다.
- 이번 계획의 근거는 독립 에이전트 3개의 읽기 조사와 주 에이전트의 현재 diff 대조다. 제품 코드·테스트·서버·모델·배포 설정은 변경하지 않았다.

#### 최근 변경 재검증 실행 결과 — 2026-10-17

- 범위: `3f61250..eea2ab6`의 주요 주제 표시·내보내기 변경(도입 커밋 `6ae28f2`). backend helper와 MD/DOCX/HWPX·전체 TXT, frontend의 동일 목록/로컬 TXT builder와 기존 이름·편집·범위 계약만 확인했다. 주 에이전트가 검사를 순차 실행하고 독립 에이전트 2개가 backend 데이터 계약과 frontend/검증 공백을 나눠 읽기 리뷰했다.
- 기준 보존: `HEAD eea2ab6c0762a3c7a7e4dc357025d1f1653ee497`. 대상 helper/exporter/검사/main/repository 등 11개 파일의 `git hash-object` 결과가 실행 전후 같았다. 실행 중 다른 AI의 App·작성·최근 기록·사이드바·스타일 및 UI 시뮬레이션 변경이 생겼지만 이 점검에서 편집하거나 검사 결과로 보증하지 않았다. 기존 `.claude/launch.json`과 계획 문서 변경도 보존했다.
- 환경: Windows PowerShell, 작업 폴더 `D:\Projects\audio`, 기존 `backend\.venv-desktop`와 `desktop-app/node_modules` 사용. API 테스트는 임시 config/세션/출력/다운로드를 격리하고 실제 serializer·route·파일 응답을 실행한다. 브라우저·실제 모델·TCP/TLS·사용자 설치 엔진을 실행한 증거는 아니다. 서버·모델 설치·빌드·제품 코드/테스트 편집·커밋·push는 수행하지 않았다.

| 검사 | 결과 | 확인 범위 |
| --- | --- | --- |
| backend 주요 주제·실제 다운로드 집중 검사 | 7개 통과 | 제목 우선/공백 중복 제거/fallback/일부 잘못된 값, MD/DOCX/HWPX 주제 목록, 실제 인증 API의 범위×형식 11조합 |
| `test:export-consistency` | 9개 통과 | 편집 대화록 우선순위, 지운/부분/legacy 이름, 현재 참석자 요약, backend 출력 없는 payload/대체 텍스트, 주요 주제 제목 우선·fallback |
| 실제 helper 경계 비교 | 한국어·ASCII 중복·빈 제목 fallback 일치, Unicode 1건 불일치 재현 | 아래 P2. MD·전체 TXT 실제 파일에서도 확인, 본문과 입력 객체 보존 |

실행 명령:

```powershell
# D:\Projects\audio, 순차 실행
& .\backend\.venv-desktop\Scripts\python.exe -B -X utf8 -m unittest -v backend.test_summary_display backend.test_authenticated_web_flow.AuthenticatedWebFlowTest.test_actual_export_files_preserve_current_content_and_scope
corepack pnpm --dir desktop-app test:export-consistency
```

API 하위 조건은 대화록 TXT, 기록 정리 MD/DOCX/HWPX, 보고서 MD/DOCX/HWPX, 전체 TXT/MD/DOCX/HWPX다. 실제 response bytes의 최신 내용·포함/제외 범위·지운 이름·생성 당시 보고 양식·MIME/첨부 파일명·ZIP CRC/XML과 원본 JSON 비변경을 확인했다. DOCX/HWPX 편집기 렌더링은 확인하지 않았다. backend 실행 시 기존 Starlette/httpx 폐기 예정 경고가 있었으며 테스트 오류와 구분했다.

**재현된 P2 — Unicode 주제 목록 불일치, 후속 수정 대기.** 유효한 문자열 제목 `Maße`, `Masse`를 가진 두 section을 넣으면 실제 frontend `getDisplayTopics`는 두 항목, backend `get_display_topics`는 첫 항목만 반환한다. frontend `meetingGeneration.ts`는 `toLocaleLowerCase()`, backend `pipeline/summary_display.py`는 `casefold()`를 사용하기 때문이다. backend MD와 `plain_text=True` 전체 TXT 파일의 주요 주제에도 첫 항목만 남는 것을 재현했다. 두 section 본문(`dimensions`, `mass`)과 원래 입력 객체는 보존됐다. DOCX/HWPX도 같은 helper를 사용하지만 이 Unicode 입력으로 두 형식의 파일을 별도 재현하지는 않았다.

재현 입력은 `topics=[]`, `topicSections=[{topic:'Maße',summary:'dimensions'},{topic:'Masse',summary:'mass'}]`이고 backend에는 `topic_sections` 키로 전달했다. PowerShell 표준 입력으로 `desktop-app`에서 `node --input-type=module`을 실행해 실제 TS helper를 기존 검사와 같은 AST/VM 방식으로 읽었다. 이어서 루트에서 `backend\.venv-desktop\Scripts\python.exe -B -X utf8 -`로 실제 Python helper·`export_markdown`을 임시 폴더에서 실행했다. 한국어 공백 중복, ASCII `Budget/BUDGET`, 빈 section 제목 뒤 `topics` fallback은 양쪽 결과가 같았다.

- 판정: 기본 회귀 16개는 통과했지만 화면/파일의 모든 문자열 일관성을 완료 처리하지 않는다. 재현된 P2는 `todo.md`에 승격했다. 일반 한국어 대표 입력에서 차단은 없으며 다음 UI 점검 묶음 진행은 가능하다. 점검 요청 범위를 유지해 수정은 하지 않았다.
- 확인 공백: 비문자 section 제목은 frontend가 버리고 backend는 문자열로 바꾼다. 정상 생성은 이미 제목을 문자열로 정규화하므로 기존 사용자 기록 발생 근거 없이 결함으로 단정하지 않는다. 동일 fixture를 양쪽에 넣는 검사는 향후 규칙 통일 시 보강한다.
- 남은 관문: FN-01/02/04 최신 UI, 실제 WAV/video·모델 준비·참석자 구분, Word/한컴 실열기·실제 HTTPS·설치 PC는 이번에 실행하지 않았다. 실제 문서/HTTPS 검증은 기존 출시 위험 표의 동일 행을 유지한다.

#### 새 기록·모델 미준비·실패/취소 복구 점검 — 2026-10-17

- 범위: FN-01/02/04. 독립 에이전트 3개가 새 기록/이동, 모델 준비, 실패/취소 보존을 나눠 읽기 검토하고 주 에이전트가 브라우저 검사를 순차 실행했다. 시각 디자인·제품/기존 테스트 수정·모델 설치·실제 추론은 제외했다.
- 기준: 시작 `eea2ab6` + 다른 AI의 미커밋 UI 변경. 종료 시 다른 AI의 커밋으로 HEAD는 `8754c59`가 됐지만 App/Writer/최근 기록/설정/저장/연결 및 대상 검사 등 18개 파일의 해시가 시작과 같았다. 다른 AI의 스테이징과 `.tmp-index-check` 파일은 보존했다. 이 점검의 변경은 결과 문서와 Git 제외 경로 `.tmp/functional-audit-2026-10-17/flow-probes.mjs`뿐이다.
- 환경: `D:\Projects\audio`에서 `corepack pnpm --dir desktop-app dev --host 127.0.0.1 --port 5197 --strictPort`. HTTP 제목 `바로록`·실제 `/src/main.jsx`·브라우저 DOM으로 대상을 확인했다. 프로젝트 Playwright cache와 각 검사 전용 browser context를 사용해 API를 mock하고 IndexedDB/localStorage를 격리했다. 네트워크/브라우저 권한·실제 엔진·실제 파일 코덱 검증은 아니다. 검사 후 이번 서버(PID 23376)를 Ctrl+C로 종료했고 5197 LISTENING이 사라진 것을 확인했다.

| 검사 | 결과 | 확인 범위 |
| --- | --- | --- |
| 표준 `test:new-record-home-flow` | 환경 차단으로 기록, 통과 처리 안 함 | 첫 실행은 초기 `page.goto` 30초, 두 번째는 첫 heading 10초 대기 초과. 이후 진단 브라우저에서 실제 앱 렌더링 확인 |
| 별도 기능 전용 home probe | 4장면 통과 | 빈 새 기록, 최근 5개/그룹/열기, 복구 카드/선택, 취소 대기 중 분석 차단과 기존 기록 열기 |
| `test:writer-model-readiness` | 통과 | 필수 모델 미준비 안내·시작 차단·모델 탭 이동 |
| `test:analysis-stop-flow failure-recovery` | 통과 | 모의 오류 후 제목/파일 보존·입력 확인·초점·재시도, 정확한 재요청 횟수 |
| `test:analysis-stop-flow pending-cancellation-transition` | 통과 | 지연 partial/정리 409에서 새 분석 잠금과 중복 요청 차단, 파일 교체/지연 metadata 보호 |
| 준비 완료·설정 왕복·최근 기록 이동 probe | 입력 보존 통과, 초점 결함 재현 | 제목·목적·File 이름 유지, 시작 활성화; 최근 기록 이동 거부/승인→상세→로고 복귀 입력 유지; Escape 닫기 뒤 초점 BODY |
| 취소 보존 계약 probe | 안내/동작 불일치 재현 | 격리 DB에 진행 중 대화록 1건 준비→실제 취소 UI 실행→기존 취소 검사에서 기록 0건 확인 |

실행 명령은 아래와 같다. 표준 home 검사는 실패 이력이며 별도 기능 probe 통과로 덮어쓰지 않는다.

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH='D:\Projects\audio\.cache\ms-playwright'
$env:APP_URL='http://127.0.0.1:5197/'
corepack pnpm --dir desktop-app test:new-record-home-flow
node .tmp/functional-audit-2026-10-17/flow-probes.mjs home
$env:APP_URL='http://127.0.0.1:5197/?view=minutes'
corepack pnpm --dir desktop-app test:writer-model-readiness
corepack pnpm --dir desktop-app test:analysis-stop-flow failure-recovery
corepack pnpm --dir desktop-app test:analysis-stop-flow pending-cancellation-transition
node .tmp/functional-audit-2026-10-17/flow-probes.mjs readiness
node .tmp/functional-audit-2026-10-17/flow-probes.mjs cancel-contract
```

home probe는 현재 시뮬레이션 함수를 메모리에서 읽어 실행하며 첫 장면의 순수 배치 측정을 제외하고 10초 명시 대기를 30초로 늘렸다. 기존 테스트 파일은 그대로다. 나머지 최근 목록/복구/취소 대기 장면의 기능 단언은 유지했다. 표준 검사 초기 진입 실패는 제품 기능 실패로 단정하지 않는다. 후기 서버 로그에는 다른 AI의 `.tmp-index-check` 하위 HTML/tsconfig 변경에 따른 full reload·cache clear와 CSS HMR도 있었다. 공유 작업 트리의 외부 reload는 남은 검사 환경 한계이며 기능/입력 보존 통과를 전체 디자인 회귀 통과로 확대하지 않는다.

**P2 — 취소 안내가 보존 범위를 과장한다.** `MeetingWriter.tsx:2636`은 취소 시 지금까지 만든 대화록·정리 결과를 남긴다고 말하지만 `deleteMeetingRecordForJob`은 편집/정리 결과 없는 `diarization_in_progress` 기록을 삭제한다. 완료·중지·실패 기록이나 사용자 결과가 있는 기록의 보호와는 별개다. 별도 probe에서 실제 취소 패널 문구와 취소 전 `segments=1`의 진행 중 기록을 확인했고, 취소 후 기존 검사 단언 `meetings.length===0`이 통과했다. 전체 SSE를 취소까지 보류하는 기존 fixture 특성 때문에 중간 기록은 실제 partial 저장 형태로 DB에 준비했다. 실제 STT가 중간 결과를 생성한 증거는 아니다. 초기 probe의 partial 저장 대기는 이 fixture 특성으로 실패했고 DB 준비 방식으로 바꿔 재검증했다. 데이터 처리 정책에 맞게 안내하거나 정책을 명시하는 후속을 TODO에 기록했다.

**P2 — 모델 준비 완료 후 설정을 닫으면 키보드 초점이 빠진다.** 미준비 화면의 `모델 준비`로 설정 진입→mock 모델 준비 완료→실제 설정 새로고침→Escape 닫기에서 제목·목적·선택 파일과 시작 가능 상태는 유지됐으나 `document.activeElement`가 BODY였다. 준비 완료로 기존 trigger가 제거되면 `Settings.tsx:465`의 isConnected 조건에서 초점 복귀가 생략되고 대체 대상이 없다. 다음 유효 조작으로 초점을 복귀시키는 후속을 TODO에 기록했다.

- 재현하지 못한 후보: 이전 missing 응답을 보류하고 새 ready 응답을 먼저 완료한 뒤 이전 응답 완료까지 기다렸으나 최종 버튼은 `분석 시작`, enabled였다. 두 번의 probe에서 준비 차단 회귀는 관찰되지 않았다. 코드상 요청 세대 보호 공백만으로 결함 수에 넣지 않는다. 위 외부 reload 한계도 있어 요청 경합의 안전성을 전부 입증한 것으로 처리하지 않는다.
- 남은 공백: 실제 모델 받기/추론, 요약·참석자 모델별 실제 제한, 완료 전에 설정을 닫은 뒤의 다운로드 반영, 정리 성공 후 자동 잠금 해제/실제 재시작, 새로고침/브라우저 프로필 손실 복구는 이번 증거에 포함하지 않는다. 연결 preview의 준비 문구 후보도 실제 장면 검증 전에는 확정하지 않는다.
- 판정: 기본 조작·입력 보존·실패 재시도·취소 대기 잠금의 좁은 증거를 확보했다. 현재 흐름의 P2 두 건과 표준 home 검사 환경 차단을 남겼으므로 FN-01/02/04 전체 완료나 출시 가능으로 표시하지 않는다. 다음 수정 묶음은 취소 보존 안내·준비 후 초점 복귀이며 다른 AI 소유 UI 파일의 편집은 조율한 뒤 진행한다.

#### 취소 안내·설정 초점 수정과 격리 재검증 — 2026-10-17

- 수정 범위: `MeetingWriter.tsx`의 취소 설명과 초점 복귀 표식, `Settings.tsx`의 복귀 처리, 관련 시뮬레이션 2개만 변경했다. 보존/삭제 정책·API·CSS·레이아웃·다른 AI의 회의 상세 작업은 변경하지 않았다. 시작 HEAD는 `8754c59`, 검증 중 다른 AI가 `12e4883`/`3ab5b87`을 커밋했으며 해당 변경은 보존했다.
- 취소 안내: 이번 분석의 임시 대화록 삭제와 완료·중지·실패한 회의록, 본문 수정·확정 대화록 및 정리 결과의 보존을 구분한다. 독립 agent가 일반적인 제목/목적/이름 편집까지 보존한다고 읽힐 수 있다고 지적해, 최종 문구는 **본문 수정·확정**으로 좁혔다. 실제 보존 로직은 그대로다.
- 초점 복귀: 원래 열었던 요소가 표시·활성 상태면 우선 복귀한다. 모델 준비로 그 요소가 사라졌다면 열기 당시의 작성 영역 안에서만 표시·활성 대상을 찾는다. 파일이 있으면 분석 시작, 없으면 파일 선택 영역이다. 다른 화면의 숨긴 Writer나 숨겨진 파일 input으로 이동하지 않으며 클릭·파일 선택창·분석을 자동 실행하지 않는다.
- 격리 환경: 활성 `desktop-app` 밖의 `.tmp\functional-fix-20261017\desktop-app`에 src/public/scripts·실행 설정을 복사하고 기존 node_modules는 junction으로 재사용했다. 복사본 `vite.config.js`의 `cacheDir`는 `fileURLToPath(new URL('./.vite-audit-cache', import.meta.url))`로 분리했다. 원본 Vite 설정과 다른 AI의 서버·파일을 변경하지 않았다. 원본 앱과 검사본의 수정 4개 파일 및 기존 home 검사, App/최근 기록/CSS 해시가 일치했다.
- 작업 폴더는 위 격리 앱 폴더다. 서버 명령은 `corepack pnpm dev --host 127.0.0.1 --port 5198 --strictPort`. 실제 제목 `바로록`과 새 기록 heading으로 진입을 확인한 뒤 **원본 home 시뮬레이션의 대기 시간·단언을 바꾸지 않고** 실행했다. 이전 공유 환경의 시간 초과는 이 격리 실행에서 재현되지 않았다. 이 결과를 모든 PC의 콜드 스타트 성능 보장으로 확대하지 않는다.

| 검사 | 결과 |
| --- | --- |
| `corepack pnpm test:new-record-home-flow` | 원본 4장면 전체 통과; 별도 우회 probe가 아님 |
| `corepack pnpm test:writer-model-readiness` | 미준비 차단·모델 탭, 기존 opener 복귀, 준비 완료 후 분석 시작/파일 선택 초점, 제목·목적·File 보존 통과 |
| `corepack pnpm test:analysis-stop-flow pending-cancellation-transition` | 수정한 취소 설명 노출·취소 대기 잠금·중복 실행 차단 통과 |
| `corepack pnpm test:resume-draft-flow stopped-meeting-keeps-generated-sections failed-meeting-keeps-generated-sections resume-cancel-keeps-user-result` | 중지·실패 기록의 생성 결과 및 이어하기 취소 후 사용자 결과 보존 3장면 통과 |
| `corepack pnpm typecheck` | 격리 앱 최종 소스 통과; 원본 작업 폴더 타입 검사도 통과 |
| 원본 작업 폴더의 변경 파일 lint·diff 검사 | 통과 |

Playwright 실행 시 `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`, home은 `APP_URL=http://127.0.0.1:5198/`, 나머지는 `APP_URL=http://127.0.0.1:5198/?view=minutes`를 명시했다. 원본 변경 파일 lint 명령은 `corepack pnpm --dir desktop-app exec eslint src/Settings.tsx src/MeetingWriter.tsx scripts/simulate-writer-model-readiness.mjs scripts/simulate-analysis-stop-flow.mjs`다. 초기 lint가 렌더 중 ref 읽기를 지적해 작성 영역 기억을 effect 설정으로 옮겼으며 최종 검사에서는 오류가 없다.

- 독립 검토: agent 2개가 각각 취소 정책·문구와 초점/StrictMode/숨긴 영역/검증 범위를 검토했다. 문구 finding을 수정한 뒤 해당 finding 재검토에서 해소됐고, 최종 P0/P1·현재 목표 P2 차단은 없다. 두 기존 P2는 TODO에서 완료로 바꿨다. Unicode 주제 목록의 별도 P2는 계속 열어 둔다.
- 정리: 검사 전용 서버 PID 33604를 Ctrl+C로 종료했고 5198 LISTENING이 사라진 것을 확인했다. 이번 세션은 Git index·커밋·push를 조작하지 않았다. 격리 소스·캐시는 Git 제외 경로에만 남긴다.
- 한계·다음: API와 모델 상태는 mock이다. 이번 수정·기능 회귀와 home 환경 차단은 해소했지만 실제 모델 받기/추론·HTTPS·설치 엔진·다른 PC·보조기술 출시 관문을 완료한 것은 아니다. 다음은 기존 A4 실제 짧은 WAV/video와 생성 결과 근거 확인이다.

#### 실제 모델 처리 시도·환경 차단 — 2026-10-17

- 판정: **실제 분석 결과 0건, A4 실모델 관문 미완료**. mock 응답은 사용하지 않았으나 실제 STT 완료에 도달하지 못했다. 참석자 구분·요약·브라우저 저장/재열기·동기화·실제 결과 내보내기는 미실행이다. 이전 mock/API fixture 통과로 대체하지 않는다.
- 격리: `.tmp\native-model-audit-20261017`에 config·표본·outputs·temp·logs와 별도 Vite 소스를 두고 기존 모델은 junction으로 읽었다. 기본 `backend/config.json`, 사용자 outputs, 제품/디자인 코드는 수정하지 않았다. 시작 HEAD `3ab5b87`; 다른 AI의 진행 중 변경은 보존했다. 선택은 faster-whisper-large-v3 CPU, speaker-diarization-community-1, gemma4:e2b다. 검사 config에서만 구분/요약 자동 생성을 끄고 후속 endpoint로 나누었다.
- 표본: `video/test (4).mp4` 앞 30초를 bundled ffmpeg로 mono 16kHz WAV로 추출했고 기존 `video/portable_video_15s.mp4`를 복사했다. 두 표본을 manifest에 등록했다. 사람 정답 대화록·검증된 화자 수가 없어 정확도/참석자 구분 품질은 판정할 수 없다.
- 실행 경계: 기본 LocalAppData 설치/데이터 엔진 폴더는 없었다. 이번 시도는 **현재 소스의 Windows Python 로컬 API**이며 설치 엔진·frozen payload·Tauri·실제 HTTPS 검증이 아니다. 기존 system Ollama PID 17392/11434는 유지했다. 앱 전용 Ollama 모델 tag와 manifest layer 파일은 있었지만 요약 추론은 실행하지 않았다.

| 단계 | 실제 증거 | 판정 |
| --- | --- | --- |
| 최초 `.venv-desktop` 엔진 | 인증 강제, QA backend_dir·Python health 일치, 공간 preflight HTTP 200 | 좁은 API 진입 확인 |
| 30초 WAV real 요청 | `mode=real`, `native_audio_20261017`, 실제 SSE 업로드→모델 경로 확인→WAV 변환→chunk 준비→STT 30%; 완료 chunk 0, 최종 result 없음 | STT 완료 미검증 |
| 최초 지연 | 514초 이상 heartbeat 관찰 후 검사자가 종료; 모델 경로 선택은 있으나 가중치 로딩 성공 로그 없음 | 추론 실패·무한 대기·제품 UI 결함으로 원인 확정 금지 |
| `.venv` 순차 준비 | torch 2.11.0+cpu import 247.89초, 이후 faster-whisper→ctranslate2 converter→transformers/sympy 파일 읽기 stack; 서버 준비 전 11분 이상 대기 후 종료 | 라이브러리 초기화 지연으로 환경 차단 |
| 영상·생성·저장·내보내기 | fixture·실제 API 기반 검사 도구 준비; outputs 파일 0개 | 미실행 |
| Vite 브라우저 | 바로록 새 회의록 화면 표시. 최초 launch 시간 초과, 후속은 예전 heading selector 불일치; 현재 heading으로 검사 도구 수정 | 제품 실패 증거 아님; 실엔진 UI 흐름 미검증 |

- 환경: `.venv-desktop` torch 2.12.0+cpu/torchaudio 2.11.0+cpu, `.venv`는 둘 다 2.11.0+cpu였다. 로컬 torchaudio METADATA에는 Requires-Dist가 없어 요구 버전 위반을 확정하지 않는다. 버전 차이는 호환성 확인 대상이며 지연 원인으로 입증되지 않았다. 별도 메모리 관측은 69~73% 사용·8.29~9.61GB 여유였고 RAM 부족을 확정할 증거는 없다.
- 진단 한계: 90초 간격 `Timeout`은 launcher의 faulthandler stack 출력이며 API timeout/프로세스 종료가 아니다. `runtime.json`은 후속 `.venv`, health JSON은 최초 `.venv-desktop` 증거다. 경로 확인 문구와 STT 30%는 실제 가중치 로딩·추론 성공 증거가 아니다.
- agent는 표본/정답, 격리/endpoint, 저장/export 계약을 분담했다. 데이터 agent가 최종 로그·SSE·빈 outputs를 다시 읽고 결과 0건·후속 미검증 판정에 동의했다. 환경 agent가 버전 차이와 metadata의 한계를 확인했다.
- 증거: QA의 `evidence/engine-first-attempt.log`, `evidence/native_audio_20261017_sse.jsonl`, `evidence/api_health_get.json`, `evidence/source-sha256.json`, `engine.log`, `runtime.json`. launcher·request/UI·export 도구는 Git 제외 경로에 있다. `validate_exports.py`는 AST 구문 확인만 했으며 실제 export 통과가 아니다. 토큰 파일은 공유/출력하지 않는다.
- 재실행: 초기화 원인을 좁힌 뒤 같은 sample/model로 health→models status 완료→real analyze→generate-diarization→generate-summary→sync/export를 직렬 실행한다. launcher 명령은 `backend\.venv\Scripts\python.exe -X utf8 .tmp\native-model-audit-20261017\launch_engine.py`, 요청은 `.venv-desktop`의 같은 옵션으로 `run_audit.py analyze test4_30s.wav <새 job_id>`. Vite는 QA `ui`에서 `corepack pnpm dev --host 127.0.0.1 --port 5174 --strictPort`; `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`, TEMP/TMP는 QA temp다. API/UI 요청은 준비 완료 뒤 실행한다.
- 정리: 최초 PID 29560·후속 PID 31848과 검사 Vite/브라우저/비교 진단을 종료했다. 5174/17864/11475 LISTENING 없음, 기존 11434/PID 17392 유지를 확인했다. HF offline 변수를 사용했고 model download/pull·재설치·release build·commit/push는 실행하지 않았다. 후속과 종료 조건은 `todo.md`의 A4 큐다.

#### 웹 + 설치형 로컬 엔진 배포 준비 재점검 — 2026-10-18

- 범위: 웹 UI → Windows 로컬 엔진 설치·연결 → 모델·분석 → 기록 보존·내보내기 → 업데이트의 배포 준비 상태를 점검했다. 기준 HEAD는 `03702e5`와 기존 미커밋 변경이다. 제품 코드·기존 서버·실행 중 검사·모델은 변경하지 않았고 빌드·외부 배포도 실행하지 않았다.
- 문서보다 최신인 실모델 증거: `.tmp/native-model-audit-20261017`의 2026-10-18 산출물과 `engine-recovery-20261018.log`를 읽어 `test4_30s.wav`의 실제 STT 15개 구간, `portable_video_15s.mp4`의 2개 구간 및 두 작업의 참석자 구분 완료를 확인했다. WAV SSE는 `mode=real`, `status=completed`, 진행률 100이고, 두 참석자 구분 API 기록은 HTTP 200이다. 따라서 위 2026-10-17의 결과 0건은 당시 시도에 한정한다. 이번 점검이 새 추론을 실행한 것은 아니다.
- 증거의 한계: 확인 시 WAV 요약 상태는 `generating`, 영상은 `skipped`였다. TXT/MD/DOCX/HWPX 파일은 있지만 파일 존재만으로 요약 성공·최신 내용·브라우저 재열기·편집기 호환을 완료 처리하지 않는다. 사람 정답 대화록과 화자 정답이 없어 정확도도 미판정이다. 소스 Python 엔진의 결과이며 실제 설치/frozen/HTTPS 증거가 아니다.
- 연결·배포 경계: `MeetingWriter.tsx`의 설치·pairing 화면은 `VITE_LOCAL_ENGINE_CONNECTION_UI=true` 또는 개발 query gate 뒤에 있고, 현재 `<LocalEngineConnectionSurface />`에 `installerUrl`·`updateUrl`이 전달되지 않는다. 일반 웹 빌드만 올려서는 최초 사용자 설치 흐름이 연결되지 않는다. 실제 HTTPS origin, 서명된 설치 파일과 업데이트 manifest 배포 경로·버전 정책을 확정한 뒤 연결해야 한다.
- 설치 산출물: current-user NSIS 소스·preflight·staging/rollback·데이터 보존 테스트는 있다. builder는 `signed=false`, `distributionReady=false`의 PoC만 생성한다. 현재 PC에서는 기본 경로의 NSIS compiler 및 `releases/web-local-engine-poc/poc-manifest.json`, `releases/web-local-engine-installer-poc/installer-poc-manifest.json`이 없었다. 과거 frozen 검증을 현재 PC의 서명된 배포 후보나 install/update/uninstall 실물 성공으로 간주하지 않는다.
- 기록 보존: `meetingRepository.ts`의 회의·폴더 CRUD는 여전히 `MeetingHistoryDB` IndexedDB v2다. 브라우저 사이트 데이터 삭제·다른 브라우저에서도 같은 기록을 다시 읽는 엔진 SQLite 전환, revision·백업·가져오기 검증은 6단계 미완료다. backend 결과 JSON이 있어도 회의·폴더 전체의 복원 계약을 대신하지 않는다.
- 이번 집중 재검증: `corepack pnpm --dir desktop-app`의 `test:runtime-boundary`, `test:auth-recovery` 22개, `test:api-auth-boundary` 6개, `test:audio-playback-transport` 9개, `test:export-consistency` 9개와 `typecheck` 통과. `backend\.venv-desktop\Scripts\python.exe -B -X utf8 -m unittest backend.test_local_engine_security backend.test_authenticated_web_flow` 43개, 같은 interpreter의 `tests.test_web_local_engine_packaging tests.test_web_local_engine_verifier backend.test_web_local_engine_runtime backend.test_web_local_engine_installer_preflight` 47개 통과. API 검사는 추론 대역·임시 파일을 사용하며 설치 테스트는 실제 NSIS 설치가 아니다. Starlette/httpx 폐기 예정 경고는 남았다.
- 배포 판정: 일반 사용자 공개 준비는 미완료다. 다음은 A4 요약·저장/재열기·실제 파일 내용까지 닫기, 6단계 SQLite 기록 보존, 3C 서명된 설치/업데이트·다른 PC 데이터 보존, 실제 URL과 최초 연결 화면 연결, 8단계 HTTPS Chrome/Edge 설치부터 다운로드까지 통합 검증이다. 지원 사양·장시간 파일·조직 정책·비민감 진단은 기존 아래 release QA 위험 표를 유지한다.

#### 실행 환경 확인·실제 모델 전체 흐름 재검증 — 2026-10-18

- 결과: **같은 30초 WAV·15초 MP4의 실제 음성 인식(STT)→참석자 구분→요약→저장/재열기→현재 내용 내보내기를 확인했다.** 실행 경로는 복구됐으며 A4의 원음 정확도·요약 품질·설치/HTTPS 관문은 별도다. 이 점검은 현재 소스 Windows 엔진과 최신 UI 복사본을 사용했고 API mock은 없다.
- 변경 범위: 기존 정상 `backend\.venv-desktop`를 재사용하고 QA launcher·요청/브라우저/파일 검사 도구만 보강했다. 패키지 재설치·다운그레이드·전역 Python·기본 config·모델·제품/디자인 코드는 변경하지 않았다. 시작 HEAD `03702e5`; 실행 후 backend 6개 파일은 전날 SHA256과 같았고 주요 UI 6개 파일도 격리 snapshot과 현재 소스가 일치했다. 다른 AI의 배포 준비 기록은 유지한다.
- 초기화 조사: `.venv`의 faster-whisper→ctranslate2 converter→선택 의존성 Transformers 4.57.6이 `models` 하위 소스 전체를 직접 읽는 경로를 확인했다. `.venv-desktop`에는 이 선택 패키지가 없어 해당 순회를 피한다. 전날 torch 247.89초 지연은 오늘 재현되지 않았으며 그 근본 원인을 확정하지 않는다. bytecode 삭제나 전체 설치를 복구로 사용하지 않았다.
- 호환성 정정: [공식 TorchAudio 설치 문서](https://github.com/pytorch/audio/blob/main/docs/source/installation.rst)는 2.11의 stable ABI가 PyTorch 2.11 이후를 지원한다고 명시한다. `torch 2.12.0+cpu`/`torchaudio 2.11.0+cpu` 차이는 충돌이 아니다. torchaudio/torchcodec METADATA 4개는 RECORD 해시와 일치했고 조사한 중요 파일 누락은 없었다. 실제 단일 프로세스 import는 torch 7.469초, torchaudio 0.891초, faster-whisper 1.718초, pyannote 20.813초로 모두 완료됐다. 후속 엔진의 torch+faster-whisper 준비는 1.08초였다. 서로 다른 캐시/환경의 관측값이므로 성능 배수 비교로 사용하지 않는다.

| 실제 단계 | 30초 WAV | 15초 MP4 |
| --- | --- | --- |
| STT | `native_audio_20261018`, 15개 발언, SSE 완료 약 36.8초 | `b84c04bf-1f39-41b2-9b05-6f2b6e1a6e40`, 실제 UI 업로드·완료, 2개 발언 |
| 참석자 구분 | HTTP 200, applied true, 3개 모델 화자 ID, 13.703초 | HTTP 200, applied true, 1개 모델 화자 ID, 2.078초 |
| 요약 | gemma4:e2b 실제 응답·completed, 첫 로딩 포함 177.203초 | 같은 모델 실제 응답·completed, 후속 5.797초 |
| 저장/재열기 | 실제 recoverable 변환·upsert 후 같은 상세 열기→reload→같은 id/jobId/본문/요약/생성·구분 상태 보존 | 실제 UI 분석 저장/재열기 1차, 생성 후 같은 복구·보존 검사 2차 |
| 현재 내용 내보내기 | 재열기한 동일 record로 sync→전체 TXT/MD/DOCX/HWPX 4개 | 같은 경로 4개 |

- 결과 계약: 원본 STT 15개/2개 발언은 유지됐다. 표시 행은 같은 화자 병합으로 4개/1개다. 두 요약에 임시 transcript 추출 fallback은 없고 결정/할 일은 빈 배열이다. 실제 모델 근거는 `[LLM] ... gemma4:e2b` 로그와 전용 Ollama `/api/ps`의 tag/digest다. JSON의 legacy `settings.llm_model` 경로를 실제 모델 증거로 사용하지 않는다.
- 파일 검사: 두 실제 브라우저 기록을 읽어 제목/이름을 QA 값으로 덮지 않고 그대로 payload로 사용했다. sync 뒤 현재 제목·요약·대화록, 원본 `raw_stt_segments`·추론 설정 보존, export 때 저장 JSON bytes 불변을 확인했다. TXT/MD는 UTF-8, DOCX/HWPX는 CRC·필수 항목·XML, HWPX는 preview 일치를 검사했다. 8개 모두 현재 제목·요약·기대 발언을 포함한다. 이는 전체 텍스트 완전 동일성/추가 내용 부재 단언이나 UI 다운로드 버튼 검사가 아니다. 기본 GET TXT는 원래 대화록 전용이며 전체 TXT는 명시적 full payload로 검사했다.
- 검사 도구 보정: 최초 WAV 도구는 완료 result 뒤 `[DONE]`를 JSON으로 읽어 종료했지만 실제 STT는 이미 저장됐다. 종료 신호 처리를 고치고 기존 실제 결과로 후속을 진행했다. 파일 도구의 기본 GET TXT 제목 기대도 실제 `export_txt`의 대화록 전용 계약에 맞췄으며 full TXT 제목/요약 검사는 유지했다. 최종 파일 검사와 두 browser 모드는 통과했다.
- 메모리/재시작: 두 STT/구분 뒤 남은 RAM 7.25GB/31.11GB(76% 사용)에서, 모델 파일 약 7.2GB의 첫 요약을 앞두고 **검사 엔진만** PID 19236→36896으로 같은 폴더/명령/17864 포트에서 재시작했다. 여유 RAM 11.15GB(64%)를 확보했고 두 저장 작업이 유지됐다. 요약 중 관측은 4.15GB 여유(86%)였다. 따라서 중간 재시작을 포함한 실제 흐름이며 단일 프로세스의 모든 모델 최대 동시 상주/긴 파일 성능을 입증하지 않는다.
- 발견 P2: (1) 뒤 발언의 `speaker_needs_review`/`short_speaker_overlap`가 표시 병합에서 빠지고 `segments_for_ui`에서도 전달되지 않는다. 실제 WAV 마지막 겹침 구간에서 확인했다. (2) WAV 주제 `민준의 외모와 성격` 중 성격 평가는 불명확한 다른 대상을 가리킬 수 있어 인물 귀속 근거가 부족하다. 생성 제목에는 QA 입력의 목적이 반영됐다. 실행 환경 복구 범위를 지켜 제품 소스는 수정하지 않았고 두 후속을 TODO에 남겼다. 사용자 제목 보존 자체를 결함으로 분류하지 않는다.
- 한계: 사람 정답/확정 화자 수가 없어 음성·화자 정확도를 통과시키지 않는다. TorchCodec 내장 파일 디코더/DLL 경고는 남았지만 현재 pyannote의 메모리 waveform 입력은 성공했다. 모든 native 경로가 정상이라는 뜻은 아니다. 일반 Chromium의 native bootstrap adapter는 재생 metadata GET 401을 발생시켰다(HEAD는 인증 client로 200). 재생·실제 Tauri·HTTPS pairing 판정에는 사용하지 않는다. 사용자 이름 변경/해제, Word/한컴에서 실제 열기, 설치 엔진/frozen 검증도 이번 통과 범위 밖이다.
- agent 재검토: 환경/패키지·실제 결과/요약·브라우저 경로를 분담했다. 파일 agent는 실제 8개와 동일 record의 저장/복원 계약을 재검토해 추가 차단 없음으로 판정했다. 요약 귀속과 불확실성 표시 P2는 별도로 유지했다.
- 증거는 `.tmp/native-model-audit-20261017/evidence/recovery-20261018/`의 `desktop-imports.log`, `ui-source-provenance.json`, `runtime-stt-phase.json`, `runtime-summary-phase.json`, `ollama-actual-model.json`, 메모리 snapshot과 `upload-video-2026-10-17T15-21-01-427Z-26612/manifest.json`, `recover-jobs-2026-10-17T15-27-12-386Z-19880/manifest.json`, `browser-records-20261017T152825Z/report.json`이다. 이름의 `2026-10-17T15...Z`는 UTC이며 한국 실행 날짜는 18일이다. 실제 8개 파일은 QA `downloads/browser-records-20261017T152825Z/`, 실제 모델 로그는 `engine-recovery-20261018.log`에 보존했다. 토큰은 출력/공유하지 않는다.
- 재실행: repo root에서 `backend\.venv-desktop\Scripts\python.exe -X utf8 .tmp\native-model-audit-20261017\launch_engine.py`; 준비 후 같은 interpreter로 `run_audit.py analyze test4_30s.wav <새 job_id>`, `diarization <job_id>`, `summary <job_id>`. UI는 QA `ui-recovery-20261018`에서 `corepack pnpm dev --host 127.0.0.1 --port 5174 --strictPort`, `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`와 QA temp의 TEMP/TMP를 지정해 `corepack pnpm exec node audit-recovery.mjs upload-video` 또는 `recover-jobs <job_id...>`를 실행한다. 생성된 manifest를 `export_browser_records.py`에 전달한다. 모두 실제 API를 사용한다.
- 정리: 검사 엔진 PID 36896·전용 Ollama PID 39596/runner 42140·Vite PID 26288과 브라우저를 종료했다. 5174/17864/11475 LISTENING 없음, 원래 system Ollama 11434/PID 17392 유지를 확인했다. 종료 후 여유 RAM은 13.86GB(55% 사용)였다. 빌드·모델 받기·commit/push는 실행하지 않았다.

### 2026-10-18 화자 검토 표시·요약 인물 귀속 수정과 동일 표본 재검증

- 범위: 앞서 발견한 P2 두 건의 backend 수정과 집중 회귀다. 제품 frontend·CSS·레이아웃은 수정하지 않았다. 다른 AI의 변경을 보존하고 현재 UI 복사본 `ui-speaker-summary-fixes-20261018`에서 별도 Vite cache와 5174 포트를 사용했다. 소스 엔진은 기존 `.venv-desktop`, 격리 config/output, 17864 API·11475 app-managed Ollama를 재사용했다. 패키지·모델·전처리 설정은 바꾸지 않았다.
- 표시 수정: `transcript_display.py`는 5종 검토 flag의 camel/snake 입력을 정규화하고 같은 화자의 발언 병합에서 OR로 보존한다. `main.py`는 화면 응답과 저장 요청 양쪽으로 전달한다. 원본을 변경하거나 다른 화자에게 표시를 퍼뜨리지 않는다. 화면에는 기존 `참석자 확인 필요` badge를 그대로 사용한다.
- 요약 수정: 발언자와 평가 대상을 구분하고, 근처 이름·앞뒤 발언만으로 대상이 확정되지 않으면 특정인에게 연결하지 않도록 제목/주제/본문 공통 지시를 보강했다. 명시적인 이름은 유지한다. 장문 부분 요약의 `needs_check`는 최종 병합에서 누락되어도 중복 없이 보존한다. 특정 이름 하드코딩·추가 추론 호출은 없다.
- 집중 검증: `backend\.venv-desktop\Scripts\python.exe -B -X utf8 -m unittest tests.test_transcript_display backend.test_authenticated_web_flow` 21개, 같은 interpreter의 `-m unittest discover -s tests -p test_summarize_followups.py` 16개 통과. 초기 분할 테스트는 기본 인수에 고정된 chunk 크기 때문에 기대 3회 대신 2회가 되어 fixture를 실제 분할 함수의 명시적 크기 호출로 수정했다. 부분 병합의 정상/빈 결과/확인 사항 누락·중복·다른 회의로의 누출, 명시 이름·GGUF 경로도 검사했다. mock 결과는 모델 의미 정확도의 증거와 구분한다. 구현 후 독립 agent 검토에서 현재 범위의 차단 사항은 없었다.

| 같은 실제 입력 | 대화록·구분 결과 | 수정 후 표시·요약 |
|---|---|---|
| `test4_30s.wav` 30초 | STT 15개/표시 4행, 원본 검토 3곳 | 표시 검토 2→3행, 화면 최초/reload/sync 후 복원 모두 badge 3개. 요약은 `혜원의 그림 실력`, `민준의 외모`; 불명확한 성격 평가는 채택하지 않음 |
| `portable_video_15s.mp4` 15초 | STT 2개/표시 1행 | 검토 badge 0개 유지. 업체 6곳과 제공 기간을 STT 원문에 맞춰 요약 |

- 실제 새 job은 WAV `native_audio_fix_20261018`, 영상 `4610f322-9fd3-4a39-912c-f68e6a3ac3ed`다. 영상은 실제 UI 파일 업로드·분석·저장·재열기를 거쳤다. 독립 agent가 동기화 전 보존한 이전 JSON과 비교해 두 입력 fingerprint, raw STT/정렬/표시 본문·순서·시각·화자 매핑이 같음을 확인했다. WAV 마지막 21.98~29.40초 표시 행의 `speaker_needs_review`·`short_speaker_overlap`이 복구됐다. 기존 outputs는 이전 sync로 표현 시각과 표시 정보가 달라져 있어 원본 비교 기준으로 쓰지 않았다.
- 실제 모델은 `/api/ps`의 `gemma4:e2b`와 digest `7fbdbf8f5e45a75bb122155ed546e765b4d9c53a1285f62fd9f506baa1c5a47e`로 확인했다. WAV 요약 129.313초(첫 로딩 포함), 영상 1.656초에 completed다. 두 결과의 `actions`·`decisions`는 비어 있다. WAV는 불명확한 평가 자체를 요약에 넣지 않아 `needs_check`도 비어 있다. 모든 발언을 요약에 강제로 포함하는 요구가 아니며, 이 표본에서는 기존의 잘못된 귀속이 재현되지 않았다. 독립 agent가 원문과 대조했다.
- 저장/화면: 저장 JSON→recoverable API→실제 repository의 IndexedDB record에서 segment별 5종 flag 배열을 비교했다. 상세 열기/reload의 badge 수와 전체 record 내용·생성 상태가 유지됐다. 이후 실제 record payload를 sync한 뒤 다시 API 복원→저장→상세/reload를 반복해 3개/0개 표시와 요약 보존을 확인했다.
- 내보내기: 같은 실제 브라우저 record로 full TXT/MD/DOCX/HWPX 8개를 생성했다. 최신 제목/요약/발언과 UTF-8·ZIP/XML·HWPX preview, 저장 flag/원본 STT/설정/요약 확인 사항 보존, export 전후 JSON 불변을 확인했다. 파일은 QA `downloads/fixed-browser-records-20261017T155020Z/`에 있다.
- 증거: QA `evidence/speaker-summary-fixes-20261018/` 아래 `upload-video-2026-10-17T15-45-11-526Z-20196/manifest.json`, `recover-jobs-2026-10-17T15-49-45-860Z-46004/manifest.json`, sync 후 `recover-jobs-2026-10-17T15-50-32-887Z-27472/manifest.json`, `fixed-browser-records-20261017T155020Z/report.json`, `ollama-loaded-model.json`. 기록 이름은 UTC이며 한국 실행일은 18일이다. native 로그는 `engine-speaker-summary-fixes-20261018.log`다.
- 재실행: repo root에서 같은 interpreter로 `.tmp\native-model-audit-20261017\launch_fixes.py`, `run_audit.py analyze test4_30s.wav <새 job_id>`와 `diarization/summary <job_id>`를 실행한다. snapshot에서 `corepack pnpm dev --host 127.0.0.1 --port 5174 --strictPort`; `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`, TEMP/TMP=QA temp로 `corepack pnpm exec node audit-fixes.mjs upload-video` 및 `recover-jobs <job_id...>`. 통과 manifest를 `export_fixed_records.py`에 전달한다. 원본 결과/과거 증거는 덮어쓰지 않는다.
- 한계: 사람 정답 기반 STT/화자 품질이나 모든 입력의 인물 귀속 정확도를 보장하지 않는다. 장문 병합은 집중 mock 검사이며 실제 장문 성능 검증은 아니다. Vite+소스 Windows 엔진 증거로, 실제 설치/frozen/HTTPS·Tauri·Word/한컴 렌더링 관문은 기존 QA 표에 열린 상태로 유지한다. TorchCodec 내장 디코더 경고와 native bootstrap adapter의 audio GET 401은 앞선 한계와 같다. 요약 전 검사 엔진 PID 11156만 종료해 모델 캐시를 회수하고 같은 명령/폴더/포트로 PID 31612를 복구했다. 단일 프로세스 최대 모델 동시 상주 검증은 아니다.
- 정리: 검사 Vite PID 7120·엔진 PID 31612·전용 Ollama PID 28928/runner 12036을 종료했다. loopback 연결 검사에서 5174/17864/11475 닫힘, 기존 system Ollama 11434/PID 17392 유지 확인. 브라우저는 각 helper의 finally에서 닫았다. 종료 후 여유 RAM 8.97GB(71% 사용)는 다른 작업을 포함한 관측값이다. 빌드·commit·push는 실행하지 않았다.

### 2026-10-18 설치형 로컬 엔진·HTTPS 실환경 진입 점검 — 준비 차단

- 요청: 같은 30초 WAV·15초 MP4로 실제 설치 엔진과 HTTPS 웹에서 분석→참석자 구분→요약→저장/재열기→실제 다운로드를 agent로 점검한다. 이전 Vite+소스 Python 통과와 구분한다. 디자인·제품 소스 변경, 다른 작업 서버 종료, 외부 배포는 하지 않았다.
- 사용자에게 배포 URL/설치 경로를 확인했으나 사용자는 별도 주소를 알지 못하며 이 프로젝트를 대상으로 지시한 것임을 확인했다. 저장소·기본 설치 경로·등록 정보·연결된 브라우저 목록을 조사했지만 실제 대상을 확보하지 못했다. 따라서 URL을 사용자가 이미 알고 있어야 한다고 가정하지 않고, 프로젝트의 실환경 준비 작업으로 분류한다.

| 실물 진입 조건 | 직접 확인한 상태 | 검사 재개에 필요한 증거 |
|---|---|---|
| Windows 설치 엔진 | `%LOCALAPPDATA%\Programs\Barorok\LocalEngine` 및 data 경로 없음, HKCU uninstall native/32bit 등록 없음, 기본 `127.0.0.1:17863` 연결 불가 | 설치 실행 파일·버전·payload hash, 실제 backend/data/output 경로, probe/health 응답 |
| 설치용 산출물·도구 | `releases/web-local-engine-poc`·manifest·installer-poc 폴더 없음. `makensis.exe`는 PATH·표준 NSIS 위치에 없음 | 신뢰할 Windows NSIS와 현재 변경을 포함하는 frozen/installer 검사본; 설치 payload hash와 빌드 당시 소스 hash 연결 |
| 실제 HTTPS 웹·연결 설정 | 저장소의 `https://minutes.example`는 예시이며 운영 origin·배포/설치 URL은 미정. production 연결 UI는 `VITE_LOCAL_ENGINE_CONNECTION_UI=true`가 필요하고 호출부는 installerUrl/updateUrl을 전달하지 않음 | 실제 HTTPS 검사 주소, 그 주소와 정확히 일치하는 엔진 허용 origin, 연결 UI가 켜진 배포 빌드와 검사본 설치 경로 |

- 직접 실행: `backend\.venv-desktop\Scripts\python.exe -B -X utf8 scripts\verify_web_local_engine_poc.py releases\web-local-engine-poc --manifest-only`는 exit 1, `Frozen engine executable not found`다. 이 검사는 설치/엔진 실행 전 파일 확인에서 종료됐다. 새 QA `.tmp/installed-https-audit-20261018/preflight.py`가 같은 명령·설치 경로/registry/compiler/포트 관측·현재 backend 소스 SHA256을 `preflight.json`에 저장했다. 보고 스크립트 자체 exit 0은 준비 통과라는 뜻이 아니며 상태는 `blocked_prerequisites`다.
- 실행 결과: **이번 설치형/HTTPS 표본 분석은 0건**이다. 저장·재열기·실제 UI 다운로드도 미실행이며 앞선 소스 검사 통과를 이 관문에 재사용하지 않았다. 남은 `releases/lmo_audio`는 별도 Tauri 포터블 형태이고 manifest는 과거 `7cb39ac...`를 가리켜 이번 설치형 대상 또는 최신 수정 증거로 쓰지 않았다. 제품 기능 실패로 판정할 실행 결과도 아직 없다.
- agent 검토: 실행 환경 agent는 설치/registry/산출물/NSIS 부재, 웹 agent는 운영 URL·연결 UI 설정/CTA, 데이터 agent는 pairing과 기록/다운로드 증거 계약을 독립 확인했다. 기존 QA helper의 `__TAURI__` adapter·desktop action token·Vite `/src` import·API 직접 export는 실환경 인증/다운로드 검사에 그대로 사용할 수 없다. 파일 bytes의 UTF-8·본문·ZIP/XML 검사 함수만 재사용한다.
- 후속 순서: (1) HTTPS 검사 호스팅/origin과 Windows 내부 QA 버전을 정한다. (2) Windows NSIS 도구를 준비하고 `build_web_local_engine_poc.ps1 -Origin <실제HTTPSorigin> -EngineVersion <검사버전>` → manifest/frozen verifier → `build_web_local_engine_installer_poc.ps1`로 검사본을 만든다. installer 스크립트가 helper도 빌드하므로 중복 빌드하지 않는다. unsigned PoC는 내부 검사 범위이며 외부 사용자 배포 완료와 구분한다. (3) 실제 current-user 설치와 모델/runtime 경로를 준비한다. (4) HTTPS 웹의 실제 Chrome/Edge에서 로컬 네트워크 접근과 helper 코드로 pairing한다. (5) 같은 두 입력의 새 job으로 전체 흐름을 직렬 실행한다.
- 종료 조건: 실행 파일 경로·버전/hash·허용 origin과 `/api/health.backend_dir`/`output_dir`, 브라우저가 실제 보내는 Origin·Bearer 인증, SSE/outputs/`MeetingRecord.jobId` 일치를 연결해 기록한다. 동일 HTTPS origin에서 저장/reload/재열기 후 본문·요약·화자 검토 표시·생성 상태를 비교하고, UI에서 full TXT/MD/DOCX/HWPX 8개의 실제 다운로드 이벤트와 파일 내용을 확인한다. 메모리 세션의 reload 후 재pairing과 저장 기록 보존은 별도로 판정한다. MD/DOCX/HWPX 실패 뒤 TXT fallback이면 해당 형식 통과로 처리하지 않는다. 웹 save-copy의 예상 403 뒤 정상 다운로드와 실제 실패도 구분한다.
- 남은 관문은 아래 기존 릴리스 위험 표의 frozen·실제 HTTPS 접근·다운로드/설치 행에 갱신했다. 기능 회귀 mock·개발 서버·임의 도메인·localhost TLS로 이 검사를 대체하지 않았다. 제품/디자인 파일, 사용자 데이터, 전역 도구, 원래 서버를 변경하지 않았으며 빌드·설치·배포·commit/push는 하지 않았다.

#### 후속: 검사 도구·실제 설치 r1·loopback TLS 전체 흐름 — 2026-10-18

- 위 준비 차단 이후 사용자가 검사 도구·웹·설치 검사본 준비와 같은 두 표본의 재검증을 승인했다. 공식 NSIS 3.13 ZIP의 SHA256을 확인해 프로젝트 `.tmp/installed-https-audit-20261018/tools`에 준비했으며 전역 설치·PATH 변경은 하지 않았다. 현재 기능 수정과 경로 재확정 수정을 포함한 frozen `0.1.1-qa-20261018` 및 unsigned installer를 만들었다. manifest는 4,956개 파일을 연결하며 `signed=false`, `distributionReady=false`다.
- 실제 `0.1.0-qa-20261018` 첫 설치는 HTTP 200이어도 데이터 생성 전후 AppData 경로의 mutex 식별자가 달라 준비 helper exit 3·등록 미완료였다. 데이터 생성 후 재시작은 helper exit 0을 확인했다. 데이터 준비 후 최종 경로를 다시 확정한 r1은 새 데이터·중단된 설치 복구 실행에서 installer exit 0, 등록 버전 `0.1.1-qa-20261018`, pending marker 없음으로 통과했다. 대상별 sidecar 정리와 NSIS 명령 위치·UTF-8 입력 수정도 포함하며 상세 시행착오는 `docs/tauri-desktop-release-checklist.md` 기존 12·13절에 기록했다.
- full frozen smoke는 통과했다. host/installer preflight, 닫힌 manifest·읽기 전용 payload, ffmpeg·loopback·기본 거부, 단일 실행, pairing 만료/재사용/경합, startup-safe stop, 고정 포트 충돌·자체/외부 프로세스 구분, relocation 보존을 확인했다. 실행 중 엔진의 installer preflight `warning`은 로그에 구분한다. 이 smoke는 실제 모델 분석 성공이나 실모델 처리 후 정상 종료를 뜻하지 않는다.
- Cloudflare 임시 공개는 자동 승인 검토가 명시적인 공개 승인을 요구해 거부했고 사용자 답변 대기다. 우선 `https://127.0.0.1:5443`에 TLS 웹을 준비하고 동일 origin을 엔진 설정/manifest에 연결했다. 검사 브라우저에만 QA 전용 공개키 지문 예외(SPKI pin)를 적용하며 OS 신뢰 저장소는 변경하지 않는다. 공개 HTTPS 배포·원격 origin에서 loopback 접근·Chrome/Edge Local Network Access·다른 PC·서명 관문은 통과하지 않았다.
- 실모델 UI 진행 중 P2를 확인했다. 최초 401 이후 기록 상세(History)의 요약 버튼 1개가 `enabled=false`로 남았지만 실제 `/api/models/status`는 `managed_stopped`·`can_auto_start=true`·`managed_runtime_available=true`였다. 15초 대기 점검을 포함해 설정 열기→모델 상태 읽기 완료→닫기 조작 후 `enabled=true`로 회복했다. 회복 조작 중 설정값 변경·모델 다운로드·요약 POST는 0건이다. 확정된 결함은 UI 상태 불일치와 정상 설정 조작에 의한 회복이며, 인증 전환 후 준비 상태 동기화 누락은 원인 후보다. 제품 UI/디자인 소스는 수정하지 않고 `todo.md`에 후속 1건으로 올렸다. 증거는 QA `evidence/inspect-2026-10-17T16-49-54-000Z-34812/{readiness-recovery.json,inspect-after-settings-close.json}`이다. 이 회복 후 아래 UI 검사를 통과했지만 제품 P2가 해결된 것은 아니다. 설정 HTTP 응답 직후 닫아 mounted guard가 상태 반영을 취소했던 별도 QA 경합은 helper의 상태 읽기 완료 대기를 보강해 해소했으며 제품 결함과 구분한다.
- 최종 결과: **설정 상태 읽기·닫기 회복 조치를 거친 뒤 실제 설치 r1의 두 표본에서 STT 결과→참석자 구분→실제 요약→저장/reload·재열기→UI 다운로드를 통과했다.** 화면이 보이는 bundled Chromium, native helper pairing, `https://127.0.0.1:5443`→`http://127.0.0.1:17863` 조합이다. 오디오는 최초 UI 시도에서 생성한 설치형 job을 재분석 없이 이어갔다. 앞선 Vite+소스 Python 결과를 설치형 결과로 대체하지 않았다.

| 설치형 표본·job | 원본/표시 구간 | 참석자 구분·요약 | reload 전→후 검토 표시 | 실제 UI 다운로드 |
|---|---|---|---|---|
| 30초 WAV `242fe28a-0abf-4c80-ae7e-b9c39de13090` | 15 / 4 | `diarizationApplied=true`·`completed` | 3 → 3 | 4개 |
| 15초 MP4 `c918b095-c22e-4bd6-8e71-0397eb94c4c5` | 2 / 1 | `diarizationApplied=true`·`completed` | 0 → 0 | 4개 |

- 저장·파일 증거: 두 기록의 reload 전후 JSON bytes가 동일했다. 실제 다운로드는 TXT 대화록 2개와 정리 내용 MD·DOCX·HWPX 각 2개, 총 8개다. 크기·SHA256·MIME·본문·ZIP CRC·전체 XML 파싱·HWPX preview 대조를 통과했다. `save-copy` 403 뒤 export 200은 의도된 웹 fallback이며 실패나 TXT 대체로 판정하지 않는다. 검사 네트워크 위반 0건·page error 0건이며 선택적 외부 font 자산 3개 차단은 별도로 기록했다.
- 요약 품질: 이번 WAV는 불명확한 성격 평가를 주제에서 생략해 민준에게 귀속했던 오류가 재발하지 않았고, 두 표본의 `actions`·`decisions`는 빈 목록이었다. 이는 해당 두 표본의 대화록 대조 결과이며 사람 원음 정답, 모든 입력의 인물 귀속, 모든 불명확 내용 보존을 보장하지 않는다.
- 종료 P2: 두 실모델 작업 완료 후 `--stop` CLI exit 0은 종료 요청 접수였고 엔진 PID 44876은 15초 종료 대기 실패 뒤 최소 96초 이상 남았다. `Shutting down`은 기록됐지만 application shutdown complete는 없었고, 17863 포트가 닫혀도 프로세스와 약 4.27GB 메모리가 남았다. `server.run` 반환 전 mutex/atexit 정리가 끝나지 않는 구조이며 Uvicorn connection/transport/`wait_closed` 대기는 원인 후보일 뿐 stack이 없어 근본 원인은 미확정이다. generation-progress는 일반 JSON이므로 무한 SSE로 단정하지 않는다. 실제 모델 처리 뒤 제한 시간 내 종료·포트/mutex/자체 Ollama 해제·데이터 보존과 업데이트 전 stop 복구를 확인할 후속 P2를 `todo.md`에 추가했다. startup-safe stop 통과와 구분한다.
- 변경·검증: 빌드 대상별 정리, NSIS 명령 위치·UTF-8 입력, 데이터 생성 뒤 runtime 경로 재확정만 필수 수정했고 디자인/UI 제품 소스는 수정하지 않았다. backend/frontend 독립 agent 2명이 최종 증거를 검토해 통과했다. 변경 영역 소스 검사는 합산 22개다. backend 작업 디렉터리에서 `.venv-desktop\Scripts\python.exe -B -X utf8 -m unittest test_web_local_engine_runtime test_local_engine_preflight.LocalEnginePreflightTest.test_server_preflight_finishes_before_settings_data_or_engine_start test_local_engine_preflight.LocalEnginePreflightTest.test_server_installer_preflight_uses_canonical_targets_before_startup` 17개와 저장소 루트에서 `backend\.venv-desktop\Scripts\python.exe -B -X utf8 -m unittest tests.test_web_local_engine_packaging` 5개를 각각 통과했다. 이는 NSIS 실제 컴파일·설치 복구·full frozen smoke·실모델 UI 증거와 함께 판정하며, 22개 자체가 실물 검증을 대신하지 않는다.
- 한계: 기존 로컬 모델을 재사용했으므로 일반 사용자의 최초 모델 다운로드·준비, 공개 HTTPS에서의 로컬 네트워크 접근, Chrome/Edge 승인·거부·재승인·조직 정책, 다른 PC·서명, Word/한컴 직접 열기는 여전히 미검증이다. 이번 UI 검사에는 음성 재생/탐색과 주제·참석자 요약·보고서 생성도 포함하지 않았다. frozen의 TorchCodec·`tbb12.dll` 경고는 시험한 WAV/MP4의 메모리 waveform 경로를 막지 않았지만 범용 디코더 정상의 증거는 아니다.
- 증거·보존: `.tmp/installed-https-audit-20261018/final-evidence-summary.json`, 같은 QA 폴더의 `evidence/resume-2026-10-17T16-53-06-831Z-32716/{manifest.json,network.json,*-rendered.json,*-record-before-reload.json,*-record-after-reload.json,downloads/*}`와 r1 provenance·`frozen-smoke-r1.log`를 보관한다. 정상 종료 잔류 후 이 세션 소유 엔진 44876, managed Ollama 36488·35032, static/TLS 2056·33356만 강제 정리했으며 `shutdown-result.json`의 `ownedProcessIdsRemaining=[]`를 확인했다. 기존 system Ollama 17392, 설치본·두 기록·다운로드 8개는 보존했다. 강제 정리 후에도 backend 결과 2개의 jobId·overview가 저장된 frontend 기록과 일치하고 8개 다운로드의 크기/SHA256이 manifest와 같은 것을 확인했다. 최종 요약은 `overallQaStatus=findings_open`, known issue 2건, `postShutdownDownloadHashesAndBackendSummariesVerified=true`다. `shutdown-delay.json`·`shutdown-result.json`에 실패와 정리를 분리했고, 같은 QA 폴더의 `restart_inspection.ps1`에 복원 명령을 보관한다. OS trust 변경은 없다.

#### 후속: 실제 설치 r2의 인증 후 요약 수정·두 표본 재검증·종료 잔류 — 2026-10-18

- 인증 후 요약 P2 수정: `MeetingHistory.tsx`가 기존 연결 context의 인증 상태를 구독하고 준비 상태 조회 effect를 재실행하도록 기능 코드 3줄만 연결했다. 이전 인증 시점의 응답은 기존 effect 취소 가드로 무시하며 마크업·문구·CSS는 바꾸지 않았다. 최초 미인증 401→실제 pairing UI 성공→`managed_stopped`·자동 시작 가능 응답→설정/포커스 조작 없이 요약 버튼 활성화 집중 회귀는 수정 전 실패·수정 후 통과했고 typecheck·변경 lint도 통과했다. 이번 runtime 집중 22개와 새 frontend 회귀는 앞선 r1의 17+5=22개와 별개의 검사 결과이며 중복 합산하지 않는다.
- 설치·기본 smoke: `0.1.2-qa-20261018` frozen/installer로 기존 데이터를 유지한 실제 업데이트를 수행했다. `installation.json`은 57.1466초·installer exit 0·등록 버전 일치·pending marker 없음이며 `frozen-smoke.log`의 Stage 3B 기본 smoke도 통과했다. 이 기본 smoke와 실모델 전체 흐름·실모델 후 종료 판정은 각각 별도 증거다.
- 실제 UI: 현재 UI 원본 61개 파일을 별도 snapshot에 복사하고 복사본에서 `build:web`를 실행했다. 과거 r1 증거는 덮어쓰지 않았다. 새 QA 브라우저 프로필 `audit-2026-10-17T22-09-11-723Z-34640`에서 같은 30초 WAV·15초 MP4를 모두 새 작업으로 처리했다. `https://127.0.0.1:5443`과 실제 설치 엔진을 연결했고 설정 열기/닫기 회복 옵션 없이 `readinessRecovery=[]`로 STT→참석자 구분→실제 요약→저장/reload·재열기→8개 다운로드를 통과했다. r1의 수동 회복 후 통과와 구분해 인증 후 요약 P2를 완료 처리한다.

| 설치 r2 표본·job | 원본/표시 구간 | 구분·요약 | reload 전→후 검토 표시 | 실제 UI 다운로드 |
|---|---|---|---|---|
| WAV `5511a26f-e366-4eab-bc06-cfbfca0009fb` | 15 / 4 | `diarizationApplied=true`·`completed` | 3 → 3 | 4개 |
| MP4 `c3c36b46-d4f9-4b67-b510-2b493695f38d` | 2 / 1 | `diarizationApplied=true`·`completed` | 0 → 0 | 4개 |

- 저장·범위: 실제 UI 파일은 TXT 대화록 2개·정리 MD/DOCX/HWPX 각 2개다. network 위반·page error는 0건이며 `manifest.json`·각 `*-rendered.json`에 기록했다. 종료 전후 `preserved-before-stop.json`·`preserved-after-stop.json`의 13개 저장 증거/결과/다운로드 파일 hash 대조도 통과했다. 이 대조의 `recordFile`은 종료 전 브라우저에서 저장한 증거 파일이며, 종료 후 새 브라우저에서 IndexedDB를 다시 읽었다는 증거로 확대하지 않는다.
- 종료 P2는 유지한다. `shutdown-result.json`에서 stop ACK는 exit 0·0.682초, 엔진 본체 34064는 약 1.964초 내 사라졌고 17863 포트와 mutex도 해제됐다. 하지만 자체 managed Ollama가 띄운 runner 8776과 그 conhost 15460은 남았고 당시 약 5.6GB 상주를 관측했다. `ownedProcessIdsRemaining=[8776,15460]`, `passed=false`, `forcedCleanupUsed=false`이며 foreign Ollama 36096은 보존됐다. 본체·managed Ollama 부모·부모 conhost 소멸을 전체 하위 프로세스 소멸로 취급하지 않는다. `engineExitCode:null`은 종료 뒤 `Get-Process`로 exit code를 관측하지 못한 결과여서 성공 0으로 기록하지 않는다. own 하위 프로세스 전체 정리 수정은 진행 중이고 이 r2 결과로 완료 처리하지 않는다.
- 최신 증거 루트는 `.tmp/remaining-fixes-20261018`이다. `installation.json`, `frozen-smoke.log`, `web-source-provenance.json`, `evidence/audit-2026-10-17T22-09-11-723Z-34640/{manifest.json,network.json,*-rendered.json,*-record-before-reload.json,*-record-after-reload.json,downloads/*}`, `preserved-before-stop.json`, `shutdown-result.json`, `preserved-after-stop.json`을 함께 본다. 공개 HTTPS·원격 origin→loopback/LNA·Word/한컴 직접 열기·소비자 최초 모델 준비·다른 PC·서명은 여전히 미검증이며 A5/A6 전체 출시 완료가 아니다.

#### 후속: r3 종료 수정·설치 파일 준비 후 사용자 요청으로 일시 중지 — 2026-10-18

- `windows_process_job.py`와 `ollama_utils.py`에 소유한 Windows 하위 프로세스 묶음만 정리하는 처리를 추가했다. 일시 정지 상태로 실행한 뒤 전용 Job에 편입하고, 단일 초기 thread의 소유 PID를 확인한 후 재개한다. 부모가 먼저 끝나도 저장한 Job으로 자식·손자를 정리하며 외부 Ollama는 편입하지 않는다. 실제 Windows 잔류 RED→GREEN, 집중 25개와 독립 검토를 통과했다.
- 별도 실제 설치 경로의 Ollama에서 기존 `gemma4:e2b`를 빈 입력으로 적재한 뒤 소유 프로세스 4개가 모두 0.328초에 종료됐다. 첫 단독 진단의 로그 없는 exit -1은 원인 미확정으로 남기고, 실제 설치 경로·native 시작 로그·Job 구성원/프로세스 handle 추적을 추가한 후속 결과로 판정했다. 사용자 음성은 이 단독 진단에 사용하지 않았다.
- `0.1.3-qa-20261018`의 전체 frozen Stage 3B 기본 검사와 NSIS 설치 파일 제작이 완료됐다. 설치 파일은 `releases/web-local-engine-installer-poc/Barorok-Local-Engine-Setup-0.1.3-qa-20261018.exe`, 442,775,495 bytes, SHA256 `e34734381aa969b427ec80af90f27c5769af48f106a1ff826595d6f346cf89c6`이며 `signed=false`, `distributionReady=false`인 검사본이다.
- 사용자가 설치 파일 완성까지만 진행한 뒤 잠시 멈추도록 요청했다. 따라서 **r3 설치·동일 음성/영상 전체 처리·설치본 종료/재시작은 미실행**이며, 현재 설치 버전은 r2인 `0.1.2-qa-20261018`이다. 정상 종료 P2는 이 설치본 검증 전까지 유지한다. 검사 소유 HTTPS 서버 32588을 종료했고 5443/17863 포트가 비었으며 외부 Ollama 36096은 보존했다. 원래 작업 폴더·복원 명령과 재개 경계는 `.tmp/remaining-fixes-20261018-r3/user-pause-state.json`에 기록했다. 공개 HTTPS/LNA와 다른 출시 관문의 미검증 상태도 유지한다.
- 준비 증거는 `.tmp/remaining-fixes-20261018-r3/{native-owned-job-probe.json,native-owned-job-probe.log,native-ollama-diagnostic.log,frozen-smoke.log,frozen-build-r1-provenance.json,installer-r1-provenance.json,user-pause-state.json}`이다. 마크업·문구·CSS 변경 없이 기능 코드와 검사 환경만 수정했다.

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
| frozen payload의 실제 STT·화자 구분 분석 | 설치QA1.6·HTTPS 60/120분 실처리와 QA1.7 요약 재생성 통과; 요약 의미 품질 P2·범용 디코더 열림 | 설치된 실제 모델과 대표 입력으로 분석→저장→내보내기 확인; torchcodec·`tbb12.dll` 경고의 범용 디코더 영향과 다른 PC 확인. 요약 전반/중반/후반 주제 포괄·결정/논의 구분은 todo의 의미 품질 P2로 관리 | 대표 입력 성공과 native dependency 영향 해소, 요약 품질 P2 종료 근거 확보. 시험한 waveform 경로를 범용 지원으로 확대하지 않음 | 2026-10-19 QA HTTPS+실제 설치1.6에서60/120분 UI 업로드·중지/재개·STT120/240청크·구분·저장/재열기·4종 파일 확인. 빈 요약 정상 완료 결함은3fdbdcd/31개 회귀 후 설치QA1.7의 동일120분 대화록으로 실제 요약1회/모델11호출 성공. 그러나 후반 AI 주제 누락·논의를 결정으로 표시한 P2가 남았다. 1.6/1.7 native473파일·FFmpeg 동일, 긴 STT/구분은1.6 증거 재사용. 원본 .tmp/two-hour-audit-20261018 및 web-local-engine-followup-plan의 최종 절 |
| 공식 지원 Windows·CPU·RAM·GPU·여유 디스크 | 열림·이 PC 60/120분 설치형/HTTPS 실측 완료; 다른 사양·최소 요구량 미확정 | Windows 11 x64 저사양·일반형·NVIDIA PC의 설치/모델 준비와 대표 입력 측정. OS spool/temp/output별 여유 디스크 사전 검사·최고 사용량, 브라우저·GPU 포함 실제 메모리 압력 확인. Windows 10 x64/ARM64와2시간30분·3/5시간은 별도 증거 전 지원 범위 밖 | 최소·권장 사양, 예상 처리시간, 최대 입력2시간과 미지원 환경이 사용자 문서·설치 전 점검에 동일하게 반영 | 2026-10-19 물리RAM31861MiB PC에서60분/120분 실물 기능 검사 완료. 엔진/소유 하위 작업집합 합계 최대7717.9/9685.5MiB·시스템 최소 여유374.9/756.9MiB(공유 중복·동시 앱 영향 있음),120분 STT후 temp231624905B/results2757163B는 고정 시점이며 최고치 아님. 512MiB는 전체 waveform 배열의 진입 제한으로 모델/전체 RAM 한도가 아니다. 다른 PC·최소 사양·디스크 최고치·물리 전원 차단은 미검증. 상세 audio-performance-improvement-log와 followup-plan |
| Chrome·Edge와 조직 정책의 Local Network Access | 열림·공개/QA HTTPS→설치 엔진 연결·장시간 인증 복구 통과; 실제 권한 창/Edge/조직 정책 미검증 | 최신 stable Chrome·Edge의 실제 권한 승인·거부·재승인과 관리 정책 허용·차단, 다른 PC smoke; 인증 음성 재생과 A6 흐름 함께 확인. 로컬 처리 문구 확인에는 업로드·SSE·결과·sync-record 목적지 및 외부 요청 본문 증거 필요 | 지원 브라우저 범위와 상태별 복구 안내 확정, 회사 관리 브라우저 차단을 설치 실패와 구분. 음성·대화록의 loopback 한정 전송을 실제 Network 기록으로 확인 | 2026-10-19 Chrome 검사 환경의 제어된 LNA 허용 상태에서 공개/QA Cloudflare→loopback 실제 연결·60/120분 처리·유휴 만료/재연결 통과. QA 종료 후 운영1.5/PID30552·barorok.ecomarin.workers.dev 실제 pairing 복원. 사람이 누르는 권한 창·Edge·조직 정책·다른 PC 증거로 확대하지 않음. 근거 two-hour-audit-20261018 및 public-engine-audit-20261018/evidence/pair-2026-10-18T17-51-22-639Z-28652. 같은 날 로컬 처리 문구 재확인은 설치1.5/PID14328의 probe200까지 성공했으나 Windows 브라우저 URL 식별 실패로 제어 중단, 실제 분석/Network 미확보. 소유 엔진 정상stop ACK0·PID 소멸·17863 미응답 확인. 반복 제어 실패가 해소되거나 사람이 Network 기록을 확보하기 전 완료 처리하지 않음 |
| 브라우저 음성 중계의 배포·장시간 파일 호환 | 열림·짧은 mock WAV만 통과 | 배포 후보 HTTPS에서 worker 파일·scope·CSP, 기존 worker 충돌, transferable stream 지원 확인; stable Chrome·Edge와 실제 설치 엔진으로 긴 WAV의 최초 재생·Range 탐색·회의 전환/만료/탭 종료 시 취소 및 메모리 측정 | 지원 환경에서 구간 응답과 재생이 유지되고 전체 파일 선다운로드 없이 전달되며 취소 후 읽기가 종료됨; 미지원 환경의 오류·복구 안내 확인 | 2026-10-15 단위 9개·20초 WAV·웹 자산 포함 통과; 장시간/실배포 증거 없음 |
| 문서 다운로드의 실환경·편집기 호환 | 열림·공개 짧은 입력/QA60·120분 실제4종 다운로드 통과; 편집기·Edge 잔여 | HTTPS·설치 엔진의 Chrome/Edge 다운로드, 한글 파일명·취소·만료 처리; Word DOCX/한컴 HWPX에서 긴 본문·표/문단·쪽 나눔 확인 | 지원 편집기에서 복구 경고 없이 최신 범위/내용을 표시하고 잘림·중복·읽기 불가가 없으며 브라우저 다운로드 완료·자원 해제 확인 | 2026-10-19 QA60분과120분 UI의 TXT/MD/DOCX/HWPX 실제 다운로드·본문/ZIP CRC/전체 XML/HWPX preview 검증, reload/브라우저 재시작 후 전체 기록 불변. QA1.7의120분 재생성 요약도 같은4종 일치. 공개 짧은 입력의 기존8개 파일 증거 유지. 실제 Word/한컴 렌더링·Edge·취소/만료 조합·기존 Unicode 목록 P2는 열림. 근거 two-hour-audit-20261018의 성공 continue-60m·actual-120m·summary-only-120m과 followup-plan |
| 보조기술·확대의 실제 사용자 접근성 | 열림·대표 Chromium 키보드/ARIA 회귀 통과 | 배포 후보 Chrome/Edge에서 NVDA 또는 Narrator로 새 기록 필수 오류·설정/menu·상세 탭/재생·진행/실패 읽기; native 200% 확대·강제 색상·낮은 높이 조합 확인 | 이름/역할/상태와 오류·진행이 이해 가능하게 읽히고 모든 주요 동작·복구에 키보드 접근 가능하며 초점 유실·잘린 제어가 없음 | 2026-10-15 mocked Chromium 대표 흐름·메뉴/탭/설정 1024×720 통과; 실제 보조기술·확대 증거 없음 |
| 고정 포트와 공용 PC·다중 Windows 사용자 | 다중 사용자/RDP·절전 열림; 이 PC의 실모델 하위 잔류 P2 닫음 | `127.0.0.1:17863` 선점, 같은 PC의 두 사용자/RDP 세션, 엔진 재시작·절전 복귀 및 실모델 처리 후 전체 하위 프로세스 stop smoke | 다른 프로세스를 탐색·종료하지 않고 충돌 원인과 복구 동작을 제공하며 지원 범위를 명시; 실모델 후 제한 시간 내 본체·포트·mutex·자체 Ollama/runner/conhost 해제와 데이터 보존 확인 | 2026-10-18 설치1.5 실제 모델 적재·영상 요약 완료 후 startupOnly=false 정상stop. 요청ACK0과 별도로 본체 실제exit0·6.37초, 본체/Ollama/runner/conhost5개 소멸, 포트/mutex해제, 강제정리없음, foreign36096보존. 동일설치본/환경/17863을 PID48712로 복원해 두 기록 전체·화면해시·검토표시 불변; 재열기 생성/추론/export0건을 독립agent 확인. 근거 public-engine-audit-20261018/{loaded-015-before-stop.json,shutdown-015-after-summary.json,restart-015-ready.json,evidence/reopen-2026-10-18T07-33-08-233Z-42872}. 다중 사용자/RDP·절전은 미완료 |
| 설치·모델 다운로드의 오프라인·프록시·보안 제품 영향 | 열림·공개1.5 다운로드/설치 상태/영상 요약 복구 통과; 첫 준비503 남음 | 실제 HTTPS origin·서명된 installer/update manifest URL을 확정하고 일반 인터넷, 인증 프록시, 완전 오프라인, Defender·SmartScreen·대표 조직 EDR에서 설치·모델 받기·업데이트 확인; A5 신규/업데이트/재설치 데이터 보존 증거 필요 | 서명·관리자 배포·오프라인 모델 준비·중단 후 재개 절차가 있고 차단 원인을 사용자 조치와 관리자 조치로 구분; 실제 배포 후보 manifest·서명 검증과 최초 웹 설치 흐름 성공 | 2026-10-18 1.5 공개Chrome다운로드·전체SHA/크기·미서명안내 독립검토 통과. 사용자Windows실행승인 뒤 등록/설정/EXE SHA/미완료표시false·origin/auth·기록설정9개/모델73개/추가2기록 설치 전후 보존 확인. 설치프로그램exit은관측기nullPath오류로미관측이며 성공0아님. 같은영상요약재시도·두기록파일8개/재열기·실모델정상종료/복원 통과. 첫API준비약4분·첫모델적재/요약추가약8분과 준비전503은todoP2에남김. 근거 installed-015-runtime-state·installed-015-boundary·성공resume2개/최종reopen; 상세 followup-plan11절. signed=false/distributionReady=false, 서명·다른PC·최초모델다운로드·오프라인/프록시/EDR 미검증 |
| 공개 파일 배포의 계정 사용량·비용 관리 | 부분 확인·계정 전체 청구 확인 열림 | R2 Standard 무료 포함량과 실제 계정 전체 저장/요청, Workers 구독 플랜·일별 호출량, 예산 알림 또는 운영 기준 확인 | 프로젝트 비용 예상과 계정 실제 사용량을 대조하고 무료 초과 시 과금/차단 동작·보관 버전 정책·확인 담당을 기록 | 2026-10-18 공식 한도·가격 및 Standard 기본 등급·443MB 공개 객체 HEAD 확인. 100명 각 1회는 약 44.277GB의 무료 R2 전송과 GET 최소100회·단일 파일 약0.443GB 보관. bucket info 집계 0개/16.8MB는 실제 HEAD와 달라 현재 청구량 확정에 사용하지 않음. 계정 전체 사용량·Workers 플랜·청구서·알림 미조회/미설정. 상세는 followup-plan 11절 요금 표 |
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
