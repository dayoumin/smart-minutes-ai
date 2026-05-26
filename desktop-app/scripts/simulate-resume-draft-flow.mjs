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
    meetingPurpose: '중단된 분석 이어하기 확인',
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
    meetingPurpose: '예전 실패 분석 재사용 확인',
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
    await page.getByRole('button', { name: /미완료 분석 기록 2건/ }).click();
    await page.locator('.sidebar-resume-draft-button').filter({ hasText: '중단된 회의' }).click();
    await page.getByRole('heading', { name: '이어하기' }).waitFor({ timeout: 10000 });
    await page.getByText('이전 분석 기록을 이어서 진행합니다. 같은 음성 파일을 다시 선택한 뒤 이어하기를 시작하세요.').waitFor({ timeout: 10000 });
    await page.getByText('같은 음성/영상 파일 선택 *').waitFor({ timeout: 10000 });
    await page.getByText('resume-draft-target.mp4 파일을 다시 선택해 주세요.').waitFor({ timeout: 10000 });
    await expectValue(page, '#meeting-title', '중단된 회의');
    await expectValue(page, '#meeting-purpose', '중단된 분석 이어하기 확인');
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByText('같은 파일을 확인했습니다. 이어하기를 시작할 수 있습니다.').waitFor({ timeout: 10000 });
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
    meetingPurpose: '진행 중 분석 상태 확인',
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
    await page.waitForFunction(() => {
      const stored = window.localStorage.getItem('analysisResumeDrafts');
      const parsed = JSON.parse(stored ?? '[]');
      return parsed[0]?.status === 'completed';
    }, undefined, { timeout: 10000 });
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
    meetingPurpose: '오래된 분석 정리 확인',
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
    await page.waitForFunction(() => {
      const stored = window.localStorage.getItem('analysisResumeDrafts');
      const parsed = JSON.parse(stored ?? '[]');
      return parsed[0]?.status === 'unavailable' && parsed[0]?.resumeUnavailableReason === 'not-candidate';
    }, undefined, { timeout: 10000 });
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
    await page.getByLabel('회의 목적/정리 맥락 *').fill('재개 후보 숨김 동작을 확인');
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

const runSuppressedActiveCandidateBlocksFreshStartScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let analyzeCalled = false;
  const suppressedKey = `${fixtureUpload.name}::${fixtureUpload.size}::${fixtureUpload.lastModified}`;

  await context.addInitScript(value => {
    window.localStorage.setItem('suppressedResumeCandidateKeys', JSON.stringify([value]));
    window.localStorage.setItem('analysisResumeDrafts', '[]');
  }, suppressedKey);

  await installBaseRoutes(page);
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      recommended_job_id: 'suppressed-active-job',
      candidates: [{
        job_id: 'suppressed-active-job',
        stage: 'transcribing',
        updated_at: '2026-05-14T12:00:00.000Z',
        resume_supported: true,
        active: true,
        chunk_count: 4,
        completed_chunk_count: 2,
        last_progress: {
          message: 'Transcribing chunk 2/4...',
          progress: 50,
          status: 'processing',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze', route => {
    analyzeCalled = true;
    return route.abort();
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('회의 제목 *').fill('suppressed active candidate');
    await page.getByLabel('회의 목적/정리 맥락 *').fill('진행 중 후보는 억제와 무관하게 차단');
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByRole('button', { name: '분석 시작' }).click();
    await page.getByText('같은 파일의 분석이 이미 진행 중입니다. 완료되거나 취소된 뒤 다시 시도해 주세요.').waitFor({ timeout: 10000 });
    assert.equal(analyzeCalled, false);
    console.log('ok - suppressed active candidate blocks fresh start scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runSelectedResumeFreshStartScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let analyzeRequestSnapshot = null;
  let dialogShown = false;

  const draft = {
    jobId: 'fresh-choice-draft-job',
    title: '새 분석 선택 회의',
    date: '2026-05-14T10:00',
    meetingPurpose: '이어하기 대신 새 분석 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-14T10:00:00.000Z',
    updatedAt: '2026-05-14T10:15:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 2/4...',
    lastProgress: 50,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);

  page.on('dialog', async dialog => {
    dialogShown = true;
    await dialog.dismiss();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: 'fresh-choice-draft-job',
        status: 'cancelled',
        stage: 'cancelled',
        updated_at: '2026-05-14T10:15:00.000Z',
        resume_supported: true,
        completed_chunk_count: 2,
        last_progress: {
          message: 'Transcribing chunk 2/4...',
          progress: 50,
          status: 'cancelled',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      recommended_job_id: 'fresh-choice-draft-job',
      candidates: [{
        job_id: 'fresh-choice-draft-job',
        stage: 'transcribing',
        updated_at: '2026-05-14T10:15:00.000Z',
        resume_supported: true,
        active: false,
        chunk_count: 4,
        completed_chunk_count: 2,
        last_progress: {
          message: 'Transcribing chunk 2/4...',
          progress: 50,
          status: 'cancelled',
        },
      }],
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
        'data: {"type":"result","progress":100,"status":"completed","summary":"fresh choice summary","segments":[],"meeting":{"source_file":"resume-draft-target.mp4","job_id":"fresh-choice-new-job"},"outputs":{"job_id":"fresh-choice-new-job","json":"/api/outputs/fresh-choice-new-job/json","txt":"/api/outputs/fresh-choice-new-job/txt","md":null,"docx":null,"hwpx":null},"resume":{"requested":false,"mode":"fresh_start","message":"","reused_chunk_count":0}}',
        '',
        'event: done',
        'data: [DONE]',
        '',
      ].join('\n'),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /미완료 분석 기록 1건/ }).click();
    await page.locator('.sidebar-resume-draft-button').filter({ hasText: '새 분석 선택 회의' }).click();
    await page.getByRole('heading', { name: '이어하기' }).waitFor({ timeout: 10000 });
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByRole('button', { name: '새 분석', exact: true }).click();
    await page.getByRole('heading', { name: '새 회의록 작성' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '분석 시작' }).click();
    await page.getByText('분석이 완료되었습니다').waitFor({ timeout: 10000 });
    assert.equal(dialogShown, false);
    assert.doesNotMatch(analyzeRequestSnapshot ?? '', /name="job_id"\r\n\r\nfresh-choice-draft-job/);
    assert.match(analyzeRequestSnapshot ?? '', /name="resume_requested"\r\n\r\nfalse/);
    console.log('ok - selected resume can start fresh scenario');
  } catch (error) {
    console.error(error);
    console.error('analyzeRequestSnapshot:', analyzeRequestSnapshot);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runActiveDraftDeleteAfterBackendErrorScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const draft = {
    jobId: 'stale-active-delete-job',
    title: '삭제할 진행 기록',
    date: '2026-05-15T11:00',
    meetingPurpose: '오래된 진행 기록 삭제 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'active',
    createdAt: '2026-05-15T11:00:00.000Z',
    updatedAt: '2026-05-15T11:10:00.000Z',
    stage: 'transcribing',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /진행 중이던 분석 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 500,
    contentType: 'text/plain',
    body: 'Python interpreter failed to start',
  }));
  await page.route('**/api/analyze/drafts/stale-active-delete-job', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ job_id: 'stale-active-delete-job', deleted: ['jobs/stale-active-delete-job'] }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /미완료 분석 기록 1건/ }).click();
    await page.locator('.sidebar-resume-draft-button').filter({ hasText: '삭제할 진행 기록' }).click();
    await page.getByRole('heading', { name: '이어하기' }).waitFor({ timeout: 10000 });
    await page.locator('.resume-draft-card').filter({ hasText: '삭제할 진행 기록' }).getByRole('button', { name: '삭제할 진행 기록 분석 기록 삭제' }).click();
    await expectLocalStorageJson(page, 'analysisResumeDrafts', []);
    const bodyText = await page.locator('body').innerText();
    assert.doesNotMatch(bodyText, /Python interpreter/);
    console.log('ok - active draft delete after backend error scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runLocalOnlyDeleteRetriesPendingCleanupScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let deleteCalls = 0;

  const draft = {
    jobId: 'pending-cleanup-delete-job',
    title: '나중에 정리할 기록',
    date: '2026-05-15T11:20',
    meetingPurpose: '백엔드 일시 실패 후 정리 재시도 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-15T11:20:00.000Z',
    updatedAt: '2026-05-15T11:25:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
    window.localStorage.setItem('pendingAnalysisDraftCleanups', '[]');
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /이전 분석 진행 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: 'pending-cleanup-delete-job',
        status: 'cancelled',
        stage: 'cancelled',
        updated_at: '2026-05-15T11:25:00.000Z',
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: {
          message: 'Transcribing chunk 1/4...',
          progress: 25,
          status: 'cancelled',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze/drafts/**', route => {
    deleteCalls += 1;
    if (deleteCalls === 1) return route.abort('failed');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: 'pending-cleanup-delete-job', deleted: ['jobs/pending-cleanup-delete-job'] }),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const deleteCard = page.locator('.resume-draft-card').filter({ hasText: '나중에 정리할 기록' });
    await deleteCard.waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    await deleteCard.locator('button[title="분석 기록 삭제"]').click();
    await expectLocalStorageJson(page, 'analysisResumeDrafts', []);
    await page.waitForFunction(() => {
      const pendingRaw = window.localStorage.getItem('pendingAnalysisDraftCleanups');
      return pendingRaw === '[]';
    }, undefined, { timeout: 10000 });
    assert.equal(deleteCalls >= 2, true);
    console.log('ok - local-only delete retries pending cleanup scenario');
  } catch (error) {
    console.error(error);
    console.error('deleteCalls:', deleteCalls);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runDeleteServerErrorKeepsDraftScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const draft = {
    jobId: 'delete-server-error-job',
    title: '삭제 실패 기록',
    date: '2026-05-15T11:30',
    meetingPurpose: '삭제 실패 시 유지 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-15T11:30:00.000Z',
    updatedAt: '2026-05-15T11:35:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /이전 분석 진행 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: 'delete-server-error-job',
        status: 'cancelled',
        stage: 'cancelled',
        updated_at: '2026-05-15T11:35:00.000Z',
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: {
          message: 'Transcribing chunk 1/4...',
          progress: 25,
          status: 'cancelled',
        },
      }],
    }),
  }));
  let deleteRouteCalled = false;
  await page.route('**/api/analyze/drafts/**', route => {
    deleteRouteCalled = true;
    return route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'delete failed' }),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const deleteCard = page.locator('.resume-draft-card').filter({ hasText: '삭제 실패 기록' });
    await deleteCard.waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    await deleteCard.locator('button[title="분석 기록 삭제"]').click();
    await page.getByText('분석 임시 파일을 정리하지 못했습니다.').waitFor({ timeout: 10000 });
    assert.equal(deleteRouteCalled, true);
    await page.waitForFunction(() => {
      const stored = window.localStorage.getItem('analysisResumeDrafts');
      const parsed = JSON.parse(stored ?? '[]');
      return parsed.length === 1 && parsed[0]?.jobId === 'delete-server-error-job';
    }, undefined, { timeout: 10000 });
    console.log('ok - delete server error keeps draft scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runActiveDraftNetworkFailureKeepsDraftScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const draft = {
    jobId: 'active-network-delete-job',
    title: '확인 불가 진행 기록',
    date: '2026-05-15T11:45',
    meetingPurpose: '진행 상태 확인 실패 시 삭제 보류',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'active',
    createdAt: '2026-05-15T11:45:00.000Z',
    updatedAt: '2026-05-15T11:50:00.000Z',
    stage: 'transcribing',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
    window.localStorage.setItem('pendingAnalysisDraftCleanups', '[]');
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /진행 중이던 분석 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 500,
    contentType: 'text/plain',
    body: 'backend unavailable',
  }));
  await page.route('**/api/analyze/drafts/**', route => route.abort('failed'));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const deleteCard = page.locator('.resume-draft-card').filter({ hasText: '확인 불가 진행 기록' });
    await deleteCard.waitFor({ timeout: 10000 });
    await deleteCard.locator('button[title="분석 기록 삭제"]').click();
    await page.waitForFunction(() => {
      const drafts = JSON.parse(window.localStorage.getItem('analysisResumeDrafts') ?? '[]');
      const pending = JSON.parse(window.localStorage.getItem('pendingAnalysisDraftCleanups') ?? '[]');
      return drafts.length === 1 && drafts[0]?.jobId === 'active-network-delete-job' && pending.length === 0;
    }, undefined, { timeout: 10000 });
    console.log('ok - active draft network failure keeps draft scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runDeleteDoesNotSuppressFileCandidateScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const draft = {
    jobId: 'delete-no-suppress-job',
    title: '삭제만 할 기록',
    date: '2026-05-15T11:55',
    meetingPurpose: '삭제가 후보 숨김으로 이어지지 않는지 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-15T11:55:00.000Z',
    updatedAt: '2026-05-15T11:58:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
    window.localStorage.setItem('suppressedResumeCandidateKeys', '[]');
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /이전 분석 진행 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: 'delete-no-suppress-job',
        status: 'cancelled',
        stage: 'cancelled',
        updated_at: '2026-05-15T11:58:00.000Z',
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: {
          message: 'Transcribing chunk 1/4...',
          progress: 25,
          status: 'cancelled',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze/drafts/delete-no-suppress-job', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ job_id: 'delete-no-suppress-job', deleted: ['jobs/delete-no-suppress-job'] }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const deleteCard = page.locator('.resume-draft-card').filter({ hasText: '삭제만 할 기록' });
    await deleteCard.waitFor({ timeout: 10000 });
    await page.waitForTimeout(800);
    await deleteCard.locator('button[title="분석 기록 삭제"]').click();
    await expectLocalStorageJson(page, 'analysisResumeDrafts', []);
    await expectLocalStorageJson(page, 'suppressedResumeCandidateKeys', []);
    console.log('ok - delete does not suppress file candidate scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runCancelledDraftImmediateDeleteScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const draft = {
    jobId: 'cancelled-immediate-delete-job',
    title: '방금 중단한 기록',
    date: '2026-05-15T12:00',
    meetingPurpose: '중단 직후 삭제 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-15T12:00:00.000Z',
    updatedAt: '2026-05-15T12:05:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /이전 분석 진행 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: 'cancelled-immediate-delete-job',
        status: 'cancelled',
        stage: 'cancelled',
        updated_at: '2026-05-15T12:05:00.000Z',
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: {
          message: 'Transcribing chunk 1/4...',
          progress: 25,
          status: 'cancelled',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze/drafts/cancelled-immediate-delete-job', route => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'analysis_job_active' }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '방금 중단한 기록 분석 기록 삭제' }).click();
    await expectLocalStorageJson(page, 'analysisResumeDrafts', []);
    const bodyText = await page.locator('body').innerText();
    assert.doesNotMatch(bodyText, /아직 진행 중인 분석입니다/);
    console.log('ok - cancelled draft immediate delete scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
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
    await runSuppressedActiveCandidateBlocksFreshStartScenario(browser, fixtureUpload);
    await runSelectedResumeFreshStartScenario(browser, fixtureUpload);
    await runActiveDraftDeleteAfterBackendErrorScenario(browser, fixtureUpload);
    await runLocalOnlyDeleteRetriesPendingCleanupScenario(browser, fixtureUpload);
    await runDeleteServerErrorKeepsDraftScenario(browser, fixtureUpload);
    await runActiveDraftNetworkFailureKeepsDraftScenario(browser, fixtureUpload);
    await runDeleteDoesNotSuppressFileCandidateScenario(browser, fixtureUpload);
    await runCancelledDraftImmediateDeleteScenario(browser, fixtureUpload);
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
