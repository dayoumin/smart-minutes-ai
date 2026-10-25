# 웹·설치형 엔진·데스크톱 배포 체크리스트

이 문서는 LMO 회의록의 배포 전 공통 점검 기준과 대상별 검증 기록을 관리한다. 먼저 배포 대상을 정하고 해당 항목을 확인한다. 한 대상의 통과 결과를 다른 대상의 통과로 사용하지 않는다.

| 배포 대상 | 이 문서에서 확인할 내용 | 상세 절차·상태 |
| --- | --- | --- |
| HTTPS 웹 화면 | 화면·엔진 호환성, 연결 실패·복구, 브라우저 기록 보존, 6-1절의 웹 배포 데이터 안전 | [웹 실행 계획의 배포 준비·남은 QA](web-local-engine-followup-plan.md#11-cloudflare-배포-준비--2026-10-18) |
| 웹에 연결하는 Windows 설치형 엔진 | 첫 설치·업데이트·제거 시 데이터 보존, 시작·연결·복구, 웹과의 실제 조합 검증 | 6-1절과 13절, [웹 실행 계획](web-local-engine-followup-plan.md) |
| Windows Tauri 데스크톱 EXE | 자체 서버 시작·복구, 실제 분석·자동 저장, portable 빌드·업데이트·신규 설치 패키지 | 이 문서의 EXE QA, 6-1절 데이터 안전, 7절 빌드·패키지 절차 |

6-1절은 웹·설치형 엔진·데스크톱의 공통 데이터 안전 기준이다. 7절의 빌드·패키지 명령은 Tauri portable용이며 웹 배포나 설치형 엔진 제작 명령으로 대신 사용하지 않는다. 아래 날짜별 결과의 버전·환경·미확인 범위를 확인한 뒤 현재 후보를 판정한다.

## 현재 판정 — 2026-10-25

이번에 요청한 데스크톱·웹 장애 복구, 신규 설치 ZIP, 공개 웹 본문 기한 수정·배포 점검은 완료했다. 아래 표는 완료된 실행, 다른 버전의 완료 이력, 이번 후보에서 실행하지 않은 범위를 구분한다. 과거의 대기 문구나 반복 점검용 빈 체크칸을 이번 작업의 미완료 항목으로 합산하지 않는다.

| 범위 | 판정 | 확인한 대상·증거 |
| --- | --- | --- |
| 이번 데스크톱 장애·복구 점검 | 완료 | clean `1ebd2d9` 실제 EXE에서 서버 미실행·응답 지연·연결 끊김·복구·시험 기록 보존, 정상 종료 통과. `.tmp/native-final-qa-20261025/final-report.json` |
| 이번 실제 분석·자동 저장·업데이트 이관 | 완료 | `8eac988→1ebd2d9` 시험 설치본에서 실제 음성 분석·자동 저장·업데이트·기존 음성 재생·새 버전 신규 분석·재실행 후 두 기록 재열기 통과. 보존104파일 SHA 일치. `.tmp/native-data-update-qa-20261025/final-report.json` |
| 웹 공개 배포·설치형 엔진 업데이트 | 완료 이력 있음 | 2026-10-21의 `0.1.11-beta-20261021` 실제10→11 업데이트 exit0, 설치4957파일 검증·기존145파일 SHA/모델73파일 크기 보존, 공개 배포 검증 통과. `.tmp/public-test-release-20261021/{installed11-verification,public-verification}.json`. 이번 데스크톱 후보와 별도 산출물이다. |
| HTTPS 웹에서 같은 장애5조건 | 완료: 이 PC의 공개 웹+0.1.11/IAB | 실제 설치 payload4957파일을 검증한 전용 복사본으로 미실행·65초 지연·강제 끊김·재시작·실기록 보존/음성 재생을 순차 확인했다. `.tmp/web-failure-qa-20261025/final-report.json`. Chrome/Edge 사용자 권한·회사 정책·다른 PC는 아래 별도 목록을 따른다. |
| 공개 웹 JSON 본문 시간 제한 수정·배포 | 완료: `e796ea3` 공개 반영 | 헤더 뒤 성공·오류 JSON 정체도 작성 준비15초/설정20초 제한에 포함한다. 실제 HTTP 부분 본문 시뮬레이션·독립 agent 재점검·공개 자산/설치 링크·기존 기록 재열기/재생을 통과했다. 아래 공개 웹 본문 기한 배포 절과 `.tmp/public-json-deadline-20261025`를 따른다. |
| `1ebd2d9` 신규 설치 ZIP | 완료: 이 PC의 새 폴더/새 프로필 | 정식 ZIP 생성·CRC 추출·구성/개인 자료 제외·HEAD 기본 설정·sidecar 실행/내보내기·실제 EXE 첫 실행/모델 준비 안내·정상 종료를 확인했다. `.tmp/new-install-qa-20261025/final-report.json`, 전달 파일 `releases/handoff/lmo_audio_no_ollama_no_whisper_1ebd2d9.zip`. |
| 다른 PC·일반 권한 첫 실행·Chrome/Edge·회사 정책 | 대기: 대상 환경 필요 | 아래 별도 인계 목록을 따른다. 이 PC의 IAB/기존 WebView2·시스템 Ollama가 있는 환경과 구분한다. |

2026-10-25 완료 정합성 확인: 보존된 두 최종 보고서의 판정·후보 출처, 실제 EXE 세 사본(후보/업데이트한 시험본/업데이트 payload)의 SHA, 실제 분석 두 record와 backend 결과 파일, SSL 정책 파일 세 사본, 업데이트 보존 증거를 다시 대조해 일치했다. 원본 deploy는 `8eac988`이며 교체하지 않았다. 현재 작업 폴더의 다른 미커밋 UI·백엔드 변경 전체가 검증된 것은 아니다. 문서 정리와 별개로 Codex 자체 멈춤의 원인은 당시 도구 로그가 없어 미확정이다.

## 0. 문서 운영 원칙

### 다른 PC・회사 환경에서 이어서 확인할 항목

이 목록은 이 PC의 통과 결과와 분리한 인계 목록이다. 실제 대상 PC에서 아래 환경·버전·관측 결과를 남겨 닫는다. 안전 설정을 낮추거나 사용자 자료를 지워 통과시키지 않는다.

| 대상 | 상태 | 실행할 확인·종료 증거 |
| --- | --- | --- |
| 새 Windows PC의 일반 권한 첫 실행 | 대기: 대상 PC 필요 | ZIP SHA·manifest 버전을 맞추고 쓰기 가능한 새 폴더에 추출한다. 개발용 Python/Node 없이 EXE 실행, WebView2 준비/부족 안내, 자체 서버 경로·포트, 새 목록·설정 저장·정상 종료를 확인한다. 이 PC의 권한 확보 실행으로 대신하지 않는다. |
| 회사 Chrome·Edge와 조직 정책 | 대기: 실제 브라우저/정책 필요 | 공개 HTTPS+검증된 설치 엔진에서 로컬 연결 권한 허용·거부·재허용, 엔진 미실행·지연·끊김·복구를 확인한다. 입력·기존 기록을 보존하고 실제 분석/저장/재열기까지 실행한다. Network에서 음성·대화록 전송 대상이 loopback인지 확인한다. IAB 통과와 구분한다. |
| 첫 모델 준비·외부망/업무망 | 대기: 해당 네트워크 필요 | ZIP에 없는 Whisper·Ollama 실행 파일·요약 모델의 준비 경로를 확인한다. 다운로드 중지/끊김 후 재개·재시도·파일 검증, 프록시/오프라인의 관리자 배치 안내를 확인한다. 준비 전 안내→준비 후 실제 짧은 분석·자동 저장을 증거로 남긴다. |
| 해당 PC의 기존 설치 업데이트·제거/재설치 | 대기: 시험 복사본/사전 백업 필요 | 설치형 엔진 NSIS와 데스크톱 수동 업데이트를 구분한다. 기존 설정/모델/결과와 브라우저/WebView 기록의 전후 기준값·재열기·음성 재생, 시작 메뉴·재시작 복원, 제거/재설치 후 보존을 확인한다. 실제 사용자 원본을 파괴하는 시험은 하지 않는다. |
| 다른 CPU/GPU·보안 제품·입력 형식 | 대기: 대표 PC 필요 | CPU 기본 동작과 지원 GPU의 대표 입력, 디스크/메모리 부족·백신 차단 시 안내/복구·저장 결과 보존을 확인한다. 이번30초 WAV의 성공을 긴 영상·모든 디코더/PC 사양의 지원으로 확대하지 않는다. 미지원 OS/구조는 지원 정책부터 확인한다. |
| 회사의 문서 편집기와 접근성 환경 | 대기: 실제 사용 도구 필요 | 실제 DOCX/HWPX를 Word/한컴에서 열어 내용·표·쪽 나눔·잘림/복구 경고를 확인한다. 대상 브라우저의 키보드·확대·내레이터/NVDA도 확인한다. 파일 구조 검사나 일반 화면 관측으로 대신하지 않는다. |

마지막 정리: 2026-10-25. 완료 증거는 PC/OS·브라우저·EXE/설치 파일 SHA·모델 준비 상태·사용한 입력·실제 결과·보존/종료 관측을 포함하고, 기존 웹 release QA 행에도 반영한다. 코드 서명·회사 배포 승인 같은 운영 조건은 이 기능 시험의 통과와 별도로 관리한다.

### 날짜별 결정·검증 이력

- 2026-10-23 당시 결정(이력): 실제 음성 분석·요약·재실행 검증을 회사에서 이어서 하기로 했고, 당시 추가 화면 수정은 재빌드 대상이었다. 이후 2026-10-25 격리 후보 `1ebd2d9`의 실제 음성·자동 저장·portable 업데이트 검사는 아래 연속 점검 표에서 통과했다. 요약·참석자 구분 추론은 이번 실행에 포함하지 않았으며 과거 버전의 검증 이력은 각 날짜의 기록을 따른다. 다른 PC와 일반 권한 첫 실행은 별도 환경 검증이다. 이 결과를 현재 작업 폴더의 다른 미커밋 변경 전체에 적용하지 않는다.

- 2026-10-22 웹·데스크톱 병행: 웹 설치 엔진의 고정 포트17863을 데스크톱이 먼저 사용하지 않도록 `src-tauri/src/backend_port.rs`에서17864부터 탐색한다. 포트 모듈의 실제 소켓 검사는 `rustc --edition=2021 --test desktop-app/src-tauri/src/backend_port.rs -o .tmp/dual-runtime/backend-port-tests.exe`로 좁게 실행할 수 있다. 이것은 Tauri 실행 파일의 실제 공존 검증을 대신하지 않는다.
- 기존 deploy 폴더는 사용자 설치본일 수 있다. `Sync-PortableToDeploy`는 패키지 코드만 mirror하며 설정·outputs/temp/logs/database·DB/WAL·다운로드한 모델/runtime·개인 최상위 파일을 보존한다. 프로세스 종료는 지정 deploy 폴더의 실행 파일 경계로 제한한다. 전역 WebView 이름/명령행만으로 다른 설치본을 종료하지 않는다.
- 보존과 전달은 구분한다. 신규 설치 패키지는 알려진 패키지 루트만 복사하고 개인 백업·로그·DB/보조파일을 제외한다. `backend/config.json`은 설치본에서 복사하지 않고 현재 HEAD의 UTF-8 기본 설정을 넣는다. 보통 HEAD 일치·clean manifest 게이트를 지키며 `-AllowStale`/`-AllowDirty`는 로컬 시험용이다. 격리된 신·기존 설치 fixture의 파일 해시와 ZIP 내용으로 보존/제외를 검증한다. 실사용 폴더로 시험하지 않는다.
- 같은 날짜 검증: `backend\.venv-desktop\Scripts\python.exe`(Python3.12.14), `-B -X utf8 -m unittest tests.test_portable_release_scripts`는22개 중21개 통과·1개 skip(기존 deploy에 runtime 산출물이 있어 실제 폴더를 사용하는 검사는 생략). `TEMP`/`TMP`는 `.tmp\dual-runtime\temp`로 지정했다. 실제 소켓2검사, `corepack pnpm --dir desktop-app typecheck`·인증 경계10검사·공개 업데이트 정보4검사, `cargo check --locked --offline --lib` 통과. Cargo 최초 검사에서 누락된 고정 의존성과 사용자 캐시 쓰기 권한을 구분했고, 잠금 파일을 바꾸지 않고 캐시 접근 권한으로 재검사했다. 독립 agent의 포트·배포 데이터 검토 지적과 후속 재검토를 완료했다. 전체 portable 재빌드·실제 Tauri UI·운영 배포는 실행하지 않았다.

### 2026-10-22 체계적 후속 검토: 기존 설치본 검사와 데이터 보호

- 추가 agent 검토에서 동기화 뒤 `verify_portable.ps1`의 재귀 정리가 보존한 결과를 다시 삭제할 수 있음을 확인했다. 재귀 정리를 제거하고 빈 디렉터리만 정리한다. 기본 runtime smoke는 기존 산출물·실행 중인 대상·비표준 내부 데이터 경로를 만나면 실행 전에 중단하며, 다른 설치본을 강제로 종료하지 않는다. 시험 작업/다운로드에는 고유 ID를 사용한다.
- `release_portable.ps1`은 깨끗한 중간 빌드의 smoke를 통과한 뒤 파일을 동기화하고, 기존 deploy는 `-ExistingInstallation`으로 구조·코드 해시만 읽는다. 이때 기준은 검증된 빌드에서 복사한 manifest이며 deploy 파일로 다시 생성하지 않는다. 이 모드는 프로세스 실행/종료·설정/데이터 정리를 하지 않는다. 정상 사용자 설정 변경은 이전 설정 해시와 달라도 허용하며, 파일 존재·JSON 객체 유효성과 실행 코드 해시는 계속 검사한다.
- 기존 설치본을 실행 없이 검사하는 명령: `powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify_portable.ps1 -PortableDir releases\lmo_audio -ExistingInstallation`. 일반 smoke 통과와 이 무결성 검사를 구분한다. 과거 manifest의 코드·모델 조건이 현재와 다르면 무결성 실패를 우회하지 않는다.
- `scripts/portable_data_safety.ps1`은 업데이트·포장 전에 설정된 저장 경로를 검사한다. portable 내부의 비표준 결과/임시/로그 경로, backend 내부에 존재하는 사용자 모델/활성 양식 경로는 삭제·전달 위험이 있어 안전하게 중단한다. 사용자 모델 검사는 `paths.llm_model`뿐 아니라 실제 요약 모델을 선택하는 `summary.model`의 로컬 파일 경로도 포함한다. 임의 경로를 자동 이전하지 않는다. 외부 경로는 업데이트·포장에서 보존하며 runtime smoke는 기본 경로에서만 허용한다.
- 후속 최종 검증은 위 초기22개 기록을 대체한다. 동일 Python·TEMP/TMP로 `tests.test_portable_release_scripts` **26/26 통과, skip 없음**. 실제 deploy를 사용하는 검사를 격리된 가짜 PE/데이터 fixture로 교체했다. 설정 변경 통과, 코드 변조·잘못된 JSON 거부, 기존 파일 SHA 불변, 비표준 내부 경로의 변경 전 거부, ZIP 개인 파일 제외를 검사했다. 실제 소켓4검사·두 모의 환경 기록/삭제 격리 시뮬레이션·변경 JS ESLint도 통과했다. 독립 후속 재검토의 기능상 차단 지적은 없으며 실행 파일·실제 업데이트·WebView 검증은 여전히 미실행이다.
- 같은 날 추가 검토: `runtime`을 `/E`로만 갱신하면 빌드에 포함된 Ollama를 덮을 때 이전 버전 라이브러리가 남아 섞이고, 배포 manifest가 동기화 뒤 폴더에서 생성되어 이를 잡지 못했다. 이제 빌드에 `runtime\ollama\ollama.exe`가 있을 때만 `runtime\ollama`를 `/MIR`로 통째로 교체하고, 없으면 사용자가 받은 Ollama를 보존한다(README만 추가). Ollama 모델은 `models\ollama`에 있어 교체 대상이 아니다. 고정 fixture 테스트를 추가했고 이전 `/E`·HEAD `/MIR` 버전에서 각각 실패, 수정본에서 통과함을 확인했다. `tests.test_portable_release_scripts` **27/27 통과**, `releases` 폴더 4936파일 불변. 실제 Ollama 버전 교체 실행은 하지 않았다.
- 같은 날 독립 리뷰의 두 누락 사례도 회귀 검사로 고정했다. `summary.model`로 지정한 backend 내부 파일이 보호 검사를 통과해 갱신에서 삭제되고 ZIP에 포함되던 경로를 변경 전 거부한다. 백엔드와 같이 이름 형태보다 실제 파일 존재를 먼저 확인하므로 확장자가 없는 파일·슬래시 하위 경로도 보호한다. `./file.gguf`, 파일명만 있는 경로, Windows 상대 경로, 절대 경로와 공백이 붙은 참조를 검사하며 backend 외부 파일·Ollama 모델 이름의 허용도 확인한다. 전달 검사는 실제 진입점을 임시 fixture에 적용해 출력 폴더를 만들기 전 중단과 원본 파일 해시 불변을 확인한다.
- 동기화 후 manifest를 새로 만들면 robocopy가 크기·수정 시각이 같아 건너뛴 잘못된 코드를 정상으로 승인할 수 있었다. 이제 빌드 manifest를 그대로 복사해 대조한다. 실제 완료 순서와 읽기 전용 verifier를 가짜 PE fixture로 실행하여 정상 갱신 통과·설정/기록/다운로드 자원 보존, 잘못된 코드 거부, 양쪽 manifest 바이트 일치를 검사한다. 불일치 시 릴리스를 실패시키며 자동 재해시나 자동 복구는 하지 않는다. 이 검사는 실행 파일·실제 업데이트·WebView 검증을 대신하지 않는다.
- 이번 수정 검증: 프로젝트의 `backend\.venv-desktop\Scripts\python.exe`(Python3.12.14)를 사용하고 `TEMP`/`TMP`를 `.tmp\dual-runtime-fixes-20261022\temp`로 지정했다. 새 집중3검사 중 두 결함을 잡는 검사는 수정 전 실패했고 외부 모델/Ollama 허용 검사는 통과했다. 수정 후 집중3/3, `-B -X utf8 -m unittest tests.test_portable_release_scripts` 전체 **30/30 통과**. 모두 임시 fixture이며 전달 테스트의 고유 시험 ZIP만 생성 후 삭제한다. 실제 설치본·사용자 데이터·실행 중인 앱/엔진은 실행·종료·수정하지 않았고 portable 전체 빌드·배포·커밋은 하지 않았다.

- 같은 날 후속 P2: `D:private-model` 같은 드라이브 상대 경로는 릴리스 셸 위치가 아니라 데스크톱 엔진의 `backend` 작업 위치 기준으로 검사한다. 드라이브 문자 대소문자·루트 상대 경로를 함께 처리하며, 확인된 모델 파일은 절대 경로로 보호 목록에 넣는다. `q:7b` 같은 이름은 실제 로컬 파일이 없으면 계속 허용한다. 업데이트의 source/destination과 전달 진입점에서 변경 전 거부·파일 해시 보존을 검증했다.
- Ollama 최초 설치는 `runtime\ollama\README.txt`를 실행 파일로 대체한다. `-ExistingInstallation`에서는 이 정확한 안내 파일만 없고 `runtime\ollama\ollama.exe`가 있을 때 정상으로 인정한다. 새 패키지 검사나 실행 코드의 누락·해시 불일치는 계속 실패해야 한다. 회귀 검사는 실제 backend 설치 함수·payload 목록·manifest 판정 함수를 임시 fixture에서 실행하며 가짜 실행 파일을 실행하지 않는다.
- 후속 P2 검증: 동일한 `backend\.venv-desktop\Scripts\python.exe`(Python3.12.14), `TEMP`/`TMP=.tmp\p2-followup\temp`, `-B -X utf8 -m unittest tests.test_portable_release_scripts`로 **31/31 통과**했다. 경로·무결성 검사를 나눈 독립 agent 2개의 재검토에서도 남은 지적이 없었다. 기존 미커밋 변경은 보존했으며 실제 실행 파일 검사·전체 portable 빌드·커밋·푸시·배포는 수행하지 않았다.

- 2026-10-20 자동 연결 웹/설치형 엔진은 같은 소스 기준으로 함께 제공한다. 새 엔진의 `--pair`는 시작 별칭이며 이전 숫자 코드 웹의 준비 절차와 호환된다고 안내하지 않는다. `PYINSTALLER_CONFIG_DIR=D:\Projects\audio\.cache\pyinstaller`를 사용한 전용 웹 엔진 빌드는 중간 산출물 삭제 권한 오류 시 실제 설치 엔진과 경로가 다른지 먼저 확인한다. 실행 중인 사용자 엔진을 빌드 캐시로 오인해 종료하지 않는다.
  - 0.1.8 실제 current-user 업데이트 exit0, 기존 데이터 보존·재시작 복원/해제, 비공개 R2 전체 read-back SHA와 운영 웹6파일 SHA·이전 링크2개를 확인했다. 운영 Chrome의 무코드 자동 연결·reload 후 `분석 준비 완료`까지 통과했다. 임시 업로드 Worker/로컬 인증은 정리했고 사용자 모델·회의록은 전송하지 않았다. 근거 `.tmp/browser-connection-20261020`, 자세한 현재 범위/남은 QA는 followup-plan과 기존 release QA 표를 따른다.
  - 0.1.9는 새 엔진·helper·NSIS 설치 파일을 만들고0.1.8 위 실제 업데이트45.36초/exit0·설치 payload4957파일 해시·기존 데이터 불변·재시작 복원/해제를 확인했다. 설치 helper의 `--result-json`/`--decision-ini`는 TEMP 내부의 아직 없는 파일이어야 한다. 전용 QA 폴더를 TEMP/TMP로 지정하고 GUI 실행 파일은 Python `subprocess.run` 등으로 종료를 기다린다. 실행 중인 자기 엔진만 경고인 exit10을 저장 공간 미확정으로 해석하지 않는다. helper 빌드의 `build/web-local-engine-installer-preflight-helper`는 생성물이며 커밋하지 않는다. 근거 `.tmp/release-019-20261020`, 공개 반영/잔여 관문은 followup-plan과 release QA 표를 따른다.

- 이 파일을 portable release, sidecar packaging, build venv, deploy folder 검증의 단일 상세 원본으로 둔다.
- `AGENTS.md`에는 이 파일을 먼저 읽으라는 짧은 운영 규칙만 남기고, venv 복구 절차나 pip cache 우회처럼 긴 해결 절차를 중복 기록하지 않는다.
- 새 빌드 시행착오, 재발 방지책, 검증 명령은 이 파일의 날짜 섹션에 추가한다.
- 과거 실험 로그나 성능 비교 문서에 남은 release 언급은 당시 맥락 기록으로만 보고, 현재 배포 절차 판단은 이 파일을 기준으로 한다.

## 2026-05-05 UI 정리 결정

- 사용자 설정 화면에는 필수 모델, 분석 옵션, 다운로드 형식처럼 사용자가 직접 판단해야 하는 항목만 둔다.
- Whisper, Qwen ASR, fallback STT 같은 대체 모델 후보는 사용자 설정에 노출하지 않고 개발 문서와 `todo.md`에만 남긴다.
- Python, FastAPI, sidecar 같은 구현 용어는 사용자 UI에 노출하지 않는다.
- 포터블 앱은 실행 시 빈 로컬 포트를 잡아 내부 분석 기능에 전달한다. 포트 충돌이 있으면 사용자에게는 "분석 기능을 준비하지 못했습니다" 수준으로 안내한다.

이 체크리스트는 Tauri 앱이 로컬 백엔드 sidecar, 모델, ffmpeg 같은 리소스를 함께 배포할 때 사용한다.

## 0-1. 데스크탑앱 한계 체크

웹에서 잘 동작해도 데스크탑앱에서는 아래 조건 때문에 실패할 수 있다. 앱 수정 후 배포 여부를 판단할 때 이 항목을 먼저 확인한다.

- 실행 단위: 사용자는 `lmo_audio.exe` 하나가 아니라 `releases\lmo_audio` 폴더 전체를 사용해야 한다. exe만 이동하면 sidecar, ffmpeg, 모델, 설정 파일을 찾지 못할 수 있다.
- 쓰기 권한: 회사 PC의 portable 폴더는 쓰기 가능한 위치에 있어야 한다. 결과는 `backend\outputs`, 임시 파일은 `backend\temp`, 로그는 `logs` 또는 `backend\logs`에 생긴다.
- 로컬 백엔드: 앱은 내부 sidecar를 띄워 로컬 포트로 통신한다. 개발 서버가 켜져 있거나 포트 충돌이 있어도 앱이 자기 sidecar에 붙는지 확인한다.
- 모델 의존성: STT 모델과 참석자 구분 모델은 `models` 폴더에 있어야 한다. Ollama 정리 모델이 없더라도 대화록 작성은 완료되어야 하며, 정리 기능만 준비 필요 상태로 남아야 한다.
- 긴 파일 자원 한계: 긴 영상은 임시 WAV와 중간 산출물이 커질 수 있다. 시작 전 저장 공간을 확인하고, 2시간 이상 파일은 참석자 구분이 오래 걸리거나 제외될 수 있음을 UI에서 안내한다.
- 이어하기 한계: 중간 진행분을 재사용하려면 같은 파일과 같은 설정이 필요하다. 원본 음성 파일을 보관하지 않은 경우 결과 화면에서 참석자 구분을 다시 실행하지 못할 수 있다.
- 저장/다운로드 위치: 자동 저장, 내보내기, 내부 결과 폴더를 구분한다. 사용자가 다운로드한 파일과 앱 내부 결과 파일이 어디에 남는지 혼동되지 않아야 한다.
- 외부망/내부망: 회사 PC가 외부망이 아니면 Ollama 모델 다운로드나 추가 설치를 앱 안에서 즉시 처리할 수 없을 수 있다. 이 경우 관리자가 모델을 준비하는 절차를 문서에 남긴다.
- 백신/권한 정책: sidecar 실행, ffmpeg, 대용량 임시 파일 생성이 보안 정책에 막힐 수 있다. 실패 시 사용자에게 내부 구현 용어가 아니라 "분석 기능을 준비하지 못했습니다", "저장 공간 또는 권한을 확인해 주세요"처럼 안내한다.
- Windows 보안 경고: 코드 서명 또는 SmartScreen/Defender 경고가 뜰 수 있다. 배포 전 회사 PC 기준으로 차단 여부를 확인하고, 허용이 필요한 경우 사용자 안내가 아니라 관리자 배포 절차에 기록한다.
- 경로 조건: 한글, 공백, 긴 경로, OneDrive/네트워크 드라이브, 권한 제한 폴더에서 실행할 때 모델/출력/로그 경로가 깨지지 않는지 확인한다. 첫 배포는 가능하면 로컬 쓰기 가능한 짧은 경로에서 검증한다.
- 로그/결과물 민감정보: 로그, 결과 JSON, HWPX/DOCX/TXT에는 회의 파일명, 참석자명, 발화 내용, 로컬 경로가 포함될 수 있다. 지원 요청이나 오류 공유 전에 어떤 파일을 전달해도 되는지 사용자/관리자 안내에 구분한다.

## 1. 실행 파일 형태

- Windows 릴리즈 앱에는 `#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]`가 있어야 한다.
- 앱 exe의 PE Subsystem은 `Windows GUI`여야 한다.
- 백엔드 sidecar도 콘솔 창이 뜨지 않는 형태여야 한다.
- 앱 실행 시 `PowerShell`, `WindowsTerminal`, `cmd`, 새 콘솔 창이 뜨지 않아야 한다.

## 2. 백엔드 sidecar

- 고정 포트만 사용하지 않는다. 가능한 경우 Tauri/Rust가 빈 포트를 잡아 sidecar에 전달한다.
- 프론트엔드는 하드코딩된 `8000`이 아니라 Tauri command로 받은 실제 API base URL을 사용한다.
- `/api/health`와 `/api/models/status`가 같은 sidecar에서 응답하는지 확인한다.
- 다른 Python/FastAPI 개발 서버가 켜져 있어도 앱이 자기 sidecar에 붙는지 확인한다.
- sidecar 시작 실패를 사용자가 볼 수 있는 메시지나 로그로 남긴다.

### 서버 미실행·무응답·복구 출시 전 QA (2026-10-25)

서버가 없는 상태는 지원해야 하는 실패 조건이다. 화면 점검 도구인 Codex의 멈춤과 제품 화면의 무한 대기는 별도로 판정한다. 2026-10-25 사용자가 서버 미실행 상태의 화면 점검 중 Codex 멈춤을 보고했으나, 당시 대상 URL·실행 형태·도구 로그가 없어 원인은 미확정이다. 제품 결함 재현이나 배포본 정상의 근거로 쓰지 않는다.

| 항목 | 상태 | 필요한 증거·종료 조건 | 마지막 확인 |
| --- | --- | --- | --- |
| Tauri 실행 파일의 서버 없는 시작·실패 복구 | 실제 후보1ebd2d9에서 요청5조건 통과, 실제 분석·저장·portable 업데이트도 아래 별도 표본 통과 | 아래 실제 EXE 결과표가 서버 미실행·응답 지연·연결 끊김·복구·시험 기록 보존의 증거를 소유한다. 개발 서버 없는 자체 sidecar 시작과 정상 재실행도 확인했다. 이어 아래 연속 점검에서 실제 30초 음성·자동 저장·8eac988→1ebd2d9 portable 업데이트 보존을 확인했다. 장기 기동 지연·장문 품질·다른 PC·HTTPS+설치 엔진·NSIS 업데이트는 별도 QA다. 원본 설치본은 갱신하지 않았다. | 2026-10-25 |
| HTTPS 웹의 설치형 엔진 미실행·복구 | 공개 웹+0.1.11/IAB 표본 통과 | 아래 웹 실제 시험 결과가 미실행·지연·끊김·복구·실제 생성 기록의 보존을 소유한다. 응답 모의/가상 시간 없이 시험했으며 Tauri 검사로 대신하지 않았다. 일반 Chrome/Edge 권한, 회사 정책, 다른 PC와 헤더 뒤 JSON 본문 정체까지 통과한 것은 아니다. | 2026-10-25 |

소스 확인: Tauri는 시작 시 `spawn_backend`를 호출한다. 일부 초기 모델/음성 조회에는 기본45초의 유한 재시도·취소 처리가 있다. `corepack pnpm --dir desktop-app exec node --experimental-strip-types --test scripts/test-desktop-startup-read.mjs`의12검사가 통과했다. 연결 거부·요청 지연·전체 기한·취소·응답 본문 정체를 모의 검증한 결과이며, 실제 설치본 전체 화면의 반응성이나 Codex 멈춤 원인을 입증하지 않는다.

#### 실제 HTTPS 웹 장애·복구 결과 — 2026-10-25

대상은 공개 `https://barorok.ecomarin.workers.dev`와 실제 설치된 `0.1.11-beta-20261021` 엔진의 변경 없는 복사본이다. 원본/복사본 payload4957파일 SHA를 전후 대조했고, 자식 프로세스에만 전용 `LOCALAPPDATA`·`TEMP`·`TMP`를 전달했다. 자료·모델은 전용 QA 폴더를 사용했다. 브라우저는 이 작업의 IAB이며 시작 시 해당 origin의 회의 목록0건을 확인하고 시험 기록1건만 추가했다. 새 탭만으로 독립 프로필을 증명했다고 하지 않으며 사이트 데이터를 지우지 않았다.

| 항목 | 사전 기준 | 결과 |
| --- | --- | --- |
| 엔진 미실행 | 45초 안에 실패/재확인 안내, 입력 유지 | 통과. 실제 연결 시도 뒤28.304초 이내 `연결하지 못했습니다`·`다시 확인`, 제목·목적 유지. 엔진 시작 후 자동 `연결됨` 관측 상한41.861초. |
| 응답 지연 | 소유 엔진65초 정지, 설정 조회30초 내 안내·Esc3초 내 닫기, 자동 재개 | 통과. 0.85초 간격 관측에서20.368초에 자동 재확인 안내, Esc15ms·창 닫힘, `resumeStatus=0`. 외부 복원 watchdog도 두었다. 해제 뒤 설정 재열기에서 실제 값 정상. |
| 연결 끊김·재시작 | 소유 엔진만 종료, 새 요청10초 내 안내·재시작 후60초 내 연결 회복 | 통과. 실제 종료 뒤 설정 새 조회308ms에 실패 안내. 같은 전용 환경 재시작 뒤37.373초 이내 `연결됨` 관측. |
| 실제 기록 보존 | 실제 음성으로 만든 기록을 장애 전후·서버 없는 reload/재열기 후 비교, 복구 후 음성 재생 | 통과. UI에서30초 WAV의 실제 분석/참석자 구분43초·자동 저장. job ID `c255b545-d7a0-4567-8b5a-64308b3470ed`, raw15구간/display4구간. 대화록388자 exact 일치, 서버 없이 reload/재열기 성공, 복구 후 실제 음성5.995초 재생. 분석 POST는1회뿐이다. |
| 정상 종료·원본 보호 | 전용 `--stop`, 소유 프로세스·포트·mutex/event 해제, 원본 자료 불변 | 통과. 종료 요청 exit0/344ms와 별도로 소유 프로세스0·17863리스너0·mutex/stop-event 없음 확인. 원본145파일 SHA·85모델 파일 크기/mtime 불변. |

근거는 `.tmp/web-failure-qa-20261025/{criteria,fixture,final-report,delay-samples,delay-close,disconnect-ui,offline-reopen,recovered-record,cleanup,mutex-after-stop}.json`, `transcript-before.txt`, 실제 UI 관측과 PNG에 있다. 원본 설치·현재 사용자 Chrome 프로필·공개 배포는 변경하지 않았다. 실모델 요약과 장문/범용 디코더 품질은 이 장애 시험 범위 밖이다.

공개 버전의 시간 초과 문구는 `설정을 불러오는 중입니다. 잠시 후 자동으로 다시 확인합니다.`이고5초 뒤 재시도하므로, 첫 시험의26.959초 로딩 관측은 안내 구간을 놓친 것이다. 첫 시간 판정은 보류하고 연속 계측한 재시험으로 판정했다. 공개본과 로컬 후보의 문구 차이, DOM locator가 찾지 못한 브라우저 기본 음성 컨트롤은 도구 관측 문제와 구분한다. 재시작 직후 연결 준비 전 음성 `다시 확인`1회는 실패했고, 새 회의록의 `연결됨` 확인→기존 기록 재열기 경로에서 실제 재생을 확인했다. 이 경로를 무조작 자동 음성 회복으로 설명하지 않는다.

위 장애5조건 시험 당시 공개0.1.11의 설정20초 기한은 헤더 수신까지였다. 엔진 전체 정지로 헤더 전 무응답을 만든 이 시험과 아래 본문 정체 시뮬레이션·수정 배포를 구분한다. 본문 기한 수정은 아래 `e796ea3` 공개 배포에서 반영했다.

#### 공개 웹 JSON 본문 기한 수정·배포 — 2026-10-25

공개 소스 `e796ea30c5b5ab9e86c4d6ab9985a41a50d8e3ec`를 배포했다. 기존 공개 기준 `a88fcf9`와 검증된 제품 override3개를 `ddd0c50`로 먼저 기록한 뒤 공통 유한 JSON helper·작성 준비·설정 wrapper와 집중 회귀 검사만 추가했다. main에는 이미 검증한 데스크톱/UI 변경이 있어 공개 소스 태그와 main의 최종 커밋이 다르다. 다른 미커밋 UI·백엔드 변경은 이번 배포에 포함하지 않았다. 엔진0.1.11·설치 파일·저장 형식·운영 주소는 유지했다.

| 확인 | 결과·근거 |
| --- | --- |
| 코드·인증 검사 | 공개 후보 유한 응답5·인증 경계10·인증 복구22검사, 타입 검사·변경 파일 lint 통과. 통합 소스의 초기 복구·본문 기한·인증49검사와 타입 검사도 통과했다. `corepack pnpm --dir desktop-app exec node --experimental-strip-types --test --test-concurrency=1 scripts/test-desktop-startup-read.mjs scripts/test-api-auth-boundary.mjs scripts/test-auth-recovery.mjs`. |
| 실제 부분 HTTP 본문 | 빌드된 공개 후보 웹과 전용 HTTP 서버/새 Chromium 컨텍스트를 사용한 격리 시뮬레이션이다. 200/500 헤더와 JSON11바이트만 전송하고 정체시켜 각각20.351초/20.272초에 실패 안내, Esc6ms/5ms, 입력 보존·설정 재열기 후 정상200 회복을 확인했다. 분석 POST0건을 전체 API 집계로 검사했다. 가상 시간을 사용하지 않았으며 실제 설치 엔진을 고장 낸 시험은 아니다. `body-simulation.json`. |
| 수정 전 대조 | 이전 실제 공개 번들 `index-CtaNKO8O.js`에서는 같은 시험이24초 안에 안내를 찾지 못해 예상대로 실패했다. `negative-control.json`, `negative-control.log`. |
| agent 재점검 | 제품 코드 차단 지적 없음. 처음에는 설정 요청만 집계해 분석 POST0을 주장하는 검사 P2가 있었고 전체 API 집계로 보완한 뒤 재실행·독립 확인해 종결했다. |
| 공개 배포·복원 기준 | Worker `b71f13df-d93c-4ae4-ac14-f47f497094df`, 새 JS `index-CG81lWGo.js`. 배포 직전 Worker `bc0c7890-91e4-4a21-b4dc-059f47075023`와 기존6자산을 별도 보존했다. 기존 배포 명령 `corepack pnpm --dir deploy/cloudflare run deploy --config <전용 설정>` 사용. `deployment-before.json`, `deployment-after.json`, `public-before.json`, `rollback-assets/`, `deploy.log`. |
| 공개 검증·자료 보존 | 공개6자산 SHA·0.1.11 metadata·설치 파일 HEAD/Range·이전 링크5개307 통과. 실제 IAB+격리0.1.11 엔진에서 설정 로딩·기존 대화록388자 일치·30초 음성8.130초 재생(오류 없음)을 확인했다. 원본145파일 SHA·85모델 메타·QA 결과2파일 불변, 정상 stop0/672ms, 프로세스·17863포트 잔류 없음. `public-after.json`, `public-ui.json`, `engine-stop.json`. |

배포 태그 `prod-2026-10-25.1`은 실제 공개 소스 `e796ea3`를 가리킨다. Worker deployment ID는 `3f092f58-9bd4-4fea-a33d-c8164a07e9de`, JS SHA256은 `a95f7fc8d9064293d106c3ccc610a61e8b03e9b41c01331595f6fb1c725477fd`다. 엔진 설치 파일의 기존 SHA `f074b179a8c548632946299a045dd7abcb77802d690f62c1cbc23c848d0c2b77`와 크기442842027바이트를 유지했다.

증거 루트: `.tmp/public-json-deadline-20261025`. 재현 명령은 `PLAYWRIGHT_BROWSERS_PATH=D:\Projects\audio\.cache\ms-playwright`, `EVIDENCE_DIR=<전용 증거 폴더>`를 현재 명령에만 지정하고 `corepack pnpm --dir desktop-app exec node scripts/simulate-finite-json-body.mjs`다. 기존 공개0.1.11 source와 동일한 빌드 옵션/설치 링크로 만든 `.tmp/cloudflare-web/dist`를 입력으로 사용한다. 다른 PC·일반 Chrome/Edge 연결 권한·회사 정책·최초 모델 다운로드 관문은 첫머리 인계 목록대로 유지한다.

최종 독립 agent 검토에서 사전 기한·실제 정지와 안내의 시간 순서·원본 보존·대화록/음성·정상 종료 증거를 대조했고, 위 시험 범위의 차단 지적/P2는 없었다. 다른 브라우저/PC·권한·본문 정체의 범위는 그대로 유지한다.

#### 공통 경로 우선 진단·검사 실행 순서

목표는 같은 연결 실패를 여러 화면·모델에서 중복 재현하지 않고, 첫 실패 계층을 확인한 뒤 해당 부분만 고치는 것이다. 진단 절차와 최종 배포 판정은 이 절에서 관리하고, 브라우저 시뮬레이션의 실행 방법·개별 결과는 [frontend-simulation-testing.md](frontend-simulation-testing.md)에 둔다.

프로젝트 간 재사용할 판단 기준은 playbook의 `quality/desktop-app-lifecycle.md`와 `quality/testing-strategy.md`(시작·통신 복구 보강2026-10-25)를 따른다. 이 프로젝트의 시간·포트·명령·실제 후보·미완료 QA는 이 문서가 소유하며, 다른 앱의 채택이나 검증 완료를 뜻하지 않는다.

| 순서 | 최소 확인 | 실패 시 처리·다음 단계 조건 |
| --- | --- | --- |
| 1. 대상 고정 | 개발 화면, HTTPS 웹+설치 엔진, Tauri 중 하나를 선택한다. URL 또는 EXE·manifest·프로필·관련 포트의 소유권을 기록한다. | 이전 세션의 주소/프로세스 기록은 후보 정보다. 현재 응답과 실제 경로가 일치하기 전에는 준비 완료로 보지 않는다. |
| 2. 화면 준비 | 개발 화면은 제한 시간 내 HTTP 응답과 해당 프로젝트의 화면 제목, 초기 모듈·CSS 로딩까지 한 번 확인한다. Tauri는 EXE가 자기 sidecar를 시작하는 경로를 확인한다. | 정상 경로 진단에서 화면 진입이 실패하면 화면별 검사를 중단하고 기동/자산 로딩만 조사한다. Tauri를 통과시키려고 개발 백엔드를 대신 띄우지 않는다. |
| 3. 공통 연결 | 웹은 `/api/probe`와 브라우저 승인·인증, Tauri는 네이티브가 알려준 주소와 인증된 `/api/health`를 확인한다. 실제 backend 경로는 인증된 health/로그로 확인한다. | 연결 거부·잘못된 대상·401/403·브라우저 권한 대기를 구분한다. 실패한 연결에 의존하는 모델/분석 검사는 `선행 조건 미충족으로 미실행`으로 남긴다. health 성공은 모델 준비 완료가 아니다. |
| 4. 요청 방식별 대표 검사 | 유한 JSON은 모델 상태 조회, 음성은 HEAD와 실제 재생/범위 요청, 진행 수신은 SSE의 시작·취소·중단 처리를 각각 최소 한 경로로 확인한다. | 먼저 모의 응답으로 실패·시간 제한·취소·재연결을 확인하고, 최종 배포 조합에서는 실제 경로도 확인한다. 한 요청의 통과/실패를 다른 방식 전체에 일반화하지 않는다. |
| 5. 필요한 실모델 검사 | 앞 단계가 통과하고 변경/배포 범위상 필요할 때만 짧은 고정 음성 하나로 음성 인식→참석자 구분→요약을 순차 확인한다. | 한 단계 실패 시 그 결과에 의존하는 후속 생성을 멈춘다. CPU/GPU·메모리를 공유하는 모델을 동시에 실행하거나 장문·전체 성능 평가로 확대하지 않는다. |
| 6. 복구·보존 | 격리된 시험 복사본/프로필에서 지연·끊김·응답 없음 후 재연결과 기록/설정 보존을 확인한다. 검사에서 바꾼 서버·포트·환경을 복원하고 health와 화면 준비를 재확인한다. | 복구와 보존 증거까지 있어야 해당 QA를 닫는다. 정상 첫 실행만 통과한 결과로 실패 복구까지 완료 처리하지 않는다. |

- **진단 중단과 의도적인 장애 시험을 구분한다.** 정상 경로에서 서버가 없으면 후속 실제 모델 검사를 멈춘다. 서버 미실행 자체를 시험할 때는 화면 진입을 확보한 뒤 시험용 엔진만 미실행/무응답으로 만들고, 안내·화면 조작·닫기·취소·복구를 검증한다. 모의 UI는 실제 엔진 없이 실행할 수 있으므로 실제 health 실패만으로 생략하지 않는다.
- **병렬 실행은 독립된 가벼운 검사에만 적용한다.** 소스 검사·서로 격리된 모의 테스트는 선행 조건 통과 후 자원 여유가 있을 때 최대2개까지 허용한다. 이 수치는 제품 동시 실행 한계가 아니라 이 PC의 점검 운영 기준이다. 브라우저 시뮬레이션은 기본1개, 실제 모델·빌드·패키징은 순차 실행한다. 같은 서버·설정·프로필·모델을 바꾸는 검사는 겹치지 않는다. 압박/시간 초과가 생기면 동시 실행을 줄인 뒤 해당 검사만 재확인한다.
- **공통 경로와 개별 기능의 수정 범위를 구분한다.** 주소·인증·연결·취소의 공유 결함이 재현되면 공통 클라이언트/연결 관리에서 수정하고 대표 소비자로 회귀 확인한다. 모델 준비·음성 재생·SSE 본문 처리는 별도 계약이다. 모든 요청에 같은 시간 제한이나 재시도를 일괄 적용하지 않는다. 긴 분석 스트림, 사용자 응답을 기다리는 브라우저 승인, 부작용이 있는 POST는 특히 별도 정책이 필요하다. 실패한 POST를 자동 재전송하지 않는다.
- **시작 시 요청이 몰린다는 관찰은 추적으로 확인한다.** 첫 요청의 시작/종료·경로·호출 화면·중복 개수를 남긴다. 같은 준비 조회가 겹치는 것이 확인되면 진행 중인 읽기 요청 공유와 재시도 담당 통합을 검토한다. 특정 모델이 없어도 다른 사용 가능한 기능과 기존 기록 열람까지 차단하는 전역 준비 조건을 만들지 않는다.
- **중단 증거는 한 번에 남긴다.** 최초 실패 단계, URL/실행 파일, 응답 코드 또는 연결 오류, 경과 시간, 관련 로그, 가용 메모리 비율과 동시 작업, 실행하지 않은 후속 검사, 복원 상태를 기록한다. 소유권이 불명확한 프로세스는 종료하지 않는다. 같은 실패를 증거 변경 없이 반복하지 않는다.
- **시험 전에 합격 기한을 고정한다.** 각 경로의 요청 기한(헤더뿐 아니라 유한 본문 완료까지), 전체 재시도/배경 재확인 정책, 취소·종료 기한, 실패 안내로 바뀌어야 하는 시점을 기록한다. 실제 경과 시간과 판정을 남기며, 이 값이 미정이면 해당 QA를 완료 처리하지 않는다. 현재 작성 준비 요청은15초, 설정의 유한 요청은20초, 일부 네이티브 초기 조회의 전체 회복은45초다. 이 값을 모든 화면의 합격 상한으로 일반화하지 않는다. 작성 화면의45초 초기 준비와 이후 느린 재확인, 설정의5~30초 재시도 간격은 개별 요청 기한과 별개이며 실제 UI 전환/취소 시간은 시험별로 고정·관측한다. 브라우저 사람 승인 대기는 사용자가 결정하기 전의 대기로 별도 판정하고, 거부·취소 뒤 회복 기준을 따로 기록한다.

2026-10-25 현재 진단: 이전 세션 기록 `.tmp/dev-servers-20261024.json`의 개발 화면 `http://127.0.0.1:5183/`와 개발 backend `http://127.0.0.1:17863/api/health`를 순차 HTTP 조회(각5초 제한)했으며 각각 약2.2초/2.0초에 연결 거부됐다. 브라우저·엔진·모델은 새로 실행하지 않았다. 이는 조회 당시 두 개발 주소가 준비되지 않았다는 증거이며, 설치본 상태나 과거 Codex 멈춤 원인은 아니다. 서버 없는 소스 검사는 `corepack pnpm --dir desktop-app exec node --experimental-strip-types --test --test-concurrency=1 scripts/test-desktop-startup-read.mjs scripts/test-runtime-boundary.mjs`로 순차 실행해 초기 회복12검사와 실행 환경/공통 클라이언트 검사1묶음이 통과했다.

관련 선행 기록: 이 문서 0-1·2절의 자체 sidecar·충돌·시작 실패 기준, 아래 `2026-10-23 초기 상태 후속 수정 검증`, `todo.md`의 `실제 실행 초기 상태 회복`, 시뮬레이션 문서의 `Native startup read recovery — 2026-10-23` 및 `Merged-source browser verification and startup timeout — 2026-10-21`. 기존 수정·시험 결과를 유지하며, 위 최종 배포본 실패 조건의 미완료 상태와 구분한다.

현재 구현 범위: `MeetingWriter.tsx`의 `refreshReadiness`는 health가 성공한 뒤 모델 상태를 조회하는 순차 경로다. `localEngineClient.ts`는 주소·인증·브라우저 권한 처리를 공유하지만 요청 전체의 단일 준비 상태나 모든 호출자의 중복 제거를 보장하는 계층은 아니다. 일부 초기 조회는 `desktopStartupRead.ts`의 유한 회복을 사용한다. 따라서 모든 기능이 동시에 실행되거나 모든 실패가 같은 원인이라는 판정, 전역 초기화 구조 변경은 요청 추적 없이 하지 않는다.

2026-10-25 독립 에이전트 검토 후속: 배포/문서 관점에서 시험별 판정 기한 누락(P2)을 위 기준으로 보완했다. 코드/검사 관점에서는 작성 준비·설정 요청이 헤더 수신 직후 타이머를 해제해 성공/오류 JSON 본문이 끝나지 않으면 확인 상태가 남는 P2를 순수 모의 응답으로 재현했다. 두 유한 요청 경로를 `requestFiniteEngineJson`으로 통합해 본문 완료까지 기존15초/20초 기한과 호출자 취소를 유지한다. 401/403은 기존 클라이언트의 인증 복구 판정 후 본문을 기다리지 않고 상태·헤더만 반환한다. 비인증 오류의 본문은 보존하며, 실패한 POST를 재전송하지 않는다. 일반 요청·SSE·다운로드의 기본 정책은 바꾸지 않았다. 집중17검사+인증 경계10검사+실행 환경/공통 클라이언트1묶음(총28개)과 타입 검사가 통과했다. 이는 소스 수정 근거이며 최종 배포본 QA 두 행은 대기를 유지한다. Codex 프로세스 전체 멈춤의 원인으로 단정하지 않는다.

수정 후 변경4파일 ESLint·diff 검사와 독립2에이전트의 코드/배포 재검토에서 차단 지적이 없었다. 이 소스 검증 단계에서는 브라우저·서버·실모델·배포 빌드를 실행하지 않았다. 검증 명령은 시뮬레이션 문서의 같은 날짜 후속을 따른다.

2026-10-25 후속 브라우저 검증: Vite5198 한 개와 Chromium 한 개로 `simulate-finite-request-recovery.mjs`의 health 성공 본문 정체·모델500 오류 본문 정체·설정 성공 본문 정체3경로를 순차 통과했다. 실제 제품 UI를 렌더링하되 네이티브 연결과 모든 API를 모의했고 가상 시간을 사용했다. 작성 요청15초/설정20초에 본문이 취소되는지, 준비 중에서 복구 안내로 바뀌는지, 설정 Esc 닫기·재열기와 연결 회복 후 상태 갱신을 확인했다. 실제 캡처에서 안내·닫기·복구 화면을 확인했다. 분석 POST는0이며 실제 엔진·모델·사용자 프로필을 사용하지 않았다. 명령·서버 정리·캡처6개와 `result.json`은 시뮬레이션 문서 및 `.tmp/finite-request-ui-20261025`를 따른다. 최종 설치 EXE와 HTTPS+설치 엔진의 QA는 여전히 대기다.

#### 실제 EXE 장애·복구 점검 결과 — 2026-10-25

원본 `releases/lmo_audio`의 `8eac988`/dirty=false는 읽기 전용 무결성 검사 전체 통과이나 이번 수정 미포함이다. `93b4ea7`과 원본 배포 소스 사이 backend/Rust/배포 스크립트 차이가 없어 검증된 sidecar를 재사용했다. 격리 worktree `codex/desktop-failure-qa-20261025`의 `1ebd2d9`에는 유한 본문 수정4파일만 커밋했다. 원본의 다른 미커밋 코드는 포함하지 않는다. 집중27검사·타입·변경 파일 lint·독립 검토를 통과한 뒤 해당 worktree 내부의 정식 portable 후보 빌드·중간 runtime/export smoke·최종 폴더 무결성 검사가 exit0이다. 시험 후 프로그램 payload4,982파일 해시도 같은 manifest와 일치했다. 원본 deploy는 갱신하지 않았다. 근거는 원본 작업 폴더 `.tmp/native-final-qa-20261025/final-report.json`, `build.log`와 개별 관측 JSON을 따른다.

| 항목 | 사전 합격 기준 | 상태·관측 |
| --- | --- | --- |
| 새 후보 출처·무결성 | `1ebd2d9`/dirty=false, 중간 runtime smoke와 worktree deploy 읽기 전용 검사 통과 | 통과. 후보는 `C:\Users\MS\.codex\worktrees\desktop-failure-qa\audio\releases\lmo_audio`. 같은 소스의 EXE와 실제 frozen sidecar를 사용했다. 시험 뒤 payload4,982파일 해시 일치. |
| 서버 미실행 | 후보의 sidecar만 일시 보류한 상태에서 실제 창 실행,65초 안에 복구 안내·관련 화면 조작 가능 | 통과. 실제 재실행0.586초에 준비 중,45.564초에 `no-response`. 문제 해결→설정→재시작을 실제 조작해10.565초 안에 health 회복·backend 경로 일치. 보류 파일은 원래 SHA로 복원했다. |
| 응답 지연 | 소유 후보 backend만 자동 복원되는40초 일시 정지. 설정 조회 뒤25초 안에 실패 안내, Esc 닫기3초 이내 | 통과. 실제40초 정지에서20.131초 오류 안내·Esc0.103초. `resumeStatus=0` 및 실제 health 회복을 확인했고 설정 재열기 정상. 가상 시간·응답 모의 없음. |
| 연결 끊김·복구 | 소유 후보 backend만 종료하고 설정 새 조회 시 오류 안내10초 이내, UI 재시작 뒤 health60초 이내·실제 backend 경로 일치 | 통과. 실제 서버 종료·포트 해제 뒤 설정 클릭→창 열림→오류 문구 확인을 같은 도구 호출에서 수행했고 전체가 약2.1초(보수적 상한2.2초)였다. 정밀 JS 시간 기록의 바인딩 오류와 실행 코드는 `disconnect-observation-note.txt`에 표시했다. 화면 재시작 뒤0.706초 health 회복·새 소유 PID 확인. 대기 화면의 상시 연결 감시는 이 판정에 포함하지 않는다. |
| 기록 보존 | 전용 프로필의 식별 가능한 시험 기록을 장애 전후 및 정상 종료/같은 프로필 재실행 후 재열기. 원본 보호 파일·모델 메타데이터 불변 | 통과. 시험 대화록·요약·화자 표시·메타데이터9필드와 같은job ID의 backend 결과를 비교했다. 서버 없이도 기록 열람, 장애 뒤 대화록/요약 UI 재열기, 정상 재실행의 자체 서버 시작·기록 재열기를 확인했다. 원본10파일 SHA와 모델20파일 크기/mtime 불변. |
| 정상 종료·정리 | 디버그 연결 없는 실제 실행에서 닫기 후 소유 앱·서버·WebView10초 안에 종료, 시험 포트/보류 파일 해제 | 통과. 닫기 입력 뒤 앱0.141초·서버0.192초·WebView0.594초. 실제 프로세스 핸들로 관측했다. 마지막17864/9338 포트 없음·소유 프로세스 잔류 없음·보류 파일 없음. |

시험 기록은 프로그램으로 전용 IndexedDB에 준비했고 같은job ID의 backend JSON을 맞췄다. 기록 준비 전후 실제 WebView의 부모 PID·전용 프로필 인자를 확인했다. 실제 음성 인식·자동 저장·원본 음성 재생이나 업데이트 이관 성공과 구분한다. 실제 시간·프로세스 경로·프로필로 검증했으며 가상 시간/응답 모의는 쓰지 않았다. HTTPS 웹+설치 엔진·다른 PC·실모델 품질·전체 배포 QA 승인은 별도다.

실행 명령: 격리 worktree에서 `corepack pnpm build -SkipSidecarBuild -NoClearWebViewCache -Python D:\Projects\audio\backend\.venv-desktop\Scripts\python.exe`. 첫 시도는 프로젝트 로컬 Corepack 캐시의 실행 파일 누락으로 실패해 기존 검사에 쓰던 기본 Corepack 경로를 사용했다. 컴파일 후 Tauri의 내용 차이 없는 `Cargo.toml` 줄바꿈 변경이 dirty 판정을 만들어 초기 smoke가 거부됐고, 실제 diff가 없음을 확인한 뒤 그 파일만 복원했다. 재컴파일 없이 `corepack pnpm build -SkipSidecarBuild -SkipTauriBuild -NoClearWebViewCache -Python D:\Projects\audio\backend\.venv-desktop\Scripts\python.exe`로 포장·검증을 마쳤다. 실패 로그 `build-cargo-line-ending-failure.log`도 보존한다.

계측 제약/후속(2026-10-25): 사용자 입력 경합·창 활성화/좌표 미확보·보고 변수 바인딩 오류가 있었던 시도는 제품 실패로 분류하지 않고 유효한 조작과 관측으로 재확인했다. 디버그 연결 중 종료10초 probe는 완료되지 않았고 이후 잔류는 사라졌으나 원인은 미확정이다. 디버그 없는 실행의 종료는 위 값으로 통과했다. 디버그 조건의 원인을 닫으려면 다음 계측에서 앱/서버/WebView별 종료 시각과 디버그 접속 상태를 동시에 기록한다. 이번 결과를 Codex 자체 멈춤의 원인 규명으로 확대하지 않는다. 후보와 재현 도구는 격리 worktree/원본 `.tmp/native-final-qa-20261025`에 보존하며 공개 배포·원본 교체·push는 하지 않았다.

최종 독립 검토에서 후보 출처·시험 기록 범위·원본 보호·시간 측정 근거를 확인했다. 연결 끊김 측정의 클릭/관측 동일 호출 증거를 보완한 뒤 이 검토 범위의 남은 차단 지적은 없다. 문서 diff 검사도 통과했다.

#### 실제 음성·자동 저장·업데이트 연속 점검 — 2026-10-25

장애 시험용으로 준비한 기록과 실제 분석으로 자동 저장된 기록은 증거가 다르다. 아래 세 행은 같은 격리 설치본·전용 WebView 프로필에서 순서대로 검사한다. 이전 설치본 `8eac988`과 새 후보 `1ebd2d9`를 구분하며 원본 설치본을 업데이트하지 않는다. 근거는 `.tmp/native-data-update-qa-20261025`에 보존한다.

| 항목 | 상태 | 합격 기준·필요 증거 | 마지막 확인 |
| --- | --- | --- | --- |
| 구버전 실제 분석·자동 저장·재열기 | 통과: 실제 음성 1건 | UI에서 30초 WAV를 분석해 37.916초에 대화록 15구간이 생성됐다. DB 주입·별도 저장 조작 없이 `e8cda98c-7620-488a-bb0a-f04e36e6f817`이 저장됐고, 정상 종료/같은 프로필 재실행 뒤 전체 record 일치·실제 대화록 열람을 확인했다. 원본 WAV SHA 불변. | 2026-10-25 |
| 업데이트 후 기존 실기록 보존 | 통과: portable 8eac988→1ebd2d9 | 구버전 정상 종료·프로세스 해제 후 clean 후보에서 `corepack pnpm package:update`로 만든 패키지를 격리 설치본에 적용했다. `SkipVerify` 없이 적용/검증 exit0. 새 앱 실행 전 설정·결과·음성·모델/runtime·개인 시험 파일 등 104파일 SHA가 모두 같았다. 같은 프로필의 이전 record 전체가 일치했고 대화록 재열기·보관 음성 실제 재생5.963초를 확인했다. 새 EXE SHA·manifest commit/dirty=false도 일치. | 2026-10-25 |
| 새 후보의 새 분석·자동 저장·재열기 | 통과: 신규 실기록 + 이전 기록 | 업데이트한 `1ebd2d9`에서 같은 30초 WAV로 새 분석을 시작해 21.625초에 대화록 15구간·새 ID `b1248580-8cf9-422f-b8d4-f4755bc269b4`가 자동 저장됐다. 별도 저장 조작 없이 정상 종료/재실행 후 두 record 전체가 일치했고 두 대화록을 실제 화면에서 각각 열었다. 실제 분석 POST는 총2건이며 재열기로 늘지 않았다. | 2026-10-25 |

짧은 실제 음성 1개의 기능 점검이며 장문 처리·요약/참석자 구분 품질·신규 설치 패키지·NSIS 설치형 엔진 업데이트·HTTPS 웹·다른 PC 합격으로 확대하지 않는다. 위 처리 시간도 이 PC의 표본 관측값이며 성능 보장값이 아니다. 이번 시험에서는 요약·참석자 구분 추론을 실행하지 않았다. 실패하거나 환경 때문에 실행하지 못한 행은 통과 처리하지 않고 원인·다음 종료 조건을 이 표에 갱신한다.

근거: `final-report.json`, `old-after-analysis.json`, `old-reopen.json`, `package.log`, `apply.log`, `update-preserved-{before,after}.json`, `after-update-records.json`, `old-audio-playback.json`, `new-after-analysis.json`, `final-reopen.json`과 최종 대화록 UI 관측 텍스트를 함께 보존한다. 저장된 두 record의 ID/job ID·15구간 텍스트·서버 결과와의 시간 변환 계약을 확인했고 backend 결과 JSON은 분석 직후와 최종 재열기 뒤에도 같다. 화면의 `HH:MM:SS`와 서버의 실수 초는 `backend/main.py`의 `seconds_to_timestamp` 변환 후 비교했다. 사용하지 않은 원본 설치본/기본 프로필 보호10파일 SHA와 모델20파일 크기/mtime도 불변이다.

실행 환경 한계: 기본 sandbox 실행은 WebView 창·서버 생성 전에 자식이 종료되어 해당 창 없는 시험 프로세스만 경로 확인 후 정리했다. 같은 설치·프로필을 권한이 확보된 실행으로 재시도해 실제 작업을 검증했다. 이 결과는 모든 PC의 일반 권한 첫 실행 또는 Codex 자체 멈춤 원인 규명을 대신하지 않는다. Computer Use의 모달 소유 창/좌표 관측 실패와 최종 비교 도구의 시간 형식·UTF-8 BOM 읽기 보완은 제품 실패와 구분한다. 원본 교체·공개 배포·push는 하지 않았다.

최종 독립 agent 검토에서 위 세 흐름의 기록·업데이트·원본 보호 증거와 문서 범위를 대조했고 현재 범위의 차단 지적/P2는 없었다. 정상 닫기 뒤 소유 앱·서버·WebView 및 시험 포트17864/9339/13448 잔류0을 `final-cleanup.json`에 남겼다. 문서 diff 검사도 통과했다.

### Python 통신 초기화·보안 정책 리소스 확인

- [x] 빌드 Python에서 `ssl.create_default_context()`가 성공한다. 해당 Python이 `codex-rejected-cas.pem` 같은 추가 정책 파일을 요구하면 파일을 발견해 수집하며, 인증서 검증을 끄거나 빈 파일로 우회하지 않는다. 이 이름은 현재 Codex 제공 Python에 해당하며 모든 Python의 필수 파일로 가정하지 않는다.
- [x] `backend\.venv-desktop\Scripts\python.exe -B -X utf8 -m unittest tests.test_sidecar_ssl_runtime`이 통과한다. 실제 최소 frozen 실행 파일의 정책 파일 SHA 일치, SSL 기본 컨텍스트 생성, `CERT_REQUIRED`·hostname 검사 유지, 로컬 HTTP 요청 성공을 확인한다.
- [x] 최종 `releases\lmo_audio\binaries\_internal`에 빌드가 발견한 정책 파일이 같은 SHA로 들어 있고 `release-manifest.json`의 코드 파일 목록에도 포함돼 있다. 빌드에서 이 정책을 요구하지 않으면 그 사실과 검사한 Python 경로를 기록한다.
- [x] 새 빌드의 별도 QA 복사본에서 실제 로컬 요약 요청 성공, 자동 저장, 같은 프로필 재실행 후 요약 재열기를 확인한다. 2026-10-23 `07e071c7`의 30초 WAV/Qwen4B 검사로 확인했으며, 장문 품질·초기 상태 회복 문제의 종료로 확대하지 않는다.
- [x] `1ebd2d9` 업데이트 패키지의 최종 payload와 업데이트한 시험 설치본에도 같은 정책 리소스가 들어 있다. 2026-10-25 후보/패키지/시험본3사본 SHA 일치, 실제 적용·검증 통과.
- [x] 같은 후보의 신규 설치 패키지(ZIP)에도 정책 리소스가 같은 SHA로 포함된다. 2026-10-25 `1ebd2d9` ZIP 추출본의 정책 파일 SHA와 HEAD 기본 설정, 실제 sidecar 실행을 확인했다.

2026-10-23 현재 상태: 현재 `.venv-desktop`의 통신 초기화와 최소 frozen 회귀 검사 1개가 통과했다. 정책 파일은 906바이트, SHA256 `c916ce1b14ed8ca69e9b5c9fab22799a900dd610d6d4ec9b1347f4fd48e53718`이다. 격리된 clean 브랜치 `codex/ui-home-release-20261023`의 `371b066`에서 `corepack pnpm build -NoClearWebViewCache`가 exit0이며 중간 폴더 실행 smoke와 최종 deploy 읽기 전용 무결성 검사를 통과했다. 정책 파일의 최종 SHA·manifest 포함도 일치한다. 빌드 전후 설정·모델·사용자 WebView 저장소 34파일의 SHA가 모두 같다(`.tmp/home-release-20261023/postbuild-protection.json`). 이후 채택한 I안과 추가 화면 수정의 실제 요약·자동 저장·재실행 검사는 **사용자 결정으로 회사 PC에 이관**했다. `todo.md`의 회사 이어하기 항목에 따라 최종 소스 재빌드·실제 모델 검사 증거로 닫는다. 이 상태를 회사 PC·신규 설치 패키지 또는 모든 수동 QA 완료로 해석하지 않는다.

2026-10-23 후속 확인(`D:\Projects\LMO_audio`): P2 수정·독립 재검토 후 `07e071c7`을 커밋하고 `corepack pnpm build -NoClearWebViewCache` 전체 빌드가 exit0이다. 중간 실행 smoke·최종 설치본 읽기 전용 무결성, HEAD 일치·dirty=false, SSL 정책 파일 SHA 일치를 확인했다. 보호61항목의 사용자 파일·설정·기존 WebView 기록 SHA와 모델 파일 크기가 불변이다(모델 전체 SHA 검사는 아님). 별도 QA 복사본·전용 프로필에서 실제30초 음성의15구간/2화자 분석·자동 저장, 시스템 Ollama0.34.2의 `qwen3.5:4b` 요약·자동 저장·정상 종료/같은 프로필 재실행 후 같은 대화록/요약과 backend overview 일치를 확인했다. 정리 전 저장 잠금·요약 후 저장 활성화도 실제 EXE에서 통과했다. 재실행 첫 음성 확인 실패는 `다시 확인`으로 회복 후 실제 재생 시간이0.53초를 넘어갔다. 초기 요약 모델 상태는 설정의 준비 상태 재확인 뒤 회복했다. 두 초기 상태 문제는 기존 release QA 행과 TODO에 미해결로 유지한다. 원본 WAV는 SHA 불변이다. 근거 `.tmp/release-20261023/{build.log,protected-after.json,final-qa.json,open.json,retry-audio.json,play.json}`. 사용자 설치본의 요약 설정은 바꾸지 않았으며 시험 복사본만 Qwen을 사용했다. 새 업데이트/신규 설치 패키지·HTTPS 웹·설치 엔진·장문 품질·다른 PC 검증은 수행하지 않았고 공개 배포 보류를 유지한다.

2026-10-23 초기 상태 후속 수정 검증: 첫 모델/음성 조회의 시작 실패 고착, 모델 준비 중 성공 응답의 고착, 기존 요약에서 첫 모델 확인 전 재생성 허용을 UI에서 수정했다. 네이티브의 읽기 전용 조회만45초 안에서 회복하며 유한 JSON 본문도 요청 시간 제한·취소에 포함했다. 집중12·브라우저 승인21·인증 경계10검사, 화면3시나리오, 타입/lint, 독립2관점 재검토 통과. `corepack pnpm --dir desktop-app desktop:build:exe`로 UI EXE를 컴파일해 검증된07e071c7 sidecar/모델이 있는 **별도 QA 복사본에만** 반영했다. `dirty=true` 시험용이며 정식 deploy 갱신·clean portable 재빌드 완료로 표시하지 않는다. 앱·시스템 Ollama 동시 새 시작 및 같은 프로필 정상 재시작2회에서 수동 준비 상태 확인·음성 재시도 각0회, 30초 음성 실제 재생과 요약 재생성POST200·기존 요약 재열기 통과. 초기 준비9.4초/6.1초, 전체26.5초/11.4초이며 성능 일반화 자료는 아니다. 최종 source/EXE SHA·backend overview 일치는 `.tmp/native-startup-fix/{provenance,final-report,cycle-1,cycle-2}.json`을 따른다. 앞 문단의 두 초기 상태 결함은 이 표본에서 해소했으며, 웹·설치 엔진·업데이트/신규 설치 패키지·장문 품질·공개 배포 보류는 유지한다.

## 3. 리소스와 모델 경로

- portable 배포에서는 exe 하나만 옮기는 것이 아니라 앱 폴더 전체를 유지해야 한다.
- 모델 경로는 `실행 폴더/models/...` 기준으로 안내한다.
- 현재 앱 설정 화면은 필수 모델 준비 상태와 `models` 폴더 기준 안내를 보여준다. 절대 경로 표시/복사 버튼은 후속 UX 개선으로 다루되, 배포 문서에는 실제 배치 위치를 반드시 명시한다.
- 일반 사용자 배포 UX를 개선할 때는 `models`, `backend`, `binaries`, `runtime` 같은 내부 폴더를 최상위에 그대로 노출하지 않는 구조를 검토한다. 예: 최상위에는 `lmo_audio.exe`와 `START_HERE.txt`만 두고, 모델과 런타임 파일은 `_internal` 또는 앱 관리 데이터 폴더 아래에 둔다.
- 내부 폴더를 숨기더라도 모델 파일을 단일 파일로 합치지는 않는다. STT 모델과 참석자 구분 모델은 여러 필수 파일로 구성되므로, 실제 파일 구조는 유지하고 앱/패키징/검증 코드가 역할 기반 모델 registry에서 경로를 찾게 한다.
- 모델 교체 가능성을 열어둘 때는 `faster-whisper-large-v3` 같은 모델명을 UI, 설정 저장, backend 경로, verify script에 직접 박지 않는다. `stt`, `diarization`, `summary` 같은 역할과 `portable_model_layout.json` 또는 후속 model registry를 기준으로 resolve한다.
- 필수 모델이 없으면 분석 버튼 클릭 후 즉시 원인과 조치 방법을 보여준다.
- 큰 모델을 zip에서 제외하는 경우, 제외한 모델명과 넣을 위치를 문서에 명시한다. 신규 설치 패키지(ZIP)는 `no_ollama_no_whisper` 기준으로 만들고, 참석자 구분 모델은 포함한다.
- Ollama runtime은 기본 배포 zip에 포함하지 않는다. 앱 설정의 모델 탭에서 고정된 공식 standalone Windows CLI release zip을 받아 `runtime\ollama\ollama.exe`로 풀고, portable 폴더에 쓸 수 없으면 `%LOCALAPPDATA%\LMO_audio\runtime\ollama`를 사용한다. 앱은 앱 관리 runtime이 있으면 시스템 설치본보다 우선 사용하고, 앱 관리 runtime이 없으면 `OLLAMA_EXE`, PATH의 `ollama`, 일반 설치 경로의 시스템 Ollama 순서로 fallback한다. 앱 관리 runtime의 요약 모델 저장소는 같은 앱 관리 경계의 `models\ollama`를 사용한다. release 운영 시 `LMO_OLLAMA_RUNTIME_VERSION`과 `LMO_OLLAMA_RUNTIME_SHA256`을 기록해 다운로드 URL과 해시가 의도한 릴리스인지 확인한다.
- 오프라인 또는 사전 내장 배포가 필요할 때만 공식 standalone Windows CLI 압축을 풀어 `runtime\ollama\ollama.exe`가 보이게 둔다. 이때 전체 `releases\lmo_audio` 폴더 크기와 회사 전달용 신규 설치 패키지(ZIP) 크기를 구분해서 기록한다.
- Ollama 요약 모델은 임의의 단일 파일 링크 다운로드가 아니라 앱 내부에서 `ollama pull <model>` 흐름으로 받는다. 그래야 manifest/blob 저장 구조와 설치 여부 확인이 Ollama 기준과 맞는다.

## 4. 패키징 산출물

- 이전 portable/zip 산출물을 삭제한 뒤 새로 만든다.
- zip을 빈 폴더에 풀어서 실행하는 clean-room 테스트를 한다.
- zip 안의 exe와 현재 release exe가 같은 최신 빌드인지 확인한다.
- 최종 zip 또는 전달 폴더의 버전/commit, 생성일, 크기, SHA256을 기록한다. 사용자가 받은 파일이 어느 빌드인지 `release-manifest.json`과 대조할 수 있어야 한다.
- 모델과 외부 runtime을 포함하거나 제외할 때는 재배포 가능 여부, 라이선스/출처, 회사 내부 전달 가능 범위를 확인한다.
- sidecar 재빌드가 필요한 Python 코드 변경 후에는 반드시 sidecar를 다시 만든다.

## 5. 사용자 시나리오

- 앱 실행 후 콘솔 창이 뜨지 않는지 확인한다.
- 모델이 없는 상태에서 분석 시작 시 즉시 안내가 나오는지 확인한다.
- 모델이 있는 상태에서 MP4/WAV 분석이 시작되는지 확인한다.
- 분석 실패 시 진행 영역에서 실패 원인이 보이는지 확인한다.
- 회의 기록 저장과 HWPX/TXT/DOCX 다운로드가 동작하는지 확인한다.
- HWPX는 zip/XML smoke만으로 완료 처리하지 않는다. 회사 PC에서 실제 한글 또는 HWPX 뷰어로 열어 제목, 일시, 참석자, 본문이 표시되는지 확인한다.
- 설정은 `일반`과 `모델` 탭 기준으로 확인한다. 더 이상 일반 사용자 흐름에서 `분석 준비` 탭명을 기대하지 않는다.
- 설정 `일반` 탭에서 참석자 구분 사용 여부와 분석 중 참석자 구분 실행 옵션이 저장되고 `/api/models/status`에 반영되는지 확인한다.
- 설정 `모델` 탭에서 추천 모델, 직접 입력 모델, 설치된 Ollama 모델, 사용 중 모델 표시가 서로 일관되는지 확인한다.
- 설정 `모델` 탭의 음성 인식 모델은 없는 상태의 `받기`, 받는 중 진행률/남은 시간/중지, 완료 후 준비 체크 표시를 함께 확인한다. 완료 응답만으로 준비됨 처리하지 말고 `/api/models/status`에서 실제 모델 파일이 확인된 뒤 체크 표시가 떠야 한다.
- Ollama runtime 받기는 받는 중 진행률/남은 시간/중지, 완료 후 준비 상태 확인, portable 폴더 쓰기 불가 시 `%LOCALAPPDATA%\LMO_audio\runtime\ollama` fallback을 함께 확인한다.
- Ollama 모델 받기/상태 확인/삭제 기능은 사용자 입력 모델명 검증, 받는 중 진행률/남은 시간/중지, 완료 후 준비 체크 표시, 사용 중 모델 삭제 차단, 받는 중 모델 삭제 차단을 함께 확인한다. Ollama runtime이 아직 없으면 모델 받기 요청은 먼저 요약 프로그램을 받으라는 안내로 끝나고, 진행 중 메시지가 남지 않아야 한다. 완료 응답만으로 준비됨 처리하지 말고 `/api/models/status`에서 Ollama 설치 목록이 확인된 뒤 체크 표시가 떠야 한다.
- 앱 관리 Ollama가 있는 배포본이나 첫 실행 후 다운로드된 상태에서는 별도 Ollama 설치 없이 모델 받기가 시작되는지, 앱 관리 `models\ollama` 아래에 모델 데이터가 생기는지 확인한다. 외부 Ollama 설치본이 이미 있어도 앱은 앱 관리 runtime과 내부 포트를 우선 사용해야 한다. 외부 Ollama 설치본은 있으나 실행 중이 아니면 사용자가 먼저 기존 Ollama를 실행한 뒤 다시 확인하도록 안내한다. 계속 실행되지 않으면 회사 보안 정책이나 설치 상태 문제로 보고 관리자 확인을 안내한다. 회사 보안 정책이 앱 관리 runtime 실행을 막으면 다운로드만으로 해결되지 않으므로 관리자에게 `runtime\ollama\ollama.exe` 또는 `%LOCALAPPDATA%\LMO_audio\runtime\ollama\ollama.exe` 실행 허용을 요청하도록 안내한다.
- 모델 탭은 사용자가 직접 누른 `준비 상태 확인` 때만 확인 중 상태를 보여준다. 탭을 열어 둔 것만으로 반복 상태 점검, `최근 확인` 시간, 긴 백엔드 상태 문구, 완료 배너가 계속 표시되어 레이아웃을 흔들면 안 된다.
- 결과 화면에서 요약 모델이 없을 때는 `모델 필요` 수준의 사용자 문구와 `모델` 탭 이동이 동작해야 한다.
- 결과 화면에서 원본 음성이 없을 때 참석자 구분 상태를 구분한다. 기존 참석자 표식이 1명뿐이면 `표식 1명`, 표식 자체가 없으면 `재실행 불가` 안내가 나와야 한다.

## 6. 배포 전 자동 점검

프로젝트별로 `scripts/verify_portable.ps1` 같은 스크립트를 두고 아래 항목을 자동화한다.

- portable 폴더 존재 여부
- 앱 exe와 sidecar exe 존재 여부
- 앱 exe와 sidecar exe의 PE Subsystem
- 앱 관리 Ollama runtime 폴더와 `runtime\ollama\ollama.exe` 포함 여부 또는 첫 사용 다운로드 안내
- 백엔드 모델/ffmpeg 폴더 구조
- 앱 실행 후 sidecar listen 포트 탐지
- `/api/health`, `/api/settings`, `/api/models/status` 응답 확인
- `/api/models/download`, `/api/models/download-status`, `/api/models/download/stop` 응답 확인
- `/api/models/ollama/pull`, `/api/models/ollama/pull-status`, `/api/models/ollama/pull/stop`, `/api/models/ollama/model` 응답 확인
- 필수 모델 누락 목록 출력
- 테스트 후 앱/sidecar 프로세스 종료

현재 루트 점검 명령:

```powershell
corepack pnpm check:quick
corepack pnpm check:release
corepack pnpm check:portable
```

- `check:quick`: 수정 중 반복 실행한다. 프론트 타입체크/린트, 가벼운 백엔드 unittest, 배포 스크립트 계약 테스트를 실행한다.
- `check:release`: 배포 후보에서 실행한다. `check:quick` 범위에 백엔드 API unittest, 업데이트 패키지 테스트, 프론트 사용자 흐름 시뮬레이션을 추가한다.
- `check:portable`: 이미 `releases\lmo_audio`를 만든 뒤 실행한다. `check:release` 범위에 portable 폴더의 읽기 전용 무결성 검사(`-ExistingInstallation`)를 추가한다. 앱 실행 smoke는 빌드 중 깨끗한 중간 빌드 폴더에서 이미 실행하며, 사용자 기록이 있을 수 있는 deploy 폴더에서는 다시 실행하지 않는다.
- 실제 모델을 사용하는 STT smoke는 기본 자동 게이트에서 제외한다. 필요할 때 `scripts\run_release_checks.ps1 -Tier release -IncludeModelSmoke`로 별도 실행한다.
- `check:release`·`check:portable`은 Node 22.6 이상이 필요하다(2026-10-20). `test:generation-flow`·`test:topic-generation-ui`가 `node --experimental-strip-types`로 TypeScript를 바로 불러오기 때문이고, 더 낮은 Node에서는 `bad option: --experimental-strip-types`로 실패한다. 빌드 PC에서 먼저 `node --version`을 확인한다.
- 현재 `check:release`의 백엔드 API unittest는 Ollama 모델 받기/상태/삭제, 직접 입력 모델 저장, 참석자 구분 분석 중 실행 옵션을 포함한다. 프론트 시뮬레이션은 모델 탭 진입, 추천/직접 입력 표시, 참석자 구분 재실행 상태를 일부 확인한다.

## 6-1. 배포·업데이트·전달 스크립트를 바꿀 때 데이터 안전 체크

GPU 준비 확인 잔여 관문(최종 확인2026-10-24): **미완료·다음 배포 전 필요**. 개발 환경 RTX5080의 CTranslate2/앱 관리 Ollama CUDA12/cuDNN 조합에서 실제 음성 인식은 검증했으나 새 Windows 엔진/Tauri 패키지의 증거는 아니다. 기대 증거는 NVIDIA GPU PC의 새 패키지에서 `gpu_detected`/`gpu_usable`, 상태 조회 없는 명시적 CUDA 샘플 완료, Ollama 없음·CUDA12 없음·GPU 없음에서 CPU 선택/복구, 기존 설정·모델·기록 보존 결과다. 해당 증거와 빌드 버전을 기록해야 닫는다. GPU용으로 요약 프로그램 받기를 강제하거나 CUDA13 DLL을 CUDA12로 이름 바꾸지 않는다. 모델 재사용 추론 시간과 최초 GPU 준비 시간을 분리해 기록한다. 관련 수정 `pipeline/transcribe.py`, 실험 `docs/audio-performance-improvement-log.md`.

다음을 바꾸면 리뷰 전에 이 절을 확인한다. 데스크톱과 웹은 화면 코드를 함께 쓰므로 한쪽만 바꿔도 양쪽 표를 본다.

- 데스크톱: `release_portable.ps1`, `verify_portable.ps1`, `create_handoff_package.ps1`, `create_update_package.ps1`, `portable_data_safety.ps1`, `run_release_checks.ps1`
- 웹: `prepare_cloudflare_web.ps1`, `installer\web-local-engine.nsi`, `build_web_local_engine_*.ps1`, `backend\web_local_engine_installer_preflight.py`, `backend\web_local_engine_runtime.py`
- 공통: 앱이 파일을 저장하는 위치, `desktop-app\src\meetingRepository.ts`의 저장 형식(`DB_VERSION`), 화면·엔진 호환 번호(`API_CONTRACT_VERSION`, `SUPPORTED_API_CONTRACT_VERSIONS`)

2026-10-22 웹·데스크톱 병행 작업에서 리뷰가 반복될 때마다 같은 종류의 누락(결과 폴더 → 요약 모델 파일 → 드라이브 상대 경로)이 나왔기 때문에 만든 목록이다. 아래 날짜별 기록은 "무슨 일이 있었나", 이 절은 "다음에 무엇을 볼까"다.

공통 원칙과 이유는 playbook 저장소의 `quality/release-update-data-safety.md`(이 PC에서는 `D:\Projects\playbook\quality\release-update-data-safety.md`)에 있다. 이 절에는 이 프로젝트의 표와 체크 항목만 둔다. 공통 원칙이 추가되면 해당하는 체크 항목만 여기에 더한다.

### 데스크톱 portable (`releases\lmo_audio`)

portable 앱은 프로그램과 사용자 자료가 같은 `lmo_audio` 폴더 안에 섞여 있다. 그래서 업데이트가 폴더를 다룰 때마다 주인을 구분해야 한다. 위치가 늘거나 동작이 바뀌면 이 표부터 고친다.

패키지 파일의 기준은 빌드 manifest의 파일 목록(`portablePayloadFiles`)이다. 업데이트 패키지와 신규 설치 패키지는 폴더를 훑지 않고 이 목록대로 만든다. 사용자 자료가 섞인 `backend\`에서 지우는 파일은 설치본의 이전 manifest 목록에 있고, 그 뒤 바뀌지 않았고, 새 빌드에 없는 것뿐이다. 목록에 없는 파일은 사용자 것으로 보고 둔다. 사용자 자료 위치는 목록에 적혀 있어도, `.`·`..`·끝의 점처럼 다른 표기로 적혀 있어도 Windows가 여는 실제 경로로 판단해 건드리지 않는다. 새 manifest는 작업이 끝난 뒤 마지막에 복사하므로, 중간에 멈춰도 다음 실행이 설치본의 이전 목록을 다시 읽는다.

| 위치 | 주인 | 배포 동기화(`Sync-PortableToDeploy`)·업데이트 패키지(`update_lmo_audio.ps1`) | 신규 설치 패키지 |
| --- | --- | --- | --- |
| `lmo_audio.exe`, `START_HERE.txt`, `release-manifest.json` | 패키지 | 덮어쓴다. manifest는 검증된 빌드의 것을 그대로 복사한다(업데이트 패키지는 적용 기록을 덧붙인다) | 포함. manifest의 파일 목록은 빌드 것을 유지하고 새로 쓴 `START_HERE.txt` 항목만 고친다 |
| `binaries\` | 패키지 | 통째로 맞춘다(`/MIR`) | 빌드 목록대로, 빌드 해시와 대조해 담는다 |
| `backend\` 코드 | 패키지 | 새 코드를 복사하고, 이전 목록에 있던 파일 중 바뀌지 않았고 새 빌드에 없는 것만 지운다. 이전 manifest에 목록이 없으면 지우지 않고 경고한다 | 빌드 목록대로, 빌드 해시와 대조해 담는다. 다르거나 없으면 만들지 않는다 |
| `backend\` 안에 사용자가 둔 파일(예: `outputs - 복사본`, 별칭 모델 위치 `backend\models\stt`·`diarization`), 설치 뒤 사용자가 고친 패키지 파일 | 사용자 | 목록에 없거나 바뀌었으므로 지우지 않는다. 고친 패키지 파일을 새 빌드가 다시 담고 있으면 새 것으로 덮어쓴다 | 제외 |
| `backend\config.json` | 사용자 | 배포 동기화는 없을 때만 기본값을 넣는다. 업데이트 패키지는 건드리지 않는다 | 설치본 것 대신 HEAD 기본값 |
| `backend\outputs`·`temp`·`logs`·`database`, `*.db*`, `*.sqlite*` | 사용자 | 건드리지 않는다. 목록에 들어 있어도 지우거나 덮어쓰지 않는다 | 제외 |
| `models\` | 패키지 + 사용자 다운로드 | 배포 동기화는 `/E`로 추가·갱신만 하고 지우지 않는다(이름이 같은 파일은 빌드 것으로 덮어쓴다). 업데이트 패키지는 건드리지 않는다 | 정한 모델 폴더만 |
| `models\ollama` | 사용자(Ollama 모델) | 건드리지 않는다 | 제외 |
| `runtime\ollama` | 빌드에 `ollama.exe`가 있으면 패키지, 없으면 사용자 | 배포 동기화는 있으면 `/MIR` 통째 교체, 없으면 `/E`로 사용자 것 보존. 업데이트 패키지는 건드리지 않는다 | `README.txt`만. 앱으로 Ollama를 받아 README가 사라졌으면 빌드와 같은 내용으로 되살린다 |
| 그 밖의 `runtime\` | 패키지 | 배포 동기화는 `/E`. 업데이트 패키지는 건드리지 않는다(알려진 한계) | 빌드 목록대로 담는다 |
| 루트 `logs\`, 개인 백업 등 그 밖의 최상위 파일 | 사용자 | 건드리지 않는다 | 제외 |
| WebView 회의 목록(`%LOCALAPPDATA%\com.nifs.smart-minutes-ai\EBWebView`) | 사용자 | 폴더 밖. `-ClearWebViewCache`는 캐시와 `Session Storage`만 지우고 IndexedDB는 보존한다 | 해당 없음 |

### 웹 화면과 설치형 엔진

웹은 배포물이 둘이다. 화면은 Cloudflare에 올리는 순간 모든 사용자에게 바뀌고, 엔진은 사용자가 설치 프로그램을 실행해야 바뀐다. 엔진은 프로그램과 자료가 이미 다른 폴더로 나뉘어 있다.

| 위치 | 주인 | 배포·업데이트 때 | 비고 |
| --- | --- | --- | --- |
| 웹 화면 자산 | 패키지 | 배포 때 전체 교체, 모든 사용자에게 즉시 반영 | `prepare_cloudflare_web.ps1`이 `.tmp\cloudflare-web\dist`에 만든다 |
| 브라우저 회의 목록(IndexedDB) | 사용자 | 배포가 건드리지 않는다. 사이트 주소(프로토콜·도메인·포트)마다 따로 저장된다 | 운영 주소 `https://barorok.ecomarin.workers.dev` |
| 엔진 프로그램 `%LOCALAPPDATA%\Programs\Barorok\LocalEngine` | 패키지 | 설치 프로그램이 준비 폴더에 풀어 교체한다. 새 엔진이 시작되지 않으면 되돌린다 | 정리는 설치 프로그램이 만든 파일 목록 안에서만 한다. 허용하는 웹 주소는 빌드 때 `defaults\engine-settings.json`에 고정된다 |
| 엔진 자료 `%LOCALAPPDATA%\Barorok\LocalEngine`(설정·모델·DB·결과·임시·로그·런타임) | 사용자 | 설치·업데이트·제거 모두 보존한다 | |

### 체크 항목

아래 빈 체크칸은 배포·저장 경계가 바뀔 때 다시 사용하는 검토 기준이다. 이번 후보의 실행 결과는 문서 첫머리의 현재 판정과 날짜별 QA 표에 기록한다. 이 기준 목록 전체가 미완료 작업 목록인 것은 아니다.

데스크톱 업데이트와 공통:

- [ ] **주인 구분**: 앱이 새 파일·폴더를 만들기 시작했다면 위 표에 주인과 업데이트·전달 동작을 먼저 적었다.
- [ ] **설정으로 바뀌는 경로**: `paths.*`, `summary.model`, 활성 양식처럼 사용자가 위치를 바꿀 수 있는 값을 `portable_data_safety.ps1`이 검사한다. 해석 기준은 앱과 같은 `backend` 작업 위치다(상대·드라이브 상대 `D:x`·루트 상대 `\x` 포함). 셸 위치 기준으로 해석하지 않는다. 배포 동기화, 업데이트 패키지 생성과 적용, 신규 설치 패키지에 모두 적용된다.
- [ ] **폴더별 동작 선택**: `/MIR`은 패키지가 전부 소유한 폴더에만 쓴다. `/E`는 버전이 섞여도 안전한 폴더에만 쓴다. 섞이면 고장 나는 실행 파일 묶음은 통째로 교체한다.
- [ ] **지울 파일의 근거**: 사용자 자료가 섞인 폴더(`backend\`)에서는 설치본의 이전 manifest 목록에 있고 그 뒤 바뀌지 않은 파일만 지운다. 폴더를 훑어 "새 빌드에 없으니 지운다"로 판단하지 않는다. 공통 규칙은 `portable_data_safety.ps1`의 `Remove-StalePortablePackageFiles`·`Test-PortableUserDataPath`에 있다.
- [ ] **시험 실행 위치**: 앱을 실제로 켜는 smoke는 중간 빌드 폴더에서만 실행한다. `releases\lmo_audio`는 `-ExistingInstallation`으로 읽기만 한다. 검사를 통과시키려고 기록·로그·설정을 지우지 않는다.
- [ ] **비교 기준**: 설치본 무결성은 검증된 빌드 manifest와 비교한다. 동기화 뒤 대상 폴더로 manifest를 다시 만들지 않는다. 다시 만들면 잘못 복사된 파일도 정상으로 기록된다.
- [ ] **앱이 스스로 바꾸는 파일**: 설치 후 앱이 바꾸는 파일(`backend\config.json`, Ollama 설치로 사라지는 `runtime\ollama\README.txt`)을 알고 있다. 검사 예외는 정확한 파일과 조건으로만 둔다.
- [ ] **종료 범위**: 프로세스 종료는 그 설치 폴더 안의 실행 파일 경로로만 고른다. 이름이나 명령행으로 넓게 고르지 않는다. 웹 엔진(17863)과 다른 설치본은 종료하지 않는다.
- [ ] **두 제품 공존**: 데스크톱 포트는 17864부터 고르고 17863은 쓰지 않는다. 기록·설정 위치는 제품마다 따로 둔다. RAM·GPU·시스템 Ollama 공유는 허용된 제약이며 완전 격리로 설명하지 않는다.
- [ ] **업데이트 패키지·신규 설치 패키지**: 빌드 manifest 목록대로 담고, 설치본 파일을 빌드 해시와 대조한다. 다르거나 빠진 파일이 있으면 만들지 않는다. 설정은 담지 않거나(업데이트) HEAD 기본값으로 넣는다(신규 설치 패키지). 목록에 없는 `backend` 안 개인 파일은 담기지 않는다.
- [ ] **테스트 방식**: 임시 fixture로만 시험하고 `releases\lmo_audio`나 실행 중인 앱은 쓰지 않는다. 수정 전 코드에서 새 테스트가 실패하는지 확인한다. 실행 전후 파일 해시로 보존을 확인한다.
- [ ] **확인 명령과 문서**: `check:portable`, `verify:portable`, 릴리스 스킬, 이 문서의 작업 순서가 현재 흐름과 같다. 예전 명령이 남으면 정상 빌드도 실패로 보인다.
- [ ] **커밋 범위**: 여러 세션이 같은 작업 트리를 바꿨다면 검토한 변경만 커밋한다. 빌드 전에 커밋해 manifest가 HEAD를 가리키게 한다.
- [ ] **중간에 멈췄을 때(알려진 한계)**: `Sync-PortableToDeploy`는 준비 폴더나 되돌리기 없이 `releases\lmo_audio`에 바로 복사한다. 디스크 부족이나 잠긴 파일로 중간에 멈추면 새 버전과 이전 버전이 섞인 설치본이 남을 수 있다. 사용자 자료는 동기화 대상이 아니므로 그대로 남는다. 복구는 원인을 해결한 뒤 `scripts\build_user_release.ps1 -SkipSidecarBuild -SkipTauriBuild`로 동기화와 읽기 전용 검사를 다시 하는 것이다. 동기화 방식을 바꿀 때는 준비 폴더와 되돌리기를 함께 검토한다.

웹 화면과 설치형 엔진:

- [ ] **저장 위치를 정하는 식별자 유지**: 아래 값을 바꾸지 않는다. 꼭 바꿔야 하면 기록 이전과 엔진 업데이트 계획을 같은 릴리스에 넣는다.
  - 운영 웹 주소(프로토콜·도메인·포트): 바꾸면 브라우저의 기존 회의 목록이 보이지 않고, 설치된 엔진이 허용한 웹 주소(빌드 때 고정, `validate_production_web_origin`)와도 달라져 연결이 거부된다.
  - 데스크톱 앱 식별자 `com.nifs.smart-minutes-ai`(`tauri.conf.json`): WebView 저장소 폴더를 정한다. 브랜드 이름이 바뀌어도 이 값은 유지한다.
  - IndexedDB 이름 `MeetingHistoryDB`: 바꾸면 웹과 데스크톱 모두 기존 회의 목록이 빈 것처럼 보인다.
  - Tauri 메이저 업그레이드: WebView 주소나 프로필 경로가 바뀌는지 확인하고, 이전 버전이 만든 기록이 보이는지 시험한다.
- [ ] **저장 형식 버전**: `DB_VERSION`은 올리기만 한다. 올릴 때는 이전 형식을 읽어 올리는 코드와 테스트를 같이 둔다. 화면을 예전 빌드로 되돌릴 때는 그 빌드의 `DB_VERSION`이 운영 중인 값보다 낮지 않은지 확인한다. 낮으면 브라우저가 기존 저장소를 열지 않는다. 데스크톱 WebView도 같은 코드라 함께 해당한다.
- [ ] **화면·엔진 호환**: 화면은 즉시 바뀌고 엔진은 늦게 바뀐다. 호환 번호를 바꾸기 전에, 새 화면이 아직 업데이트하지 않은 엔진을 만났을 때 무엇을 보여 줄지(업데이트 안내) 먼저 정하고 시험한다. 한 번에 한쪽만 올려도 동작하도록 순서를 정한다.
- [ ] **엔진 설치 프로그램 약속**: 실행 중인 엔진은 `--stop`으로 멈추고 멈춤을 확인한 뒤 교체한다. 설치 프로그램이 만든 파일 목록 밖은 지우지 않는다. 새 엔진이 시작되지 않으면 되돌린다. 제거해도 자료 폴더는 남긴다. 이 동작을 바꾸면 기존 설치본 위 실제 업데이트로 파일 해시와 자료 보존을 대조한다.

### 알려진 한계

- **같은 PC의 포장 실패와 복구(2026-10-22)**: clean `7addaa7`의 전체 빌드에서 sidecar와 Tauri 실행 파일은 성공했으나, 오래된 `resources/backend/__pycache__`의 Python3.13 캐시3개가 그대로 복사되어 중간 runtime preflight가 거부했다. 배포 동기화 전이므로 기존 deploy는 변경하지 않았다. `package_desktop_portable.ps1`의 backend 복사 경계에서 캐시·결과·임시·로그·DB를 제외하고 복사 오류를 전파하도록 수정했다. 실제 복사 진입문을 격리 fixture에서 실행한 회귀 검사는 수정 전 실패·수정 후 통과, 원본 SHA 불변을 확인했고 독립 검토도 통과했다. 이 수정은 실행 코드나 화면 자산을 바꾸지 않으므로 검증된 sidecar·Tauri 산출물을 유지하고 `build_user_release.ps1 -SkipSidecarBuild -SkipTauriBuild -NoClearWebViewCache`로 포장·manifest·smoke·deploy 검사를 다시 진행해 통과했다. 캐시를 지우거나 사용자 자료 정리를 해서 verifier를 우회하지 않는다.

- **이 PC의 후보·보존 검사(2026-10-22, `D:\Projects\audio`)**: 최초 deploy는 `7cb39ac`/dirty=false(2026-06-08)였다. 원격 `77555e3`와 검토한 UI 변경을 합치고 요약 실험은 별도 stash에 보존한 clean `7addaa7`에서 sidecar·Tauri 전체 빌드를 완료했다. 위 복사 경계 수정 뒤 clean `eb79082`로 재포장하여 중간 runtime smoke·4형식 export·deploy 읽기 전용 무결성 검사가 통과했다. 원래 deploy의 설정·모델20개 SHA는 동일하고 모델 안내 파일1개만 패키지 내용으로 갱신됐다. 격리한 구버전 복사본·별도 WebView 프로필에 합성 기록과3초 음성을 넣은 뒤 실제 업데이트를 적용했고, 설정·모델·결과·음성·사용자 파일·로그25개 SHA 불변과 같은 프로필의 기록/대화록 재열기·음성 재생을 확인했다(데스크톱17864). 기록은 IndexedDB에 직접 넣었으므로 실제 STT·새 회의 생성·자동 저장 성공의 근거로 쓰지 않는다. 최종 clean `beb3554`로 재포장·중간 smoke·deploy 무결성 검사 후 `corepack pnpm package:update`와 `corepack pnpm package:handoff`를 순차 완료했다. 최종 업데이트를 같은 시험 복사본에 실제 적용해25파일 SHA 불변·기록 재열기·음성 재생 시작을 다시 확인했다. 신규 설치 패키지 `lmo_audio_no_ollama_no_whisper_beb3554.zip`은474,053,423바이트·4,995항목이며 Ollama 실행 환경·Whisper를 제외했다. 별도 추출본과 새 WebView 프로필에서 초기 화면·모델 받기 안내·자체 backend17864를 확인했다. 최초 CDP 검사에서 페이지 생성 전 접속해 대상 미발견으로 실패했으며, 실제 URL/엔진 응답을 확인하고 검사 도구의 페이지 준비 대기만 보완해 통과했다(최초 로그 보존). 후속으로 같은 최종 후보에서 고정30초 실제 음성을 UI로 분석해15구간 자동 저장·참석자 구분3개 ID를 확인했다. 실제 프로세스 종료/같은 프로필 재실행 후 동일 대화록·서버 결과 SHA와30초 음성 완주를 확인했으며 보호24파일·원본 음성은 불변이었다. 서버 로그에서 최초 분석/구분 POST200은 각각1회이고 재시작 뒤 추가 분석/생성 POST는0이다. 이 표본의 처리·저장·복원 동작만 확인했으며 인식/화자 정답 정확도·요약 생성·다른 PC·새 모델 다운로드 복구는 미검증이다. 근거 `real-qa-complete.json` 및 오디오 성능 로그의 같은 날짜 절; 기존 release QA 미완료 관문을 유지한다. 최종 근거는 같은 폴더의 `final-user-preservation.json`, `verify-native-result.json`, `handoff-artifact.json`, `handoff-native-result.json`, `final-original-user-preservation.json`, `build-source-correspondence.json`이다. 근거: `.tmp/release-candidate-20261022`의 `original-user-preservation.json`, `qa-user-preservation-after-update.json`, `seed-native-result.json`, `verify-native-result.json`. 아래 다른 PC의 `a150589b` 이력과 구분한다.

- **후속 판정: 배포 보류.** 실제 요약 QA에서 frozen Python의 SSL 정책 리소스 `codex-rejected-cas.pem`(906바이트) 누락을 확인했다. QA 복사본에 원본 파일만 추가하면 요약 POST200·자동 저장·재실행 보존이 통과한다. `scripts/package_backend_sidecar.ps1`에 빌드 Python의 TLS 초기화 사전 검사와 해당 리소스 수집을 추가했고 실제 최소 frozen 회귀 검사1개·독립 검토를 통과했다. 인증서 검증은 유지한다. 기존 `beb3554` deploy/ZIP/update에는 수정이 없으므로 전달 승인으로 해석하지 않는다. 새 clean 빌드·manifest/리소스 확인·재포장·실물 요약 회복 검증 후에만 배포 가능하다.
  - QA 증거: `summary-result.json`, `summary-reopen-result.json`, `summary-export-validation.json`, `qa-ssl-runtime-fix.json`, `frozen-probe-trace.json`, `frozen-probe-resource-fixed.json` (`.tmp/release-candidate-20261022`). 기록 정리 MD/DOCX/HWPX는 실제 요약 포함, 대화록 TXT는 실제 발언 포함을 확인했다. ZIP CRC·XML 검사이며 Word/한컴 화면 렌더링 검사는 아니다. UI의 초기 모델 준비 표시 불일치는 설정의 상태 다시 확인으로 회복한 관찰이며 별도 UI 채팅에 전달했다.

- **기본 업데이트 명령 복구(2026-10-22)**: 실제 `powershell -File update_lmo_audio.ps1 -TargetDir ...`에서 매개변수 기본값의 `$PSScriptRoot`가 비어 적용 전에 실패했다. `verify_update.ps1`도 같았다. 두 스크립트 모두 본문에서 기본 패키지 경로를 확정하도록 고쳤으며, 회귀 검사는 실제 `-File` 호출에서 `-PackageDir`를 생략한 적용과 단독 검증을 실행한다. 업데이트 검사15개·독립 검토와 실제 구버전 복사본 업데이트가 통과했다. `eb79082` 패키지에 이 수정만 덧씌운 시험 산출물은 QA 전용이며 배포하지 않는다. 최종 산출물은 수정 커밋 후 clean HEAD로 다시 생성한다.

2026-10-22 빌드 전 검토에서 나온 업데이트 패키지·신규 설치 패키지 위험(backend 로그·DB·알 수 없는 파일 삭제와 유출, 앱으로 Ollama를 받은 설치본의 README 실패, 신규 설치 패키지의 비교 기준, Whisper를 넣은 신규 설치 패키지 검사)은 같은 날 위 규칙으로 고쳤다. 남은 한계는 다음과 같다.

- **빌드 목록이 없는 설치본**: 2026-06-01 이전 빌드처럼 manifest에 `portablePayloadFiles`가 없거나, 2026-10-22 이전에 만든 신규 설치 패키지로 설치해 목록이 빌드 것이 아니면(`handoff.payloadList`가 `build`가 아님), 새 빌드에 없는 backend 파일을 지우지 않고 경고만 한다. 예전 신규 설치 패키지의 목록은 폴더를 훑어 만든 것이라 사용자 복사본이 섞여 있을 수 있기 때문이다. 오래된 코드 파일이 남을 수 있지만 사용자 자료는 지우지 않는다.
- **업데이트 패키지는 `runtime\`을 담지 않는다**: 지금 빌드의 `runtime`에는 Ollama 안내 파일만 있어 영향이 없다. `verify_update.ps1`은 업데이트가 담는 앱·`binaries`·`backend`만 확인하고, 적용 뒤 대상 manifest의 `runtime` 항목은 설치본의 이전 항목을 유지한다. 새 빌드가 `runtime`에 파일을 더하면 업데이트 패키지로는 전달되지 않으므로, 그때는 업데이트 패키지 범위를 먼저 넓힌다.
- **나중에 넣은 Whisper의 크기**: `-ExistingInstallation`은 신규 설치 패키지에서 뺀 Whisper가 들어온 것을 허용하지만, 기대 크기를 모르므로 표식 파일이 있는지만 본다. 잘린 모델 파일은 앱의 모델 상태 화면에서 확인한다.
- **다른 PC의 중단 이력 — 2026-10-22(현재 PC의 완료 결과는 위 항목)**: 위 보호 규칙의 실제 `package:update` 적용과 최신 신규 설치 패키지 생성은 아직 하지 않았다. 기존 deploy는 `a150589b`/dirty=false이며 읽기 전용 무결성 검사를 통과했다. 별도 복사본·별도 WebView 프로필에서는 실제30초 음성의 대화록·2명 구분·자동 저장과 음성 파일 로드까지 확인했지만, 재시작/업데이트 후 재열기·재생은 미검증이다. 분석6분12초는 동시 파일 복사와 가용 메모리0.8GB/5%가 겹친 조건으로 성능 정상 판정에 쓰지 않는다. 재포장에 필요한 중간 sidecar가 없어 검증된 deploy에서 복구했고, 후속 포장은 deploy 동기화 전 파일 복사 중 중지했다. 중간 portable 폴더는 미완성이며 배포물로 쓰지 않는다. 다음 확인은 실모델 실행 없이 `build_user_release.ps1 -SkipSidecarBuild -SkipTauriBuild -NoClearWebViewCache`를 끝낸 뒤 업데이트·신규 설치 패키지를 순차 생성하는 것이다. 종료 조건은 clean/HEAD manifest·중간 smoke·deploy 무결성 통과, 별도 시험 복사본에 실제 업데이트 후 설정/모델/기록 보존, 같은 WebView 프로필의 대화록·음성 재열기/재생, 새 ZIP의 별도 폴더 첫 실행이다. 원본 deploy 사용자 파일35개·기존 IndexedDB8개는 종료 시 SHA 불변이다. 근거와 복원 명령은 `.tmp/release-real-qa-20261022` 및 `todo.md`의 같은 항목에 보관하며, 웹·데스크톱 공존의 최종 판정은 기존 release QA 표를 계속 사용한다.

구조 개선 후보(미결정): 사용자 자료를 프로그램과 분리된 `data` 폴더나 `%LOCALAPPDATA%`로 옮기면 업데이트를 "프로그램 폴더 통째 교체"로 단순화할 수 있다. 웹 설치 엔진은 이미 `%LOCALAPPDATA%\Barorok\LocalEngine`을 쓴다. 기존 설치본 이전 절차가 필요하므로 별도 범위로 검토한다.

### 설정 모델 검색 변경 출시 전 QA (2026-10-24)

| 항목 | 상태 | 필요한 증거·종료 조건 | 마지막 확인 |
| --- | --- | --- | --- |
| 통합 설정 실제 화면 | 개발환경 배치·실제 모델 흐름 완료, 배포 QA 대기 | 모의 UI·타입·린트·독립 검토 통과. 기존 인앱 탭에 정상 재연결했고 앞선 승인 거부의 정확한 계기는 미확정이나 현재 차단은 재현되지 않았다. 현재 사용자 설정으로1360×900/860×720을 직접 확인: 열 간격24px·내부16px, 모델 버튼32px, CPU/HWPX148px·문자공간22px·같은 기준선, 가로/설정 세로 넘침0·저장 전체 표시. 근거 `.tmp/settings-live-20261024`, `.tmp/settings-inset-20261024`, `.tmp/settings-text-outline-20261024`. 후속 `.tmp/settings-buttons-live-20261024`에서 `요약 모델` 제목, 실제 E2B→E4B 선택 저장·재접속 및 E2B 복귀, 공식 검색→목록 이동·도움말, 새 삭제 확인→취소를 확인했다. 기존 native confirm 검증 중 E4B가 의도와 달리 실제 삭제되어 공식 같은 태그로 재다운로드·SHA 검증·실제 목록 복원을 완료했다. 원래 E2B 선택 유지, 복원용 임시 서버 종료. 명시적 React 확인 UI로 수정했고 취소·Esc·X는DELETE0/확인만DELETE1을 모의 검증했다. 후속 버전 호환 수정에서 실제 등록→받기 거부→업데이트→받기 완료→선택·재열기를 확인했다(아래 행). 최신32px 공통 열 간격과 모델 설명 툴팁 제거도1360×900/860×720 실제 화면에서 넘침 없이 확인했다. 설치형 배포 QA는 아래 행의 조건을 따른다. | 2026-10-24 |
| 공식 Ollama 목록 구조 호환성 | 대기 | 공식 검색 API가 없어 제한된 공개 페이지 파서 사용. 개발 Python에서 실제 llama3.2:1b 목록/manifest 조회와 집중 검사18개 통과. 최신 설치형 연결 프로그램에서 검색·목록 추가(자동 받기/선택 없음), 조회 실패 안내, 구형 연결 프로그램404 업데이트 안내까지 확인하면 종료. | 2026-10-24 |
| 실제 모델 받기 버전 호환성과 오류 안내 | 개발환경 수정·실제 흐름 완료, 배포 QA 대기 | 앱 전용0.30.6의 실제 E4B 세부 태그 받기 거부를 재현하고 업데이트 안내/버튼을 확인했다. 설정의 명시적 업데이트로 공식 SHA 검증된0.40.10 적용·API 버전 확인, 같은 태그의 받기 완료(exit0)→선택→설정 재열기 유지까지 통과했다. 기존 E4B 큰 파일을 재사용한 실제 받기이며 전체6.6GB 재전송으로 세지 않는다. 원래 E2B 선택 복원, 기존2개 모델 manifest SHA·blob 크기와 업데이트 전후 설정 보존, 시스템11434 유지. 근거 `.tmp/ollama-update-20261024`의 실제 JPG3개와 final-verification.json. backend34검사·화면 모의 흐름·타입/lint·독립 검토 통과. 실패/롤백은 임시 fixture로 검증했다. 새 설치형 엔진·HTTPS 웹 또는 portable 패키지에서 같은 흐름과 보존 증거를 확인해야 배포 QA를 종료한다. | 2026-10-24 |

## 7. Tauri 데스크톱 portable 배포 흐름

이 절은 Windows Tauri 데스크톱 EXE와 portable 패키지에 적용한다. HTTPS 웹 배포와 웹 연결용 Windows 설치형 엔진의 제작·배포 절차는 문서 첫머리의 대상별 링크를 따른다. 여러 대상을 함께 배포할 때도 대상별 산출물과 검증 결과를 각각 남긴다.

혼돈을 줄이기 위해 실제 배포 기준은 `releases\lmo_audio` 폴더 하나로 고정한다. Tauri target 폴더는 중간 산출물이며 사용자가 직접 실행할 기준 폴더가 아니다.

### 고정 작업 순서

배포가 필요한 변경은 아래 순서를 기본으로 한다. 순서를 바꾸는 경우에는 final summary에 이유를 남긴다.

배포 필요 여부는 다음 기준으로 판단한다.

- 문구, 아이콘, 단순 배치만 바뀌고 저장/분석/내보내기/설정/모델/sidecar에 영향이 없으면 좁은 프론트 검증까지만 할 수 있다.
- 분석 시작, 진행 상태, 중지/취소, 이어하기, 참석자 구분, 기록 정리, 저장/다운로드, 설정, 모델 상태, 경로, Tauri command, sidecar API가 바뀌면 데스크탑앱 한계 체크를 함께 한다.
- 백엔드 Python, 패키징 리소스, 모델 경로, ffmpeg, Tauri/Rust, release script가 바뀌면 최종 portable 빌드와 `verify_portable.ps1` 검증 대상이다.
- 회사 전달, 실행 파일 재생성, zip/update package 생성, "빌드" 요청은 항상 사용자용 portable 배포 흐름으로 본다.
- 공유/전달/다른 PC 실행 목적이면 전체 `releases\lmo_audio` 폴더가 아니라 `corepack pnpm package:handoff`로 만든 슬림 zip을 기본 전달 산출물로 보고한다. 전체 폴더 크기는 검증 원본 크기로만 구분하고, 사용자가 전체 모델 포함 배포를 명시하지 않았으면 최종 전달물처럼 말하지 않는다.

1. 변경 범위를 분류한다: 웹 UI, 데스크탑/Tauri, 백엔드, 배포 스크립트, 모델/성능.
2. 변경 범위에 맞는 좁은 검증을 먼저 실행한다.
   - 공통 빠른 점검: `corepack pnpm check:quick`.
   - 프론트엔드: `corepack pnpm --dir desktop-app run typecheck`, `corepack pnpm --dir desktop-app run lint`, 필요한 `desktop-app/scripts/simulate-*.mjs`.
   - Tauri/Rust: `cargo check` in `desktop-app\src-tauri`.
   - 백엔드: 관련 Python unittest 또는 `py_compile`.
3. 서버 재시작, 취소/삭제, 이어하기, 저장/내보내기, 배포, 긴 파일 처리처럼 사용자 작업 손실이나 운영 위험이 있으면 큰 관점/작은 관점 리뷰를 실행한다. 리뷰에는 0-1의 데스크탑앱 한계 체크를 포함한다. 배포·업데이트·전달 스크립트나 저장 위치가 바뀌었으면 6-1의 데이터 안전 체크도 포함한다.
4. 리뷰 지적을 반영하고 다시 좁은 검증을 통과시킨다.
5. 배포 빌드 전에 변경 사항을 커밋한다. 최종 사용자용 manifest는 커밋된 HEAD를 가리켜야 한다.
6. 루트에서 `corepack pnpm build`를 실행한다.
7. 실패하면 레이어를 나눠 확인한다: sidecar packaging, Tauri exe build, portable packaging, deploy-folder verify.
8. 빌드 출력에서 중간 빌드 폴더의 smoke 통과와 `Portable installation integrity verified`를 확인한다. 다시 확인할 때는 `scripts\verify_portable.ps1 -PortableDir releases\lmo_audio -ExistingInstallation`(`corepack pnpm verify:portable`)을 사용한다.
   - 전체 자동 게이트로는 `corepack pnpm check:portable`을 사용한다.
   - `-ExistingInstallation` 없이 deploy 폴더에 smoke를 실행하면 기록·로그가 있는 설치본에서는 실행 전에 거부된다. 검사를 통과시키려고 기록·로그·설정을 지우지 않는다.
9. `releases\lmo_audio\release-manifest.json`의 `commit`이 `git rev-parse HEAD`와 같고 `dirty=false`인지 확인한다.
10. 공유/전달 목적이면 `corepack pnpm package:handoff`를 실행하고 zip 경로, 크기, 포함/제외 모델 검수 결과를 기록한다.
11. `git fetch origin` 후 behind가 없을 때 `git push origin main`을 실행한다. push 조건은 `AGENTS.md` 「브랜치·배포 공통 규칙」 2를 따른다. pre-push hook이 없는 지금은 커밋까지만 하고 사용자 확인 뒤 push한다. `--no-verify`·force-push는 쓰지 않는다.
12. 포터블 데스크톱 전달물은 `release-manifest.json`의 commit과 handoff·update 파일 이름의 commit으로 식별하며 태그를 따로 만들지 않는다(`tauri.conf.json`의 `0.1.0`은 릴리스 버전이 아니다). 웹 연결용 설치 엔진을 새로 공개하면(`deploy/cloudflare/release.json`의 `engineVersion` 갱신) 그 설치 파일을 빌드한 커밋에 annotated 태그 `v<engineVersion>`(예: `v0.1.10-beta-20261021`)을 만들고 메시지에 설치 파일 SHA256·크기, 검증 결과를 적는다. 태그 push도 사용자 확인 뒤 한다. 웹 Worker 배포는 같은 블록의 규칙 4·5·7(`prod-YYYY-MM-DD.N`)을 따르고, 클라우드 세션에서는 실행하지 않는다.

단순 문구/아이콘 변경처럼 배포가 필요 없는 경우에는 5~10번과 12번을 생략할 수 있다. 사용자가 "빌드" 또는 "전달"을 요청한 경우에는 5~10번을 생략하지 않는다.

정식 배포 갱신:

```powershell
corepack pnpm build
```

위 명령은 루트 `package.json`의 `build` 스크립트이며, 내부적으로 `scripts\build_user_release.ps1`를 실행한다. 이 프로젝트에서 사용자가 단순히 "빌드"라고 하면 Vite 웹 자산 빌드가 아니라 이 포터블 배포 빌드를 기본값으로 해석한다.

동일한 작업을 PowerShell로 직접 실행할 때:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_user_release.ps1
```

이미 exe와 sidecar를 새로 만든 뒤 복사/검증만 다시 할 때:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\build_user_release.ps1 -SkipSidecarBuild -SkipTauriBuild
```

`desktop-app` 안의 `pnpm build`는 `desktop-app\dist`의 Vite 웹 자산만 만든다. 사용자에게 전달할 실행 폴더를 갱신했다는 의미로 사용하지 않는다.

배포 스크립트가 하는 일:

- `releases\lmo_audio` 안의 실행 파일로 실행 중인 앱·sidecar만 종료한다. 다른 설치본이나 웹 엔진은 종료하지 않는다.
- 필요 시 WebView 렌더 캐시만 지우고 IndexedDB 회의 기록은 보존한다.
- Tauri 리소스와 중간 portable 폴더를 다시 구성하고 `release-manifest.json`에 exe, sidecar, backend, runtime 파일 해시를 기록한다.
- 중간 portable 폴더에서 `scripts\verify_portable.ps1`로 manifest 해시와 실행 smoke test를 확인한다.
- `releases\lmo_audio`에는 패키지 코드만 동기화하고 설정·기록·로그·다운로드 자원을 보존한다. 빌드 manifest를 그대로 복사한다.
- `releases\lmo_audio`는 `-ExistingInstallation`으로 실행 없이 읽기 전용 검사한다.

문제가 반복될 때는 먼저 진단 스크립트로 실제 실행 파일, 프로세스, 포트, 모델, manifest를 확인한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\diagnose_portable.ps1
```

### 패키지 명칭과 용도

문서와 사용자 안내에서는 **업데이트 패키지 / 신규 설치 패키지**로 통일한다. ZIP은 압축 형식이므로 용도 명칭과 별도로 표시한다. `package:handoff` 같은 명령·파일명·경로·스키마 식별자는 유지한다.

| 구분 | 업데이트 패키지 | 신규 설치 패키지 |
| --- | --- | --- |
| 용도 | 기존 설치의 프로그램 갱신 | 새 PC 또는 새 폴더에서 시작 |
| 앱·백엔드 | 포함 | 포함 |
| 설정·모델 | 기존 설정·모델 사용 | 기본 설정·참석자 구분 모델 포함 |
| 적용 방식 | 업데이트·검증 스크립트로 기존 설치에 적용 | ZIP 압축 해제 후 필요한 자원 준비 |
| 사용자 기록 | 기존 기록 보존 | 기존 사용자의 기록 제외 |

현재 신규 설치 패키지는 Whisper 모델·Ollama 실행 파일·Ollama 요약 모델 데이터를 제외하므로 별도 준비가 필요하다. 업데이트 패키지도 이 자원을 포함하지 않는다. 핵심 프로그램 파일은 대부분 공통이며, 압축 여부가 두 패키지의 차이는 아니다.

### 기존 설치본용 수동 업데이트 패키지

이미 사용자 PC에 `lmo_audio\models`가 준비되어 있으면 전체 모델을 다시 전달하지 않고 업데이트 패키지만 만들 수 있다. 이 패키지는 빌드 manifest에 있는 앱·`binaries`·`backend` 파일만 포함하고, 대상 PC의 `models`, `runtime`, `backend\config.json`, `backend\outputs`·`temp`·`logs`·`database`, DB 파일, 그리고 대상의 이전 manifest 목록에 없는 `backend` 파일은 보존한다(6-1 표).

업데이트 패키지는 변경 사항을 커밋하고 깨끗한 portable 빌드가 끝난 뒤 만든다. `create_update_package.ps1`는 기본적으로 `release-manifest.json`의 commit이 현재 `HEAD`와 같은지 확인한다. 로컬 테스트에서만 `-AllowStale`을 쓴다.

```powershell
corepack pnpm package:update
```

직접 실행할 때:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\create_update_package.ps1
```

기본 산출물은 `releases\updates\lmo_audio_update_<commit>`이다. 이 폴더 안에는 `payload`, `update-manifest.json`, `update_lmo_audio.ps1`, `verify_update.ps1`, `portable_data_safety.ps1`가 들어간다. `payload\models`와 `payload\backend\config.json`이 있으면 잘못 만든 패키지로 본다.

### 신규 설치 패키지(ZIP)

새 PC에 전달하되 2GB 이상 Whisper 모델, Ollama 실행 파일, Gemma 등 Ollama 요약 모델 데이터를 제외하려면 풀 portable 빌드가 끝난 뒤 아래 명령을 사용한다. 요약 프로그램과 요약 모델은 대상 PC에서 앱 설정 화면으로 받는다.

Codex가 사용자에게 배포 결과를 보고할 때는 이 zip을 먼저 제시한다. `releases\lmo_audio`는 로컬 검증 원본이며, 크기가 수 GB가 될 수 있으므로 일반 전달물로 오해시키지 않는다.

```powershell
corepack pnpm package:handoff
```

기본 산출물은 `releases\handoff\lmo_audio_no_ollama_no_whisper_<commit>.zip`이다. 이 zip은 앱, 백엔드, sidecar, 설정 파일, `runtime\ollama` placeholder(설치본에서 앱으로 Ollama를 받아 README가 사라졌으면 빌드와 같은 내용으로 되살린다), `models\speaker-diarization-community-1`을 포함하고, `runtime\ollama\ollama.exe`, `models\faster-whisper-large-v3`, `models\ollama`의 실제 요약 모델 데이터는 제외한다. 예전처럼 `no_models`로 만들면 참석자 구분 모델까지 빠져 사용자가 다시 준비해야 하므로 피한다.

슬림 zip 검수 기준:

- zip 안에 `lmo_audio\models\speaker-diarization-community-1\config.yaml`이 있어야 한다.
- zip 안에 `lmo_audio\runtime\ollama\ollama.exe`는 없어야 한다.
- zip 안에 `lmo_audio\models\faster-whisper-large-v3\model.bin`은 없어야 한다.
- zip 안에 `lmo_audio\models\ollama` 모델 데이터는 없어야 한다.
- `START_HERE.txt`와 `models\README.txt`가 Whisper 모델을 넣을 위치를 안내해야 한다.
- 회사 PC에서 Whisper 모델을 넣기 전에는 대화록 작성이 준비 필요 상태로 보일 수 있다.

슬림 zip을 빈 폴더에 풀어 구조와 sidecar 실행을 검증할 때는 `-Handoff` 모드를 사용한다. 이 명령은 읽기 전용 검사가 아니며 health/settings/models 조회, 설정 시험 후 원래 바이트 복원, 4형식 export smoke를 실행한다. 사용자 기록이 없는 새 추출본에서 UI 첫 실행 전에 한 번 실행하고 종료·시험 산출물 정리를 확인한다. Tauri EXE 창의 첫 실행은 별도로 확인한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify_portable.ps1 -PortableDir <압축을 푼 경로>\lmo_audio -Handoff
```

실행 없이 신규 설치 구조·무결성만 읽을 때는 위 명령에 `-ExistingInstallation`을 함께 지정한다.

#### 신규 설치 ZIP 실물 점검 결과 — 2026-10-25

기존에 clean 빌드·runtime 검증한 `1ebd2d9` 후보를 그대로 사용해 worktree 루트에서 `corepack pnpm package:handoff`를 실행했다. `AllowDirty`·`AllowStale` 없이 exit0이고, 소스/manifest의 HEAD 일치·dirty=false를 확인했다. 현재 원본 작업 폴더의 다른 미커밋 기능을 포함한 새 빌드로 설명하지 않는다.

| 항목 | 결과·증거 |
| --- | --- |
| 실제 ZIP | 통과. `releases/handoff/lmo_audio_no_ollama_no_whisper_1ebd2d9.zip`, **474,057,309바이트 / 4,996항목**. SHA256 `e8c20748611808f4cc16f436e34e82ccebd1dd8cfd6289dbb4b271848a49779e`. 검증 후 원본 프로젝트의 전달 폴더로 복사하고 SHA를 다시 맞췄다. |
| 구성·개인 자료 제외 | 통과. 경로/심볼릭 링크 안전 검사와 전체 CRC 검사를 포함해 빈 QA 폴더에 추출했다. EXE·sidecar·ffmpeg·참석자 구분 모델·Ollama 준비 안내·SSL 정책 파일 포함. Whisper·Ollama 실행 파일/요약 모델 데이터, outputs/temp/logs/DB·기존 시험 job/제목은 제외됐다. |
| 기본 설정·출처 | 통과. ZIP의 `backend/config.json` 바이트가 `HEAD:backend/config.json`과 정확히 같았다(SHA `5de0397fbc9ab50ee8b0eb238c52e823410a311c5400f7914d4ce98e7892f56f`). EXE SHA는 앞선 실제 장애/데이터 QA 후보와 같다. |
| 새 추출본 `-Handoff` 실행 검증 | 통과. 구조/해시·실제 sidecar health/settings/models·4형식 export smoke 전체 PASS. Whisper 누락은 신규 설치 정책에 맞게 판정했다. 설정 원래 바이트 복원과 outputs/temp/logs/database 파일0을 확인한 뒤 UI를 실행했다. |
| 실제 EXE 첫 실행 | 통과. 별도 fresh WebView 프로필·실제 부모 PID/경로와 backend 경로 일치. 기존 회의0건, `모델을 받아야 분석할 수 있습니다`·음성 인식 준비 안내, `모델 받기`→설정의 `음성 인식 모델 받기` 경로를 실제 조작해 확인했다. 모델 다운로드/실제 분석은 시작하지 않았다. |
| 정상 종료·원본 보호 | 통과. native 제목줄 X로 종료한 뒤 소유 앱·sidecar·WebView 및17864리스너0. 원본 설치본/기본 프로필 보호10파일 SHA·모델20파일 크기/mtime 불변. |

근거는 `.tmp/new-install-qa-20261025/{archive-report,after-smoke,first-start-health,ownership,cleanup,final-report}.json`, `inspect-extract.log`, `verify-handoff.log`, 첫 화면/모델 준비 UI 관측·PNG에 보존한다. 이 PC에는 WebView2와 시스템 Ollama가 있었으므로, 새 PC에서 둘 다 없는 조건이나 회사 보안 정책을 통과했다고 하지 않는다. 모델 준비 전 실제 분석 성공을 이 ZIP 첫 실행의 합격 기준으로 삼지 않으며, 첫 모델 준비/분석과 일반 권한·다른 PC 항목은 별도 인계 목록을 따른다.

최종 독립 agent 검토에서 ZIP 실물·출처/기본 설정·자료 제외·실제 sidecar/EXE·새 프로필·모델 준비 안내·정상 종료/원본 보호 증거가 일치했고, 현재 범위의 차단 지적/P2는 없었다. 문서의 `-Handoff` 실행 범위도 실제 동작에 맞게 보완했다.

신규 설치 패키지는 설치본이 빌드 manifest와 같을 때만 만들어진다. 설치본의 패키지 파일이 빌드 뒤 바뀌었거나 빠졌으면 멈추므로, 먼저 다시 빌드하거나 설치본을 고친다.

Whisper 모델까지 넣은 뒤에는 `-ExistingInstallation`으로 검사한다. 이 모드는 ZIP의 manifest가 "신규 설치 패키지에서 뺌"으로 기록한 Whisper가 나중에 들어온 것을 허용하고, 모델 표식 파일이 빠짐없이 있는지는 그대로 확인한다. 일반 모드와 `-Handoff` 모드는 ZIP을 막 푼 상태를 기준으로 하므로 Whisper를 넣은 뒤에는 실패한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify_portable.ps1 -PortableDir <압축을 푼 경로>\lmo_audio -ExistingInstallation
```

사용자 PC에서 적용할 때는 업데이트 패키지 폴더에서 대상 `lmo_audio` 폴더를 지정한다. 이 작업은 일반 사용자가 앱 사용 중에 누르는 자동 업데이트가 아니라 관리자/운영자가 유지보수 시간에 실행하는 수동 절차다. 적용 전 앱을 닫고 분석 작업이 진행 중이 아닌지 확인한다. 중요한 결과물이 있으면 `backend\outputs`를 먼저 백업한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File update_lmo_audio.ps1 -TargetDir D:\Apps\lmo_audio
```

검증만 다시 실행할 때:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File verify_update.ps1 -TargetDir D:\Apps\lmo_audio
```

루트 package script로 검증할 때는 인자를 넘긴다.

```powershell
corepack pnpm verify:update -- -TargetDir D:\Apps\lmo_audio -PackageDir releases\updates\lmo_audio_update_<commit>
```

`update_lmo_audio.ps1`는 대상 폴더를 수정하기 전에 package payload 해시와 사용자 자료 위치를 먼저 확인한다. payload가 사용자 자료 위치를 덮어쓰려 하거나, 대상 설정이 결과·임시·로그 폴더나 사용자 모델·양식을 `lmo_audio` 안의 비표준 위치에 두었으면 아무것도 바꾸지 않고 멈춘다. 업데이트 검증은 payload 파일 해시, 앱 exe, sidecar, ffmpeg, 기존 모델 marker, 기존 설정 파일 보존 여부와, 빌드 목록 중 업데이트가 담는 앱·`binaries`·`backend` 파일의 해시를 확인한다. 기존 설정과 모델을 보존하므로 적용 후 대상 `release-manifest.json`의 `backendConfig` 해시와 model marker 크기는 현재 대상 PC 파일 기준으로 다시 맞춘다.

운영 기준:

- 기본 STT 모델은 외부망 PC에서 설정 화면의 `받기`로 앱이 다운로드를 시작할 수 있다. 내부망/실패 상황에서는 관리자가 준비해 `models\faster-whisper-large-v3`에 배치한다. 참석자 구분 모델은 앱 안에서 개별 다운로드하지 않고, 신규 설치 패키지(ZIP)에 포함하거나 관리자가 `models\speaker-diarization-community-1`에 배치한다.
- Ollama 정리 모델은 외부망 PC에서 설정 화면으로 받거나 선택할 수 있다. 기본 배포본은 Ollama runtime을 함께 묶지 않고 설정 화면에서 고정된 standalone Windows CLI release zip을 내려받아 앱 관리 runtime으로 설치한다. 앱 관리 runtime이 없고 대상 PC에 Ollama가 이미 설치되어 실행 중이면 시스템 설치본을 사용해 상태 확인과 모델 받기를 시도한다. 시스템 설치본이 실행되지 않으면 사용자가 먼저 Ollama를 실행한 뒤 다시 확인하도록 안내한다. 오프라인 배포나 사전 내장 배포가 필요할 때만 공식 zip을 미리 풀어 앱 내부 `runtime\ollama\ollama.exe`와 `models\ollama`를 사용한다. 내부망/오프라인 PC에서는 이미 설치된 모델 감지와 관리자 준비 절차를 기준으로 한다.
- 기본 STT 모델을 앱에서 받을 수 없는 PC는 관리자가 지정한 공유 위치에서 받아 `releases\lmo_audio\models\faster-whisper-large-v3` 아래에 둔다.
- `release-manifest.json`은 배포본의 신분증이며, verify/diagnose가 파일 해시 불일치를 잡아야 한다.
- 일반 사용자에게 전달할 배포본은 manifest의 `dirty`가 `false`여야 한다. dirty 배포본은 로컬 테스트용이며, 필요한 경우에만 `-AllowDirty`로 명시한다.
- 분석 결과와 임시 파일은 portable 실행 폴더 하위 `backend\outputs`, `backend\temp`에 생성된다.
- 회사 PC에서는 portable 폴더를 쓰기 가능한 위치에 둔다.
- 회사 PC에서 Ollama 설치/모델 준비가 확실하지 않으면 요약 AI를 필수 조건으로 보지 않는다.
  - STT, 참석자 구분, 대화록 TXT/JSON 생성은 계속 완료되어야 한다.
  - 요약 AI가 준비되지 않으면 결과의 `generation_status.summary`는 `skipped`로 남기고, 사용자는 대화록을 먼저 사용한다.
  - Ollama와 요약 모델은 준비된 PC에서 전체 요약, 주제별 정리, 참석자별 정리를 다시 실행하는 선택 기능으로 다룬다.
- `backend\.venv-desktop`는 PC 간에 복사해서 쓰는 공용 자산이 아니다.
  - 이 폴더는 생성 당시의 로컬 Python 설치 경로를 내부에 기록한다.
  - 회사 PC에서 만든 `venv`를 집 PC로 가져오거나, 기준 Python을 삭제/교체하면 같은 경로 오류가 다시 난다.
  - 새 PC에서는 먼저 아래 스크립트로 build venv를 새로 만든다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\ensure_backend_build_env.ps1 -Python <실제로 설치된 python.exe 경로> -RecreateBroken
```

- portable/sidecar 빌드는 가능하면 항상 repo-local build venv를 명시적으로 사용한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\release_portable.ps1 -Python backend\.venv-desktop\Scripts\python.exe
```

## 8. 2026-05-12 빌드 시행착오 기록

- 최상단 안내 파일명은 ASCII로 둔다: `START_HERE.txt`.
  - `START_HERE_먼저읽기.txt`처럼 한글 파일명을 PowerShell 스크립트 안에 직접 쓰면 Windows PowerShell 실행 인코딩에 따라 깨질 수 있다.
  - 안내 파일 내용은 `[System.IO.File]::WriteAllText(..., [System.Text.UTF8Encoding]::new($false))`로 저장한다.
- 안내 파일만 실패한 경우에는 sidecar/Tauri를 다시 빌드할 필요가 없다.
  - 이미 `Created sidecar`와 `Built application at`이 끝난 뒤라면 `release_portable.ps1 -SkipSidecarBuild -SkipTauriBuild`로 패키징/검증만 다시 한다.
  - `START_HERE.txt`는 manifest 해시 대상이다. 손으로 복사하지 말고 `build_user_release.ps1 -SkipSidecarBuild -SkipTauriBuild`로 manifest와 검증을 함께 갱신한다.
- `verify_portable.ps1`의 `/api/models/status` 호출은 첫 실행에서 모델/라이브러리 초기화 때문에 5초를 넘을 수 있다.
  - health/settings가 PASS인데 runtime smoke가 timeout이면 모델 상태 요청 timeout을 먼저 의심한다.
  - 현재 검증 스크립트는 모델 상태 요청에 최소 60초 timeout을 사용한다.
- Python 런타임은 PATH의 `python`에 기대지 않는다.
  - 이 PC에서는 `python` 명령이 없고 `py`도 설치 Python을 찾지 못할 수 있다.
  - `backend\.venv-desktop\Scripts\python.exe`가 존재해도, 내부 기준 Python이 삭제된 경로를 가리키면 `Unable to create process ... Python311\python.exe`로 실패한다.
  - 이 경우는 build script를 다시 돌리는 것으로 해결되지 않는다. 먼저 `scripts\ensure_backend_build_env.ps1 -Python <python.exe> -RecreateBroken`으로 venv를 재생성해야 한다.
  - sidecar를 다시 빌드할 때는 `release_portable.ps1 -Python <실제로 실행 가능한 python.exe>`를 사용하고, 스크립트의 runtime probe가 통과하는지 먼저 확인한다.
  - 상대 경로 Python 인자는 repo 기준 절대 경로로 바꿔 전달한다. `backend\.venv-desktop\Scripts\python.exe`가 PowerShell에서 모듈명처럼 해석되는 실패를 피하기 위해서다.
- 포터블 smoke test는 `Get-NetTCPConnection`만 믿지 않는다.
  - 일부 환경에서는 프로세스/포트 조회가 불안정하거나 권한 영향을 받는다.
  - 실제 기준은 sidecar의 `/api/health` 응답이며, 검증 스크립트도 health 응답을 먼저 기다린다.
- 루트 `lmo_audio` 폴더는 과거 산출물이다.
  - 새 배포 기준은 `releases\lmo_audio`이며, `release_portable.ps1`와 `diagnose_portable.ps1`는 루트 `lmo_audio`가 남아 있으면 경고한다.

## 9. 2026-05-13 빌드 venv 재발 방지

- `backend\.venv-desktop`가 존재해도 완성된 build venv라고 판단하지 않는다.
  - `pyvenv.cfg`가 현재 실행 가능한 Python을 가리키는지 확인한다.
  - `PyInstaller`, `fastapi`, `faster_whisper`, `huggingface_hub`, `torch`가 설치되어 있는지 확인한다.
  - venv 생성과 pip 업그레이드만 끝난 상태는 불완전한 venv다.
- `ensure_backend_build_env.ps1 -RecreateBroken`를 실행하다가 중단했다면 다음 release를 바로 시작하지 않는다.
  - 먼저 아래 probe가 통과하는지 확인한다.

```powershell
backend\.venv-desktop\Scripts\python.exe -c "import importlib.util; required=['PyInstaller','fastapi','faster_whisper','huggingface_hub','torch']; missing=[name for name in required if importlib.util.find_spec(name) is None]; print('missing=' + ','.join(missing)); raise SystemExit(1 if missing else 0)"
```

- `release_portable.ps1`와 `package_backend_sidecar.ps1`는 sidecar 빌드 전에 위 필수 패키지를 선검사한다.
  - 실패하면 앱 프로세스 종료, WebView cache 삭제, sidecar 산출물 제거 같은 작업으로 넘어가지 않는다.
  - 해결은 `scripts\ensure_backend_build_env.ps1 -Python <실제로 실행 가능한 python.exe> -RecreateBroken`를 끝까지 완료하는 것이다.
- `backend\.venv-test312` 같은 임시 venv는 응급 빌드에는 사용할 수 있지만, 반복 가능한 배포 기준은 아니다.
  - 임시 venv를 사용했다면 final summary와 manifest dirty 상태에 반드시 남긴다.
  - 다음 정식 배포 전에는 `.venv-desktop`를 정상 복구하는 것을 우선한다.
- pip install이 사용자 프로필 cache 권한 문제로 실패하면 repo 내부 임시 경로를 사용한다.
  - 예: `$env:TMP=(Resolve-Path .codex-work\tmp).Path`, `$env:TEMP=$env:TMP`, `$env:PIP_NO_CACHE_DIR='1'`.
  - `C:\Users\...\pip\cache`나 권한이 불확실한 `C:\tmp`에 의존하지 않는다.
- `-SkipSidecarBuild`는 backend 변경을 이번 배포에 반영할 필요가 없고, 기존 sidecar가 의도한 버전임을 확인한 경우에만 사용한다.

## 10. 2026-05-21 빌드 명령 혼동 방지

- 루트 `package.json`를 추가해 `corepack pnpm build`가 항상 사용자 배포용 포터블 릴리스 흐름을 실행하게 했다.
  - 실행 스크립트: `scripts\build_user_release.ps1`
  - 내부 기준: `scripts\release_portable.ps1 -Python backend\.venv-desktop\Scripts\python.exe -ClearWebViewCache`
  - 최종 검증: `scripts\verify_portable.ps1 -PortableDir releases\lmo_audio -ExistingInstallation`(2026-10-22부터. 앱 실행 검사는 빌드 중 중간 빌드 폴더에서 하고, 배포 폴더는 읽기만 한다)
- `scripts\release_portable.ps1`의 기본 Python도 `backend\.venv-desktop\Scripts\python.exe`로 바꿨다. 전역 `python`이나 설치 상태가 다른 PC의 PATH에 의존하지 않는다.
- `desktop-app\package.json`에는 `build:web`와 `build:portable`를 분리해 두었다.
  - `desktop-app`의 `build`와 `build:web`는 웹 자산만 만든다.
  - 사용자에게 전달할 실행 폴더를 만들 때는 루트에서 `corepack pnpm build`를 사용한다.
- Codex가 "빌드" 요청을 받으면 명시적으로 웹/Vite 빌드를 요청한 경우가 아닌 한 `corepack pnpm build`를 선택해야 한다.
- `verify_portable.ps1`는 manifest `dirty=true`를 기본 실패로 처리한다.
  - 로컬 점검 중 dirty 배포본을 확인해야 할 때만 `build_user_release.ps1 -AllowDirty` 또는 `verify_portable.ps1 -AllowDirty`를 사용한다.
  - 사용자에게 전달할 최종 배포본은 변경 사항을 커밋한 뒤 다시 빌드해 `manifest clean`이 PASS여야 한다.

## 11. 2026-05-21 Windows/Codex 프로세스 조회 문제

- Codex 샌드박스에서는 `Get-CimInstance Win32_Process`가 `Access denied`로 실패할 수 있다.
  - 명령줄 확인이 꼭 필요하면 권한 상승으로 다시 실행한다.
  - 실행 파일 경로만 필요하면 `Get-Process` 기반 fallback을 먼저 사용한다.
- `release_portable.ps1`는 앱/WebView 프로세스 조회가 CIM 권한 문제로 실패해도 즉시 중단하지 않고, portable 폴더 아래 실행 파일만 `Get-Process`로 정리하도록 fallback한다.
- `diagnose_portable.ps1`도 CIM 실패 시 실행 파일 경로 기반 목록으로 fallback한다.
- Node/npm을 통해 실행된 Windows PowerShell에서는 `Get-FileHash` cmdlet이 로드되지 않는 경우가 있었다.
  - release/verify/diagnose 스크립트는 `Get-FileHash`가 없으면 .NET `SHA256`으로 해시를 계산한다.
- Git 전역 ignore 파일 권한 문제로 `git status --short`가 실패해 manifest의 `dirty` 값이 틀릴 수 있었다.
  - release 스크립트는 manifest용 git 명령에 `-c core.excludesFile=`를 붙여 전역 ignore 파일 권한 문제를 우회한다.
  - `dirty` 계산은 `status --short --untracked-files=all` 기준으로 한다.
  - manifest용 git 명령이 실패하면 clean으로 간주하지 않고 release를 실패시킨다.
- Python unittest의 `subprocess.run(..., capture_output=True)`에서 Windows PowerShell로 `verify_portable.ps1`를 실행할 때 `ProcessStartInfo.EnvironmentVariables[...]`가 `Cannot index into a null array`로 실패했다.
  - verify 스크립트는 현재 PowerShell 프로세스 환경변수를 임시 설정하고 sidecar 자식 프로세스가 상속하게 한다. `ProcessStartInfo.EnvironmentVariables[...]` 직접 인덱싱에 의존하지 않는다.
- 사용자가 빌드를 중단하면 재시도 전에 남은 `corepack pnpm build`, `scripts\build_user_release.ps1`, Tauri, PyInstaller, sidecar 프로세스를 확인한다. 다른 Codex 세션이나 다른 프로젝트 프로세스를 종료하지 않도록 명령줄 또는 실행 경로를 먼저 확인한다.
- 프로젝트 전용 Codex 스킬은 전역 `C:\Users\User\.codex\skills`가 아니라 저장소의 `.agents\skills` 아래에 둔다.

## 12. 2026-05-21 배포 폴더 잔여 파일 정리

- `binaries\_internal`의 Python 패키지, `.pyd`, DLL은 PyInstaller sidecar 런타임 의존성이므로 손으로 선별 삭제하지 않는다.
- 분석 실행 중 생기는 파일은 `backend\temp`, 결과물은 `backend\outputs`, 실행 로그는 `backend\logs`에 모은다. 이 폴더들은 사용자 PC에서 주기적으로 정리하기 쉬운 런타임 데이터 위치다.
- `robocopy /MIR /XD outputs temp __pycache__`는 제외 폴더를 새로 복사하지는 않지만, 대상 배포 폴더에 이미 남아 있는 제외 폴더를 삭제하지 않는다.
  - `release_portable.ps1`는 `releases\lmo_audio` 동기화 전에 `backend\outputs`, `backend\temp`, `backend\logs`, `backend\__pycache__`와 허용 목록 밖의 최상위 잔여 파일을 제거한다.
  - `verify_portable.ps1`는 최상위 배포 폴더와 런타임 폴더가 깨끗한지 검사하고, 저장소의 `releases\lmo_audio` 산출물을 검증할 때만 smoke test가 만든 `logs`, `backend\outputs`, `backend\temp`, `backend\logs`, `backend\__pycache__`를 종료 후 정리한다. 실제 사용자 설치 폴더를 직접 검증할 때는 사용자 결과물 삭제를 피하기 위해 후처리 삭제를 건너뛴다.
  - 2026-10-22부터 위 두 동작은 바뀌었다. `releases\lmo_audio`가 실제 사용 중인 설치본일 수 있어, 동기화 전 정리를 하지 않고 기록·로그·설정을 보존한다. `verify_portable.ps1`은 빈 폴더만 지운다. 앱 실행 검사는 중간 빌드 폴더에서 하고, 배포 폴더는 `-ExistingInstallation`으로 읽기만 한다(6-1 참고).
- 포터블 루트에 회의 원본 MP4/WAV 같은 입력 파일을 보관하지 않는다. 분석 파일은 사용자가 선택한 원본 위치에 두고, 앱은 필요한 임시 복사본만 `backend\temp` 아래에 만든다.
- 2026-10-18 웹 로컬 엔진 빌드에서는 이전 desktop 산출물의 `.pyd` 삭제가 `Access denied`로 실패했다. `package_backend_sidecar.ps1`는 `dist-sidecar` 전체 대신 현재 `$BuildOutputDir`만 정리한다. 삭제 대상의 정규화된 부모 경로가 `$BuildDistDir`인지 확인하고 reparse point를 거부해 다른 대상의 산출물을 보존한다.

## 13. 2026-10-18 실모델 검사 환경의 최소 복구

- `.venv`와 `.venv-desktop`의 패키지 목록은 다를 수 있다. 실행한 Python·기준 Python·실제 backend_dir를 health/로그로 기록하고, 필요한 import를 단일 프로세스에서 순서대로 완료한 뒤 모델 요청을 보낸다. 버전 숫자 차이만으로 전체 requirements를 재설치하지 않는다.
- [공식 TorchAudio 설치 문서](https://github.com/pytorch/audio/blob/main/docs/source/installation.rst)의 2.11 이상 stable ABI 정책 때문에 torch 2.12/torchaudio 2.11 조합은 지원 대상이다. 실제 import·필요 API를 함께 확인해야 한다. torchaudio 2.11의 METADATA에 Requires-Dist가 없는 것 자체도 손상 증거가 아니다. 이 조합을 옛 버전의 동일 번호 규칙만으로 강제 다운그레이드하지 않는다.
- 이번 기존 `.venv-desktop`는 torch/torchaudio/faster-whisper/pyannote import와 실제 WAV/video 생성 흐름을 완료했다. 선택적 conversion 의존성 Transformers가 없으며 기본 STT에는 필요하지 않다. 실험용 `.venv`의 Transformers를 옮기면 모델 소스 순회 비용과 HF/tokenizer 제약을 추가할 수 있으므로 사용처·요구 버전부터 확인한다. 과거 native 초기 지연의 근본 원인은 아직 확정되지 않았다.
- TorchCodec 내장 디코더/DLL 경고는 현재 `soundfile`→메모리 waveform 구분 성공과 별개다. 이를 모든 파일 디코더 정상이나 frozen 패키징 성공으로 확대하지 않는다. 실제 설치 payload 검증은 기존 release QA 표에서 계속 관리한다.
- 모델 처리 간 메모리가 부족해지기 전에 소유 프로세스·작업 파일 보존을 확인하고 검사 단계의 순서를 조절한다. 검사 엔진을 재시작했다면 동일 command/dir/port와 health를 복구하고 결과 재열기를 확인하며, 단일 프로세스의 최대 동시 상주를 통과했다고 보고하지 않는다. 무관한 서버/사용자 프로세스는 종료하지 않는다.
- 재현 명령·정확한 관측값·QA 격리 방식·한계는 `docs/web-runtime-separation-implementation-plan.md` 6.6의 `실행 환경 확인·실제 모델 전체 흐름 재검증`과 `docs/audio-performance-improvement-log.md`에 기록했다. 이번 소스 환경 검사는 release build를 실행하거나 portable/Tauri/실제 HTTPS를 입증한 것이 아니다.

### 같은 날 확인한 설치형 웹 로컬 엔진 경계

- NSIS 3.13은 `SetShellVarContext current`를 최상위에서 허용하지 않는다. `installer/web-local-engine.nsi`의 `.onInit`·`un.onInit` 및 설치·제거 Section 안에서 현재 사용자 범위를 지정한다. BOM 없는 UTF-8 스크립트의 한글을 보존하려면 `build_web_local_engine_installer_poc.ps1`와 직접 재컴파일 모두 `/INPUTCHARSET UTF8`을 지정한다. 기존 helper를 재사용한 직접 컴파일은 통과했다.
- 실제 `0.1.0-qa-20261018` 설치에서는 HTTP 200이어도 준비 확인 helper가 exit 3으로 종료해 등록이 완료되지 않았다. 첫 AppData 디렉터리 생성 전의 논리 경로와 생성 후 MSIX Pcache 실제 경로가 달라 엔진과 helper의 mutex 식별자가 달랐다. 데이터가 존재하는 상태에서 재시작하자 helper exit 0을 확인했다.
- 정상 시작에서는 `prepare_web_local_engine_data` 후 `_resolve_startup_layout`을 다시 적용해 환경변수·mutex·종료 이벤트·연결 코드 표시가 같은 최종 경로를 사용하도록 수정했다. 사용자 config 경로와 기존 경로·권한 검사는 보존한다. 소스 집중 17+5=22개·독립 검토, `0.1.1-qa-20261018`(r1)의 실제 설치 복구·등록·full frozen smoke를 통과했다. 이어 `https://127.0.0.1:5443`의 실제 helper/설치 엔진 UI에서 두 표본의 구분·요약·저장/reload·다운로드 8개(TXT 대화록 2개, 정리 MD/DOCX/HWPX 각 2개)를 통과했다. 이 r1 검사 당시 요약 버튼 상태 P2는 설정 상태 읽기/닫기로 회복한 뒤 진행했으며 제품 수정 없이 열린 상태였다. 일반 사용자 최초 모델 다운로드·준비, 공개 HTTPS/LNA·다른 PC·서명·Word/한컴 렌더링은 미검증이다. 시험한 WAV/MP4 waveform 성공을 범용 디코더 정상으로 확대하지 않는다. r1의 최종 증거·한계·정리/복원 기록은 `.tmp/installed-https-audit-20261018`과 원본 계획 6.6에 보관한다.
- full frozen의 startup-safe stop 통과를 실모델 처리 후 정상 종료 통과로 확대하지 않는다. r1의 두 실모델 처리 뒤 `--stop` CLI exit 0은 요청 접수에 그쳤고 포트가 닫혀도 엔진이 최소 96초 이상 잔류해 own 프로세스 강제 정리가 필요했다. 요약 버튼 상태와 별도로 정상 종료·업데이트 전 stop 복구 P2를 `todo.md`에 유지한다. 제한 시간 내 프로세스·포트·mutex·own Ollama 해제와 데이터 보존을 재검증해야 하며, 근본 원인은 아직 미확정이다. `shutdown-delay.json`·`shutdown-result.json`은 own 프로세스 잔류 없음·기존 system Ollama 17392와 설치본/결과 보존을 기록하고, `restart_inspection.ps1`은 같은 QA 폴더에서 복원 명령을 보관한다. 강제 정리 후에도 backend 결과/저장 기록 2건과 다운로드 8개 hash 일치를 확인했으며 당시 최종 QA 상태는 `findings_open`·known issue 2건이었다.
- 후속 r2(`0.1.2-qa-20261018`)에서는 startup 기본 smoke와 두 실모델 처리를 구분해 종료를 다시 확인했다. stop ACK 0, 본체 약 1.964초 종료, 포트·mutex 해제는 확인했지만 own runner 8776/conhost 15460이 약 5.6GB를 남겨 전체 종료 검사는 실패했다. 따라서 본체·managed Ollama 부모의 종료만으로 완료 처리하지 말고, 모델을 실제로 적재한 뒤 해당 실행이 만든 runner/conhost까지 소멸했는지 별도로 확인한다. foreign Ollama 36096은 보존했으며 own 하위 프로세스 정리 수정은 아직 검증 전이다. 최신 근거는 `.tmp/remaining-fixes-20261018/{frozen-smoke.log,preserved-before-stop.json,shutdown-result.json,preserved-after-stop.json}`과 원본 계획 6.6이다.
- 종료 후 `Get-Process`로 얻은 관측 객체의 `engineExitCode:null`을 성공 0으로 바꾸지 않는다. 요청 helper의 exit code, 본체 소멸 시간, 포트·mutex 해제, 소유 경로/부모 관계를 확인한 하위 프로세스 잔류, 파일 보존을 각각 기록한다. 종료 전후 저장 증거 파일 hash 일치도 종료 후 브라우저 IndexedDB 재열기나 전체 프로세스 정리의 증거를 대신하지 않는다.
- r3의 Windows Job 기반 소유 프로세스 정리는 집중 25개·독립 검토와 실제 모델 적재 뒤 4개 프로세스 전체 소멸(0.328초)을 통과했다. `0.1.3-qa-20261018` frozen 기본 smoke·설치 파일 제작까지 완료한 뒤 사용자가 잠시 멈추도록 요청했다. 새 설치본의 두 표본 처리·종료/재시작은 미실행이므로 설치형 종료 P2를 완료 처리하지 않는다. `.tmp/remaining-fixes-20261018-r3/user-pause-state.json`과 계획 6.6의 r3 후속을 따른다.
- 생성 산출물의 `Remove-Item`·`Move-Item`이 파일별 처리로 수분 지연될 때는 실행 중인 해당 빌드의 정확한 PID·명령·자식 유무를 확인하고 중지/복원 계획을 먼저 알린다. 실제로 이 세션의 빌드 27628과 이동 명령 35688만 중지한 뒤, 전용 `barorok-local-engine`의 dist/work 두 폴더를 절대 경로·재분석 지점·기존 대상 검증 후 같은 D 볼륨의 QA 보관 폴더로 `[IO.Directory]::Move`해 0.73초에 정리했다. 사용자 데이터·다른 sidecar 대상은 이동하지 않았으며 원래 작업 폴더·환경·origin·버전·빌드 명령을 복구했다. 상세 보관 경로는 `build-cleanup-relocation.json`, 이전 로그는 `frozen-build-cleanup-first.log`에 남긴다. r3 패키징 보조 프로세스 종료 지연 경고는 PyInstaller 자체 정리 후 빌드가 계속돼 최종 성공한 별도 도구 경고이며, 제품 엔진 종료 성공으로 확대하지 않는다.

### 2026-10-20 웹 연결용 설치 도우미만 수정할 때

- 설치 전 `설치 전 점검 결과를 확인하지 못했습니다`는 도우미의 결과 계약 실패이며 엔진 실행/브라우저 연결 실패와 별도다. `TMP≠TEMP` 회귀는 이전/수정 frozen 도우미를 같은 manifest로 비교하고 JSON·INI 생성과 exit10을 확인한다. 실행 실패 안내와도 구분한다.
- 기존 공식 NSIS3.13은 `.tmp/installed-https-audit-20261018/tools/nsis-3.13/makensis.exe`에 보존돼 있다. PATH 부재만으로 컴파일러 미설치라고 판단하지 않는다. `/INPUTCHARSET UTF8`을 유지하고 컴파일 경고도 기록한다.
- 엔진 본체 변경이 없는 수정은 동일 공개 payload의 closed manifest/hash를 먼저 검증한 뒤 helper/NSIS만 재빌드할 수 있다. 새 installer revision·파일 SHA와 기존 engineVersion을 별도로 명시한다. 원래 설치 파일과 사용자 모델/결과를 보존한다.
- 다른 세션의 로컬 `.tmp/cloudflare-web/dist`가 운영 자산과 다를 수 있다. 다운로드만 수정할 때는 현재 공개6개 자산을 별도 폴더에 받아 hash를 기록하고, 그 폴더를 지정한 배포 설정으로 검사한다. 미커밋 UI를 함께 빌드/배포하지 않는다. 이전 받기 링크는 고정된 같은 origin의 새 다운로드로 연결하고 캐시하지 않는다.
- 이번 원인·실물 설치·배포 상태는 `docs/web-local-engine-followup-plan.md`의 `2026-10-20 수정 설치 파일 실물 재검증`과 기존 release QA 표를 따른다.

### 2026-10-20 웹 연결용 설치 파일의 공간 점검 값과 표시 이름

- `poc-manifest.json`에는 `storageRequirements`(모델·분석 임시·결과의 `requiredBytes`/`recommendedBytes`)가 있어야 한다. 없으면 정상 PC에서도 설치 중 확인 질문이 뜬다. `build_web_local_engine_poc.ps1`이 `backend/web_local_engine_storage_requirements.py`로 채우고, 설치 파일 빌드 전 `verify_web_local_engine_poc.py --manifest-only`가 누락·오류를 막는다. 이전 payload를 재사용해 helper/NSIS만 다시 묶을 때는 그 manifest에 블록이 없으므로 payload부터 다시 만든다.
- 값의 근거와 바꿀 때 함께 고칠 곳은 `docs/web-local-engine-followup-plan.md`의 `설치 전 점검: 모델·작업 공간 크기와 표시 이름 — 2026-10-20`을 따른다.
- 설치 프로그램 표시 이름은 브랜드 없는 `음성 분석`이고, 브랜드는 `configs/brand.json`에서 읽어 `/DBRAND_NAME`으로만 들어간다(NSIS·빌드 스크립트에 브랜드를 직접 쓰지 않는다). `PRODUCT_KEY`·설치 폴더·엔진 exe 이름은 업그레이드 식별자라 바꾸지 않는다. 새 설치 확인 때 시작 메뉴에 `음성 분석` 폴더(음성 분석 시작·`<브랜드> 연결`·음성 분석 종료·음성 분석 제거)만 남고 옛 `바로록 로컬 엔진` 폴더가 사라졌는지, 앱 목록 이름과 게시자, HKCU `...\Uninstall\BarorokLocalEngine`의 `ConnectShortcut` 값이 바로가기 이름과 같은지 함께 본다.
