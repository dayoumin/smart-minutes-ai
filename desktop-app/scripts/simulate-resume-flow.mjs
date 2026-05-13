import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
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

  child.stdout.on('data', data => {
    if (process.env.DEBUG_FLOW_TEST) process.stdout.write(data);
  });
  child.stderr.on('data', data => {
    if (process.env.DEBUG_FLOW_TEST) process.stderr.write(data);
  });

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
  const dir = await mkdtemp(join(tmpdir(), 'smart-minutes-resume-'));
  const filePath = join(dir, 'resume-target.mp4');
  await writeFile(filePath, Buffer.from('resume-file-content'));
  return filePath;
};

const runResumeReuseScenario = async (browser, fixturePath) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const requests = [];
  let analyzeRequestSnapshot = null;

  page.on('request', request => {
    if (request.url().includes('/api/')) {
      requests.push(`${request.method()} ${request.url()}`);
    }
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      recommended_job_id: 'resume-job-001',
      candidates: [
        {
          job_id: 'resume-job-001',
          stage: 'transcribing',
          updated_at: '2026-05-13T10:10:00',
          resume_supported: true,
          active: false,
          chunk_count: 4,
          completed_chunk_count: 2,
          last_progress: {
            message: 'Transcribing chunk 2/4...',
            progress: 47,
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
        'data: {"type":"result","progress":100,"status":"completed","summary":"resume summary","segments":[],"meeting":{"source_file":"resume-target.mp4","job_id":"resume-job-001"},"outputs":{"job_id":"resume-job-001","json":"/api/outputs/resume-job-001/json","txt":"/api/outputs/resume-job-001/txt","md":null,"docx":null,"hwpx":null},"resume":{"requested":true,"mode":"reused_stt","message":"이전 음성 인식 진행분을 재사용했습니다.","reused_chunk_count":2}}',
        '',
        'event: done',
        'data: [DONE]',
        '',
      ].join('\n'),
    });
  });

  page.once('dialog', async dialog => {
    assert.match(dialog.message(), /이전 음성 인식 진행분 재사용을 시도할까요/);
    await dialog.accept();
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('회의 제목 *').fill('resume reuse scenario');
    await page.getByLabel('참석자 *').fill('홍길동');
    await page.setInputFiles('#meeting-file-input', fixturePath);
    await page.getByRole('button', { name: 'AI 분석 시작' }).click();
    await page.getByText('이전 음성 인식 진행분 2개 구간을 재사용했습니다.').waitFor({ timeout: 10000 });
    assert.match(analyzeRequestSnapshot ?? '', /name="job_id"\r\n\r\nresume-job-001/);
    assert.match(analyzeRequestSnapshot ?? '', /name="resume_requested"\r\n\r\ntrue/);
    console.log('ok - resume reuse flow simulation');
  } catch (error) {
    console.error(error);
    console.error('requests:', requests);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 3000));
    throw error;
  } finally {
    await page.close();
  }
};

const runResumeFallbackScenario = async (browser, fixturePath) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let analyzeRequestSnapshot = null;

  await installBaseRoutes(page);
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      recommended_job_id: 'resume-job-002',
      candidates: [
        {
          job_id: 'resume-job-002',
          stage: 'transcribing',
          updated_at: '2026-05-13T10:20:00',
          resume_supported: true,
          active: false,
          chunk_count: 3,
          completed_chunk_count: 1,
          last_progress: {
            message: 'Transcribing chunk 1/3...',
            progress: 30,
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
        'data: {"type":"progress","progress":5,"message":"이전 분석 기록과 일치하지 않아 처음부터 다시 분석합니다.","status":"processing"}',
        '',
        'event: result',
        'data: {"type":"result","progress":100,"status":"completed","summary":"fallback summary","segments":[],"meeting":{"source_file":"resume-target.mp4","job_id":"resume-job-002"},"outputs":{"job_id":"resume-job-002","json":"/api/outputs/resume-job-002/json","txt":"/api/outputs/resume-job-002/txt","md":null,"docx":null,"hwpx":null},"resume":{"requested":true,"mode":"fallback_fresh_start","message":"이전 분석 기록과 일치하지 않아 처음부터 다시 분석합니다.","fallback_reason":"fingerprint_mismatch","reused_chunk_count":0}}',
        '',
        'event: done',
        'data: [DONE]',
        '',
      ].join('\n'),
    });
  });

  page.once('dialog', async dialog => {
    await dialog.accept();
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('회의 제목 *').fill('resume fallback scenario');
    await page.getByLabel('참석자 *').fill('홍길동');
    await page.setInputFiles('#meeting-file-input', fixturePath);
    await page.getByRole('button', { name: 'AI 분석 시작' }).click();
    await page.getByText('이전 분석 기록과 일치하지 않아 이번 분석은 처음부터 다시 진행했습니다.').waitFor({ timeout: 10000 });
    assert.match(analyzeRequestSnapshot ?? '', /name="resume_requested"\r\n\r\ntrue/);
    console.log('ok - resume fallback flow simulation');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 3000));
    throw error;
  } finally {
    await page.close();
  }
};

const run = async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const fixturePath = await createFixtureFile();

  try {
    await runResumeReuseScenario(browser, fixturePath);
    await runResumeFallbackScenario(browser, fixturePath);
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
