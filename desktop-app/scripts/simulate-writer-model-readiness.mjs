import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';

// The development UI's action row: recovery actions while blocked; analysis only after a file is selected.
const rowOf = page => page.locator('.writer-action-row');
const statusOf = page => page.locator('#writer-local-engine-requirement');
const waitForRowState = (page, state, timeout = 10000) => page.waitForFunction(
  expected => document.querySelector('.writer-action-row')?.getAttribute('data-state') === expected, state, { timeout },
);
const readRow = async page => ({
  state: await rowOf(page).getAttribute('data-state'),
  title: (await statusOf(page).locator('.writer-status-title').allInnerTexts())[0] ?? '',
  message: (await statusOf(page).locator('.writer-status-message:not(.sr-only)').allInnerTexts())[0] ?? null,
  buttons: (await rowOf(page).locator('.writer-status-actions > :is(button, a)').allInnerTexts()).map(text => text.trim()),
});
const startButtonOf = page => page.locator('.writer-start-button');
const isStartBlocked = async page => (await startButtonOf(page).getAttribute('aria-disabled')) === 'true';
const refreshModelsOnFocus = async page => {
  const isModelStatus = request => new URL(request.url()).pathname === '/api/models/status';
  await Promise.all([
    page.waitForRequest(isModelStatus),
    page.waitForResponse(response => isModelStatus(response.request())),
    page.evaluate(() => window.dispatchEvent(new Event('focus'))),
  ]);
  assert.equal(await page.getByRole('button', { name: '모델 준비 상태 다시 확인', exact: true }).count(), 0, 'normal model settings do not offer a manual refresh');
};
// None of the old surfaces: no 준비 필요 label, no readiness or form banner, no second hint line.
const assertNoOldSurfaces = async page => {
  assert.equal(await page.getByRole('button', { name: '준비 필요', exact: true }).count(), 0, 'no 준비 필요 label');
  assert.equal(await page.locator('.status-banner').count(), 0, 'no banner under the form');
  assert.equal(await page.locator('#writer-readiness-hint, #writer-engine-checking, .writer-action-bar').count(), 0, 'no old action bar lines');
  if (await startButtonOf(page).count()) {
    assert.equal(await startButtonOf(page).getAttribute('aria-describedby'), 'writer-local-engine-requirement', 'the status line is the only description');
  }
};

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

// The web app has no 재시작: a failed settings load points at the connection program and offers 다시 확인 (SB-2).
const verifyWebSettingsRecovery = async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let settingsUp = false;
  let holdSettings = null;
  let releaseSettings;
  let markRetryStarted;
  try {
    await page.clock.install();
    await page.route('**/api/health', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    await page.route('**/api/models/status', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, models: [], errors: [] }),
    }));
    await page.route('**/api/settings', async route => {
      if (holdSettings) {
        markRetryStarted();
        await holdSettings;
      }
      return settingsUp
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
        : route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'settings unavailable' }) });
    });
    await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });

    await page.getByRole('complementary').getByRole('button', { name: '설정' }).click();
    const dialog = page.getByRole('dialog', { name: '설정' });
    const failure = dialog.getByText(`설정을 불러오지 못했습니다. 잠시 후 자동으로 다시 확인합니다. 계속 실패하면 ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인해 주세요.`, { exact: true });
    await failure.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await dialog.getByText('재시작', { exact: false }).count(), 0, 'the web app must not point at the desktop-only 재시작');
    const generalPanel = dialog.locator('#settings-general-panel');
    const bodyY = (await generalPanel.boundingBox()).y;
    const retryStarted = new Promise(resolve => { markRetryStarted = resolve; });
    holdSettings = new Promise(resolve => { releaseSettings = resolve; });
    await page.clock.runFor(5100);
    await retryStarted;
    assert.equal(await failure.isVisible(), true, 'a pending automatic retry keeps the existing settings error visible');
    assert.equal((await generalPanel.boundingBox()).y, bodyY, 'a pending retry does not move the settings body by removing its error banner');
    settingsUp = true;
    releaseSettings();
    holdSettings = null;
    await dialog.getByText('설정을 불러오지 못했습니다.', { exact: false }).waitFor({ state: 'hidden', timeout: 10000 });
    assert.equal(await dialog.getByText('불러오지 못함', { exact: true }).count(), 0, 'settings load after the automatic retry succeeds');
    console.log(`ok - web settings failure points at ${LOCAL_ENGINE_NAME}, stays stable during retries, and clears after recovery`);
  } finally {
    releaseSettings?.();
    await page.close();
  }
};

// GPU selected but unusable, models present: the way forward is 분석 장치 (CPU), not a restart or a model download.
const verifyGpuUnavailable = async (browser, { width = 1280, reducedMotion = false, verifyHighlight = false } = {}) => {
  const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: reducedMotion ? 'reduce' : 'no-preference' });
  const gpu = { selected: 'cuda' };
  try {
    await page.route('**/api/health', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    await page.route('**/api/models/status', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: gpu.selected !== 'cuda',
        models: [{ key: 'stt_faster_whisper', label: 'Faster Whisper Large v3', required: true, installed: true, downloadable: true }],
        selected_stt_device: gpu.selected,
        stt_device_status: { gpu_detected: true, gpu_usable: false, gpu_reason: 'CUDA 런타임이 준비되지 않았습니다.' },
        errors: gpu.selected === 'cuda' ? ['CUDA 런타임이 준비되지 않았습니다.'] : [],
      }),
    }));
    await page.route('**/api/settings', route => {
      if (route.request().method() === 'PATCH') {
        const device = route.request().postDataJSON()?.stt?.device;
        if (device) gpu.selected = device;
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stt: { device: gpu.selected } }) });
    });
    await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });

    await waitForRowState(page, 'gpu-unavailable');
    assert.deepEqual(await readRow(page), {
      state: 'gpu-unavailable', title: 'GPU를 쓸 수 없습니다', message: null, buttons: ['문제해결'],
    });
    assert.equal(await page.getByRole('button', { name: '모델 받기', exact: true }).count(), 0, 'a GPU problem is not a missing model');
    assert.equal(await page.getByText(/CUDA|DLL/).count(), 0, 'the GPU guidance does not show implementation terms');
    await assertNoOldSurfaces(page);
    await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '설정' });
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.closest('#settings-analysis-device') !== null, undefined, { timeout: 10000 });
    if (verifyHighlight) {
      const target = page.locator('#settings-analysis-device');
      await page.locator('#settings-analysis-device[data-settings-highlighted="true"]').waitFor();
      const before = await target.boundingBox();
      const appearance = await target.evaluate(element => ({ animation: getComputedStyle(element).animationName, overflow: element.scrollWidth - element.clientWidth }));
      assert.equal(appearance.animation, reducedMotion ? 'none' : 'settings-target-highlight', 'reduced motion uses a static highlight');
      assert.equal(appearance.overflow, 0, 'the compact target keeps its control visible');
      if (process.env.SETTINGS_TARGET_SCREENSHOTS) {
        await mkdir(process.env.SETTINGS_TARGET_SCREENSHOTS, { recursive: true });
        await dialog.screenshot({ path: `${process.env.SETTINGS_TARGET_SCREENSHOTS}/device-${width}${reducedMotion ? '-reduced' : ''}.png` });
      }
      await page.waitForFunction(() => document.querySelector('#settings-analysis-device')?.getAttribute('data-settings-highlighted') === 'false');
      assert.deepEqual(await target.boundingBox(), before, 'the highlight starts and ends without moving the setting');
      assert.equal(await page.locator('#settings-analysis-device select').evaluate(element => element === document.activeElement), true, 'highlight expiry preserves keyboard focus');
    }
    await page.locator('#settings-analysis-device select').selectOption('cpu');
    for (let attempt = 0; attempt < 40 && gpu.selected !== 'cpu'; attempt += 1) {
      await page.waitForTimeout(100);
    }
    assert.equal(gpu.selected, 'cpu', 'switching 분석 장치 should save CPU');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await waitForRowState(page, 'ready', 15000);
    assert.deepEqual(await readRow(page), { state: 'ready', title: '', message: null, buttons: [] }, 'normal readiness leaves guidance empty');
    console.log('ok - an unusable GPU points at 분석 장치 and clears after switching to CPU');
  } finally {
    await page.close();
  }
};

// Only the diarization model is missing, and only because 참석자 구분까지 이어서 실행 is on: turning it off is the way.
const verifyDiarizationSettingShortcut = async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  const settings = { duringAnalysis: true };
  try {
    await page.route('**/api/health', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    await page.route('**/api/models/status', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: !settings.duringAnalysis,
        models: [
          { key: 'stt_faster_whisper', label: 'Faster Whisper Large v3', required: true, installed: true, downloadable: true },
          { key: 'diarization', label: 'pyannote', required: settings.duringAnalysis, installed: false, downloadable: false },
        ],
        diarization_generate_during_analysis: settings.duringAnalysis,
        errors: [],
      }),
    }));
    await page.route('**/api/settings', route => {
      if (route.request().method() === 'PATCH') {
        const during = route.request().postDataJSON()?.diarization?.generate_during_analysis;
        if (typeof during === 'boolean') settings.duringAnalysis = during;
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ diarization: { generate_during_analysis: settings.duringAnalysis } }) });
    });
    await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });

    await waitForRowState(page, 'diarization-model-missing');
    assert.deepEqual(await readRow(page), {
      state: 'diarization-model-missing', title: '참석자 구분 모델이 없습니다', message: null, buttons: ['문제해결'],
    });
    assert.equal(await page.getByText('다시 설치', { exact: false }).count(), 0, 'turning one setting off beats reinstalling');
    await assertNoOldSurfaces(page);
    await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).click();
    await page.getByRole('dialog', { name: '설정' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.closest('#settings-analysis-diarization') !== null, undefined, { timeout: 10000 });
    await page.locator('#settings-analysis-diarization input').uncheck();
    for (let attempt = 0; attempt < 40 && settings.duringAnalysis; attempt += 1) {
      await page.waitForTimeout(100);
    }
    assert.equal(settings.duringAnalysis, false, 'the setting should be saved off');
    await page.keyboard.press('Escape');
    await waitForRowState(page, 'ready', 15000);
    console.log('ok - a missing diarization model points at the one setting that unblocks analysis');
  } finally {
    await page.close();
  }
};

// The desktop app names its engine 분석 기능, exposes one recovery action, and leaves normal guidance empty.
const installTauriMock = () => {
  window.__unexpectedTauriCommands = [];
  window.__TAURI__ = {
    core: {
      invoke: async (command) => {
        if (command === 'get_backend_base_url') return 'http://127.0.0.1:17863';
        if (command === 'get_desktop_action_token') return 'desktop-test-token';
        if (command === 'set_close_guard_active' || command === 'write_frontend_log') return undefined;
        window.__unexpectedTauriCommands.push(command);
        return undefined;
      },
    },
  };
};

const verifyDesktopStatusRow = async (browser) => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const engine = { up: false, models: 'missing' };
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  try {
    await page.clock.install();
    await page.addInitScript(installTauriMock);
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/health') return engine.up ? json({ ok: true }) : route.abort('connectionrefused');
      if (path === '/api/models/status') {
        if (engine.models === 'error') return json({ detail: 'models unavailable' }, 500);
        const installed = engine.models === 'ready';
        return json({
          ready: installed,
          models: [{ key: 'stt_faster_whisper', label: 'Faster Whisper Large v3', required: true, installed, downloadable: engine.models === 'missing' }],
          errors: [],
        });
      }
      if (path === '/api/settings') return json({});
      if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
      return json({ detail: 'not used by this scenario' }, 404);
    });
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    await page.getByRole('heading', { name: '새 회의록', exact: true }).waitFor();
    const assertDesktopSurfaces = async () => {
      await assertNoOldSurfaces(page);
      assert.equal(await rowOf(page).getByRole('button', { name: '문제 해결 도움말' }).count(), 0, 'the desktop app has no ?');
      assert.equal(await page.locator('#writer-status-help').count(), 0);
    };

    // Right after the app opens: the engine is still starting.
    await waitForRowState(page, 'readiness-checking');
    assert.deepEqual(await readRow(page), { state: 'readiness-checking', title: '분석 기능 준비 중', message: null, buttons: [] });
    assert.equal(await rowOf(page).locator('.writer-status-busy').count(), 1, 'a grey spinner, not a warning');
    assert.equal(await startButtonOf(page).count(), 0, 'preparing analysis shows no start action');
    await assertDesktopSurfaces();
    // 45s after the app opens without an answer: still starting at 43s, then a warning with one recovery action.
    await page.clock.runFor(43_000);
    assert.equal(await rowOf(page).getAttribute('data-state'), 'readiness-checking', 'no warning before 45s');
    await page.clock.runFor(4_000);
    await waitForRowState(page, 'no-response');
    assert.deepEqual(await readRow(page), {
      state: 'no-response', title: '분석 기능이 아직 준비되지 않았습니다', message: null, buttons: ['문제해결'],
    });
    assert.equal(await page.getByText(LOCAL_ENGINE_NAME, { exact: false }).count(), 0, 'the desktop app does not name the web connection program');
    assert.equal(await startButtonOf(page).count(), 0, 'an unavailable engine offers only its recovery action');
    await assertDesktopSurfaces();
    await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '설정' });
    await settings.waitFor({ state: 'visible', timeout: 10000 });
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });

    // The engine answers on the slow check: models it can download come first.
    engine.up = true;
    await page.clock.runFor(11_000);
    await waitForRowState(page, 'models-missing');
    assert.deepEqual(await readRow(page), {
      state: 'models-missing', title: '모델을 받아야 분석할 수 있습니다', message: null, buttons: ['문제해결'],
    });
    await assertDesktopSurfaces();

    // A model Settings cannot download still offers the runtime's troubleshooting destination.
    engine.models = 'reinstall';
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await waitForRowState(page, 'models-reinstall');
    assert.deepEqual(await readRow(page), {
      state: 'models-reinstall', title: '필요한 모델이 없어 분석을 시작할 수 없습니다', message: null, buttons: ['문제해결'],
    });
    await assertDesktopSurfaces();

    // Readiness cannot be confirmed: offer desktop recovery actions without an unusable analysis action.
    engine.models = 'error';
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await waitForRowState(page, 'readiness-checking');
    await page.clock.runFor(46_000);
    await waitForRowState(page, 'readiness-error');
    assert.deepEqual(await readRow(page), {
      state: 'readiness-error', title: '분석 준비 상태를 확인하지 못했습니다', message: null, buttons: ['문제해결'],
    });
    const errorGeometry = await rowOf(page).evaluate(row => {
      const main = row.closest('.writer-upload-main').getBoundingClientRect();
      const controls = [...row.querySelectorAll('button, a')].map(el => {
        const rect = el.getBoundingClientRect();
        return { label: el.textContent.trim(), left: Math.round(rect.left), right: Math.round(rect.right), top: Math.round(rect.top), bottom: Math.round(rect.bottom), inside: rect.left >= main.left - 1 && rect.right <= main.right + 1 && rect.top >= 0 && rect.bottom <= innerHeight };
      });
      return {
        mainWidth: Math.round(main.width), controls,
        textOverflow: [...row.querySelectorAll('.writer-status-title, .writer-status-message')].map(el => el.scrollWidth - el.clientWidth),
        rowOverflow: row.scrollWidth - row.clientWidth,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    console.log(`desktop readiness-error layout: ${JSON.stringify(errorGeometry)}`);
    if (process.env.WRITER_READINESS_SCREENSHOTS) {
      await mkdir(process.env.WRITER_READINESS_SCREENSHOTS, { recursive: true });
      await page.screenshot({ path: `${process.env.WRITER_READINESS_SCREENSHOTS}/desktop-readiness-error-1440.png`, animations: 'disabled' });
    }
    assert.ok(errorGeometry.controls.every(control => control.inside) && errorGeometry.textOverflow.every(overflow => overflow <= 1)
      && errorGeometry.rowOverflow <= 1 && errorGeometry.documentOverflow <= 0,
    `recovery controls and status must fit the wide upload column: ${JSON.stringify(errorGeometry)}`);
    await assertDesktopSurfaces();
    // The single desktop recovery action opens the restart section, rather than rechecking from the writer.
    engine.up = false;
    await page.evaluate(() => {
      window.__readinessEvents = 0;
      window.addEventListener('focus', () => { window.__readinessEvents += 1; });
      window.addEventListener('analysis:settings-updated', () => { window.__readinessEvents += 1; });
    });
    await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).click();
    await settings.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.closest('#settings-troubleshooting') !== null);
    engine.up = true;
    engine.models = 'ready';
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });
    await page.clock.runFor(3_000);

    // Nothing blocked, but no file yet: reserve the action area without showing analysis start.
    await waitForRowState(page, 'ready');
    assert.equal(await page.evaluate(() => window.__readinessEvents), 1, 'the settings update starts the readiness check without a writer retry button');
    assert.deepEqual(await readRow(page), { state: 'ready', title: '', message: null, buttons: [] });
    assert.equal((await statusOf(page).innerText()).trim(), '');
    assert.equal(await statusOf(page).locator('.writer-status-icon').count(), 0);
    assert.equal(Math.round((await rowOf(page).locator('.writer-action-buttons').boundingBox()).height), 40, 'empty actions retain their reserved height');
    assert.equal(await statusOf(page).getByText('이 PC와 연결됨', { exact: true }).count(), 0);
    assert.equal(await startButtonOf(page).count(), 0, 'readiness alone does not show analysis start');
    await assertDesktopSurfaces();

    // With a file selected, missing meeting details remain recoverable through the available analysis action.
    await page.setInputFiles('#meeting-file-input', {
      name: 'desktop-readiness.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('desktop readiness fixture'),
    });
    await page.locator('#meeting-title').fill('');
    await page.getByLabel('회의 목적', { exact: true }).fill('');
    assert.equal(await isStartBlocked(page), false);
    await startButtonOf(page).click();
    await waitForRowState(page, 'required-fields');
    assert.deepEqual(await readRow(page), {
      state: 'required-fields', title: '필수 항목이 비어 있습니다', message: null, buttons: ['문제해결'],
    });
    await page.waitForFunction(() => document.activeElement?.id === 'meeting-title');
    assert.equal(await page.locator('#writer-form-error').count(), 1, 'one list, in the status line');
    assert.equal(await page.locator('#writer-form-error').textContent(), '회의 제목, 회의 목적');
    assert.match(await page.locator('#writer-form-error').getAttribute('class'), /(?:^|\s)sr-only(?:\s|$)/, 'the required-field list stays available to assistive technology without visible helper copy');
    assert.equal(await page.locator('#meeting-title').getAttribute('aria-describedby'), 'writer-form-error');
    await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'meeting-title');
    await page.locator('#meeting-title').fill('데스크톱 상태 줄');
    await page.waitForFunction(() => document.querySelector('#writer-form-error')?.textContent === '회의 목적');
    assert.equal(await page.locator('#meeting-title').getAttribute('aria-describedby'), null);
    await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'meeting-purpose');
    await assertDesktopSurfaces();
    assert.deepEqual(await page.evaluate(() => window.__unexpectedTauriCommands), []);
    assert.deepEqual(errors, []);
    console.log('ok - desktop status row: preparation, one recovery action, models, reinstall, readiness error, empty when ready, required-field focus');
  } finally {
    await context.close();
  }
};

const verifyConnectedReinstall = async browser => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  let modelInstalled = false;
  let failModelStatus = false;
  let modelRecoveryGate = null;
  let releaseModelRecovery;
  await page.addInitScript(() => {
    localStorage.setItem('localProcessingIntroSeen', '1');
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = value => value?.name === 'loopback-network'
      ? Promise.resolve({ state: 'granted' }) : query(value);
  });
  const grant = { session_token: 'connected-reinstall-regression-token', expires_at: Math.floor(Date.now() / 1000) + 3600,
    capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (data, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(data) });
    if (path === '/api/probe') return json({ product_id: 'barorok-local-engine', engine_version: 'test', api_contract_version: 1,
      capabilities: grant.capabilities, auth_state: 'pairing-required', pairing_available: true, pairing_mode: 'browser-connection', update_required: false });
    if (path === '/api/pair/start') return json({ mode: 'browser-connection', pairing_id: 'repair-challenge', expires_in_seconds: 120 });
    if (path === '/api/pair/complete' || path === '/api/pair/restore') return json(grant);
    if (path === '/api/health') return json({ ok: true });
    if (path === '/api/models/status') {
      if (route.request().headers().authorization !== `Bearer ${grant.session_token}`) return json({}, 401);
      if (failModelStatus) {
        return json({ detail: 'temporary model status failure' }, 503);
      }
      if (modelRecoveryGate) await modelRecoveryGate;
      return json({ ready: modelInstalled, models: [{ key: 'stt_faster_whisper', required: true, installed: modelInstalled, downloadable: false }], errors: [] });
    }
    if (path === '/api/settings') return json({});
    if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
    return json({}, 404);
  });
  try {
    const url = new URL(APP_URL);
    url.searchParams.set('localEngineConnection', '1');
    await page.goto(url.toString(), { waitUntil: 'domcontentloaded' });
    await waitForRowState(page, 'models-reinstall');
    await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).click();
    const recovery = page.locator('#settings-troubleshooting');
    const dialog = page.getByRole('dialog', { name: '설정', exact: true });
    assert.equal(await dialog.getByRole('heading', { name: '연결 문제 해결', exact: true }).count(), 1, 'the recovery page has one heading');
    await recovery.getByText('필수 모델 파일 복구', { exact: true }).waitFor();
    assert.match(await recovery.innerText(), /다시 설치해 주세요/);
    assert.equal(await recovery.getByRole('button', { name: '모델 설정 열기' }).count(), 0, 'a non-downloadable missing model must not loop back to model settings');
    assert.equal(await recovery.getByRole('link').count(), 0, 'this repair fixture requires no configured installer or update URL');
    await recovery.getByRole('button', { name: '설치 파일 문의', exact: true }).click();
    await dialog.getByText('문의사항은 아래 이메일로 연락주세요.', { exact: true }).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '문의 연락처 보기', exact: true }).getAttribute('aria-expanded'), 'true', 'repair support opens the existing contact panel');
    assert.equal(await dialog.locator('a[href^="mailto:"]').count(), 1, 'installation support exposes the real contact email action');
    await dialog.getByRole('button', { name: '문의 연락처 닫기', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '설치 파일 문의');
    assert.equal(await rowOf(page).locator('.writer-status-message, .writer-status-help-toggle').count(), 0);
    modelRecoveryGate = new Promise(resolve => { releaseModelRecovery = resolve; });
    failModelStatus = true;
    await refreshModelsOnFocus(page);
    await dialog.getByText('모델 상태를 확인하지 못했습니다.', { exact: false }).first().waitFor();
    failModelStatus = false;
    await recovery.getByText('필수 모델 파일 복구', { exact: true }).waitFor();
    assert.match(await recovery.innerText(), /다시 설치해 주세요/, 'a temporary model-status failure must retain the last confirmed repair guidance');
    assert.equal(await recovery.getByRole('button', { name: '모델 설정 열기' }).count(), 0, 'a failed refresh must not revive the model-settings loop');
    await recovery.getByRole('button', { name: '설치 파일 문의', exact: true }).click();
    await dialog.getByRole('button', { name: '문의 연락처 닫기', exact: true }).waitFor();
    modelInstalled = true;
    modelRecoveryGate = null;
    releaseModelRecovery();
    await waitForRowState(page, 'ready', 20000);
    await recovery.getByText('연결이 확인되었습니다', { exact: true }).waitFor({ timeout: 15000 });
    assert.equal(await recovery.getByText('필수 모델 파일 복구', { exact: true }).count(), 0, 'a successful installed-model response clears the repair requirement');
    assert.equal(await recovery.getByRole('button', { name: '설치 파일 문의', exact: true }).count(), 0, 'successful recovery removes the original contact opener');
    await dialog.getByRole('button', { name: '문의 연락처 닫기', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'settings-troubleshooting');
    assert.equal(await dialog.getByRole('button', { name: '문의 연락처 보기', exact: true }).getAttribute('aria-expanded'), 'false', 'closing contact after its opener disappeared restores focus to connection recovery');
    await recovery.getByRole('button', { name: '작성 화면으로 돌아가기', exact: true }).click();
    await dialog.waitFor({ state: 'detached' });
    assert.equal(await startButtonOf(page).count(), 0, 'returning without a selected file does not expose analysis start');
    console.log('ok - authenticated engine retains reinstall guidance through a failed model check and clears it after verified repair');
  } finally { releaseModelRecovery?.(); await page.close(); }
};

// A connected engine can still need a model or device fix; recovery must reflect actual analysis readiness.
const verifyRecoveryCompletion = async browser => {
  for (const scenario of ['gpu', 'diarization', 'downloadable', 'other', 'ready', 'update']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const state = { mode: scenario === 'update' ? 'ready' : 'reinstall', device: scenario === 'gpu' ? 'cuda' : 'cpu',
      diarizationDuringAnalysis: scenario === 'diarization', deviceUpdates: 0, diarizationUpdates: 0, analysisRequests: 0 };
    const errors = [];
    let modelRefreshGate = null;
    let releaseModelRefresh;
    let markModelRefreshHeld;
    page.on('pageerror', error => errors.push(error.message));
    await page.addInitScript(() => {
      localStorage.setItem('localProcessingIntroSeen', '1');
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = value => value?.name === 'loopback-network'
        ? Promise.resolve({ state: 'granted' }) : query(value);
    });
    const grant = { session_token: `recovery-completion-${scenario}-session-token`, expires_at: Math.floor(Date.now() / 1000) + 3600,
      capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] };
    await page.route('**/api/**', async route => {
      const path = new URL(route.request().url()).pathname;
      const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
      if (path === '/api/probe') return json({ product_id: 'barorok-local-engine', engine_version: 'test', api_contract_version: 1,
        capabilities: grant.capabilities, auth_state: 'pairing-required', pairing_available: true, pairing_mode: 'browser-connection', update_required: scenario === 'update' });
      if (path === '/api/pair/start') return json({ mode: 'browser-connection', pairing_id: `recovery-${scenario}-challenge`, expires_in_seconds: 120 });
      if (path === '/api/pair/complete' || path === '/api/pair/restore') return json(grant);
      if (path === '/api/health') return json({ ok: true });
      if (path === '/api/settings') {
        if (route.request().method() === 'PATCH') {
          const device = route.request().postDataJSON()?.stt?.device;
          if (device) { state.device = device; state.deviceUpdates += 1; }
          const diarization = route.request().postDataJSON()?.diarization?.generate_during_analysis;
          if (typeof diarization === 'boolean') { state.diarizationDuringAnalysis = diarization; state.diarizationUpdates += 1; }
        }
        return json({ stt: { device: state.device }, diarization: { generate_during_analysis: state.diarizationDuringAnalysis } });
      }
      if (path === '/api/models/status') {
        if (scenario !== 'update' && route.request().headers().authorization !== `Bearer ${grant.session_token}`) return json({}, 401);
        if (modelRefreshGate && state.mode === 'diarization' && !state.diarizationDuringAnalysis) {
          markModelRefreshHeld();
          await modelRefreshGate;
        }
        const installed = !['reinstall', 'downloadable'].includes(state.mode);
        const gpuUnavailable = state.mode === 'gpu' && state.device === 'cuda';
        return json({
          ready: installed && !gpuUnavailable && state.mode !== 'other' && !(state.mode === 'diarization' && state.diarizationDuringAnalysis),
          models: [{ key: 'stt_faster_whisper', required: true, installed, downloadable: state.mode === 'downloadable' },
            ...(state.mode === 'diarization' ? [{ key: 'diarization', required: state.diarizationDuringAnalysis, installed: false, downloadable: false }] : [])],
          diarization_generate_during_analysis: state.diarizationDuringAnalysis,
          selected_stt_device: state.device,
          stt_device_status: { gpu_usable: !gpuUnavailable },
          errors: gpuUnavailable ? ['GPU unavailable'] : state.mode === 'other' ? ['분석 환경 점검이 필요합니다.'] : [],
        });
      }
      if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
      if (path === '/api/analyze') { state.analysisRequests += 1; return json({ detail: 'recovery must not start analysis' }, 500); }
      return json({}, 404);
    });
    try {
      const url = new URL(APP_URL);
      url.searchParams.set('localEngineConnection', '1');
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
      await waitForRowState(page, scenario === 'update' ? 'update-required' : 'models-reinstall');
      await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).click();
      const dialog = page.getByRole('dialog', { name: '설정', exact: true });
      const recovery = dialog.locator('#settings-troubleshooting');
      await recovery.waitFor();
      if (scenario === 'update') {
        assert.equal(await recovery.getByRole('link').count(), 0, 'this update fixture requires no configured installer or update URL');
        await recovery.getByRole('button', { name: '설치 파일 문의', exact: true }).click();
        await dialog.getByText('문의사항은 아래 이메일로 연락주세요.', { exact: true }).waitFor();
        assert.equal(await dialog.getByRole('button', { name: '문의 연락처 보기', exact: true }).getAttribute('aria-expanded'), 'true', 'missing update URLs lead to the existing contact panel');
        assert.equal(await dialog.locator('a[href^="mailto:"]').count(), 1, 'missing update URLs expose a real contact email action');
        await page.keyboard.press('Escape');
        await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '설치 파일 문의');
        assert.equal(await dialog.isVisible(), true, 'Escape closes contact without leaving the recovery page');
      } else {
        await recovery.getByText('필수 모델 파일 복구', { exact: true }).waitFor();
        state.mode = scenario;
        await refreshModelsOnFocus(page);
        await waitForRowState(page, scenario === 'gpu' ? 'gpu-unavailable' : scenario === 'diarization' ? 'diarization-model-missing' : scenario === 'downloadable' ? 'models-missing' : scenario === 'other' ? 'readiness-blocked' : 'ready');
        if (scenario === 'gpu') {
          await recovery.getByText('분석 장치를 변경해 주세요', { exact: true }).waitFor();
          assert.equal(await recovery.getByText('연결이 확인되었습니다', { exact: true }).count(), 0, 'connection alone does not claim analysis is ready while the GPU is unusable');
          await recovery.getByRole('button', { name: '분석 장치 설정', exact: true }).click();
          await dialog.locator('#settings-analysis-device[data-settings-highlighted="true"]').waitFor();
          await page.waitForFunction(() => document.activeElement?.closest('#settings-analysis-device') !== null);
          await dialog.locator('#settings-analysis-device select').selectOption('cpu');
          await waitForRowState(page, 'ready', 15000);
          assert.equal(state.device, 'cpu');
          assert.ok(state.deviceUpdates > 0, 'the recovery control saves the CPU setting');
        } else if (scenario === 'diarization') {
          await recovery.getByText('참석자 구분 설정을 변경해 주세요', { exact: true }).waitFor();
          await recovery.getByRole('button', { name: '참석자 구분 설정', exact: true }).click();
          await dialog.locator('#settings-analysis-diarization[data-settings-highlighted="true"]').waitFor();
          await page.waitForFunction(() => document.activeElement?.closest('#settings-analysis-diarization') !== null);
          const refreshHeld = new Promise(resolve => { markModelRefreshHeld = resolve; });
          modelRefreshGate = new Promise(resolve => { releaseModelRefresh = resolve; });
          await dialog.locator('#settings-analysis-diarization input[type="checkbox"]').uncheck();
          await refreshHeld;
          assert.equal(state.diarizationDuringAnalysis, false, 'the setting is saved before updated model status arrives');
          assert.equal(await recovery.getByText('필수 모델 파일 복구', { exact: true }).count(), 0, 'stale required diarization metadata does not show reinstall guidance after follow-up diarization is disabled');
          assert.equal(await recovery.getByRole('button', { name: '설치 파일 문의', exact: true }).count(), 0, 'the pending model refresh must not revive installation support for a skipped model');
          modelRefreshGate = null;
          releaseModelRefresh();
          await waitForRowState(page, 'ready', 15000);
          assert.equal(state.diarizationDuringAnalysis, false);
          assert.ok(state.diarizationUpdates > 0, 'the recovery control saves disabling follow-up diarization');
        } else if (scenario === 'downloadable' || scenario === 'other') {
          await recovery.getByText(scenario === 'downloadable' ? '분석 모델을 준비해 주세요' : '분석 준비를 확인해 주세요', { exact: true }).waitFor();
          assert.equal(await recovery.getByText('연결이 확인되었습니다', { exact: true }).count(), 0, 'remaining readiness problems are not presented as complete recovery');
          await recovery.getByRole('button', { name: '모델 설정 열기', exact: true }).click();
          await dialog.locator('#settings-analysis-models[data-settings-highlighted="true"]').waitFor();
          assert.equal(await dialog.getByRole('tab').count(), 0, 'model recovery uses the integrated settings without a tab switch');
          await dialog.locator('#settings-general-panel').waitFor();
          await page.waitForFunction(() => document.activeElement?.closest('#settings-analysis-models') !== null);
          state.mode = 'ready';
          await refreshModelsOnFocus(page);
          await waitForRowState(page, 'ready');
        }
        await recovery.getByText('연결이 확인되었습니다', { exact: true }).waitFor();
        await recovery.getByRole('button', { name: '작성 화면으로 돌아가기', exact: true }).click();
        await dialog.waitFor({ state: 'detached' });
        assert.equal(await startButtonOf(page).count(), 0, 'returning without a file keeps analysis start hidden');
      }
      assert.equal(state.analysisRequests, 0, `${scenario}: recovery does not submit analysis`);
      assert.deepEqual(errors, [], `${scenario}: no uncaught UI errors`);
      console.log(`ok - recovery completion: ${scenario}`);
    } finally { releaseModelRefresh?.(); await page.close(); }
  }
};

// Web failures open a recovery destination and reconnect automatically.
const verifyDevelopmentReadinessError = async (browser, viewport = { width: 1280, height: 900 }) => {
  const page = await browser.newPage({ viewport });
  let modelsUp = false;
  try {
    await page.clock.install();
    await page.route('**/api/health', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    await page.route('**/api/models/status', route => (modelsUp
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true, models: [], errors: [] }) })
      : route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'models unavailable' }) })));
    await page.route('**/api/settings', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }));
    await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    await waitForRowState(page, 'readiness-checking');
    await page.clock.runFor(46_000);
    await waitForRowState(page, 'readiness-error');
    assert.deepEqual(await readRow(page), {
      state: 'readiness-error', title: '분석 준비 상태를 확인하지 못했습니다', message: null, buttons: ['문제해결'],
    });
    assert.equal(await rowOf(page).getByRole('button', { name: '다시 확인', exact: true }).count(), 0);
    await page.clock.runFor(6_000);
    await waitForRowState(page, 'readiness-error');
    assert.equal(await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).count(), 1, 'a persistent error keeps its recovery action during automatic checks');
    assert.equal(await startButtonOf(page).count(), 0, 'readiness errors show recovery instead of analysis start');
    const anchors = () => page.evaluate(() => Object.fromEntries(['.writer-header', '.writer-upload-section', '.writer-action-buttons', '.writer-privacy', '.recent-meetings'].map(selector => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return [selector, { x: box.x, y: box.y, width: box.width, height: box.height }];
    })));
    const before = await anchors();
    const recovery = rowOf(page).getByRole('button', { name: '문제해결', exact: true });
    await recovery.click();
    const settings = page.getByRole('dialog', { name: '설정', exact: true });
    await settings.getByRole('heading', { name: '연결 문제 해결', exact: true }).waitFor();
    await page.waitForFunction(() => document.activeElement?.id === 'settings-troubleshooting');
    assert.deepEqual(await anchors(), before, 'opening the recovery destination does not move the work surface');
    await settings.getByRole('button', { name: '설정 닫기', exact: true }).press('Escape');
    await settings.waitFor({ state: 'hidden' });
    assert.equal(await recovery.evaluate(el => el === document.activeElement), true, 'recovery returns focus to its opener');
    modelsUp = true;
    await page.clock.runFor(6_000);
    await waitForRowState(page, 'ready');
    assert.deepEqual(await readRow(page), { state: 'ready', title: '', message: null, buttons: [] });
    assert.equal(await startButtonOf(page).count(), 0, 'automatic recovery without a selected file does not show analysis start');
    assert.deepEqual(await anchors(), before, 'automatic recovery keeps the same layout anchors without a retry click');
    await assertNoOldSurfaces(page);
    console.log('ok - recovery opens actionable Settings and failed readiness recovers automatically');
  } finally {
    await page.close();
  }
};

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    if (process.env.WRITER_READINESS_SCENARIO === 'settings-targets') {
      await verifyGpuUnavailable(browser, { width: 1440, verifyHighlight: true });
      await verifyGpuUnavailable(browser, { width: 860, verifyHighlight: true });
      await verifyGpuUnavailable(browser, { width: 860, reducedMotion: true, verifyHighlight: true });
      return;
    }
    if (process.env.WRITER_READINESS_SCENARIO === 'recovery-completion') {
      await verifyRecoveryCompletion(browser);
      return;
    }
    if (process.env.WRITER_READINESS_SCENARIO === 'reinstall') {
      await verifyConnectedReinstall(browser);
      return;
    }
    if (process.env.WRITER_READINESS_SCENARIO === 'help-stability') {
      for (const width of [1440, 1024, 860]) await verifyDevelopmentReadinessError(browser, { width, height: 900 });
      return;
    }
    if (process.env.WRITER_READINESS_SCENARIO === 'desktop') {
      await verifyDesktopStatusRow(browser);
      return;
    }
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const state = await installRoutes(page);
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });

    // One uniform recovery action opens model preparation without an unusable analysis action.
    await waitForRowState(page, 'models-missing');
    assert.deepEqual(await readRow(page), {
      state: 'models-missing', title: '모델을 받아야 분석할 수 있습니다', message: null, buttons: ['문제해결'],
    });
    assert.equal(await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '모델 준비', exact: true }).count(), 0);
    assert.equal(await page.getByText('models 폴더', { exact: false }).count(), 0, 'the writer should not mention the models folder');
    assert.equal(await startButtonOf(page).count(), 0, 'missing models show only their recovery action');
    await assertNoOldSurfaces(page);

    await page.getByLabel('회의 목적', { exact: true }).fill('모델 미준비 상태에서 시작 차단 확인');
    await page.setInputFiles('#meeting-file-input', {
      name: '준비 상태 확인.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('readiness fixture'),
    });
    assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), '준비 상태 확인');
    assert.equal(await startButtonOf(page).count(), 0, 'selecting a file does not show analysis start while required models are missing');
    await assertNoOldSurfaces(page);

    await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).click();
    const integratedSettings = page.locator('#settings-general-panel');
    await integratedSettings.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.getByRole('dialog').getByRole('tab').count(), 0, 'model guidance opens integrated settings');
    await page.waitForFunction(() => document.activeElement?.closest('#settings-analysis-models') !== null);
    // The card title and the model row both read 음성 인식 모델 once the status has loaded.
    await integratedSettings.locator('#settings-analysis-models').getByText('음성 인식 모델', { exact: true }).first().waitFor({ state: 'visible', timeout: 10000 });

    await page.keyboard.press('Escape');
    await page.getByRole('dialog').waitFor({ state: 'detached' });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '문제해결');

    const prepareModel = async () => {
      await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.locator('#settings-analysis-models').waitFor();
      state.ready = true;
      await refreshModelsOnFocus(page);
      await waitForRowState(page, 'ready');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    };
    await prepareModel();
    await page.waitForFunction(() => document.activeElement?.classList.contains('writer-start-button'));
    assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), '준비 상태 확인');
    assert.equal(await page.getByLabel('회의 목적', { exact: true }).inputValue(), '모델 미준비 상태에서 시작 차단 확인');
    assert.equal(await page.locator('#meeting-file-input').evaluate(input => input.files?.[0]?.name), '준비 상태 확인.mp3');
    // Ready: normal guidance stays empty beside the enabled start action.
    assert.deepEqual(await readRow(page), { state: 'ready', title: '', message: null, buttons: [] });
    assert.equal(await statusOf(page).locator('.writer-status-icon').count(), 0, 'normal readiness has no decorative status icon');
    assert.equal(Math.round((await rowOf(page).locator('.writer-action-buttons').boundingBox()).height), 40, 'normal readiness retains the reserved action height');
    assert.equal(await isStartBlocked(page), false);
    assert.equal(await statusOf(page).getAttribute('role'), 'status');

    await page.getByRole('button', { name: '준비 상태 확인.mp3 제거', exact: true }).click();
    assert.equal(await startButtonOf(page).count(), 0, 'removing the file removes analysis start');
    state.ready = false;
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await waitForRowState(page, 'models-missing');
    assert.equal(await startButtonOf(page).count(), 0, 'model recovery without a file still has no analysis action');
    await prepareModel();
    await page.waitForFunction(() => document.activeElement?.classList.contains('file-drop-zone'));

    // A download that finishes while Settings is closed clears the line on the writer's own slow check: no focus or
    // settings event is sent, and the line clears within one slow interval.
    state.ready = false;
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await rowOf(page).getByRole('button', { name: '문제해결', exact: true }).waitFor({ timeout: 10000 });
    await page.evaluate(() => {
      window.__readinessEvents = 0;
      window.addEventListener('focus', () => { window.__readinessEvents += 1; });
      window.addEventListener('analysis:settings-updated', () => { window.__readinessEvents += 1; });
    });
    state.ready = true;
    await waitForRowState(page, 'ready', 20000);
    assert.equal(await page.evaluate(() => window.__readinessEvents), 0, 'the slow check cleared the line without any event');

    // If Settings cannot download a model, the same recovery label opens connection/install guidance.
    state.ready = false;
    state.downloadable = false;
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await waitForRowState(page, 'models-reinstall');
    assert.deepEqual(await readRow(page), {
      state: 'models-reinstall',
      title: '필요한 모델이 없어 분석을 시작할 수 없습니다',
      message: null,
      buttons: ['문제해결'],
    }, 're-checking cannot install a model Settings cannot download');
    assert.equal(await page.getByRole('button', { name: '모델 받기', exact: true }).count(), 0, 'no 모델 받기 for a model Settings cannot download');
    assert.equal(await page.getByText('모델 받기를 누르면', { exact: false }).count(), 0);
    await assertNoOldSurfaces(page);

    await verifyWebSettingsRecovery(browser);
    await verifyGpuUnavailable(browser);
    await verifyDiarizationSettingShortcut(browser);
    await verifyRecoveryCompletion(browser);
    await verifyDevelopmentReadinessError(browser);
    await verifyDesktopStatusRow(browser);
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
