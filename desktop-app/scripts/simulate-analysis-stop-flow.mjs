import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
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

const assertProjectPage = async (page) => {
  const title = await page.title();
  if (title !== 'AI 회의록 도우미') {
    throw new Error(`Unexpected app at ${APP_URL}: ${title || '(no title)'}`);
  }
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
  const command = `corepack pnpm run dev --host ${url.hostname} --port ${url.port || '5173'} --strictPort --configLoader runner`;
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

const createFixtureFile = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-minutes-analysis-stop-'));
  const filePath = join(dir, 'analysis-stop-target.mp4');
  await writeFile(filePath, Buffer.alloc(128, 4));
  const fileStat = await stat(filePath);
  return {
    path: filePath,
    name: 'analysis-stop-target.mp4',
    size: fileStat.size,
    lastModified: Math.trunc(fileStat.mtimeMs),
  };
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

  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ recommended_job_id: null, candidates: [] }),
  }));

  await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
  }));
};

const multipartField = (body, name) => {
  const match = body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]+)`));
  return match?.[1] ?? null;
};

const readLocalStorageJson = async (page, key) => page.evaluate(storageKey => {
  const raw = window.localStorage.getItem(storageKey);
  return raw ? JSON.parse(raw) : null;
}, key);

const runScenario = async (browser, fixture, action) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  let releaseAnalyzeResponse = () => {};
  const analyzeCanFinish = new Promise(resolve => {
    releaseAnalyzeResponse = resolve;
  });
  let markAnalyzeStarted = () => {};
  const analyzeStarted = new Promise(resolve => {
    markAnalyzeStarted = resolve;
  });
  let analyzeJobId = null;
  let cancelRequestCount = 0;
  const cancelRequestBodies = [];
  let markCancelRequested = () => {};
  const cancelRequested = new Promise(resolve => {
    markCancelRequested = resolve;
  });

  try {
    await installBaseRoutes(page);

    await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        drafts: analyzeJobId ? [{
          job_id: analyzeJobId,
          status: action === 'stop' && cancelRequestCount > 0 ? 'active' : 'cancelled',
          stage: action === 'stop' && cancelRequestCount > 0 ? 'transcribing' : 'cancelled',
          active: action === 'stop' && cancelRequestCount > 0,
          updated_at: new Date().toISOString(),
          resume_supported: true,
          completed_chunk_count: 1,
          last_progress: {
            message: 'Transcribing chunk 2/4...',
            progress: 42,
            status: 'cancelled',
          },
        }] : [],
      }),
    }));

    await page.route('**/api/analyze', async route => {
      const postData = (await route.request().postDataBuffer()).toString('utf-8');
      analyzeJobId = multipartField(postData, 'job_id');
      markAnalyzeStarted();
      await analyzeCanFinish;
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: [
          'event: progress',
          `data: ${JSON.stringify({ type: 'progress', progress: 42, status: 'transcribing', message: 'Transcribing chunk 2/4...' })}`,
          '',
          'event: cancelled',
          `data: ${JSON.stringify({ type: 'cancelled', action, progress: 42, status: 'cancelled', message: '분석이 취소되었습니다.' })}`,
          '',
          'event: done',
          'data: [DONE]',
          '',
          '',
        ].join('\n'),
      });
    });

    await page.route(/\/api\/analyze\/[^/]+\/cancel$/, route => {
      cancelRequestCount += 1;
      cancelRequestBodies.push(JSON.parse(route.request().postData() ?? '{}'));
      markCancelRequested();
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ job_id: analyzeJobId, action, cancel_requested: true }),
      });
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await assertProjectPage(page);
    await page.getByLabel('회의 제목 *').fill(`${action} 분석 중지 테스트`);
    await page.getByLabel('회의 목적/정리 맥락 *').fill('분석 중 중지와 취소 동작 확인');
    await page.setInputFiles('#meeting-file-input', fixture.path);
    await page.getByRole('button', { name: '분석 시작' }).click();
    await analyzeStarted;
    await page.getByRole('button', { name: '중지/취소' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '중지/취소' }).click();
    await page.getByText('분석을 어떻게 처리할까요?').waitFor({ timeout: 10000 });

    if (action === 'stop') {
      await page.locator('.analysis-stop-panel').getByRole('button', { name: '이어하기 기록을 남기고 분석 중지' }).click();
      await page.getByRole('main').getByText('현재 처리 중인 구간이 끝나면 이어하기 기록으로 남깁니다.').waitFor({ timeout: 10000 });
    } else {
      await page.locator('.analysis-stop-panel').getByRole('button', { name: '이어하기 기록을 남기지 않고 분석 취소' }).click();
      await page.getByRole('main').getByText('현재 처리 중인 구간이 끝나면 이어하기 기록을 제거합니다.').waitFor({ timeout: 10000 });
    }

    await cancelRequested;
    assert.equal(cancelRequestCount, 1);
    assert.deepEqual(cancelRequestBodies, [{ action }]);
    if (action === 'stop') {
      await page.waitForTimeout(1800);
      const draftsBeforeFinalCancel = await readLocalStorageJson(page, 'analysisResumeDrafts');
      assert.equal(draftsBeforeFinalCancel.length, 1);
      assert.equal(draftsBeforeFinalCancel[0].status, 'stopped');
    }
    releaseAnalyzeResponse();

    if (action === 'stop') {
      await page.getByText('분석을 중지했습니다. 같은 파일을 선택하면 이어서 진행할 수 있습니다.').waitFor({ timeout: 10000 });
      const drafts = await readLocalStorageJson(page, 'analysisResumeDrafts');
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].status, 'stopped');
      assert.equal(drafts[0].jobId, analyzeJobId);
    } else {
      await page.getByText('분석을 취소했습니다.').waitFor({ timeout: 10000 });
      assert.deepEqual(await readLocalStorageJson(page, 'analysisResumeDrafts'), []);
      assert.deepEqual(await readLocalStorageJson(page, 'pendingAnalysisDraftCleanups'), [analyzeJobId]);
      assert.deepEqual(
        await readLocalStorageJson(page, 'suppressedResumeCandidateKeys'),
        [`${fixture.name}::${fixture.size}::${fixture.lastModified}`],
      );
    }

    console.log(`ok - analysis ${action} flow simulation`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
};

const server = await startServer();
const fixture = await createFixtureFile();
const browser = await chromium.launch();
try {
  await runScenario(browser, fixture, 'stop');
  await runScenario(browser, fixture, 'cancel');
} finally {
  await browser.close();
  await stopServer(server);
}
