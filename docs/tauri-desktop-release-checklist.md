# Tauri Desktop Release Checklist

## 0. 문서 운영 원칙

- 2026-10-22 웹·데스크톱 병행: 웹 설치 엔진의 고정 포트17863을 데스크톱이 먼저 사용하지 않도록 `src-tauri/src/backend_port.rs`에서17864부터 탐색한다. 포트 모듈의 실제 소켓 검사는 `rustc --edition=2021 --test desktop-app/src-tauri/src/backend_port.rs -o .tmp/dual-runtime/backend-port-tests.exe`로 좁게 실행할 수 있다. 이것은 Tauri 실행 파일의 실제 공존 검증을 대신하지 않는다.
- 기존 deploy 폴더는 사용자 설치본일 수 있다. `Sync-PortableToDeploy`는 패키지 코드만 mirror하며 설정·outputs/temp/logs/database·DB/WAL·다운로드한 모델/runtime·개인 최상위 파일을 보존한다. 프로세스 종료는 지정 deploy 폴더의 실행 파일 경계로 제한한다. 전역 WebView 이름/명령행만으로 다른 설치본을 종료하지 않는다.
- 보존과 전달은 구분한다. 전달 ZIP은 알려진 패키지 루트만 복사하고 개인 백업·로그·DB/보조파일을 제외한다. `backend/config.json`은 설치본에서 복사하지 않고 현재 HEAD의 UTF-8 기본 설정을 넣는다. 보통 HEAD 일치·clean manifest 게이트를 지키며 `-AllowStale`/`-AllowDirty`는 로컬 시험용이다. 격리된 신·기존 설치 fixture의 파일 해시와 ZIP 내용으로 보존/제외를 검증한다. 실사용 폴더로 시험하지 않는다.
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

## 3. 리소스와 모델 경로

- portable 배포에서는 exe 하나만 옮기는 것이 아니라 앱 폴더 전체를 유지해야 한다.
- 모델 경로는 `실행 폴더/models/...` 기준으로 안내한다.
- 현재 앱 설정 화면은 필수 모델 준비 상태와 `models` 폴더 기준 안내를 보여준다. 절대 경로 표시/복사 버튼은 후속 UX 개선으로 다루되, 배포 문서에는 실제 배치 위치를 반드시 명시한다.
- 일반 사용자 배포 UX를 개선할 때는 `models`, `backend`, `binaries`, `runtime` 같은 내부 폴더를 최상위에 그대로 노출하지 않는 구조를 검토한다. 예: 최상위에는 `lmo_audio.exe`와 `START_HERE.txt`만 두고, 모델과 런타임 파일은 `_internal` 또는 앱 관리 데이터 폴더 아래에 둔다.
- 내부 폴더를 숨기더라도 모델 파일을 단일 파일로 합치지는 않는다. STT 모델과 참석자 구분 모델은 여러 필수 파일로 구성되므로, 실제 파일 구조는 유지하고 앱/패키징/검증 코드가 역할 기반 모델 registry에서 경로를 찾게 한다.
- 모델 교체 가능성을 열어둘 때는 `faster-whisper-large-v3` 같은 모델명을 UI, 설정 저장, backend 경로, verify script에 직접 박지 않는다. `stt`, `diarization`, `summary` 같은 역할과 `portable_model_layout.json` 또는 후속 model registry를 기준으로 resolve한다.
- 필수 모델이 없으면 분석 버튼 클릭 후 즉시 원인과 조치 방법을 보여준다.
- 큰 모델을 zip에서 제외하는 경우, 제외한 모델명과 넣을 위치를 문서에 명시한다. 회사 전달용 슬림 zip은 `no_ollama_no_whisper` 기준으로 만들고, 참석자 구분 모델은 포함한다.
- Ollama runtime은 기본 배포 zip에 포함하지 않는다. 앱 설정의 모델 탭에서 고정된 공식 standalone Windows CLI release zip을 받아 `runtime\ollama\ollama.exe`로 풀고, portable 폴더에 쓸 수 없으면 `%LOCALAPPDATA%\LMO_audio\runtime\ollama`를 사용한다. 앱은 앱 관리 runtime이 있으면 시스템 설치본보다 우선 사용하고, 앱 관리 runtime이 없으면 `OLLAMA_EXE`, PATH의 `ollama`, 일반 설치 경로의 시스템 Ollama 순서로 fallback한다. 앱 관리 runtime의 요약 모델 저장소는 같은 앱 관리 경계의 `models\ollama`를 사용한다. release 운영 시 `LMO_OLLAMA_RUNTIME_VERSION`과 `LMO_OLLAMA_RUNTIME_SHA256`을 기록해 다운로드 URL과 해시가 의도한 릴리스인지 확인한다.
- 오프라인 또는 사전 내장 배포가 필요할 때만 공식 standalone Windows CLI 압축을 풀어 `runtime\ollama\ollama.exe`가 보이게 둔다. 이때 전체 `releases\lmo_audio` 폴더 크기와 회사 전달용 handoff zip 크기를 구분해서 기록한다.
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

다음을 바꾸면 리뷰 전에 이 절을 확인한다. 데스크톱과 웹은 화면 코드를 함께 쓰므로 한쪽만 바꿔도 양쪽 표를 본다.

- 데스크톱: `release_portable.ps1`, `verify_portable.ps1`, `create_handoff_package.ps1`, `create_update_package.ps1`, `portable_data_safety.ps1`, `run_release_checks.ps1`
- 웹: `prepare_cloudflare_web.ps1`, `installer\web-local-engine.nsi`, `build_web_local_engine_*.ps1`, `backend\web_local_engine_installer_preflight.py`, `backend\web_local_engine_runtime.py`
- 공통: 앱이 파일을 저장하는 위치, `desktop-app\src\meetingRepository.ts`의 저장 형식(`DB_VERSION`), 화면·엔진 호환 번호(`API_CONTRACT_VERSION`, `SUPPORTED_API_CONTRACT_VERSIONS`)

2026-10-22 웹·데스크톱 병행 작업에서 리뷰가 반복될 때마다 같은 종류의 누락(결과 폴더 → 요약 모델 파일 → 드라이브 상대 경로)이 나왔기 때문에 만든 목록이다. 아래 날짜별 기록은 "무슨 일이 있었나", 이 절은 "다음에 무엇을 볼까"다.

공통 원칙과 이유는 playbook 저장소의 `quality/release-update-data-safety.md`(이 PC에서는 `D:\Projects\playbook\quality\release-update-data-safety.md`)에 있다. 이 절에는 이 프로젝트의 표와 체크 항목만 둔다. 공통 원칙이 추가되면 해당하는 체크 항목만 여기에 더한다.

### 데스크톱 portable (`releases\lmo_audio`)

portable 앱은 프로그램과 사용자 자료가 같은 `lmo_audio` 폴더 안에 섞여 있다. 그래서 업데이트가 폴더를 다룰 때마다 주인을 구분해야 한다. 위치가 늘거나 동작이 바뀌면 이 표부터 고친다.

패키지 파일의 기준은 빌드 manifest의 파일 목록(`portablePayloadFiles`)이다. 업데이트 패키지와 전달 ZIP은 폴더를 훑지 않고 이 목록대로 만든다. 사용자 자료가 섞인 `backend\`에서 지우는 파일은 설치본의 이전 manifest 목록에 있고, 그 뒤 바뀌지 않았고, 새 빌드에 없는 것뿐이다. 목록에 없는 파일은 사용자 것으로 보고 둔다. 사용자 자료 위치는 목록에 적혀 있어도, `.`·`..`·끝의 점처럼 다른 표기로 적혀 있어도 Windows가 여는 실제 경로로 판단해 건드리지 않는다. 새 manifest는 작업이 끝난 뒤 마지막에 복사하므로, 중간에 멈춰도 다음 실행이 설치본의 이전 목록을 다시 읽는다.

| 위치 | 주인 | 배포 동기화(`Sync-PortableToDeploy`)·업데이트 패키지(`update_lmo_audio.ps1`) | 전달 ZIP |
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

데스크톱 업데이트와 공통:

- [ ] **주인 구분**: 앱이 새 파일·폴더를 만들기 시작했다면 위 표에 주인과 업데이트·전달 동작을 먼저 적었다.
- [ ] **설정으로 바뀌는 경로**: `paths.*`, `summary.model`, 활성 양식처럼 사용자가 위치를 바꿀 수 있는 값을 `portable_data_safety.ps1`이 검사한다. 해석 기준은 앱과 같은 `backend` 작업 위치다(상대·드라이브 상대 `D:x`·루트 상대 `\x` 포함). 셸 위치 기준으로 해석하지 않는다. 배포 동기화, 업데이트 패키지 생성과 적용, 전달 ZIP에 모두 적용된다.
- [ ] **폴더별 동작 선택**: `/MIR`은 패키지가 전부 소유한 폴더에만 쓴다. `/E`는 버전이 섞여도 안전한 폴더에만 쓴다. 섞이면 고장 나는 실행 파일 묶음은 통째로 교체한다.
- [ ] **지울 파일의 근거**: 사용자 자료가 섞인 폴더(`backend\`)에서는 설치본의 이전 manifest 목록에 있고 그 뒤 바뀌지 않은 파일만 지운다. 폴더를 훑어 "새 빌드에 없으니 지운다"로 판단하지 않는다. 공통 규칙은 `portable_data_safety.ps1`의 `Remove-StalePortablePackageFiles`·`Test-PortableUserDataPath`에 있다.
- [ ] **시험 실행 위치**: 앱을 실제로 켜는 smoke는 중간 빌드 폴더에서만 실행한다. `releases\lmo_audio`는 `-ExistingInstallation`으로 읽기만 한다. 검사를 통과시키려고 기록·로그·설정을 지우지 않는다.
- [ ] **비교 기준**: 설치본 무결성은 검증된 빌드 manifest와 비교한다. 동기화 뒤 대상 폴더로 manifest를 다시 만들지 않는다. 다시 만들면 잘못 복사된 파일도 정상으로 기록된다.
- [ ] **앱이 스스로 바꾸는 파일**: 설치 후 앱이 바꾸는 파일(`backend\config.json`, Ollama 설치로 사라지는 `runtime\ollama\README.txt`)을 알고 있다. 검사 예외는 정확한 파일과 조건으로만 둔다.
- [ ] **종료 범위**: 프로세스 종료는 그 설치 폴더 안의 실행 파일 경로로만 고른다. 이름이나 명령행으로 넓게 고르지 않는다. 웹 엔진(17863)과 다른 설치본은 종료하지 않는다.
- [ ] **두 제품 공존**: 데스크톱 포트는 17864부터 고르고 17863은 쓰지 않는다. 기록·설정 위치는 제품마다 따로 둔다. RAM·GPU·시스템 Ollama 공유는 허용된 제약이며 완전 격리로 설명하지 않는다.
- [ ] **업데이트 패키지·전달 ZIP**: 빌드 manifest 목록대로 담고, 설치본 파일을 빌드 해시와 대조한다. 다르거나 빠진 파일이 있으면 만들지 않는다. 설정은 담지 않거나(업데이트) HEAD 기본값으로 넣는다(전달 ZIP). 목록에 없는 `backend` 안 개인 파일은 담기지 않는다.
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

2026-10-22 빌드 전 검토에서 나온 업데이트 패키지·전달 ZIP 위험(backend 로그·DB·알 수 없는 파일 삭제와 유출, 앱으로 Ollama를 받은 설치본의 README 실패, 전달 ZIP의 비교 기준, Whisper를 넣은 전달 ZIP 검사)은 같은 날 위 규칙으로 고쳤다. 남은 한계는 다음과 같다.

- **빌드 목록이 없는 설치본**: 2026-06-01 이전 빌드처럼 manifest에 `portablePayloadFiles`가 없거나, 2026-10-22 이전에 만든 전달 ZIP으로 설치해 목록이 빌드 것이 아니면(`handoff.payloadList`가 `build`가 아님), 새 빌드에 없는 backend 파일을 지우지 않고 경고만 한다. 예전 전달 ZIP의 목록은 폴더를 훑어 만든 것이라 사용자 복사본이 섞여 있을 수 있기 때문이다. 오래된 코드 파일이 남을 수 있지만 사용자 자료는 지우지 않는다.
- **업데이트 패키지는 `runtime\`을 담지 않는다**: 지금 빌드의 `runtime`에는 Ollama 안내 파일만 있어 영향이 없다. `verify_update.ps1`은 업데이트가 담는 앱·`binaries`·`backend`만 확인하고, 적용 뒤 대상 manifest의 `runtime` 항목은 설치본의 이전 항목을 유지한다. 새 빌드가 `runtime`에 파일을 더하면 업데이트 패키지로는 전달되지 않으므로, 그때는 업데이트 패키지 범위를 먼저 넓힌다.
- **나중에 넣은 Whisper의 크기**: `-ExistingInstallation`은 전달 ZIP에서 뺀 Whisper가 들어온 것을 허용하지만, 기대 크기를 모르므로 표식 파일이 있는지만 본다. 잘린 모델 파일은 앱의 모델 상태 화면에서 확인한다.
- **실제 업데이트·전달 ZIP 검사 대기 — 2026-10-22 사용자 요청으로 중단**: 위 보호 규칙의 실제 `package:update` 적용과 최신 전달 ZIP 생성은 아직 하지 않았다. 기존 deploy는 `a150589b`/dirty=false이며 읽기 전용 무결성 검사를 통과했다. 별도 복사본·별도 WebView 프로필에서는 실제30초 음성의 대화록·2명 구분·자동 저장과 음성 파일 로드까지 확인했지만, 재시작/업데이트 후 재열기·재생은 미검증이다. 분석6분12초는 동시 파일 복사와 가용 메모리0.8GB/5%가 겹친 조건으로 성능 정상 판정에 쓰지 않는다. 재포장에 필요한 중간 sidecar가 없어 검증된 deploy에서 복구했고, 후속 포장은 deploy 동기화 전 파일 복사 중 중지했다. 중간 portable 폴더는 미완성이며 배포물로 쓰지 않는다. 다음 확인은 실모델 실행 없이 `build_user_release.ps1 -SkipSidecarBuild -SkipTauriBuild -NoClearWebViewCache`를 끝낸 뒤 업데이트·전달 ZIP을 순차 생성하는 것이다. 종료 조건은 clean/HEAD manifest·중간 smoke·deploy 무결성 통과, 별도 시험 복사본에 실제 업데이트 후 설정/모델/기록 보존, 같은 WebView 프로필의 대화록·음성 재열기/재생, 새 ZIP의 별도 폴더 첫 실행이다. 원본 deploy 사용자 파일35개·기존 IndexedDB8개는 종료 시 SHA 불변이다. 근거와 복원 명령은 `.tmp/release-real-qa-20261022` 및 `todo.md`의 같은 항목에 보관하며, 웹·데스크톱 공존의 최종 판정은 기존 release QA 표를 계속 사용한다.

구조 개선 후보(미결정): 사용자 자료를 프로그램과 분리된 `data` 폴더나 `%LOCALAPPDATA%`로 옮기면 업데이트를 "프로그램 폴더 통째 교체"로 단순화할 수 있다. 웹 설치 엔진은 이미 `%LOCALAPPDATA%\Barorok\LocalEngine`을 쓴다. 기존 설치본 이전 절차가 필요하므로 별도 범위로 검토한다.

## 7. 이 프로젝트의 단일 배포 흐름

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
11. `git fetch origin` 후 behind가 없을 때 `git push origin main`을 실행한다.

단순 문구/아이콘 변경처럼 배포가 필요 없는 경우에는 5~10번을 생략할 수 있다. 사용자가 "빌드" 또는 "전달"을 요청한 경우에는 5~10번을 생략하지 않는다.

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

### 회사 전달용 슬림 zip

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

슬림 zip을 빈 폴더에 풀어 구조만 검증할 때는 `-Handoff` 모드를 사용한다.

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File scripts\verify_portable.ps1 -PortableDir <압축을 푼 경로>\lmo_audio -Handoff
```

전달 ZIP은 설치본이 빌드 manifest와 같을 때만 만들어진다. 설치본의 패키지 파일이 빌드 뒤 바뀌었거나 빠졌으면 멈추므로, 먼저 다시 빌드하거나 설치본을 고친다.

Whisper 모델까지 넣은 뒤에는 `-ExistingInstallation`으로 검사한다. 이 모드는 ZIP의 manifest가 "전달 ZIP에서 뺌"으로 기록한 Whisper가 나중에 들어온 것을 허용하고, 모델 표식 파일이 빠짐없이 있는지는 그대로 확인한다. 일반 모드와 `-Handoff` 모드는 ZIP을 막 푼 상태를 기준으로 하므로 Whisper를 넣은 뒤에는 실패한다.

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

- 기본 STT 모델은 외부망 PC에서 설정 화면의 `받기`로 앱이 다운로드를 시작할 수 있다. 내부망/실패 상황에서는 관리자가 준비해 `models\faster-whisper-large-v3`에 배치한다. 참석자 구분 모델은 앱 안에서 개별 다운로드하지 않고, 회사 전달용 슬림 zip에 포함하거나 관리자가 `models\speaker-diarization-community-1`에 배치한다.
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
