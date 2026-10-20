import assert from 'node:assert/strict';
import { chromium } from 'playwright';

assert.ok(process.env.APP_URL, 'Set APP_URL to a dedicated Vite server for this checkout.');
const appUrl = new URL(process.env.APP_URL).toString();
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
const page = await context.newPage();
page.setDefaultTimeout(10000);
const sidebar = page.locator('.barorok-navigation');
const failure = sidebar.getByText('폴더를 불러오지 못했습니다.', { exact: true });
const folder = sidebar.getByRole('button', { name: '복구 검증 폴더', exact: true });
const record = sidebar.getByText('보존할 회의록', { exact: true });
const retry = sidebar.getByRole('button', { name: '폴더 다시 불러오기', exact: true });
const seed = () => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('MeetingHistoryDB', 2);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const transaction = db.transaction(['meetings', 'folders'], 'readwrite');
    const now = new Date().toISOString();
    transaction.objectStore('folders').put({ id: 'recovery-folder', name: '복구 검증 폴더', createdAt: now, updatedAt: now });
    transaction.objectStore('meetings').put({
      id: 'recovery-record', folderId: 'recovery-folder', title: '보존할 회의록',
      date: now, createdAt: now, updatedAt: now, summary: '보존할 본문',
      segments: [], displaySegments: [], topics: [], decisions: [], actions: [], speakerLabels: {},
    });
    transaction.oncomplete = () => { db.close(); resolve(); };
    transaction.onerror = () => reject(transaction.error);
  };
}));

try {
  for (const [path, body] of Object.entries({
    health: { ok: true }, settings: { diarization: { enabled: true, generate_during_analysis: true } },
    'models/status': { ready: true, models: [] }, 'analyze/draft-statuses': { drafts: [] },
  })) {
    await page.route(`**/api/${path}`, route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify(body),
    }));
  }
  await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
  await sidebar.getByRole('button', { name: '폴더 만들기', exact: true }).waitFor();
  await seed();
  await page.addInitScript(() => {
    // StrictMode runs initial effects twice, so hold the failure until retry.
    window.folderReadFailures = Infinity;
    window.folderReadsAborted = 0;
    const original = IDBObjectStore.prototype.getAll;
    IDBObjectStore.prototype.getAll = function (...args) {
      const request = original.apply(this, args);
      if (window.folderReadFailures > 0 && this.name === 'folders' && this.transaction.objectStoreNames.length === 1) {
        window.folderReadFailures -= 1;
        window.folderReadsAborted += 1;
        this.transaction.abort();
      }
      return request;
    };
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await failure.waitFor();
  assert.equal(await folder.count(), 0, 'initial failure is explicit even with no cached folders');
  const initialFailures = await page.evaluate(() => {
    window.folderReadFailures = 0;
    return window.folderReadsAborted;
  });
  assert.ok(initialFailures > 0);
  await retry.click();
  await folder.waitFor();
  await failure.waitFor({ state: 'hidden' });
  if (!await record.isVisible()) await folder.click();
  await record.waitFor();
  console.log('ok - initial folder read failure exposes a retry that restores saved meetings');

  const failNextRead = () => page.evaluate(() => {
    window.folderReadFailures = 1;
    window.dispatchEvent(new Event('meetings:updated'));
  });
  await failNextRead();
  await failure.waitFor();
  assert.equal(await folder.isVisible(), true, 'a failed refresh preserves the last successful folder list');
  assert.equal(await record.isVisible(), true, 'filed meetings remain accessible');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await failure.waitFor({ state: 'hidden' });
  assert.equal(await record.isVisible(), true);
  console.log('ok - a failed refresh keeps meetings visible and window focus retries folders');

  await failNextRead();
  await failure.waitFor();
  await retry.click();
  await failure.waitFor({ state: 'hidden' });
  const stored = await page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('MeetingHistoryDB', 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction('meetings', 'readonly');
      const get = transaction.objectStore('meetings').get('recovery-record');
      transaction.oncomplete = () => { db.close(); resolve(get.result); };
      transaction.onerror = () => reject(transaction.error);
    };
  }));
  assert.equal(stored.folderId, 'recovery-folder');
  assert.equal(stored.summary, '보존할 본문');
  assert.equal(await page.evaluate(() => window.folderReadsAborted), initialFailures + 2);
  console.log('ok - explicit retry preserves the stored folder assignment and meeting content');
} finally {
  await context.close();
  await browser.close();
}
