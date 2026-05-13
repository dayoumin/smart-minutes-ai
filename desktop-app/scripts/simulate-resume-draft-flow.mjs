import assert from 'node:assert/strict';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
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
    // Start local Vite server.
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

  await waitForApp(APP_URL);
  return child;
};

const installBaseRoutes = async (page) => {
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
      models: [
        { key: 'stt_faster_whisper', label: '음성 인식 기본 모델', installed: true, required: true },
      ],
    }),
  }));

  await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
  }));
};

const createFixtureFile = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-minutes-resume-draft-'));
  const filePath = join(dir, 'resume-draft-target.mp4');
  await writeFile(filePath, Buffer.alloc(25, 7));
  const fileStat = await stat(filePath);
  return {
    path: filePath,
    name: 'resume-draft-target.mp4',
    size: fileStat.size,
    lastModified: Math.trunc(fileStat.mtimeMs),
  };
};

const runResumeDraftScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let analyzeRequestSnapshot = null;
  let resumeCandidatesCalled = false;

  const drafts = [{
    jobId: 'draft-job-001',
    title: '중단된 회의',
    date: '2026-05-13T09:30',
    participants: '홍길동, 김철수',
    sourceFilename: 'resume-draft-target.mp4',
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-13T09:30:00.000Z',
    updatedAt: '2026-05-13T09:45:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 2/4...',
    lastProgress: 45,
  }, {
    jobId: 'draft-job-older',
    title: '예전 실패 분석',
    date: '2026-05-13T08:00',
    participants: '홍길동',
    sourceFilename: 'resume-draft-target.mp4',
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'failed',
    createdAt: '2026-05-13T08:00:00.000Z',
    updatedAt: '2026-05-13T08:15:00.000Z',
    stage: 'failed',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 20,
    errorMessage: '이전 오류',
  }];

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify(value));
  }, drafts);

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [
        {
          job_id: 'draft-job-001',
          status: 'cancelled',
          stage: 'cancelled',
          updated_at: '2026-05-13T09:45:00.000Z',
          resume_supported: true,
          completed_chunk_count: 2,
          last_progress: {
            message: 'Transcribing chunk 2/4...',
            progress: 45,
            status: 'cancelled',
          },
        },
        {
          job_id: 'draft-job-older',
          status: 'failed',
          stage: 'failed',
          updated_at: '2026-05-13T08:15:00.000Z',
          resume_supported: true,
          completed_chunk_count: 1,
          last_progress: {
            message: 'Transcribing chunk 1/4...',
            progress: 20,
            status: 'failed',
          },
          last_error: '이전 오류',
        },
      ],
    }),
  }));
  await page.route('**/api/analyze/resume-candidates', route => {
    resumeCandidatesCalled = true;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        recommended_job_id: 'draft-job-001',
        candidates: [
          {
            job_id: 'draft-job-001',
            stage: 'transcribing',
            updated_at: '2026-05-13T10:10:00',
            resume_supported: true,
            active: false,
            chunk_count: 4,
            completed_chunk_count: 3,
            last_progress: {
              message: 'Transcribing chunk 3/4...',
              progress: 70,
              status: 'processing',
            },
          },
        ],
      }),
    });
  });

  await page.route('**/api/analyze', async route => {
    const postData = await route.request().postDataBuffer();
    analyzeRequestSnapshot = postData.toString('utf-8');
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        'event: progress',
        'data: {"type":"progress","progress":5,"message":"업로드 파일 저장 완료","status":"processing"}',
        '',
        'event: result',
        'data: {"type":"result","progress":100,"status":"completed","summary":"resume draft summary","segments":[],"meeting":{"source_file":"resume-draft-target.mp4","job_id":"draft-job-001"},"outputs":{"job_id":"draft-job-001","json":"/api/outputs/draft-job-001/json","txt":"/api/outputs/draft-job-001/txt","md":null,"docx":null,"hwpx":null},"resume":{"requested":true,"mode":"reused_stt","message":"이전 음성 인식 진행분을 재사용했습니다.","reused_chunk_count":3}}',
        '',
        'event: done',
        'data: [DONE]',
        '',
      ].join('\n'),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const resumeCard = page.locator('.resume-draft-card').filter({ hasText: '중단된 회의' }).first();
    await resumeCard.getByRole('button', { name: '이어하기' }).click();
    await expectValue(page, '#meeting-title', '중단된 회의');
    await expectValue(page, '#meeting-participants', '홍길동, 김철수');
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByRole('button', { name: '이어하기' }).last().click();
    await page.getByText('이전 음성 인식 진행분 3개 구간을 재사용했습니다.').waitFor({ timeout: 10000 });
    assert.equal(resumeCandidatesCalled, true);
    assert.match(analyzeRequestSnapshot ?? '', /name="job_id"\r\n\r\ndraft-job-001/);
    assert.match(analyzeRequestSnapshot ?? '', /name="resume_requested"\r\n\r\ntrue/);
    const storedDrafts = await page.evaluate(() => window.localStorage.getItem('analysisResumeDrafts'));
    const parsedDrafts = JSON.parse(storedDrafts ?? '[]');
    assert.equal(parsedDrafts.length, 2);
    assert.equal(parsedDrafts.every(draft => draft.status === 'completed'), true);
    assert.equal(parsedDrafts.every(draft => draft.resumeUnavailableReason === 'completed'), true);
    console.log('ok - resume draft flow simulation');
  } catch (error) {
    console.error(error);
    console.error('analyzeRequestSnapshot:', analyzeRequestSnapshot);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runActiveDraftBackendSyncScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const drafts = [{
    jobId: 'active-draft-job-001',
    title: '진행 중이던 분석',
    date: '2026-05-13T09:30',
    participants: '홍길동',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'active',
    createdAt: '2026-05-13T09:30:00.000Z',
    updatedAt: '2026-05-13T09:45:00.000Z',
    stage: 'transcribing',
    lastMessage: 'Transcribing chunk 2/4...',
    lastProgress: 45,
  }];

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify(value));
  }, drafts);

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [
        {
          job_id: 'active-draft-job-001',
          status: 'completed',
          stage: 'completed',
          active: false,
          resume_supported: true,
        },
      ],
    }),
  }));

  try {
    await waitForApp(APP_URL);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(800);
    await page.getByText('정리됨').waitFor({ timeout: 10000 });
    const storedDrafts = await page.evaluate(() => window.localStorage.getItem('analysisResumeDrafts'));
    const parsedDrafts = JSON.parse(storedDrafts ?? '[]');
    assert.equal(parsedDrafts.length, 1);
    assert.equal(parsedDrafts[0].status, 'completed');
    assert.equal(parsedDrafts[0].resumeUnavailableReason, 'completed');
    await expectNoText(page, '진행 중이던 분석 기록');
    console.log('ok - active draft backend sync scenario');
  } finally {
    await context.close();
  }
};

const runInvalidResumeDraftScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let analyzeCalled = false;

  const draft = {
    jobId: 'stale-draft-job-001',
    title: '오래된 분석',
    date: '2026-05-13T09:30',
    participants: '홍길동',
    sourceFilename: 'resume-draft-target.mp4',
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'failed',
    createdAt: '2026-05-13T09:30:00.000Z',
    updatedAt: '2026-05-13T09:45:00.000Z',
    stage: 'failed',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 20,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [
        {
          job_id: 'stale-draft-job-001',
          status: 'failed',
          stage: 'failed',
          updated_at: '2026-05-13T09:45:00.000Z',
          resume_supported: true,
          completed_chunk_count: 1,
          last_progress: {
            message: 'Transcribing chunk 1/4...',
            progress: 20,
            status: 'failed',
          },
        },
      ],
    }),
  }));
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [], recommended_job_id: null }),
  }));
  await page.route('**/api/analyze', route => {
    analyzeCalled = true;
    return route.abort();
  });

    try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '이어하기' }).click();
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByRole('button', { name: '이어하기' }).last().click();
    await page.getByText('이전 분석 기록을 이어서 진행할 수 없습니다. 현재 재사용 후보로 확인되지 않았습니다. 새 분석으로 시작할 수 있습니다.').waitFor({ timeout: 10000 });
    await page.getByText('이어하기 불가').first().waitFor({ timeout: 10000 });
    assert.equal(analyzeCalled, false);
    const storedDrafts = await page.evaluate(() => window.localStorage.getItem('analysisResumeDrafts'));
    const parsedDrafts = JSON.parse(storedDrafts ?? '[]');
    assert.equal(parsedDrafts.length, 1);
    assert.equal(parsedDrafts[0].status, 'unavailable');
    assert.equal(parsedDrafts[0].resumeUnavailableReason, 'not-candidate');
    console.log('ok - invalid resume draft scenario');
  } finally {
    await context.close();
  }
};

const runSuppressedResumeCandidateScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let analyzeRequestSnapshot = null;
  let dialogShown = false;

  const suppressedKey = `${fixtureUpload.name}::${fixtureUpload.size}::${fixtureUpload.lastModified}`;

  await context.addInitScript(value => {
    window.localStorage.setItem('suppressedResumeCandidateKeys', JSON.stringify([value]));
    window.localStorage.setItem('analysisResumeDrafts', '[]');
  }, suppressedKey);

  page.on('dialog', async dialog => {
    dialogShown = true;
    await dialog.dismiss();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      recommended_job_id: 'suppressed-job-001',
      candidates: [
        {
          job_id: 'suppressed-job-001',
          stage: 'transcribing',
          updated_at: '2026-05-13T10:10:00',
          resume_supported: true,
          active: false,
          chunk_count: 4,
          completed_chunk_count: 2,
          last_progress: {
            message: 'Transcribing chunk 2/4...',
            progress: 55,
            status: 'processing',
          },
        },
      ],
    }),
  }));

  await page.route('**/api/analyze', async route => {
    const postData = await route.request().postDataBuffer();
    analyzeRequestSnapshot = postData.toString('utf-8');
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        'event: progress',
        'data: {"type":"progress","progress":5,"message":"업로드 파일 저장 완료","status":"processing"}',
        '',
        'event: result',
        'data: {"type":"result","progress":100,"status":"completed","summary":"fresh summary","segments":[],"meeting":{"source_file":"resume-draft-target.mp4","job_id":"fresh-job-001"},"outputs":{"job_id":"fresh-job-001","json":"/api/outputs/fresh-job-001/json","txt":"/api/outputs/fresh-job-001/txt","md":null,"docx":null,"hwpx":null},"resume":{"requested":false,"mode":"fresh_start","message":"","reused_chunk_count":0}}',
        '',
        'event: done',
        'data: [DONE]',
        '',
      ].join('\n'),
    });
  });

  try {
    await waitForApp(APP_URL);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('회의 제목 *').fill('suppressed resume candidate');
    await page.getByLabel('참석자 *').fill('홍길동');
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByRole('button', { name: '분석 시작' }).click();
    await page.getByText('분석이 완료되었습니다').waitFor({ timeout: 10000 });
    assert.equal(dialogShown, false);
    assert.match(analyzeRequestSnapshot ?? '', /name="resume_requested"\r\n\r\nfalse/);
    console.log('ok - suppressed resume candidate scenario');
  } finally {
    await context.close();
  }
};

const expectValue = async (page, selector, expected) => {
  await page.waitForFunction(
    ({ selector: nextSelector, expected: nextExpected }) => {
      const element = document.querySelector(nextSelector);
      return element instanceof HTMLInputElement && element.value === nextExpected;
    },
    { selector, expected },
  );
};

const expectLocalStorageJson = async (page, key, expected) => {
  await page.waitForFunction(
    ({ storageKey, expectedValue }) => {
      const raw = window.localStorage.getItem(storageKey);
      return raw === JSON.stringify(expectedValue);
    },
    { storageKey: key, expectedValue: expected },
  );
};

const expectNoText = async (page, text) => {
  await page.waitForFunction(nextText => !document.body?.innerText.includes(nextText), text);
};

const run = async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const fixtureUpload = await createFixtureFile();

  try {
    await runResumeDraftScenario(browser, fixtureUpload);
    await runActiveDraftBackendSyncScenario(browser, fixtureUpload);
    await runInvalidResumeDraftScenario(browser, fixtureUpload);
    await runSuppressedResumeCandidateScenario(browser, fixtureUpload);
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
