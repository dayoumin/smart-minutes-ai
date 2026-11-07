import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/?view=minutes';
const shouldStartServer = !process.env.APP_URL;
const DIARIZATION_MODEL_LABEL = '\uCC38\uC11D\uC790 \uAD6C\uBD84 \uBAA8\uB378';

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

const startServer = async () => {
  if (!shouldStartServer) {
    await waitForApp(APP_URL);
    return null;
  }

  const url = new URL(APP_URL);
  url.port = String(await getAvailablePort(url.hostname));
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
  const settingsPatches = [];
  const pullRequests = [];
  const modelDownloadRequests = [];
  const modelDownloadStatusRequests = [];
  const readinessAuthHeaders = [];
  const routeState = {
    settingsPatches,
    pullRequests,
    modelDownloadRequests,
    modelDownloadStatusRequests,
    readinessAuthHeaders,
    // Engine-reported model problems; 재시작 only appears in such a recovery context.
    modelStatusErrors: [],
    audioModelState: {
      sttInstalled: false,
      diarizationInstalled: true,
    },
    delayNextSettingsPatchMs: 0,
    // When set, GET /api/settings waits on this promise (an engine that does not answer yet).
    settingsGetGate: null,
    heldSettingsGets: 0,
    abortedSettingsGets: 0,
  };
  let settingsState = {
    processing: { long_audio_chunk_seconds: 95, enable_long_audio_chunking: false },
    diarization: { enabled: false, generate_during_analysis: false },
    stt: { selected_model: 'faster-whisper-large-v3', device: 'cpu' },
    preprocessing: { enabled: true, normalize_audio: false, normalization_mode: 'speechnorm' },
    privacy: { preserve_extracted_audio: true, auto_save_hwpx_copy: false, auto_save_audio_copy: false },
    summary: {
      provider: 'ollama',
      model: 'gemma4:e2b',
      model_options: [
        { model: 'gemma4:e2b', label: '2B', url: 'https://ollama.com/library/gemma4%3Ae2b', command: 'ollama run gemma4:e2b' },
        { model: 'gemma4:e4b', label: '4B', url: 'https://ollama.com/library/gemma4%3Ae4b', command: 'ollama run gemma4:e4b' },
      ],
    },
  };
  await page.route('**/api/health', route => {
    readinessAuthHeaders.push(route.request().headers()['x-lmo-desktop-action-token'] ?? null);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ok: true }),
    });
  });

  await page.route('**/api/models/status', route => {
    readinessAuthHeaders.push(route.request().headers()['x-lmo-desktop-action-token'] ?? null);
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
      ready: true,
      errors: routeState.modelStatusErrors,
      ollama_runtime_status: {
        key: 'ollama_runtime',
        available: true,
        active: false,
        status: 'completed',
        message: '요약 프로그램이 준비되어 있습니다.',
        target_path: 'runtime\\ollama',
        executable_path: 'runtime\\ollama\\ollama.exe',
        downloaded_bytes: 0,
        expected_bytes: 1600000000,
        progress_percent: null,
        eta_seconds: null,
      },
      models: [
        {
          key: 'stt_faster_whisper',
          label: 'STT',
          repo_id: 'Systran/faster-whisper-large-v3',
          installed: routeState.audioModelState.sttInstalled,
          required: true,
          install_url: 'https://huggingface.co/Systran/faster-whisper-large-v3',
          downloadable: true,
        },
        {
          key: 'diarization',
          label: 'Diarization',
          repo_id: 'pyannote/speaker-diarization-community-1',
          installed: routeState.audioModelState.diarizationInstalled,
          required: true,
          install_url: 'https://huggingface.co/pyannote/speaker-diarization-community-1',
        },
        {
          key: 'llm',
          label: 'Gemma via Ollama',
          installed: true,
          configured_model: settingsState.summary.model,
          installed_model: settingsState.summary.model,
          installed_models: [settingsState.summary.model],
          ollama_available: true,
          required: false,
          install_options: settingsState.summary.model_options,
        },
      ],
      stt_device_status: { gpu_detected: false, gpu_usable: false },
      system_profile: { memory_gb: 16 },
      summary_model_recommendation: {
        model: 'gemma4:e4b',
        basis: 'memory',
        message: '이 PC 메모리는 약 16GB입니다. 4B를 권장합니다. 속도나 저장 공간이 걱정되면 2B를 선택하세요.',
      },
      }),
    });
  });

  await page.route('**/api/models/ollama/runtime-status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      key: 'ollama_runtime',
      available: true,
      active: false,
      status: 'completed',
      message: '요약 프로그램이 준비되어 있습니다.',
      target_path: 'runtime\\ollama',
      executable_path: 'runtime\\ollama\\ollama.exe',
      downloaded_bytes: 0,
      expected_bytes: 1600000000,
      progress_percent: null,
      eta_seconds: null,
    }),
  }));

  await page.route('**/api/models/ollama/pull', async route => {
    const body = route.request().postDataJSON();
    const aliases = { 'gemma4:2b': 'gemma4:e2b', 'gemma4:4b': 'gemma4:e4b' };
    const model = aliases[body.model] ?? body.model;
    pullRequests.push(model);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        model,
        active: true,
        status: 'starting',
        message: `${model} 모델 받기 또는 업데이트 확인을 시작합니다.`,
        progress_percent: 4,
        eta_seconds: 1800,
      }),
    });
  });

  await page.route('**/api/models/download', async route => {
    const body = route.request().postDataJSON();
    const key = body.key;
    modelDownloadRequests.push(key);
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        key,
        active: true,
        status: 'starting',
        message: '모델 받기를 시작합니다.',
      }),
    });
  });

  await page.route('**/api/models/download-status**', route => {
    const url = new URL(route.request().url());
    const key = url.searchParams.get('key') || '';
    modelDownloadStatusRequests.push(key);
    if (key === 'stt_faster_whisper') {
      routeState.audioModelState.sttInstalled = true;
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        key,
        active: false,
        status: 'completed',
        message: '음성 인식 모델 받기가 완료되었습니다.',
      }),
    });
  });

  await page.route('**/api/models/ollama/pull-status**', route => {
    const url = new URL(route.request().url());
    const model = url.searchParams.get('model') || '';
    if (!pullRequests.includes(model)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          model,
          active: false,
          status: 'idle',
          message: '',
          progress_percent: null,
          eta_seconds: null,
        }),
      });
    }
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        model,
        active: true,
        status: 'running',
        message: `${model} 모델을 받는 중입니다.`,
        progress_percent: 20,
        eta_seconds: 1200,
      }),
    });
  });

  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PATCH') {
      const patch = route.request().postDataJSON();
      settingsPatches.push(patch);
      settingsState = {
        ...settingsState,
        ...Object.fromEntries(
          Object.entries(patch).map(([key, value]) => [
            key,
            value && typeof value === 'object' && !Array.isArray(value)
              ? { ...(settingsState[key] || {}), ...value }
              : value,
          ]),
        ),
      };
      const delayMs = routeState.delayNextSettingsPatchMs;
      routeState.delayNextSettingsPatchMs = 0;
      if (delayMs > 0) {
        await sleep(delayMs);
      }
    } else if (routeState.settingsGetGate) {
      routeState.heldSettingsGets += 1;
      await routeState.settingsGetGate;
      // The held request stands for the old engine: it fails once it is finally answered.
      await route.abort('connectionrefused');
      routeState.abortedSettingsGets += 1;
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(settingsState),
    });
  });

  await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
  }));

  return routeState;
};

const installTauriMock = () => {
  window.__restartCalls = 0;
  window.__openedUrls = [];
  window.open = (url) => {
    window.__openedUrls.push(String(url));
    return null;
  };
  window.__TAURI__ = {
    core: {
      invoke: async (command, args = {}) => {
        if (command === 'get_backend_base_url') return 'http://127.0.0.1:17863';
        if (command === 'get_desktop_action_token') return 'desktop-test-token';
        if (command === 'open_external_url') {
          window.__openedUrls.push(String(args.url));
          return undefined;
        }
        if (command === 'restart_backend') {
          window.__restartCalls += 1;
          if (window.__restartShouldFail) {
            window.__restartShouldFail = false;
            throw new Error('restart did not finish in time');
          }
          return 'http://127.0.0.1:17863';
        }
        if (command === 'set_close_guard_active' || command === 'write_frontend_log') return undefined;
        throw new Error(`unexpected command ${command}`);
      },
    },
  };
};

const runTroubleshootingEntryScene = async (browser) => {
  // The writer's 문제 해결 shortcut (engine never answers) should land on 재시작, not only scroll to it.
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  try {
    const page = await context.newPage();
    await page.addInitScript(installTauriMock);
    await installRoutes(page);
    await page.route('**/api/health', route => route.abort());
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    // The writer status row shows its one visible action as 문제해결.
    const troubleshootButton = page.getByRole('button', { name: '문제해결', exact: true });
    // The writer waits out its first-start window (45s) before calling the engine unreachable.
    await troubleshootButton.waitFor({ state: 'visible', timeout: 70000 });
    await troubleshootButton.click();
    await page.getByRole('dialog', { name: '설정' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '재시작', undefined, { timeout: 5000 });
    console.log('ok - 문제 해결 opens Settings with focus on 재시작');
  } finally {
    await context.close();
  }
};

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1360, height: 860 } });
    await page.addInitScript(installTauriMock);
    const routeState = await installRoutes(page);
    await page.goto(APP_URL, { waitUntil: 'networkidle' });
    assert.equal(
      routeState.readinessAuthHeaders.includes('desktop-test-token'),
      true,
      'Tauri readiness requests should use the desktop action token through the common client',
    );

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('analysis:status', {
        detail: { active: true, progress: 15, message: '분석 중' },
      }));
    });

    // 재시작 is shown only when something needs recovery; a reported model problem is one.
    routeState.modelStatusErrors.push('모델 환경 설정을 확인해 주세요.');
    await page.getByRole('complementary').getByRole('button', { name: '설정' }).click();
    const settingsDialog = page.getByRole('dialog', { name: '설정' });
    await settingsDialog.waitFor({ state: 'visible', timeout: 10000 });
    // Model download, search and selection live in simulate-settings-model-management.mjs; this scene covers restart and general saves.
    assert.equal(await settingsDialog.getByText(DIARIZATION_MODEL_LABEL, { exact: true }).count(), 0, 'diarization model should not be a separate user-facing model card');

    const restartButton = page.getByRole('button', { name: '재시작' });
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
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const calls = await page.evaluate(() => window.__restartCalls);
      if (calls > 0) break;
      await sleep(250);
    }
    const restartCalls = await page.evaluate(() => window.__restartCalls);
    assert.equal(restartCalls, 1, 'restart command should run once');
    await page.getByText(/분석 기능을 다시 시작/).waitFor({ state: 'visible', timeout: 10000 });

    // The download format is a browser preference: saved at once, never through the engine.
    await page.getByLabel('다운로드 형식', { exact: true }).selectOption('docx');
    assert.equal(
      await page.evaluate(() => window.localStorage.getItem('smart-minutes-download-format')),
      'docx',
      'the download format should be stored as soon as it changes',
    );
    await sleep(900);
    assert.equal(routeState.settingsPatches.length, 0, 'the download format must not write engine settings');
    await page.getByLabel('회의 요약 HWPX 자동 저장', { exact: true }).check();
    for (let attempt = 0; attempt < 40 && routeState.settingsPatches.length === 0; attempt += 1) {
      await sleep(250);
    }
    if (routeState.settingsPatches.length === 0) throw new Error('settings patch was not sent');
    const firstPatch = routeState.settingsPatches[0];
    assert.equal('processing' in firstPatch, false, 'general save should preserve hidden processing settings');
    assert.deepEqual(firstPatch.diarization, { generate_during_analysis: false }, 'general save should not rewrite diarization.enabled');
    assert.equal('preprocessing' in firstPatch, false, 'general save should leave the display-only 음량 자동 보정 setting alone');

    routeState.settingsPatches.length = 0;
    routeState.delayNextSettingsPatchMs = 900;
    const autoSaveAudioCheckbox = page.getByLabel('음성 파일 자동 저장', { exact: true });
    await autoSaveAudioCheckbox.check();
    for (let attempt = 0; attempt < 40 && routeState.settingsPatches.length === 0; attempt += 1) {
      await sleep(100);
    }
    if (routeState.settingsPatches.length === 0) throw new Error('delayed audio auto-save patch was not sent');
    await autoSaveAudioCheckbox.uncheck();
    for (let attempt = 0; attempt < 60 && routeState.settingsPatches.length < 2; attempt += 1) {
      await sleep(100);
    }
    assert.equal(routeState.settingsPatches.length >= 2, true, 'latest checkbox change should be saved after an in-flight save finishes');
    assert.equal(
      routeState.settingsPatches.at(-1)?.privacy?.auto_save_audio_copy,
      false,
      'latest audio auto-save value should win over the earlier delayed response',
    );
    assert.equal(await autoSaveAudioCheckbox.isChecked(), false, 'delayed save response should not re-check the audio auto-save box');

    // Closing right after a change, inside the save delay, must still send it.
    routeState.settingsPatches.length = 0;
    await page.getByLabel('회의 요약 HWPX 자동 저장', { exact: true }).uncheck();
    await page.keyboard.press('Escape');
    await settingsDialog.waitFor({ state: 'detached', timeout: 10000 });
    for (let attempt = 0; attempt < 40 && routeState.settingsPatches.length === 0; attempt += 1) {
      await sleep(100);
    }
    assert.equal(
      routeState.settingsPatches.at(-1)?.privacy?.auto_save_hwpx_copy,
      false,
      'a change made just before closing settings should still be saved',
    );
    // The saved change makes the writer re-read settings; let that finish before holding the next load.
    await sleep(1000);

    // An engine that has not answered yet shows 불러오는 중 and no guessed values. 재시작 belongs to the recovery
    // context, so it appears once the read fails, next to one-line row failures and a single warning popup.
    let releaseSettingsGet = () => undefined;
    routeState.settingsGetGate = new Promise(resolve => { releaseSettingsGet = resolve; });
    await page.getByRole('complementary').getByRole('button', { name: '설정' }).click();
    await settingsDialog.waitFor({ state: 'visible', timeout: 10000 });
    for (let attempt = 0; attempt < 40 && routeState.heldSettingsGets === 0; attempt += 1) {
      await sleep(100);
    }
    assert.equal(routeState.heldSettingsGets, 1, 'the settings load should be held so the dialog is still loading');
    assert.equal(await settingsDialog.getByRole('checkbox').count(), 0, 'no engine-backed switch should render before settings load');
    assert.equal(await settingsDialog.getByText('불러오는 중', { exact: true }).count(), 5, 'each engine-backed control should show 불러오는 중');
    assert.equal(await page.getByLabel('다운로드 형식', { exact: true }).isEnabled(), true, 'the browser-only download format stays usable while loading');
    assert.equal(await page.getByRole('button', { name: '재시작' }).count(), 0, 'a first load that has not failed yet is not a recovery context');
    // Only this load is held; it then fails like an engine that stopped answering.
    routeState.settingsGetGate = null;
    releaseSettingsGet();
    await settingsDialog.getByText('설정을 불러오지 못했습니다', { exact: false }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await settingsDialog.getByText('불러오지 못함', { exact: true }).count(), 6, 'each engine-backed row and the 음량 자동 보정 status should show a one-line failure');
    const restartCallsBeforeRecovery = await page.evaluate(() => window.__restartCalls);
    await expectDisabled(page.getByRole('button', { name: '재시작' }), false, 'restart should be offered once the settings read fails');
    await page.getByRole('button', { name: '재시작' }).click();
    for (let attempt = 0; attempt < 40; attempt += 1) {
      if (await page.evaluate(() => window.__restartCalls) > restartCallsBeforeRecovery) break;
      await sleep(250);
    }
    assert.equal(await page.evaluate(() => window.__restartCalls), restartCallsBeforeRecovery + 1, 'restart should run from the failure state');
    await page.getByLabel('음성 재생 파일 보관', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.getByLabel('음성 재생 파일 보관', { exact: true }).isEnabled(), true, 'the restarted settings should be loaded');
    assert.equal(await settingsDialog.getByText('설정을 불러오지 못했습니다', { exact: false }).count(), 0, 'the settings warning should clear after recovery');

    // A restart that fails (for example an engine that came up slowly) should still end with loaded settings.
    await page.keyboard.press('Escape');
    await settingsDialog.waitFor({ state: 'detached', timeout: 10000 });
    await page.evaluate(() => { window.__restartShouldFail = true; });
    await page.getByRole('complementary').getByRole('button', { name: '설정' }).click();
    await settingsDialog.waitFor({ state: 'visible', timeout: 10000 });
    await expectDisabled(page.getByRole('button', { name: '재시작' }), false, 'restart should be available');
    await page.getByRole('button', { name: '재시작' }).click();
    await page.getByText('재시작은 확인하지 못했지만 분석 기능에 다시 연결했습니다.').waitFor({ state: 'visible', timeout: 10000 });
    await page.getByLabel('음성 재생 파일 보관', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.getByLabel('음성 재생 파일 보관', { exact: true }).isEnabled(), true, 'settings should be loaded again after a failed restart');
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '재시작', undefined, { timeout: 5000 });

    await runTroubleshootingEntryScene(browser);

    console.log('ok - settings backend restart simulation');
  } catch (error) {
    console.error(error);
    if (page) console.error('body:', (await page.locator('body').innerText()).slice(0, 3000));
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopServer(server);
  }
};

const expectDisabled = async (locator, expected, message) => {
  await locator.waitFor({ state: 'visible', timeout: 10000 });
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
