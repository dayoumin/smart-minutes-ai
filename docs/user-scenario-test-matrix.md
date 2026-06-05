# 사용자 시나리오 테스트 매트릭스

기준일: 2026-06-04

## 목적

사용자가 실제로 겪는 흐름을 파일 종류, 파일 길이, 중지/취소, 재시작 가능성 기준으로 검증한다. 실제 긴 파일을 매번 처리하는 테스트는 비용이 크므로, 기본은 프론트엔드 시뮬레이션과 백엔드 단위 테스트로 상태 전이를 확인하고, 릴리스 전에는 대표 샘플로 수동 또는 반자동 확인을 한다.

## 원칙

- 짧은 파일과 긴 파일을 모두 본다.
- 음성 파일과 영상 파일을 모두 본다.
- 대화록 작성, 참석자 구분, 기록 정리를 별도 단계로 본다.
- 중지는 나중에 이어서 할 수 있어야 하고, 취소는 이번 실행을 멈춘 뒤 다시 시작할 수 있어야 한다.
- 긴 파일 테스트는 실제 2시간 파일을 매번 쓰지 않고, 가능한 경우 mock route와 duration/size 조건으로 먼저 검증한다.
- 실제 긴 샘플 검증은 릴리스 후보에서만 좁게 실행한다.

## 시나리오 매트릭스

| ID | 사용자 상황 | 확인할 결과 | 현재 커버리지 | 다음 액션 |
| --- | --- | --- | --- | --- |
| UST-01 | 짧은 음성 파일로 대화록 작성 | 분석 시작, 진행률 표시, 대화록 저장, 기록 정리 진입 가능 | `test:generation-flow`, backend/export 단위 테스트 일부 | 유지 |
| UST-02 | 짧은 영상 파일로 대화록 작성 | 영상에서 음성을 준비하고 대화록을 저장함 | `test:analysis-stop-flow`가 mp4 fixture로 분석 시작 흐름 확인 | 파일 선택 안내까지 확장 가능 |
| UST-02A | 영상에서 오디오만 추출 | 영상 선택 후 다운로드 버튼 표시, 완료 후 저장 완료 안내와 폴더 열기 CTA 표시 | `test:audio-extract-ui` | 유지 |
| UST-03 | 긴 음성 파일 시작 전 | 긴 파일 안내, 저장공간 사전점검, 대화록 우선 안내 | `backend/test_storage_preflight.py` | 프론트 파일 안내 시뮬레이션 추가 |
| UST-04 | 긴 영상 파일 시작 전 | 영상 길이/크기 기준 안내, 저장공간 부족 시 시작 차단 | `backend/test_storage_preflight.py` | 프론트 파일 안내 시뮬레이션 추가 |
| UST-05 | 음성인식 중 중지 | 완료된 구간을 남기고 중지, 같은 파일로 이어하기 가능 | `test:analysis-stop-flow` | 유지 |
| UST-06 | 음성인식 중 취소 | 이번 실행을 취소하고 진행 상태가 정리됨 | `test:analysis-stop-flow` | 유지 |
| UST-07 | 중지 후 같은 파일 재선택 | 이어하기 후보 표시, 이어서 진행 선택 가능 | `test:resume-flow`, `test:resume-draft-flow` | 긴 파일 문구 확인 추가 |
| UST-08 | 취소 후 같은 파일 재시작 | 이어하기가 아닌 새 분석 흐름으로 시작 | `test:analysis-stop-flow` 일부 | 명시 assertion 보강 가능 |
| UST-09 | 분석 중 화면 이동/닫기 | 사용자에게 진행 중 경고를 보여줌 | `test:close-guard-flow`, `test:edit-guard-flow` | 유지 |
| UST-10 | 대화록 저장 후 참석자 구분 실행 | 참석자 구분 진행률, 경과 시간, 중지/취소 버튼 표시 | `test:meeting-detail-flow` | 유지 |
| UST-11 | 참석자 구분 중 중지 | 중지 중 표시, 완료 후 다시 실행 가능 | `test:meeting-detail-flow` | 유지 |
| UST-12 | 참석자 구분 중 취소 | 취소 중 표시, 이번 실행만 멈추고 다시 실행 가능 | `test:meeting-detail-flow` | 유지 |
| UST-13 | 참석자 구분 원본 음성 없음 | 원본 필요 상태 표시, 실행 버튼 비활성화 | `test:meeting-detail-flow` | 유지 |
| UST-14 | 참석자 구분 모델 미준비 | 대화록은 유지, 모델 준비 필요 안내 | backend/API 오류 매핑 일부 | 프론트 시뮬레이션 추가 가능 |
| UST-15 | 참석자 구분 리소스 제한 | 대화록은 유지, 참석자 구분 제외/나중 실행 안내 | backend/API 오류 매핑 일부 | 프론트 시뮬레이션 추가 가능 |
| UST-16 | 기록 정리 중 입력 변경 | 오래된 결과 저장 방지, 다시 정리 안내 | `test:generation-flow`, `test:topic-generation-ui` | 유지 |
| UST-17 | 내보내기 | TXT/MD/HWPX/DOCX 다운로드가 깨지지 않음 | `test:meeting-detail-flow`, backend export tests | 유지 |
| UST-18 | 내부 음성 파일 보존 설정 변경 | 나중 참석자 구분 가능 여부 안내가 일관됨 | 설정 UI 일부 | 설정-결과 화면 연결 시나리오 추가 |
| UST-19 | 요약 모델 직접 입력/추천 선택 | 모델 탭에서 추천 모델, 직접 입력 모델, 사용 중 모델 표시가 일관됨 | `backend/test_api.py`, `test:meeting-detail-flow` 일부 | 직접 입력 저장 UI 시뮬레이션 보강 가능 |
| UST-20 | Ollama 모델 받기/삭제 | 모델명 검증, 받는 중/완료/실패 상태, 사용 중/받는 중 모델 삭제 차단 | `backend/test_api.py`, `test:settings-model-management` | 유지 |
| UST-21 | 참석자 구분 원본 음성 없음 | 표식 1명 상태와 재실행 불가 상태를 구분해 안내 | `test:meeting-detail-flow`, backend/API 오류 매핑 | 유지 |
| UST-22 | 분석 중 참석자 구분 실행 옵션 변경 | 설정 저장, `/api/models/status` 반영, 분석 결과 설정 기록 일관성 | `backend/test_api.py` | 설정 UI 저장 시뮬레이션 보강 가능 |

## 자동화 우선순위

1. 파일 선택 안내 시뮬레이션을 추가한다.
   - 짧은 음성, 짧은 영상, 긴 음성, 긴 영상 mock fixture를 사용한다.
   - 실제 긴 파일을 만들지 않고 size/duration 조건을 주입할 수 있는 구조를 우선 검토한다.

2. `test:analysis-stop-flow`에 취소 후 새 시작 assertion을 명확히 추가한다.
   - 취소는 이어하기 후보가 아니라 새 분석으로 이어지는지 확인한다.

3. 설정과 결과 화면 연결 시나리오를 추가한다.
   - 내부 음성 파일 보존이 꺼져 있으면 참석자 구분 재실행 가능 안내가 과장되지 않아야 한다.

4. 모델 탭 UI 시뮬레이션을 유지한다.
   - 직접 입력 모델 저장, Ollama 모델 받기 진행 상태, 삭제 차단/삭제 완료를 mock route로 확인한다.
   - 실제 `ollama pull`은 릴리스 후보 수동 확인으로 분리하고 기본 자동 테스트에서는 실행하지 않는다.

## 릴리스 후보 수동 샘플

| 샘플 | 파일 종류 | 길이 | 목적 |
| --- | --- | --- | --- |
| RS-01 | 음성 | 5분 이하 | 기본 분석과 내보내기 smoke |
| RS-02 | 영상 | 5분 이하 | 영상 음성 준비와 대화록 저장 |
| RS-03 | 음성 | 30분~1시간 | 긴 파일 안내와 예상 시간 |
| RS-04 | 영상 | 1시간 30분 이상 | 저장공간 점검, 중지 후 이어하기 |
| RS-05 | 음성 또는 영상 | 2시간 이상 | 대화록 우선 저장, 참석자 구분 위험 안내 |

릴리스 후보에서는 모든 샘플을 매번 끝까지 돌리지 않는다. 변경 범위가 대화록 작성이면 RS-01~RS-04를 우선 보고, 참석자 구분 변경이면 RS-01, RS-03, RS-05에서 참석자 구분 시작/중지/재실행을 확인한다.

## 실행 명령

```powershell
corepack pnpm --dir desktop-app test:analysis-stop-flow
corepack pnpm --dir desktop-app test:resume-flow
corepack pnpm --dir desktop-app test:resume-draft-flow
corepack pnpm --dir desktop-app test:audio-extract-ui
corepack pnpm --dir desktop-app test:meeting-detail-flow
corepack pnpm --dir desktop-app test:settings-backend-restart
corepack pnpm --dir desktop-app test:settings-model-management
corepack pnpm --dir desktop-app test:generation-flow
corepack pnpm --dir desktop-app test:topic-generation-ui
```

Windows PC가 느릴 때는 한 번에 묶어 실행하지 않는다. 변경한 흐름과 직접 관련된 명령부터 하나씩 실행한다.

## 판정 기준

- 사용자가 다음에 할 수 있는 행동이 화면에 바로 보여야 한다.
- 중지와 취소의 의미가 문구와 상태에 일관되게 반영되어야 한다.
- 원본 음성, 저장공간, 모델 준비 같은 예외는 raw backend 오류가 아니라 사용자 문구로 보여야 한다.
- 대화록이 저장된 상태에서는 참석자 구분이나 기록 정리가 실패해도 대화록을 잃지 않아야 한다.
- 다시 실행 가능한 상태와 다시 분석해야 하는 상태가 섞이면 실패로 본다.
