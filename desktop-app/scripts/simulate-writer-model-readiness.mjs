import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/?view=minutes';
const shouldStartServer = !process.env.APP_URL;
const PAGE_GOTO_TIMEOUT_MS = 60000;

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
        'taskkill.exe',
        ['/pid', String(child.pid), '/t', '/f'],
        { stdio: 'ignore', windowsHide: true },
      );
      const timeout = setTimeout(() => {
        killer.kill();
        resolve();
      }, 5000);
      const finish = () => {
        clearTimeout(timeout);
        resolve();
      };
      killer.on('exit', finish);
      killer.on('error', finish);
    });
    let childExited = child.exitCode !== null || await Promise.race([
      new Promise(resolve => child.once('exit', () => resolve(true))),
      sleep(1500).then(() => false),
    ]);
    if (!childExited) {
      child.kill('SIGKILL');
      childExited = child.exitCode !== null || await Promise.race([
        new Promise(resolve => child.once('exit', () => resolve(true))),
        sleep(1500).then(() => false),
      ]);
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    if (!childExited) throw new Error(`Failed to stop Vite process ${child.pid}`);
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
      },
    );

  child.stdout.on('data', data => {
    if (process.env.DEBUG_FLOW_TEST) process.stdout.write(data);
  });
  child.stderr.on('data', data => {
    if (process.env.DEBUG_FLOW_TEST) process.stderr.write(data);
  });

  try {
    await waitForApp(APP_URL);
    return child;
  } catch (error) {
    await stopServer(child);
    throw error;
  }
};

const installRoutes = async (page) => {
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));

  await page.route('**/api/models/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ready: false,
      models: [
        {
          key: 'stt_faster_whisper',
          label: 'Faster Whisper Large v3',
          required: true,
          installed: false,
          downloadable: true,
          manual_note: '설정에서 음성 인식 모델을 받을 수 있습니다.',
        },
      ],
      errors: [],
    }),
  }));

  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({}),
  }));

  await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
  }));
};

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await installRoutes(page);
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });

    const infoBanner = page.locator('.status-banner-info').filter({ hasText: '음성 인식 기본 모델 준비 필요' });
    await infoBanner.waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('모델 탭에서 받을 수 있는 항목은 바로 받을 수 있습니다.').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(
      await page.locator('.status-banner-error').filter({ hasText: '음성 인식 모델' }).count(),
      0,
      'missing models should be shown as guidance, not an error banner',
    );

    await page.getByLabel('회의 목적 *').fill('모델 미준비 상태에서 시작 차단 확인');
    await page.setInputFiles('#meeting-file-input', {
      name: '준비 상태 확인.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('readiness fixture'),
    });
    assert.equal(await page.getByLabel('회의 제목 *').inputValue(), '준비 상태 확인');
    const actionBar = page.locator('.writer-action-bar');
    const blockedStartButton = actionBar.getByRole('button', { name: '준비 필요', exact: true });
    await blockedStartButton.waitFor({ timeout: 10000 });
    assert.equal(await blockedStartButton.isDisabled(), true, 'missing required models should disable analysis start');

    await page.getByRole('button', { name: '모델 준비' }).click();
    const modelsTab = page.getByRole('tab', { name: '모델' });
    await modelsTab.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await modelsTab.getAttribute('aria-selected'), 'true', 'model guidance should open the models tab');
    await page.getByText('음성 인식 모델', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });

    console.log('ok - writer model readiness simulation');
  } catch (error) {
    console.error(error);
    if (page) {
      console.error('body:', (await page.locator('body').innerText()).slice(0, 3000));
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopServer(server);
  }
};

await run();
