import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const shouldStartServer = !process.env.APP_URL;
const PAGE_GOTO_TIMEOUT_MS = 60000;
const holdNextSettingsResponse = (state, method, summaryModel = '') => {
  let release;
  let notifyArrived;
  const arrived = new Promise(resolve => { notifyArrived = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  state.settingsResponseHold = { method, summaryModel, gate, notifyArrived };
  return { arrived, release };
};
const refreshModelsOnFocus = async (page, state, returnEvent = 'focus') => {
  const requestsBefore = state.modelStatusRequests.length;
  const response = page.waitForResponse(result => new URL(result.url()).pathname === '/api/models/status');
  // A return event during the previous refresh is intentionally ignored. Wait
  // for that request to settle, then dispatch once more rather than mistaking its
  // already in-flight response for the refresh under test.
  for (let attempt = 0; attempt < 20 && state.modelStatusRequests.length === requestsBefore; attempt += 1) {
    await page.evaluate(eventName => (eventName === 'visibilitychange' ? document : window).dispatchEvent(new Event(eventName)), returnEvent);
    await sleep(50);
  }
  await response;
  assert.ok(state.modelStatusRequests.length > requestsBefore, `${returnEvent}: returning to Settings refreshes model status without a manual check button`);
  assert.equal(await page.getByRole('button', { name: '모델 준비 상태 다시 확인', exact: true }).count(), 0);
};

const getLayoutMetrics = async (locator) => locator.evaluate(element => {
  const rect = element.getBoundingClientRect();
  return {
    height: Math.round(rect.height),
    scrollHeight: Math.round(element.scrollHeight),
    clientHeight: Math.round(element.clientHeight),
  };
});

const SETTINGS_FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

const getSettingsFocusState = async (page) => page.evaluate((selector) => {
  const dialog = document.querySelector('[role="dialog"]');
  const focusableElements = Array.from(dialog?.querySelectorAll(selector) ?? []).filter(element => (
    element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0
  ));
  return {
    activeIndex: focusableElements.indexOf(document.activeElement),
    count: focusableElements.length,
    dialogContainsActive: Boolean(dialog?.contains(document.activeElement)),
  };
}, SETTINGS_FOCUSABLE_SELECTOR);

const focusSettingsBoundary = async (page, boundary) => page.evaluate(({ selector, boundary: targetBoundary }) => {
  const dialog = document.querySelector('[role="dialog"]');
  if (!dialog) return;
  const focusableElements = Array.from(dialog.querySelectorAll(selector)).filter(element => (
    element.getAttribute('aria-hidden') !== 'true'
    && element.getClientRects().length > 0
  ));
  const target = targetBoundary === 'first'
    ? focusableElements[0]
    : focusableElements[focusableElements.length - 1];
  target?.focus();
}, { selector: SETTINGS_FOCUSABLE_SELECTOR, boundary });

const assertHeightDeltaAtMost = (before, after, maxDelta, message) => {
  const delta = after.scrollHeight - before.scrollHeight;
  assert.equal(
    delta <= maxDelta,
    true,
    `${message}: expected delta <= ${maxDelta}, got ${delta}`,
  );
};

const waitForApp = async (url, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(5000) });
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
    await Promise.race([
      new Promise(resolve => {
        const killer = spawn(
          process.env.ComSpec ?? 'cmd.exe',
          ['/d', '/s', '/c', `taskkill /pid ${child.pid} /t /f`],
          { stdio: 'ignore', windowsHide: true },
        );
        killer.on('exit', resolve);
        killer.on('error', resolve);
      }),
      sleep(5000),
    ]);
    if (child.exitCode === null) child.kill();
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
  const sttStopRequests = [];
  const sttDownloadStatusRequests = [];
  const pullRequests = [];
  const pullStopRequests = [];
  const pullStatusRequests = [];
  const cancelledPullModels = new Set();
  const deleteRequests = [];
  const settingsPatches = [];
  const modelStatusRequests = [];
  const modelStatusErrors = [];
  let settingsState = {
    processing: { long_audio_chunk_seconds: 30, enable_long_audio_chunking: true },
    diarization: { enabled: true, generate_during_analysis: false },
    stt: { selected_model: 'faster-whisper-large-v3', device: 'cpu' },
    preprocessing: { enabled: false, normalize_audio: false, normalization_mode: 'speechnorm' },
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
    sttStopRequests,
    sttDownloadStatusRequests,
    installedModels,
    ollamaAvailable: true,
    ollamaConnectRequests: [],
    ollamaConnectFailure: false,
    ollamaConnection: {
      status: 'managed_ready',
      source: 'managed',
      executable_available: true,
      server_ready: true,
      can_auto_start: true,
      managed_runtime_available: true,
      executable_path: 'runtime\\ollama\\ollama.exe',
    },
    modelStatusRequests,
    modelStatusErrors,
    pullRequests,
    pullStopRequests,
    pullStatusRequests,
    cancelledPullModels,
    runtimeUpdateRequests: [],
    runtimeStopRequests: [],
    runtimeUpdateResolved: false,
    deleteRequests,
    searchRequests: [],
    registrationRequests: [],
    searchFailure: false,
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
    addUserModel(model) {
      if (settingsState.summary.user_models.some(option => option.model === model)) return;
      settingsState.summary.user_models.push({ model, label: model, source: 'user' });
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
    const method = route.request().method();
    const patch = method === 'PATCH' ? route.request().postDataJSON() : null;
    if (patch) {
      state.patchSettings(patch);
    }
    // Capture the response before holding it so a concurrent general save cannot
    // make this simulated model response accidentally contain newer form values.
    const body = JSON.stringify(state.settingsState);
    const hold = state.settingsResponseHold;
    if (hold?.method === method && (!hold.summaryModel || patch?.summary?.model === hold.summaryModel)) {
      state.settingsResponseHold = null;
      hold.notifyArrived();
      await hold.gate;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body,
    });
  });

  await page.route('**/api/models/download', route => {
    const body = route.request().postDataJSON();
    state.sttDownloadRequests.push(body.key);
    state.sttDownloadPaused = false;
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
        ...(state.sttProgressFixture || {}),
      }),
    });
  });

  await page.route('**/api/models/download/stop', route => {
    const body = route.request().postDataJSON();
    state.sttStopRequests.push(body.key);
    state.sttDownloadPaused = true;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        key: body.key,
        active: true,
        status: 'cancelling',
        message: '모델 받기를 중지하고 있습니다.',
        downloaded_bytes: 524288000,
        expected_bytes: 3090839274,
        progress_percent: 17.0,
        eta_seconds: 2400,
        cancel_requested: true,
        ...(state.sttProgressFixture || {}),
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
        active: !state.sttDownloadPaused,
        status: state.sttDownloadPaused ? 'cancelled' : 'running',
        can_resume: Boolean(state.sttDownloadPaused),
        message: '음성 인식 모델을 받는 중입니다.',
        downloaded_bytes: 524288000,
        expected_bytes: 3090839274,
        progress_percent: 17.0,
        eta_seconds: 2400,
        ...(state.sttProgressFixture || {}),
      }),
    });
  });

  await page.route('**/api/models/status', async route => {
    state.modelStatusRequests.push(Date.now());
    if (state.modelStatusGate) await state.modelStatusGate;
    const configuredModel = state.modelStatusConfiguredOverride || state.settingsState.summary.model;
    // The real backend may report installed=true for an available fallback even
    // when the configured model itself is absent.
    const installedModel = state.installedModels.has(configuredModel)
      ? configuredModel : state.installedModels.values().next().value ?? null;
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        ready: state.sttInstalled,
        summary_ready: state.installedModels.has(configuredModel),
        summary_reason: state.summaryReason,
        errors: state.modelStatusErrors,
        ollama_runtime_status: {
          key: 'ollama_runtime',
          available: state.ollamaAvailable,
          active: false,
          status: state.ollamaAvailable ? 'completed' : 'idle',
          message: state.ollamaAvailable ? '요약 프로그램이 준비되어 있습니다.' : '',
          target_path: 'runtime\\ollama',
          executable_path: state.ollamaAvailable ? 'runtime\\ollama\\ollama.exe' : '',
          downloaded_bytes: 0,
          expected_bytes: 1600000000,
          progress_percent: null,
          eta_seconds: null,
          ...(state.runtimeStatusOverride || {}),
        },
        ollama_connection: state.ollamaConnection,
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
            installed: Boolean(installedModel),
            configured_model: configuredModel,
            installed_model: installedModel,
            installed_models: Array.from(state.installedModels),
            inventory_checked: state.summaryInventoryChecked !== false,
            ollama_available: state.ollamaAvailable,
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

  await page.route('**/api/models/ollama/connect', route => {
    assert.equal(route.request().method(), 'POST', 'checking installed models uses the explicit connect action');
    state.ollamaConnectRequests.push(Date.now());
    if (state.ollamaConnectFailure) {
      return route.fulfill({ status: 503, contentType: 'application/json', body: JSON.stringify({ detail: '요약 프로그램에 연결하지 못했습니다. 다시 시도해 주세요.' }) });
    }
    state.summaryInventoryChecked = true;
    state.ollamaConnection = { ...state.ollamaConnection, status: 'managed_ready', server_ready: true };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ready: true }) });
  });

  await page.route('**/api/models/ollama/runtime-status', route => {
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        key: 'ollama_runtime',
        available: state.ollamaAvailable,
        active: false,
        status: state.ollamaAvailable ? 'completed' : 'idle',
        message: state.ollamaAvailable ? '요약 프로그램이 준비되어 있습니다.' : '',
        target_path: 'runtime\\ollama',
        executable_path: state.ollamaAvailable ? 'runtime\\ollama\\ollama.exe' : '',
        downloaded_bytes: 0,
        expected_bytes: 1600000000,
        progress_percent: null,
        eta_seconds: null,
        ...(state.runtimeStatusOverride || {}),
      }),
    });
  });

  await page.route('**/api/models/ollama/runtime/download?update=true', route => {
    assert.equal(route.request().method(), 'POST');
    assert.equal(new URL(route.request().url()).searchParams.get('update'), 'true', 'the update action explicitly requests updating the existing runtime');
    state.runtimeUpdateRequests.push(route.request().url());
    state.runtimeStatusOverride = { available: true, active: true, status: 'downloading', update_required: true,
      message: '요약 프로그램을 업데이트하고 있습니다.', progress_percent: 40, eta_seconds: 5 };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ key: 'ollama_runtime', ...state.runtimeStatusOverride }) });
  });
  await page.route('**/api/models/ollama/runtime/stop', route => {
    assert.equal(route.request().method(), 'POST');
    state.runtimeStopRequests.push(route.request().url());
    state.runtimeStatusOverride = { available: true, active: false, status: 'cancelled', update_required: true,
      message: '요약 프로그램 업데이트를 중지했습니다.', progress_percent: 40, cancel_requested: false };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ key: 'ollama_runtime', ...state.runtimeStatusOverride }) });
  });

  await page.route('**/api/models/ollama/pull', route => {
    const body = route.request().postDataJSON();
    const model = body.model;
    state.pullRequests.push(model);
    state.cancelledPullModels.delete(model);

    if (model === 'runtime-needs-update:1b' && !state.runtimeUpdateResolved) {
      state.runtimeStatusOverride = { available: true, active: false, status: 'completed', update_required: true };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ model, active: false, status: 'failed',
        error_code: 'runtime_update_required', message: '이 모델을 받으려면 요약 프로그램을 업데이트해 주세요.' }) });
    }

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
          message: '요약 프로그램(Ollama)을 찾지 못했습니다. 요약 프로그램을 설치한 뒤 준비 상태 확인을 눌러 주세요. 설치 페이지가 열리지 않으면 ecomarine@korea.kr으로 문의해 주세요.',
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
        progress_percent: 8.5,
        eta_seconds: 1800,
      }),
    });
  });

  await page.route('**/api/models/ollama/pull/stop', route => {
    const body = route.request().postDataJSON();
    const model = body.model;
    state.pullStopRequests.push(model);
    state.cancelledPullModels.add(model);
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        model,
        active: true,
        status: 'cancelling',
        message: `${model} 모델 받기를 중지하고 있습니다.`,
        progress_percent: 25,
        eta_seconds: 900,
        cancel_requested: true,
      }),
    });
  });

  await page.route('**/api/models/ollama/pull-status**', route => {
    const url = new URL(route.request().url());
    const model = url.searchParams.get('model') || '';
    state.pullStatusRequests.push(model);

    if (state.cancelledPullModels.has(model)) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          model,
          active: false,
          status: 'cancelled',
          can_resume: true,
          message: `${model} 모델 받기를 중지했습니다.`,
          cancel_requested: false,
          progress_percent: 25,
          eta_seconds: null,
          exit_code: null,
          error: '',
        }),
      });
    }

    const pullStarted = state.pullRequests.includes(model);
    if (model === 'broken-model:1b' && pullStarted) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        model, active: false, status: 'failed', message: 'broken-model:1b 모델을 받지 못했습니다.',
      }) });
    }
    if (model === 'runtime-needs-update:1b' && pullStarted
        && (!state.runtimeUpdateResolved || state.pullRequests.filter(item => item === model).length < 2)) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ model, active: false, status: 'failed',
        error_code: 'runtime_update_required', message: '이 모델을 받으려면 요약 프로그램을 업데이트해 주세요.' }) });
    }
    if (['gemma4:e4b', 'new-search:1b', 'runtime-needs-update:1b'].includes(model) && pullStarted) {
      state.installedModels.add(model);
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          model,
          active: false,
          status: 'completed',
          message: `${model} 모델 받기가 완료되었습니다.`,
        }),
      });
      return;
    }

    if (pullStarted) {
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          model,
          active: true,
          status: 'running',
          message: `${model} 모델을 받는 중입니다.`,
          progress_percent: 25,
          eta_seconds: 900,
        }),
      });
      return;
    }

    route.fulfill({
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
  });

  await page.route('**/api/models/ollama/search**', async route => {
    const query = new URL(route.request().url()).searchParams.get('q') || '';
    state.searchRequests.push(query);
    const hold = state.searchHold;
    if (hold?.query === query) {
      state.searchHold = null;
      hold.notifyArrived();
      await hold.gate;
    }
    if (state.searchFailure) return route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ detail: '모델을 검색하지 못했습니다. 다시 시도해 주세요.' }) });
    const names = query === 'empty-results' ? [] : query === 'many-results' ? Array.from({ length: 6 }, (_, index) => 'search-result-' + index + ':1b') : [query.includes(':') ? query : query + ':1b'];
    const models = names.map(model => ({ model, label: model, description: '검색 결과 모델', size: '1.3 GB' }));
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ models, has_more: false, source: 'https://ollama.com' }) });
  });

  await page.route('**/api/models/ollama/model**', async route => {
    if (route.request().method() === 'POST') {
      const { model } = route.request().postDataJSON();
      state.registrationRequests.push(model);
      state.addUserModel(model);
      const body = JSON.stringify({ model, summary: state.settingsState.summary });
      const hold = state.registrationResponseHold;
      if (hold?.model === model) {
        state.registrationResponseHold = null;
        hold.notifyArrived();
        await hold.gate;
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body });
    }
    assert.equal(route.request().method(), 'DELETE');
    const url = new URL(route.request().url());
    const model = url.searchParams.get('model') || '';
    const deleteFiles = url.searchParams.get('delete_files') === 'true';
    state.deleteRequests.push({ model, deleteFiles });
    if (deleteFiles) {
      state.installedModels.delete(model);
    }
    // The real backend removes a user registration for both deletion modes.
    // Built-in options remain available independently of the user list.
    state.removeUserModel(model);

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

const revealModel = async (summaryPanel, model) => {
  await summaryPanel.locator('.settings-summary-model-list').waitFor({ state: 'visible', timeout: 10000 });
  const row = summaryPanel.locator('[data-model-name="' + model + '"]');
  for (let attempt = 0; attempt < 20; attempt += 1) {
    if (await row.count()) return row;
    const next = summaryPanel.getByRole('button', { name: '다음 모델', exact: true });
    const previous = summaryPanel.getByRole('button', { name: '이전 모델', exact: true });
    if (await next.count() && await next.isEnabled()) await next.click();
    else if (await previous.count() && await previous.isEnabled()) {
      while (await previous.isEnabled()) await previous.click();
    } else break;
  }
  throw new Error('Model is not present in paginated settings list: ' + model);
};

const waitForHeldRequest = async (promise, message) => {
  let timeout;
  try {
    await Promise.race([promise, new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error(message)), 10000); })]);
  } finally {
    clearTimeout(timeout);
  }
};

const waitForSaved = async (page, predicate, message) => {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (await predicate()) return;
    await page.waitForTimeout(100);
  }
  assert.fail(message);
};

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;
  const state = createRouteState();
  if (process.env.SETTINGS_MODEL_SCENARIO === 'controls') {
    state.settingsState.preprocessing = { enabled: true, normalize_audio: true, normalization_mode: 'auto', noise_gate: false, denoise: false, trim_silence: false };
  }
  if (['controls', 'downloads'].includes(process.env.SETTINGS_MODEL_SCENARIO)) {
    state.sttProgressFixture = { downloaded_bytes: 9272518, progress_percent: 0.3, eta_seconds: 3600 };
  }
  const originalPreprocessing = structuredClone(state.settingsState.preprocessing);
  try {
    console.log('stage: checking test server');
    server = await startServer();
    console.log('stage: server ready', APP_URL);
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1360, height: 900 } });
    page.setDefaultTimeout(30000);
    console.log('stage: browser ready');
    await page.addInitScript(() => {
      window.__openedUrls = [];
      window.open = url => { window.__openedUrls.push(String(url)); return null; };
      window.__TAURI__ = { core: { invoke: async (command, args = {}) => {
        if (command === 'get_backend_base_url') return window.location.origin;
        if (command === 'open_external_url') { window.__openedUrls.push(String(args.url)); return; }
        return null;
      } } };
      // Removed pins must neither reorder the list nor be rewritten by Settings.
      localStorage.setItem('smart-minutes-summary-model-pins-v2', JSON.stringify(['list-only:1b']));
    });
    await installRoutes(page, state);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    console.log('stage: app loaded');
    const settingsButton = page.getByRole('complementary').getByRole('button', { name: '설정' });
    const settingsDialog = page.getByRole('dialog', { name: '설정', exact: true });
    const modelsPanel = page.locator('#settings-general-panel');
    const summaryPanel = modelsPanel.locator('#settings-summary-models');
    const selection = model => summaryPanel.getByRole('radio', { name: model + ' 요약 모델로 선택', exact: true });
    const download = model => summaryPanel.getByRole('button', { name: model + ' AI 모델 받기', exact: true })
      .or(summaryPanel.getByRole('button', { name: model + ' 이어받기', exact: true }));
    const speechModelCell = modelsPanel.locator('#settings-analysis-models');
    const speechChecking = () => speechModelCell.getByRole('status').filter({ hasText: '확인 중' });
    const speechReady = () => speechModelCell.getByRole('status', { name: '음성 인식 모델 있음', exact: true });
    const speechStatusPosition = async () => speechModelCell.evaluate(cell => {
      const title = cell.querySelector('.settings-row-title')?.getBoundingClientRect();
      const status = cell.querySelector('[role="status"]')?.getBoundingClientRect();
      return title && status ? { titleCenter: title.top + title.height / 2, statusCenter: status.top + status.height / 2,
        titleRight: title.right, statusLeft: status.left, statusRight: status.right } : null;
    });
    const searchInput = () => settingsDialog.getByRole('textbox', { name: '요약 모델 검색', exact: true });
    const searchResults = () => settingsDialog.getByRole('region', { name: '요약 모델 검색 결과', exact: true });
    const search = async query => {
      await searchInput().fill(query);
      await searchInput().press('Enter');
      await searchResults().waitFor();
    };
    const backToSettings = async () => {
      await settingsDialog.getByRole('button', { name: '설정으로 돌아가기', exact: true }).click();
      await summaryPanel.waitFor();
    };
    const captureSettings = async name => {
      if (!process.env.SETTINGS_SCREENSHOT_DIR) return;
      await mkdir(process.env.SETTINGS_SCREENSHOT_DIR, { recursive: true });
      await page.screenshot({ path: join(process.env.SETTINGS_SCREENSHOT_DIR, name + '.png'), animations: 'disabled' });
    };
    const checkDialogSize = async () => {
      const rect = await settingsDialog.boundingBox();
      const viewport = page.viewportSize();
      assert.ok(rect.height <= Math.min(760, viewport.height - 32) + 1, 'Settings fits content up to the dialog cap');
      assert.ok(Math.abs(rect.y - Math.max(16, (viewport.height - 760) / 2)) <= 1, 'Settings keeps its top anchor when content height changes');
      assert.ok(rect.y >= 15 && rect.y + rect.height <= viewport.height - 15, 'Settings remains inside the supported window');
    };
    const visibleModelLayout = async () => summaryPanel.evaluate(panel => {
      const rows = [...panel.querySelectorAll('.settings-summary-model-list [data-model-name]')];
      return { rows: rows.map(row => {
        const rect = row.getBoundingClientRect();
        return { model: row.dataset.modelName, x: rect.x, y: rect.y, width: rect.width, height: rect.height };
      }), page: panel.querySelector('.settings-model-pagination')?.textContent.replace(/\s/g, '') || '1/1' };
    });
    const allModelNames = async () => {
      await summaryPanel.locator('.settings-summary-model-list').waitFor();
      const previous = summaryPanel.getByRole('button', { name: '이전 모델', exact: true });
      const next = summaryPanel.getByRole('button', { name: '다음 모델', exact: true });
      while (await previous.count() && await previous.isEnabled()) await previous.click();
      const names = [];
      for (let pageNumber = 0; pageNumber < 20; pageNumber += 1) {
        names.push(...await summaryPanel.locator('.settings-summary-model-list [data-model-name]').evaluateAll(rows => rows.map(row => row.dataset.modelName)));
        if (!await next.count() || !await next.isEnabled()) return names;
        await next.click();
      }
      assert.fail('Model pagination did not finish while inspecting the full order');
    };
    const checkPlainModelLabels = async container => {
      assert.equal(await container.getByRole('img', { name: / 모델 정보 도움말$/ }).count(), 0, 'model lists do not expose optional description tooltip icons');
      const overflow = await settingsDialog.locator('.settings-content').evaluate(element => element.scrollHeight - element.clientHeight);
      assert.ok(overflow <= 2, 'normal model views fit the supported window without adding a scroll bar');
    };
    const addModel = async model => {
      const pullsBefore = state.pullRequests.length;
      const patchesBefore = state.settingsPatches.length;
      const selectedBefore = state.settingsState.summary.model;
      await search(model);
      await searchResults().getByRole('button', { name: model + ' 목록에 추가', exact: true }).waitFor();
      if (model === 'new-search:1b') {
        for (const [width, height] of [[917, 627], [860, 720], [1360, 900]]) {
          await page.setViewportSize({ width, height });
          await checkPlainModelLabels(searchResults());
          await captureSettings('settings-search-before-add-' + width);
          if (width === 917) {
            await settingsDialog.getByRole('img', { name: '검색 결과 도움말', exact: true }).focus();
            await page.getByRole('tooltip').waitFor();
            assert.ok((await page.getByRole('tooltip').innerText()).trim().length > 0, 'search guidance remains available after removing per-model hints');
            await page.keyboard.press('Escape');
            await page.getByRole('tooltip').waitFor({ state: 'hidden' });
            assert.equal(await searchResults().isVisible(), true, 'Escape dismisses search guidance without leaving results');
          }
        }
      }
      await searchResults().getByRole('button', { name: model + ' 목록에 추가', exact: true }).click();
      const viewInList = searchResults().getByRole('button', { name: model + ' 목록에서 보기', exact: true });
      await viewInList.waitFor();
      assert.equal(await viewInList.isEnabled(), true, 'an added result offers an enabled path to its list row');
      assert.equal(state.pullRequests.length, pullsBefore, 'adding a search result never downloads model files');
      assert.equal(state.settingsPatches.length, patchesBefore, 'adding a result does not change the active model');
      assert.equal(state.settingsState.summary.model, selectedBefore);
      if (model === 'new-search:1b') {
        for (const [width, height] of [[917, 627], [860, 720], [1360, 900]]) {
          await page.setViewportSize({ width, height });
          await captureSettings('settings-search-after-add-' + width);
        }
      }
      await viewInList.click();
      await summaryPanel.waitFor();
      // The UI itself returns to the new row. Clicking pagination here could
      // race that automatic page change and conceal a navigation regression.
      const row = summaryPanel.locator('[data-model-name="' + model + '"]');
      try {
        await waitForSaved(page, async () => await row.count() > 0
          && await row.evaluate(element => element.contains(document.activeElement)), 'returning from added results focuses the new model action without manual pagination');
      } catch (error) {
        console.error('added-model focus:', model, await page.evaluate(() => document.activeElement?.outerHTML));
        throw error;
      }
      return row;
    };

    if (process.env.SETTINGS_MODEL_SCENARIO === 'controls') {
      await settingsButton.click();
      await settingsDialog.waitFor();
      const volume = modelsPanel.getByRole('checkbox', { name: '음량 자동 보정', exact: true });
      const offNotice = settingsDialog.locator('.settings-normalization-notice').getByRole('status').filter({ hasText: '음량을 보정하지 않고 분석합니다.' });
      const checkNoticeAnchor = async () => {
        const notice = await offNotice.boundingBox();
        const trigger = await volume.boundingBox();
        const dialog = await settingsDialog.boundingBox();
        const gap = Math.min(Math.abs(notice.y - trigger.y - trigger.height - 8), Math.abs(trigger.y - notice.y - notice.height - 8));
        assert.ok(gap <= 2, 'normalization feedback is anchored within 8px of the switch');
        assert.ok(notice.x >= dialog.x && notice.x + notice.width <= dialog.x + dialog.width, 'notice stays within the dialog');
        assert.ok(notice.y >= dialog.y && notice.y + notice.height <= dialog.y + dialog.height, 'notice remains visible');
      };
      await volume.waitFor();
      assert.equal(await volume.isChecked(), true, 'new-install default stays enabled');
      assert.equal(await offNotice.count(), 0, 'opening settings does not announce normalization');
      await modelsPanel.getByRole('checkbox', { name: '참석자 구분 실행', exact: true }).waitFor();
      await modelsPanel.getByRole('button', { name: '음성 인식 모델 받기', exact: true }).click();
      for (const width of [1360, 860]) {
        await page.setViewportSize({ width, height: 900 });
        const device = await page.locator('#settings-analysis-device .settings-row-title').boundingBox();
        const speech = await page.locator('.settings-analysis-model-status .settings-row-title').boundingBox();
        assert.ok(Math.abs((device.y + device.height / 2) - (speech.y + speech.height / 2)) <= 1, 'device and speech titles align while progress is visible');
        const stop = await modelsPanel.getByRole('button', { name: '음성 인식 모델 중지', exact: true }).boundingBox();
        assert.ok(Math.abs((stop.y + stop.height / 2) - (speech.y + speech.height / 2)) <= 1, 'Stop is on the speech model title line');
        assert.ok((await speechModelCell.boundingBox()).height <= 96, 'speech progress stays compact with comfortable edge padding');
        const panel = await modelsPanel.locator('.settings-analysis-list').boundingBox();
        const deviceSelect = await page.locator('#settings-analysis-device select').boundingBox();
        assert.ok(deviceSelect.y - panel.y >= 12, 'analysis control has breathing room above it');
        assert.ok(device.x - panel.x >= 20, 'analysis content is inset from the border');
        const summaryBox = await summaryPanel.locator('.settings-summary-panel').boundingBox();
        const searchBox = await searchInput().boundingBox();
        assert.ok(searchBox.y - summaryBox.y >= 16 && searchBox.x - summaryBox.x >= 20, 'summary search is comfortably inset');
        const dividers = await summaryPanel.locator('.settings-summary-model-list > .settings-model-row').evaluateAll(rows => rows.map(row => ({ top: getComputedStyle(row).borderTopWidth, bottom: getComputedStyle(row).borderBottomWidth })));
        assert.ok(dividers.every(border => border.top === '0px' && border.bottom === '0px'), 'summary models use spacing instead of row dividers');
        await captureSettings('settings-analysis-aligned-' + width);
      }
      const beforeOff = await getLayoutMetrics(modelsPanel);
      await volume.uncheck();
      await offNotice.waitFor();
      await checkNoticeAnchor();
      assert.equal(await modelsPanel.getByText('음량을 보정하지 않고 분석합니다.', { exact: true }).count(), 0, 'off guidance never occupies a setting row');
      assertHeightDeltaAtMost(beforeOff, await getLayoutMetrics(modelsPanel), 1, 'off toast does not change panel height');
      await waitForSaved(page, () => state.settingsState.preprocessing.normalize_audio === false, 'turning normalization off is saved');
      await captureSettings('settings-volume-off-860');
      await page.setViewportSize({ width: 1360, height: 900 });
      await offNotice.waitFor({ state: 'hidden' });
      await volume.check();
      await waitForSaved(page, () => state.settingsState.preprocessing.normalize_audio === true, 'normalization is enabled before the next explicit off action');
      await volume.uncheck();
      await offNotice.waitFor();
      await checkNoticeAnchor();
      await captureSettings('settings-volume-off');
      await offNotice.waitFor({ state: 'hidden', timeout: 10000 });
      await volume.check();
      await waitForSaved(page, () => state.settingsState.preprocessing.normalize_audio === true, 'normalization can be enabled before testing notice dismissal');
      await volume.uncheck();
      await offNotice.waitFor();
      await settingsDialog.getByRole('button', { name: '음량 보정 안내 닫기', exact: true }).click();
      assert.equal(await offNotice.count(), 0);
      assert.equal(await volume.evaluate(element => document.activeElement === element), true, 'closing feedback returns focus to its switch');
      const autoSave = modelsPanel.getByRole('checkbox', { name: '회의 요약 HWPX 자동 저장', exact: true });
      await autoSave.check();
      await waitForSaved(page, () => state.settingsState.privacy.auto_save_hwpx_copy === true, 'unrelated settings can be saved after dismissing the notice');
      assert.equal(await offNotice.count(), 0, 'unrelated saves never repeat the off notice');
      await autoSave.uncheck();
      await waitForSaved(page, () => state.settingsState.privacy.auto_save_hwpx_copy === false, 'original privacy setting is restored');
      await settingsDialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
      await settingsButton.click();
      await volume.waitFor();
      assert.equal(await volume.isChecked(), false);
      assert.equal(await offNotice.count(), 0, 'reopening a saved off state never repeats the toast');
      assert.equal(state.settingsState.preprocessing.normalization_mode, 'auto');
      assert.equal(state.settingsState.preprocessing.noise_gate, false);
      await volume.check();
      await waitForSaved(page, () => state.settingsState.preprocessing.normalize_audio === true, 'turning normalization on is saved');
      assert.equal(await offNotice.count(), 0);

      const inFlight = holdNextSettingsResponse(state, 'PATCH');
      await volume.uncheck();
      await inFlight.arrived;
      await volume.check();
      await settingsDialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
      await settingsDialog.waitFor({ state: 'hidden' });
      await settingsButton.click();
      await settingsDialog.waitFor();
      await sleep(200);
      assert.equal(await volume.count(), 0, 'reopened settings waits for the previous dialog flush before exposing editable values');
      inFlight.release();
      await waitForSaved(page, () => state.settingsState.preprocessing.normalize_audio === true, 'closing during an older off-save flushes the latest on choice in order');
      await volume.waitFor();
      assert.equal(await volume.isChecked(), true, 'latest normalization choice survives reopening');
      await volume.uncheck();
      await waitForSaved(page, () => state.settingsState.preprocessing.normalize_audio === false, 'a new choice after reopening is saved after all previous writes');
      await volume.check();
      await waitForSaved(page, () => state.settingsState.preprocessing.normalize_audio === true, 'normalization can be enabled again');
      for (const key of ['normalization_mode', 'noise_gate', 'denoise', 'trim_silence']) {
        assert.deepEqual(state.settingsState.preprocessing[key], originalPreprocessing[key], key + ' is preserved');
      }
      await settingsDialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
      state.settingsState.preprocessing = { ...originalPreprocessing, enabled: false, normalize_audio: true, noise_gate: true };
      const disabledAdvanced = structuredClone(state.settingsState.preprocessing);
      const patchesBeforeGuard = state.settingsPatches.length;
      await settingsButton.click();
      await volume.waitFor();
      assert.equal(await volume.isChecked(), false);
      await volume.click();
      await settingsDialog.getByText('다른 음성 보정 설정이 있어 켜지 못했습니다. 문의해 주세요.', { exact: true }).waitFor();
      assert.equal(await volume.isChecked(), false, 'normalization cannot silently enable a disabled noise gate');
      await sleep(800);
      assert.equal(state.settingsPatches.length, patchesBeforeGuard);
      assert.deepEqual(state.settingsState.preprocessing, disabledAdvanced, 'advanced settings are not overwritten');
      console.log('ok - focused alignment, normalization on/off, stable guidance and save/close/reopen (mocked APIs)');
      return;
    }

    if (process.env.SETTINGS_MODEL_SCENARIO === 'downloads') {
      await settingsButton.click();
      await settingsDialog.waitFor();
      const chosenBefore = state.settingsState.summary.model;
      await modelsPanel.getByRole('button', { name: '음성 인식 모델 받기', exact: true }).click();
      await modelsPanel.getByRole('button', { name: '음성 인식 모델 중지', exact: true }).click();
      const resumeStt = modelsPanel.getByRole('button', { name: '음성 인식 모델 이어받기', exact: true });
      await resumeStt.waitFor();
      await captureSettings('settings-stt-paused');
      assert.equal(state.sttDownloadRequests.length, 1, 'Stop never restarts a download');
      await resumeStt.click();
      await modelsPanel.getByRole('button', { name: '음성 인식 모델 중지', exact: true }).waitFor();
      assert.equal(state.sttDownloadRequests.length, 2, 'Resume is an explicit second request');
      await modelsPanel.getByRole('button', { name: '음성 인식 모델 중지', exact: true }).click();
      await resumeStt.waitFor();

      await revealModel(summaryPanel, 'user-running:1b');
      await download('user-running:1b').click();
      await summaryPanel.getByRole('button', { name: 'user-running:1b 중지', exact: true }).click();
      const resumeModel = summaryPanel.getByRole('button', { name: 'user-running:1b 이어받기', exact: true });
      await resumeModel.waitFor();
      await captureSettings('settings-model-paused');
      assert.equal(state.pullRequests.length, 1);
      await resumeModel.click();
      await summaryPanel.getByRole('button', { name: 'user-running:1b 중지', exact: true }).waitFor();
      assert.equal(state.pullRequests.length, 2);
      assert.equal(state.settingsState.summary.model, chosenBefore, 'Stop/Resume never selects a model');

      state.ollamaAvailable = false;
      state.ollamaConnection = { status: 'missing', source: 'none', executable_available: false, server_ready: false, can_auto_start: false, managed_runtime_available: false };
      state.runtimeStatusOverride = { available: false, active: false, status: 'cancelled', can_resume: true,
        message: 'legacy long message', downloaded_bytes: 4800000, expected_bytes: 1600000000, progress_percent: 0.3 };
      await refreshModelsOnFocus(page, state);
      await modelsPanel.getByRole('button', { name: 'AI 모델 사용 준비 이어받기', exact: true }).waitFor();
      assert.equal(await summaryPanel.getByText('legacy long message', { exact: true }).count(), 0);
      await captureSettings('settings-runtime-paused');
      state.runtimeStatusOverride = { ...state.runtimeStatusOverride, can_resume: false, status: 'idle', downloaded_bytes: 0, progress_percent: null };
      await refreshModelsOnFocus(page, state);
      await modelsPanel.getByRole('button', { name: 'AI 모델 사용 준비', exact: true }).waitFor();
      assert.equal(await modelsPanel.getByRole('button', { name: 'AI 모델 사용 준비 이어받기', exact: true }).count(), 0, 'discarded/empty state offers a fresh download');
      state.runtimeStatusOverride = { ...state.runtimeStatusOverride, status: 'failed', message: '회사 보안 정책 또는 인터넷 연결 문제일 수 있습니다. 사내망 담당자와 someone@example.com으로 문의해 주세요.' };
      await refreshModelsOnFocus(page, state);
      await summaryPanel.getByText('받지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.', { exact: true }).waitFor();
      assert.equal(await summaryPanel.getByText(/someone@example.com/).count(), 0);
      for (const width of [1360, 860]) {
        await page.setViewportSize({ width, height: 900 });
        await captureSettings('settings-download-short-error-' + width);
        assert.equal(await settingsDialog.evaluate(el => el.scrollWidth > el.clientWidth), false);
      }
      console.log('ok - focused STT/model/runtime stop, resume, empty state and short error copy (mocked APIs)');
      return;
    }

    let releaseModelStatus;
    state.modelStatusGate = new Promise(resolve => { releaseModelStatus = resolve; });
    state.summaryInventoryChecked = false;
    state.setSttInstalled(true);
    console.log('stage: opening pending settings');
    await settingsButton.click();
    await settingsDialog.waitFor();
    console.log('stage: pending settings visible');
    await speechChecking().waitFor();
    const checkingPositions = new Map();
    for (const [width, height] of [[917, 627], [860, 720], [1360, 900]]) {
      await page.setViewportSize({ width, height });
      const position = await speechStatusPosition();
      assert.ok(position && position.statusLeft >= position.titleRight, 'speech model checking status stays to the right of its title');
      assert.ok(Math.abs(position.titleCenter - position.statusCenter) <= 1, 'speech model checking status shares the title row');
      checkingPositions.set(width, position);
      await captureSettings('settings-speech-checking-' + width);
    }
    assert.equal(await speechModelCell.getByText('모델 상태를 불러오는 중입니다.', { exact: true }).count(), 0, 'loading does not add a separate status row below the model title');
    assert.equal(await summaryPanel.getByRole('button', { name: /(?:gemma|user|list|search|broken)[^ ]* (?:AI 모델 받기|이어받기)$/ }).count(), 0, 'pending inventory never guesses a missing model');
    state.modelStatusGate = null;
    releaseModelStatus();
    await summaryPanel.getByRole('button', { name: '연결 다시 확인', exact: true }).waitFor();
    await speechReady().waitFor();
    assert.equal((await speechReady().innerText()).trim(), '준비됨');
    const readyPosition = await speechStatusPosition();
    assert.ok(Math.abs(readyPosition.statusRight - checkingPositions.get(1360).statusRight) <= 1, 'checking and ready share the same status alignment');
    assert.ok(Math.abs(readyPosition.titleCenter - readyPosition.statusCenter) <= 1);
    assert.equal(await selection('gemma4:e2b').isChecked(), true, 'configured choice remains visible while inventory is unknown');
    assert.equal(await selection('gemma4:e2b').isDisabled(), true, 'unknown inventory cannot change selection');
    assert.equal(await summaryPanel.getByRole('button', { name: /(?:gemma|user|list|search|broken)[^ ]* (?:AI 모델 받기|이어받기)$/ }).count(), 0, 'unconfirmed inventory keeps downloads unavailable');
    assert.equal(await summaryPanel.locator('select').count(), 0, 'model choice is not repeated in a select dropdown');
    assert.equal(await summaryPanel.getByRole('button', { name: /고정/ }).count(), 0, 'pin controls are removed');
    // Match the reported real screen: two registered models, stopped runtime, inventory unknown.
    const originalUsers = structuredClone(state.settingsState.summary.user_models);
    const originalConnection = { ...state.ollamaConnection };
    state.settingsState.summary.user_models = [];
    state.ollamaConnection = { ...originalConnection, status: 'managed_stopped', server_ready: false };
    state.setSttInstalled(true);
    await page.keyboard.press('Escape');
    await settingsDialog.waitFor({ state: 'hidden' });
    await settingsButton.click();
    await summaryPanel.getByRole('button', { name: '요약 프로그램 실행', exact: true }).waitFor();
    for (const [width, height] of [[917, 627], [860, 720], [1360, 900]]) {
      await page.setViewportSize({ width, height });
      await checkDialogSize();
      const metrics = await summaryPanel.evaluate(section => {
        const content = section.closest('.settings-content');
        const panel = section.querySelector('.settings-summary-panel');
        const rows = [...section.querySelectorAll('[data-model-name]')];
        const footer = section.querySelector('.settings-model-footer');
        const button = section.querySelector('[aria-label="요약 프로그램 실행"]');
        const firstRow = rows[0]?.getBoundingClientRect();
        return { panelHeight: panel.getBoundingClientRect().height,
          overflowY: content.scrollHeight - content.clientHeight,
          rowCount: rows.length, firstModel: rows[0]?.dataset.modelName,
          recoveryBelowList: footer.contains(button) && button.getBoundingClientRect().top >= firstRow.bottom,
          storageBottom: document.querySelector('[aria-labelledby="settings-storage-title"]').getBoundingClientRect().bottom,
          contentBottom: content.getBoundingClientRect().bottom };
      });
      assert.equal(metrics.rowCount, 2, 'real inventory is not padded with mock model names');
      assert.equal(metrics.firstModel, 'gemma4:e2b', 'the first registered option keeps its place despite unknown inventory');
      assert.ok(metrics.panelHeight <= 160, width + 'px: two models do not reserve a blank second row, got ' + metrics.panelHeight);
      assert.ok(metrics.overflowY <= 2, width + 'px: unknown inventory does not push storage out, got ' + metrics.overflowY);
      assert.ok(metrics.storageBottom <= metrics.contentBottom + 1, width + 'px: storage controls remain visible');
      assert.equal(metrics.recoveryBelowList, true);
      assert.equal(await selection('gemma4:e2b').isChecked(), true);
      assert.equal(await selection('gemma4:e4b').isDisabled(), true);
      assert.equal(await summaryPanel.getByRole('button', { name: / 받기$/ }).count(), 0);
      assert.equal(await summaryPanel.getByRole('button', { name: '다음 모델', exact: true }).count(), 0);
      const readyStatusAtWidth = await speechStatusPosition();
      assert.ok(Math.abs(readyStatusAtWidth.statusRight - checkingPositions.get(width).statusRight) <= 1, width + 'px: ready and checking use the same right edge');
      const selectAlignment = await modelsPanel.evaluate(panel => {
        const device = panel.querySelector('#settings-analysis-device select')?.getBoundingClientRect();
        const format = panel.querySelector('select[aria-label="다운로드 형식"]')?.getBoundingClientRect();
        return device && format ? { widthDifference: Math.abs(device.width - format.width), rightDifference: Math.abs(device.right - format.right) } : null;
      });
      assert.ok(selectAlignment && selectAlignment.widthDifference <= 1 && selectAlignment.rightDifference <= 1, width + 'px: device and download-format selects share width and right alignment');
      if (process.env.SETTINGS_SCREENSHOT_DIR) {
        await mkdir(process.env.SETTINGS_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.SETTINGS_SCREENSHOT_DIR, 'settings-unconfirmed-two-models-' + width + '.png') });
      }
    }
    const pullsBeforePreparing = state.pullRequests.length;
    const connectsBeforePreparing = state.ollamaConnectRequests.length;
    for (const scenario of ['managed_starting', 'runtime_preparing']) {
      if (scenario === 'runtime_preparing') state.modelStatusErrors.push('GPU 가속을 사용할 수 없습니다.');
      state.ollamaConnection = { ...originalConnection, status: scenario === 'managed_starting' ? 'managed_starting' : 'managed_ready' };
      state.summaryReason = scenario === 'runtime_preparing' ? 'runtime_preparing' : undefined;
      state.summaryInventoryChecked = scenario === 'runtime_preparing';
      await refreshModelsOnFocus(page, state);
      await summaryPanel.getByText('요약 프로그램을 준비하고 있습니다.', { exact: true }).waitFor();
      assert.equal(await summaryPanel.getByRole('button', { name: /^(요약 프로그램 실행|연결 다시 확인)$/ }).count(), 0, 'preparing is informational and offers no duplicate connection action');
      assert.equal(state.pullRequests.length, pullsBeforePreparing, 'preparing cannot download a model automatically');
      assert.equal(state.ollamaConnectRequests.length, connectsBeforePreparing, 'preparing does not send another connection action');
      await captureSettings('settings-summary-preparing-' + scenario);
    }
    const requestsBeforeAutomaticReady = state.modelStatusRequests.length;
    state.summaryReason = undefined;
    state.ollamaConnection = originalConnection;
    state.summaryInventoryChecked = true;
    await summaryPanel.getByText('요약 프로그램을 준비하고 있습니다.', { exact: true }).waitFor({ state: 'hidden', timeout: 10000 });
    assert.ok(state.modelStatusRequests.length > requestsBeforeAutomaticReady, 'preparing refreshes readiness without a focus event or user action');
    assert.equal(await selection('gemma4:e2b').isEnabled(), true, 'automatic readiness refresh restores model selection');
    assert.equal(await speechModelCell.getByText('GPU 가속을 사용할 수 없습니다.', { exact: false }).count(), 1, 'a separate GPU warning does not stop the summary readiness refresh');
    state.modelStatusErrors.length = 0;
    const readyBeforeManualCheck = await speechStatusPosition();
    state.modelStatusErrors.push('모델 환경 설정을 확인해 주세요.');
    await refreshModelsOnFocus(page, state);
    let releaseManualModelStatus;
    state.modelStatusGate = new Promise(resolve => { releaseManualModelStatus = resolve; });
    await speechModelCell.getByRole('button', { name: '다시 확인', exact: true }).click();
    await speechChecking().waitFor();
    const manualCheckingPosition = await speechStatusPosition();
    assert.ok(Math.abs(manualCheckingPosition.statusRight - readyBeforeManualCheck.statusRight) <= 1, 'manual checking uses the same right-aligned status slot as ready');
    assert.ok(Math.abs(manualCheckingPosition.titleCenter - manualCheckingPosition.statusCenter) <= 1, 'manual checking does not add a separate heading row');
    assert.equal(await speechModelCell.getByText('환경 확인 중', { exact: true }).count(), 0);
    await captureSettings('settings-speech-manual-checking');
    state.modelStatusErrors.length = 0;
    state.modelStatusGate = null;
    releaseManualModelStatus();
    await speechReady().waitFor();
    state.settingsState.summary.user_models = originalUsers;
    state.ollamaConnection = originalConnection;
    state.setSttInstalled(false);
    state.summaryInventoryChecked = true;
    await page.setViewportSize({ width: 1360, height: 900 });
    await page.keyboard.press('Escape');
    await settingsDialog.waitFor({ state: 'hidden' });
    await settingsButton.click();
    await selection('gemma4:e2b').waitFor();
    assert.equal(await selection('gemma4:e2b').isChecked(), true);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('smart-minutes-summary-model-pins-v2'))), ['list-only:1b'], 'old pin preferences are no longer read or rewritten');

    await settingsDialog.getByRole('button', { name: '설정 닫기', exact: true }).focus();
    await focusSettingsBoundary(page, 'last');
    await page.keyboard.press('Tab');
    assert.equal((await getSettingsFocusState(page)).activeIndex, 0, 'Tab wraps inside Settings');
    await focusSettingsBoundary(page, 'first');
    await page.keyboard.press('Shift+Tab');
    const focusState = await getSettingsFocusState(page);
    assert.equal(focusState.activeIndex, focusState.count - 1, 'Shift+Tab wraps inside Settings');
    await page.keyboard.press('Escape');
    await settingsDialog.waitFor({ state: 'hidden' });
    await settingsButton.click();
    await selection('gemma4:e2b').waitFor();

    console.log('stage: pending inventory and focus passed');
    // Prepared-state layout:4 visible rows per page; normal wide/narrow windows fit.
    state.setSttInstalled(true);
    await refreshModelsOnFocus(page, state);
    for (const [width, height] of [[1360, 900], [860, 720]]) {
      await page.setViewportSize({ width, height });
      await checkDialogSize();
      const metrics = await modelsPanel.evaluate(element => {
        const content = element.closest('.settings-content') || element;
        const top = selector => element.querySelector(selector)?.getBoundingClientRect().top;
        const rows = [...element.querySelectorAll('.settings-summary-model-list [data-model-name]')].map(row => row.getBoundingClientRect());
        return {
          analysis: top('#settings-analysis-models'), summary: top('#settings-summary-models'), storage: top('#settings-storage-title'),
          overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
          overflowY: content.scrollHeight - content.clientHeight,
          modelCount: rows.length,
          paired: rows.length > 1 && Math.abs(rows[0].top - rows[1].top) <= 1 && rows[0].right <= rows[1].left + 1,
        };
      });
      assert.ok(metrics.analysis < metrics.summary && metrics.summary < metrics.storage, width + 'px: settings retain analysis/model/storage order');
      assert.equal(metrics.overflowX, 0, width + 'px: no horizontal overflow');
      assert.ok(metrics.overflowY <= 2, width + 'px: prepared settings fit without scrolling, got ' + metrics.overflowY);
      assert.equal(metrics.modelCount, 4, width + 'px: model page is bounded at4 rows');
      assert.equal(metrics.paired, true, width + 'px: models form balanced two-column rows');
      assert.equal(await settingsDialog.getByRole('tab').count(), 0);
      assert.equal(await settingsDialog.getByText('회의록 정리', { exact: true }).count(), 0);
      assert.equal(await searchInput().count(), 1, 'only one model search appears');
      assert.equal(await summaryPanel.locator('select').count(), 0);
      const storagePairs = await modelsPanel.locator('[aria-labelledby="settings-storage-title"] .settings-paired-row').evaluateAll(rows => rows.map(row => {
        const [a, b] = [...row.children].map(child => child.getBoundingClientRect());
        return a && b && Math.abs(a.top - b.top) <= 1 && a.right <= b.left + 1 && Math.abs(a.width - b.width) <= 1;
      }));
      assert.equal(storagePairs.length, 2);
      assert.ok(storagePairs.every(Boolean), width + 'px: storage forms aligned2×2 controls');
      if (process.env.SETTINGS_SCREENSHOT_DIR) {
        await mkdir(process.env.SETTINGS_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.SETTINGS_SCREENSHOT_DIR, 'settings-model-flow-' + width + '.png') });
      }
    }
    await page.setViewportSize({ width: 1360, height: 900 });
    await revealModel(summaryPanel, 'user-running:1b');
    assert.equal(await summaryPanel.locator('[data-model-name="gemma4:e2b"]').count(), 0, 'the second page does not grow the model grid');
    await revealModel(summaryPanel, 'gemma4:e2b');
    const currentRow = summaryPanel.locator('[data-model-name="gemma4:e2b"]');
    assert.equal(await currentRow.getByRole('radio').isChecked(), true);
    const selectedAppearance = await summaryPanel.locator('.settings-summary-model-list').evaluate(list => {
      const selected = list.querySelector('[data-model-selected="true"]');
      const other = list.querySelector('[data-model-selected="false"]');
      const selectedInput = selected.querySelector('input[type="radio"]');
      return { selectedBackground: getComputedStyle(selected).backgroundColor,
        otherBackground: getComputedStyle(other).backgroundColor,
        selectedCheckBackground: getComputedStyle(selectedInput).backgroundColor,
        clearCheckBackground: getComputedStyle(list.querySelector('input[type="radio"]:not(:checked)')).backgroundColor };
    });
    assert.equal(selectedAppearance.selectedBackground, selectedAppearance.otherBackground, 'selection is not repeated as a colored row background');
    assert.notEqual(selectedAppearance.selectedCheckBackground, selectedAppearance.clearCheckBackground, 'the filled check alone distinguishes the chosen model');
    const activeDelete = currentRow.getByRole('button', { name: 'gemma4:e2b 삭제 옵션', exact: true });
    assert.equal(await activeDelete.isDisabled(), true, 'current model cannot be deleted through its trash action');

    assert.equal(await modelsPanel.getByRole('checkbox', { name: '음성 정리', exact: true }).count(), 0, 'the retired audio-cleanup switch is absent');
    assert.equal(await modelsPanel.getByRole('checkbox', { name: '음량 자동 보정', exact: true }).isChecked(), false, 'the volume switch reflects the existing disabled setting');
    for (const label of ['음량 자동 보정', '참석자 구분 실행', '다운로드 형식', '회의 요약 HWPX 자동 저장', '음성 재생 파일 보관', '음성 파일 자동 저장']) {
      const help = settingsDialog.getByRole('img', { name: label + ' 도움말', exact: true });
      await help.focus();
      await page.getByRole('tooltip').waitFor();
      assert.ok((await page.getByRole('tooltip').innerText()).trim().length > 0);
      await page.keyboard.press('Escape');
      await page.getByRole('tooltip').waitFor({ state: 'hidden' });
      assert.equal(await settingsDialog.isVisible(), true, 'Escape dismisses help without closing Settings');
      await settingsDialog.getByRole('button', { name: '설정 닫기', exact: true }).focus();
    }
    const beforeTooltip = await getLayoutMetrics(modelsPanel);
    await settingsDialog.getByRole('img', { name: '다운로드 형식 도움말', exact: true }).hover();
    await page.getByRole('tooltip').waitFor();
    assert.deepEqual(await getLayoutMetrics(modelsPanel), beforeTooltip, 'tooltip does not move or resize the settings work surface');
    await page.keyboard.press('Escape');
    await page.mouse.move(0, 0);

    assert.equal(await summaryPanel.getByRole('img', { name: / 모델 정보 도움말$/ }).count(), 0);
    await settingsDialog.getByRole('img', { name: '다운로드 형식 도움말', exact: true }).click();
    await page.getByRole('tooltip').waitFor();
    assert.ok((await page.getByRole('tooltip').innerText()).trim().length > 0, 'storage guidance also opens by clicking its help control');
    await page.keyboard.press('Escape');
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    assert.equal(await settingsDialog.isVisible(), true, 'Escape dismisses clicked storage guidance without closing Settings');

    const preserveAudio = modelsPanel.getByRole('checkbox', { name: '음성 재생 파일 보관', exact: true });
    const autoSaveAudio = modelsPanel.getByRole('checkbox', { name: '음성 파일 자동 저장', exact: true });
    await preserveAudio.uncheck();
    assert.equal(await preserveAudio.isChecked(), false, 'the audio-retention switch is off before showing dependent-setting help');
    assert.equal(await autoSaveAudio.isDisabled(), true, 'automatic audio saving requires keeping the audio file');
    const autoSaveAudioHelp = settingsDialog.getByRole('img', { name: '음성 파일 자동 저장 도움말', exact: true });
    await autoSaveAudioHelp.focus();
    await page.getByRole('tooltip').waitFor();
    assert.equal(await page.getByRole('tooltip').innerText(), '음성 재생 파일 보관을 켜면 사용할 수 있습니다.', 'disabled audio saving explains the action that enables it');
    await captureSettings('settings-audio-save-disabled-help');
    await page.keyboard.press('Escape');
    await page.getByRole('tooltip').waitFor({ state: 'hidden' });
    await preserveAudio.check();
    assert.equal(await autoSaveAudio.isEnabled(), true, 'keeping audio again makes automatic saving available');

    // Explicit recovery checks existing inventory; it never starts a download.
    state.summaryInventoryChecked = false;
    state.ollamaConnection = { ...state.ollamaConnection, status: 'managed_stopped', server_ready: false };
    await refreshModelsOnFocus(page, state);
    const startSummary = summaryPanel.getByRole('button', { name: '요약 프로그램 실행', exact: true });
    state.ollamaConnectFailure = true;
    const downloadsBeforeCheck = state.pullRequests.length;
    await startSummary.click();
    await summaryPanel.getByText('요약 프로그램에 연결하지 못했습니다. 다시 시도해 주세요.', { exact: true }).waitFor();
    const checkModels = summaryPanel.getByRole('button', { name: '연결 다시 확인', exact: true });
    assert.equal(await checkModels.isEnabled(), true);
    assert.equal(await summaryPanel.getByRole('button', { name: /(?:gemma|user|list|search|broken)[^ ]* (?:AI 모델 받기|이어받기)$/ }).count(), 0);
    state.ollamaConnectFailure = false;
    await checkModels.click();
    await summaryPanel.getByRole('button', { name: /^(요약 프로그램 실행|연결 다시 확인)$/ }).waitFor({ state: 'hidden' });
    assert.equal(state.ollamaConnectRequests.length, 2);
    assert.equal(state.pullRequests.length, downloadsBeforeCheck, 'recovery check cannot download a model');
    await revealModel(summaryPanel, 'gemma4:e4b');
    assert.equal(await selection('gemma4:e4b').count(), 0, 'missing models cannot be selected before downloading');
    await download('gemma4:e4b').click();
    await selection('gemma4:e4b').waitFor();
    assert.equal(state.settingsState.summary.model, 'gemma4:e2b', 'completing download never silently changes selection');
    const beforeFirstPageChoice = await visibleModelLayout();
    await selection('gemma4:e4b').click();
    await waitForSaved(page, () => state.settingsState.summary.model === 'gemma4:e4b', 'choosing a ready model saves immediately');
    await waitForSaved(page, async () => await selection('gemma4:e4b').isChecked() && await selection('gemma4:e4b').isEnabled(), 'ready model choice is reflected after save');
    assert.deepEqual(await visibleModelLayout(), beforeFirstPageChoice, 'choosing e4b preserves the first-page row order, coordinates and page');

    const diarizationToggle = modelsPanel.getByRole('checkbox', { name: '참석자 구분 실행', exact: true });
    const autoSaveToggle = modelsPanel.getByRole('checkbox', { name: '회의 요약 HWPX 자동 저장', exact: true });
    await revealModel(summaryPanel, 'gemma4:e2b');
    await page.clock.install();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const modelSave = holdNextSettingsResponse(state, 'PATCH', 'gemma4:e2b');
    await diarizationToggle.check();
    const beforeFirstPageChoiceBack = await visibleModelLayout();
    await selection('gemma4:e2b').click();
    await waitForHeldRequest(modelSave.arrived, 'summary model PATCH did not arrive');
    await settingsDialog.locator('.settings-save-state').getByText('저장 중', { exact: true }).waitFor();
    await autoSaveToggle.check();
    modelSave.release();
    await page.clock.resume();
    await waitForSaved(page, () => state.settingsState.diarization.generate_during_analysis && state.settingsState.privacy.auto_save_hwpx_copy, 'concurrent analysis/storage edits must save');
    assert.equal(await diarizationToggle.isChecked(), true, 'delayed model save preserves newer analysis edit');
    assert.equal(await autoSaveToggle.isChecked(), true, 'delayed model save preserves newer storage edit');
    assert.equal(await selection('gemma4:e2b').isChecked(), true, 'following general save preserves model choice');
    await settingsDialog.locator('.settings-save-state').getByText('저장 중', { exact: true }).waitFor({ state: 'hidden' });
    assert.deepEqual(await visibleModelLayout(), beforeFirstPageChoiceBack, 'choosing e2b again preserves the first-page order, coordinates and page during concurrent saves');
    assert.equal(await settingsDialog.getByText('저장됨', { exact: true }).count(), 0, 'successful saves do not leave a permanent success label');
    assert.ok(state.settingsPatches.some(patch => !patch.summary), 'the preservation check exercises a general-settings save');
    assert.ok(state.settingsPatches.every(patch => !Object.hasOwn(patch, 'preprocessing')), 'general and model saves do not send hidden preprocessing settings');
    assert.deepEqual(state.settingsState.preprocessing, originalPreprocessing, 'saving visible settings preserves the existing internal preprocessing options');

    // Model selection owns provider/model only; a later registration owns the
    // model list even when the earlier selection response contains an old list.
    await revealModel(summaryPanel, 'gemma4:e4b');
    const selectionWithOldList = holdNextSettingsResponse(state, 'PATCH', 'gemma4:e4b');
    await selection('gemma4:e4b').click();
    await waitForHeldRequest(selectionWithOldList.arrived, 'selection PATCH for registration ownership race did not arrive');
    await addModel('concurrent-added:1b');
    selectionWithOldList.release();
    await revealModel(summaryPanel, 'gemma4:e4b');
    await waitForSaved(page, () => selection('gemma4:e4b').isChecked(), 'held selection finishes after model registration');
    await revealModel(summaryPanel, 'concurrent-added:1b');
    assert.equal(await download('concurrent-added:1b').isVisible(), true, 'old selection response cannot remove a later registered model');

    // Choosing from a later page changes only the check. Registration order,
    // row coordinates, current page and keyboard focus remain steady.
    for (const model of ['page-ready-0:1b', 'page-ready-1:1b', 'page-ready-2:1b']) {
      await addModel(model);
      state.installedModels.add(model);
    }
    await refreshModelsOnFocus(page, state);
    for (const [model, keyboard] of [['page-ready-2:1b', true], ['page-ready-1:1b', false]]) {
      await revealModel(summaryPanel, model);
      assert.equal(await summaryPanel.getByRole('button', { name: '이전 모델', exact: true }).isEnabled(), true, 'choice starts on a later model page');
      const beforeLaterPageChoice = await visibleModelLayout();
      if (keyboard) await selection(model).press('Space');
      else await selection(model).click();
      await waitForSaved(page, () => state.settingsState.summary.model === model, 'later-page selection reaches the engine');
      await waitForSaved(page, async () => await selection(model).isVisible()
        && await selection(model).isChecked() && await selection(model).isEnabled()
        && await selection(model).evaluate(element => element === document.activeElement),
      'later-page selection keeps the selected check visible and focused without manual pagination');
      assert.deepEqual(await visibleModelLayout(), beforeLaterPageChoice, 'later-page selection preserves row order, coordinates and page for keyboard and mouse');
    }

    // A save response must respect explicit pagination performed while waiting.
    await revealModel(summaryPanel, 'page-ready-0:1b');
    const selectionDuringNavigation = holdNextSettingsResponse(state, 'PATCH', 'page-ready-0:1b');
    await selection('page-ready-0:1b').click();
    await waitForHeldRequest(selectionDuringNavigation.arrived, 'held selection before explicit pagination did not arrive');
    await summaryPanel.getByRole('button', { name: '이전 모델', exact: true }).click();
    const afterExplicitNavigation = await visibleModelLayout();
    selectionDuringNavigation.release();
    await settingsDialog.locator('.settings-save-state').getByText('저장 중', { exact: true }).waitFor({ state: 'hidden' });
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(state.settingsState.summary.model, 'page-ready-0:1b', 'the held selection is saved even after navigating away');
    assert.deepEqual(await visibleModelLayout(), afterExplicitNavigation, 'a delayed save preserves the page, row order and coordinates chosen by the user meanwhile');
    assert.equal(await selection('page-ready-0:1b').count(), 0, 'the delayed response does not force the selected model page back into view');

    await revealModel(summaryPanel, 'user-running:1b');
    const beforePull = await getLayoutMetrics(modelsPanel);
    await download('user-running:1b').click();
    const stopPull = summaryPanel.getByRole('button', { name: 'user-running:1b 중지', exact: true });
    await stopPull.waitFor();
    assert.equal(await summaryPanel.getByRole('button', { name: 'user-running:1b 삭제 옵션', exact: true }).isDisabled(), true, 'downloading model cannot be deleted');
    assertHeightDeltaAtMost(beforePull, await getLayoutMetrics(modelsPanel), 2, 'reserved progress row keeps model page stable');
    state.summaryInventoryChecked = false;
    await refreshModelsOnFocus(page, state);
    assert.equal(await stopPull.isVisible(), true, 'unconfirmed inventory still permits stopping an active download');
    state.summaryInventoryChecked = true;
    await refreshModelsOnFocus(page, state);
    const selectedBeforeStop = state.settingsState.summary.model;
    const pullsBeforeStop = state.pullRequests.length;
    const pollsBeforeStop = state.pullStatusRequests.filter(model => model === 'user-running:1b').length;
    await stopPull.click();
    assert.deepEqual(state.pullStopRequests, ['user-running:1b']);
    await download('user-running:1b').waitFor();
    assert.equal(await download('user-running:1b').isEnabled(), true, 'completed cancellation restores the explicit download action');
    assert.equal(await stopPull.count(), 0, 'completed cancellation removes the stop action');
    await summaryPanel.getByText(/중지됨 · 25.0%/).waitFor();
    assert.ok(state.pullStatusRequests.filter(model => model === 'user-running:1b').length > pollsBeforeStop, 'the UI polls cancellation to its final state');
    assert.equal(state.settingsState.summary.model, selectedBeforeStop, 'cancelling a model download never changes the selected model');
    assert.equal(state.pullRequests.length, pullsBeforeStop, 'cancelling does not restart the download automatically');

    console.log('stage: model download/selection/save race/stop passed');
    // Search stays inside the dialog. Error/empty/add paths neither pull nor select.
    state.searchFailure = true;
    const pullsBeforeSearch = state.pullRequests.length;
    const externalBeforeSearch = await page.evaluate(() => window.__openedUrls.length);
    await search('blocked-search:1b');
    await searchResults().getByText('모델 검색을 불러오지 못했습니다. 인터넷 연결을 확인하고 다시 검색해 주세요.', { exact: true }).waitFor();
    assert.equal(state.pullRequests.length, pullsBeforeSearch);
    await backToSettings();
    state.searchFailure = false;
    await search('empty-results');
    assert.equal(await searchResults().getByRole('button', { name: / 목록에 추가$/ }).count(), 0, 'empty results cannot add a fabricated model');
    await backToSettings();
    await search('many-results');
    await searchResults().getByRole('button', { name: 'search-result-0:1b 목록에 추가', exact: true }).waitFor();
    assert.equal(await searchResults().getByRole('button', { name: / 목록에 추가$/ }).count(), 4, 'search results are bounded to4 per page');
    await searchResults().getByRole('button', { name: '다음 검색 결과', exact: true }).click();
    assert.equal(await searchResults().getByRole('button', { name: / 목록에 추가$/ }).count(), 2);
    assert.equal(await searchResults().getByRole('button', { name: 'search-result-4:1b 목록에 추가', exact: true }).count(), 1);
    await backToSettings();
    let releaseSearch;
    let notifySearchArrived;
    const delayedSearchArrived = new Promise(resolve => { notifySearchArrived = resolve; });
    state.searchHold = { query: 'delayed-search:1b', gate: new Promise(resolve => { releaseSearch = resolve; }), notifyArrived: notifySearchArrived };
    await search('delayed-search:1b');
    await waitForHeldRequest(delayedSearchArrived, 'delayed search request did not arrive');
    await backToSettings();
    await search('newer-search:1b');
    await searchResults().getByRole('button', { name: 'newer-search:1b 목록에 추가', exact: true }).waitFor();
    const delayedResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/models/ollama/search' && new URL(response.url()).searchParams.get('q') === 'delayed-search:1b');
    releaseSearch();
    await delayedResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.equal(await searchResults().getByRole('button', { name: 'newer-search:1b 목록에 추가', exact: true }).count(), 1, 'a stale search cannot replace a newer result');
    assert.equal(await searchResults().getByRole('button', { name: 'delayed-search:1b 목록에 추가', exact: true }).count(), 0);
    await backToSettings();
    await addModel('new-search:1b');
    assert.ok(state.registrationRequests.includes('new-search:1b'));
    assert.equal(await download('new-search:1b').isVisible(), true, 'added result becomes a downloadable list row');
    assert.equal(await selection('new-search:1b').count(), 0);
    assert.equal(await page.evaluate(() => window.__openedUrls.length), externalBeforeSearch, 'search results do not launch an external browser');
    const selectedBeforeNewDownload = state.settingsState.summary.model;
    const pullsBeforeNewDownload = state.pullRequests.length;
    await download('new-search:1b').click();
    await selection('new-search:1b').waitFor();
    assert.equal(state.pullRequests.length, pullsBeforeNewDownload + 1, 'only the explicit list download action starts the new model download');
    assert.equal(state.pullRequests.at(-1), 'new-search:1b');
    assert.equal(state.settingsState.summary.model, selectedBeforeNewDownload, 'downloading a newly added model does not select it');
    await selection('new-search:1b').click();
    await waitForSaved(page, () => selection('new-search:1b').isChecked(), 'the downloaded model is selected only by the explicit choice action');
    await addModel('broken-model:1b');
    await revealModel(summaryPanel, 'new-search:1b');
    for (const [width, height] of [[917, 627], [860, 720], [1360, 900]]) {
      await page.setViewportSize({ width, height });
      await checkPlainModelLabels(summaryPanel);
      await captureSettings('settings-list-models-' + width);
    }
    await revealModel(summaryPanel, 'broken-model:1b');
    await download('broken-model:1b').click();
    await summaryPanel.getByText('받지 못했습니다. 인터넷 연결을 확인하고 다시 시도해 주세요.', { exact: true }).waitFor();
    assert.equal(state.pullRequests.at(-1), 'broken-model:1b');
    const registrationsBeforeExistingSearch = state.registrationRequests.length;
    const pullsBeforeExistingSearch = state.pullRequests.length;
    await search('new-search:1b');
    const existingModelView = searchResults().getByRole('button', { name: 'new-search:1b 목록에서 보기', exact: true });
    await existingModelView.waitFor();
    assert.equal(await existingModelView.isEnabled(), true, 'searching for a registered model offers the existing list action');
    assert.equal(await searchResults().getByRole('button', { name: 'new-search:1b 목록에 추가', exact: true }).count(), 0);
    await existingModelView.click();
    await waitForSaved(page, () => selection('new-search:1b').evaluate(element => element === document.activeElement), 'viewing an existing search result focuses its model selection');
    assert.equal(state.registrationRequests.length, registrationsBeforeExistingSearch, 'viewing a registered search result does not register it again');
    assert.equal(state.pullRequests.length, pullsBeforeExistingSearch, 'viewing a registered search result does not download it');

    console.log('stage: internal search/add/stale response passed');
    // Trash options remain keyboard reachable and distinguish list/file removal.
    await revealModel(summaryPanel, 'user-ready:1b');
    const deleteTrigger = summaryPanel.getByRole('button', { name: 'user-ready:1b 삭제 옵션', exact: true });
    await deleteTrigger.focus();
    await deleteTrigger.press('Enter');
    const deleteMenu = settingsDialog.getByRole('menu');
    await deleteMenu.waitFor();
    const fileDelete = deleteMenu.getByRole('menuitem', { name: 'user-ready:1b PC에서 삭제', exact: true });
    await fileDelete.waitFor();
    await page.keyboard.press('Escape');
    await deleteMenu.waitFor({ state: 'hidden' });
    assert.equal(await settingsDialog.isVisible(), true);
    assert.equal(await deleteTrigger.evaluate(element => document.activeElement === element), true, 'Escape returns focus to trash control');
    const fileConfirmation = settingsDialog.getByRole('region', { name: 'PC에서 모델 삭제', exact: true });
    const deletesBeforeConfirmation = state.deleteRequests.length;
    for (const cancellation of ['취소', 'Escape', '설정 닫기', 'Enter']) {
      await deleteTrigger.click();
      await fileDelete.click();
      await fileConfirmation.waitFor();
      await waitForSaved(page, () => fileConfirmation.getByRole('button', { name: '취소', exact: true }).evaluate(element => element === document.activeElement), 'destructive confirmation initially focuses Cancel');
      assert.equal(state.deleteRequests.length, deletesBeforeConfirmation, 'opening a visible confirmation does not issue DELETE');
      assert.ok((await fileConfirmation.innerText()).includes('user-ready:1b'), 'file deletion confirmation identifies the affected model');
      if (cancellation === '취소') await fileConfirmation.getByRole('button', { name: '취소', exact: true }).click();
      else if (cancellation === '설정 닫기') await settingsDialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
      else await page.keyboard.press(cancellation);
      await fileConfirmation.waitFor({ state: 'hidden' });
      assert.equal(state.deleteRequests.length, deletesBeforeConfirmation, cancellation + ' never authorizes deletion');
      if (cancellation === '설정 닫기') {
        await settingsDialog.waitFor({ state: 'hidden' });
        assert.equal(state.deleteRequests.length, deletesBeforeConfirmation, 'closing Settings discards the pending deletion');
        await settingsButton.click();
        await revealModel(summaryPanel, 'user-ready:1b');
      } else {
        assert.equal(await settingsDialog.isVisible(), true, 'Cancel, Escape and the default Enter action restore the settings body');
      }
    }
    await deleteTrigger.click();
    await fileDelete.click();
    await fileConfirmation.waitFor();
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    const deleteSettings = holdNextSettingsResponse(state, 'GET');
    await fileConfirmation.getByRole('button', { name: 'user-ready:1b PC에서 삭제 확인', exact: true }).click();
    await waitForHeldRequest(deleteSettings.arrived, 'post-delete GET settings did not arrive');
    assert.equal(state.deleteRequests.length, deletesBeforeConfirmation + 1, 'only the explicit file-deletion confirmation sends DELETE');
    await diarizationToggle.uncheck();
    await autoSaveToggle.uncheck();
    await page.clock.resume();
    await revealModel(summaryPanel, 'gemma4:e2b');
    await selection('gemma4:e2b').click();
    await waitForSaved(page, () => selection('gemma4:e2b').isChecked(), 'new model selection finishes while the post-delete response is held');
    await addModel('added-during-delete:1b');
    deleteSettings.release();
    await waitForSaved(page, () => !state.settingsState.diarization.generate_during_analysis && !state.settingsState.privacy.auto_save_hwpx_copy, 'edits during post-delete settings refresh must save');
    assert.deepEqual(state.deleteRequests.at(-1), { model: 'user-ready:1b', deleteFiles: true });
    assert.equal(await diarizationToggle.isChecked(), false);
    assert.equal(await autoSaveToggle.isChecked(), false);
    await revealModel(summaryPanel, 'gemma4:e2b');
    assert.equal(await selection('gemma4:e2b').isChecked(), true, 'old post-delete settings cannot overwrite the newer selected model');
    await revealModel(summaryPanel, 'added-during-delete:1b');
    assert.equal(await download('added-during-delete:1b').isVisible(), true, 'old post-delete settings cannot remove a later registration');
    assert.equal(state.settingsState.summary.user_models.some(model => model.model === 'user-ready:1b'), false, 'file deletion removes the user registration as on the actual backend');
    await search('user-ready:1b');
    assert.equal(await searchResults().getByRole('button', { name: 'user-ready:1b 목록에 추가', exact: true }).isEnabled(), true, 'deleted user model is absent from the UI list, so it can be added again');
    await backToSettings();
    await revealModel(summaryPanel, 'list-only:1b');
    const listDeleteTrigger = summaryPanel.getByRole('button', { name: 'list-only:1b 삭제 옵션', exact: true });
    const deleteCount = state.deleteRequests.length;
    const listConfirmation = settingsDialog.getByRole('region', { name: '모델 목록에서 제거', exact: true });
    await listDeleteTrigger.click();
    await settingsDialog.getByRole('menuitem', { name: 'list-only:1b 목록에서 제거', exact: true }).click();
    await listConfirmation.waitFor();
    assert.equal(state.deleteRequests.length, deleteCount, 'choosing list removal only opens its confirmation');
    assert.ok((await listConfirmation.innerText()).includes('list-only:1b'), 'list removal confirmation identifies the affected model');
    await listConfirmation.getByRole('button', { name: '취소', exact: true }).click();
    await listConfirmation.waitFor({ state: 'hidden' });
    assert.equal(state.deleteRequests.length, deleteCount, 'cancelled confirmation does not call delete');
    await listDeleteTrigger.click();
    await settingsDialog.getByRole('menuitem', { name: 'list-only:1b 목록에서 제거', exact: true }).click();
    await listConfirmation.getByRole('button', { name: 'list-only:1b 목록에서 제거 확인', exact: true }).click();
    await waitForSaved(page, () => state.deleteRequests.length > deleteCount, 'confirmed list removal reaches API');
    assert.deepEqual(state.deleteRequests.at(-1), { model: 'list-only:1b', deleteFiles: false });
    assert.equal(state.settingsState.summary.user_models.some(model => model.model === 'list-only:1b'), false);
    await waitForSaved(page, () => searchInput().evaluate(element => element === document.activeElement), 'removed row restores focus to model search');

    // A registration response owns only the added model. Its old list must not
    // resurrect another model that was removed while that response was delayed.
    await addModel('late-registration-victim:1b');
    let releaseRegistration;
    let notifyRegistrationArrived;
    const registrationArrived = new Promise(resolve => { notifyRegistrationArrived = resolve; });
    state.registrationResponseHold = { model: 'late-registration:1b',
      gate: new Promise(resolve => { releaseRegistration = resolve; }), notifyArrived: notifyRegistrationArrived };
    await search('late-registration:1b');
    await searchResults().getByRole('button', { name: 'late-registration:1b 목록에 추가', exact: true }).click();
    await waitForHeldRequest(registrationArrived, 'held registration response did not arrive');
    await backToSettings();
    await revealModel(summaryPanel, 'late-registration-victim:1b');
    await summaryPanel.getByRole('button', { name: 'late-registration-victim:1b 삭제 옵션', exact: true }).click();
    await settingsDialog.getByRole('menuitem', { name: 'late-registration-victim:1b 목록에서 제거', exact: true }).click();
    await listConfirmation.getByRole('button', { name: 'late-registration-victim:1b 목록에서 제거 확인', exact: true }).click();
    await waitForSaved(page, () => searchInput().evaluate(element => element === document.activeElement), 'victim deletion finishes before the delayed registration');
    const registrationResponse = page.waitForResponse(response => new URL(response.url()).pathname === '/api/models/ollama/model'
      && response.request().method() === 'POST' && response.request().postDataJSON()?.model === 'late-registration:1b');
    releaseRegistration();
    await registrationResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    await revealModel(summaryPanel, 'late-registration:1b');
    assert.equal(await download('late-registration:1b').isVisible(), true, 'delayed registration still adds its own model');
    await search('late-registration-victim:1b');
    await waitForSaved(page, () => searchResults().getByRole('button', { name: 'late-registration-victim:1b 목록에 추가', exact: true }).isEnabled(), 'a delayed registration cannot resurrect an independently deleted model');
    await backToSettings();

    // A model that requires a newer runtime has one recovery action. Updating
    // keeps the chosen model and never retries model downloads on the user's behalf.
    const runtimeModel = 'runtime-needs-update:1b';
    const selectedBeforeRuntimeUpdate = state.settingsState.summary.model;
    await page.setViewportSize({ width: 860, height: 720 });
    await addModel(runtimeModel);
    await download(runtimeModel).click();
    const updateRuntime = summaryPanel.getByRole('button', { name: '요약 프로그램 업데이트', exact: true });
    const stopRuntimeUpdate = summaryPanel.getByRole('button', { name: '요약 프로그램 업데이트 중지', exact: true });
    await updateRuntime.waitFor();
    assert.equal(await summaryPanel.getByText('이 모델을 받으려면 요약 프로그램을 업데이트해 주세요.', { exact: true }).count(), 1, 'compatibility failure appears once next to its recovery action');
    assert.equal(await summaryPanel.locator('.settings-model-progress').getByText('이 모델을 받으려면 요약 프로그램을 업데이트해 주세요.', { exact: true }).count(), 0, 'compatibility guidance is not duplicated under the model row');
    assert.equal(await settingsDialog.getByText('설정 확인 실패', { exact: true }).count(), 0, 'compatibility recovery does not add a generic error banner');
    assert.equal(state.runtimeUpdateRequests.length, 0, 'a compatibility failure never starts a runtime update automatically');
    const pullsBeforeRuntimeUpdate = state.pullRequests.length;
    await captureSettings('settings-runtime-update-required-860');
    await updateRuntime.click();
    await stopRuntimeUpdate.waitFor();
    assert.equal(await stopRuntimeUpdate.isEnabled(), true, 'downloading a runtime can be stopped');
    await revealModel(summaryPanel, selectedBeforeRuntimeUpdate);
    assert.equal(await selection(selectedBeforeRuntimeUpdate).isDisabled(), true, 'runtime updating locks the current selection control');
    assert.equal(await selection('gemma4:e4b').isDisabled(), true, 'runtime updating blocks choosing another installed model');
    assert.equal(await summaryPanel.getByRole('button', { name: 'gemma4:e4b 삭제 옵션', exact: true }).isDisabled(), true, 'runtime updating blocks file deletion');
    await revealModel(summaryPanel, runtimeModel);
    assert.equal(await download(runtimeModel).isDisabled(), true, 'runtime updating blocks a new model download');
    await stopRuntimeUpdate.click();
    await updateRuntime.waitFor();
    assert.equal(state.runtimeStopRequests.length, 1, 'stopping the update uses its dedicated endpoint');
    assert.equal(state.runtimeStatusOverride.update_required, true, 'stopping an update keeps the requirement for a later retry');
    assert.equal(state.pullRequests.length, pullsBeforeRuntimeUpdate);
    await updateRuntime.click();
    await stopRuntimeUpdate.waitFor();
    state.runtimeStatusOverride = { ...state.runtimeStatusOverride, active: false, status: 'failed', update_required: true,
      message: '요약 프로그램 업데이트에 실패했습니다. 다시 시도해 주세요.' };
    await updateRuntime.waitFor();
    await summaryPanel.getByText('요약 프로그램 업데이트에 실패했습니다. 다시 시도해 주세요.', { exact: true }).waitFor();
    assert.equal(await updateRuntime.isEnabled(), true, 'a failed update leaves the explicit retry available');
    assert.equal(state.runtimeUpdateRequests.length, 2, 'the failure does not retry updating automatically');
    assert.equal(state.settingsState.summary.model, selectedBeforeRuntimeUpdate);
    await captureSettings('settings-runtime-update-failed-860');
    await updateRuntime.click();
    await stopRuntimeUpdate.waitFor();
    state.runtimeStatusOverride = { ...state.runtimeStatusOverride, active: true, status: 'installing', update_required: true,
      message: '요약 프로그램 업데이트를 적용하고 있습니다.', progress_percent: 95 };
    await waitForSaved(page, () => stopRuntimeUpdate.isDisabled(), 'the update cannot be stopped during installation');
    assert.equal(await download(runtimeModel).isDisabled(), true, 'installation keeps model downloads locked');
    assert.equal(state.pullRequests.length, pullsBeforeRuntimeUpdate);
    await captureSettings('settings-runtime-update-installing-860');
    state.runtimeUpdateResolved = true;
    state.runtimeStatusOverride = { available: true, active: false, status: 'completed', update_required: false,
      message: '요약 프로그램 업데이트가 완료되었습니다.', progress_percent: 100 };
    await updateRuntime.waitFor({ state: 'hidden' });
    await download(runtimeModel).waitFor();
    await waitForSaved(page, () => download(runtimeModel).isEnabled(), 'completed runtime update restores the model download action');
    assert.equal(state.runtimeUpdateRequests.length, 3);
    assert.equal(state.pullRequests.length, pullsBeforeRuntimeUpdate, 'runtime completion does not retry the failed model download');
    assert.equal(state.settingsState.summary.model, selectedBeforeRuntimeUpdate, 'runtime completion preserves the chosen model');
    const stalePullChecksBeforeReopen = state.pullStatusRequests.filter(model => model === runtimeModel).length;
    await settingsDialog.getByRole('button', { name: '설정 닫기', exact: true }).click();
    await settingsDialog.waitFor({ state: 'hidden' });
    const stalePullResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname === '/api/models/ollama/pull-status' && url.searchParams.get('model') === runtimeModel;
    });
    await settingsButton.click();
    await revealModel(summaryPanel, runtimeModel);
    await stalePullResponse;
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    assert.ok(state.pullStatusRequests.filter(model => model === runtimeModel).length > stalePullChecksBeforeReopen, 'reopening checks the old inactive pull status');
    assert.equal(await updateRuntime.count(), 0, 'an old inactive compatibility failure cannot reappear as a runtime update requirement after reopening');
    assert.equal(await download(runtimeModel).isEnabled(), true, 'the upgraded runtime remains ready for an explicit model retry after reopening');
    assert.equal(state.pullRequests.length, pullsBeforeRuntimeUpdate);
    await download(runtimeModel).click();
    await selection(runtimeModel).waitFor();
    assert.equal(state.pullRequests.length, pullsBeforeRuntimeUpdate + 1, 'only an explicit model retry starts the download');
    assert.equal(await selection(runtimeModel).isChecked(), false, 'model download completion does not choose it');
    assert.equal(state.settingsState.summary.model, selectedBeforeRuntimeUpdate);
    await selection(runtimeModel).click();
    await waitForSaved(page, () => state.settingsState.summary.model === runtimeModel && selection(runtimeModel).isChecked(), 'the updated model is chosen only by the explicit selection action');
    await captureSettings('settings-runtime-update-model-selected-860');
    state.runtimeStatusOverride = undefined;
    await page.setViewportSize({ width: 1360, height: 900 });
    console.log('stage: runtime update recovery and explicit model retry/selection passed');

    // STT uses its existing independent stop route, even within the compact layout.
    state.setSttInstalled(false);
    await refreshModelsOnFocus(page, state);
    await modelsPanel.getByRole('button', { name: '음성 인식 모델 받기', exact: true }).click();
    const stopStt = modelsPanel.getByRole('button', { name: '음성 인식 모델 중지', exact: true });
    await stopStt.waitFor();
    await waitForSaved(page, () => state.sttDownloadStatusRequests.length > 0, 'STT download polls progress');
    await stopStt.click();
    assert.deepEqual(state.sttDownloadRequests, ['stt_faster_whisper']);
    assert.deepEqual(state.sttStopRequests, ['stt_faster_whisper']);

    // Existing Ollama is reused; a missing runtime is installed only by user action.
    state.ollamaAvailable = false;
    state.installedModels.clear();
    state.ollamaConnection = { status: 'missing', source: 'none', executable_available: false, server_ready: false, can_auto_start: false, managed_runtime_available: false };
    let runtimeDownloadRequests = 0;
    await page.route('**/api/models/ollama/runtime/download', route => {
      runtimeDownloadRequests += 1;
      state.ollamaAvailable = true;
      state.installedModels.add(state.settingsState.summary.model);
      state.ollamaConnection = { status: 'managed_ready', source: 'managed', executable_available: true, server_ready: true, can_auto_start: true, managed_runtime_available: true };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ key: 'ollama_runtime', available: true, active: false, status: 'completed', message: '요약 프로그램이 준비되어 있습니다.' }) });
    });
    await refreshModelsOnFocus(page, state);
    const installRuntime = modelsPanel.getByRole('button', { name: 'AI 모델 사용 준비', exact: true });
    const externalInstall = modelsPanel.getByRole('button', { name: '요약 프로그램 설치 페이지 열기', exact: true });
    await installRuntime.waitFor();
    assert.equal(runtimeDownloadRequests, 0, 'opening Settings never downloads a runtime automatically');
    await externalInstall.click();
    assert.equal((await page.evaluate(() => window.__openedUrls)).at(-1), 'https://ollama.com/download/windows');
    assert.equal(runtimeDownloadRequests, 0, 'official install alternative never starts an app-managed download');
    await installRuntime.click();
    await installRuntime.waitFor({ state: 'hidden' });
    assert.equal(runtimeDownloadRequests, 1);
    assert.equal(await externalInstall.count(), 0, 'an existing ready runtime offers no redundant installation');
    state.setSttInstalled(true);
    await refreshModelsOnFocus(page, state, 'visibilitychange');
    await modelsPanel.getByRole('status', { name: '음성 인식 모델 있음', exact: true }).waitFor();

    const formatSelect = modelsPanel.getByRole('combobox', { name: '다운로드 형식', exact: true });
    await formatSelect.selectOption('md');
    const savedModelBeforeClose = state.settingsState.summary.model;
    const modelOrderBeforeReopen = await allModelNames();
    await page.keyboard.press('Escape');
    await settingsDialog.waitFor({ state: 'hidden' });
    assert.equal(await settingsButton.evaluate(element => document.activeElement === element), true);
    await settingsButton.click();
    assert.deepEqual(await allModelNames(), modelOrderBeforeReopen, 'saving a different selected model preserves the full registration order after reopening');
    await revealModel(summaryPanel, savedModelBeforeClose);
    assert.equal(await selection(savedModelBeforeClose).isChecked(), true, 'saved model persists after reopening');
    assert.equal(await formatSelect.inputValue(), 'md');
    assert.equal(await diarizationToggle.isChecked(), false);
    assert.equal(await autoSaveToggle.isChecked(), false);
    assert.equal(await settingsDialog.getByRole('tab').count(), 0);
    assert.equal(await modelsPanel.getByRole('checkbox', { name: '음량 자동 보정', exact: true }).isChecked(), false, 'reopening preserves the existing disabled setting');
    assert.deepEqual(state.settingsState.preprocessing, originalPreprocessing, 'all button and recovery flows leave internal preprocessing unchanged');
    assert.ok(state.settingsPatches.every(patch => !Object.hasOwn(patch, 'preprocessing')), 'later saves and recovery actions also omit hidden preprocessing');
    await page.keyboard.press('Escape');
    await settingsDialog.waitFor({ state: 'hidden' });
    console.log('ok - settings search/add/download/select/delete model flow simulation');
  } catch (error) {
    console.error(error);
    if (page) {
      console.error('body:', (await page.locator('body').innerText()).slice(0, 5000));
      if (process.env.SETTINGS_SCREENSHOT_DIR) {
        await mkdir(process.env.SETTINGS_SCREENSHOT_DIR, { recursive: true });
        await page.screenshot({ path: join(process.env.SETTINGS_SCREENSHOT_DIR, 'settings-model-flow-failure.png') }).catch(() => undefined);
      }
    }
    throw error;
  } finally {
    await Promise.race([browser?.close().catch(() => undefined) ?? Promise.resolve(), sleep(5000)]);
    await stopServer(server);
  }
};

run().catch(error => { console.error(error); process.exit(1); });
