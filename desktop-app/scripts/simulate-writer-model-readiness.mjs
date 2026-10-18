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
  const state = { ready: false, downloadable: true };
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));

  await page.route('**/api/models/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ready: state.ready,
      models: [
        {
          key: 'stt_faster_whisper',
          label: 'Faster Whisper Large v3',
          required: true,
          installed: state.ready,
          downloadable: state.downloadable,
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
  return state;
};

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const state = await installRoutes(page);
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });

    const infoBanner = page.locator('.status-banner-info').filter({ hasText: '준비할 모델' });
    await infoBanner.waitFor({ state: 'visible', timeout: 10000 });
    await infoBanner.getByText('음성 인식 기본 모델', { exact: false }).waitFor({ state: 'visible', timeout: 10000 });
    await page.getByText('모델 받기를 누르면 설정에서 바로 받을 수 있습니다.').waitFor({ state: 'visible', timeout: 10000 });
    // One way forward: 모델 받기 beside 분석 시작. The banner only adds 다시 확인, no 설정/모델 준비 duplicates.
    assert.equal(await page.getByRole('button', { name: '모델 받기', exact: true }).count(), 1);
    assert.equal(await page.locator('.writer-action-bar').getByRole('button', { name: '모델 받기', exact: true }).count(), 1, '모델 받기 sits beside 분석 시작');
    assert.equal(await infoBanner.getByRole('button', { name: '설정', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '모델 준비', exact: true }).count(), 0);
    assert.equal(await infoBanner.getByRole('button', { name: '다시 확인', exact: true }).count(), 1);
    assert.equal(await page.getByText('models 폴더', { exact: false }).count(), 0, 'the writer should not mention the models folder');
    // 다시 확인 in the banner must not add a second (error) banner repeating the same sentence.
    await infoBanner.getByRole('button', { name: '다시 확인', exact: true }).click();
    await page.waitForTimeout(500);
    assert.equal(await page.getByText('모델 받기를 누르면 설정에서 바로 받을 수 있습니다.').count(), 1, 'the readiness sentence appears once');
    assert.equal(await page.locator('.status-banner-error').count(), 0, 'rechecking should not raise an error banner');
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

    await page.getByRole('button', { name: '모델 받기', exact: true }).click();
    const modelsTab = page.getByRole('tab', { name: '모델' });
    await modelsTab.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await modelsTab.getAttribute('aria-selected'), 'true', 'model guidance should open the models tab');
    // The panel heading and loaded model row share this label.
    await page.locator('#settings-models-panel').getByText('음성 인식 모델', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });

    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '모델 받기');

    const prepareModel = async () => {
      await page.getByRole('button', { name: '모델 받기', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('tab', { name: '모델', exact: true }).waitFor();
      state.ready = true;
      await dialog.getByRole('button', { name: '모델 준비 상태 다시 확인', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.writer-start-button')?.textContent?.trim() === '분석 시작');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    };
    await prepareModel();
    await page.waitForFunction(() => document.activeElement?.classList.contains('writer-start-button'));
    assert.equal(await page.getByLabel('회의 제목 *').inputValue(), '준비 상태 확인');
    assert.equal(await page.getByLabel('회의 목적 *').inputValue(), '모델 미준비 상태에서 시작 차단 확인');
    assert.equal(await page.locator('#meeting-file-input').evaluate(input => input.files?.[0]?.name), '준비 상태 확인.mp3');
    assert.equal(await actionBar.getByRole('button', { name: '분석 시작', exact: true }).isEnabled(), true);

    await page.getByRole('button', { name: '준비 상태 확인.mp3 제거', exact: true }).click();
    state.ready = false;
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await page.getByRole('button', { name: '준비 필요', exact: true }).waitFor();
    await prepareModel();
    await page.waitForFunction(() => document.activeElement?.classList.contains('file-drop-zone'));

    // A missing model that Settings cannot download must not point at 모델 받기.
    state.ready = false;
    state.downloadable = false;
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    const errorBanner = page.locator('.status-banner-error').filter({ hasText: '분석을 시작할 수 없습니다' });
    await errorBanner.getByText('이 모델은 설정에서 받을 수 없으니 바로록을 다시 설치해 주세요.', { exact: false }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('button', { name: '모델 받기', exact: true }).count(), 0, 'no 모델 받기 for a model Settings cannot download');
    assert.equal(await page.getByText('모델 받기를 누르면', { exact: false }).count(), 0);

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
