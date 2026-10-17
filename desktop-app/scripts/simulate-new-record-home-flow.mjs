import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';


const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
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

const startServer = async () => {
  if (!shouldStartServer) return null;
  try {
    await waitForApp(APP_URL, 1000);
    return null;
  } catch {
    // Start a dedicated Vite server when none is running.
  }
  const url = new URL(APP_URL);
  const command = `corepack pnpm exec vite --host ${url.hostname} --port ${url.port || '5173'}`;
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
    assert.equal(await page.getByRole('button', { name: '바로록 첫 화면' }).getAttribute('aria-current'), 'page');
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
    await recovery.getByText('이어서 할 기록', { exact: true }).waitFor({ timeout: 10000 });
    await recovery.getByRole('heading', { name: '이어갈 회의' }).waitFor();
    assert.equal(await page.locator('.recent-meetings').count(), 0, 'recovery takes the companion slot before the recent list');
    await recovery.getByRole('button', { name: '이어서 기록', exact: true }).click();
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

const run = async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await runEmptyHomeScene(browser);
    await runRecentListScene(browser);
    await runRecoveryScene(browser);
    await runPendingCancellationLockScene(browser);
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
