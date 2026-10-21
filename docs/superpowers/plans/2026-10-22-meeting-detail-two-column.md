# 회의 상세 2단 배치 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 회의 상세(분석 진행 포함)를 "머리글 + 왼쪽 회의 정보 칸 + 오른쪽 탭 영역"으로 바꾸고, 좁은 창에서는 회의 정보 칸 대신 앱 메뉴를 아이콘 줄로 접는다.

**Architecture:** `MeetingHistory`의 상세 JSX를 머리글(`.meeting-detail-overview`)과 2단 묶음(`.meeting-detail-columns` = `aside.meeting-detail-info` + `.meeting-detail-main`)으로 나누고, 2단 여부는 CSS 컨테이너 쿼리(`meeting-detail-shell`, 50rem)가 정한다. 분석·참석자 구분 진행 패널의 portal 대상(`.meeting-analysis-content`, `analysisStatusRef`)과 `<audio>` 요소는 정보 칸 안에 그대로 두어 진행→완료 전환과 재생이 끊기지 않게 한다. 앱 메뉴는 `Layout`이 접힘 상태(펼침·아이콘 줄·겹쳐 열림)를 정하고 `Sidebar` 한 인스턴스가 상태에 맞게 그린다.

**Tech Stack:** React + TypeScript, Vite, Tailwind v4 + `src/index.css`, lucide-react 아이콘, Playwright 시뮬레이션 스크립트(`desktop-app/scripts/simulate-*.mjs`, 단위 테스트 프레임워크 없음).

**Spec:** `docs/design.md` 「회의 상세·분석 진행 2단 배치 (2026-10-22 채택, 구현 전)」. 시안: Figma `A8ny8v22BU9Wj6fvHaOIxG`의 D2 `44:1691`, D3 `45:1706`, D4 `46:1736`, D5 `47:1758`. 시안과 spec이 다르면(진행 패널 위치 등) spec이 우선이다.

## Global Constraints

- 2단 기준: `@container meeting-detail-shell (min-width: 50rem)`. 미만이면 지금처럼 회의 정보가 탭 위에 쌓인다(요약 줄·`정보 보기` 버튼은 만들지 않음).
- 정보 칸 폭 `17.5rem`(280px), 오른쪽 경계선 1px `var(--border-default)`. 탭 영역 `max-width: 64rem`, 왼쪽 여백 `2rem`.
- 기존 `@container meeting-detail (min-width: 40rem)` 규칙(대화록 3열 행 등)은 탭 영역 폭 기준이 된다. 컨테이너 이름 `meeting-detail`은 `.meeting-detail-main`으로 옮기고 `.meeting-detail-shell`은 `meeting-detail-shell`이 된다.
- 앱 메뉴:
  - 아이콘 줄 폭은 `3.5rem`(56px), 펼친 메뉴는 지금의 `w-60`(240px)이다.
  - 좁은 창 판단: `window.matchMedia('(max-width: 1199.98px)')`.
  - 넓은 창의 접힘 선택은 `localStorage` 키 `sidebarCollapsed`(`'1'`/`'0'`)에 저장한다. 읽기·쓰기는 모두 `try/catch`로 감싸고, 실패하면 펼침으로 본다.
- 문구:
  - 앱 메뉴 버튼: `메뉴 접기`, `메뉴 펼치기`, `회의록 목록`, `새 회의록`, `설정`. 진행 아이콘 버튼은 기존 숨김 문구와 같은 `분석 진행 화면 열기`.
  - 재생 오류 문구의 `상단 음성 재생기`는 `음성 재생기`로 바꾼다.
  - 그 밖의 문구는 바꾸지 않는다.
- 새 데이터를 만들지 않는다. 머리글 폴더 경로, 머리글 `내보내기`·더보기, 결정 사항 시간 링크는 넣지 않는다. 탭 순서(`대화록`·`기록 정리`·`보고서`)는 그대로다.
- `ref={analysisStatusRef}` 대상(`.meeting-analysis-content`)과 `<audio className="meeting-audio-player" ref={reviewAudioRef}>`는 DOM에 하나만 있고, 폭이나 메뉴 상태가 바뀌어도 다시 마운트되지 않는다.
- 연속성 기준(기존 `simulate-analysis-stop-flow.mjs`): 1280·760 폭에서 준비→진행→완료→다시 열기 동안 `.meeting-detail-title`, `.detail-main-nav`, `.detail-search-field`, `.detail-command-bar-script`의 x/y가 ±1px 안에서 유지된다.
- 새 회의록 화면(`.writer-shell`, `--rail-content: 55rem`)과 설정 창은 바꾸지 않는다.
- 작업 트리에는 다른 세션의 커밋 안 된 수정(`MeetingHistory.tsx`, `index.css`, `simulate-*.mjs`, `docs/design.md` 등)이 있다. 커밋할 때는 이 작업의 hunk만 패치로 만들어 `git apply --cached`로 올리고, `git diff --cached`로 확인한 뒤 staged 상태 기준으로 `tsc --noEmit`을 돌린다. 다른 사람의 수정을 되돌리거나 함께 커밋하지 않는다.
- 명령은 `D:\Projects\audio`에서 실행한다. 아래 `SIM`은 `PLAYWRIGHT_BROWSERS_PATH=D:/Projects/audio/.cache/ms-playwright corepack pnpm --dir desktop-app exec node --experimental-strip-types`를 뜻한다(`docs/frontend-simulation-testing.md`).
- 검증 순서: `corepack pnpm --dir desktop-app typecheck` → `corepack pnpm --dir desktop-app exec eslint <바꾼 파일>` → 해당 시뮬레이션.

## Review Focus

1. 70자 넘는 긴 회의 제목: 제목은 줄바꿈되고 오른쪽 동작 버튼과 겹치지 않는다. (Task 1 `columns`)
2. 음성·참석자·회의 목적이 없는 회의록: 값 없는 행이 숨겨져도 2단에서 탭 줄 위치가 음성 있는 회의록과 같다. (Task 1에서 기존 `runAudioRowScenario`가 1280에서 통과)
3. 겹쳐 열린 메뉴를 둔 채 창을 1200px 이상으로 넓힘: 겹친 메뉴는 닫히고, 기억한 선택(없으면 펼침)으로 돌아온다. 화면에 메뉴가 두 개 보이거나 내용이 가려진 채 남지 않는다. (Task 2)
4. 좁은 창에서 분석 중: 아이콘 줄에 진행 아이콘이 보이고 `새 회의록`은 비활성이다. 사이드바 포커스가 갈 곳을 잃으면 진행 아이콘, 그다음 로고로 간다. (Task 2, `simulate-analysis-stop-flow.mjs` 760 폭)
5. 280px 정보 칸 안의 분석 중지 확인(`중지`·`취소`·`계속`)과 참석자 구분 중지 확인: 버튼이 칸 밖으로 넘치지 않고 정보 칸에 가로 스크롤이 없다. (Task 3)

---

### Task 1: 머리글과 2단 묶음(상세 영역 50rem 이상)

**Files:**
- Modify: `desktop-app/src/MeetingHistory.tsx:4022-4325` (머리글·속성·탭 줄 재구성), `:5124` (재생 오류 문구)
- Modify: `desktop-app/src/index.css:1227-1407` (상세 머리글·속성·상태 규칙), `:1451-1455` (`.meeting-detail-shell`), `:1535-1547` (`.detail-main-nav`)
- Test: `desktop-app/scripts/simulate-meeting-detail-layout.mjs` (새 `runColumnsScenario`, argv `columns`)
- Test: `desktop-app/scripts/simulate-analysis-stop-flow.mjs` (`.meeting-detail-overview-main` 테두리 단언 교체)

**Interfaces:**
- Produces (DOM, 이후 작업이 사용):
  - `div.app-panel-header.meeting-detail-overview`: 제목 줄(`.meeting-detail-title-row` = 제목 또는 수정 중 제목 입력 + `.meeting-detail-actions`)만 담는다. 테두리 상자 `.meeting-detail-overview-main`은 없앤다.
  - `div.meeting-detail-columns`: 순서대로 두 자식을 담는다.
    - `aside.meeting-detail-info[aria-label="회의 정보"]`: 수정 중 일시·회의 목적 입력(지금 MH:4093-4110), `dl.meeting-meta-list`, 머리글 오류 줄 `DetailStatusLine`(지금 MH:4260).
    - `div.meeting-detail-main`: `.detail-main-nav`, `.meeting-detail-body`.
  - CSS 컨테이너: `.meeting-detail-shell`은 `container-name: meeting-detail-shell`, `.meeting-detail-main`은 `container-name: meeting-detail`. 둘 다 `container-type: inline-size`.

- [ ] **Step 1: 실패하는 `runColumnsScenario(browser, { width, height })` 작성**

  `segments`를 반복해 대화 60개짜리 회의록(제목 72자, 음성 있음)을 `putMeetings`로 넣고 1280×720, 1440×900에서 연다. argv에 `columns`가 있으면 두 폭을 실행한다. 단언:

  ```js
  assert.ok(info.right <= tablist.left + 1, 'info panel sits left of the tabs');
  assert.ok(Math.abs(info.width - 280) <= 1, `info panel is 280px, got ${info.width}`);
  assert.ok(tablist.top <= header.bottom + 24, 'tabs start right under the header');
  assert.ok(title.right <= actions.left + 1, 'long title does not run under the actions');
  // after workspace.scrollTop = 1500
  assert.ok(audioAfter.top >= 0 && audioAfter.bottom <= innerHeight, 'audio player stays visible while reading');
  assert.ok(tablistAfter.top >= workspaceTop - 1 && tablistAfter.top <= workspaceTop + 2, 'tab bar sticks to the top');
  assert.ok(documentOverflow <= 0);
  ```

  각 rect는 다음 요소에서 잰다.
  - `tablist`: `[role=tablist][aria-label="회의록 상세"]`
  - `header`: `.meeting-detail-overview`
  - `actions`: `.meeting-detail-actions`
  - `workspaceTop`: `.barorok-workspace`의 top

- [ ] **Step 2: 실패 확인** — Run: `SIM scripts/simulate-meeting-detail-layout.mjs columns` / Expected: FAIL — `.meeting-detail-info` 없음.

- [ ] **Step 3: JSX 재구성**

  위 Interfaces 구조대로 기존 블록을 옮긴다. 값·조건·핸들러는 그대로 두고 감싸는 요소만 바꾼다. MH:5124 문구는 `해당 구간을 재생하지 못했습니다. 음성 재생기를 확인해 주세요.`로 바꾼다.

- [ ] **Step 4: CSS**
  - `.meeting-detail-shell`: `mx-auto max-w-[var(--rail-content)]`를 빼고 `w-full`로 둔다. 컨테이너 이름은 `meeting-detail-shell`.
  - `.meeting-detail-overview`: 아래 경계선 1px, 아래 여백 `1.25rem`. `.meeting-detail-overview-main` 규칙은 지운다.
  - `.meeting-detail-main`: 컨테이너 `meeting-detail`, `min-width: 0`.
  - `.detail-main-nav`: `position: sticky; top: 0; z-index: 10; background: var(--color-neutral-0)`. 이 규칙은 두 모드 모두에 적용한다.
  - `@container meeting-detail-shell (min-width: 50rem)` 안:
    - `.meeting-detail-columns { display: grid; grid-template-columns: 17.5rem minmax(0, 1fr); align-items: start; }`
    - `.meeting-detail-info { position: sticky; top: 0; max-height: calc(100dvh - 4rem); overflow-y: auto; padding: 1.5rem 1.5rem 1.5rem 0; border-right: 1px solid var(--border-default); }`
    - `.meeting-detail-main { padding-left: 2rem; max-width: 64rem; }`
    - 정보 칸 안의 `.meeting-meta-item`은 `grid-template-columns: minmax(0, 1fr)`로 바꿔 라벨을 값 위에 둔다.
    - 회의 목적의 줄 수 제한을 푼다.
    - `.meeting-status-grid`는 한 열로 바꾸고, 각 항목을 `항목명 왼쪽, 체크·배지 오른쪽`으로 둔다.

- [ ] **Step 5: 연속성 단언 교체** — `simulate-analysis-stop-flow.mjs`의 `.meeting-detail-overview-main` `borderTopWidth === '1px'` 단언을 `.meeting-detail-overview` `borderBottomWidth === '1px'`로 바꾼다.

- [ ] **Step 6: 검증**

  Run:
  - typecheck
  - `eslint src/MeetingHistory.tsx scripts/simulate-meeting-detail-layout.mjs scripts/simulate-analysis-stop-flow.mjs`
  - `SIM scripts/simulate-meeting-detail-layout.mjs columns`
  - `SIM scripts/simulate-meeting-detail-layout.mjs` (기본 묶음: 760 속성 행은 쌓인 배치로 통과)
  - `SIM scripts/simulate-analysis-stop-flow.mjs detail-continuity`
  - `SIM scripts/simulate-analysis-stop-flow.mjs diarization-continuity`

  Expected: 모두 `ok`.

- [ ] **Step 7: Commit** — `feat(detail): split meeting detail into header, info panel and tab column`

### Task 2: 앱 메뉴 접기(아이콘 줄·겹쳐 열기)

**Files:**
- Create: `desktop-app/src/useSidebarCollapse.ts`
- Modify: `desktop-app/src/Layout.tsx:36-66` (상태 연결, 겹친 메뉴용 56px 자리)
- Modify: `desktop-app/src/Sidebar.tsx:868` (`aside.barorok-navigation`과 브랜드 줄), `:146-152` (포커스 대체 로직), `:1250-1277` (분석 중 카드)
- Modify: `desktop-app/src/index.css` (`.barorok-navigation` 아이콘 줄·겹침 규칙)
- Create: `desktop-app/scripts/simulate-sidebar-collapse.mjs`, `desktop-app/package.json`에 `"test:sidebar-collapse": "node scripts/simulate-sidebar-collapse.mjs"`
- Modify: `desktop-app/scripts/simulate-meeting-detail-flow.mjs:1585-1644` (800 폭 메뉴 단언 전에 메뉴 펼치기)
- Modify: `desktop-app/scripts/simulate-analysis-stop-flow.mjs` (760 폭 단언 추가)

**Interfaces:**
- Consumes: Task 1의 `.meeting-detail-info`, `[role=tablist][aria-label="회의록 상세"]`
- Produces:
  - `export type SidebarMode = 'expanded' | 'rail' | 'overlay'`
  - `export function useSidebarCollapse(): { mode: SidebarMode; narrow: boolean; collapse: () => void; expand: () => void; close: () => void }` (`useSidebarCollapse.ts`)
    - 넓은 창: `collapse`/`expand`가 `expanded`↔`rail`을 바꾸고 `sidebarCollapsed`에 저장한다. `close`는 아무 일도 하지 않는다.
    - 좁은 창: 기본이 `rail`이다. `expand`는 `overlay`, `close`·`collapse`는 `rail`로 바꾼다. 저장값은 읽지도 쓰지도 않는다.
    - `narrow`가 바뀌면 `overlay`를 닫고, 넓은 창이면 저장값(없으면 `expanded`)으로 돌아간다.
  - `Sidebar` 새 props: `mode: SidebarMode; onCollapse: () => void; onExpand: () => void; onRequestClose: () => void`
  - DOM:
    - `aside.barorok-navigation[data-mode]`
    - 아이콘 줄 버튼 `.sidebar-rail-button`(각각 `aria-label`·`title`), 펼치기 버튼 `.sidebar-rail-expand`, 진행 아이콘 `.sidebar-rail-analysis`
    - 브랜드 줄의 `button.sidebar-collapse-button[aria-label="메뉴 접기"]`
    - `overlay`일 때 Layout이 흐름 안에 두는 `div.sidebar-rail-spacer`(56px)

- [ ] **Step 1: 실패하는 `simulate-sidebar-collapse.mjs` 작성**

  `simulate-meeting-detail-layout.mjs`의 서버·경로·`putMeetings`·`openMeeting` 도우미 방식을 따른다. 시나리오와 단언:
  - **1280×720:** `.barorok-navigation` 폭이 240이다. `메뉴 접기`를 누르면 폭이 56이고 `.barorok-workspace` left가 56이다. 새로고침 뒤에도 56이다. `메뉴 펼치기`를 누르면 240이다.
  - **1024×768, 빈 저장소:**
    - 첫 화면: 메뉴 폭 56, `.meeting-detail-info` right ≤ tablist left + 1(2단).
    - `메뉴 펼치기`: `aside[data-mode="overlay"]` 폭 240. `.barorok-workspace` left와 `.meeting-detail-info` rect는 펼치기 전과 ±1px 같다.
    - `Escape`: 겹친 메뉴가 닫히고 `document.activeElement`가 `.sidebar-rail-expand`다.
    - 다시 펼친 뒤 다른 회의록 행 클릭: 겹친 메뉴가 닫히고 그 회의록 제목이 열린다.
    - 다시 펼친 뒤 작업면 클릭: 닫힌다.
  - **Review Focus 3:** 1024에서 겹친 메뉴를 연 채 `setViewportSize({ width: 1280, height: 720 })` 한다. `aside[data-mode="expanded"]` 하나만 남고 `.sidebar-rail-spacer`는 없다.
  - **새 회의록 화면 1024:** 아이콘 줄의 `새 회의록` 버튼이 보이고 누르면 새 회의록 화면 제목이 보인다.

- [ ] **Step 2: 실패 확인** — Run: `SIM scripts/simulate-sidebar-collapse.mjs` / Expected: FAIL — `메뉴 접기` 버튼 없음.

- [ ] **Step 3: `useSidebarCollapse` 구현**

  `matchMedia` 변경 리스너와 저장소 접근(`try/catch`)을 담는다. Layout이 한 번 호출한다.

- [ ] **Step 4: `Sidebar`·`Layout` 연결**
  - **`mode === 'rail'`:** `Sidebar`가 아이콘 줄만 그린다. 순서는 로고(기존 `onOpenStart`/진행 화면 동작), `새 회의록`(기존 `newMeetingBlocked` 비활성·`aria-describedby` 유지), `회의록 목록`(`onExpand`), `analysisStatus?.active`일 때 `.sidebar-rail-analysis`(`onOpenAnalysis`), 아래쪽 `설정`, `.sidebar-rail-expand`.
    - 이어서 할 분석이 있으면 `회의록 목록` 아이콘에 점(`.sidebar-rail-dot`, 숨김 문구 `이어서 할 분석 있음`)을 단다.
  - **`expanded`·`overlay`:** 지금 메뉴를 그리고 브랜드 줄 오른쪽에 `메뉴 접기`(`onCollapse`)를 둔다.
  - **`overlay`:**
    - aside는 `position: absolute; inset-block: 0; left: 0; z-index: 40; box-shadow: var(--shadow-overlay)`이다.
    - Layout은 흐름 안에 `.sidebar-rail-spacer`를 둔다.
    - Sidebar는 `keydown` Escape와 바깥 `pointerdown`에서 `onRequestClose`를 부르고, 닫힌 뒤 `.sidebar-rail-expand`로 포커스를 옮긴다.
    - Layout은 `onSelectMeeting`·`onCreateMeeting`·`onSelectResumeDraft`·`onOpenSettings`·`onOpenAnalysis`를 감싸 `overlay`일 때 `close()`도 부른다.
  - **포커스 대체 순서(Sidebar.tsx:146-152):** `.sidebar-analysis-card` → `.sidebar-rail-analysis` → 로고.

- [ ] **Step 5: 기존 시나리오 맞추기**
  - `simulate-meeting-detail-flow.mjs` 800 폭 구간: 행 메뉴를 열기 전에 `메뉴 펼치기`를 누른다. 메뉴 bounds 단언(`left >= 0 && right <= 800`)은 그대로 둔다.
  - `simulate-analysis-stop-flow.mjs`의 `runDetailContinuityScenario` 760 폭 진행 중 단계에 다음 단언을 더한다.
    - `.sidebar-rail-analysis`가 보인다.
    - 아이콘 줄 `새 회의록`이 비활성(`disabled` 또는 `aria-disabled="true"`)이다.
  - 연속성 앵커 단언은 바꾸지 않는다.

- [ ] **Step 6: 검증**

  Run:
  - typecheck
  - `eslint src/useSidebarCollapse.ts src/Sidebar.tsx src/Layout.tsx scripts/simulate-sidebar-collapse.mjs scripts/simulate-meeting-detail-flow.mjs scripts/simulate-analysis-stop-flow.mjs`
  - `SIM scripts/simulate-sidebar-collapse.mjs`
  - `SIM scripts/simulate-meeting-detail-flow.mjs`
  - `SIM scripts/simulate-analysis-stop-flow.mjs detail-continuity`
  - `SIM scripts/simulate-analysis-stop-flow.mjs diarization-continuity`
  - `SIM scripts/simulate-meeting-detail-layout.mjs`

  Expected: 모두 통과.

- [ ] **Step 7: Commit** — `feat(shell): collapsible app menu with icon rail and overlay on narrow windows`

### Task 3: 280px 정보 칸 안의 진행·중지 확인 패널

**Files:**
- Modify: `desktop-app/src/index.css:2428-2500` (`.meeting-analysis-status` 안 writer 패널 규칙)
- Test: `desktop-app/scripts/simulate-analysis-stop-flow.mjs` (stop-actions·`runDetailContinuityScenario`·`runDiarizationContinuityScenario`에 1280 단언 추가)

**Interfaces:**
- Consumes: Task 1의 `.meeting-detail-info`(2단에서 280px), 기존 portal 대상 `.meeting-analysis-content`. JSX 변경은 없을 것으로 보고, 필요하면 클래스만 더한다.

- [ ] **Step 1: 실패하는 단언 추가(1280×720)**
  - **분석 진행 중:** `.meeting-analysis-status` right ≤ 탭 목록 left + 1. `.writer-analysis-panel` bottom ≤ `innerHeight`(기존 단언 유지).
  - **중지 확인을 연 상태(`.analysis-stop-panel`):** 그 안의 모든 `button` right ≤ `.meeting-detail-info` right + 1. `.meeting-detail-info`의 `scrollWidth - clientWidth ≤ 0`.
  - **참석자 구분 중지 확인(`.diarization-stop-panel`):** 같은 두 단언.

- [ ] **Step 2: 실패 확인** — Run: `SIM scripts/simulate-analysis-stop-flow.mjs stop-actions` / Expected: 버튼이 정보 칸 밖으로 넘친다는 FAIL.

- [ ] **Step 3: CSS**

  50rem 이상 컨테이너 쿼리 안에서만 바꾼다.
  - `.meeting-detail-info .writer-analysis-timing`과 중지 확인 버튼 묶음에 `flex-wrap: wrap`. 실제 클래스는 MH:3866-3902와 MeetingWriter.tsx:3360에서 확인한다.
  - 설명 문장에 `min-width: 0`.
  - `.meeting-analysis-status`의 고정 `height: 9rem`과 `:has(...)` 확장 규칙은 유지한다.
  - 문구·버튼 수·순서는 바꾸지 않는다.

- [ ] **Step 4: 검증**

  Run: typecheck, 그리고 `SIM scripts/simulate-analysis-stop-flow.mjs <argv>`를 `stop-actions`, `detail-continuity`, `diarization-continuity`, `failure-recovery`, `failure-causes`, `preparation` 순서로 하나씩 실행한다.

  Expected: 모두 통과.

- [ ] **Step 5: Commit** — `fix(detail): keep progress and stop panels inside the info panel`

### Task 4: 문서 정리와 전체 확인

**Files:**
- Modify: `docs/design.md` (「회의 상세·분석 진행 2단 배치」, 「콘텐츠 레일」, 「앱 셸과 사이드바」)
- Modify: `docs/frontend-simulation-testing.md` (`columns` 시나리오, `test:sidebar-collapse`)
- Modify: `todo.md` (미룬 항목)

- [ ] **Step 1: 측정 후 design.md 갱신**
  - 1280×720과 1024×768에서 탭 목록 top과 대화록 첫 발화 top을 잰다(`columns`·`simulate-sidebar-collapse` 시나리오에 `console.log`).
  - 「콘텐츠 레일」의 880px 문서 열·120px 라벨 배치·처리 상태 3열·탭 너비·첫 화면 기준 항목을 새 절을 가리키는 짧은 문장과 잰 값으로 바꾼다.
  - 「앱 셸과 사이드바」의 `240px 고정 폭` 문장에 접기 규칙 참조를 단다.
  - 절 제목의 `구현 전`을 `구현 완료(커밋 해시)`로 바꾸고 2026-10-22 안내 줄을 지운다.

- [ ] **Step 2: todo.md에 미룬 항목 기록**
  - 머리글 폴더 경로: 상세가 폴더 이름을 받아야 한다.
  - 머리글 `내보내기`: 지금은 탭별 다운로드다.
  - 결정 사항·할 일의 대화 위치 링크: 근거 위치 저장이 필요하다.
  - D3처럼 진행 패널을 탭 영역에 두는 안: 연속성 기준 재검토가 필요하다.

- [ ] **Step 3: 전체 검증**

  Run(순서대로, 하나씩):
  - typecheck, `corepack pnpm --dir desktop-app lint`
  - `SIM scripts/simulate-meeting-detail-layout.mjs` (기본, `columns`, `review`, `summary-review`, `meta`)
  - `SIM scripts/simulate-sidebar-collapse.mjs`
  - `SIM scripts/simulate-analysis-stop-flow.mjs` (각 argv)
  - `SIM scripts/simulate-meeting-detail-flow.mjs`, `SIM scripts/simulate-audio-playback.mjs`, `SIM scripts/simulate-audio-back-navigation.mjs`, `SIM scripts/simulate-report-tab-edge-flow.mjs`
  - 새 회의록 화면 회귀: `SIM scripts/simulate-new-record-home-flow.mjs`

  Expected: 모두 통과. 실패하면 출력과 함께 기록하고 고친다.

- [ ] **Step 4: 사용자 확인용 화면 저장**
  - 1440×900, 1280×720, 1024×768에서 완료된 회의록, 분석 진행 중, 1024 메뉴 펼침 화면을 `D:\Projects\audio\.tmp\meeting-detail-two-column\`에 PNG로 저장한다.
  - 이 화면들은 Vite 개발 UI 검증이다. 로컬 엔진 연결이나 데스크톱 실행 파일 동작을 증명하지 않는다.

- [ ] **Step 5: 독립 리뷰 후 Commit**

  AGENTS.md의 iterative-dev-loop·engineering-reviewer 절차대로 독립 agent 리뷰를 한 번 받는다. 막는 문제만 고친 뒤 `docs: record two-column meeting detail and collapsible menu`로 커밋한다. 푸시하지 않는다.
