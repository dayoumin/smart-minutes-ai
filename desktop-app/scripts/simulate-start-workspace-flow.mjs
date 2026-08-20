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

const runEmptyAndResponsiveScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const startWorkspace = page.getByRole('region', { name: '말하는 순간부터, 회의록이 됩니다' });
    await page.getByRole('heading', { name: '저장된 회의록이 없습니다' }).waitFor({ timeout: 10000 });
    await startWorkspace.getByRole('button', { name: '새 기록', exact: true }).waitFor();
    const typographyMetrics = await page.evaluate(() => {
      const heading = document.querySelector('.start-workspace-heading h1');
      const primaryLabel = document.querySelector('.start-scene-empty .start-primary-label');
      const labelTransform = primaryLabel ? new DOMMatrix(getComputedStyle(primaryLabel).transform) : null;
      return {
        headingLetterSpacing: heading ? getComputedStyle(heading).letterSpacing : '',
        headingWordSpacing: heading ? getComputedStyle(heading).wordSpacing : '',
        primaryLabelOffsetX: labelTransform?.m41 ?? null,
        primaryLabelIconCount: primaryLabel?.querySelectorAll('svg').length ?? null,
      };
    });
    assert.ok(['normal', '0px'].includes(typographyMetrics.headingLetterSpacing));
    assert.notEqual(typographyMetrics.headingWordSpacing, 'normal');
    assert.equal(typographyMetrics.primaryLabelOffsetX, -5);
    assert.equal(typographyMetrics.primaryLabelIconCount, 0);
    assert.equal(await page.getByText('첫 회의록', { exact: true }).count(), 0);
    assert.equal(await page.locator('.start-scene-copy p').count(), 0);
    const fileSupportAssurance = page.locator('.start-assurance-item').filter({ hasText: '영상·음성 파일 지원' }).first();
    await fileSupportAssurance.focus();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#start-assurance-tooltip-1')).opacity === '1');
    assert.equal(await page.locator('#start-assurance-tooltip-1').evaluate(element => getComputedStyle(element).opacity), '1');
    assert.equal(await page.locator('[data-shell-variant="ocean"]').count(), 1);
    await assertNoHorizontalOverflow(page);
    const compactMetrics = await page.evaluate(() => {
      const workspace = document.querySelector('.barorok-workspace');
      const backdrop = document.querySelector('.ocean-backdrop');
      return {
        documentScrollable: document.documentElement.scrollHeight > document.documentElement.clientHeight,
        workspaceOverflowY: workspace ? getComputedStyle(workspace).overflowY : '',
        backgroundImage: backdrop ? getComputedStyle(backdrop).backgroundImage : '',
      };
    });
    assert.equal(compactMetrics.documentScrollable, false);
    assert.match(compactMetrics.workspaceOverflowY, /auto|scroll/);
    assert.match(compactMetrics.backgroundImage, /workspace-compact\.webp/);

    await page.setViewportSize({ width: 1536, height: 1024 });
    await page.waitForTimeout(100);
    await assertNoHorizontalOverflow(page);
    const wideBackground = await page.locator('.ocean-backdrop').evaluate(element => getComputedStyle(element).backgroundImage);
    assert.match(wideBackground, /workspace-wide\.webp/);

    await page.emulateMedia({ forcedColors: 'active' });
    const backdropDisplay = await page.locator('.ocean-backdrop').evaluate(element => getComputedStyle(element).display);
    assert.equal(backdropDisplay, 'none');
    const forcedColorsCreateButton = startWorkspace.getByRole('button', { name: '새 기록', exact: true });
    await forcedColorsCreateButton.focus();
    assert.equal(await forcedColorsCreateButton.evaluate(element => document.activeElement === element), true);
    await page.emulateMedia({ forcedColors: 'none' });
    await startWorkspace.getByRole('button', { name: '새 기록', exact: true }).click();
    await page.getByRole('heading', { name: '새 회의록' }).waitFor({ timeout: 10000 });
    console.log('ok - start workspace empty and responsive scene');
  } finally {
    await context.close();
  }
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

const runRecentScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '저장된 회의록이 없습니다' }).waitFor({ timeout: 10000 });
    await putMeeting(page, {
      id: 'recent-start-meeting',
      title: '최근 운영 회의',
      date: '2026-08-13T10:00:00.000Z',
      participants: '',
      meetingPurpose: '최근 회의록 진입 확인',
      summary: '최근 회의의 요약입니다.',
      segments: [],
      displaySegments: [],
      speakerLabels: {},
      createdAt: '2026-08-13T10:00:00.000Z',
      updatedAt: '2026-08-13T10:10:00.000Z',
    });
    await page.getByText('최근 회의록', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('heading', { name: '최근 운영 회의' }).waitFor();
    await page.getByRole('button', { name: '회의록 열기', exact: true }).click();
    await page.locator('.meeting-detail-shell').getByRole('heading', { name: '최근 운영 회의' }).waitFor({ timeout: 10000 });
    console.log('ok - start workspace recent scene');
  } finally {
    await context.close();
  }
};

const runRecoveryScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const draft = {
    jobId: 'start-recovery-job',
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
    await putMeeting(page, {
      id: 'recovery-priority-recent-meeting',
      title: '복구보다 오래된 최근 회의',
      date: '2026-08-13T08:00:00.000Z',
      participants: '',
      meetingPurpose: '복구 우선순위 확인',
      summary: '최근 회의가 있어도 복구가 우선이어야 합니다.',
      segments: [],
      displaySegments: [],
      speakerLabels: {},
      createdAt: '2026-08-13T08:00:00.000Z',
      updatedAt: '2026-08-13T08:10:00.000Z',
    });
    await page.getByText('이어서 할 기록', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('heading', { name: '이어갈 회의' }).waitFor();
    await page.getByRole('button', { name: '이어서 기록', exact: true }).click();
    await page.getByRole('heading', { name: /이어하기|분석 상태/ }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByText('최근 회의록', { exact: true }).count(), 0);
    console.log('ok - start workspace recovery scene');
  } finally {
    await context.close();
  }
};

const runPendingCancellationLockScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    window.localStorage.setItem('pendingAnalysisDraftCleanups', JSON.stringify(['start-pending-cancel-job']));
    window.localStorage.setItem('pendingCancelledAnalysisCleanups', JSON.stringify(['start-pending-cancel-job']));
  });
  const page = await context.newPage();
  let analyzeRequestCount = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/analyze') analyzeRequestCount += 1;
  });
  await installBaseRoutes(page);
  await page.route('**/api/analyze/drafts/start-pending-cancel-job', route => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'analysis_job_active' }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const emptyCreateButton = page.getByRole('region', { name: '말하는 순간부터, 회의록이 됩니다' }).getByRole('button', { name: '새 기록', exact: true });
    await emptyCreateButton.waitFor({ timeout: 10000 });
    assert.equal(await emptyCreateButton.isDisabled(), true);
    await page.locator('#start-new-meeting-blocked').waitFor();

    await putMeeting(page, {
      id: 'pending-lock-recent-meeting',
      title: '정리 대기 중 최근 회의',
      date: '2026-08-13T11:00:00.000Z',
      participants: '',
      meetingPurpose: '정리 잠금 확인',
      summary: '기존 회의록 열기는 계속 사용할 수 있습니다.',
      segments: [],
      displaySegments: [],
      speakerLabels: {},
      createdAt: '2026-08-13T11:00:00.000Z',
      updatedAt: '2026-08-13T11:10:00.000Z',
    });
    await page.getByText('최근 회의록', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('button', { name: '새 기록 만들기', exact: true }).isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '회의록 열기', exact: true }).isEnabled(), true);

    const minutesUrl = new URL(APP_URL);
    minutesUrl.searchParams.set('view', 'minutes');
    await page.goto(minutesUrl.toString(), { waitUntil: 'domcontentloaded' });
    const writerStartButton = page.getByRole('button', { name: '분석 시작', exact: true });
    await writerStartButton.waitFor({ timeout: 10000 });
    assert.equal(await writerStartButton.isDisabled(), true);
    assert.equal(analyzeRequestCount, 0);
    console.log('ok - pending cancellation locks start and writer actions');
  } finally {
    await context.close();
  }
};

const run = async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await runEmptyAndResponsiveScene(browser);
    await runRecentScene(browser);
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
