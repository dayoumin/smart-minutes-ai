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
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ drafts: [] }),
  }));
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

const runArchiveFlow = async browser => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  const now = new Date();
  const recentDate = now.toISOString();
  const oldDate = '2020-01-15T10:00:00.000Z';
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '기록 찾기', exact: true }).waitFor({ timeout: 10000 });
    await putMeetings(page, [
      {
        id: 'archive-recent-meeting',
        title: '하반기 운영 회의',
        date: recentDate,
        createdAt: recentDate,
        updatedAt: recentDate,
        participants: '김대리, 이과장',
        meetingPurpose: '하반기 예산과 보도자료 준비',
        summary: '예산과 배포 일정을 확정했습니다.',
        topics: ['예산', '배포'],
        decisions: ['하반기 예산을 3천만 원으로 확정', '9월 첫째 주 배포 승인'],
        actions: ['김대리가 보도자료 초안을 작성'],
        segments: [{ start: '00:00:10', end: '00:00:20', speaker: '김대리', text: '예산은 3천만 원으로 확정하겠습니다.' }],
        displaySegments: [{ start: '00:00:10', end: '00:00:20', speaker: '김대리', text: '예산은 3천만 원으로 확정하겠습니다.' }],
        speakerLabels: {},
      },
      {
        id: 'archive-old-meeting',
        title: '이전 장비 회의',
        date: oldDate,
        createdAt: oldDate,
        updatedAt: oldDate,
        participants: '박주임',
        meetingPurpose: '장비 교체 검토',
        summary: '구형 장비를 유지하기로 했습니다.',
        topics: ['장비'],
        decisions: ['구형 장비를 1년 더 유지'],
        actions: ['교체 비용을 다시 조사'],
        segments: [],
        displaySegments: [],
        speakerLabels: {},
      },
    ]);

    await page.getByRole('button', { name: '기록 찾기', exact: true }).click();
    await page.getByRole('heading', { name: '기록 찾기', exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('[data-shell-variant="document"]').count(), 1);
    await page.getByText('하반기 예산을 3천만 원으로 확정', { exact: true }).waitFor();
    await page.getByText('구형 장비를 1년 더 유지', { exact: true }).waitFor();
    assert.equal(await page.locator('.meeting-archive-item-decision').count(), 3);
    await assertNoHorizontalOverflow(page);
    if (process.env.ARCHIVE_SCREENSHOT_PATH) {
      await page.screenshot({ path: process.env.ARCHIVE_SCREENSHOT_PATH, fullPage: true });
    }

    const search = page.getByLabel('선택한 종류의 기록 검색');
    await search.fill('예산');
    await page.getByText('하반기 예산을 3천만 원으로 확정', { exact: true }).waitFor();
    assert.equal(await page.locator('.meeting-archive-item-decision').count(), 1);
    assert.equal(await page.locator('.archive-search-highlight').count() > 0, true);

    await search.fill('보도자료');
    await page.getByRole('button', { name: '할 일', exact: true }).click();
    await page.getByText('김대리가 보도자료 초안을 작성', { exact: true }).waitFor();
    assert.equal(await page.locator('.meeting-archive-item-action').count(), 1);

    await search.fill('');
    await page.getByLabel('기간').selectOption('30');
    assert.equal(await page.getByText('교체 비용을 다시 조사', { exact: true }).count(), 0);
    await page.getByText('김대리가 보도자료 초안을 작성', { exact: true }).waitFor();

    await page.getByRole('button', { name: '결정', exact: true }).click();
    const recentDecision = page.locator('.meeting-archive-item-decision').filter({ hasText: '하반기 예산을 3천만 원으로 확정' });
    await recentDecision.getByRole('button').click();
    await page.locator('.meeting-detail-shell').getByRole('heading', { name: '하반기 운영 회의' }).waitFor({ timeout: 10000 });
    const archiveButton = page.getByRole('button', { name: '기록 찾기', exact: true });
    await archiveButton.focus();
    await page.keyboard.press('Enter');
    await page.getByRole('heading', { name: '기록 찾기', exact: true }).waitFor();
    assert.equal(await page.locator('[aria-current="page"]').count(), 1, 'sidebar should expose one current page');
    assert.equal(await archiveButton.getAttribute('aria-current'), 'page');
    await page.setViewportSize({ width: 760, height: 720 });
    await assertNoHorizontalOverflow(page);
    console.log('ok - meeting archive search and decision timeline flow');
  } finally {
    await context.close();
  }
};

const runEmptyArchive = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(new URL('?view=archive', APP_URL).toString(), { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '기록 찾기', exact: true }).waitFor({ timeout: 10000 });
    await page.getByText('결정 기록이 없습니다.', { exact: true }).waitFor();
    await assertNoHorizontalOverflow(page);
    console.log('ok - meeting archive empty state');
  } finally {
    await context.close();
  }
};

const server = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  await runArchiveFlow(browser);
  await runEmptyArchive(browser);
} finally {
  await browser.close();
  await stopServer(server);
}
