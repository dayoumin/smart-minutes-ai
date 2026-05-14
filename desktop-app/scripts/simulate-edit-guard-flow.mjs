import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const shouldStartServer = !process.env.APP_URL;
const meetingId = 'codex-edit-guard-simulation';
const jobId = 'codex-edit-guard-job';
const staleSummaryMessage = '정리 중에 대화록이 바뀌어 이번 결과는 저장하지 않았습니다. 다시 정리해 주세요.';
const guardMessage = '저장되지 않은 변경이 있습니다. 정리 실행 전에 변경 내용을 저장하거나 취소해 주세요.';
const downloadGuardMessage = '저장되지 않은 변경이 있습니다. 파일 저장 전에 변경 내용을 저장하거나 취소해 주세요.';

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
  if (!shouldStartServer) return null;

  try {
    await waitForApp(APP_URL, 1000);
    return null;
  } catch {
    // Start a local Vite server when the app is not already available.
  }

  const url = new URL(APP_URL);
  const command = `corepack pnpm exec vite --host ${url.hostname} --port ${url.port || '5173'}`;
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
      ['pnpm', 'exec', 'vite', '--host', url.hostname, '--port', url.port || '5173'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, BROWSER: 'none' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    );

  child.stdout.on('data', data => {
    if (process.env.DEBUG_FLOW_TEST) process.stdout.write(data);
  });
  child.stderr.on('data', data => {
    if (process.env.DEBUG_FLOW_TEST) process.stderr.write(data);
  });

  await waitForApp(APP_URL);
  return child;
};

const seedMeeting = async (page) => {
  await page.evaluate(async ({ meetingId, jobId }) => {
    const request = indexedDB.open('MeetingHistoryDB', 1);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) {
          db.createObjectStore('meetings', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const meeting = {
      id: meetingId,
      jobId,
      date: '2026-05-07 23:55',
      title: '수정본 가드 시뮬레이션',
      summary: '기본 요약입니다.',
      participants: '화자1',
      sourceFile: 'simulation.mp4',
      topics: [],
      topicSections: [],
      speakerContextSummaries: [],
      generationStatus: { summary: 'completed', topicSections: 'not_started', speakerContextSummaries: 'not_started' },
      segments: [
        {
          start: '00:00:01',
          end: '00:00:08',
          speaker: '화자1',
          text: '처음 생성된 대화록입니다.',
        },
      ],
      actions: [],
      decisions: [],
      needsCheck: [],
      speakerLabels: {},
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      tx.objectStore('meetings').put(meeting);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { meetingId, jobId });
};

const installRoutes = async (page, apiCalls) => {
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));

  await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
  }));

  await page.route(`**/api/outputs/${jobId}/sync-record`, async route => {
    const body = JSON.parse(route.request().postData() ?? '{}');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        outputs: body.outputFiles ?? {},
        export_error: null,
      }),
    });
  });

  await page.route(`**/api/outputs/${jobId}/generate-summary`, route => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'summary_input_changed' }),
  }));

  await page.route('**/api/export-record/**', route => {
    apiCalls.push(`UNEXPECTED_EXPORT ${route.request().url()}`);
    return route.fulfill({
      status: 500,
      contentType: 'text/plain; charset=utf-8',
      body: 'download should have been blocked',
    });
  });
};

const run = async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const apiCalls = [];
  page.on('request', request => {
    if (request.url().includes('/api/')) {
      apiCalls.push(`${request.method()} ${request.url()}`);
    }
  });

  try {
    await installRoutes(page, apiCalls);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await seedMeeting(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('수정본 가드 시뮬레이션').first().click();

    await page.getByRole('tab', { name: '대화록' }).click();
    await page.getByRole('button', { name: '대화록 편집' }).click();
    await page.getByLabel('화자1 대화록 수정').fill('사용자가 수정 중인 대화록입니다.');

    await page.getByRole('tab', { name: '회의 요약' }).click();
    await page.getByRole('button', { name: '전체 요약 다시 정리' }).click();
    await page.getByText(guardMessage).waitFor({ timeout: 10000 });

    await page.getByRole('button', { name: '회의록 HWPX 저장' }).click();
    await page.getByText(downloadGuardMessage).waitFor({ timeout: 10000 });
    assert.equal(
      apiCalls.some(call => call.includes('/api/export-record/')),
      false,
      `download API should be blocked before request: ${apiCalls.join('\n')}`,
    );

    await page.getByRole('tab', { name: '대화록' }).click();
    await page.getByRole('button', { name: '수정본 저장' }).click();
    await page.getByText('대화록 수정본을 저장했습니다.').waitFor({ timeout: 10000 });

    await page.getByRole('tab', { name: '회의 요약' }).click();
    await page.getByRole('button', { name: '전체 요약 다시 정리' }).click();
    await page.getByText(staleSummaryMessage).waitFor({ timeout: 10000 });
    await page.getByText('정리 전').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '전체 요약 정리' }).waitFor({ timeout: 10000 });

    console.log('ok - edit guard and stale summary flow simulation');
  } catch (error) {
    console.error(error);
    console.error('api calls:', apiCalls);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 3000));
    throw error;
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
