import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const shouldStartServer = !process.env.APP_URL;

const waitForApp = async (url, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until the dedicated Vite server is ready.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const startServer = async () => {
  if (!shouldStartServer) return null;
  try {
    await waitForApp(APP_URL, 1000);
    return null;
  } catch {
    // Start a server only when the configured port is unused.
  }
  const url = new URL(APP_URL);
  const child = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', `corepack pnpm exec vite --host ${url.hostname} --port ${url.port || '5173'}`],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  await waitForApp(APP_URL);
  return child;
};

const stopServer = async child => {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const killer = spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `taskkill /pid ${child.pid} /t /f`],
      { stdio: 'ignore', windowsHide: true },
    );
    killer.on('exit', resolve);
    killer.on('error', resolve);
  });
};

const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const installBaseRoutes = async page => {
  await page.route('**/api/**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/health', route => route.fulfill(json({ ok: true })));
  await page.route('**/api/settings', route => route.fulfill(json({ diarization: { enabled: true, generate_during_analysis: true } })));
  await page.route('**/api/models/status', route => route.fulfill(json({ ready: true, models: [] })));
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill(json({ drafts: [] })));
};

const putMeetings = async (page, meetings) => page.evaluate(values => new Promise((resolve, reject) => {
  const request = indexedDB.open('MeetingHistoryDB', 2);
  request.onerror = () => reject(request.error);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('meetings')) db.createObjectStore('meetings', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
  };
  request.onsuccess = () => {
    const db = request.result;
    const transaction = db.transaction('meetings', 'readwrite');
    const store = transaction.objectStore('meetings');
    values.forEach(value => store.put(value));
    transaction.oncomplete = () => {
      db.close();
      window.dispatchEvent(new Event('meetings:updated'));
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  };
}), meetings);

const segments = [
  { start: '00:00:03', end: '00:00:18', speaker: 'SPEAKER_00', text: '3분기 자원조사 결과를 정리하겠습니다.' },
  { start: '00:00:19', end: '00:00:41', speaker: 'SPEAKER_01', text: '고등어 어획량이 전 분기 대비 약 18% 줄었습니다. 수온이 평년보다 높게 유지되면서 어군이 북쪽으로 이동한 것으로 보입니다.' },
];

const baseMeeting = {
  date: '2026-10-14 13:00',
  participants: '',
  summary: '어획량 감소 원인과 장비 교정 일정을 정리했다.',
  segments,
  displaySegments: segments,
  speakerLabels: { SPEAKER_00: '김연구', SPEAKER_01: '박조사' },
  analysisStatus: 'completed',
  generationStatus: { summary: 'completed', topicSections: 'completed' },
};

const topicMeeting = {
  ...baseMeeting,
  id: 'layout-topic-meeting',
  title: '주제 칩 이동 확인',
  topics: ['어획량 감소', '장비 교정', '어획량 감소와 수온', '음향 장비 교정'],
  topicSections: [
    { topic: '어획량 감소와 수온', summary: '수온 상승으로 어군이 북상했다.' },
    { topic: '음향 장비 교정', summary: '10월 말까지 교정을 마친다.' },
  ],
};

const narrowMeeting = {
  ...baseMeeting,
  id: 'layout-narrow-meeting',
  title: '좁은 폭 메타 확인',
  meetingPurpose: '아주 긴 회의 목적 문장입니다. 상반기 사업 현황 점검과 결정사항, 후속 조치 담당자 지정까지 모두 다룹니다',
  sourceFile: '아주-긴-원본-파일-이름-2026-10-14-회의.m4a',
  analysisStatus: 'diarization_failed',
  diarizationRequested: true,
  jobId: 'layout-narrow-job',
};

const openMeeting = async (page, title) => {
  await page.locator('.barorok-navigation').getByText(title, { exact: true }).click();
  await page.locator('.meeting-detail-shell').getByRole('heading', { name: title }).waitFor({ timeout: 10000 });
};

const runTopicChipScenario = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor({ timeout: 10000 });
    await putMeetings(page, [topicMeeting]);
    await openMeeting(page, topicMeeting.title);
    await page.getByRole('tab', { name: '기록 정리', exact: true }).click();

    const chips = page.locator('.summary-topic-list .topic-chip');
    await chips.first().waitFor({ timeout: 10000 });
    assert.deepEqual(await chips.allTextContents(), ['어획량 감소와 수온', '음향 장비 교정'], 'summary chips should use deduplicated topic section titles');

    // Visit the topic sections once so their nodes unmount before the chip is used.
    await page.getByRole('tab', { name: '주제별 정리', exact: true }).click();
    await page.locator('#organize-mode-panel-topics').waitFor();
    await page.getByRole('tab', { name: '전체 요약', exact: true }).click();
    await page.locator('.summary-topic-list').getByRole('button', { name: '음향 장비 교정' }).click();

    await page.waitForFunction(() => document.activeElement?.classList.contains('topic-section-heading'));
    assert.equal(await page.getByRole('tab', { name: '주제별 정리', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '음향 장비 교정', 'focus should move to the opened topic heading');
    const sectionInViewport = await page.evaluate(() => {
      const heading = document.activeElement;
      const article = heading?.closest('article');
      if (!article?.isConnected) return false;
      const rect = article.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });
    assert.ok(sectionInViewport, 'the selected topic section should be connected and visible');
    console.log('ok - summary topic chip dedupes and opens the topic after a tab round-trip');
  } finally {
    await context.close();
  }
};

const runNarrowMetaScenario = async browser => {
  const context = await browser.newContext({ viewport: { width: 760, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor({ timeout: 10000 });
    await putMeetings(page, [narrowMeeting]);
    await openMeeting(page, narrowMeeting.title);
    await page.locator('.meeting-status-grid').waitFor();
    const metrics = await page.evaluate(() => {
      const list = document.querySelector('.meeting-meta-list');
      const listRect = list?.getBoundingClientRect();
      const rows = [...document.querySelectorAll('.meeting-meta-item')].map(row => {
        const label = row.querySelector('.meeting-meta-label').getBoundingClientRect();
        const value = row.querySelector('.meeting-meta-value').getBoundingClientRect();
        return { overflow: row.scrollWidth - row.clientWidth, labelRight: label.right, valueLeft: value.left, valueRight: value.right };
      });
      // Measure the actual inline content, not the stretched block boxes.
      const inlineParts = [...document.querySelectorAll('.meeting-status-grid .status-pill, .meeting-status-grid button, .meeting-participant-chip, .meeting-meta-value-source')];
      const statusParts = [...document.querySelectorAll('.meeting-status-grid .status-pill, .meeting-status-grid button')];
      return {
        rowCount: rows.length,
        rowOverflow: Math.max(...rows.map(row => row.overflow)),
        labelOverlap: rows.some(row => row.labelRight > row.valueLeft + 1),
        valueOutside: inlineParts.some(part => listRect && part.getBoundingClientRect().right > listRect.right + 1),
        statusInside: statusParts.length > 0 && statusParts.every(part => listRect && part.getBoundingClientRect().right <= listRect.right + 1),
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.ok(metrics.rowCount >= 4, `expected property rows, got ${metrics.rowCount}`);
    assert.ok(metrics.rowOverflow <= 1, `a property row overflowed by ${metrics.rowOverflow}px`);
    assert.equal(metrics.labelOverlap, false, 'property labels should not overlap their values');
    assert.equal(metrics.valueOutside, false, 'property values should stay inside the list');
    assert.equal(metrics.statusInside, true, 'status chips should stay inside the property list');
    assert.ok(metrics.documentOverflow <= 0, `document overflowed by ${metrics.documentOverflow}px`);
    console.log('ok - narrow meeting property rows fit without overlap');
  } finally {
    await context.close();
  }
};

const runTranscriptRowScenario = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor({ timeout: 10000 });
    await putMeetings(page, [{ ...topicMeeting, id: 'layout-row-meeting', title: '대화록 행 확인' }]);
    await openMeeting(page, '대화록 행 확인');
    await page.locator('.script-row').first().waitFor();
    const rowTops = async textSelector => page.locator('.script-row').first().evaluate((row, selector) => (
      ['.script-time-range', '.script-meta', selector].map(part => Math.round(row.querySelector(part).getBoundingClientRect().top))
    ), textSelector);
    const [timeTop, metaTop, textTop] = await rowTops('.script-text');
    assert.ok(timeTop === metaTop && metaTop === textTop, `wide transcript row should share one line: ${timeTop}/${metaTop}/${textTop}`);
    await page.getByRole('button', { name: '대화록 편집', exact: true }).click();
    const [editTimeTop, , editTextTop] = await rowTops('.script-edit-textarea');
    assert.ok(Math.abs(editTimeTop - editTextTop) <= 1, 'edit textarea should stay in the text column of the same row');
    console.log('ok - transcript rows keep time, speaker and text on one line');
  } finally {
    await context.close();
  }
};

const runAudioRowScenario = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  // Hold the audio check so the 확인 중 state can be measured before the 404 arrives.
  let releaseAudioCheck = () => undefined;
  let audioCheckGate = new Promise(resolve => { releaseAudioCheck = resolve; });
  await page.route('**/api/outputs/*/audio', async route => {
    await audioCheckGate;
    return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
  });
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor({ timeout: 10000 });
    const outputs = job => ({ job_id: job, json: `/api/outputs/${job}/json`, txt: `/api/outputs/${job}/txt` });
    // diarizationApplied keeps the participant guidance line (DT-11), which follows a missing audio file, out of this check.
    await putMeetings(page, [
      { ...baseMeeting, id: 'layout-audio-unknown', title: '음성 확인 회의', jobId: 'layout-audio-unknown-job', diarizationApplied: true },
      { ...baseMeeting, id: 'layout-audio-none', title: '음성 미보관 회의', jobId: 'layout-audio-none-job', diarizationApplied: true, outputFiles: outputs('layout-audio-none-job') },
    ]);
    const tabListTop = () => page.getByRole('tablist', { name: '회의록 상세' }).evaluate(element => Math.round(element.getBoundingClientRect().top));

    // A record that may have audio keeps the row through the check and shows 음성 없음 after a 404.
    await openMeeting(page, '음성 확인 회의');
    const audioRow = page.locator('.meeting-meta-item-audio');
    await audioRow.getByText('확인 중', { exact: true }).waitFor({ timeout: 10000 });
    const topWhileChecking = await tabListTop();
    releaseAudioCheck();
    await audioRow.getByText('음성 없음', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await tabListTop(), topWhileChecking, 'a missing audio file should not collapse the row and shift the tabs');

    // A full output list without audio means the engine kept none: no row, not even while checking.
    audioCheckGate = new Promise(resolve => { releaseAudioCheck = resolve; });
    await openMeeting(page, '음성 미보관 회의');
    assert.equal(await page.locator('.meeting-meta-item-audio').count(), 0, 'no audio row should show while the check is pending');
    releaseAudioCheck();
    await page.waitForTimeout(500);
    assert.equal(await page.locator('.meeting-meta-item-audio').count(), 0, 'a record whose outputs list no audio should not show the audio row');
    console.log('ok - the audio row keeps its place through the check and stays hidden when no audio was kept');
  } finally {
    releaseAudioCheck();
    await context.close();
  }
};

// Detail failures stay beside the work that failed; the shell banner is only for a failed load (DT-2, DT-6, DT-8).
const runErrorPlacementScenario = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  await page.route('**/api/models/status', route => route.fulfill(json({ ready: true, models: [], summary_ready: true })));
  // The engine went away after the meeting was opened: syncing a saved edit cannot reach it.
  await page.route('**/api/outputs/*/sync-record', route => route.abort('connectionrefused'));
  let releaseSummary = () => undefined;
  let summaryGate = new Promise(resolve => { releaseSummary = resolve; });
  await page.route('**/api/outputs/*/generate-summary', async route => {
    await summaryGate;
    return route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'Ollama request failed: 500 Internal Server Error' }) });
  });
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor({ timeout: 10000 });
    const job = 'layout-error-job';
    await putMeetings(page, [{
      ...baseMeeting,
      id: 'layout-error-meeting',
      title: '오류 위치 확인',
      jobId: job,
      summary: '',
      generationStatus: {},
      diarizationApplied: true,
      outputFiles: { job_id: job, json: `/api/outputs/${job}/json`, txt: `/api/outputs/${job}/txt` },
    }]);
    await openMeeting(page, '오류 위치 확인');
    const tabListTop = () => page.getByRole('tablist', { name: '회의록 상세' }).evaluate(element => Math.round(element.getBoundingClientRect().top));
    const shellBanners = page.locator('.meeting-detail-shell > .status-banner');
    const topBefore = await tabListTop();

    // Saved locally, but the engine is off: a warning in the 대화록 tab, never `Failed to fetch` or a banner on top.
    await page.getByRole('button', { name: '대화록 편집', exact: true }).click();
    await page.locator('.script-edit-textarea').first().fill('3분기 자원조사 결과를 다시 정리하겠습니다.');
    await page.locator('#meeting-detail-panel-script').getByRole('button', { name: '저장', exact: true }).click();
    const scriptStatus = page.locator('#meeting-detail-panel-script .detail-report-status');
    await scriptStatus.getByText('저장 내용은 반영됐지만 분석 원본과 동기화하지 못했습니다. 바로록 연결이 실행 중인지 확인해 주세요.', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await shellBanners.count(), 0, 'a save failure must not use the shell banner');
    assert.equal(await page.getByText('Failed to fetch', { exact: false }).count(), 0, 'raw fetch errors must not reach the screen');
    assert.equal(await tabListTop(), topBefore, 'the save warning must not push the tabs');

    // 기록 정리: the reserved line shows the work in progress, then the failure, while the controls stay put.
    await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
    const organizeStatus = page.locator('#meeting-detail-panel-summary .detail-report-status');
    await organizeStatus.waitFor({ timeout: 10000 });
    const statusTop = () => organizeStatus.evaluate(element => Math.round(element.getBoundingClientRect().top));
    const selectLeft = () => page.getByLabel('이번 정리 기준 선택').evaluate(element => Math.round(element.getBoundingClientRect().left));
    const organizeTabTop = await tabListTop();
    const statusTopBefore = await statusTop();
    const selectLeftBefore = await selectLeft();
    assert.equal((await organizeStatus.innerText()).trim(), '', 'nothing to report before 정리 starts');

    await page.getByRole('button', { name: '전체 요약 정리', exact: true }).click();
    await organizeStatus.getByText('전체 요약을 정리하는 중입니다.', { exact: true }).waitFor({ timeout: 10000 });
    await page.locator('#organize-mode-panel-summary').getByText('전체 요약이 아직 없습니다.', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByText('정리를 실행해 주세요.', { exact: false }).count(), 0, 'no instruction to run 정리 while it runs');
    assert.equal(await selectLeft(), selectLeftBefore, '정리 → 정리 중 must not push the select beside it');

    releaseSummary();
    await organizeStatus.getByText('전체 요약을 만들지 못했습니다. 잠시 뒤 다시 정리해 주세요.', { exact: true }).waitFor({ timeout: 10000 });
    assert.match(await organizeStatus.getAttribute('class'), /detail-report-status-error/);
    assert.equal(await shellBanners.count(), 0, 'a generation failure must not use the shell banner');
    assert.equal(await page.getByText('Ollama request failed', { exact: false }).count(), 0, 'raw engine text must not reach the screen');
    assert.equal(await tabListTop(), organizeTabTop, 'the failure must not push the tabs');
    assert.equal(await statusTop(), statusTopBefore, 'the reserved line keeps the body in place');
    assert.equal(await selectLeft(), selectLeftBefore, 'the select stays in place after the run');

    // A run that fails while another tab is open says so once in a toast; its line keeps the failure.
    summaryGate = new Promise(resolve => { releaseSummary = resolve; });
    await page.getByRole('button', { name: '전체 요약 정리', exact: true }).click();
    await organizeStatus.getByText('전체 요약을 정리하는 중입니다.', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '대화록', exact: true }).click();
    releaseSummary();
    await page.locator('.meeting-history-toast-stack').getByText('전체 요약을 만들지 못했습니다. 잠시 뒤 다시 정리해 주세요.', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
    await organizeStatus.getByText('전체 요약을 만들지 못했습니다. 잠시 뒤 다시 정리해 주세요.', { exact: true }).waitFor({ timeout: 10000 });
    console.log('ok - detail errors stay in their tab line and nothing above them moves');
  } finally {
    releaseSummary();
    await context.close();
  }
};

const server = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  await runTopicChipScenario(browser);
  await runNarrowMetaScenario(browser);
  await runTranscriptRowScenario(browser);
  await runAudioRowScenario(browser);
  await runErrorPlacementScenario(browser);
} finally {
  await browser.close();
  await stopServer(server);
}
