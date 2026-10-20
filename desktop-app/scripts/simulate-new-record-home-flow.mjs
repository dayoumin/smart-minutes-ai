import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BRAND_NAME, LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';


let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const shouldStartServer = !process.env.APP_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

const waitForApp = async (url, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until ready.
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
  const command = `corepack pnpm exec vite --host ${url.hostname} --port ${url.port} --strictPort --configLoader runner`;
  const child = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', command],
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

const stopServer = async (child) => {
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

const installBaseRoutes = async page => {
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ diarization: { enabled: true, generate_during_analysis: true } }),
  }));
  await page.route('**/api/models/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ready: true, models: [] }),
  }));
};

const assertNoHorizontalOverflow = async page => {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    workspace: (() => {
      const element = document.querySelector('.barorok-workspace');
      return element ? element.scrollWidth - element.clientWidth : 0;
    })(),
  }));
  assert.ok(overflow.document <= 0, `document overflowed by ${overflow.document}px`);
  assert.ok(overflow.workspace <= 0, `workspace overflowed by ${overflow.workspace}px`);
};

const putMeeting = async (page, meeting) => page.evaluate(value => new Promise((resolve, reject) => {
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
    transaction.objectStore('meetings').put(value);
    transaction.oncomplete = () => {
      db.close();
      window.dispatchEvent(new Event('meetings:updated'));
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  };
}), meeting);

const readMeetingIds = async page => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('MeetingHistoryDB', 2);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const read = db.transaction('meetings', 'readonly').objectStore('meetings').getAllKeys();
    read.onsuccess = () => {
      db.close();
      resolve(read.result.map(String).sort());
    };
    read.onerror = () => reject(read.error);
  };
}));

const meetingAt = (id, title, time, meetingPurpose = '') => {
  const iso = new Date(time).toISOString();
  return {
    id,
    title,
    date: iso,
    participants: '',
    meetingPurpose,
    summary: '',
    segments: [],
    displaySegments: [],
    speakerLabels: {},
    createdAt: iso,
    updatedAt: iso,
  };
};

const runEmptyHomeScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.ocean-backdrop, .start-workspace, [data-shell-variant]').count(), 0);
    assert.equal(await page.getByRole('button', { name: `${BRAND_NAME} 첫 화면` }).getAttribute('aria-current'), 'page');
    // Give the recent-meetings load a moment; an empty store renders no list at all.
    await page.waitForTimeout(300);
    assert.equal(await page.locator('.recent-meetings, .writer-recovery').count(), 0);

    const wideMetrics = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector)?.getBoundingClientRect() ?? null;
      const shell = rect('.writer-shell');
      const drop = rect('.file-drop-zone');
      const info = rect('.writer-info-section');
      const cta = rect('.writer-start-button');
      const label = rect('label[for="meeting-title"]');
      const input = rect('#meeting-title');
      return {
        viewportHeight: window.innerHeight,
        shellWidth: shell?.width ?? 0,
        dropBottom: drop?.bottom ?? 0,
        infoTop: info?.top ?? 0,
        ctaBottom: cta?.bottom ?? Infinity,
        labelRight: label?.right ?? 0,
        inputLeft: input?.left ?? 0,
        labelTop: label?.top ?? 0,
        inputTop: input?.top ?? 0,
      };
    });
    assert.ok(wideMetrics.shellWidth <= 880, `writer column should stay within 880px, got ${wideMetrics.shellWidth}`);
    assert.ok(wideMetrics.dropBottom <= wideMetrics.infoTop, 'upload zone should sit above meeting information');
    assert.ok(wideMetrics.ctaBottom <= wideMetrics.viewportHeight, `analysis start should be visible at 1280x720, bottom ${wideMetrics.ctaBottom}`);
    assert.ok(wideMetrics.labelRight <= wideMetrics.inputLeft, 'wide meeting information should use label/value rows');
    assert.ok(Math.abs(wideMetrics.labelTop - wideMetrics.inputTop) < 20, 'wide label and input should share a row');
    await assertNoHorizontalOverflow(page);

    await page.setViewportSize({ width: 800, height: 720 });
    await page.waitForTimeout(100);
    const narrowMetrics = await page.evaluate(() => {
      const label = document.querySelector('label[for="meeting-title"]')?.getBoundingClientRect();
      const input = document.querySelector('#meeting-title')?.getBoundingClientRect();
      return { labelBottom: label?.bottom ?? 0, inputTop: input?.top ?? 0 };
    });
    assert.ok(narrowMetrics.labelBottom <= narrowMetrics.inputTop + 1, 'narrow meeting information should stack label above input');
    await assertNoHorizontalOverflow(page);
    console.log('ok - empty new-record home keeps form and start button in one column');
  } finally {
    await context.close();
  }
};

const runRecentListScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    // Anchor to local midnight so the grouping does not depend on when the test runs.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = todayStart.getTime();
    const meetings = [
      meetingAt('home-today-1', '오늘 오후 운영 회의', today + 2 * 60 * 1000, '주간 운영 점검'),
      meetingAt('home-today-2', '오늘 아침 회의', today + 60 * 1000),
      meetingAt('home-week-1', '최근 기획 회의', today - 2 * DAY_MS, '신규 과제 범위'),
      meetingAt('home-older-1', '지난달 회의 1', today - 30 * DAY_MS),
      meetingAt('home-older-2', '지난달 회의 2', today - 31 * DAY_MS),
      meetingAt('home-older-3', '지난달 회의 3', today - 32 * DAY_MS),
    ];
    // Editing or pinning bumps updatedAt; the list must still order by when the meeting was recorded.
    meetings[3].updatedAt = new Date().toISOString();
    for (const meeting of meetings) await putMeeting(page, meeting);

    const recent = page.getByRole('region', { name: '최근 회의록' });
    await recent.waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelectorAll('.recent-meeting-row').length === 5);
    const groups = await recent.locator('.recent-meetings-group-label').allTextContents();
    assert.deepEqual(groups, ['오늘', '최근 7일', '이전']);
    const titles = await recent.locator('.recent-meeting-title').allTextContents();
    assert.deepEqual(titles, ['오늘 오후 운영 회의', '오늘 아침 회의', '최근 기획 회의', '지난달 회의 1', '지난달 회의 2']);
    await assertNoHorizontalOverflow(page);

    await recent.getByRole('button', { name: /최근 기획 회의/ }).click();
    await page.locator('.meeting-detail-shell').getByRole('heading', { name: '최근 기획 회의' }).waitFor({ timeout: 10000 });
    console.log('ok - recent meetings list groups the latest five and opens a meeting');
  } finally {
    await context.close();
  }
};

const runRecoveryScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const draft = {
    jobId: 'home-recovery-job',
    title: '이어갈 회의',
    date: '2026-08-13T09:00',
    participants: '',
    sourceFilename: 'recovery.wav',
    sourceSize: 1024,
    sourceLastModified: 123456,
    status: 'stopped',
    createdAt: '2026-08-13T09:00:00.000Z',
    updatedAt: '2026-08-13T09:05:00.000Z',
    resumeEligible: true,
    completedChunkCount: 1,
  };
  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);
  const page = await context.newPage();
  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ drafts: [{
      job_id: draft.jobId,
      status: 'stopped',
      stage: 'stopped',
      resume_supported: true,
      completed_chunk_count: 1,
      last_progress: { message: '중지됨', progress: 35 },
    }] }),
  }));
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await putMeeting(page, meetingAt('home-recovery-recent', '복구보다 오래된 최근 회의', Date.now() - DAY_MS));
    const recovery = page.locator('.writer-recovery');
    await recovery.getByText('이어서 할 분석', { exact: true }).waitFor({ timeout: 10000 });
    await recovery.getByRole('heading', { name: '이어갈 회의' }).waitFor();
    const recentAfterRecovery = page.getByRole('region', { name: '최근 회의록' });
    await recentAfterRecovery.waitFor({ timeout: 10000 });
    const order = await page.evaluate(() => {
      const card = document.querySelector('.writer-recovery')?.getBoundingClientRect();
      const list = document.querySelector('.recent-meetings')?.getBoundingClientRect();
      return { cardBottom: card?.bottom ?? 0, listTop: list?.top ?? 0 };
    });
    assert.ok(order.cardBottom <= order.listTop, 'the recovery card sits above the recent list, which stays reachable');
    await recovery.getByRole('button', { name: '이어서 분석', exact: true }).click();
    await page.getByRole('heading', { name: /이어하기|분석 상태/, level: 2 }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.writer-recovery, .recent-meetings').count(), 0, 'companion hides while choosing the resume file');
    console.log('ok - recovery card resumes the saved analysis');
  } finally {
    await context.close();
  }
};

const runPendingCancellationLockScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    window.localStorage.setItem('pendingAnalysisDraftCleanups', JSON.stringify(['home-pending-cancel-job']));
    window.localStorage.setItem('pendingCancelledAnalysisCleanups', JSON.stringify(['home-pending-cancel-job']));
  });
  const page = await context.newPage();
  let analyzeRequestCount = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/analyze') analyzeRequestCount += 1;
  });
  await installBaseRoutes(page);
  await page.route('**/api/analyze/drafts/home-pending-cancel-job', route => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'analysis_job_active' }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const writerStartButton = page.getByRole('button', { name: '분석 시작', exact: true });
    await writerStartButton.waitFor({ timeout: 10000 });
    await page.locator('#writer-analysis-start-blocked').waitFor({ timeout: 10000 });
    assert.equal(await writerStartButton.isDisabled(), true);
    assert.equal(await page.locator('.sidebar-create-button').first().isDisabled(), true);

    await putMeeting(page, meetingAt('home-pending-recent', '정리 대기 중 최근 회의', Date.now() - 60 * 1000));
    const recentRow = page.getByRole('region', { name: '최근 회의록' }).getByRole('button', { name: /정리 대기 중 최근 회의/ });
    await recentRow.waitFor({ timeout: 10000 });
    assert.equal(await recentRow.isEnabled(), true);
    await recentRow.click();
    await page.locator('.meeting-detail-shell').getByRole('heading', { name: '정리 대기 중 최근 회의' }).waitFor({ timeout: 10000 });
    assert.equal(analyzeRequestCount, 0);
    console.log('ok - pending cancellation locks analysis but keeps recent meetings open');
  } finally {
    await context.close();
  }
};

const runAnalysisEntryPointScene = async browser => {
  // While an analysis runs, 새 회의록 is disabled and the 분석 중 card is the way back to the progress view.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === '/api/analyze' && String(init?.method || 'GET').toUpperCase() === 'POST') {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify({ type: 'progress', progress: 30, status: 'transcribing', message: 'Transcribing chunk 1/4...' })}\n\n`));
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    };
  });
  const page = await context.newPage();
  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ drafts: [] }) }));
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recommended_job_id: null, candidates: [] }) }));
  await page.route('**/api/analyze/preflight', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, level: 'ok', reason: 'enough_storage', required_bytes: 1, available_bytes: 1e9, message: 'ok' }) }));
  page.on('dialog', dialog => dialog.accept());
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    await putMeeting(page, meetingAt('entry-point-meeting', '진입점 확인 회의', Date.now() - DAY_MS));
    await page.getByLabel('회의 목적 *').fill('분석 중 진입점 확인');
    await page.setInputFiles('#meeting-file-input', { name: 'entry-point.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('entry') });
    await page.getByLabel('회의 제목 *').fill('진입점 분석');
    await page.getByRole('button', { name: '분석 시작', exact: true }).click();
    await page.locator('.writer-analysis-panel').waitFor({ timeout: 10000 });
    const navigation = page.locator('.barorok-navigation');
    const createButton = navigation.getByRole('button', { name: '새 회의록', exact: true });
    await page.waitForFunction(() => document.querySelector('.barorok-navigation .sidebar-create-button')?.disabled === true);
    assert.equal(await navigation.getByText('진행 중인 분석 보기', { exact: true }).count(), 0, 'the create button keeps its name during analysis');
    assert.ok(await createButton.getAttribute('aria-describedby'), 'the disabled reason is linked for assistive tech');
    await navigation.getByText('진입점 확인 회의').first().click();
    await page.locator('.meeting-detail-shell').getByRole('heading', { name: '진입점 확인 회의' }).waitFor({ timeout: 10000 });
    await navigation.locator('.sidebar-analysis-card').click();
    await page.getByRole('heading', { name: '분석 진행', level: 2 }).waitFor({ timeout: 10000 });
    console.log('ok - analysis keeps 새 회의록 disabled and the 분석 중 card returns to progress');
  } finally {
    await context.close();
  }
};

const runPrivacyNoteWithoutEngineScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.route('**/api/**', route => route.abort('connectionrefused'));
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    // The processing promise is fixed copy, so it shows even before (or without) an engine answer.
    const privacyNote = page.locator('.writer-file-privacy-note');
    await privacyNote.getByText('음성·영상과 대화록은 이 PC에서 처리합니다.', { exact: true }).waitFor({ timeout: 10000 });
    const noteBox = await privacyNote.boundingBox();
    assert.ok(noteBox && noteBox.height <= 24, `the processing note must stay one line at 1280px (height ${noteBox?.height})`);
    const helpTitle = '회의 내용은 내 PC에서 처리합니다';
    // The first-visit notice belongs to the web connection build; the default dev UI opens straight to the writer.
    assert.equal(await page.getByRole('dialog', { name: helpTitle }).count(), 0, 'first-visit notice must not open without the connection build flag');

    const helpButton = privacyNote.getByRole('button', { name: '처리 방식', exact: true });
    assert.equal(await helpButton.getAttribute('aria-haspopup'), 'dialog');
    await helpButton.click();
    const help = page.getByRole('dialog', { name: helpTitle });
    await help.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '확인');
    // Help opens straight to the details; the first-visit toggle and footnote are intro-only.
    for (const term of ['처리', '보관', '인터넷', '삭제']) {
      assert.equal(await help.locator('dt').getByText(term, { exact: true }).count(), 1, `help must explain ${term}`);
    }
    assert.equal(await help.getByRole('button', { name: '처리 방식 자세히 보기' }).count(), 0);
    assert.equal(await help.getByRole('button', { name: '시작하기' }).count(), 0);
    assert.equal(await help.getByText('웹사이트 접속과 프로그램·모델 다운로드에는 인터넷을 사용합니다.').count(), 0);
    // Without an engine answer the storage row still states the local-only promise instead of guessing a retention.
    await help.getByText('회의록은 이 PC에만 보관합니다.', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await help.getByText('분석용 임시 음성은 완료 후 삭제', { exact: false }).count(), 0);
    // The install sentence is for the first visit; someone opening help is already using the writer.
    assert.equal(await help.getByText('처음 한 번', { exact: false }).count(), 0, 'help must not repeat the first-visit install sentence');
    // The dialog's height is capped to the window, so its box always fits; content that does not fit scrolls inside it.
    const helpOverflow = await help.evaluate(element => element.scrollHeight - element.clientHeight);
    assert.ok(helpOverflow <= 0, `help must show all four rows without scrolling at 1280x720 (overflow ${helpOverflow}px)`);
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '확인', 'focus must stay inside the help dialog');
    await page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await page.keyboard.press('Tab');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent?.trim()), '확인', 'Tab from outside the help returns focus to it');
    await page.keyboard.press('Escape');
    await help.waitFor({ state: 'hidden', timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '처리 방식');
    assert.equal(await page.evaluate(() => window.localStorage.getItem('localProcessingIntroSeen')), null, 'closing help must not mark the first-visit notice as seen');
    console.log('ok - new-record home keeps the local processing note and help without an engine answer');
  } finally {
    await context.close();
  }
};

const runEngineDownDeleteScene = async browser => {
  // Without an engine answer the record is deleted at once and its copy on this PC is deleted on the next answer.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const jobId = 'engine-down-delete-job';
  const blockedJobId = 'engine-down-blocked-job';
  let engineUp = false;
  const deleteRequests = [];
  await page.route('**/api/**', route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === 'DELETE' && pathname.startsWith('/api/outputs/')) {
      deleteRequests.push(`${engineUp ? 'answered' : 'refused'} ${decodeURIComponent(pathname.slice('/api/outputs/'.length))}`);
      return engineUp
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: [] }) })
        : route.abort('connectionrefused');
    }
    return route.abort('connectionrefused');
  });
  const dialogs = [];
  page.on('dialog', dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.accept();
  });
  const waitFor = async (check, label) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (await check()) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const pendingCleanups = () => page.evaluate(() => JSON.parse(window.localStorage.getItem('pendingMeetingOutputCleanups') ?? '[]'));
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    await putMeeting(page, { ...meetingAt('engine-down-delete', '엔진 꺼짐 삭제 회의', Date.now() - DAY_MS), jobId });
    await putMeeting(page, { ...meetingAt('engine-down-blocked', '정리 기억 실패 회의', Date.now() - 2 * DAY_MS), jobId: blockedJobId });
    await putMeeting(page, { ...meetingAt('engine-down-keep', '함께 남는 회의', Date.now() - 3 * DAY_MS), jobId: 'engine-down-keep-job' });
    const navigation = page.locator('.barorok-navigation');
    const menuTrigger = title => navigation.locator(`[data-sidebar-record-menu-trigger][aria-label^="${title},"]`);
    const deleteFromMenu = async title => {
      await menuTrigger(title).focus();
      await menuTrigger(title).press('Enter');
      await navigation.locator('[data-sidebar-record-menu]').getByRole('button', { name: '삭제', exact: true }).click();
    };
    await menuTrigger('엔진 꺼짐 삭제 회의').waitFor({ timeout: 10000 });
    assert.deepEqual(await readMeetingIds(page), ['engine-down-blocked', 'engine-down-delete', 'engine-down-keep']);
    assert.deepEqual(await pendingCleanups(), []);

    await deleteFromMenu('엔진 꺼짐 삭제 회의');
    await menuTrigger('엔진 꺼짐 삭제 회의').waitFor({ state: 'detached', timeout: 10000 });
    assert.deepEqual(dialogs.map(dialog => dialog.type), ['confirm'], 'deleting while the engine is off asks nothing more');
    assert.deepEqual(await readMeetingIds(page), ['engine-down-blocked', 'engine-down-keep']);
    assert.deepEqual(await pendingCleanups(), [jobId], 'the copy on this PC waits for the engine');
    assert.ok(deleteRequests.includes(`refused ${jobId}`));
    const toast = page.locator('.operation-toast');
    await toast.getByText(`회의록을 삭제했습니다. 이 PC의 분석 파일은 ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행되면 지웁니다.`, { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.barorok-navigation .operation-toast').count(), 0, 'the toast is outside the sidebar, above the page');

    // When this browser cannot remember the cleanup, the record stays so its analysis is never orphaned.
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItemUnlessCleanup(key, value) {
        if (key === 'pendingMeetingOutputCleanups') throw new DOMException('blocked', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
      window.__restoreSetItem = () => { Storage.prototype.setItem = setItem; };
    });
    await deleteFromMenu('정리 기억 실패 회의');
    await waitFor(() => dialogs.length === 3, 'the storage alert');
    assert.deepEqual(dialogs.map(dialog => dialog.type), ['confirm', 'confirm', 'alert']);
    assert.match(dialogs[2].message, /기억하지 못해 회의록을 삭제하지 않았습니다/);
    assert.deepEqual(await readMeetingIds(page), ['engine-down-blocked', 'engine-down-keep']);
    assert.equal(await menuTrigger('정리 기억 실패 회의').count(), 1);
    assert.deepEqual(await pendingCleanups(), [jobId]);
    await page.evaluate(() => window.__restoreSetItem());

    // A queued job that a record uses again (the same file resumed) leaves the queue without being deleted.
    await page.evaluate(() => {
      const queued = JSON.parse(window.localStorage.getItem('pendingMeetingOutputCleanups') ?? '[]');
      window.localStorage.setItem('pendingMeetingOutputCleanups', JSON.stringify([...queued, 'engine-down-keep-job']));
    });

    // The next answer from the engine deletes the waiting copy without the user doing anything.
    engineUp = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitFor(async () => (await pendingCleanups()).length === 0, 'the queued cleanup to finish');
    assert.ok(deleteRequests.includes(`answered ${jobId}`));
    assert.ok(!deleteRequests.includes(`answered ${blockedJobId}`), 'a kept record keeps its analysis');
    assert.ok(!deleteRequests.some(request => request.endsWith('engine-down-keep-job')), 'a job a record uses is never deleted from the queue');
    assert.deepEqual(await readMeetingIds(page), ['engine-down-blocked', 'engine-down-keep']);
    assert.equal(dialogs.length, 3, 'the background cleanup shows no dialog');
    console.log('ok - deleting with the engine off removes the record now and its PC copy on the next answer');
  } finally {
    await context.close();
  }
};

const run = async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await runEmptyHomeScene(browser);
    await runRecentListScene(browser);
    await runRecoveryScene(browser);
    await runPendingCancellationLockScene(browser);
    await runAnalysisEntryPointScene(browser);
    await runPrivacyNoteWithoutEngineScene(browser);
    await runEngineDownDeleteScene(browser);
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
