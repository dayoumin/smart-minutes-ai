import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const shouldStartServer = !process.env.APP_URL;
const PAGE_GOTO_TIMEOUT_MS = 60000;
const meetingId = 'codex-download-scope-flow';
const jobId = 'codex-download-scope-job';

const waitForApp = async (url, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until Vite is ready.
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

const stopServer = async (child) => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `taskkill /pid ${child.pid} /t /f`],
        { stdio: 'ignore', windowsHide: true },
      );
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(2000),
  ]);
};

const startServer = async () => {
  if (!shouldStartServer) {
    await waitForApp(APP_URL);
    return null;
  }

  const url = new URL(APP_URL);
  const port = await getAvailablePort(url.hostname);
  url.port = String(port);
  APP_URL = url.toString();
  const command = `corepack pnpm exec vite --host ${url.hostname} --port ${url.port} --strictPort --configLoader runner`;
  const child = process.platform === 'win32'
    ? spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', command],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, BROWSER: 'none' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    : spawn(
      'corepack',
      ['pnpm', 'exec', 'vite', '--host', url.hostname, '--port', url.port, '--strictPort', '--configLoader', 'runner'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, BROWSER: 'none' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

  if (process.env.DEBUG_FLOW_TEST) {
    child.stdout.on('data', data => process.stdout.write(data));
    child.stderr.on('data', data => process.stderr.write(data));
  }
  await waitForApp(APP_URL);
  return child;
};

const installRoutes = async (page, exportCalls, exportBodies) => {
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      summary: { enabled: true, model: 'gemma4:e2b' },
      diarization: { enabled: false },
      privacy: {},
    }),
  }));
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));
  await page.route('**/api/models/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ready: true,
      summary_ready: true,
      summary_status: 'ready',
      summary_message: '',
      models: [],
    }),
  }));
  await page.route('**/api/outputs/**/generation-progress/**', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ active: false, progress: 0, status: '' }),
  }));
  await page.route('**/api/outputs/**/audio', route => route.fulfill({ status: 404, body: '' }));

  for (const format of ['hwpx', 'txt']) {
    await page.route(`**/api/export-record/${format}/save-copy`, async route => {
      exportCalls.push(`${format}:save-copy`);
      exportBodies.push(JSON.parse(route.request().postData() ?? '{}'));
      if (format === 'txt') await sleep(1900);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: format,
          saved_path: `C:\\Users\\User\\Downloads\\download-scope.${format}`,
          size_bytes: 16,
        }),
      });
    });
  }
};

const seedMeeting = async (page) => {
  await page.evaluate(async ({ meetingId, jobId }) => {
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('meetings')) {
          database.createObjectStore('meetings', { keyPath: 'id' });
        }
        if (!database.objectStoreNames.contains('folders')) {
          database.createObjectStore('folders', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      const store = tx.objectStore('meetings');
      store.clear();
      store.put({
        id: meetingId,
        jobId,
        date: '2026-06-12 10:00',
        title: '다운로드 범위 회의록',
        summary: '기록 정리 저장 범위를 확인합니다.',
        participants: '참석자01, 참석자02',
        meetingPurpose: '다운로드 범위 분리 확인',
        sourceFile: 'download-scope.mp4',
        topics: ['다운로드 범위'],
        topicSections: [
          {
            topic: '다운로드 범위',
            summary: '대화록과 기록 정리 저장을 분리합니다.',
            evidence: ['각 탭에서 저장 버튼을 제공합니다.'],
            actions: ['저장 피드백 확인'],
          },
        ],
        speakerContextSummaries: [
          {
            speaker: 'SPEAKER_00',
            display_name: '참석자01',
            summary: '저장 범위 분리를 제안했습니다.',
            key_points: ['탭별 저장'],
            actions: [],
          },
        ],
        generationStatus: {
          summary: 'completed',
          topicSections: 'completed',
          speakerContextSummaries: 'completed',
          meetingReport: 'completed',
        },
        selectedReportTemplateId: 'standard-minutes',
        reportTemplate: {
          id: 'standard-minutes',
          name: '기본 보고서',
          purpose: '보고서 저장 범위 확인',
          sections: ['검토 배경', '후속 조치'],
        },
        meetingReport: {
          templateId: 'standard-minutes',
          generatedAt: '2026-06-12T10:10:00',
          content: '보고서 저장은 보고서 탭에서 분리해야 합니다.',
          sections: [
            { title: '검토 배경', content: '보고서 전용 배경입니다.' },
            { title: '후속 조치', content: '보고서 전용 조치입니다.' },
          ],
        },
        speakerLabels: { SPEAKER_00: '참석자01', SPEAKER_01: '참석자02' },
        segments: [
          {
            start: '00:00:01',
            end: '00:00:05',
            speaker: 'SPEAKER_00',
            displaySpeaker: '참석자01',
            text: '기록 정리 저장은 대화록과 분리해야 합니다.',
          },
          {
            start: '00:00:06',
            end: '00:00:09',
            speaker: 'SPEAKER_01',
            displaySpeaker: '참석자02',
            text: '대화록 저장 버튼도 필요합니다.',
          },
        ],
        editedDisplaySegments: [],
        actions: ['저장 피드백 확인'],
        decisions: ['탭별 저장을 둡니다.'],
        needsCheck: [],
      });
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { meetingId, jobId });
};

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;
  const exportCalls = [];
  const exportBodies = [];

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    await installRoutes(page, exportCalls, exportBodies);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    await seedMeeting(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await page.getByText('다운로드 범위 회의록').first().click();
    await page.waitForFunction(() => document.body.innerText.includes('기록 정리 저장은 대화록과 분리해야 합니다.'), null, { timeout: 10000 });

    await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
    await page.getByRole('button', { name: '기록 정리 HWPX 파일을 다운로드 폴더에 저장' }).click();
    const organizedSaveButton = page.locator('button.detail-download-button').first();
    const filenameEditor = page.locator('.detail-download-popover');
    const filenameInput = filenameEditor.locator('input');
    await filenameInput.waitFor({ timeout: 10000 });
    await page.waitForFunction(element => document.activeElement === element, await filenameInput.elementHandle());
    assert.equal(await filenameInput.evaluate(element => document.activeElement === element), true);
    assert.equal(await organizedSaveButton.getAttribute('aria-controls'), await filenameEditor.getAttribute('id'));
    const selection = await filenameInput.evaluate(element => ({
      start: element.selectionStart,
      end: element.selectionEnd,
      length: element.value.length,
    }));
    assert.equal(selection.start, 0);
    assert.equal(selection.end, selection.length);
    await filenameInput.press('Escape');
    await filenameEditor.waitFor({ state: 'detached' });
    await page.waitForFunction(element => document.activeElement === element, await organizedSaveButton.elementHandle());
    assert.equal(await organizedSaveButton.evaluate(element => document.activeElement === element), true);

    await organizedSaveButton.press('Enter');
    await filenameInput.waitFor({ timeout: 10000 });
    await filenameInput.fill(' custom:/export?name. ');
    await filenameInput.dispatchEvent('keydown', {
      key: 'Enter',
      code: 'Enter',
      isComposing: true,
      bubbles: true,
      cancelable: true,
    });
    await sleep(100);
    assert.equal(exportCalls.length, 0);
    await filenameInput.press('Enter');
    await page.waitForFunction(element => element.querySelector('svg')?.classList.contains('lucide-check'), await organizedSaveButton.elementHandle());
    for (let attempt = 0; attempt < 50 && exportCalls.length < 1; attempt += 1) {
      await sleep(100);
    }
    await page.waitForFunction(element => document.activeElement === element, await organizedSaveButton.elementHandle());
    assert.equal(await organizedSaveButton.evaluate(element => document.activeElement === element), true);

    await page.getByRole('tab', { name: '대화록', exact: true }).click();
    const transcriptSaveButton = page.locator('button.detail-download-button').first();
    await transcriptSaveButton.waitFor({ timeout: 10000 });
    await transcriptSaveButton.click();
    await filenameInput.waitFor({ timeout: 10000 });
    const activeTab = page.locator('[role="tab"][aria-selected="true"]');
    await activeTab.click();
    await filenameEditor.waitFor({ state: 'detached' });
    assert.equal(await activeTab.evaluate(element => document.activeElement === element), true);

    await transcriptSaveButton.click();
    await filenameInput.fill('custom-export-name');
    await page.locator('.detail-download-popover-actions button').last().click();
    await page.waitForFunction(element => element.querySelector('svg')?.classList.contains('animate-spin'), await transcriptSaveButton.elementHandle());
    await sleep(1700);
    assert.equal(await transcriptSaveButton.locator('svg.animate-spin').count(), 1);
    for (let attempt = 0; attempt < 50 && exportCalls.length < 2; attempt += 1) {
      await sleep(100);
    }
    await page.waitForFunction(element => document.activeElement === element, await transcriptSaveButton.elementHandle());
    await page.waitForFunction(element => element.querySelector('svg')?.classList.contains('lucide-check'), await transcriptSaveButton.elementHandle());
    assert.equal(await transcriptSaveButton.evaluate(element => document.activeElement === element), true);

    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    const reportSaveButton = page.locator('button.detail-download-button').first();
    await reportSaveButton.waitFor({ timeout: 10000 });
    await reportSaveButton.click();
    await page.locator('[role="dialog"] input').fill('custom-export-name');
    await page.locator('[role="dialog"] button').last().click();
    for (let attempt = 0; attempt < 50 && exportCalls.length < 3; attempt += 1) {
      await sleep(100);
    }

    assert.deepEqual(exportCalls, ['hwpx:save-copy', 'txt:save-copy', 'hwpx:save-copy']);
    assert.deepEqual(exportBodies.map(body => body.downloadFilename), ['custom--export-name', 'custom-export-name', 'custom-export-name']);
    assert.equal(exportBodies[0].exportScope, 'organized');
    assert.match(exportBodies[0].title, /_기록정리$/);
    assert.equal(exportBodies[1].exportScope, 'transcript');
    assert.match(exportBodies[1].title, /_대화록$/);
    assert.equal(exportBodies[1].displaySegments[0].text, '기록 정리 저장은 대화록과 분리해야 합니다.');
    assert.equal(exportBodies[2].exportScope, 'report');
    assert.match(exportBodies[2].title, /_보고서$/);
    assert.equal(exportBodies[2].meetingReport.sections[0].content, '보고서 전용 배경입니다.');

    console.log('ok - download scope flow simulation');
  } catch (error) {
    console.error(error);
    if (page) {
      console.error('body:', (await page.locator('body').innerText()).slice(0, 2000));
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
