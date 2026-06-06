import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
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

const createRouteState = () => {
  const installedModels = new Set(['gemma4:e2b', 'user-ready:1b', 'custom-ready:1b']);
  let sttInstalled = false;
  let sttDownloadStarted = false;
  const sttDownloadRequests = [];
  const sttDownloadStatusRequests = [];
  const pullRequests = [];
  const pullStatusRequests = [];
  const deleteRequests = [];
  const settingsPatches = [];
  let settingsState = {
    processing: { long_audio_chunk_seconds: 30, enable_long_audio_chunking: true },
    diarization: { enabled: true, generate_during_analysis: false },
    stt: { selected_model: 'faster-whisper-large-v3', device: 'cpu' },
    preprocessing: { enabled: true },
    privacy: { preserve_extracted_audio: true, auto_save_hwpx_copy: false, auto_save_audio_copy: false },
    summary: {
      provider: 'ollama',
      model: 'gemma4:e2b',
      model_options: [
        {
          model: 'gemma4:e2b',
          label: '2B',
          description: '용량과 속도를 우선할 때 사용합니다.',
          url: 'https://ollama.com/library/gemma4%3Ae2b',
          command: 'ollama run gemma4:e2b',
        },
        {
          model: 'gemma4:e4b',
          label: '4B',
          description: 'PC 여유가 있으면 더 큰 모델을 사용할 수 있습니다.',
          url: 'https://ollama.com/library/gemma4%3Ae4b',
          command: 'ollama run gemma4:e4b',
        },
      ],
      user_models: [
        {
          model: 'user-ready:1b',
          label: '앱 관리 모델',
          description: 'PC 삭제 상태 확인용 모델입니다.',
          source: 'user',
          managed_by_app: true,
        },
        {
          model: 'list-only:1b',
          label: '목록 전용 모델',
          description: '목록 제거 상태 확인용 모델입니다.',
          source: 'user',
        },
        {
          model: 'user-running:1b',
          label: '받는 중 삭제 차단 모델',
          description: '받는 중에는 목록 제거가 비활성화되어야 합니다.',
          source: 'user',
        },
      ],
    },
  };

  return {
    get settingsState() {
      return settingsState;
    },
    get sttInstalled() {
      return sttInstalled;
    },
    setSttInstalled(value) {
      sttInstalled = value;
    },
    get sttDownloadStarted() {
      return sttDownloadStarted;
    },
    setSttDownloadStarted(value) {
      sttDownloadStarted = value;
    },
    sttDownloadRequests,
    sttDownloadStatusRequests,
    installedModels,
    pullRequests,
    pullStatusRequests,
    deleteRequests,
    settingsPatches,
    patchSettings(patch) {
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
    },
    removeUserModel(model) {
      settingsState = {
        ...settingsState,
        summary: {
          ...settingsState.summary,
          user_models: settingsState.summary.user_models.filter(option => option.model !== model),
        },
      };
    },
  };
};

const installRoutes = async (page, state) => {
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));

  await page.route('**/api/settings', async route => {
    if (route.request().method() === 'PATCH') {
      state.patchSettings(route.request().postDataJSON());
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(state.settingsState),
    });
  });

  await page.route('**/api/models/download', route => {
    const body = route.request().postDataJSON();
    state.sttDownloadRequests.push(body.key);
    state.setSttDownloadStarted(true);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        key: body.key,
        active: true,
        status: 'running',
        message: '음성 인식 모델을 받는 중입니다.',
        downloaded_bytes: 104857600,
        expected_bytes: 3090839274,
        progress_percent: 3.4,
        eta_seconds: 3600,
      }),
    });
  });

  await page.route('**/api/models/download-status**', route => {
    const url = new URL(route.request().url());
    const key = url.searchParams.get('key') || '';
    state.sttDownloadStatusRequests.push(key);
    if (!state.sttDownloadStarted) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          key,
          active: false,
          status: 'idle',
          message: '',
          downloaded_bytes: 0,
          expected_bytes: 3090839274,
          progress_percent: null,
          eta_seconds: null,
        }),
      });
      return;
    }

    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        key,
        active: true,
        status: 'running',
        message: '음성 인식 모델을 받는 중입니다.',
        downloaded_bytes: 524288000,
        expected_bytes: 3090839274,
        progress_percent: 17.0,
        eta_seconds: 2400,
      }),
    });
  });

  await page.route('**/api/models/status', route => {
    const configuredModel = state.settingsState.summary.model;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: state.sttInstalled,
        summary_ready: state.installedModels.has(configuredModel),
        models: [
          {
            key: 'stt_faster_whisper',
            label: 'STT',
            repo_id: 'Systran/faster-whisper-large-v3',
            installed: state.sttInstalled,
            required: true,
            downloadable: true,
            install_url: 'https://huggingface.co/Systran/faster-whisper-large-v3',
          },
          {
            key: 'diarization',
            label: 'Diarization',
            repo_id: 'pyannote/speaker-diarization-community-1',
            installed: true,
            required: true,
            install_url: 'https://huggingface.co/pyannote/speaker-diarization-community-1',
          },
          {
            key: 'llm',
            label: 'Gemma via Ollama',
            installed: state.installedModels.has(configuredModel),
            configured_model: configuredModel,
            installed_model: state.installedModels.has(configuredModel) ? configuredModel : null,
            installed_models: Array.from(state.installedModels),
            required: false,
            install_options: state.settingsState.summary.model_options,
          },
        ],
        stt_device_status: { gpu_detected: false, gpu_usable: false },
        system_profile: { memory_gb: 16 },
        summary_model_recommendation: {
          model: 'gemma4:e4b',
          basis: 'memory',
          message: '이 PC 메모리는 약 16GB입니다. 4B를 권장합니다.',
        },
      }),
    });
  });

  await page.route('**/api/models/ollama/pull', route => {
    const body = route.request().postDataJSON();
    const model = body.model;
    state.pullRequests.push(model);

    if (model === 'broken-model:1b') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          model,
          active: false,
          status: 'failed',
          message: 'broken-model:1b 모델을 받지 못했습니다.',
        }),
      });
      return;
    }

    if (model === 'missing-ollama:1b') {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          model,
          active: false,
          status: 'failed',
          message: 'Ollama를 찾지 못했습니다. Ollama를 설치한 뒤 다시 시도해 주세요.',
          error: 'ollama executable not found',
        }),
      });
      return;
    }

    route.fulfill({
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

  await page.route('**/api/models/ollama/pull-status**', route => {
    const url = new URL(route.request().url());
    const model = url.searchParams.get('model') || '';
    state.pullStatusRequests.push(model);

    if (model === 'gemma4:e4b') {
      state.installedModels.add(model);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          model,
          active: false,
          status: 'completed',
          message: 'gemma4:e4b 모델 받기가 완료되었습니다.',
        }),
      });
      return;
    }

    route.fulfill({
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

  await page.route('**/api/models/ollama/model**', route => {
    assert.equal(route.request().method(), 'DELETE');
    const url = new URL(route.request().url());
    const model = url.searchParams.get('model') || '';
    const deleteFiles = url.searchParams.get('delete_files') === 'true';
    state.deleteRequests.push({ model, deleteFiles });
    if (deleteFiles) {
      state.installedModels.delete(model);
    } else {
      state.removeUserModel(model);
    }

    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        message: deleteFiles ? `${model} 모델을 삭제했습니다.` : `${model} 모델을 목록에서 제거했습니다.`,
      }),
    });
  });

  await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
  }));
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

const openModelMenu = async (modelsPanel, modelName) => {
  const card = modelsPanel.locator('.rounded-md.border.border-border.bg-background.p-3.text-sm').filter({ hasText: modelName }).first();
  await card.getByRole('button', { name: `${modelName} 모델 작업` }).click();
  return card;
};

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;
  const state = createRouteState();

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    await page.addInitScript(() => {
      window.__confirmMessages = [];
      window.__confirmResponses = [];
      window.__openedUrls = [];
      window.confirm = (message) => {
        window.__confirmMessages.push(message);
        if (window.__confirmResponses.length > 0) {
          return window.__confirmResponses.shift();
        }
        return true;
      };
      window.open = (url) => {
        window.__openedUrls.push(String(url));
        return null;
      };
      window.__TAURI__ = {
        core: {
          invoke: async (command) => {
            if (command === 'get_backend_base_url') return window.location.origin;
            if (command === 'set_close_guard_active' || command === 'write_frontend_log') return undefined;
            return null;
          },
        },
      };
    });
    await installRoutes(page, state);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });

    await page.getByRole('button', { name: '시스템 설정' }).click();
    await page.getByRole('tab', { name: '모델' }).click();
    const modelsPanel = page.locator('#settings-models-panel');
    await modelsPanel.getByText('처음 준비:', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await modelsPanel.getByText('음성 인식 준비 → 요약 프로그램 설치 → 회의 요약 준비 순서로 진행하세요. 이미 준비된 항목은 건너뛰어도 됩니다.').waitFor({ state: 'visible', timeout: 10000 });
    await modelsPanel.getByText('회의 요약 모델', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    const sttStatusChecksBeforeDownload = state.sttDownloadStatusRequests.length;
    const sttDownloadButton = modelsPanel.getByRole('button', { name: '음성 인식 모델 받기' });
    assert.match(await sttDownloadButton.getAttribute('class'), /btn-outline/, 'STT download should use the weaker outline button style');
    await sttDownloadButton.click();
    await modelsPanel.getByText(/진행 · .* \/ 2\.9GB/).waitFor({ state: 'visible', timeout: 10000 });
    await modelsPanel.getByText(/17\.0% 진행/).waitFor({ state: 'visible', timeout: 10000 });
    assert.deepEqual(state.sttDownloadRequests, ['stt_faster_whisper']);
    assert.equal(
      state.sttDownloadStatusRequests.length > sttStatusChecksBeforeDownload,
      true,
      'download polling should continue after the initial start response',
    );
    const ollamaInstallLink = modelsPanel.getByRole('link', { name: '요약 프로그램 설치 페이지 열기' });
    await ollamaInstallLink.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await ollamaInstallLink.getAttribute('href'), 'https://ollama.com/download/windows');
    await ollamaInstallLink.click();
    assert.equal(
      (await page.evaluate(() => window.__openedUrls)).at(-1),
      'https://ollama.com/download/windows',
      'Ollama install button should open the Windows install page',
    );
    const ollamaInstallOpenedNotice = modelsPanel.getByText('요약 프로그램 설치 페이지를 열었습니다. 설치 후 다시 받기를 눌러 주세요.');
    await ollamaInstallOpenedNotice.waitFor({ state: 'visible', timeout: 10000 });
    await ollamaInstallOpenedNotice.waitFor({ state: 'hidden', timeout: 10000 });
    await modelsPanel.getByText('권장 항목으로 시작할 수 있습니다.').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await modelsPanel.getByText('정리 모델은 Ollama가 필요합니다.').count(), 0, 'summary model section should not repeat the Ollama requirement copy');
    assert.equal(await modelsPanel.getByText('선택됨', { exact: true }).count(), 0, 'selected summary model should not repeat a selected label');
    const gemma4e4bInitialCard = modelsPanel
      .getByRole('link', { name: 'gemma4:e4b 모델 페이지' })
      .locator('xpath=ancestor::div[contains(@class, "rounded-md") and contains(@class, "border")][1]');
    await gemma4e4bInitialCard.getByText('권장', { exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await modelsPanel.getByText('권장 2B', { exact: true }).count(), 0, '2B should not look recommended when memory recommends 4B');

    await openModelMenu(modelsPanel, 'gemma4:e2b');
    await modelsPanel.getByRole('menuitem', { name: 'gemma4:e2b PC에서 삭제' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.keyboard.press('Escape');

    await modelsPanel.locator('select').selectOption('gemma4:e4b');
    await modelsPanel.getByText('아래 목록에서 받을 수 있습니다.').waitFor({ state: 'visible', timeout: 10000 });
    const gemma4e4bDownloadButton = modelsPanel.getByRole('button', { name: 'gemma4:e4b 모델 받기' });
    assert.match(await gemma4e4bDownloadButton.getAttribute('class'), /btn-outline/, 'summary model download should use the weaker outline button style');
    await gemma4e4bDownloadButton.click();
    await modelsPanel.getByText('gemma4:e4b 모델 받기가 완료되었습니다.').first().waitFor({ state: 'visible', timeout: 10000 });
    await modelsPanel.getByRole('button', { name: 'gemma4:e4b 모델 사용' }).waitFor({ state: 'visible', timeout: 10000 });
    assert.deepEqual(state.pullRequests, ['gemma4:e4b']);
    assert.deepEqual(state.pullStatusRequests.filter(model => model === 'gemma4:e4b'), ['gemma4:e4b']);

    await modelsPanel.getByRole('button', { name: 'gemma4:e4b 모델 사용' }).click();
    const gemma4e4bCard = modelsPanel
      .getByRole('link', { name: 'gemma4:e4b 모델 페이지' })
      .locator('xpath=ancestor::div[contains(@class, "rounded-md") and contains(@class, "border")][1]');
    await gemma4e4bCard.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await gemma4e4bCard.getByText('사용 중', { exact: true }).count(), 0);
    assert.equal(state.settingsPatches.at(-1)?.summary?.model, 'gemma4:e4b', 'using a completed model should save it as the configured summary model');
    await openModelMenu(modelsPanel, 'gemma4:e4b');
    await modelsPanel.getByRole('menuitem', { name: 'gemma4:e4b PC에서 삭제' }).waitFor({ state: 'visible', timeout: 10000 });
    await page.keyboard.press('Escape');

    const runningPullButton = modelsPanel.getByRole('button', { name: 'user-running:1b 모델 받기' });
    await runningPullButton.click();
    await openModelMenu(modelsPanel, 'user-running:1b');
    await expectDisabled(modelsPanel.getByRole('menuitem', { name: 'user-running:1b 등록 해제' }), true, 'running pull should block list removal');
    await modelsPanel.getByText('user-running:1b 모델을 받는 중입니다.').waitFor({ state: 'visible', timeout: 10000 });
    await page.keyboard.press('Escape');

    await modelsPanel.getByLabel('고급: 직접 입력').fill('broken-model:1b');
    await modelsPanel.getByRole('button', { name: '직접 입력 broken-model:1b 모델 검색' }).click();
    assert.equal(
      (await page.evaluate(() => window.__openedUrls)).at(-1),
      'https://ollama.com/search?q=broken-model%3A1b',
      'direct input should search before download',
    );
    await modelsPanel.getByText('검색 결과에서 모델명을 확인한 뒤 받기를 눌러 주세요.').waitFor({ state: 'visible', timeout: 10000 });
    await modelsPanel.getByRole('button', { name: '직접 입력 broken-model:1b 모델 받기' }).click();
    await modelsPanel.getByText('broken-model:1b 모델을 받지 못했습니다.').waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.getByRole('alert').getByText('broken-model:1b 모델을 받지 못했습니다.').count(), 0, 'direct input pull failure should stay inside the model section');
    assert.equal(state.pullRequests.includes('broken-model:1b'), true, 'failed pull should call backend with the typed model');

    await modelsPanel.getByLabel('고급: 직접 입력').fill('missing-ollama:1b');
    await modelsPanel.getByRole('button', { name: '직접 입력 missing-ollama:1b 모델 검색' }).click();
    await modelsPanel.getByRole('button', { name: '직접 입력 missing-ollama:1b 모델 받기' }).click();
    await page.waitForFunction(
      () => window.__openedUrls.at(-1) === 'https://ollama.com/download/windows',
      null,
      { timeout: 10000 },
    );
    assert.equal(
      (await page.evaluate(() => window.__openedUrls)).at(-1),
      'https://ollama.com/download/windows',
      'missing Ollama should open the Windows install page after download is requested',
    );
    const missingOllamaNotice = modelsPanel.getByText('요약 프로그램 설치 페이지를 열었습니다. 설치 후 다시 받기를 눌러 주세요.');
    await missingOllamaNotice.waitFor({ state: 'visible', timeout: 10000 });
    await missingOllamaNotice.waitFor({ state: 'hidden', timeout: 10000 });
    assert.equal(state.pullRequests.includes('missing-ollama:1b'), true, 'missing Ollama pull should still call backend with the typed model');

    await modelsPanel.getByLabel('고급: 직접 입력').fill('custom-ready:1b');
    await modelsPanel.getByRole('button', { name: '직접 입력 custom-ready:1b 모델 사용' }).click();
    await modelsPanel.locator('select').selectOption('custom-ready:1b');
    await openModelMenu(modelsPanel, 'custom-ready:1b');
    await modelsPanel.getByRole('menuitem', { name: /^받기$/ }).waitFor({ state: 'visible', timeout: 10000 });
    await page.keyboard.press('Escape');
    assert.equal(state.settingsPatches.at(-1)?.summary?.model, 'custom-ready:1b', 'direct input installed model should save as the configured summary model');

    await openModelMenu(modelsPanel, 'user-ready:1b');
    await modelsPanel.getByRole('menuitem', { name: 'user-ready:1b PC에서 삭제' }).click();
    await page.getByText('user-ready:1b 모델을 삭제했습니다.').waitFor({ state: 'visible', timeout: 10000 });
    assert.deepEqual(state.deleteRequests.at(-1), { model: 'user-ready:1b', deleteFiles: true });
    await modelsPanel.getByRole('button', { name: 'user-ready:1b 모델 받기' }).waitFor({ state: 'visible', timeout: 10000 });

    const deleteRequestsBeforeCancel = state.deleteRequests.length;
    await page.evaluate(() => {
      window.__confirmResponses.push(false);
    });
    await openModelMenu(modelsPanel, 'list-only:1b');
    await modelsPanel.getByRole('menuitem', { name: 'list-only:1b 등록 해제' }).click();
    await sleep(250);
    assert.equal(state.deleteRequests.length, deleteRequestsBeforeCancel, 'cancelled list removal should not call delete API');

    await openModelMenu(modelsPanel, 'list-only:1b');
    await modelsPanel.getByRole('menuitem', { name: 'list-only:1b 등록 해제' }).click();
    await page.getByText('list-only:1b 모델을 목록에서 제거했습니다.').waitFor({ state: 'visible', timeout: 10000 });
    assert.deepEqual(state.deleteRequests.at(-1), { model: 'list-only:1b', deleteFiles: false });
    await page.waitForFunction(() => !document.querySelector('#settings-models-panel')?.textContent?.includes('list-only:1b 목록 전용 모델'), null, { timeout: 10000 });
    assert.equal(await modelsPanel.getByRole('button', { name: 'list-only:1b 모델 작업' }).count(), 0);

    const confirmMessages = await page.evaluate(() => window.__confirmMessages);
    assert.equal(confirmMessages.some(message => message.includes('Ollama 저장소에서 삭제할까요')), true, 'PC delete should ask for file-delete confirmation');
    assert.equal(confirmMessages.some(message => message.includes('추가한 모델 목록에서 제거할까요')), true, 'list removal should ask for list confirmation');

    console.log('ok - settings model management simulation');
  } catch (error) {
    console.error(error);
    if (page) {
      console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
