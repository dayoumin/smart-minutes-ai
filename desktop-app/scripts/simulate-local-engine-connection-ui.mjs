import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/?view=minutes&localEngineConnection=1';
const shouldStartServer = !process.env.APP_URL;
const PAGE_GOTO_TIMEOUT_MS = 60_000;

const waitForApp = async (url, timeoutMs = 30_000) => {
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

const getAvailablePort = async host => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, host, () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close(() => reject(new Error('Could not allocate a local test port.')));
      return;
    }
    server.close(() => resolve(address.port));
  });
});

const stopServer = async child => {
  if (!child || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    let killer = null;
    await Promise.race([
      new Promise(resolve => {
        killer = spawn('taskkill.exe', ['/pid', String(child.pid), '/t', '/f'], {
          stdio: 'ignore',
          windowsHide: true,
        });
        killer.on('exit', resolve);
        killer.on('error', resolve);
      }),
      sleep(3000),
    ]);
    if (killer?.exitCode === null) {
      killer.kill();
      killer.unref();
    }
    if (child.exitCode === null) {
      child.kill();
      child.unref();
    }
    child.stdout?.destroy();
    child.stderr?.destroy();
    return;
  }
  child.kill('SIGTERM');
  await Promise.race([new Promise(resolve => child.once('exit', resolve)), sleep(2000)]);
};

const startServer = async () => {
  if (!shouldStartServer) {
    await waitForApp(APP_URL);
    return null;
  }
  const url = new URL(APP_URL);
  url.port = String(await getAvailablePort(url.hostname));
  APP_URL = url.toString();
  const args = ['pnpm', 'exec', 'vite', '--host', url.hostname, '--port', url.port, '--strictPort', '--configLoader', 'runner'];
  const child = spawn('corepack', args, {
    cwd: fileURLToPath(new URL('..', import.meta.url)),
    env: { ...process.env, BROWSER: 'none' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
    shell: process.platform === 'win32',
  });
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

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;
  let probeMode = 'unreachable';
  let pairingStartCount = 0;

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });

    await page.route('**/api/probe', route => {
      if (probeMode === 'unreachable') {
        return sleep(150).then(() => route.abort('connectionrefused'));
      }
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          product_id: 'barorok-local-engine',
          engine_version: '0.1.0-test',
          api_contract_version: 1,
          capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'],
          auth_state: 'pairing-required',
          pairing_available: true,
          update_required: false,
        }),
      });
    });
    await page.route('**/api/pair/start', route => {
      pairingStartCount += 1;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ pairing_id: `pairing-id-for-ui-test-${pairingStartCount}`, expires_in_seconds: 120 }),
      });
    });
    await page.route('**/api/pair/complete', async route => {
      const payload = route.request().postDataJSON();
      if (payload.code === '654321') {
        return route.fulfill({
          status: 400,
          contentType: 'application/json',
          body: JSON.stringify({ detail: 'expired pairing challenge' }),
        });
      }
      assert.equal(payload.code, '123456');
      assert.equal(payload.pairing_id, 'pairing-id-for-ui-test-2');
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          session_token: 'session-token-for-ui-test-long-enough',
          expires_at: Math.floor(Date.now() / 1000) + 300,
          capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'],
        }),
      });
    });
    await page.route('**/api/health', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    }));
    await page.route('**/api/models/status', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, models: [], errors: [] }),
    }));

    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    const rail = page.locator('.local-engine-connection');
    await rail.getByText('이 PC에서 분석합니다').waitFor({ state: 'visible' });
    const analyzeButton = page.getByRole('button', { name: '분석 시작', exact: true });
    assert.equal(await analyzeButton.isDisabled(), true);
    assert.equal(await analyzeButton.evaluate(element => element.classList.contains('writer-start-button-connection-pending')), true);
    const infoTrigger = rail.getByRole('button', { name: '로컬 분석 안내' });
    await infoTrigger.hover();
    await page.waitForFunction(() => getComputedStyle(document.querySelector('#local-engine-info-tooltip')).opacity === '1');
    assert.equal(await page.locator('#local-engine-info-tooltip').evaluate(element => getComputedStyle(element).opacity), '1');

    await page.getByLabel('회의 제목 *').fill('연결 상태 보존 회의');
    await page.getByLabel('회의 목적 *').fill('연결 전 입력 보존 확인');
    await page.setInputFiles('#meeting-file-input', {
      name: '연결 확인.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('connection ui fixture'),
    });

    await rail.getByRole('button', { name: '연결 확인', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'writer-local-engine-requirement');
    await rail.getByText('분석 기능에 연결하지 못했습니다').waitFor({ state: 'visible' });
    assert.equal(await rail.getByRole('button', { name: '설치 파일 준비 중', exact: true }).count(), 0);

    probeMode = 'reachable';
    await rail.getByRole('button', { name: '다시 연결', exact: true }).click();
    await rail.getByText('이 브라우저를 연결해 주세요').waitFor({ state: 'visible' });
    await rail.getByRole('button', { name: '연결 시작', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: '이 브라우저 연결' });
    await dialog.waitFor({ state: 'visible' });
    const pairingCodeInput = dialog.getByRole('textbox', { name: '연결 코드', exact: true });
    await pairingCodeInput.waitFor({ state: 'visible' });
    assert.equal(await pairingCodeInput.evaluate(element => document.activeElement === element), true);
    await pairingCodeInput.fill('77');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    const codeTrigger = rail.getByRole('button', { name: '코드 입력', exact: true });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '코드 입력');
    assert.equal(await codeTrigger.evaluate(element => document.activeElement === element), true);
    await codeTrigger.click();
    await dialog.waitFor({ state: 'visible' });
    assert.equal(await pairingCodeInput.inputValue(), '', 'closing the dialog must clear the one-time code');
    await pairingCodeInput.press('Shift+Tab');
    const closeButton = dialog.getByRole('button', { name: '연결 코드 입력 닫기' });
    assert.equal(await closeButton.evaluate(element => document.activeElement === element), true);
    await closeButton.press('Shift+Tab');
    const connectButton = dialog.getByRole('button', { name: '연결', exact: true });
    assert.equal(await connectButton.evaluate(element => document.activeElement === element), true);
    await connectButton.press('Tab');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '연결 코드 입력 닫기');
    assert.equal(await closeButton.evaluate(element => document.activeElement === element), true);
    await pairingCodeInput.fill('123');
    await connectButton.click();
    await dialog.getByText('숫자 6~8자리를 입력해 주세요.').waitFor({ state: 'visible' });
    await pairingCodeInput.fill('654321');
    await connectButton.click();
    await dialog.waitFor({ state: 'hidden' });
    await rail.getByText('연결을 완료하지 못했습니다').waitFor({ state: 'visible' });
    await rail.getByRole('button', { name: '다시 연결', exact: true }).click();
    await dialog.waitFor({ state: 'visible' });
    assert.equal(pairingStartCount, 2, 'a rejected challenge must be replaced with a fresh pairing start');
    await pairingCodeInput.fill('123456');
    await connectButton.click();

    await rail.getByText('분석 준비 완료').waitFor({ state: 'visible' });
    assert.equal(await page.getByLabel('회의 제목 *').inputValue(), '연결 상태 보존 회의');
    assert.equal(await page.getByLabel('회의 목적 *').inputValue(), '연결 전 입력 보존 확인');
    await page.getByText('연결 확인.mp3').waitFor({ state: 'visible' });
    await analyzeButton.waitFor({ state: 'visible' });
    assert.equal(await analyzeButton.isEnabled(), true, 'a verified connection must unlock analysis');
    assert.equal(await analyzeButton.evaluate(element => element.classList.contains('writer-start-button-connection-pending')), false);

    for (const width of [760, 1100, 1536]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth - document.body.clientWidth,
        root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      assert.equal(Math.max(overflow.body, overflow.root), 0, `connection UI must not overflow at ${width}px`);
    }
    console.log('ok - local engine connection UI simulation');
  } catch (error) {
    console.error(error);
    if (page) console.error('body:', (await page.locator('body').innerText()).slice(0, 3000));
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopServer(server);
  }
};

await run();
