import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
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
      ready: true,
      models: [
        { key: 'stt_faster_whisper', label: 'STT', installed: true, required: true },
        { key: 'diarization', label: 'Diarization', installed: true, required: true },
      ],
      stt_device_status: { gpu_detected: false, gpu_usable: false },
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
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });

  try {
    await page.addInitScript(() => {
      window.__restartCalls = 0;
      window.__TAURI__ = {
        core: {
          invoke: async (command) => {
            if (command === 'get_backend_base_url') return 'http://127.0.0.1:17863';
            if (command === 'restart_backend') {
              window.__restartCalls += 1;
              return 'http://127.0.0.1:17863';
            }
            if (command === 'set_close_guard_active' || command === 'write_frontend_log') return undefined;
            throw new Error(`unexpected command ${command}`);
          },
        },
      };
    });
    await installRoutes(page);
    await page.goto(APP_URL, { waitUntil: 'networkidle' });

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('analysis:status', {
        detail: { active: true, progress: 15, message: '분석 중' },
      }));
    });

    await page.getByRole('button', { name: '시스템 설정' }).click();
    await page.getByRole('tab', { name: '분석 준비' }).click();

    const restartButton = page.getByRole('button', { name: '서버 재시작' });
    await expectDisabled(restartButton, true, 'active analysis should disable backend restart');

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('analysis:status', {
        detail: { active: false, progress: 0, message: '' },
      }));
    });
    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('backend-task:state', {
        detail: { source: 'test-generation', active: true },
      }));
    });
    await expectDisabled(restartButton, true, 'active generation task should disable backend restart');

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('backend-task:state', {
        detail: { source: 'test-generation', active: false },
      }));
    });
    await expectDisabled(restartButton, false, 'idle app should enable backend restart');

    await restartButton.click();
    await page.getByText('분석 서버를 다시 시작하고 상태를 확인했습니다.').waitFor({ state: 'visible', timeout: 10000 });
    const restartCalls = await page.evaluate(() => window.__restartCalls);
    assert.equal(restartCalls, 1, 'restart command should run once');

    console.log('ok - settings backend restart simulation');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 3000));
    throw error;
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

const expectDisabled = async (locator, expected, message) => {
  await locator.waitFor({ state: 'visible', timeoutMs: 10000 });
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const disabled = !(await locator.isEnabled());
    if (disabled === expected) return;
    await sleep(250);
  }
  assert.equal(!(await locator.isEnabled()), expected, message);
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
