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
  const settingsPatches = [];
  const pullRequests = [];
  const routeState = {
    settingsPatches,
    pullRequests,
    audioModelState: {
      sttInstalled: false,
      diarizationInstalled: true,
    },
    delayNextSettingsPatchMs: 0,
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
        {
          key: 'stt_faster_whisper',
          label: 'STT',
          repo_id: 'Systran/faster-whisper-large-v3',
          installed: routeState.audioModelState.sttInstalled,
          required: true,
          install_url: 'https://huggingface.co/Systran/faster-whisper-large-v3',
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
      }),
    });
  });

  await page.route('**/api/models/ollama/pull-status**', route => {
    const url = new URL(route.request().url());
    const model = url.searchParams.get('model') || '';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        model,
        active: true,
        status: 'running',
        message: `${model} 모델을 받는 중입니다.`,
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

const run = async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1360, height: 860 } });

  try {
    await page.addInitScript(() => {
      window.__restartCalls = 0;
      window.__openedUrls = [];
      window.open = (url) => {
        window.__openedUrls.push(String(url));
        return null;
      };
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
    const routeState = await installRoutes(page);
    await page.goto(APP_URL, { waitUntil: 'networkidle' });

    await page.evaluate(() => {
      window.dispatchEvent(new CustomEvent('analysis:status', {
        detail: { active: true, progress: 15, message: '분석 중' },
      }));
    });

    await page.getByRole('button', { name: '시스템 설정' }).click();
    const settingsDialog = page.getByRole('dialog', { name: '시스템 설정' });
    await settingsDialog.waitFor({ state: 'visible', timeout: 10000 });
    const generalDialogHeight = await settingsDialog.evaluate(element => Math.round(element.getBoundingClientRect().height));
    await page.getByRole('tab', { name: '모델' }).click();
    const modelDialogHeight = await settingsDialog.evaluate(element => Math.round(element.getBoundingClientRect().height));
    assert.equal(modelDialogHeight, generalDialogHeight, 'settings dialog height should not shift between tabs');
    const modelsPanel = page.locator('#settings-models-panel');
    await modelsPanel.getByText('음성 분석 모델').waitFor({ state: 'visible', timeout: 10000 });
    await modelsPanel.getByText('음성 인식 모델', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await modelsPanel.getByText('참석자 구분 모델', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await modelsPanel.getByRole('button', { name: '음성 인식 모델 준비 안내 열기' }).waitFor({ state: 'visible', timeout: 10000 });
    await modelsPanel.getByLabel('참석자 구분 모델 있음').waitFor({ state: 'visible', timeout: 10000 });
    const ollamaInstallLink = modelsPanel.getByRole('link', { name: 'Ollama 설치 페이지 열기' });
    await ollamaInstallLink.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await ollamaInstallLink.getAttribute('href'), 'https://ollama.com/download/windows');
    assert.equal(await modelsPanel.getByText('준비됨').count(), 0);
    assert.equal(await modelsPanel.getByText('대화록 작성에 필요합니다.').count(), 0);
    await modelsPanel.getByText('이 PC 메모리는 약 16GB입니다. 4B를 권장합니다.').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await modelsPanel.locator('.status-pill').filter({ hasText: /메모리/ }).count(), 0);
    assert.equal(
      await modelsPanel.locator('button').filter({ hasText: /^받기$/ }).count(),
      1,
      'only unavailable Ollama summary models should show download buttons',
    );
    routeState.audioModelState.diarizationInstalled = false;
    await page.getByRole('tab', { name: '일반' }).click();
    await page.getByRole('tab', { name: '모델' }).click();
    await modelsPanel.getByRole('button', { name: '참석자 구분 모델 준비 안내 열기' }).waitFor({ state: 'visible', timeout: 10000 });

    await modelsPanel.getByLabel('다른 모델명 추가').fill('gemma4:4b');
    await modelsPanel.getByRole('button', { name: '직접 입력 gemma4:e4b 모델 검색' }).click();
    assert.equal(
      (await page.evaluate(() => window.__openedUrls)).at(-1),
      'https://ollama.com/search?q=gemma4%3Ae4b',
      'custom model search should open Ollama search first',
    );
    await modelsPanel.getByRole('button', { name: '직접 입력 gemma4:e4b 모델 받기' }).click();
    await expectDisabled(modelsPanel.getByRole('button', { name: '직접 입력 gemma4:e4b 모델 받기' }), true, 'normalized alias pull should disable the custom download button');
    assert.deepEqual(routeState.pullRequests, ['gemma4:e4b'], 'custom alias pull should normalize before calling backend');

    await page.getByRole('tab', { name: '일반' }).click();

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
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const calls = await page.evaluate(() => window.__restartCalls);
      if (calls > 0) break;
      await sleep(250);
    }
    const restartCalls = await page.evaluate(() => window.__restartCalls);
    assert.equal(restartCalls, 1, 'restart command should run once');
    await page.getByText(/분석 서버를 다시 시작/).waitFor({ state: 'visible', timeout: 10000 });

    await page.getByLabel('다운로드 형식').selectOption('docx');
    for (let attempt = 0; attempt < 40 && routeState.settingsPatches.length === 0; attempt += 1) {
      await sleep(250);
    }
    if (routeState.settingsPatches.length === 0) throw new Error('settings patch was not sent');
    const firstPatch = routeState.settingsPatches[0];
    assert.equal('processing' in firstPatch, false, 'general save should preserve hidden processing settings');
    assert.deepEqual(firstPatch.diarization, { generate_during_analysis: false }, 'general save should not rewrite diarization.enabled');
    assert.deepEqual(firstPatch.preprocessing, { enabled: true }, 'general save should not rewrite hidden preprocessing options');

    routeState.settingsPatches.length = 0;
    routeState.delayNextSettingsPatchMs = 900;
    const autoSaveAudioCheckbox = page.getByLabel('음성 파일 자동 저장');
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
