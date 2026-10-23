import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BRAND_NAME, LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';

// The development UI's action row (design.md 동작 줄 v2): one status line beside 분석 시작, no banners.
const rowOf = page => page.locator('.writer-action-row');
const statusOf = page => page.locator('#writer-local-engine-requirement');
const waitForRowState = (page, state, timeout = 10000) => page.waitForFunction(
  expected => document.querySelector('.writer-action-row')?.getAttribute('data-state') === expected, state, { timeout },
);
const readRow = async page => ({
  state: await rowOf(page).getAttribute('data-state'),
  title: (await statusOf(page).locator('.writer-status-title').allInnerTexts())[0] ?? '',
  message: (await statusOf(page).locator('.writer-status-message').allInnerTexts())[0] ?? null,
  buttons: (await rowOf(page).locator('.writer-action-buttons > :is(button, a):not(.writer-start-button)').allInnerTexts()).map(text => text.trim()),
});
const startButtonOf = page => page.locator('.writer-start-button');
const isStartBlocked = async page => (await startButtonOf(page).getAttribute('aria-disabled')) === 'true';
// None of the old surfaces: no 준비 필요 label, no readiness or form banner, no second hint line.
const assertNoOldSurfaces = async page => {
  assert.equal(await page.getByRole('button', { name: '준비 필요', exact: true }).count(), 0, 'no 준비 필요 label');
  assert.equal(await page.locator('.status-banner').count(), 0, 'no banner under the form');
  assert.equal(await page.locator('#writer-readiness-hint, #writer-engine-checking, .writer-action-bar').count(), 0, 'no old action bar lines');
  assert.equal(await startButtonOf(page).getAttribute('aria-describedby'), 'writer-local-engine-requirement', 'the status line is the only description');
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
  try {
    await page.route('**/api/health', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) }));
    await page.route('**/api/models/status', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, models: [], errors: [] }),
    }));
    await page.route('**/api/settings', route => (settingsUp
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) })
      : route.fulfill({ status: 500, contentType: 'application/json', body: JSON.stringify({ detail: 'settings unavailable' }) })));
    await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });

    await page.getByRole('complementary').getByRole('button', { name: '설정' }).click();
    const dialog = page.getByRole('dialog', { name: '설정' });
    await dialog.getByText(`설정을 불러오지 못했습니다. 잠시 후 자동으로 다시 확인합니다. 계속 실패하면 ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인해 주세요.`, { exact: true })
      .waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await dialog.getByText('재시작', { exact: false }).count(), 0, 'the web app must not point at the desktop-only 재시작');
    settingsUp = true;
    await dialog.getByRole('button', { name: '다시 확인', exact: true }).click();
    await dialog.getByText('설정을 불러오지 못했습니다.', { exact: false }).waitFor({ state: 'hidden', timeout: 10000 });
    assert.equal(await dialog.getByText('불러오지 못함', { exact: true }).count(), 0, 'settings load after 다시 확인');
    console.log(`ok - web settings failure points at ${LOCAL_ENGINE_NAME} and rechecks`);
  } finally {
    await page.close();
  }
};

// GPU selected but unusable, models present: the way forward is 분석 장치 (CPU), not a restart or a model download.
const verifyGpuUnavailable = async (browser) => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
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
      state: 'gpu-unavailable', title: 'GPU를 쓸 수 없습니다', message: '분석 장치를 CPU로 바꿔 주세요.', buttons: ['분석 장치 설정'],
    });
    assert.equal(await page.getByRole('button', { name: '모델 받기', exact: true }).count(), 0, 'a GPU problem is not a missing model');
    assert.equal(await page.getByText(/CUDA|DLL/).count(), 0, 'the GPU guidance does not show implementation terms');
    await assertNoOldSurfaces(page);
    await rowOf(page).getByRole('button', { name: '분석 장치 설정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '설정' });
    await dialog.waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.closest('#settings-analysis-device') !== null, undefined, { timeout: 10000 });
    await page.locator('#settings-analysis-device select').selectOption('cpu');
    for (let attempt = 0; attempt < 40 && gpu.selected !== 'cpu'; attempt += 1) {
      await page.waitForTimeout(100);
    }
    assert.equal(gpu.selected, 'cpu', 'switching 분석 장치 should save CPU');
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'detached' });
    await waitForRowState(page, 'ready', 15000);
    assert.deepEqual(await readRow(page), { state: 'ready', title: '이 PC와 연결됨', message: null, buttons: [] }, 'readiness is shown beside the primary action');
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
      state: 'diarization-model-missing', title: '참석자 구분 모델이 없습니다', message: '이어서 실행을 끄면 대화록부터 만들 수 있습니다.', buttons: ['참석자 구분 설정'],
    });
    assert.equal(await page.getByText('다시 설치', { exact: false }).count(), 0, 'turning one setting off beats reinstalling');
    await assertNoOldSurfaces(page);
    await rowOf(page).getByRole('button', { name: '참석자 구분 설정', exact: true }).click();
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

// The desktop app: no connection step, its engine is 분석 기능, 문제 해결 replaces `?`, the reinstall names the app
// itself without a link, and once nothing is blocked the line is empty (design.md 동작 줄 v2, Figma 17:962).
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
    assert.equal(await isStartBlocked(page), true);
    await assertDesktopSurfaces();
    // 45s after the app opens without an answer: still starting at 43s, then the warning with 문제 해결.
    await page.clock.runFor(43_000);
    assert.equal(await rowOf(page).getAttribute('data-state'), 'readiness-checking', 'no warning before 45s');
    await page.clock.runFor(4_000);
    await waitForRowState(page, 'no-response');
    assert.deepEqual(await readRow(page), {
      state: 'no-response', title: '분석 기능이 아직 준비되지 않았습니다', message: '첫 실행은 몇 분 걸릴 수 있습니다.', buttons: ['문제 해결'],
    });
    assert.equal(await page.getByText(LOCAL_ENGINE_NAME, { exact: false }).count(), 0, 'the desktop app does not name the web connection program');
    assert.equal(await isStartBlocked(page), true);
    await assertDesktopSurfaces();
    await rowOf(page).getByRole('button', { name: '문제 해결', exact: true }).click();
    const settings = page.getByRole('dialog', { name: '설정' });
    await settings.waitFor({ state: 'visible', timeout: 10000 });
    await page.keyboard.press('Escape');
    await settings.waitFor({ state: 'detached' });

    // The engine answers on the slow check: models it can download come first.
    engine.up = true;
    await page.clock.runFor(11_000);
    await waitForRowState(page, 'models-missing');
    assert.deepEqual(await readRow(page), {
      state: 'models-missing', title: '모델을 받아야 분석할 수 있습니다', message: '음성 인식', buttons: ['모델 받기'],
    });
    await assertDesktopSurfaces();

    // A model Settings cannot download: the whole app is reinstalled, and there is no link to offer.
    engine.models = 'reinstall';
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await waitForRowState(page, 'models-reinstall');
    assert.deepEqual(await readRow(page), {
      state: 'models-reinstall', title: '필요한 모델이 없어 분석을 시작할 수 없습니다', message: `${withJosa(BRAND_NAME, '을/를')} 다시 설치해 주세요.`, buttons: [],
    });
    await assertDesktopSurfaces();

    // Readiness cannot be confirmed: 문제 해결 where the web shows ?, with 다시 확인 beside 분석 시작.
    engine.models = 'error';
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await waitForRowState(page, 'readiness-checking');
    await page.clock.runFor(46_000);
    await waitForRowState(page, 'readiness-error');
    assert.deepEqual(await readRow(page), {
      state: 'readiness-error', title: '분석 준비 상태를 확인하지 못했습니다', message: '잠시 뒤 다시 확인해 주세요.', buttons: ['문제 해결', '다시 확인'],
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
    // 다시 확인 while the engine is gone: the check keeps running, so the row clears on its own once the engine
    // answers, without a window focus or settings event (the warning that follows offers only 문제 해결).
    engine.up = false;
    await page.evaluate(() => {
      window.__readinessEvents = 0;
      window.addEventListener('focus', () => { window.__readinessEvents += 1; });
      window.addEventListener('analysis:settings-updated', () => { window.__readinessEvents += 1; });
    });
    await rowOf(page).getByRole('button', { name: '다시 확인', exact: true }).click();
    await waitForRowState(page, 'readiness-checking');
    engine.up = true;
    engine.models = 'ready';
    await page.clock.runFor(3_000);

    // Nothing blocked: normal readiness stays beside the primary action at 40px.
    await waitForRowState(page, 'ready');
    assert.equal(await page.evaluate(() => window.__readinessEvents), 0, 'the restarted check found the engine by itself');
    assert.deepEqual(await readRow(page), { state: 'ready', title: '이 PC와 연결됨', message: null, buttons: [] });
    assert.equal((await statusOf(page).innerText()).trim(), '이 PC와 연결됨');
    assert.equal(await statusOf(page).locator('.writer-status-icon').count(), 1);
    assert.equal(Math.round((await rowOf(page).boundingBox()).height), 40);
    assert.equal(await statusOf(page).getByText('이 PC와 연결됨', { exact: true }).count(), 1);
    assert.equal(await isStartBlocked(page), false);
    await assertDesktopSurfaces();

    // Required fields: 분석 시작 stays on; pressing it lists what is left and focuses the first empty field.
    await startButtonOf(page).click();
    await waitForRowState(page, 'required-fields');
    assert.deepEqual(await readRow(page), {
      state: 'required-fields', title: '필수 항목이 비어 있습니다', message: '회의 제목, 회의 목적, 영상·음성 파일', buttons: [],
    });
    await page.waitForFunction(() => document.activeElement?.id === 'meeting-title');
    assert.equal(await page.locator('#writer-form-error').count(), 1, 'one list, in the status line');
    assert.equal(await page.locator('#meeting-title').getAttribute('aria-describedby'), 'writer-form-error');
    await page.locator('#meeting-title').fill('데스크톱 상태 줄');
    await page.waitForFunction(() => document.querySelector('#writer-form-error')?.textContent === '회의 목적, 영상·음성 파일');
    assert.equal(await page.locator('#meeting-title').getAttribute('aria-describedby'), null);
    await assertDesktopSurfaces();
    assert.deepEqual(await page.evaluate(() => window.__unexpectedTauriCommands), []);
    assert.deepEqual(errors, []);
    console.log('ok - desktop status row: 분석 기능 준비 중, 45s 문제 해결, models, reinstall, readiness error, connected when ready, required fields');
  } finally {
    await context.close();
  }
};

// The development UI speaks as the web app where the desktop app differs: `?` instead of 문제 해결.
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
    assert.equal((await readRow(page)).title, '분석 준비 확인 중');
    await page.clock.runFor(46_000);
    await waitForRowState(page, 'readiness-error');
    assert.deepEqual(await readRow(page), {
      state: 'readiness-error', title: '분석 준비 상태를 확인하지 못했습니다', message: '잠시 뒤 다시 확인해 주세요.', buttons: ['다시 확인'],
    });
    const anchors = () => page.evaluate(() => Object.fromEntries(['.writer-header', '.writer-upload-section', '.writer-start-button', '.writer-privacy', '.recent-meetings'].map(selector => {
      const box = document.querySelector(selector).getBoundingClientRect();
      return [selector, { x: box.x, y: box.y, width: box.width, height: box.height }];
    })));
    const help = rowOf(page).getByRole('button', { name: '문제 해결 도움말' });
    assert.equal(await help.getAttribute('aria-expanded'), 'false');
    const beforeHelp = await anchors();
    await help.click();
    assert.deepEqual(await anchors(), beforeHelp, 'opening help must not move the header, upload, start, local promise or recent records');
    assert.equal(await page.locator('#writer-status-help').innerText(),
      `모델 상태를 확인하지 못했습니다. ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 실행한 뒤 다시 확인해 주세요.`);
    assert.equal(await rowOf(page).getByRole('button', { name: '문제 해결', exact: true }).count(), 0, '문제 해결 is desktop-only');
    await help.press('Escape');
    assert.equal(await help.getAttribute('aria-expanded'), 'false');
    assert.equal(await help.evaluate(e => e === document.activeElement), true);
    assert.deepEqual(await anchors(), beforeHelp, 'Escape closes help without shifting content');
    await help.click();
    await page.getByRole('heading', { name: '새 회의록', exact: true }).click();
    assert.equal(await help.getAttribute('aria-expanded'), 'false', 'outside click dismisses the popup');
    await help.click();
    const settingsButton = page.getByRole('button', { name: '설정', exact: true });
    await settingsButton.focus();
    await settingsButton.press('Enter');
    const settingsClose = page.getByRole('button', { name: '설정 닫기', exact: true });
    await settingsClose.waitFor();
    await settingsClose.press('Escape');
    await settingsClose.waitFor({ state: 'hidden' });
    assert.equal(await help.getAttribute('aria-expanded'), 'true', 'Escape in Settings must not close the background help or steal its focus');
    assert.equal(await settingsButton.evaluate(e => e === document.activeElement), true, 'Settings returns focus to its own opener');
    await help.press('Escape');
    await assertNoOldSurfaces(page);
    modelsUp = true;
    await rowOf(page).getByRole('button', { name: '다시 확인', exact: true }).click();
    await waitForRowState(page, 'ready');
    assert.deepEqual(await readRow(page), { state: 'ready', title: '이 PC와 연결됨', message: null, buttons: [] });
    assert.deepEqual(await anchors(), beforeHelp, 'recovering readiness keeps the same layout anchors');
    console.log('ok - development UI readiness error keeps the web ? and 다시 확인');
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

    // One way forward: 모델 받기 beside 분석 시작, said in the status line (no banner, no 설정/모델 준비 duplicates).
    await waitForRowState(page, 'models-missing');
    assert.deepEqual(await readRow(page), {
      state: 'models-missing', title: '모델을 받아야 분석할 수 있습니다', message: '음성 인식', buttons: ['모델 받기'],
    });
    assert.equal(await page.getByRole('button', { name: '모델 받기', exact: true }).count(), 1);
    assert.equal(await page.getByRole('button', { name: '모델 준비', exact: true }).count(), 0);
    assert.equal(await page.getByText('models 폴더', { exact: false }).count(), 0, 'the writer should not mention the models folder');
    await assertNoOldSurfaces(page);

    await page.getByLabel('회의 목적', { exact: true }).fill('모델 미준비 상태에서 시작 차단 확인');
    await page.setInputFiles('#meeting-file-input', {
      name: '준비 상태 확인.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('readiness fixture'),
    });
    assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), '준비 상태 확인');
    // The button keeps its action name while blocked; pressing it moves focus to the line that says why.
    assert.equal((await startButtonOf(page).innerText()).trim(), '분석 시작');
    assert.equal(await isStartBlocked(page), true, 'missing required models block analysis start');
    // Playwright will not click an aria-disabled button, so press it from the keyboard as people do.
    await startButtonOf(page).focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'writer-local-engine-requirement');
    await assertNoOldSurfaces(page);

    await page.getByRole('button', { name: '모델 받기', exact: true }).click();
    const modelsTab = page.getByRole('tab', { name: '모델' });
    await modelsTab.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await modelsTab.getAttribute('aria-selected'), 'true', 'model guidance should open the models tab');
    // The card title and the model row both read 음성 인식 모델 once the status has loaded.
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
      await waitForRowState(page, 'ready');
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'detached' });
    };
    await prepareModel();
    await page.waitForFunction(() => document.activeElement?.classList.contains('writer-start-button'));
    assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), '준비 상태 확인');
    assert.equal(await page.getByLabel('회의 목적', { exact: true }).inputValue(), '모델 미준비 상태에서 시작 차단 확인');
    assert.equal(await page.locator('#meeting-file-input').evaluate(input => input.files?.[0]?.name), '준비 상태 확인.mp3');
    // Ready: the normal status is adjacent to the enabled start action.
    assert.deepEqual(await readRow(page), { state: 'ready', title: '이 PC와 연결됨', message: null, buttons: [] });
    assert.equal(await statusOf(page).locator('.writer-status-icon').count(), 1, 'normal readiness has its status icon');
    assert.equal(Math.round((await rowOf(page).boundingBox()).height), 40, 'normal readiness keeps its 40px');
    assert.equal(await isStartBlocked(page), false);
    assert.equal(await statusOf(page).getAttribute('role'), 'status');

    await page.getByRole('button', { name: '준비 상태 확인.mp3 제거', exact: true }).click();
    state.ready = false;
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await waitForRowState(page, 'models-missing');
    assert.equal(await isStartBlocked(page), true);
    await prepareModel();
    await page.waitForFunction(() => document.activeElement?.classList.contains('file-drop-zone'));

    // A download that finishes while Settings is closed clears the line on the writer's own slow check: no focus or
    // settings event is sent, and the line clears within one slow interval.
    state.ready = false;
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await page.getByRole('button', { name: '모델 받기', exact: true }).waitFor({ timeout: 10000 });
    await page.evaluate(() => {
      window.__readinessEvents = 0;
      window.addEventListener('focus', () => { window.__readinessEvents += 1; });
      window.addEventListener('analysis:settings-updated', () => { window.__readinessEvents += 1; });
    });
    state.ready = true;
    await waitForRowState(page, 'ready', 20000);
    assert.equal(await page.evaluate(() => window.__readinessEvents), 0, 'the slow check cleared the line without any event');

    // A missing model that Settings cannot download must not point at 모델 받기. The web app's engine is the downloaded
    // connection program, so that is what gets reinstalled (WR-9); without an installer link there is no button.
    state.ready = false;
    state.downloadable = false;
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await waitForRowState(page, 'models-reinstall');
    assert.deepEqual(await readRow(page), {
      state: 'models-reinstall',
      title: '필요한 모델이 없어 분석을 시작할 수 없습니다',
      message: `${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 설치해 주세요.`,
      buttons: [],
    }, 're-checking cannot install a model Settings cannot download');
    assert.equal(await page.getByRole('button', { name: '모델 받기', exact: true }).count(), 0, 'no 모델 받기 for a model Settings cannot download');
    assert.equal(await page.getByText('모델 받기를 누르면', { exact: false }).count(), 0);
    await assertNoOldSurfaces(page);

    await verifyWebSettingsRecovery(browser);
    await verifyGpuUnavailable(browser);
    await verifyDiarizationSettingShortcut(browser);
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
