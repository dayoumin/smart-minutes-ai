# 웹 런타임 분리 구현 계획

- 작성일: 2026-08-13
- 상태: 1단계 첫 구현 묶음 완료, 2단계 준비
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
- `localEngineClient`: probe, capability, pairing, 인증된 HTTP·SSE·다운로드 요청
- `LocalEngineConnectionProvider`: 연결 상태, 재확인, 세션 만료, 업데이트 필요 상태의 단일 소유자
- `meetingRepository` 인터페이스: IndexedDB와 SQLite API 구현 교체

`/api/probe`와 pairing endpoint를 제외한 모든 엔진 요청은
`localEngineClient.request/stream/download`를 통한다. 최종 전환 시 React
컴포넌트와 coordinator의 직접 API `fetch`는 0개가 되어야 한다. 웹 세션 토큰,
Tauri action token, 401 발생 시 한 번만 수행하는 갱신과 `expired` 전이는 이
요청 경계의 런타임 어댑터가 책임진다.

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

## 6. 구현 단계

상위 문서의 단계는 제품 출시 게이트이고, 아래 단계는 코드 작업 순서다.
로컬 엔진 분리 PoC는 0~2단계에 걸쳐 수행하며, 실제 설치 CTA 배포는 최소
pairing/session PoC와 exact origin 검증이 통과한 뒤에만 허용한다.

현재 진행 상황(2026-08-13): 1단계의 첫 구현 묶음인 실행 환경 판별,
공통 로컬 엔진 클라이언트, 전송·인증 상태 분리, MeetingWriter 준비 상태 연결,
웹/Tauri 경계 회귀 검증을 완료했다. 다음 구현은 2단계의 공개 probe와
pairing·세션 최소 PoC이며, 실제 설치 다운로드 안내는 보안 계약 검증 뒤에 연다.

### 0단계: 현재 계약 고정과 회귀 기준

코드 변경 전에 다음을 기준으로 고정한다.

- 기존 API 호출과 Tauri command 사용 위치 목록
- 기존 모델 다운로드·분석·복구 시뮬레이션 목록
- 웹 빌드에서 허용할 환경 변수
- 로컬 엔진 API 계약 버전 형식
- 실제 배포 HTTPS origin은 환경 설정으로 주입하며 소스에 임의 도메인을 고정하지 않음

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
- backend 인증 미들웨어와 공개 endpoint allowlist를 먼저 도입해 기존 민감 API를 default deny로 닫는다. 이 단계에서는 민감 GET, mutation, SSE, 다운로드 대표 경로를 각각 검증한다.
- 최초 pairing은 사용자가 직접 연 로컬 pairing helper가 origin과 6~8자리
  일회성 코드를 보여 주고, 사용자가 웹에 코드를 입력하는 방식을 기준으로 한다.
- 설치 완료 화면은 첫 pairing helper를 열 수 있고, 이후 새 브라우저 추가나
  재pairing은 시작 메뉴의 `바로록 연결` helper에서 시작한다.
- `pair/start`는 exact Origin 검사, 짧은 nonce 만료, rate limit을 적용하며
  자동으로 로컬 창을 띄워 알림 스팸을 만들지 않는다.
- `pair/complete`는 origin, 엔진 인스턴스, 권한 범위에 묶인 짧은 세션 토큰을 발급한다.
- 일회성 코드와 장기 비밀값은 URL, 로그, `localStorage`, 회의 기록에 저장하지 않는다.
- 자동 재연결에 쓰는 자격 증명은 메모리 토큰, origin-bound 브라우저 저장소, loopback HttpOnly cookie 후보를 Chrome/Edge에서 PoC한 뒤 확정한다. 저장 위치, 회전·폐기, 새로고침·브라우저 재시작, XSS·CSRF 보호를 이 단계의 설계 입력으로 고정한다.
- 새 브라우저, origin 변경, 엔진 재설치, 세션 만료, 사용자 폐기와 재pairing 수명주기를 테스트로 고정한다.

완료 기준:

- 인증 전에는 probe와 pairing endpoint 외의 민감 API를 사용할 수 없다.
- 대표 민감 GET, mutation, SSE와 다운로드가 토큰 없이는 거부된다.
- 허용 origin의 pairing과 세션 요청이 통과하고 다른 origin·만료 nonce·반복 추측은 거부된다.
- 로컬 포트의 응답이 제품 식별자와 API 계약에 맞지 않으면 `incompatible` 또는 안전한 오류로 닫힌다.
- 실제 승인 helper가 준비되지 않았다면 pairing 성공을 mock 밖에서 표시하지 않는다.

### 3단계: 웹 연결·설치 복구 UX

- 첫 방문은 설명과 사용자 동작 뒤에 최초 probe를 수행하고, 이미 권한·pairing된 브라우저만 자동 재연결한다.
- 연결되지 않아도 기록 설명과 설치 안내에 접근할 수 있지만 분석 시작은 명확한 이유와 함께 제한한다.
- `unreachable`에서는 `로컬 엔진 받기`를 한 가지 주 CTA로 두고, `실행 후 다시 연결`과 `문제 해결`은 보조 동작으로 제공한다.
- 권한 거부와 엔진 미응답을 가능한 범위에서 서로 다른 복구 안내로 처리한다.
- pairing 필요, 업데이트 필요, 연결됨을 레이아웃을 밀지 않는 안정된 표면으로 표시한다.
- 코드 서명된 설치 파일과 검증된 manifest URL이 준비돼도 4단계의 전체 API 인증 전환이 완료되기 전에는 실제 사용자 대상 다운로드 CTA를 배포하지 않는다.

완료 기준:

- 처음 방문, 엔진 미응답, 권한 필요, pairing 필요, 연결됨, 버전 불일치 장면이 각각 검증된다.
- probe 실패만으로 설치 완료 여부를 단정하지 않는다.
- 키보드만으로 설치 안내와 다시 연결을 사용할 수 있다.
- 좁은 데스크톱 창에서도 주요 복구 동작이 보이고 가로 넘침이 없다.

### 4단계: 전체 엔진 API 클라이언트 전환과 인증 회귀 검증

- 개발 origin과 실제 배포 origin 설정을 분리한다. 웹 production은 exact HTTPS origin, Tauri sidecar는 고정 Tauri origin만 허용하고 localhost는 개발 모드에만 둔다.
- 2단계에서 도입한 default deny가 기존 HTTP, SSE, 진행률, 결과 조회, 설정 조회·변경, 모델 상태·설치·삭제, 분석, 중지, 삭제, 내보내기 endpoint 전체에 빠짐없이 적용되는지 목록 기반으로 검증한다.
- 모든 프런트엔드 호출을 `localEngineClient.request/stream/download`로 이전하고 컴포넌트 직접 API `fetch`를 제거한다.
- 세션 갱신은 401에서 한 번만 시도하고 실패하면 `expired`로 전환해 재pairing을 안내한다.

완료 기준:

- 허용 origin의 인증된 민감 GET, mutation, SSE와 파일 다운로드가 통과한다.
- 허용되지 않은 origin, 토큰 없음, 만료·변조·다른 origin에 묶인 토큰이 각 요청 종류에서 거부된다.
- CORS 설정만으로 mutation이 허용되지 않는다.
- 비밀값이 로그, 브라우저 오류, 저장된 회의 기록에 포함되지 않는다.

### 5단계: SQLite 기준 저장소 전환

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

### 6단계: 브라우저 파일 동작 정리

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

### 7단계: 실제 웹 MVP 통합 검증

- 실제 HTTPS 후보 환경에서 Chrome과 Edge를 검증한다.
- 설치 전부터 설치·권한·pairing·모델 받기·분석·복구·내보내기까지 한 흐름으로 확인한다.
- 30분, 60분, 장시간 파일은 기존 성능 기준과 별도 검증한다.
- 네트워크 기록으로 음성·영상이 원격 웹 서버에 전송되지 않음을 확인한다.

완료 기준:

- 신규 PC와 기존 기록이 있는 PC에서 각각 통합 흐름이 통과한다.
- 엔진 종료·업데이트·세션 만료 후 복구가 가능하다.
- 웹 빌드 검증을 데스크톱 실행 검증으로 오인하지 않는다.
- 실패 항목은 원인 계층이 웹 UI, 권한, 인증, 엔진, 모델, 저장소 중 어디인지 구분된다.

## 7. 첫 구현 묶음

계획 승인 뒤 첫 코딩은 1단계의 일부로만 제한한다.

### 포함

- 실행 환경 타입과 capability 인터페이스
- 기존 `apiBase.ts`를 감싸는 공통 엔진 클라이언트
- 전송 `checking`, `unreachable`, mock `reachable`, `incompatible`과 인증 상태 타입
- 기존 MeetingWriter readiness를 공통 상태와 연결할 수 있는 어댑터
- mock 기반의 웹/Tauri 분기 테스트와 `build:web`

### 제외

- 설치 파일 생성과 다운로드 링크
- 실제 `/api/probe`와 pairing 구현
- backend CORS production 변경
- SQLite 마이그레이션
- 모델 다운로드 UI 재작성
- 시작 화면의 대규모 디자인 변경

첫 구현의 중단 조건은 기존 분석 또는 설정 모델 관리가 깨지거나, 웹과
Tauri가 같은 분기에서 다시 섞이는 것이다. 이 경우 다음 단계로 확장하지
않고 런타임 경계부터 바로잡는다.

## 8. 검증 행렬

| 단계 | 자동 검증 | 실제 환경 검증 |
| --- | --- | --- |
| 런타임 분리 | typecheck, `build:web`, 기존 writer/settings 시뮬레이션 | Tauri 개발 실행 smoke |
| probe·pairing | backend 단위/API 테스트, nonce 만료·rate limit·origin 결합 | 로컬 helper와 실제 HTTPS origin pairing |
| 연결 UX | 상태별 Playwright, 키보드, 760/1100/1536px overflow | Chrome/Edge 권한 승인·거부 |
| 기본 인증 | 민감 GET·mutation·SSE·다운로드의 토큰 없음·만료·변조·origin 불일치 | 세션 만료·재pairing 복구 |
| SQLite | repository 계약 테스트, 가져오기·중복·복구 테스트 | 캐시 삭제·브라우저 변경 후 재조회 |
| 파일 동작 | 다운로드 이벤트와 파일명 검증 | 실제 DOCX/HWPX 열기 |
| 통합 | 설치 전/후 시뮬레이션과 회귀 테스트 | 신규 PC 전체 흐름, 네트워크 기록 |

무거운 전체 Playwright와 portable 빌드는 각 단계의 좁은 검증이 통과한 뒤
필요한 게이트에서만 수행한다.

## 9. 구현 전에 확정할 운영 입력

다음 값은 임의로 코드에 넣지 않는다.

- 실제 웹 배포 HTTPS origin
- 설치 파일과 update manifest 배포 위치
- Windows 코드 서명 인증서와 서명 주체
- 로컬 엔진 설치 경로, 사용자 데이터 경로, 로그 경로
- 자동 시작 기본값과 조직 정책 환경의 예외
- 최소 지원 Chrome/Edge 버전
- 엔진/API 호환 버전 정책과 강제 업데이트 기준
- pairing helper의 배포·서명 방식과 코드 표시 UX
- 자동 재연결 자격 증명의 저장·전달 방식과 XSS·CSRF 보호

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
