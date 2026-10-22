import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BRAND_NAME } from '../src/brand.ts';

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

const sidebar = page => page.locator('.barorok-navigation');
const mode = async (page, value) => { await page.locator(`.barorok-navigation[data-mode="${value}"]`).waitFor(); };
const click = (page, name) => sidebar(page).getByRole('button', { name, exact: true }).click();
const select = async (page, title) => {
  if (await sidebar(page).getAttribute('data-mode') === 'rail') await click(page, '회의록 목록');
  await sidebar(page).getByRole('button', { name: title, exact: true }).click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
};
const capture = async (page, name) => {
  if (process.env.SIDEBAR_SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SIDEBAR_SCREENSHOT_DIR}/${name}.png` });
};
const records = [
  { id: 'sidebar-a', title: '하반기 연구 회의', date: '2026-10-22', summary: '', participants: '', analysisStatus: 'completed', jobId: 'sidebar-a', diarizationApplied: true,
    segments: Array.from({ length: 50 }, (_, i) => ({ start: `00:00:${String(i).padStart(2, '0')}`, end: `00:00:${String(i + 1).padStart(2, '0')}`, speaker: 'SPEAKER_00', text: `${i + 1}번째 조사 결과와 장비 점검 일정을 확인합니다.` })) },
  { id: 'sidebar-b', title: '장비 점검 회의', date: '2026-10-22', summary: '', participants: '', segments: [], analysisStatus: 'completed' },
];
const run = async (browser, { width, deniedStorage = false }) => {
  const context = await browser.newContext({ viewport: { width, height: 768 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await installBaseRoutes(page);
  const audio = Buffer.alloc(44 + 8000 * 2 * 30);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  await page.route('**/api/outputs/*/audio', route => {
    const common = { 'Access-Control-Allow-Origin': new URL(APP_URL).origin, 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, Content-Length' };
    if (route.request().method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...common, 'Access-Control-Allow-Headers': 'Authorization, Range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' } });
    const range = route.request().headers().range;
    const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), audio.length - 1) : audio.length - 1;
    const headers = { ...common, 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
    if (range) headers['Content-Range'] = `bytes ${start}-${end}/${audio.length}`;
    return route.fulfill({ status: range ? 206 : 200, headers, body: route.request().method() === 'HEAD' ? '' : audio.subarray(start, end + 1) });
  });
  if (deniedStorage) await page.addInitScript(() => {
    const get = Storage.prototype.getItem;
    const set = Storage.prototype.setItem;
    Storage.prototype.getItem = function(key) { if (key === 'sidebarCollapsed') throw new DOMException('Denied', 'SecurityError'); return get.call(this, key); };
    Storage.prototype.setItem = function(key, value) { if (key === 'sidebarCollapsed') throw new DOMException('Denied', 'SecurityError'); return set.call(this, key, value); };
  });
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    assert.equal(await page.title(), BRAND_NAME);
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor();
    await putMeetings(page, records);
    const narrow = width < 1200;
    await mode(page, narrow ? 'rail' : 'expanded');
    assert.equal(Math.round((await sidebar(page).boundingBox()).width), narrow ? 56 : 240);
    if (deniedStorage) {
      await click(page, '메뉴 접기');
      await mode(page, 'expanded');
      assert.deepEqual(errors, []);
      console.log('ok - denied sidebar storage keeps expanded navigation usable');
      return;
    }
    await select(page, records[0].title);
    await page.locator('.meeting-audio-player').waitFor();
    await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
    await page.evaluate(() => {
      window.__sidebarMain = document.querySelector('main');
      window.__sidebarAudio = document.querySelector('audio');
      window.__sidebarAudio.currentTime = 3;
      document.querySelector('main').scrollTop = 250;
    });
    await page.waitForFunction(() => Math.abs(document.querySelector('audio').currentTime - 3) < 0.1);
    if (!narrow) {
      await capture(page, 'wide-expanded');
      await click(page, '메뉴 접기'); await mode(page, 'rail');
      assert.equal(Math.round((await page.locator('main').boundingBox()).x), 56);
      await page.reload({ waitUntil: 'domcontentloaded' }); await mode(page, 'rail');
      assert.equal(await page.evaluate(() => localStorage.getItem('sidebarCollapsed')), '1');
      await click(page, '메뉴 펼치기'); await mode(page, 'expanded');
      assert.equal(await page.evaluate(() => localStorage.getItem('sidebarCollapsed')), '0');
      console.log('ok - wide collapse choice survives reload and expands again');
    } else {
      await page.evaluate(async () => {
        const { upsertAnalysisResumeDraft } = await import('/src/analysisResumeDrafts.ts');
        upsertAnalysisResumeDraft({ jobId: 'sidebar-resume', title: '이어서 할 회의', date: '2026-10-22', participants: '', sourceFilename: 'sample.wav', sourceSize: 100, sourceLastModified: 0, status: 'stopped', resumeEligible: true, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });
      });
      await page.waitForFunction(() => {
        const button = document.querySelector('[aria-label="회의록 목록"]');
        const description = document.getElementById(button?.getAttribute('aria-describedby'));
        return description?.textContent === '이어서 할 분석 있음';
      });
      await page.evaluate(async () => (await import('/src/analysisResumeDrafts.ts')).removeAnalysisResumeDraft('sidebar-resume'));
      const columns = await page.evaluate(() => ({
        infoRight: document.querySelector('.meeting-detail-info').getBoundingClientRect().right,
        tabsLeft: document.querySelector('.detail-main-nav').getBoundingClientRect().left,
      }));
      assert.ok(columns.infoRight <= columns.tabsLeft, '1024px keeps meeting information beside the tabs');
      const before = await page.locator('main').evaluate(e => ({ left: e.getBoundingClientRect().left, width: e.clientWidth, top: e.scrollTop }));
      await capture(page, 'narrow-rail');
      await click(page, '회의록 목록'); await mode(page, 'overlay');
      assert.deepEqual(await page.locator('main').evaluate(e => ({ left: e.getBoundingClientRect().left, width: e.clientWidth, top: e.scrollTop })), before, 'overlay does not push or scroll the document');
      assert.equal(await page.locator('main').getAttribute('inert'), '');
      const buttons = sidebar(page).getByRole('button');
      await buttons.last().focus(); await page.keyboard.press('Tab');
      assert.ok(await buttons.first().evaluate(e => e === document.activeElement), 'Tab wraps inside the overlay');
      await page.keyboard.press('Shift+Tab');
      assert.ok(await buttons.last().evaluate(e => e === document.activeElement), 'Shift+Tab wraps inside the overlay');
      await capture(page, 'narrow-overlay');
      await page.keyboard.press('Escape'); await mode(page, 'rail');
      await page.waitForFunction(() => document.activeElement?.classList.contains('sidebar-rail-expand'));
      assert.ok(await page.evaluate(() => window.__sidebarMain === document.querySelector('main') && window.__sidebarAudio === document.querySelector('audio')), 'menu transitions preserve main and audio DOM nodes');
      const playbackTime = await page.locator('audio').evaluate(e => e.currentTime);
      assert.ok(Math.abs(playbackTime - 3) < 0.1, `playback position is retained: ${playbackTime}`);
      await page.locator('audio').evaluate(e => e.play());
      const playingTime = await page.locator('audio').evaluate(e => e.currentTime);
      await click(page, '회의록 목록'); await mode(page, 'overlay');
      await page.keyboard.press('Escape'); await mode(page, 'rail');
      await page.waitForFunction(t => !document.querySelector('audio').paused && document.querySelector('audio').currentTime > t, playingTime);
      await page.locator('audio').evaluate(e => e.pause());
      await click(page, '회의록 목록'); await mode(page, 'overlay');
      await click(page, '설정'); await mode(page, 'rail');
      await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
      await page.waitForFunction(() => document.activeElement === document.querySelector('.barorok-navigation[data-mode="rail"] button[aria-label="설정"]'));
      await click(page, '설정');
      await page.getByRole('button', { name: '설정 닫기', exact: true }).waitFor();
      await page.setViewportSize({ width: 1280, height: 768 }); await mode(page, 'expanded');
      await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
      assert.ok(await sidebar(page).getByRole('button', { name: '설정', exact: true }).evaluate(e => e === document.activeElement), 'settings focus follows a resize into expanded navigation');
      await click(page, '설정');
      await page.getByRole('button', { name: '설정 닫기', exact: true }).waitFor();
      await page.setViewportSize({ width, height: 768 }); await mode(page, 'rail');
      await page.getByRole('button', { name: '설정 닫기', exact: true }).click();
      assert.ok(await sidebar(page).getByRole('button', { name: '설정', exact: true }).evaluate(e => e === document.activeElement), 'settings focus follows a resize into icon navigation');
      await page.getByRole('button', { name: '회의 정보 수정', exact: true }).click();
      const draftTitle = page.locator('.meeting-detail-shell').getByLabel('회의 제목', { exact: true });
      await draftTitle.fill('아직 저장하지 않은 회의 제목');
      await click(page, '회의록 목록'); await mode(page, 'overlay');
      await page.keyboard.press('Escape'); await mode(page, 'rail');
      assert.equal(await draftTitle.inputValue(), '아직 저장하지 않은 회의 제목', 'opening and closing navigation preserves unsaved edits');
      await page.getByRole('button', { name: '수정 취소', exact: true }).click();
      await click(page, '메뉴 펼치기'); await mode(page, 'overlay');
      await page.getByRole('button', { name: '메뉴 닫기', exact: true }).click({ position: { x: 600, y: 400 } });
      await mode(page, 'rail');
      await select(page, records[1].title); await mode(page, 'rail');
      await click(page, '메뉴 펼치기'); await mode(page, 'overlay');
      await page.setViewportSize({ width: 1280, height: 768 }); await mode(page, 'expanded');
      assert.equal(await sidebar(page).count(), 1);
      assert.equal(await page.locator('.sidebar-rail-spacer').count(), 0);
      await click(page, '메뉴 접기'); await mode(page, 'rail');
      await page.setViewportSize({ width: 1024, height: 768 }); await mode(page, 'rail');
      await click(page, '회의록 목록'); await mode(page, 'overlay');
      await page.setViewportSize({ width: 1280, height: 768 }); await mode(page, 'rail');
      assert.equal(await page.locator('.sidebar-scrim').count(), 0, 'resize restores the remembered wide choice');
      await page.setViewportSize({ width, height: 768 });
      await click(page, '새 회의록');
      await page.getByRole('heading', { name: '새 회의록', exact: true }).waitFor();
      console.log('ok - narrow rail/overlay, focus, record selection, resize and audio continuity');
    }
    assert.deepEqual(errors, []);
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), 'no document overflow');
  } catch (error) {
    await capture(page, `failure-${width}`);
    console.error((await page.locator('body').innerText()).slice(0, 1600));
    throw error;
  } finally { await context.close(); }
};
const server = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  if (!process.argv.includes('narrow')) await run(browser, { width: 1280 });
  await run(browser, { width: 1024 });
  if (!process.argv.includes('narrow')) await run(browser, { width: 1280, deniedStorage: true });
} finally { await browser.close(); await stopServer(server); }
