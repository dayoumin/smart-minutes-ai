import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
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

const getAvailablePort = async (host) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, host, () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close(() => reject(new Error('Could not allocate a local test port.')));
      return;
    }
    const { port } = address;
    server.close(() => resolve(port));
  });
});

const startServer = async () => {
  if (!shouldStartServer) {
    await waitForApp(APP_URL);
    return null;
  }
  const url = new URL(APP_URL);
  url.port = String(await getAvailablePort(url.hostname));
  APP_URL = url.toString();
  const child = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', `corepack pnpm exec vite --host ${url.hostname} --port ${url.port} --strictPort --configLoader runner`],
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
  const expand = page.getByRole('button', { name: '메뉴 펼치기', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator('.barorok-navigation').getByText(title, { exact: true }).click();
  await page.locator('.meeting-detail-shell').getByRole('heading', { name: title }).waitFor({ timeout: 10000 });
};

const runTopicChipScenario = async (browser, width) => {
  const context = await browser.newContext({ viewport: { width, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor({ timeout: 10000 });
    await putMeetings(page, [{ ...topicMeeting, topicSections: topicMeeting.topicSections.map(section => ({
      ...section, summary: section.summary.repeat(300),
    })) }]);
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
    await page.waitForFunction(() => {
      const heading = document.activeElement?.getBoundingClientRect();
      const nav = document.querySelector('.detail-main-nav')?.getBoundingClientRect();
      return heading && nav && heading.top >= nav.bottom + 8 && heading.bottom <= innerHeight;
    });
    console.log(`ok - summary topic chip opens a long topic below the sticky navigation (${width}px)`);
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
    if (process.env.MEETING_STATUS_SCREENSHOTS) {
      await mkdir(process.env.MEETING_STATUS_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.MEETING_STATUS_SCREENSHOTS}/meeting-status-narrow.png` });
    }
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
    await page.getByRole('button', { name: '편집', exact: true }).click();
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
  const audioRequests = [];
  await page.route('**/api/outputs/*/audio', async route => {
    audioRequests.push(route.request().url());
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

    // A full output list without audio keeps the stable row, without requesting audio.
    audioCheckGate = new Promise(resolve => { releaseAudioCheck = resolve; });
    await openMeeting(page, '음성 미보관 회의');
    await audioRow.getByText('음성 없음', { exact: true }).waitFor();
    assert.equal(await audioRow.count(), 1, 'the audio row stays mounted when no audio was kept');
    assert.equal(await tabListTop(), topWhileChecking, 'records without stored audio keep the same tab position');
    releaseAudioCheck();
    await page.waitForTimeout(500);
    await audioRow.getByText('음성 없음', { exact: true }).waitFor();
    assert.equal(audioRequests.some(url => url.includes('layout-audio-none-job')), false, 'a full output list without audio skips the audio request');
    console.log('ok - the audio row stays stable through checking and when no audio was kept');
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
    await page.getByRole('button', { name: '편집', exact: true }).click();
    await page.locator('.script-edit-textarea').first().fill('3분기 자원조사 결과를 다시 정리하겠습니다.');
    await page.locator('#meeting-detail-panel-script').getByRole('button', { name: '저장', exact: true }).click();
    const scriptStatus = page.locator('#meeting-detail-panel-script .detail-report-status');
    await scriptStatus.getByText(`저장 내용은 반영됐지만 분석 원본과 동기화하지 못했습니다. ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인해 주세요.`, { exact: true }).waitFor({ timeout: 10000 });
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

const runTranscriptReviewScenario = async (browser, width) => {
  const context = await browser.newContext({ viewport: { width, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  // Controlled playback promises exercise ownership; genuine audio is covered separately.
  await page.addInitScript(() => {
    window.__reviewPlayCalls = 0;
    window.__reviewPauseCalls = 0;
    const play = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      window.__reviewPlayCalls += 1;
      if (window.__reviewPlayCalls === 1) return new Promise((_, reject) => { window.__rejectOldReviewPlay = reject; });
      return play.call(this);
    };
    const pause = HTMLMediaElement.prototype.pause;
    HTMLMediaElement.prototype.pause = function () { window.__reviewPauseCalls += 1; pause.call(this); };
  });
  const audio = Buffer.alloc(44 + 8000 * 2 * 30);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  await page.route('**/api/outputs/*/audio', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: audio }));
  const raw = [
    { start: '00:00:00', end: '00:00:10', speaker: 'SPEAKER_00', text: '경계 확인 발언', reviewVersion: 1, reviewIssues: [{ reason: 'short_speaker_overlap', start: 1.25, end: 1.8 }] },
    { start: '00:00:10', end: '00:00:12', speaker: 'UNKNOWN', text: '미배정 발언', reviewVersion: 1, reviewIssues: [] },
    { start: '00:00:12', end: '00:00:15', speaker: 'SPEAKER_00', text: '미세 보정 발언', timingApproximate: true, reviewVersion: 1, reviewIssues: [] },
  ];
  const meeting = { ...baseMeeting, id: 'review-A', jobId: 'review-job', title: '확인 구간 A', diarizationApplied: true,
    segments: raw, displaySegments: [{ ...raw[0], reviewVersion: undefined, reviewIssues: undefined, shortSpeakerOverlap: true }, ...raw.slice(1)] };
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor();
    await putMeetings(page, [meeting, { ...meeting, id: 'review-B', title: '확인 구간 B' }]);
    await openMeeting(page, meeting.title);
    const uncertain = page.locator('.script-row').filter({ hasText: '경계 확인 발언' });
    const summary = uncertain.locator('summary');
    await summary.focus(); await page.keyboard.press('Enter');
    await uncertain.getByText('00:00:01.25–00:00:01.80', { exact: true }).waitFor();
    await uncertain.getByText('짧은 다른 참석자 구간이 걸쳐 있는 부분', { exact: true }).waitFor();
    const unknown = page.locator('.script-row').filter({ hasText: '미배정 발언' });
    await unknown.getByText('참석자 미확인', { exact: true }).waitFor();
    assert.equal(await unknown.locator('summary').innerText(), '참석자 확인 필요');
    await unknown.locator('summary').click();
    await unknown.getByText('참석자를 배정하지 못한 구간', { exact: true }).waitFor();
    assert.equal(await page.locator('.script-row').filter({ hasText: '미세 보정 발언' }).locator('summary').count(), 0);
    for (const row of [uncertain, unknown]) assert(await row.locator('.script-meta').evaluate(el => el.scrollWidth <= el.clientWidth + 1));
    await page.locator('audio').evaluate(audio => { if (audio.readyState < 1) return new Promise(resolve => audio.addEventListener('loadedmetadata', resolve, { once: true })); });
    await uncertain.getByRole('button', { name: '00:00:01.25부터 00:00:01.80까지 듣기', exact: true }).click();
    await openMeeting(page, '확인 구간 B');
    const next = page.locator('.script-row').filter({ hasText: '경계 확인 발언' });
    await next.locator('summary').click();
    await page.locator('audio').evaluate(audio => { if (audio.readyState < 1) return new Promise(resolve => audio.addEventListener('loadedmetadata', resolve, { once: true })); });
    await next.getByRole('button').click();
    await page.evaluate(async () => { window.__rejectOldReviewPlay(new DOMException('old source replaced', 'AbortError')); await Promise.resolve(); });
    assert.equal(await page.getByText('해당 구간을 재생하지 못했습니다. 음성 재생기를 확인해 주세요.', { exact: true }).count(), 0);
    await page.waitForFunction(() => { const audio = document.querySelector('audio'); return audio.paused && audio.currentTime >= 1.8 && audio.currentTime < 2.6; }, null, { timeout: 10000 });
    assert(await page.evaluate(() => window.__reviewPauseCalls) > 0, 'old failure must not disable the new meeting clip stop');
    await page.reload({ waitUntil: 'domcontentloaded' }); await openMeeting(page, meeting.title);
    assert.equal(await page.locator('.script-row').filter({ hasText: '미배정 발언' }).locator('summary').count(), 1);
    console.log(`ok - precise reasons, UNKNOWN, tiny suppression, keyboard/reopen and playback ownership at ${width}px`);
  } finally { await context.close(); }
};

// Two columns at 50rem of detail width: header, a pinned 280px info panel, and the tab column (docs/design.md, 회의 상세·분석 진행 2단 배치).
const runColumnsScenario = async (browser, { width, height }) => {
  const context = await browser.newContext({ viewport: { width, height } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  const audio = Buffer.alloc(44 + 8000 * 2 * 30);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  await page.route('**/api/outputs/*/audio', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: audio }));
  const longTitle = '2026년 하반기 연근해 자원조사 결과 공유 및 음향 장비 교정 일정 협의를 위한 정기 연구 회의';
  const many = Array.from({ length: 60 }, (_, index) => ({
    start: `00:${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '30' : '00'}`,
    end: `00:${String(Math.floor(index / 2)).padStart(2, '0')}:${index % 2 ? '59' : '29'}`,
    speaker: index % 2 ? 'SPEAKER_01' : 'SPEAKER_00',
    text: `${index + 1}번째 발언입니다. 어획량과 수온 변화, 장비 교정 일정을 길게 이야기하며 스크롤 위치를 만들어 줍니다.`,
  }));
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor({ timeout: 10000 });
    await putMeetings(page, [{
      ...baseMeeting,
      id: 'layout-columns-meeting',
      title: longTitle,
      jobId: 'layout-columns-job',
      diarizationApplied: true,
      meetingPurpose: '하반기 조사 결과와 장비 교정 일정을 정리한다',
      segments: many,
      displaySegments: many,
    }]);
    await openMeeting(page, longTitle);
    await page.locator('.meeting-audio-player').waitFor({ timeout: 10000 });
    await page.locator('.script-row').first().waitFor();
    const measure = () => page.evaluate(() => {
      const box = selector => {
        const rect = document.querySelector(selector)?.getBoundingClientRect();
        if (!rect) throw new Error(`Missing ${selector}`);
        return { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right, width: rect.width };
      };
      return {
        info: box('.meeting-detail-info'),
        tablist: box('[role=tablist][aria-label="회의록 상세"]'),
        header: box('.meeting-detail-overview'),
        title: box('.meeting-detail-title'),
        actions: box('.meeting-detail-actions'),
        audio: box('.meeting-audio-player'),
        nav: box('.detail-main-nav'),
        stickyTop: box('.barorok-workspace').top + parseFloat(getComputedStyle(document.querySelector('.barorok-workspace')).paddingTop),
        innerHeight: window.innerHeight,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    const { info, tablist, header, title, actions, documentOverflow: overflowBefore } = await measure();
    assert.ok(info.right <= tablist.left + 1, `info panel sits left of the tabs at ${width}px`);
    assert.ok(Math.abs(info.width - 280) <= 1, `info panel is 280px, got ${info.width}`);
    assert.ok(tablist.top <= header.bottom + 24, `tabs start right under the header at ${width}px: tabs ${tablist.top}, header bottom ${header.bottom}`);
    assert.ok(title.right <= actions.left + 1, 'long title does not run under the actions');
    assert.ok(overflowBefore <= 0, `document overflowed by ${overflowBefore}px`);
    const statusAlignment = await page.locator('.meeting-detail-info .meeting-status-item').evaluateAll(rows => rows.map(row => {
      const label = row.querySelector('.meeting-status-title').getBoundingClientRect();
      const status = row.querySelector('.meeting-status-actions').getBoundingClientRect();
      return { labelRight: label.right, statusLeft: status.left, centerDelta: Math.abs((label.top + label.bottom - status.top - status.bottom) / 2) };
    }));
    assert.ok(statusAlignment.length > 0, 'info panel has processing status rows');
    assert.ok(statusAlignment.every(row => row.labelRight <= row.statusLeft + 1 && row.centerDelta <= 1), 'info status labels sit left of vertically aligned actions');

    await page.locator('.barorok-workspace').evaluate(element => { element.scrollTop = 1500; });
    await page.waitForTimeout(200);
    const after = await measure();
    assert.ok(after.audio.top >= 0 && after.audio.bottom <= after.innerHeight, 'audio player stays visible while reading');
    assert.ok(Math.abs(after.nav.top - after.stickyTop) <= 1, `navigation sticks to the padded workspace top: ${after.nav.top} vs ${after.stickyTop}`);
    assert.ok(after.tablist.top >= after.nav.top && after.tablist.bottom <= after.nav.bottom, 'tabs stay inside the sticky navigation');
    assert.ok(after.documentOverflow <= 0, `document overflowed by ${after.documentOverflow}px`);
    console.log(`ok - header, 280px info panel and sticky tab column at ${width}x${height}`);
  } finally {
    await context.close();
  }
};

const runSummaryReviewScenario = async (browser, width) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  const meeting = { ...topicMeeting, id: 'summary-review', title: '회의 요약 확인 안내' };
  const empty = { ...baseMeeting, id: 'summary-review-empty', title: '정리 전 회의록', summary: '', generationStatus: {} };
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor();
    await putMeetings(page, [meeting, empty]);
    await openMeeting(page, meeting.title);
    const openOrganize = () => page.getByRole('tab', { name: '기록 정리', exact: true }).click();
    await openOrganize();
    const note = page.getByLabel('AI 요약 확인 안내', { exact: true });
    await note.getByText('AI가 정리한 내용에는 누락이나 잘못된 해석이 있을 수 있습니다. 중요한 내용은 대화록과 대조해 주세요.', { exact: true }).waitFor();
    const tab = page.getByRole('tab', { name: '전체 요약', exact: true });
    const initialY = (await tab.boundingBox()).y;
    for (const name of ['주제별 정리', '참석자별 정리', '전체 요약']) {
      await page.getByRole('tab', { name, exact: true }).click();
      assert.equal(await note.count(), 1);
      assert(await note.isVisible());
      assert(Math.abs((await tab.boundingBox()).y - initialY) <= 1, 'persistent controls should stay in place');
      assert(await note.evaluate(element => element.scrollWidth <= element.clientWidth + 1), 'review guidance must wrap within its work surface');
    }
    if (process.env.SUMMARY_REVIEW_SCREENSHOTS) {
      await mkdir(process.env.SUMMARY_REVIEW_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.SUMMARY_REVIEW_SCREENSHOTS}/summary-review-${width}.png` });
    }
    await note.getByRole('button', { name: '대화록 확인', exact: true }).focus();
    await page.keyboard.press('Enter');
    const scriptTab = page.getByRole('tab', { name: '대화록', exact: true });
    await page.waitForFunction(() => document.activeElement?.id === 'meeting-detail-tab-script');
    assert.equal(await scriptTab.getAttribute('aria-selected'), 'true');
    await openMeeting(page, empty.title);
    await openOrganize();
    assert(await note.isVisible(), 'guidance should remain before the first summary is generated');
    await page.reload({ waitUntil: 'domcontentloaded' });
    await openMeeting(page, meeting.title);
    await openOrganize();
    assert(await note.isVisible(), 'saved summaries should retain the guidance on reopen');
    console.log(`ok - summary guidance, keyboard transcript review, reopen and stable controls at ${width}px`);
  } finally {
    await context.close();
  }
};


const runProductionDetailScenario = async (browser, width) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  const audio = Buffer.alloc(44 + 8000 * 2 * 30);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  await page.route('**/api/outputs/*/audio', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: audio }));
  // Captured release state: the managed summary runtime is stopped but can start on demand.
  await page.route('**/api/models/status', route => route.fulfill(json({
    ready: true, summary_ready: false, summary_status: 'skipped', summary_reason: 'server_unreachable',
    models: [{ key: 'llm', installed: false, inventory_checked: false }],
    ollama_connection: { status: 'managed_stopped', can_auto_start: true, managed_runtime_available: true },
  })));
  const meeting = {
    ...baseMeeting, id: 'production-detail', title: '주간 업무 협의',
    meetingPurpose: '이번 주 진행 상황과 다음 일정 확인',
    sourceFile: 'weekly-review.wav', jobId: 'production-detail-job',
    sourceFileMetadata: { kind: 'audio', sizeBytes: 937000, durationSeconds: 30 },
    analysisElapsedMs: 19000, diarizationRequested: true,
    analysisNotes: ['음성은 이 PC에 보관됩니다. 다른 PC에서 열면 음성 파일을 다시 선택해 주세요.'],
    segments: segments.map(segment => ({ ...segment, text: segment.text.repeat(8) })),
    displaySegments: segments.map(segment => ({ ...segment, text: segment.text.repeat(8) })),
  };
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor();
    await putMeetings(page, [meeting]);
    await openMeeting(page, meeting.title);
    await page.locator('.script-row').first().waitFor();
    await page.locator('.meeting-audio-player').waitFor();
    const metrics = await page.evaluate(() => {
      const status = document.querySelector('.meeting-analysis-status');
      const text = document.querySelector('.script-text');
      const row = document.querySelector('.script-row');
      return { statusOverflow: status.scrollHeight - status.clientHeight,
        textRatio: text.getBoundingClientRect().width / row.getBoundingClientRect().width,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth };
    });
    if (process.env.DETAIL_SCREENSHOTS) {
      await mkdir(process.env.DETAIL_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: process.env.DETAIL_SCREENSHOTS + '/detail-' + width + '.png' });
    }
    if (!process.env.DETAIL_BASELINE) {
      assert.ok(metrics.statusOverflow <= 1, 'durable processing guidance must not need a nested scrollbar');
      assert.ok(metrics.documentOverflow <= 0, 'detail must fit the desktop viewport');
      if (width >= 1440) assert.ok(metrics.textRatio >= 0.60, 'speech should own at least 60% of a wide transcript row');
      const edit = page.getByRole('button', { name: '편집', exact: true });
      const rename = page.getByRole('button', { name: '참석자 이름 변경', exact: true });
      await rename.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.closest('.speaker-label-panel'));
      const panelOverflow = await page.locator('.speaker-label-panel').evaluate(el => el.scrollWidth - el.clientWidth);
      assert.ok(panelOverflow <= 1, 'speaker name inputs fit the actual content column');
      await page.locator('#meeting-detail-panel-script').getByRole('button', { name: '취소', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'speaker-label-trigger');
      await edit.focus(); await page.keyboard.press('Enter');
      await page.waitForFunction(() => document.activeElement?.classList.contains('script-edit-textarea'));
      await page.locator('#meeting-detail-panel-script').getByRole('button', { name: '취소', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'transcript-edit-trigger');
      await edit.click();
      await page.locator('#meeting-detail-panel-script').getByRole('button', { name: '저장', exact: true }).click();
      await page.waitForFunction(() => document.activeElement?.id === 'transcript-edit-trigger');
      await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
      assert.equal(await page.getByRole('button', { name: '전체 요약 정리', exact: true }).isEnabled(), true, 'managed auto-start must allow summary without visiting settings');
      assert.equal(await page.getByText('모델 필요', { exact: true }).count(), 0, 'a stopped managed runtime must not be presented as a missing model');
      await page.getByRole('tab', { name: '대화록', exact: true }).click();
      await page.getByRole('textbox', { name: '현재 회의에서 검색', exact: true }).fill('no-matching-speech');
      await page.getByText('검색과 일치하는 대화록이 없습니다. 검색어를 바꾸거나 지워 주세요.', { exact: true }).waitFor();
    }
    console.log('ok - production detail at ' + width + 'px: ' + JSON.stringify(metrics));
  } finally { await context.close(); }
};

const server = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  if (process.argv.includes('production')) {
    for (const width of [1440, 1024, 860]) await runProductionDetailScenario(browser, width);
  } else if (process.argv.includes('columns')) {
    for (const size of [{ width: 1280, height: 720 }, { width: 1440, height: 900 }]) await runColumnsScenario(browser, size);
  } else if (process.argv.includes('meta')) {
    await runNarrowMetaScenario(browser);
  } else if (process.argv.includes('summary-review')) {
    for (const width of [1280, 860]) await runSummaryReviewScenario(browser, width);
  } else if (process.argv.includes('review')) {
    for (const width of [1280, 760]) await runTranscriptReviewScenario(browser, width);
  } else {
  for (const width of [1280, 760]) await runTopicChipScenario(browser, width);
  await runNarrowMetaScenario(browser);
  await runTranscriptRowScenario(browser);
  await runAudioRowScenario(browser);
  await runErrorPlacementScenario(browser);
  }
} finally {
  await browser.close();
  await stopServer(server);
}
