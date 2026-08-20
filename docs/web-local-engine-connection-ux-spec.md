# 웹 로컬 엔진 연결·복구 UX 설계 묶음

- 작성일: 2026-08-20
- 상태: preview UI·mock 연결 흐름 구현, 실제 다운로드 연결과 제품 배포는 보류
- 기준: `docs/design.md`, `docs/web-runtime-separation-implementation-plan.md`, `docs/web-local-engine-followup-plan.md`
- 대상: HTTPS 웹 앱의 `새 회의록` 진입부터 분석 시작 전까지

## 1. 목표와 경계

사용자가 `새 기록`을 연 뒤 로컬 엔진의 설치 여부를 추측하지 않고도 다음 행동을
알 수 있게 한다. 연결 전 입력한 파일·회의 제목·일시·회의 목적은 연결과 pairing을
거쳐도 보존하고, 연결 완료 뒤 같은 작업으로 돌아와 분석을 시작하게 한다.

이번 묶음은 기존 해양 테마, 사이드바, 새 회의록의 2열 정보 구조와 분석 기능을
재설계하지 않는다. 실제 설치 파일 URL, 서명·manifest 배포, 전체 민감 API 인증
전환은 각각 3C 실물 관문과 5단계가 끝나기 전에는 활성화하지 않는다.

## 2. 실제 화면에서 확인한 기준

2026-08-20 Windows Vite 웹 앱을 `127.0.0.1:5174`에서 열고 로컬 엔진 포트
`17863`이 비어 있는 상태를 확인했다.

- 시작 화면과 새 회의록은 승인된 해양 브랜드 장면과 2열 입력 구조를 유지한다.
- 새 회의록은 엔진 미응답 상태에서도 설치·연결·문제 해결 동작을 표시하지 않는다.
- `MeetingWriter`는 최대 45초 동안 `/api/health`를 내부 재시도하지만
  `server-waiting`을 지속 상태로 표시하거나 분석 시작을 명확히 제한하지 않는다.
- 연결 상태는 `LocalEngineConnectionProvider`에 전송과 인증 두 축으로 이미
  존재하므로 화면에서 별도 health 의미를 다시 만들지 않는다.
- 모델 설정은 기존 기능을 보존한다. 연결 복구와 모델 준비를 한 장면에 섞지 않는다.

## 3. Mobbin에서 가져올 패턴

화면을 복제하지 않고 상태 위계와 복구 동작만 적용한다.

- [Portrait의 데스크톱 앱 다운로드·연결 흐름](https://mobbin.com/flows/e52f182e-6389-461e-a558-c2e33dfe7d56):
  현재 작업을 뒤에 보존한 채 설치와 연결을 짧은 별도 단계로 연다.
- [Tailscale 온보딩 흐름](https://mobbin.com/flows/8599ed56-357b-4026-bf3a-983a9d1070c4):
  한 단계에 한 가지 확인만 요구하고 완료 뒤 실제 연결 상태를 보여준다.
- [Google Meet 오류 화면](https://mobbin.com/screens/e5069b49-767a-4c2f-a3f2-6676a13f7b54):
  오류 이유와 `다시 시도`를 같은 표면에 두고 보조 복구 경로를 분리한다.
- [Revolut Business 연결 오류](https://mobbin.com/screens/b719158e-0a19-4b2e-8cc0-5217648ea20a):
  작업 영역 안에서 연결 문제와 재시도를 직접 연결한다.
- [OpenSea 파일·메타데이터 입력](https://mobbin.com/screens/b4326929-e8a3-4c16-bbe0-e590e11f26c6):
  파일 입력과 필수 정보를 한 작업으로 묶되 역할이 다른 두 열을 유지한다.
- [ElevenLabs 파일 입력](https://mobbin.com/screens/41cdfc88-ed04-4ed6-91bc-bc84247b860e):
  파일 선택 뒤 상태와 최종 실행 동작을 입력 맥락 안에서 이어 준다.

바로록에서는 Mobbin 예시의 브랜드, 카드 반경, 색, 영문 문구와 서비스 기능을
가져오지 않는다. `docs/design.md`의 토큰과 공통 컴포넌트가 우선한다.

## 4. 공통 배치

새 회의록의 파일·회의 정보 2열 아래에 `연결 작업 레일`을 둔다. 현재 오른쪽에
독립적으로 떠 있는 `분석 시작` 동작을 이 레일의 오른쪽에 넣고, 왼쪽은 로컬 처리
상태와 복구 동작을 소유한다.

- 레일은 상태가 바뀌어도 같은 너비와 최소 높이를 유지한다.
- 한 장면에서 primary 버튼은 하나만 둔다.
- 연결 전에는 연결·설치·복구 동작이 primary이고 `분석 시작`은 이유가 연결된
  disabled 상태다.
- 연결 완료 뒤에는 `분석 시작`만 primary가 되고 연결 상태는 체크 아이콘과 짧은
  문구로 낮춘다.
- 832px 미만 작업 폭에서는 상태 다음에 현재 주 행동을 쌓되, 버튼이 화면 밖으로
  밀리지 않게 한다.
- 지속 오류와 복구 안내만 인라인에 남기며 확인 완료는 레이아웃을 밀지 않는
  상태 아이콘 또는 토스트로 알린다.

일회성 코드 입력은 같은 앱 shell 위의 modal overlay로 연다. 배경의 새 회의록
입력과 스크롤 위치를 보존하고, 닫으면 코드를 저장하지 않은 채 연결 레일로
포커스를 돌려준다.

## 5. 여섯 장면 계약

| 장면 | 판정 근거 | 제목 | primary | 보조 동작 | 분석 시작 |
| --- | --- | --- | --- | --- | --- |
| 최초 방문 | 아직 사용자가 연결 확인을 시작하지 않음 | 이 PC에서 분석합니다 | 연결 확인 | 정보 툴팁 | disabled: 연결 필요 |
| 엔진 미응답 | 사용자 동작 뒤 `transport=unreachable` | 분석 기능에 연결하지 못했습니다 | 로컬 엔진 받기 | 다시 연결, 문제 해결 | disabled: 연결 필요 |
| 권한 필요·거부 | 브라우저에서 확인 가능한 권한 증거 | 브라우저 권한을 확인해 주세요 | 권한 확인 | 다시 연결, 문제 해결 | disabled: 권한 필요 |
| pairing 필요 | `reachable` + `authorization=unpaired` | 이 브라우저를 연결해 주세요 | 코드 입력 | 취소, 문제 해결 | disabled: 연결 필요 |
| 연결 완료 | `reachable` + `authenticated` + `analysis` | 분석 준비 완료 | 분석 시작 | 필요할 때만 연결 정보 | 입력 완성도에 따라 enabled |
| 세션 만료·폐기 | `expired` 또는 `revoked` | 연결이 만료되었습니다 | 다시 연결 | 문제 해결 | disabled: 재연결 필요 |
| 버전 불일치 | `incompatible` 또는 probe의 update 요구 | 업데이트가 필요합니다 | 업데이트 안내 | 다시 확인, 문제 해결 | disabled: 업데이트 필요 |

`권한 필요·거부` 장면은 Chrome/Edge에서 확인 가능한 Local Network Access 증거가
생기기 전에는 `unreachable`과 임의로 구분하지 않는다. 현재 preview의 view model과
simulation에서는 이 장면을 보류하며, 실제 HTTPS 승인·거부·재승인 smoke와 함께 닫는다.

`unreachable`만으로 `미설치` 또는 `실행되지 않음`을 확정하지 않는다. 설치 파일이
배포 준비 전이면 실제 웹 빌드에서 설치 동작을 노출하지 않고 `다시 연결`과 문제
해결만 제공한다. 검증된 installer URL이 연결된 뒤에만 `로컬 엔진 받기`를 주 행동으로
표시한다.

## 6. 상태 전환

1. 첫 방문에서는 자동 probe를 시작하지 않는다.
2. 사용자가 `연결 확인`을 누르면 `checking`으로 바꾸고 중복 실행을 막는다.
3. 이미 유효한 세션을 가진 브라우저만 앱 진입 뒤 자동 재연결을 시도한다.
4. `reachable`만으로 연결 완료를 표시하지 않는다. `authenticated`와 `analysis`
   capability가 함께 있어야 한다.
5. pairing 성공 뒤 사용자가 입력하던 새 회의록 상태를 그대로 보이고 연결 레일만
   완료 상태로 바꾼다.
6. 분석 중 세션이 만료되면 진행 상태를 임의로 성공·실패 처리하지 않고 현재
   backend 증거에 따라 재연결 또는 기존 분석 복구 흐름으로 보낸다.

## 7. 기존 컴포넌트 재사용표

| 역할 | 재사용 대상 | 결정 |
| --- | --- | --- |
| 연결 상태 소유 | `LocalEngineConnectionProvider` | 단일 상태 소유자로 유지 |
| probe·pairing·갱신 | `LocalEngineConnectionCoordinator` | 화면 직접 `fetch` 금지 |
| 주·보조 버튼 | `Button` | 기존 variant와 focus ring 사용 |
| 지속 오류·경고 | `StatusBanner` | 레일 내부의 durable 상태에만 사용 |
| 확인 중 진행 | `ProgressBar` 또는 기존 spinner | 숫자 진행률을 만들지 않음 |
| 일시 완료 | `AppToast` | 연결 완료를 긴 배너로 반복하지 않음 |
| 코드 입력 | `input-field` | 숫자 형식, label, 오류 연결, 붙여넣기 지원 |
| overlay 표면 | `settings-dialog`의 토큰·focus 관례 | 설정 컴포넌트 자체는 재사용하지 않음 |

새 컴포넌트는 상태 표시 책임의 `LocalEngineConnectionSurface`와 pairing 입력 책임의
`LocalEnginePairingDialog` 두 개로 제한한다. 다른 화면에 같은 계약이 반복되기
전에는 범용 onboarding 시스템이나 새 카드 계층을 만들지 않는다.

## 8. 문구와 접근성

- 일반 화면에서는 `server`, `API`, `pairing`, 포트와 모델명을 쓰지 않는다.
- 버튼은 `연결 확인`, `다시 연결`, `코드 입력`, `문제 해결`처럼 짧게 쓴다.
- 정상·진행 상태는 제목만 남기고 로컬 처리 설명은 정보 툴팁으로 공개한다. 오류·복구 상태만 사용자가 다음 행동을 결정하는 한 문장을 인라인으로 유지한다.
- 연결 전에는 비활성 `분석 시작`의 크기와 장식을 낮추고 연결 완료 뒤 기존 고래 CTA 강조를 복원한다.
- disabled 분석 버튼은 `aria-describedby`로 현재 제한 이유와 연결한다.
- 상태 변경은 `role=status`, 실패는 복구 동작과 함께 적절한 live region으로 알린다.
- pairing dialog는 제목, 설명, 코드 label, 오류, 닫기, focus trap과 focus return을
  갖는다. 일회성 코드를 URL·로그·`localStorage`·회의 기록에 저장하지 않는다.
- 200% 확대와 강제 색상에서도 상태를 색만으로 구분하지 않는다.

## 9. 구현·검증 순서

1. 상태를 화면용 view model로 매핑하는 순수 함수와 여섯 장면 fixture를 만든다.
2. `LocalEngineConnectionSurface`를 새 회의록 작업 레일에 연결한다.
3. `LocalEnginePairingDialog`를 coordinator의 시작·완료·만료 상태에 연결한다.
4. 기존 `MeetingWriter`의 45초 health 추측을 provider 상태 소비로 치환한다.
5. mock 상태로 최초 방문, 미응답, 권한, pairing, 연결됨, 만료, 버전 불일치를
   재현한다.
6. 760/1100/1536px, 낮은 데스크톱 높이, 키보드, 200% 확대, 강제 색상과
   reduced transparency에서 overflow·focus·입력 보존을 확인한다.
7. 집 PC 3C 실물 smoke 뒤 installer 결과와 Start Menu `바로록 연결` 동작을
   실제 HTTPS Chrome/Edge 장면에 연결한다.

### 9.1 2026-08-20 preview 구현 현황

- 완료: view model, 새 회의록 하단 연결 작업 레일, pairing dialog, 최초 방문·미응답·pairing·연결됨·만료·버전 불일치 상태 계약
- 완료: 만료·거부 challenge 폐기 후 새 pairing 발급, 일회성 코드 비저장·닫기 시 삭제, focus 시작·복귀·Tab 순환
- 완료: provider가 preview 연결 transport를 소유하고, `MeetingWriter` 모델 readiness가 이를 덮어쓰지 않도록 분리
- 완료: runtime boundary, 760/1100/1536px overflow, 입력 보존, 연결 후 분석 활성화 mock simulation
- 보류: 실제 installer/update URL, 권한 필요·거부 장면, 낮은 높이·200% 확대·강제 색상, 실제 HTTPS Chrome/Edge smoke

따라서 이 묶음은 4단계의 안전한 preview 구현이며 4단계 완료나 사용자 배포 준비를
뜻하지 않는다.

## 10. 현재 차단점

- 집 PC에서 unsigned NSIS installer의 fresh/update/recovery/uninstall smoke가 남아 있다.
- 코드 서명된 설치 파일과 검증된 배포 manifest URL이 없다.
- 실제 Chrome/Edge Local Network Access 승인·거부·재승인 증거가 없다.
- 5단계 전체 API 클라이언트 전환과 default deny 활성화 전에는 사용자 대상
  다운로드 CTA를 배포할 수 없다.

따라서 다음 구현은 mock 상태와 비활성 배포 경계를 사용하며, 위 차단점을 통과하기
전에는 4단계 완료 또는 사용자 배포 준비로 표시하지 않는다.
