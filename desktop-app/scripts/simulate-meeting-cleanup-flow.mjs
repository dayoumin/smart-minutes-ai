import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';


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

const monthsAgo = months => {
  const date = new Date();
  date.setMonth(date.getMonth() - months);
  return date.getTime();
};

// One engine for the whole scene: `mode` switches it between answering, off and an older build.
const installEngine = async page => {
  const engine = {
    mode: 'up',
    silentDeletes: false,
    deleted: [],
    stored: [
      { job_id: 'cleanup-old-job', completed_at: '2025-12-01T00:00:00+00:00', size_bytes: 1024 * 1024 },
      { job_id: 'cleanup-recent-job', completed_at: '2026-10-19T00:00:00+00:00', size_bytes: 1024 * 1024 },
      { job_id: 'orphan-one', completed_at: '2025-11-01T00:00:00+00:00', size_bytes: 3 * 1024 * 1024 },
      { job_id: 'orphan-two', completed_at: '2025-10-01T00:00:00+00:00', size_bytes: 2 * 1024 * 1024 },
      { job_id: 'draft-job', completed_at: '2026-01-01T00:00:00+00:00', size_bytes: 1024 * 1024 },
    ],
  };
  await page.route('**/api/**', route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (engine.mode === 'down') return route.abort('connectionrefused');
    if (pathname === '/api/stored-analyses') {
      if (engine.mode === 'outdated') return route.fulfill({ status: 403, contentType: 'application/json', body: JSON.stringify({ detail: 'forbidden' }) });
      const analyses = engine.stored.filter(item => !engine.deleted.includes(item.job_id));
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ analyses }) });
    }
    if (request.method() === 'DELETE' && pathname.startsWith('/api/outputs/')) {
      // Leave the request pending to exercise the client's timeout while health and listing still answer.
      if (engine.silentDeletes) return undefined;
      // Only the answering engine deletes, so the queued retry cannot race the listing checks below.
      if (engine.mode !== 'up') return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: 'busy' }) });
      const jobId = decodeURIComponent(pathname.slice('/api/outputs/'.length));
      if (jobId === 'cleanup-active-job') {
        return route.fulfill({ status: 409, contentType: 'application/json', body: JSON.stringify({ detail: 'analysis_job_active' }) });
      }
      engine.deleted.push(jobId);
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ job_id: jobId, deleted: [] }) });
    }
    if (pathname === '/api/health') return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    return route.abort('connectionrefused');
  });
  return engine;
};

const pendingCleanups = page => page.evaluate(() => JSON.parse(window.localStorage.getItem('pendingMeetingOutputCleanups') ?? '[]'));

const runCleanupScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    if (window.localStorage.getItem('cleanup-seeded')) return;
    window.localStorage.setItem('cleanup-seeded', '1');
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([{
      jobId: 'draft-job', title: '이어갈 분석', date: '2026-01-01T09:00', participants: '',
      sourceFilename: 'draft.wav', sourceSize: 10, sourceLastModified: 1, status: 'stopped',
      createdAt: '2026-01-01T09:00:00.000Z', updatedAt: '2026-01-01T09:05:00.000Z', resumeEligible: true, completedChunkCount: 1,
    }]));
  });
  const page = await context.newPage();
  const engine = await installEngine(page);
  const dialogs = [];
  page.on('dialog', dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.accept();
  });
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    await putMeeting(page, { ...meetingAt('cleanup-recent', '이번 주 운영 회의', Date.now() - DAY_MS), jobId: 'cleanup-recent-job' });
    await putMeeting(page, { ...meetingAt('cleanup-old-1', '작년 기획 회의', monthsAgo(8)), jobId: 'cleanup-old-job' });
    await putMeeting(page, meetingAt('cleanup-old-2', '오래된 메모 회의', monthsAgo(10)));
    await putMeeting(page, { ...meetingAt('cleanup-active', '분석 중인 회의', monthsAgo(7)), jobId: 'cleanup-active-job' });
    assert.deepEqual(await readMeetingIds(page), ['cleanup-active', 'cleanup-old-1', 'cleanup-old-2', 'cleanup-recent']);

    await page.getByRole('button', { name: '설정', exact: true }).first().click();
    const settings = page.getByRole('dialog', { name: '설정' });
    await settings.waitFor({ timeout: 10000 });
    const openCleanup = settings.getByRole('button', { name: '정리하기', exact: true });
    await openCleanup.click();
    await settings.getByRole('heading', { name: '회의록 정리', level: 3 }).waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.id === 'meeting-cleanup-title');
    const count = settings.locator('.meeting-cleanup-count');
    await count.getByText('전체 4개', { exact: true }).waitFor({ timeout: 10000 });
    const rows = settings.locator('.meeting-cleanup-list li');
    assert.equal(await rows.count(), 4);
    assert.deepEqual(await settings.locator('.meeting-cleanup-list .meeting-cleanup-title').allTextContents(),
      ['이번 주 운영 회의', '분석 중인 회의', '작년 기획 회의', '오래된 메모 회의'], 'newest recorded first');
    // Leftovers exclude analyses a record or a resumable draft of this browser still uses.
    await settings.getByText('분석 결과 2개 · 5 MB', { exact: true }).waitFor({ timeout: 10000 });
    const deleteSelected = settings.locator('.meeting-cleanup-actions button');
    assert.equal(await deleteSelected.isDisabled(), true, 'nothing selected, nothing to delete');

    await settings.getByLabel('기간').selectOption('6');
    await count.getByText('전체 4개 중 3개', { exact: true }).waitFor();
    assert.equal(await rows.count(), 3);
    const head = settings.locator('.meeting-cleanup-row-head input');
    const rowBox = title => settings.locator('.meeting-cleanup-list label').filter({ hasText: title }).locator('input');
    await head.check();
    await settings.getByText('3개 선택됨', { exact: true }).waitFor();
    await rowBox('오래된 메모 회의').uncheck();
    assert.equal(await head.evaluate(input => input.indeterminate), true, 'a partial selection shows as mixed');
    assert.equal(await head.isChecked(), false);
    await rowBox('오래된 메모 회의').check();
    assert.equal(await head.evaluate(input => input.indeterminate), false);
    assert.equal(await deleteSelected.textContent(), '선택한 3개 삭제');

    await deleteSelected.click();
    await settings.locator('.meeting-cleanup-kept').waitFor({ timeout: 10000 });
    assert.equal(dialogs.length, 1);
    assert.match(dialogs[0].message, /^회의록 3개를 삭제할까요\?/);
    assert.equal(await settings.locator('.meeting-cleanup-kept').textContent(),
      '2개를 삭제했습니다. 분석이 진행 중인 1개는 남겼습니다. 분석을 중단한 뒤 다시 삭제해 주세요.');
    assert.deepEqual(await readMeetingIds(page), ['cleanup-active', 'cleanup-recent']);
    assert.deepEqual(engine.deleted, ['cleanup-old-job'], 'only the deleted record with an analysis asked the engine');
    assert.equal(await rows.count(), 1, 'the kept record stays listed');
    assert.equal(await settings.locator('.meeting-cleanup-list input').isChecked(), true, 'and stays selected to retry');
    assert.equal(await page.locator('.barorok-navigation [data-sidebar-record-menu-trigger][aria-label^="작년 기획 회의,"]').count(), 0, 'the sidebar follows');

    // With the engine off, records still go now and their PC copies wait in the queue.
    engine.mode = 'down';
    await settings.getByLabel('기간').selectOption('all');
    await rowBox('이번 주 운영 회의').check();
    await deleteSelected.click();
    const toast = page.locator('.operation-toast');
    await toast.getByText(`회의록 1개를 삭제했습니다. 이 PC의 분석 파일은 ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행되면 지웁니다.`, { exact: true }).waitFor({ timeout: 10000 });
    assert.deepEqual(await readMeetingIds(page), ['cleanup-active']);
    assert.deepEqual(await pendingCleanups(page), ['cleanup-recent-job']);
    await settings.getByText(`${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중일 때 확인할 수 있습니다.`, { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await settings.getByRole('button', { name: '모두 삭제' }).count(), 0, 'no delete without a list');

    // An older engine without the listing asks for an update instead of failing silently.
    engine.mode = 'outdated';
    await settings.getByRole('button', { name: '일반 설정' }).click();
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '정리하기');
    await openCleanup.click();
    await settings.getByText(`${withJosa(LOCAL_ENGINE_NAME, '을/를')} 업데이트하면 확인할 수 있습니다.`, { exact: true }).waitFor({ timeout: 10000 });

    engine.mode = 'up';
    await settings.getByRole('button', { name: '일반 설정' }).click();
    await openCleanup.click();
    // cleanup-recent-job lost its record, so it counts as a leftover, unless the queued retry deleted it first.
    const leftovers = settings.getByText(/^분석 결과 (3개 · 6 MB|2개 · 5 MB)$/);
    await leftovers.waitFor({ timeout: 10000 });
    const leftoverCount = (await leftovers.textContent()).match(/(\d)개/)[1];
    await settings.getByRole('button', { name: '모두 삭제', exact: true }).click();
    await settings.getByText('이 PC에만 남은 분석 파일이 없습니다.', { exact: true }).waitFor({ timeout: 10000 });
    assert.match(dialogs.at(-1).message, new RegExp(`^이 PC에만 남은 분석 결과 ${leftoverCount}개를 삭제할까요\\?`));
    assert.match(dialogs.at(-1).message, /다른 브라우저/);
    assert.deepEqual([...new Set(engine.deleted)].sort(), ['cleanup-old-job', 'cleanup-recent-job', 'orphan-one', 'orphan-two']);
    assert.ok(!engine.deleted.includes('draft-job'), 'a resumable draft keeps its analysis');
    assert.ok(!engine.deleted.includes('cleanup-active-job'));
    assert.deepEqual(await pendingCleanups(page), [], 'deleting it here also clears its queued cleanup');
    await page.locator('.operation-toast').getByText(`이 PC의 분석 결과 ${leftoverCount}개를 삭제했습니다.`, { exact: true }).waitFor({ timeout: 10000 });
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.ok(overflow <= 0, `settings overflowed by ${overflow}px`);

    // If this browser's records cannot be read, nothing on this PC may be offered as a leftover.
    engine.deleted.length = 0;
    engine.stored.push({ job_id: 'cleanup-active-job', completed_at: '2026-03-01T00:00:00+00:00', size_bytes: 1024 });
    await page.evaluate(() => {
      IDBObjectStore.prototype.getAll = function blockedGetAll() { throw new DOMException('blocked', 'InvalidStateError'); };
    });
    await settings.getByRole('button', { name: '일반 설정' }).click();
    await openCleanup.click();
    await settings.getByText('회의록을 불러오지 못했습니다. 설정을 닫았다가 다시 열어 주세요.', { exact: true }).waitFor({ timeout: 10000 });
    await settings.getByText('이 PC에 남은 분석 파일을 확인하지 못했습니다. 잠시 후 다시 열어 주세요.', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await settings.getByRole('button', { name: '모두 삭제' }).count(), 0);
    assert.equal(await settings.locator('.meeting-cleanup-list li').count(), 0);
    assert.deepEqual(engine.deleted, []);
    console.log('ok - 회의록 정리 deletes selected records by period, keeps running ones and clears PC leftovers');
  } finally {
    await context.close();
  }
};

const runUnresponsiveDeleteScenes = async browser => {
  for (const target of ['record', 'pc-files']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    const engine = await installEngine(page);
    engine.stored = [
      { job_id: 'cleanup-timeout-job', completed_at: '2026-10-19T00:00:00+00:00', size_bytes: 1024 },
      { job_id: 'cleanup-timeout-orphan', completed_at: '2026-10-19T00:00:00+00:00', size_bytes: 1024 },
    ];
    page.on('dialog', dialog => { void dialog.accept(); });
    try {
      await page.clock.install();
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
      await putMeeting(page, {
        ...meetingAt('cleanup-timeout', '응답 없는 엔진의 회의', Date.now() - DAY_MS),
        jobId: 'cleanup-timeout-job',
      });
      await page.getByRole('button', { name: '설정', exact: true }).first().click();
      const settings = page.getByRole('dialog', { name: '설정' });
      await settings.getByRole('button', { name: '정리하기', exact: true }).click();
      await settings.getByText('분석 결과 1개 · 1 KB', { exact: true }).waitFor({ timeout: 10000 });
      engine.silentDeletes = true;
      const back = settings.getByRole('button', { name: '일반 설정', exact: true });
      const close = settings.getByRole('button', { name: '설정 닫기', exact: true });
      const jobId = target === 'record' ? 'cleanup-timeout-job' : 'cleanup-timeout-orphan';
      const requestStarted = page.waitForRequest(request => request.method() === 'DELETE'
        && new URL(request.url()).pathname === `/api/outputs/${jobId}`);
      if (target === 'record') {
        await settings.locator('.meeting-cleanup-list input').check();
        await settings.getByRole('button', { name: '선택한 1개 삭제', exact: true }).click();
      } else {
        await settings.getByRole('button', { name: '모두 삭제', exact: true }).click();
      }
      await requestStarted;
      // Keep two seconds of margin around the 15s deadline for a loaded Windows machine.
      await page.clock.runFor(13_000);
      assert.equal(await back.isDisabled(), true, `${target} stays busy while the engine has not answered`);
      assert.equal(await close.isDisabled(), true);
      await page.clock.runFor(4_000);
      await page.waitForFunction(() => !document.querySelector('.meeting-cleanup-back')?.disabled, null, { timeout: 5000 });
      assert.equal(await close.isEnabled(), true, 'the timeout releases the settings close guard');
      assert.equal(await settings.getByRole('tab', { name: '모델', exact: true }).isEnabled(), true);
      if (target === 'record') {
        assert.deepEqual(await readMeetingIds(page), [], 'the record is deleted after remembering its PC copy');
        assert.deepEqual(await pendingCleanups(page), ['cleanup-timeout-job']);
        await page.locator('.operation-toast').getByText(
          `회의록 1개를 삭제했습니다. 이 PC의 분석 파일은 ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행되면 지웁니다.`,
          { exact: true },
        ).waitFor({ timeout: 5000 });
      } else {
        assert.deepEqual(await readMeetingIds(page), ['cleanup-timeout']);
        assert.deepEqual(await pendingCleanups(page), [], 'PC-only cleanup does not delete or queue browser records');
        await settings.getByText(`${withJosa(LOCAL_ENGINE_NAME, '이/가')} 응답하지 않아 나머지는 지우지 못했습니다.`,
          { exact: true }).waitFor({ timeout: 5000 });
        assert.equal(await settings.getByRole('button', { name: '모두 삭제', exact: true }).isEnabled(), true, 'PC cleanup can be retried');
      }
      assert.deepEqual(engine.deleted, [], 'a timeout is not reported as an engine-side deletion');
      await back.click();
      await close.click();
      await settings.waitFor({ state: 'hidden', timeout: 5000 });
      console.log(`ok - unresponsive ${target} deletion finishes after its timeout and releases settings`);
    } finally {
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await context.close();
    }
  }
};

const run = async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    await runCleanupScene(browser);
    await runUnresponsiveDeleteScenes(browser);
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
