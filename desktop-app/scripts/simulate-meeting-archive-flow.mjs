import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

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
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.barorok-navigation').getByRole('button', { name: '기록 찾기', exact: true }).count(), 0, 'archive entry is hidden from the sidebar for now');
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

    const archiveUrl = new URL('?view=archive', APP_URL).toString();
    await page.goto(archiveUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '기록 찾기', exact: true }).waitFor({ timeout: 10000 });
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
    await page.goto(archiveUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '기록 찾기', exact: true }).waitFor({ timeout: 10000 });
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

const runFolderFlow = async browser => {
  const context = await browser.newContext({ viewport: { width: 1100, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  const original = {
    id: 'folder-preservation-meeting', title: '폴더 선택 전 회의', date: '2026-10-18T09:00:00',
    summary: '기존 요약을 유지합니다.', segments: [], displaySegments: [], speakerLabels: {},
  };
  const other = { ...original, id: 'folder-other-meeting', title: '다른 기존 회의' };
  const readStored = () => page.evaluate(() => new Promise((resolve, reject) => {
    const request = indexedDB.open('MeetingHistoryDB', 2);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const db = request.result;
      const transaction = db.transaction(['meetings', 'folders'], 'readonly');
      const meetings = transaction.objectStore('meetings').getAll();
      const folders = transaction.objectStore('folders').getAll();
      transaction.oncomplete = () => {
        db.close();
        resolve({ meetings: meetings.result, folders: folders.result });
      };
      transaction.onerror = () => { db.close(); reject(transaction.error); };
    };
  }));
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const sidebar = page.locator('.barorok-navigation');
    await sidebar.getByRole('button', { name: '폴더 만들기', exact: true }).waitFor();
    await putMeetings(page, [original, other]);
    const recordButton = sidebar.getByRole('button', { name: original.title, exact: true });
    const otherButton = sidebar.getByRole('button', { name: other.title, exact: true });
    await recordButton.waitFor();
    await otherButton.waitFor();
    await recordButton.locator('xpath=..').hover();
    await recordButton.locator('xpath=..').locator('[data-sidebar-record-menu-trigger]').click();
    assert.equal(await sidebar.getByRole('button', { name: '폴더 이동', exact: true }).isDisabled(), true, 'no empty submenu before folders exist');
    await page.keyboard.press('Escape');
    const createFolder = async name => {
      await sidebar.getByRole('button', { name: '폴더 만들기', exact: true }).click();
      await page.getByLabel('새 폴더 이름').fill(name);
      await page.getByRole('button', { name: '만들기', exact: true }).click();
      const button = sidebar.getByRole('button', { name, exact: true });
      await button.waitFor();
      // Folder insertion renders before the creation handler finishes; wait for its settled UI.
      await page.getByLabel('새 폴더 이름').waitFor({ state: 'detached' });
      return button;
    };
    const folderA = await createFolder('첫 폴더');
    assert.equal(await folderA.getAttribute('aria-expanded'), 'false');
    assert.equal(await recordButton.isVisible(), true, 'creating a folder keeps existing records visible');
    assert.equal(await otherButton.isVisible(), true);
    assert.deepEqual((await readStored()).meetings, [other, original].sort((a, b) => a.id.localeCompare(b.id)));

    const moveRecord = async (destination, keyboard = false) => {
      const row = recordButton.locator('xpath=..');
      await row.hover();
      await row.locator('[data-sidebar-record-menu-trigger]').click();
      const trigger = sidebar.getByRole('button', { name: '폴더 이동', exact: true });
      if (keyboard) await trigger.press('ArrowRight');
      else await trigger.hover();
      const menu = sidebar.getByRole('menu', { name: '이동할 폴더', exact: true });
      await menu.waitFor();
      assert.equal(await menu.getByText('폴더 없음', { exact: true }).count(), 0);
      const current = (await readStored()).meetings.find(record => record.id === original.id);
      assert.equal(await menu.getByRole('menuitem', { name: '폴더에서 빼기', exact: true }).count(), current.folderId ? 1 : 0);
      const destinationRole = destination === '폴더에서 빼기' ? 'menuitem' : 'menuitemradio';
      if (keyboard) {
        await page.keyboard.press('ArrowLeft');
        await menu.waitFor({ state: 'detached' });
        assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
        await trigger.press('ArrowRight');
        await menu.waitFor();
        await page.keyboard.press('Escape');
        await menu.waitFor({ state: 'detached' });
        assert.equal(await trigger.evaluate(element => element === document.activeElement), true);
        await trigger.press('ArrowRight');
        await menu.waitFor();
        await page.keyboard.press('End');
        await page.keyboard.press('ArrowUp');
        await page.keyboard.press('Home');
        const names = await menu.locator('[role="menuitem"], [role="menuitemradio"]').allTextContents();
        const index = names.findIndex(name => name.trim() === destination);
        assert.ok(index >= 0);
        for (let i = 0; i < index; i += 1) await page.keyboard.press('ArrowDown');
        assert.equal(await menu.getByRole(destinationRole, { name: destination, exact: true }).evaluate(element => element === document.activeElement), true);
        await page.keyboard.press('Enter');
      } else {
        await menu.getByRole(destinationRole, { name: destination, exact: true }).click();
      }
      await sidebar.locator('[data-sidebar-record-menu]').waitFor({ state: 'detached' });
    };
    let stored = await readStored();
    const folderAId = stored.folders.find(folder => folder.name === '첫 폴더').id;
    // Let the folder refresh render while the meeting refresh is still pending.
    // The moved row must not receive focus before it disappears from the list.
    await page.evaluate(() => {
      const descriptor = Object.getOwnPropertyDescriptor(IDBTransaction.prototype, 'oncomplete');
      const gate = { active: false, held: [], folderCompletions: 0 };
      window.__folderMoveRefreshGate = gate;
      window.addEventListener('meetings:updated', () => { gate.active = true; }, { once: true });
      Object.defineProperty(IDBTransaction.prototype, 'oncomplete', {
        ...descriptor,
        set(handler) {
          descriptor.set.call(this, typeof handler !== 'function' ? handler : function (event) {
            const stores = Array.from(this.objectStoreNames);
            if (gate.active && this.mode === 'readonly' && stores.includes('meetings') && stores.includes('folders')) {
              gate.held.push(() => handler.call(this, event));
              return;
            }
            handler.call(this, event);
            if (gate.active && this.mode === 'readonly' && stores.length === 1 && stores[0] === 'folders') {
              gate.folderCompletions += 1;
            }
          });
        },
      });
      gate.release = () => {
        gate.active = false;
        Object.defineProperty(IDBTransaction.prototype, 'oncomplete', descriptor);
        gate.held.splice(0).forEach(complete => complete());
      };
    });
    await moveRecord('첫 폴더', true);
    await page.waitForFunction(() => window.__folderMoveRefreshGate.held.length > 0
      && window.__folderMoveRefreshGate.folderCompletions > 0);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await page.evaluate(() => window.__folderMoveRefreshGate.release());
    await recordButton.waitFor({ state: 'detached' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await otherButton.locator('xpath=..').locator('[data-sidebar-record-menu-trigger]')
      .evaluate(element => element === document.activeElement), true,
    'folder-first refresh restores focus to the remaining record after the moved row disappears');
    const firstMoved = (await readStored()).meetings.find(record => record.id === original.id);
    assert.equal(firstMoved.folderId, folderAId);
    await recordButton.waitFor({ state: 'detached' });
    assert.equal(await otherButton.isVisible(), true);
    await folderA.click();
    await recordButton.waitFor();
    await moveRecord('첫 폴더');
    assert.deepEqual((await readStored()).meetings.find(record => record.id === original.id), firstMoved, 'choosing the current folder does not rewrite the record');
    assert.equal(await otherButton.isVisible(), true);
    assert.equal(await recordButton.isVisible(), true);
    const folderB = await createFolder('두 번째 폴더');
    assert.equal(await folderA.getAttribute('aria-expanded'), 'true', 'creating a folder keeps other folders expanded');
    assert.equal(await folderB.getAttribute('aria-expanded'), 'false');
    assert.equal(await recordButton.isVisible(), true);
    assert.equal(await otherButton.isVisible(), true);

    stored = await readStored();
    const folderBId = stored.folders.find(folder => folder.name === '두 번째 폴더').id;
    await moveRecord('두 번째 폴더');
    await recordButton.waitFor({ state: 'detached' });
    await folderB.press('Enter');
    await recordButton.waitFor();
    await otherButton.waitFor();
    stored = await readStored();
    const moved = stored.meetings.find(record => record.id === original.id);
    const { folderId, folder_id: legacyFolderId, updatedAt, ...preserved } = moved;
    assert.equal(folderId, folderBId);
    assert.equal(legacyFolderId, undefined);
    assert.ok(updatedAt);
    assert.deepEqual(preserved, original, 'moving changes only the folder and timestamp');
    assert.deepEqual(stored.meetings.find(record => record.id === other.id), other);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await sidebar.getByRole('button', { name: '두 번째 폴더', exact: true }).click();
    await recordButton.waitFor();
    assert.equal(await otherButton.isVisible(), true);
    assert.deepEqual((await readStored()).meetings.find(record => record.id === original.id), moved);
    await moveRecord('폴더에서 빼기');
    await recordButton.waitFor();
    await otherButton.waitFor();
    assert.equal((await readStored()).meetings.find(record => record.id === original.id).folderId, undefined);
    const beforeFailedMove = (await readStored()).meetings;
    // Another window deletes the target after this window has loaded its folder options.
    await page.evaluate(id => new Promise((resolve, reject) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('folders', 'readwrite');
        transaction.objectStore('folders').delete(id);
        transaction.oncomplete = () => { db.close(); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    }), folderBId);
    const failedMoveAlert = new Promise((resolve, reject) => page.once('dialog', async dialog => {
      try {
        assert.equal(dialog.type(), 'alert');
        assert.match(dialog.message(), /회의록 폴더를 변경하지 못했습니다/);
        await dialog.accept();
        resolve();
      } catch (error) { reject(error); }
    }));
    await moveRecord('두 번째 폴더');
    await failedMoveAlert;
    assert.deepEqual((await readStored()).meetings, beforeFailedMove, 'a failed move preserves all records');
    assert.equal(await recordButton.isVisible(), true);
    // A short desktop window and many folders must keep the last destination reachable.
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction('folders', 'readwrite');
        for (let index = 0; index < 24; index += 1) {
          transaction.objectStore('folders').put({ id: `long-folder-${index}`, name: `추가 폴더 ${index}`, sortOrder: index + 10 });
        }
        transaction.oncomplete = () => {
          db.close();
          window.dispatchEvent(new Event('meetings:updated'));
          resolve();
        };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    }));
    await page.setViewportSize({ width: 760, height: 480 });
    await sidebar.getByRole('button', { name: '추가 폴더 23', exact: true }).waitFor();
    const row = recordButton.locator('xpath=..');
    await row.hover();
    await row.locator('[data-sidebar-record-menu-trigger]').click();
    await sidebar.getByRole('button', { name: '폴더 이동', exact: true }).press('ArrowRight');
    const longMenu = sidebar.getByRole('menu', { name: '이동할 폴더', exact: true });
    await longMenu.waitFor();
    const bounds = await longMenu.evaluate(element => {
      const rect = element.getBoundingClientRect();
      return { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, scrollable: element.scrollHeight > element.clientHeight };
    });
    assert.ok(bounds.top >= 0 && bounds.left >= 0 && bounds.right <= 760 && bounds.bottom <= 480);
    assert.equal(bounds.scrollable, true);
    await page.keyboard.press('End');
    assert.equal(await longMenu.getByRole('menuitemradio', { name: '추가 폴더 23', exact: true }).evaluate(element => element === document.activeElement), true);
    await page.keyboard.press('Enter');
    await sidebar.locator('[data-sidebar-record-menu]').waitFor({ state: 'detached' });
    assert.equal((await readStored()).meetings.find(record => record.id === original.id).folderId, 'long-folder-23');
    await assertNoHorizontalOverflow(page);
    console.log('ok - folder expansion, movement, reopen and removal preserve unfiled records and stored content');
  } finally {
    await context.close();
  }
};

const runFolderPaginationFlow = async browser => {
  const context = await browser.newContext({ viewport: { width: 760, height: 480 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const sidebar = page.locator('.barorok-navigation');
    await sidebar.getByRole('button', { name: '폴더 만들기', exact: true }).waitFor();
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['meetings', 'folders'], 'readwrite');
        for (const [id, name, count] of [['page-a', '첫 묶음', 12], ['page-b', '둘째 묶음', 7], ['page-empty', '빈 폴더', 0], [null, '', 11]]) {
          if (id) transaction.objectStore('folders').put({ id, name });
          for (let index = 1; index <= count; index += 1) {
            transaction.objectStore('meetings').put({
              id: `${id ?? 'unfiled'}-${index}`, title: `${name || '폴더 없는'} 회의 ${index}`,
              date: '2026-10-19T09:00:00', summary: '', segments: [],
              ...(id ? { folderId: id } : {}),
            });
          }
        }
        transaction.oncomplete = () => { db.close(); window.dispatchEvent(new Event('meetings:updated')); resolve(); };
        transaction.onerror = () => { db.close(); reject(transaction.error); };
      };
    }));
    const folderA = sidebar.getByRole('button', { name: '첫 묶음', exact: true });
    const folderB = sidebar.getByRole('button', { name: '둘째 묶음', exact: true });
    const groupA = sidebar.getByRole('group', { name: '첫 묶음 회의록', exact: true });
    const groupB = sidebar.getByRole('group', { name: '둘째 묶음 회의록', exact: true });
    const unfiled = sidebar.locator('[data-sidebar-records] .sidebar-record-row');
    await folderA.waitFor();
    assert.equal(await sidebar.locator('[data-sidebar-records] .sidebar-record-row').count(), 11);
    assert.equal(await sidebar.locator('.sidebar-folder-records .sidebar-record-row').count(), 0);
    const settingsTop = await sidebar.getByRole('button', { name: '설정', exact: true }).evaluate(element => element.getBoundingClientRect().top);
    await folderA.press('Enter');
    await groupA.locator('.sidebar-record-row').nth(4).waitFor();
    assert.equal(await groupA.locator('.sidebar-record-row').count(), 5);
    await folderB.click();
    assert.equal(await groupB.locator('.sidebar-record-row').count(), 5);
    await groupA.getByRole('button', { name: '더 보기', exact: true }).click();
    assert.equal(await groupA.locator('.sidebar-record-row').count(), 10);
    assert.equal(await groupB.locator('.sidebar-record-row').count(), 5);
    await groupA.getByRole('button', { name: '더 보기', exact: true }).press('Enter');
    assert.equal(await groupA.locator('.sidebar-record-row').count(), 12);
    assert.equal(await groupA.getByRole('button', { name: '더 보기', exact: true }).count(), 0);
    assert.equal(await groupA.locator('.sidebar-record-row').nth(10).locator('button').first().evaluate(element => element === document.activeElement), true);
    await groupB.getByRole('button', { name: '더 보기', exact: true }).click();
    assert.equal(await groupB.locator('.sidebar-record-row').count(), 7);
    assert.equal(await groupB.getByRole('button', { name: '더 보기', exact: true }).count(), 0);
    await folderA.click();
    assert.equal(await groupA.count(), 0);
    assert.equal(await groupB.locator('.sidebar-record-row').count(), 7);
    await folderA.click();
    assert.equal(await groupA.locator('.sidebar-record-row').count(), 12);
    await sidebar.getByRole('button', { name: '빈 폴더', exact: true }).click();
    await sidebar.getByRole('group', { name: '빈 폴더 회의록', exact: true }).getByText('회의록이 없습니다.', { exact: true }).waitFor();
    assert.equal(await unfiled.count(), 11);
    const scroll = sidebar.locator('.sidebar-content-scroll');
    assert.equal(await scroll.evaluate(element => element.scrollHeight > element.clientHeight && getComputedStyle(element).overflowY === 'auto'), true);
    await unfiled.last().scrollIntoViewIfNeeded();
    assert.equal(await scroll.evaluate(element => element.scrollTop > 0), true);
    assert.equal(await sidebar.getByRole('button', { name: '설정', exact: true }).evaluate(element => element.getBoundingClientRect().top), settingsTop);
    await assertNoHorizontalOverflow(page);
    console.log('ok - folders expand independently, reveal 5/10/12 and 5/7 records, preserve unfiled list and scroll above fixed settings');
  } finally {
    await context.close();
  }
};

const server = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  if (!process.env.ARCHIVE_FLOW_SCENARIO || process.env.ARCHIVE_FLOW_SCENARIO === 'folders') {
    await runFolderFlow(browser);
    await runFolderPaginationFlow(browser);
  }
  if (!process.env.ARCHIVE_FLOW_SCENARIO || process.env.ARCHIVE_FLOW_SCENARIO === 'archive') {
    await runArchiveFlow(browser);
    await runEmptyArchive(browser);
  }
} finally {
  await browser.close();
  await stopServer(server);
}
