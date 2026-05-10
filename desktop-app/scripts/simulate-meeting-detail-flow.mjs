import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const shouldStartServer = !process.env.APP_URL;
const meetingId = 'codex-detail-flow-simulation';
const jobId = 'codex-detail-flow-job';
const formats = ['hwpx', 'md', 'txt', 'docx'];

const contentTypeByFormat = {
  hwpx: 'application/hwp+zip',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

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

const startServer = async () => {
  if (!shouldStartServer) return null;

  try {
    await waitForApp(APP_URL, 1000);
    return null;
  } catch {
    // Start a local Vite server when the app is not already available.
  }

  const url = new URL(APP_URL);
  const child = spawn(
    'pnpm',
    ['dev', '--', '--host', url.hostname, '--port', url.port || '5173'],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      shell: true,
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
      title: '시뮬레이션 회의록',
      summary: '기본 회의 요약입니다.',
      participants: '화자1, 화자2',
      sourceFile: 'simulation.mp4',
      topics: [],
      topicSections: [],
      speakerContextSummaries: [],
      generationStatus: { topicSections: 'not_started', speakerContextSummaries: 'not_started' },
      segments: [
        {
          start: '00:00:01',
          end: '00:00:08',
          speaker: '화자1',
          text: 'AI 시스템 통제권과 지식 확장을 논의했습니다.',
        },
      ],
      actions: [],
      decisions: [],
      needsCheck: [],
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

const installRoutes = async (page) => {
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));

  await page.route('**/api/dev/asr-benchmarks**', route => {
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
    });
  });

  await page.route(`**/api/outputs/${jobId}/generate-topic-sections`, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      topics: ['AI 시스템 통제권'],
      topic_sections: [
        {
          topic: 'AI 시스템 통제권',
          summary: 'AI 시스템 통제권과 지식 확장 방향을 정리했습니다.',
          evidence: ['화자1이 시스템 통제권을 언급했습니다.'],
          actions: ['보안 보완 방안 확인'],
        },
      ],
      generation_status: { topic_sections: 'completed', speaker_context_summaries: 'not_started' },
      outputs: {},
    }),
  }));

  await page.route(`**/api/outputs/${jobId}/generate-speaker-context`, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      speaker_context_summaries: [
        {
          speaker: 'SPEAKER_00',
          display_name: '화자1',
          role_in_meeting: '주요 의견 제안자',
          summary: 'AI 시스템 통제권과 지식 확장에 대한 핵심 의견을 제시했습니다.',
          key_points: ['통제권 이동 방식 검토'],
          actions: ['보안 보완 방안 확인'],
          needs_check: ['실제 담당자 이름 확인'],
        },
      ],
      participant_summaries: [
        {
          participant: '화자1',
          summary: 'AI 시스템 통제권과 지식 확장에 대한 핵심 의견을 제시했습니다.',
          key_points: ['통제권 이동 방식 검토'],
          actions: ['보안 보완 방안 확인'],
        },
      ],
      generation_status: { topic_sections: 'completed', speaker_context_summaries: 'completed' },
      outputs: {},
    }),
  }));
};

const run = async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const exportCalls = [];
  const apiCalls = [];
  page.on('request', request => {
    if (request.url().includes('/api/')) {
      apiCalls.push(`${request.method()} ${request.url()}`);
    }
  });

  try {
    await installRoutes(page);
    for (const format of formats) {
      await page.route(`**/api/export-record/${format}`, route => {
        exportCalls.push(format);
        return route.fulfill({
          status: 200,
          contentType: contentTypeByFormat[format],
          headers: { 'content-disposition': `attachment; filename="simulation.${format}"` },
          body: `simulation ${format}`,
        });
      });
    }

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await seedMeeting(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('시뮬레이션 회의록').first().click();

    await page.getByText('주제별 정리 후 사용').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.detail-action-button').nth(1).isDisabled(), true);

    await page.locator('.detail-action-button').nth(0).click();
    await page.getByText('AI 시스템 통제권과 지식 확장 방향을 정리했습니다.').waitFor({ timeout: 10000 });
    await page.getByText('생성 가능').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.detail-action-button').nth(1).isDisabled(), false);

    await page.locator('.detail-action-button').nth(1).click();
    await page.getByText('AI 시스템 통제권과 지식 확장에 대한 핵심 의견을 제시했습니다.').waitFor({ timeout: 10000 });

    const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
    await page.locator('button[aria-label*="HWPX"]').first().click();
    const download = await downloadPromise;

    assert.deepEqual(exportCalls, ['hwpx']);
    assert.equal(download.suggestedFilename(), '시뮬레이션 회의록.hwpx');
    console.log('ok - meeting detail flow simulation');
  } catch (error) {
    console.error(error);
    console.error('api calls:', apiCalls);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 2000));
    throw error;
  } finally {
    await browser.close();
    if (server) {
      server.kill();
    }
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
