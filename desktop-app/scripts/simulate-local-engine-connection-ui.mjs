import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';

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

// The web connection build's status row (design.md 동작 줄 v2) and its live region.
const statusRowOf = page => page.locator('.writer-action-row');
const statusOf = page => page.locator('#writer-local-engine-requirement');
const rowState = page => statusRowOf(page).getAttribute('data-state');
const isAriaDisabled = async locator => (await locator.getAttribute('aria-disabled')) === 'true';

const verifyDefaultWriterGuidance = async browser => {
  const url = new URL(APP_URL);
  url.searchParams.delete('localEngineConnection');
  for (const scenario of ['anonymous', 'authorization', 'outage-recovery']) {
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const token = 'writer-guidance-test-token';
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    let healthUp = scenario !== 'outage-recovery';
    let modelReady = true;
    let probeCount = 0;
    let pairStartCount = 0;
    let healthCount = 0;
    let heldModelCount = 0;
    let holdAuthenticatedModels = scenario === 'authorization';
    let releaseModels;
    const modelGate = new Promise(resolve => { releaseModels = resolve; });
    const models = () => ({ ready: modelReady, models: [{
      key: 'stt_faster_whisper', label: '음성 인식 모델', required: true,
      installed: modelReady, downloadable: true,
    }], errors: [] });
    try {
      if (scenario === 'outage-recovery') await page.clock.install();
      await page.route('**/api/**', async route => {
        const path = new URL(route.request().url()).pathname;
        const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
        if (path === '/api/health') {
          healthCount += 1;
          return healthUp ? json({ ok: true }) : route.abort('connectionrefused');
        }
        if (path === '/api/models/status') {
          const authorized = route.request().headers().authorization === `Bearer ${token}`;
          if (scenario === 'authorization' && !authorized) return json({ detail: 'authorization required' }, 401);
          if (authorized && holdAuthenticatedModels) {
            heldModelCount += 1;
            await modelGate;
          }
          return json(models());
        }
        if (path === '/api/probe') {
          probeCount += 1;
          if (!healthUp) return route.abort('connectionrefused');
          return json({ product_id: 'barorok-local-engine', engine_version: 'test', api_contract_version: 1,
            capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'],
            auth_state: 'pairing-required', pairing_available: scenario !== 'outage-recovery', update_required: false });
        }
        if (path === '/api/pair/start') {
          pairStartCount += 1;
          assert.equal(scenario, 'authorization', 'anonymous development recovery must not require pairing');
          return json({ mode: 'browser-connection', pairing_id: 'writer-guidance-pairing', expires_in_seconds: 120 });
        }
        if (path === '/api/pair/complete') {
          assert.deepEqual(route.request().postDataJSON(), { mode: 'browser-connection', pairing_id: 'writer-guidance-pairing' });
          return json({ session_token: token, expires_at: Math.floor(Date.now() / 1000) + 300,
            capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] });
        }
        if (path === '/api/analyze') throw new Error('Guidance must not start analysis');
        if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
        if (path === '/api/settings') return json({});
        return json({ detail: 'not used by writer guidance' }, 404);
      });
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
      await page.getByLabel('회의 제목', { exact: true }).fill(`안내 상태 ${scenario}`);
      assert.equal(await page.getByRole('dialog', { name: '회의 파일과 대화록은 이 PC 밖으로 나가지 않습니다' }).count(), 0, 'the first-visit notice is only for the connection build');
      await page.getByLabel('회의 목적', { exact: true }).fill('입력과 파일을 보존하며 다음 동작 확인');
      await page.setInputFiles('#meeting-file-input', { name: 'guidance.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('guidance fixture') });
      const analyze = page.locator('.writer-start-button');
      const rowText = async () => ({
        state: await rowState(page),
        title: (await statusOf(page).locator('.writer-status-title').allInnerTexts())[0] ?? '',
        message: (await statusOf(page).locator('.writer-status-message').allInnerTexts())[0] ?? null,
        buttons: await statusRowOf(page).locator('.writer-action-buttons > :is(button, a):not(.writer-start-button)').allInnerTexts(),
      });
      // The development UI has the same status row without the connection step: ready says nothing (no 연결됨).
      const emptyReadyRow = { state: 'ready', title: '', message: null, buttons: [] };
      if (scenario === 'anonymous') {
        await page.waitForFunction(() => {
          const button = document.querySelector('.writer-start-button');
          return Boolean(button && button.getAttribute('aria-disabled') !== 'true');
        });
        assert.equal(await analyze.isEnabled(), true);
        // The provider's background reconnect may probe; the writer must not start connecting.
        assert.equal(pairStartCount, 0, 'a working anonymous development API keeps its existing flow');
        assert.deepEqual(await rowText(), emptyReadyRow);
        assert.equal(await page.getByText('연결됨', { exact: true }).count(), 0, 'no connection step, so no 연결됨');
        assert.equal(await analyze.getAttribute('aria-describedby'), 'writer-local-engine-requirement');
      } else {
        if (scenario === 'outage-recovery') {
          await page.locator('.writer-action-row[data-state="readiness-checking"]').waitFor();
          assert.equal((await rowText()).title, '분석 준비 확인 중');
          assert.ok(healthCount > 0);
          await page.clock.runFor(47_000);
          // The development UI speaks as the web app: the engine's web name, 다시 확인, and `?` for the rest.
          await page.locator('.writer-action-row[data-state="no-response"]').waitFor();
          assert.deepEqual(await rowText(), {
            state: 'no-response',
            title: `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 응답하지 않습니다`,
            message: '잠시 뒤 다시 확인해 주세요.',
            buttons: ['다시 확인'],
          });
          assert.equal(await statusRowOf(page).getByRole('button', { name: '문제 해결 도움말' }).count(), 1);
        } else {
          await page.locator('.writer-action-row[data-state="connection-check-required"]').waitFor();
          assert.deepEqual(await rowText(), {
            state: 'connection-check-required', title: '연결 상태를 확인해야 합니다', message: '연결 확인을 눌러 주세요.', buttons: ['연결 확인'],
          });
          assert.equal(await page.getByRole('button', { name: '모델 받기', exact: true }).count(), 0);
        }
        assert.equal(await page.locator('.status-banner, .writer-action-bar').count(), 0, 'no banner or old action bar');
        assert.equal(await page.getByRole('button', { name: '준비 필요', exact: true }).count(), 0);
        assert.equal(await analyze.isDisabled(), true);
        await statusRowOf(page).getByRole('button', { name: scenario === 'outage-recovery' ? '다시 확인' : '연결 확인', exact: true }).click();
        // Recovery hands the row to the connection status line until the anonymous API answers again.
        const rail = statusRowOf(page);
        if (scenario === 'outage-recovery') {
          await statusOf(page).getByText('연결하지 못했습니다', { exact: true }).waitFor();
          // Headless Chromium may report the loopback permission as undecided, which adds the allow hint.
          assert.ok([
            `${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행한 뒤 다시 확인해 주세요.`,
            `${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행하고, Chrome이 물으면 ‘허용’을 눌러 주세요.`,
          ].includes(await statusOf(page).locator('.writer-status-message').innerText()), 'an unanswered check says to run the engine');
          assert.equal(await rail.locator('a[href=""]').count(), 0);
          healthUp = true;
          await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
          // Back to the development UI's own row once the anonymous API answers.
          await page.waitForFunction(() => document.querySelector('.writer-action-row')?.getAttribute('data-state') === 'ready');
          assert.deepEqual(await rowText(), emptyReadyRow);
          assert.equal(await analyze.isEnabled(), true, 'a recovered anonymous API is usable without reloading');
        } else {
          await rail.getByRole('button', { name: '연결 시작', exact: true }).click();
          assert.equal(await page.getByLabel('연결 코드', { exact: true }).count(), 0);
          await statusOf(page).getByText('분석 준비 확인 중', { exact: true }).waitFor();
          assert.equal(await page.getByText('분석 준비 완료', { exact: true }).count(), 0);
          assert.equal(await analyze.isDisabled(), true, 'model readiness must complete after pairing');
          const deadline = Date.now() + 10_000;
          while (!heldModelCount && Date.now() < deadline) await sleep(50);
          assert.ok(heldModelCount > 0);
          modelReady = false;
          holdAuthenticatedModels = false;
          releaseModels();
          await rail.getByRole('button', { name: '모델 받기', exact: true }).waitFor();
          assert.equal(await analyze.textContent(), '분석 시작', 'the start button keeps its action name while blocked');
          assert.equal(await isAriaDisabled(analyze), true);
          assert.equal(await page.getByRole('button', { name: '준비 필요', exact: true }).count(), 0);
          modelReady = true;
          await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
          await statusOf(page).getByText('연결됨', { exact: true }).waitFor();
          assert.equal(await analyze.isEnabled(), true);
        }
        assert.ok(probeCount > 0);
      }
      assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), `안내 상태 ${scenario}`);
      assert.equal(await page.getByLabel('회의 목적', { exact: true }).inputValue(), '입력과 파일을 보존하며 다음 동작 확인');
      assert.equal(await page.locator('#meeting-file-input').evaluate(input => input.files[0]?.name), 'guidance.mp3');
      assert.deepEqual(errors, []);
      console.log(`ok - default writer guidance: ${scenario}`);
    } finally {
      releaseModels();
      await page.close();
    }
  }
};

const verifySummaryReadinessAfterPairing = async browser => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  // The first-visit notice is covered by the main flow; this scenario starts from a returning browser.
  await page.addInitScript(() => window.localStorage.setItem('localProcessingIntroSeen', '1'));
  const sessionToken = 'summary-readiness-ui-test-session-token';
  const record = {
    id: 'summary-readiness-after-pairing',
    jobId: 'summary-readiness-after-pairing',
    title: '연결 후 요약 준비 상태',
    date: '2026-10-18 09:00',
    meetingPurpose: '연결 성공 뒤 저장한 대화록 정리',
    summary: '요약 프로그램이 중지되어 정리를 건너뛰었습니다.',
    generationStatus: { summary: 'skipped' },
    segments: [{ start: '00:00', end: '00:05', speaker: 'SPEAKER_00', text: '연결한 뒤 이 대화록을 정리합니다.' }],
    diarizationApplied: true,
    analysisStatus: 'completed',
  };
  let rejectedModelRequests = 0;
  let authenticatedModelRequests = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    if (path === '/api/models/status') {
      if (route.request().headers().authorization !== `Bearer ${sessionToken}`) {
        rejectedModelRequests += 1;
        return json({ detail: 'local engine authorization required' }, 401);
      }
      authenticatedModelRequests += 1;
      return json({
        ready: true, models: [], errors: [], summary_ready: false,
        summary_message: '요약 프로그램이 중지되어 모델 상태를 확인하지 못했습니다.',
        ollama_connection: { status: 'managed_stopped', can_auto_start: true, managed_runtime_available: true },
      });
    }
    if (path === '/api/probe') return json({
      product_id: 'barorok-local-engine', engine_version: '0.1.0-test', api_contract_version: 1,
      capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'],
      auth_state: 'pairing-required', pairing_available: true, update_required: false,
    });
    if (path === '/api/pair/start') return json({ mode: 'browser-connection', pairing_id: 'summary-readiness-pairing', expires_in_seconds: 120 });
    if (path === '/api/pair/complete') {
      assert.deepEqual(route.request().postDataJSON(), { mode: 'browser-connection', pairing_id: 'summary-readiness-pairing' });
      return json({ session_token: sessionToken, expires_at: Math.floor(Date.now() / 1000) + 300,
        capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] });
    }
    if (path === '/api/settings') return json({});
    if (path === '/api/health') return json({ ok: true });
    if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
    return json({ detail: 'not used by readiness regression' }, 404);
  });
  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    const firstStatusDeadline = Date.now() + 10000;
    while (rejectedModelRequests === 0 && Date.now() < firstStatusDeadline) await sleep(100);
    assert.ok(rejectedModelRequests > 0, 'the mounted history must first encounter an unauthenticated model-status response');
    await page.evaluate(async record => {
      const { addMeeting } = await import('/src/meetingRepository.ts');
      await addMeeting(record);
      window.dispatchEvent(new Event('meetings:updated'));
      window.__readinessInteractions = { focus: 0, settings: 0 };
      window.addEventListener('focus', () => { window.__readinessInteractions.focus += 1; });
      window.addEventListener('analysis:settings-updated', () => { window.__readinessInteractions.settings += 1; });
    }, record);
    const row = page.locator('.sidebar-record-row').filter({ hasText: record.title });
    await row.locator('button[title]').filter({ hasText: record.title }).click();
    const detail = page.locator('.meeting-detail-shell');
    await detail.getByRole('heading', { name: record.title, exact: true }).waitFor();
    await detail.getByRole('tab', { name: '기록 정리', exact: true }).click();
    const summaryButton = detail.getByRole('button', { name: '전체 요약 정리', exact: true });
    assert.equal(await summaryButton.isDisabled(), true, 'a skipped summary cannot start while the model status is unauthenticated');
    await page.getByRole('button', { name: '새 회의록', exact: true }).click();
    const rail = statusRowOf(page);
    await rail.getByRole('button', { name: '연결 시작', exact: true }).click();
    assert.equal(await page.getByLabel('연결 코드', { exact: true }).count(), 0);
    await page.waitForFunction(() => document.querySelector('.writer-action-row')?.dataset.state === 'ready');
    await statusOf(page).getByText('연결됨', { exact: true }).waitFor();
    await row.locator('button[title]').filter({ hasText: record.title }).click();
    await detail.getByRole('tab', { name: '기록 정리', exact: true }).click();
    await page.waitForFunction(() => {
      const button = document.querySelector('[aria-label="전체 요약 정리"]');
      return button && !button.disabled;
    }, null, { timeout: 10000 });
    assert.ok(authenticatedModelRequests > 0, 'successful pairing must refresh model readiness with the new session');
    assert.equal(await summaryButton.isEnabled(), true, 'an automatically startable managed runtime must unlock the skipped summary');
    assert.deepEqual(await page.evaluate(() => window.__readinessInteractions), { focus: 0, settings: 0 },
      'readiness recovery must not require focus or settings changes');
    assert.equal(await page.getByRole('dialog', { name: '설정', exact: true }).count(), 0);
    assert.deepEqual(errors, []);
    console.log('ok - pairing refreshes skipped-summary readiness without settings or focus');
  } catch (error) {
    console.error('summary readiness body:', (await page.locator('body').innerText()).slice(0, 2000));
    throw error;
  } finally {
    await page.close();
  }
};

// Connected but a required model is missing: the rail must not claim 분석 준비 완료, and 모델 받기 must be there (WR-2).
const verifyMissingModelsAfterPairing = async browser => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  // The first-visit notice is covered by the main flow; this scenario starts from a returning browser.
  await page.addInitScript(() => window.localStorage.setItem('localProcessingIntroSeen', '1'));
  const sessionToken = 'missing-models-ui-test-session-token';
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = (payload, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(payload) });
    const authorized = route.request().headers().authorization === `Bearer ${sessionToken}`;
    if (path === '/api/models/status') {
      if (!authorized) return json({ detail: 'local engine authorization required' }, 401);
      return json({
        ready: false,
        errors: [],
        models: [{ key: 'stt_faster_whisper', label: 'faster-whisper', installed: false, required: true, downloadable: true }],
        summary_ready: false,
      });
    }
    if (path === '/api/probe') return json({
      product_id: 'barorok-local-engine', engine_version: '0.1.0-test', api_contract_version: 1,
      capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'],
      auth_state: 'pairing-required', pairing_available: true, update_required: false,
    });
    if (path === '/api/pair/start') return json({ mode: 'browser-connection', pairing_id: 'missing-models-pairing', expires_in_seconds: 120 });
    if (path === '/api/pair/complete') {
      return json({ session_token: sessionToken, expires_at: Math.floor(Date.now() / 1000) + 300,
        capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] });
    }
    if (path === '/api/settings') return json({});
    if (path === '/api/health') return json({ ok: true });
    if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
    return json({ detail: 'not used by missing-model regression' }, 404);
  });
  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    const rail = statusRowOf(page);
    await rail.getByRole('button', { name: '연결 시작', exact: true }).click();
    assert.equal(await page.getByLabel('연결 코드', { exact: true }).count(), 0);
    const status = statusOf(page);
    await status.getByText('모델을 받아야 분석할 수 있습니다', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await rowState(page), 'models-missing');
    assert.equal(await status.getByText('음성 인식', { exact: true }).count(), 1, 'the sub-line lists what to download');
    assert.equal(await page.getByText('분석 준비 완료', { exact: true }).count(), 0, 'connected is not ready while a required model is missing');
    assert.equal(await page.getByText('연결됨', { exact: true }).count(), 0, 'only the first blocked step is named');
    assert.equal(await page.getByText('준비할 모델', { exact: true }).count(), 0, 'no readiness banner below the form');
    assert.equal(await page.locator('.status-banner').count(), 0);
    assert.equal(await rail.getByRole('button', { name: '문제 해결 도움말' }).count(), 0, '모델 받기 is the whole fix, so there is no ?');
    const start = rail.getByRole('button', { name: '분석 시작', exact: true });
    assert.equal(await isAriaDisabled(start), true);
    assert.equal(await start.evaluate(element => element.hasAttribute('disabled')), false, 'a blocked start stays focusable');
    assert.equal(await start.getAttribute('aria-describedby'), 'writer-local-engine-requirement');
    await start.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'writer-local-engine-requirement');
    assert.equal(await page.getByRole('dialog', { name: '설정', exact: true }).count(), 0);
    await rail.getByRole('button', { name: '모델 받기', exact: true }).click();
    const settingsDialog = page.getByRole('dialog', { name: '설정', exact: true });
    await settingsDialog.waitFor({ state: 'visible', timeout: 10000 });
    assert.equal(await page.getByRole('tab', { name: '모델' }).getAttribute('aria-selected'), 'true', '모델 받기 opens Settings > 모델');
    assert.deepEqual(errors, []);
    console.log('ok - connected web app shows 모델 받기 instead of claiming readiness');
  } catch (error) {
    console.error('missing models body:', (await page.locator('body').innerText()).slice(0, 2000));
    throw error;
  } finally {
    await page.close();
  }
};

const waitUntil = async (condition, message, timeoutMs = 10_000) => {
  const deadline = Date.now() + timeoutMs;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting: ${message}`);
    await sleep(50);
  }
};

// Connected, then the engine stops answering the readiness check (design.md 동작 줄 v2 응답 없음):
// 45s of 분석 준비 확인 중 becomes a warning whose 다시 확인 checks the connection, then readiness.
const verifyReadinessNoResponse = async browser => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    window.localStorage.setItem('localProcessingIntroSeen', '1');
    // '기기에 있는 앱' already allowed: no prompt can hold the user's check, so it has a time limit.
    // (Headless Chromium otherwise reports the permission as undecided.)
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = descriptor => descriptor?.name === 'loopback-network'
      ? Promise.resolve({ state: 'granted' })
      : query(descriptor);
  });
  await page.clock.install();
  const grant = { session_token: 'no-response-ui-test-session-token',
    // The page clock runs minutes ahead of this process once the test fast-forwards it.
    expires_at: Math.floor(Date.now() / 1000) + 3600,
    capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] };
  // answer: the engine answers. silent: nothing answers (the page gives up on readiness requests after 15s).
  // models-silent: health answers, model status never does. models-failing: model status answers 503.
  // gone: the engine is not running.
  let engine = 'answer';
  let probes = 0;
  let healthRequests = 0;
  let modelRequests = 0;
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/settings') return json({});
    if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
    if (path === '/api/probe') probes += 1;
    if (path === '/api/health') healthRequests += 1;
    if (path === '/api/models/status') modelRequests += 1;
    if (engine === 'gone') return route.abort('connectionrefused');
    if (engine === 'silent' || (engine === 'models-silent' && path === '/api/models/status')) return undefined;
    if (path === '/api/probe') return json({ product_id: 'barorok-local-engine', engine_version: 'test',
      api_contract_version: 1, capabilities: grant.capabilities, auth_state: 'pairing-required',
      pairing_available: true, pairing_mode: 'browser-connection', update_required: false });
    if (path === '/api/pair/start') return json({ mode: 'browser-connection', pairing_id: 'no-response-challenge', expires_in_seconds: 120 });
    if (path === '/api/pair/complete') return json(grant);
    if (path === '/api/health') return json({ ok: true });
    if (path === '/api/models/status' && engine === 'models-failing') return json({ detail: 'model status failed' }, 503);
    if (path === '/api/models/status') return route.request().headers().authorization === `Bearer ${grant.session_token}`
      ? json({ ready: true, models: [], errors: [] }) : json({}, 401);
    return json({}, 404);
  });
  const rail = statusRowOf(page);
  const status = statusOf(page);
  const start = rail.getByRole('button', { name: '분석 시작', exact: true });
  const waitForRowState = state => page.locator(`.writer-action-row[data-state="${state}"]`).waitFor();
  const noResponseTitle = `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 응답하지 않습니다`;
  const warningShown = () => status.getByText(noResponseTitle, { exact: true }).count();
  // The count starts once the row shows the check: 43s later it still checks, 47s later it warns.
  // The page clock also runs in real time, so each side keeps a 2s margin for a busy machine.
  const expectWarningAfter45s = async () => {
    await page.clock.runFor(43_000);
    assert.equal(await rowState(page), 'readiness-checking', '43s of checking is still a check');
    assert.equal(await warningShown(), 0);
    await page.clock.runFor(4_000);
    await waitForRowState('no-response');
    assert.equal(await status.getByText('분석 준비 확인 중', { exact: true }).count(), 0);
  };
  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    await waitForRowState('ready');
    await status.getByText('연결됨', { exact: true }).waitFor();
    assert.equal(await isAriaDisabled(start), false);

    // The engine stops answering. The next check (window focus) keeps the last answer until its request gives up.
    engine = 'silent';
    const healthBefore = healthRequests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitUntil(async () => healthRequests > healthBefore, 'the focus check reaches the engine');
    assert.equal(await rowState(page), 'ready');
    await page.clock.runFor(15_000);
    await waitForRowState('readiness-checking');
    await expectWarningAfter45s();
    assert.deepEqual(await status.evaluate(element => [
      element.querySelector('.writer-status-title')?.textContent,
      element.querySelector('.writer-status-message')?.textContent,
    ]), [noResponseTitle, '잠시 뒤 다시 확인해 주세요.']);
    assert.equal(await rail.locator('.writer-status-line').getAttribute('class'), 'writer-status-line writer-status-warning');
    assert.deepEqual(await rail.getByRole('button').allInnerTexts(), ['', '다시 확인', '분석 시작'], '?, one fix, then 분석 시작');
    assert.equal(await isAriaDisabled(start), true);
    assert.equal(await page.locator('#writer-readiness-hint, #writer-engine-checking, .status-banner').count(), 0, 'no banner or old hint line');
    const helpToggle = rail.getByRole('button', { name: '문제 해결 도움말', exact: true });
    await helpToggle.click();
    assert.equal(await page.locator('#writer-status-help').innerText(),
      `계속되면 Windows 시작 메뉴에서 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 실행하세요.`);

    // 다시 확인 checks the connection first. The engine never answers it, so after 15s the row says the
    // connection failed instead of checking forever.
    const probesBeforeRecheck = probes;
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await waitForRowState('readiness-checking');
    assert.equal(await warningShown(), 0, 'the old warning gives way to the new check');
    assert.equal(await page.locator('#writer-status-help').count(), 0);
    await waitUntil(() => page.evaluate(() => document.activeElement?.id === 'writer-local-engine-requirement'),
      'focus follows to the line that reports the check');
    await waitUntil(async () => probes > probesBeforeRecheck, 'the press checks the connection');
    await sleep(300);
    assert.equal(probes, probesBeforeRecheck + 1, 'one connection check per press');
    // The probe's 15s started at the click, so each side keeps a 2s margin like expectWarningAfter45s.
    const expectFailedAfter15s = async waitingState => {
      await page.clock.runFor(13_000);
      assert.equal(await rowState(page), waitingState, '13s in, the check is still waiting');
      await page.clock.runFor(4_000);
      await waitForRowState('unreachable');
      assert.equal(await status.locator('.writer-status-title').innerText(), '연결하지 못했습니다');
      assert.equal(await warningShown(), 0);
    };
    await expectFailedAfter15s('readiness-checking');

    // The connection row's own 다시 확인 also gives up after 15s instead of spinning.
    const probesBeforeRowCheck = probes;
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await waitUntil(async () => probes > probesBeforeRowCheck, 'the row check reaches the engine');
    await waitForRowState('checking');
    await status.getByText('연결 확인 중', { exact: true }).waitFor();
    await expectFailedAfter15s('checking');

    // The engine answers again: 다시 확인 recovers without a reload.
    engine = 'answer';
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await waitForRowState('ready');
    await status.getByText('연결됨', { exact: true }).waitFor();
    assert.equal(await warningShown(), 0);
    assert.equal(await isAriaDisabled(start), false, 'a recovered engine unlocks 분석 시작');

    // Health answers but the model check never does: the same 45s warning.
    engine = 'models-silent';
    const modelsBefore = modelRequests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitUntil(async () => modelRequests > modelsBefore, 'the focus check asks for model status');
    assert.equal(await rowState(page), 'ready');
    await page.clock.runFor(15_000);
    await waitForRowState('readiness-checking');
    await expectWarningAfter45s();

    // The engine answers again on its own: the slow re-check finds it without a click, and the next
    // check that waits starts from the plain spinner, not the warning it once had.
    engine = 'answer';
    await waitUntil(async () => {
      await page.clock.runFor(5_000);
      return (await rowState(page)) === 'ready';
    }, 'the slow re-check finds the engine again', 30_000);
    assert.equal(await warningShown(), 0);
    engine = 'models-silent';
    const modelsBeforeRetry = modelRequests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitUntil(async () => modelRequests > modelsBeforeRetry, 'the next focus check asks for model status');
    await page.clock.runFor(15_000);
    await waitForRowState('readiness-checking');
    assert.equal(await warningShown(), 0, 'an answered check leaves no warning for the next one');
    await expectWarningAfter45s();

    // The engine goes away and comes back: the reconnect starts a fresh 45s instead of keeping the warning.
    engine = 'gone';
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await waitForRowState('unreachable');
    assert.equal(await status.locator('.writer-status-title').innerText(), '연결하지 못했습니다', 'a refused check after connecting is not a first visit');
    assert.equal(await warningShown(), 0);
    engine = 'models-silent';
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await waitForRowState('readiness-checking');
    assert.equal(await warningShown(), 0, 'no warning left over from before the reconnect');
    await expectWarningAfter45s();

    engine = 'answer';
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await waitForRowState('ready');
    assert.equal(await isAriaDisabled(start), false);

    // An engine that answers, even with an error, is not silent: each answer restarts the 45s, so the loop's
    // own check at 45s reports the error without a 응답하지 않습니다 in between.
    engine = 'models-failing';
    await page.evaluate(() => {
      window.__noResponseRowStates = [];
      new MutationObserver(() => window.__noResponseRowStates.push(document.querySelector('.writer-action-row')?.dataset.state))
        .observe(document.querySelector('.writer-action-row'), { attributes: true, attributeFilter: ['data-state'] });
    });
    let answeredModels = modelRequests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    // One second at a time, so the engine answers about once per page second like the real loop.
    for (let step = 0; step < 60 && (await rowState(page)) !== 'readiness-error'; step += 1) {
      await waitUntil(async () => modelRequests > answeredModels || (await rowState(page)) === 'readiness-error', 'the next soft check');
      answeredModels = modelRequests;
      await sleep(50);
      await page.clock.runFor(1_000);
    }
    await waitForRowState('readiness-error');
    assert.equal(await status.locator('.writer-status-title').innerText(), '분석 준비 상태를 확인하지 못했습니다');
    assert.deepEqual(await page.evaluate(() => window.__noResponseRowStates), ['readiness-checking', 'readiness-error'],
      'no 응답하지 않습니다 while the engine answers');

    // 다시 확인 from that error when the engine has gone silent: it re-checks readiness only (no
    // connection check), its request gives up after 15s, and the spinner that follows turns into the
    // warning 45s later instead of running on.
    engine = 'silent';
    const healthBeforeRecheck = healthRequests;
    const probesBeforeReadinessRecheck = probes;
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await waitUntil(async () => healthRequests > healthBeforeRecheck, 'the readiness re-check reaches the engine');
    await page.clock.runFor(15_000);
    await waitForRowState('readiness-checking');
    await expectWarningAfter45s();
    assert.equal(probes, probesBeforeReadinessRecheck, 'this 다시 확인 re-checks readiness, not the connection');
    assert.deepEqual(errors, []);
    console.log('ok - a connected engine that stops answering readiness warns after 45s and 다시 확인 recovers');
  } catch (error) {
    console.error('no-response body:', (await page.locator('body').innerText()).slice(0, 2000));
    throw error;
  } finally {
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.close();
  }
};

const verifyBrowserBlockedConnection = async browser => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => {
    window.localStorage.setItem('localProcessingIntroSeen', '1');
    // Stand-in for Chrome's '기기에 있는 앱' setting; the test flips it like a user would.
    window.__loopbackPermission = 'denied';
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = descriptor => descriptor?.name === 'loopback-network'
      ? Promise.resolve({ state: window.__loopbackPermission })
      : query(descriptor);
  });
  let probes = 0;
  let engineAnswersOpaque = false;
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/probe') probes += 1;
    // An extension that rewrites Origin lets no-cors requests through but fails every CORS read.
    // A no-cors GET carries no Origin header, which is how this stand-in tells the two apart.
    const headers = await route.request().allHeaders();
    if (engineAnswersOpaque && path === '/api/probe' && !headers.origin) {
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    }
    // Both a browser block and a stopped engine look like a refused request to the page.
    return route.abort('connectionrefused');
  });
  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    const rail = statusRowOf(page);
    const status = statusOf(page);
    await status.getByText('브라우저가 연결을 막고 있습니다', { exact: true }).waitFor();
    assert.equal(await rowState(page), 'browser-blocked', 'the automatic check reports the block before any click');
    assert.equal(await status.innerText().then(text => text.includes('사이트 정보에서 ‘기기에 있는 앱’을 허용해 주세요.')), true);
    assert.ok(!(await rail.innerText()).includes(`${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행`), 'a browser block is not explained as a stopped engine');
    assert.equal(await rail.getByRole('link').count(), 0, 'reinstalling is not offered for a denied permission');
    assert.deepEqual(await rail.getByRole('button').allInnerTexts(), ['', '다시 확인', '분석 시작'], 'one fix beside 분석 시작, plus ?');
    assert.ok(probes >= 1);

    // ? opens the longer guidance outside the live region and folds when the state changes.
    const helpToggle = rail.getByRole('button', { name: '문제 해결 도움말', exact: true });
    const lineHeightBefore = (await rail.locator('.writer-status-line').boundingBox()).height;
    assert.equal(await helpToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.locator('#writer-status-help').isVisible(), false);
    await helpToggle.click();
    assert.equal(await helpToggle.getAttribute('aria-expanded'), 'true');
    await page.locator('#writer-status-help').getByText(/주소창 왼쪽의 사이트 정보 아이콘/).waitFor();
    assert.equal(await page.locator('[role="status"] #writer-status-help, [aria-live] #writer-status-help').count(), 0, 'help is outside the live region');
    assert.equal(await page.locator('.writer-action-row [aria-live]').count(), 0, 'no aria-live over the whole action row');
    assert.equal((await rail.locator('.writer-status-line').boundingBox()).height, lineHeightBefore, 'the 24px ? does not grow the status line');

    // The user allows access but the engine is still not running.
    await page.evaluate(() => { window.__loopbackPermission = 'granted'; });
    const probesBeforeClick = probes;
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await status.getByText('연결 확인 중', { exact: true }).waitFor();
    assert.equal(await rowState(page), 'checking', 'a fast failure still shows the retry happening');
    assert.equal(await page.locator('#writer-status-help').count(), 0, 'the check folds the help');
    await status.getByText(`${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행한 뒤 다시 확인해 주세요.`, { exact: true }).waitFor();
    assert.equal(await rowState(page), 'unreachable');
    assert.equal(await status.getByText('브라우저가 연결을 막고 있습니다', { exact: true }).count(), 0);
    assert.ok(probes > probesBeforeClick);

    // Retrying from the plain failure also shows the check instead of looking unchanged.
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await status.getByText('연결 확인 중', { exact: true }).waitFor();
    await status.getByText(`${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행한 뒤 다시 확인해 주세요.`, { exact: true }).waitFor();

    // A background re-check (window focus, or every 10s) keeps the settled line, its buttons and open help.
    const plainHelpToggle = rail.getByRole('button', { name: '문제 해결 도움말', exact: true });
    await plainHelpToggle.click();
    await page.locator('#writer-status-help').getByText(/Windows 시작 메뉴에서/).waitFor();
    await page.evaluate(() => {
      window.__rowStates = [];
      new MutationObserver(() => window.__rowStates.push(document.querySelector('.writer-action-row')?.dataset.state))
        .observe(document.querySelector('.writer-action-row'), { attributes: true, attributeFilter: ['data-state'] });
    });
    const probesBeforeFocus = probes;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    const focusDeadline = Date.now() + 5000;
    while (probes === probesBeforeFocus && Date.now() < focusDeadline) await sleep(50);
    assert.ok(probes > probesBeforeFocus, 'window focus started a background re-check');
    await sleep(800);
    assert.deepEqual(await page.evaluate(() => window.__rowStates), [], 'a background re-check does not flash 연결 확인 중');
    assert.equal(await rowState(page), 'unreachable');
    assert.equal(await plainHelpToggle.getAttribute('aria-expanded'), 'true', 'the help the user opened stays open');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '문제 해결 도움말', 'focus stays where the user left it');
    await plainHelpToggle.click();
    assert.equal(await page.locator('#writer-status-help').isVisible(), false);

    // The engine now answers, but the browser refuses to let the page read it.
    engineAnswersOpaque = true;
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await status.getByText('연결 확인 중', { exact: true }).waitFor();
    await status.getByText('브라우저가 연결을 막고 있습니다', { exact: true }).waitFor();
    assert.match(await status.innerText(), /요청을 바꾸는 확장 프로그램을 꺼 주세요/);
    assert.doesNotMatch(await rail.innerText(), /기기에 있는 앱/, 'the permission is already allowed here');
    assert.doesNotMatch(await rail.innerText(), /실행한 뒤/);
    await rail.getByRole('button', { name: '문제 해결 도움말', exact: true }).click();
    await page.locator('#writer-status-help').getByText(/다시 설치해 주세요/).waitFor();
    console.log('ok - browser blocks are told apart from a stopped engine and retries visibly check');
  } finally { await page.close(); }
};

// Serves the dev app from a public-looking HTTPS origin, where Chrome would ask before the
// page may reach 127.0.0.1. The prompt itself is stood in for by a permissions/fetch stub.
const PUBLIC_TEST_ORIGIN = 'https://barorok.test';
const verifyPermissionPromptWaitsForUser = async browser => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.route(`${PUBLIC_TEST_ORIGIN}/**`, async route => {
    const requested = new URL(route.request().url());
    const response = await route.fetch({ url: new URL(`${requested.pathname}${requested.search}`, APP_URL).toString() });
    return route.fulfill({ response });
  });
  await page.addInitScript(() => {
    window.localStorage.setItem('localProcessingIntroSeen', '1');
    window.__loopbackPermission = 'prompt';
    window.__allowWhenAsked = false;
    window.__promptsShown = 0;
    const query = navigator.permissions.query.bind(navigator.permissions);
    navigator.permissions.query = descriptor => descriptor?.name === 'loopback-network'
      ? Promise.resolve({ state: window.__loopbackPermission })
      : query(descriptor);
    // Chrome asks on the first request to this PC while undecided; the test answers for the user.
    const originalFetch = window.fetch.bind(window);
    window.fetch = (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith('http://127.0.0.1') && window.__loopbackPermission === 'prompt') {
        window.__promptsShown += 1;
        if (!window.__allowWhenAsked) return Promise.reject(new TypeError('Failed to fetch'));
        window.__loopbackPermission = 'granted';
      }
      return originalFetch(input, init);
    };
  });
  const engineRequests = [];
  const grant = { session_token: 'permission-prompt-test-session-token',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] };
  await page.route('http://127.0.0.1:17863/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    engineRequests.push(path);
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json',
      headers: { 'Access-Control-Allow-Origin': PUBLIC_TEST_ORIGIN }, body: JSON.stringify(body) });
    if (path === '/api/probe') return json({ product_id: 'barorok-local-engine', engine_version: 'test',
      api_contract_version: 1, capabilities: grant.capabilities, auth_state: 'pairing-required',
      pairing_available: true, pairing_mode: 'browser-connection', update_required: false });
    if (path === '/api/pair/start') return json({ mode: 'browser-connection', pairing_id: 'permission-prompt-challenge', expires_in_seconds: 120 });
    if (path === '/api/pair/complete' || path === '/api/pair/restore') return json(grant);
    if (path === '/api/models/status') return json({ ready: true, models: [], errors: [] });
    if (path === '/api/health') return json({ ok: true });
    if (path === '/api/settings') return json({});
    if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
    return json({}, 404);
  });
  try {
    const url = new URL(APP_URL);
    await page.goto(`${PUBLIC_TEST_ORIGIN}${url.pathname}${url.search}`, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    const rail = statusRowOf(page);
    const status = statusOf(page);
    // domcontentloaded returns before a cold Vite has served the app's modules through the route.
    await status.getByText('연결 확인 후 Chrome이 물으면 ‘허용’을 눌러 주세요.', { exact: true })
      .waitFor({ timeout: PAGE_GOTO_TIMEOUT_MS });
    await status.getByText(`${withJosa(LOCAL_ENGINE_NAME, '이/가')} 필요합니다`, { exact: true }).waitFor();
    assert.equal(await rowState(page), 'intro', 'an undecided permission is not shown as a failure');
    assert.doesNotMatch(await rail.innerText(), /자동/, 'the first visit does not promise an automatic connection');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(2500);
    assert.deepEqual(engineRequests, [], 'nothing reaches this PC, so Chrome has no reason to ask yet');
    assert.equal(await page.evaluate(() => window.__promptsShown), 0, 'no prompt before the user acts');

    // The user clicks, Chrome asks, and the user closes the prompt. The page cannot tell this
    // from an engine that never answered, so it keeps the install guidance and adds the hint.
    await rail.getByRole('button', { name: '연결 확인', exact: true }).click();
    await status.getByText('Chrome이 ‘기기에 있는 앱’을 물으면 ‘허용’을 눌러 주세요.', { exact: true }).waitFor();
    assert.equal(await rowState(page), 'checking');
    await page.waitForFunction(() => document.querySelector('.writer-action-row')?.dataset.state === 'unreachable');
    await status.getByText(`${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행하고, Chrome이 물으면 ‘허용’을 눌러 주세요.`, { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__promptsShown), 1);
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await sleep(1500);
    assert.equal(await page.evaluate(() => window.__promptsShown), 1, 'a background re-check does not raise the prompt again');
    assert.deepEqual(engineRequests, []);

    // The user clicks again and allows this time.
    await page.evaluate(() => { window.__allowWhenAsked = true; });
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await status.getByText('연결됨', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.__promptsShown), 2);
    assert.equal(engineRequests[0], '/api/probe', 'the first request to this PC is the user\'s own check');
    assert.ok(engineRequests.includes('/api/pair/start'));
    console.log('ok - an undecided browser permission waits for 연결 확인 and explains the prompt');
  } finally {
    // A proxied module still in route.fetch would otherwise fail the run with TargetClosedError and hide the real error.
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await page.close();
  }
};

const verifyAutomaticEngineConnection = async browser => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  page.setDefaultTimeout(15000);
  await page.addInitScript(() => window.localStorage.setItem('localProcessingIntroSeen', '1'));
  let starts = 0;
  let restores = 0;
  let browserToken;
  const grant = { session_token: 'automatic-connection-test-session-token',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] };
  await page.route('**/api/**', route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/probe') return json({ product_id: 'barorok-local-engine', engine_version: 'test',
      api_contract_version: 1, capabilities: grant.capabilities, auth_state: 'pairing-required',
      pairing_available: true, pairing_mode: 'browser-connection', update_required: false });
    if (path === '/api/pair/start') {
      starts += 1;
      const payload = route.request().postDataJSON();
      assert.equal(payload.mode, 'browser-connection');
      browserToken = payload.browser_token;
      return json({ mode: 'browser-connection', pairing_id: 'automatic-connection-challenge', expires_in_seconds: 120 });
    }
    if (path === '/api/pair/complete') return json(grant);
    if (path === '/api/pair/restore') {
      restores += 1;
      assert.equal(route.request().postDataJSON().browser_token, browserToken);
      return json(grant);
    }
    if (path === '/api/models/status') return route.request().headers().authorization === `Bearer ${grant.session_token}`
      ? json({ ready: true, models: [], errors: [] }) : json({}, 401);
    if (path === '/api/health') return json({ ok: true });
    if (path === '/api/settings') return json({});
    if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
    return json({}, 404);
  });
  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    const status = statusOf(page);
    await status.getByText('연결됨', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.tagName), 'BODY', 'a connection the page made itself does not move focus');
    assert.equal(starts, 1);
    assert.equal(await page.getByLabel('연결 코드', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('dialog', { name: '이 브라우저 연결' }).count(), 0);
    await page.reload({ waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    await status.getByText('연결됨', { exact: true }).waitFor();
    assert.equal(starts, 1, 'reload restores the same browser instead of creating another connection');
    assert.ok(restores > 0);
    console.log('ok - installed engine connects automatically and survives reload without code or confirmation');
  } finally { await page.close(); }
};

// Connected and ready: the form's own blocks take the status row in order (design.md 동작 줄 v2 ③) —
// required fields, file length, another analysis, the same file running, and the resume states.
const verifyInputStage = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  const fixtureDir = await mkdtemp(join(tmpdir(), 'lmo-input-stage-'));
  const samePath = join(fixtureDir, 'same-file.mp4');
  await writeFile(samePath, Buffer.alloc(32, 7));
  const sameFile = { name: 'same-file.mp4', size: 32, lastModified: Math.trunc((await stat(samePath)).mtimeMs) };
  const okFile = { name: 'ok.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('input stage fixture') };
  const jobId = 'input-stage-job';
  const errors = [];
  const analyzeRequests = [];
  let statusRequests = 0;
  let remoteDraft = { job_id: jobId, status: 'active', stage: 'transcribing', resume_supported: true, completed_chunk_count: 1 };
  let holdStatuses = null;
  let failStatuses = false;
  page.on('pageerror', error => errors.push(error.message));
  page.on('dialog', dialog => dialog.accept());
  await page.addInitScript(() => {
    window.localStorage.setItem('localProcessingIntroSeen', '1');
    // Only over.wav reports a length past the 2-hour limit; other files keep the browser's own metadata.
    const names = new Map();
    const createObjectUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      const url = createObjectUrl(blob);
      names.set(url, blob.name);
      return url;
    };
    const createElement = document.createElement.bind(document);
    document.createElement = (tag, options) => {
      const element = createElement(tag, options);
      if (tag === 'audio' || tag === 'video') {
        const descriptor = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src');
        Object.defineProperty(element, 'src', {
          set(url) {
            if (names.get(url) !== 'over.wav') return descriptor.set.call(element, url);
            Object.defineProperty(element, 'duration', { configurable: true, value: 7200.001 });
            queueMicrotask(() => element.dispatchEvent(new Event('loadedmetadata')));
          },
          get() { return descriptor.get.call(element); },
        });
      }
      return element;
    };
  });
  const grant = { session_token: 'input-stage-test-session-token',
    expires_at: Math.floor(Date.now() / 1000) + 300,
    capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] };
  await page.route('**/api/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const json = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (path === '/api/probe') return json({ product_id: 'barorok-local-engine', engine_version: 'test',
      api_contract_version: 1, capabilities: grant.capabilities, auth_state: 'pairing-required',
      pairing_available: true, pairing_mode: 'browser-connection', update_required: false });
    if (path === '/api/pair/start') return json({ mode: 'browser-connection', pairing_id: 'input-stage-challenge', expires_in_seconds: 120 });
    if (path === '/api/pair/complete' || path === '/api/pair/restore') return json(grant);
    if (path === '/api/models/status') return json({ ready: true, models: [], errors: [] });
    if (path === '/api/health') return json({ ok: true });
    if (path === '/api/settings') return json({});
    if (path === '/api/analyze/draft-statuses') {
      statusRequests += 1;
      if (holdStatuses) await holdStatuses.promise;
      if (failStatuses) return json({ detail: 'draft status check failed' }, 500);
      const requested = route.request().postDataJSON()?.job_ids ?? [];
      return json({ drafts: requested.includes(jobId) ? [remoteDraft] : [] });
    }
    if (path.startsWith('/api/analyze')) {
      analyzeRequests.push(path);
      return json({ detail: 'the input step must not start an analysis' }, 500);
    }
    return json({}, 404);
  });
  const rail = statusRowOf(page);
  const status = statusOf(page);
  const start = rail.locator('.writer-start-button');
  const waitState = state => page.waitForFunction(
    expected => document.querySelector('.writer-action-row')?.dataset.state === expected, state,
  );
  const expectRow = async (state, title, message) => {
    await waitState(state);
    assert.equal(await status.locator('.writer-status-title').innerText(), title, `${state}: title`);
    assert.equal(await status.locator('.writer-status-message').innerText(), message, `${state}: sub-line`);
  };
  const fixButtons = () => rail.locator('.writer-hint-action').allInnerTexts();
  const activeId = () => page.evaluate(() => document.activeElement?.id ?? '');
  const pressBlockedStart = async state => {
    assert.equal(await isAriaDisabled(start), true, `${state}: 분석 시작 is blocked`);
    assert.equal(await start.evaluate(element => element.hasAttribute('disabled')), false, `${state}: but stays focusable`);
    await start.focus();
    await page.keyboard.press('Enter');
    await page.waitForFunction(() => document.activeElement?.id === 'writer-local-engine-requirement');
  };
  const expectNoOldSurfaces = async state => {
    assert.equal(await page.locator('.status-banner').count(), 0, `${state}: no banner under the form`);
    assert.equal(await page.locator('[id="writer-form-error"]').count(), state === 'required-fields' ? 1 : 0, `${state}: one list id at most`);
    assert.equal(await page.locator('#writer-resume-note, #writer-same-file-note, .writer-analysis-blocked-note').count(), 0,
      `${state}: nothing said again under the upload area or below the form`);
    assert.equal(await start.getAttribute('aria-describedby'), 'writer-local-engine-requirement', `${state}: one description`);
    assert.doesNotMatch(await start.innerText(), /준비 필요|이어하기 불가/);
  };
  const setDrafts = drafts => page.evaluate(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify(value));
    window.dispatchEvent(new Event('analysis-resume-drafts:updated'));
  }, drafts);
  try {
    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    await status.getByText('연결됨', { exact: true }).waitFor();
    await waitState('ready');
    assert.equal(await page.locator('#writer-form-error').count(), 0, 'before 분석 시작 nothing is listed');
    assert.equal(await start.getAttribute('aria-disabled'), null);
    // In page coordinates: moving focus to a field may scroll the window, which is not the row moving.
    const startBox = () => start.evaluate(element => {
      const box = element.getBoundingClientRect();
      return { x: box.x + window.scrollX, y: box.y + window.scrollY, width: box.width, height: box.height };
    });
    const readyBox = await startBox();
    const rowHeight = async () => Math.round((await rail.boundingBox()).height);
    assert.equal(await rowHeight(), 40, 'the row is the 40px line, without an empty help row under it');

    // Required fields: 분석 시작 stays available, lists what is left in screen order and goes to the first empty field.
    await start.click();
    await expectRow('required-fields', '필수 항목이 비어 있습니다', '영상·음성 파일, 회의 제목, 회의 목적');
    assert.equal(await activeId(), 'meeting-file-drop', 'focus moves to the first empty field on screen');
    assert.equal(await start.getAttribute('aria-disabled'), null, 'empty fields alone do not block 분석 시작');
    assert.equal(await status.locator('.writer-status-message').getAttribute('id'), 'writer-form-error');
    assert.equal(await page.locator('#meeting-file-drop').getAttribute('aria-describedby'), 'writer-form-error');
    assert.equal(await page.locator('#meeting-title').getAttribute('aria-describedby'), 'writer-form-error');
    assert.equal(await page.locator('#meeting-date').getAttribute('aria-describedby'), null, 'a filled field is not described as missing');
    assert.equal(await page.getByText('필수 항목을 확인해 주세요', { exact: false }).count(), 0, 'the old error sentence is gone');
    await expectNoOldSurfaces('required-fields');
    assert.deepEqual(await startBox(), readyBox, '분석 시작 does not move');
    assert.equal(await rowHeight(), 40);
    await page.locator('#meeting-title').fill('입력 단계 확인');
    await expectRow('required-fields', '필수 항목이 비어 있습니다', '영상·음성 파일, 회의 목적');
    assert.equal(await page.locator('#meeting-title').getAttribute('aria-describedby'), null);
    await page.locator('#meeting-purpose').fill('막힌 첫 단계만 말하는지 확인');
    await expectRow('required-fields', '필수 항목이 비어 있습니다', '영상·음성 파일');
    await page.setInputFiles('#meeting-file-input', okFile);
    await waitState('ready');
    assert.equal(await page.locator('#writer-form-error').count(), 0, 'the list disappears once everything is filled');
    assert.equal(await page.locator('#meeting-purpose').getAttribute('aria-describedby'), null);
    await page.locator('#meeting-title').fill('');
    await expectRow('required-fields', '필수 항목이 비어 있습니다', '회의 제목');
    await start.click();
    assert.equal(await activeId(), 'meeting-title', 'with a file chosen, the first empty field is the title');
    await page.locator('#meeting-title').fill('입력 단계 확인');
    await waitState('ready');

    // A file over 2 hours: a warning that 다른 파일 선택 fixes; 분석 시작 is blocked and points at the line.
    await page.setInputFiles('#meeting-file-input', { name: 'over.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(64) });
    await expectRow('file-too-long', '파일이 2시간을 넘습니다', '2시간 이하의 음성·영상 파일을 선택해 주세요.');
    assert.equal(await rail.locator('.writer-status-line').getAttribute('class'), 'writer-status-line writer-status-warning');
    assert.deepEqual(await fixButtons(), ['다른 파일 선택']);
    assert.equal(await page.getByText('선택한 파일은 약', { exact: false }).count(), 0, 'no banner repeats the length');
    await expectNoOldSurfaces('file-too-long');
    await pressBlockedStart('file-too-long');
    // The file card above changed; within the row, 분석 시작 stays on the line's top edge.
    assert.equal(Math.round((await rail.boundingBox()).y), Math.round((await start.boundingBox()).y));
    const chooser = page.waitForEvent('filechooser');
    await rail.getByRole('button', { name: '다른 파일 선택', exact: true }).focus();
    await page.keyboard.press('Enter');
    await (await chooser).setFiles(okFile);
    await waitState('ready');
    assert.equal(await start.getAttribute('aria-disabled'), null);
    assert.equal(await activeId(), 'writer-local-engine-requirement', 'the pressed fix went away; focus follows to the line, not the page');

    // Another run holds the engine (the sidebar's 분석 중 card leads there, so no button).
    const draft = {
      jobId, title: '다른 실행의 회의', date: '2026-10-20T09:30', meetingPurpose: '같은 파일 확인', participants: '',
      sourceFilename: sameFile.name, sourceSize: sameFile.size, sourceLastModified: sameFile.lastModified,
      status: 'active', stage: 'transcribing', createdAt: '2026-10-20T09:30:00.000Z', updatedAt: '2026-10-20T09:31:00.000Z',
      resumeEligible: true, completedChunkCount: 1,
    };
    await setDrafts([draft]);
    await expectRow('other-analysis', '진행 중인 분석이 있습니다', '끝나면 새 회의록을 분석할 수 있습니다.');
    assert.equal(await rail.locator('.writer-status-line').getAttribute('class'), 'writer-status-line writer-status-info');
    assert.deepEqual(await fixButtons(), []);
    assert.equal(await page.locator('#writer-analysis-start-blocked.sr-only').count(), 1, 'the reason stays only for the recovery card');
    await expectNoOldSurfaces('other-analysis');
    await pressBlockedStart('other-analysis');

    // The same file is already running: 상태 확인 asks the engine again.
    await page.setInputFiles('#meeting-file-input', samePath);
    await expectRow('same-file-running', '같은 파일 분석이 이미 진행 중입니다', '먼저 상태를 확인해 주세요.');
    assert.deepEqual(await fixButtons(), ['상태 확인']);
    await expectNoOldSurfaces('same-file-running');
    await pressBlockedStart('same-file-running');
    // Hold the answer so the check 상태 확인 asked for can be seen: it spins and keeps its focus.
    let releaseCheck;
    holdStatuses = { promise: new Promise(resolve => { releaseCheck = resolve; }) };
    const requestsBefore = statusRequests;
    remoteDraft = { job_id: jobId, status: 'stopped', stage: 'stopped', resume_supported: true, completed_chunk_count: 2 };
    const statusCheck = rail.getByRole('button', { name: '상태 확인', exact: true });
    assert.equal(await statusCheck.locator('svg.animate-spin').count(), 0, 'no spinner before it is pressed');
    await statusCheck.focus();
    await page.keyboard.press('Enter');
    await waitUntil(() => statusRequests > requestsBefore, '상태 확인 asks the engine', 3000);
    await statusCheck.locator('svg.animate-spin').waitFor();
    assert.equal(await statusCheck.isEnabled(), true, 'a repeated press only queues one more check');
    assert.equal(await rowState(page), 'same-file-running', 'still running until the engine answers');
    holdStatuses = null;
    releaseCheck();
    await waitState('ready');
    assert.equal(await start.getAttribute('aria-disabled'), null, 'a stopped run no longer blocks the same file');
    // The answer arrives through the draft store, so the focus effect may run just after the row paints.
    await page.waitForFunction(() => document.activeElement?.id === 'writer-local-engine-requirement', null, { timeout: 3000 });

    // Resume: choose the file first, then the same file; 분석 시작 reads 이어하기 throughout.
    await page.locator('.writer-recovery').getByRole('button', { name: '이어서 분석', exact: true }).click();
    await page.getByRole('heading', { name: '이어하기', exact: true }).waitFor();
    await expectRow('resume-choose-file', '이어서 분석할 파일을 선택해 주세요', sameFile.name);
    assert.deepEqual(await fixButtons(), ['파일 선택']);
    assert.equal(await start.innerText(), '이어하기');
    await expectNoOldSurfaces('resume-choose-file');
    await pressBlockedStart('resume-choose-file');
    await page.setInputFiles('#meeting-file-input', okFile);
    await expectRow('resume-other-file', '선택한 파일이 다릅니다', `${sameFile.name} 파일을 다시 선택해 주세요.`);
    assert.deepEqual(await fixButtons(), ['다른 파일 선택']);
    assert.equal(await start.innerText(), '이어하기');
    await expectNoOldSurfaces('resume-other-file');
    await pressBlockedStart('resume-other-file');
    await page.setInputFiles('#meeting-file-input', samePath);
    await waitState('ready');
    assert.equal(await start.innerText(), '이어하기');
    assert.equal(await start.getAttribute('aria-disabled'), null);
    assert.equal(await page.getByText('같은 파일을 확인했습니다', { exact: false }).count(), 0, 'no sentence under the upload area');

    // A background re-check keeps the last answer instead of flashing 이어하기 불가.
    let release;
    holdStatuses = { promise: new Promise(resolve => { release = resolve; }) };
    const heldBefore = statusRequests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitUntil(() => statusRequests > heldBefore, 'a background draft check');
    await sleep(300);
    assert.equal(await rowState(page), 'ready', 'still 연결됨 while the drafts are being checked');
    assert.equal(await start.getAttribute('aria-disabled'), null);
    holdStatuses = null;
    release();

    // A failed check is an answer too: the next background check does not flip it to 연결됨 while it runs.
    failStatuses = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expectRow('resume-unavailable', '이전 분석을 이어서 진행할 수 없습니다', '새 분석으로 시작할 수 있습니다.');
    failStatuses = false;
    holdStatuses = { promise: new Promise(resolve => { release = resolve; }) };
    const afterFailure = statusRequests;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitUntil(() => statusRequests > afterFailure, 'a background draft check after a failed one');
    await sleep(300);
    assert.equal(await rowState(page), 'resume-unavailable', 'the failed answer holds while the next check runs');
    holdStatuses = null;
    release();
    await waitState('ready');

    // The run turns out to be going elsewhere (another window started it), then to have nothing left to reuse.
    remoteDraft = { job_id: jobId, status: 'active', stage: 'transcribing', resume_supported: true, completed_chunk_count: 2 };
    await setDrafts([{ ...draft, status: 'active', completedChunkCount: 2 }]);
    await expectRow('resume-unavailable', '이전 분석을 이어서 진행할 수 없습니다', '진행이 끝나거나 중단된 뒤 이어갈 수 있습니다.');
    assert.equal(await rail.locator('.writer-status-line').getAttribute('class'), 'writer-status-line writer-status-error');
    assert.deepEqual(await fixButtons(), [], 'the selected run outranks another analysis and the same file');
    assert.equal(await start.innerText(), '이어하기');
    await expectNoOldSurfaces('resume-unavailable');
    await pressBlockedStart('resume-unavailable');
    // It finished there and its meeting is saved: nothing to resume, and no hint to analyze it again.
    await setDrafts([{ ...draft, status: 'completed', stage: 'completed', resumeEligible: false, resumeUnavailableReason: 'completed' }]);
    await expectRow('resume-completed', '이 분석은 이미 끝났습니다', '결과는 회의록에서 확인해 주세요.');
    assert.equal(await rail.locator('.writer-status-line').getAttribute('class'), 'writer-status-line writer-status-info');
    assert.equal(await page.getByText('새 분석으로 시작할 수 있습니다.', { exact: true }).count(), 0);
    assert.deepEqual(await fixButtons(), []);
    await expectNoOldSurfaces('resume-completed');
    await pressBlockedStart('resume-completed');
    remoteDraft = { job_id: jobId, status: 'stopped', stage: 'stopped', resume_supported: false, completed_chunk_count: 0 };
    await setDrafts([{ ...draft, status: 'stopped', stage: 'stopped', resumeEligible: false, completedChunkCount: 0 }]);
    await page.waitForFunction(() => document.querySelector('.writer-status-message')?.textContent === '새 분석으로 시작할 수 있습니다.');
    assert.equal(await rowState(page), 'resume-unavailable');
    assert.equal(await page.getByText('이전 분석 기록을 이어서 진행할 수 없습니다', { exact: false }).count(), 0, 'no banner repeats it');
    await expectNoOldSurfaces('resume-unavailable');

    assert.deepEqual(analyzeRequests, [], 'nothing in the input step starts an analysis');
    assert.deepEqual(errors, []);
    console.log('ok - the input step speaks in the status row: required fields, file length, other runs and resume');
  } catch (error) {
    console.error('input stage body:', (await page.locator('body').innerText()).slice(0, 2000));
    throw error;
  } finally {
    await context.close();
    await rm(fixtureDir, { recursive: true, force: true });
  }
};

const verifyIntroDismissals = async browser => {
  // Escape and a click on the dim area close the first-visit notice like 시작하기 does, and count as read.
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  page.setDefaultTimeout(15000);
  await page.route('**/api/**', route => route.abort('connectionrefused'));
  const intro = page.getByRole('dialog', { name: '회의 파일과 대화록은 이 PC 밖으로 나가지 않습니다' });
  const seen = () => page.evaluate(() => window.localStorage.getItem('localProcessingIntroSeen'));
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    await intro.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '시작하기');
    assert.equal(await seen(), null);
    await page.keyboard.press('Escape');
    await intro.waitFor({ state: 'hidden' });
    assert.equal(await seen(), '1', 'Escape counts as having read the notice');

    await page.evaluate(() => window.localStorage.removeItem('localProcessingIntroSeen'));
    await page.reload({ waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    await intro.waitFor({ state: 'visible' });
    assert.equal(await seen(), null);
    // A click inside the dialog is not a backdrop click.
    await intro.getByRole('heading', { name: '회의 파일과 대화록은 이 PC 밖으로 나가지 않습니다' }).click();
    assert.equal(await intro.isVisible(), true, 'a click inside the notice keeps it open');
    assert.equal(await seen(), null);
    await page.mouse.click(8, 8);
    await intro.waitFor({ state: 'hidden' });
    assert.equal(await seen(), '1', 'a backdrop click counts as having read the notice');
    console.log('ok - first-visit notice is remembered after Escape or a backdrop click');
  } finally {
    await context.close();
  }
};

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;
  let probeMode = 'unreachable';
  let pairingStartCount = 0;
  let nativeDecision = 'pending';
  let rememberedBrowserToken;
  let authRecoveryMode = 'off';
  let renewalRequests = 0;
  let recoveryApiRequests = 0;

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    if (process.env.LOCAL_ENGINE_UI_SCENARIO === 'automatic') {
      await verifyAutomaticEngineConnection(browser);
      return;
    }
    if (process.env.LOCAL_ENGINE_UI_SCENARIO === 'permission-prompt') {
      await verifyPermissionPromptWaitsForUser(browser);
      return;
    }
    if (process.env.LOCAL_ENGINE_UI_SCENARIO === 'browser-blocked') {
      await verifyBrowserBlockedConnection(browser);
      return;
    }
    if (process.env.LOCAL_ENGINE_UI_SCENARIO === 'writer-guidance') {
      await verifyDefaultWriterGuidance(browser);
      return;
    }
    if (process.env.LOCAL_ENGINE_UI_SCENARIO === 'summary-readiness') {
      await verifySummaryReadinessAfterPairing(browser);
      return;
    }
    if (process.env.LOCAL_ENGINE_UI_SCENARIO === 'missing-models') {
      await verifyMissingModelsAfterPairing(browser);
      return;
    }
    if (process.env.LOCAL_ENGINE_UI_SCENARIO === 'no-response') {
      await verifyReadinessNoResponse(browser);
      return;
    }
    if (process.env.LOCAL_ENGINE_UI_SCENARIO === 'intro-dismissal') {
      await verifyIntroDismissals(browser);
      return;
    }
    if (process.env.LOCAL_ENGINE_UI_SCENARIO === 'input-stage') {
      await verifyInputStage(browser);
      return;
    }
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(15000);

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
      const payload = route.request().postDataJSON();
      assert.equal(payload.mode, 'browser-connection');
      assert.match(payload.browser_token, /^[A-Za-z0-9_-]{43}$/);
      rememberedBrowserToken = payload.browser_token;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ mode: 'browser-connection', pairing_id: `pairing-id-for-ui-test-${pairingStartCount}`, expires_in_seconds: 120 }),
      });
    });
    await page.route('**/api/pair/complete', async route => {
      const payload = route.request().postDataJSON();
      assert.equal(payload.mode, 'browser-connection');
      assert.equal(payload.code, undefined);
      if (nativeDecision !== 'approved') {
        return route.fulfill({
          status: nativeDecision === 'pending' ? 202 : 403,
          contentType: 'application/json',
          body: JSON.stringify({ status: nativeDecision }),
        });
      }
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
    await page.route('**/api/pair/forget', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ revoked: true }),
    }));
    await page.route('**/api/pair/restore', route => {
      assert.equal(route.request().postDataJSON().browser_token, rememberedBrowserToken);
      return route.fulfill({
        status: authRecoveryMode === 'expired' ? 401 : 200,
        contentType: 'application/json',
        body: JSON.stringify({ session_token: 'restored-session-token-for-ui-test-long-enough',
          expires_at: Math.floor(Date.now() / 1000) + 300,
          capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] }),
      });
    });
    const authRejection = route => route.fulfill({
      status: 401,
      contentType: 'application/json',
      headers: {
        'WWW-Authenticate': 'Bearer',
        'Access-Control-Expose-Headers': 'WWW-Authenticate',
        'Access-Control-Allow-Origin': new URL(APP_URL).origin,
      },
      body: JSON.stringify({ detail: 'local engine authorization required' }),
    });
    await page.route('**/api/session/renew', route => {
      renewalRequests += 1;
      if (authRecoveryMode === 'expired') return authRejection(route);
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          session_token: 'renewed-session-token-for-ui-test-long-enough',
          expires_at: Math.floor(Date.now() / 1000) + 300,
          capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'],
        }),
      });
    });
    await page.route('**/api/outputs/ui-auth-recovery-probe/json', route => {
      recoveryApiRequests += 1;
      if (authRecoveryMode === 'expired' || recoveryApiRequests === 1) return authRejection(route);
      assert.equal(route.request().headers().authorization, 'Bearer renewed-session-token-for-ui-test-long-enough');
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) });
    });
    await page.route('**/api/health', route => route.fulfill({
      status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }),
    }));
    await page.route('**/api/models/status', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ ready: true, models: [], errors: [] }),
    }));

    await page.goto(APP_URL, { waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    const introTitle = '회의 파일과 대화록은 이 PC 밖으로 나가지 않습니다';
    const intro = page.getByRole('dialog', { name: introTitle });
    await intro.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.localStorage.getItem('localProcessingIntroSeen')), null, 'opening the notice is not yet a confirmation');
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '시작하기');
    await intro.getByText(`이를 위해 처음 한 번 ‘${LOCAL_ENGINE_NAME}’ 설치와 분석에 필요한 파일 다운로드가 필요합니다.`, { exact: true }).waitFor();
    const introFootnote = intro.getByText('웹사이트 접속과 프로그램·모델 다운로드에는 인터넷을 사용합니다.', { exact: true });
    assert.equal(await introFootnote.count(), 1);
    assert.equal(await intro.locator('#local-processing-details').count(), 0, 'first visit keeps the details folded');
    const detailsToggle = intro.getByRole('button', { name: '처리 방식 자세히 보기', exact: true });
    assert.equal(await detailsToggle.getAttribute('aria-expanded'), 'false');
    // Focus that left the dialog comes back on Tab: forward to the first button, backward to the last.
    const activeText = () => page.evaluate(() => document.activeElement?.textContent?.trim());
    const blurActive = () => page.evaluate(() => { if (document.activeElement instanceof HTMLElement) document.activeElement.blur(); });
    await blurActive();
    await page.keyboard.press('Tab');
    assert.equal(await activeText(), '처리 방식 자세히 보기', 'Tab from outside the notice returns to its first button');
    await blurActive();
    await page.keyboard.press('Shift+Tab');
    assert.equal(await activeText(), '시작하기', 'Shift+Tab from outside the notice returns to its last button');
    await detailsToggle.click();
    await intro.locator('#local-processing-details').waitFor({ state: 'visible' });
    const foldToggle = intro.getByRole('button', { name: '간단히 보기', exact: true });
    assert.equal(await foldToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await introFootnote.count(), 0, 'the internet row replaces the footnote while details are open');
    await intro.locator('dd').getByText(`웹사이트 접속과 ${LOCAL_ENGINE_NAME}·모델 받기에만 씁니다.`, { exact: true }).waitFor();
    // The dialog's height is capped to the window, so its box always fits; content that does not fit scrolls inside it.
    await page.setViewportSize({ width: 1280, height: 720 });
    const introOverflow = await intro.evaluate(element => element.scrollHeight - element.clientHeight);
    assert.ok(introOverflow <= 0, `expanded notice must show everything without scrolling at 1280x720 (overflow ${introOverflow}px)`);
    await page.setViewportSize({ width: 1280, height: 900 });
    await intro.getByRole('button', { name: '시작하기', exact: true }).click();
    await intro.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.localStorage.getItem('localProcessingIntroSeen')), '1', 'closing the notice is remembered in this browser');
    await page.reload({ waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    const rail = statusRowOf(page);
    const status = statusOf(page);
    await status.getByText(`${withJosa(LOCAL_ENGINE_NAME, '이/가')} 필요합니다`, { exact: true }).waitFor({ state: 'visible' });
    // The second sentence applies while Chrome has not decided the loopback permission (headless may report that).
    assert.ok(['설치했다면 연결 확인을 눌러 주세요.', '연결 확인 후 Chrome이 물으면 ‘허용’을 눌러 주세요.']
      .includes(await status.locator('.writer-status-message').innerText()), 'the first visit asks for 연결 확인 without promising an automatic connection');
    assert.equal(await page.getByRole('dialog', { name: introTitle }).count(), 0, 'the first-visit notice must not repeat in the same browser');
    const analyzeButton = page.getByRole('button', { name: '분석 시작', exact: true });
    assert.equal(await analyzeButton.isDisabled(), true);
    assert.equal(await isAriaDisabled(analyzeButton), true, 'one disabled look: the Button aria-disabled variant');
    assert.deepEqual(await analyzeButton.evaluate(element => ({
      nativeDisabled: element.hasAttribute('disabled'),
      describedBy: element.getAttribute('aria-describedby'),
      classes: [...element.classList].filter(name => name.includes('pending')),
    })), { nativeDisabled: false, describedBy: 'writer-local-engine-requirement', classes: [] });
    assert.deepEqual(await status.evaluate(element => ({
      role: element.getAttribute('role'), atomic: element.getAttribute('aria-atomic'),
    })), { role: 'status', atomic: 'true' });
    assert.equal(await page.locator('.writer-action-row [aria-live], .writer-action-bar').count(), 0, 'no live region over the whole row');
    assert.equal(await rail.getByRole('button', { name: '문제 해결 도움말' }).count(), 0, 'the first visit has no ?');
    // The writer states local processing once, under the title, instead of repeating it in the status row.
    assert.equal(await page.locator('.writer-local-promise').getByText('회의 파일과 대화록은 이 PC 밖으로 나가지 않습니다', { exact: true }).count(), 1);
    assert.equal(await rail.getByText('이 PC 밖으로', { exact: false }).count(), 0);
    assert.equal(await rail.getByRole('button', { name: '로컬 분석 안내' }).count(), 0);

    await page.getByLabel('회의 제목', { exact: true }).fill('연결 상태 보존 회의');
    await page.getByLabel('회의 목적', { exact: true }).fill('연결 전 입력 보존 확인');
    await page.setInputFiles('#meeting-file-input', {
      name: '연결 확인.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('connection ui fixture'),
    });
    await page.getByText('연결 확인.mp3').waitFor({ state: 'visible' });
    const startBoxAtIntro = await analyzeButton.boundingBox();

    await rail.getByRole('button', { name: '연결 확인', exact: true }).click();
    await page.waitForFunction(() => document.activeElement?.id === 'writer-local-engine-requirement');
    await status.getByText('연결하지 못했습니다').waitFor({ state: 'visible' });
    assert.equal(await rowState(page), 'unreachable');
    assert.equal(await rail.getByRole('button', { name: '설치 파일 준비 중', exact: true }).count(), 0);
    assert.equal(await rail.getByRole('button', { name: '문제 해결 도움말', exact: true }).getAttribute('aria-controls'), 'writer-status-help');
    assert.deepEqual(await analyzeButton.boundingBox(), startBoxAtIntro, '분석 시작 does not move when the status changes');

    // At a narrow work surface the buttons drop below the status line, right-aligned and not stretched.
    await page.setViewportSize({ width: 760, height: 900 });
    const narrow = await page.evaluate(() => {
      const box = selector => document.querySelector(selector).getBoundingClientRect();
      const line = box('.writer-status-line');
      const buttons = box('.writer-action-buttons');
      const row = box('.writer-action-row');
      return { below: buttons.top >= line.bottom, rightGap: Math.round(row.right - buttons.right), start: box('.writer-start-button').width };
    });
    assert.equal(narrow.below, true, 'buttons sit under the status line');
    assert.equal(narrow.rightGap, 0, 'buttons are right-aligned');
    assert.equal(Math.round(narrow.start), Math.round(startBoxAtIntro.width), 'buttons are not stretched');
    await page.setViewportSize({ width: 1280, height: 900 });

    probeMode = 'reachable';
    await rail.getByRole('button', { name: '다시 확인', exact: true }).click();
    await status.getByText('이 브라우저를 연결해 주세요').waitFor({ state: 'visible' });
    await rail.getByRole('button', { name: '연결 시작', exact: true }).click();

    await status.getByText('연결 확인 중', { exact: true }).waitFor();
    assert.equal(await page.getByLabel('연결 코드', { exact: true }).count(), 0);
    nativeDecision = 'denied';
    await status.getByText('연결을 완료하지 못했습니다').waitFor({ state: 'visible' });
    // Decide before the click: the fresh request's first poll can arrive before the click resolves.
    nativeDecision = 'approved';
    await rail.getByRole('button', { name: '다시 연결', exact: true }).click();

    await status.getByText('연결됨', { exact: true }).waitFor({ state: 'visible' });
    assert.equal(await rowState(page), 'ready');
    assert.equal(await page.getByText('분석 준비 완료', { exact: true }).count(), 0, 'the old ready sentence is gone');
    assert.equal(await rail.locator('.writer-hint-action').count(), 0, 'nothing to fix, so no buttons besides 분석 시작');
    assert.equal(pairingStartCount, 2, 'a rejected request must be replaced with a fresh connection');
    assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), '연결 상태 보존 회의');
    assert.equal(await page.getByLabel('회의 목적', { exact: true }).inputValue(), '연결 전 입력 보존 확인');
    await page.getByText('연결 확인.mp3').waitFor({ state: 'visible' });
    await analyzeButton.waitFor({ state: 'visible' });
    assert.equal(await analyzeButton.isEnabled(), true, 'a verified connection must unlock analysis');
    assert.equal(await analyzeButton.getAttribute('aria-disabled'), null);
    assert.deepEqual(await analyzeButton.boundingBox(), startBoxAtIntro, '분석 시작 stays put when only 연결됨 is left');

    for (const width of [760, 1100, 1536]) {
      await page.setViewportSize({ width, height: 900 });
      const overflow = await page.evaluate(() => ({
        body: document.body.scrollWidth - document.body.clientWidth,
        root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      }));
      assert.equal(Math.max(overflow.body, overflow.root), 0, `connection UI must not overflow at ${width}px`);
    }
    await page.setViewportSize({ width: 1280, height: 900 });
    authRecoveryMode = 'recover';
    const recoveredStatus = await page.evaluate(async () => {
      const { localEngineClient } = await import('/src/localEngineClient.ts');
      return (await localEngineClient.request('/api/outputs/ui-auth-recovery-probe/json')).status;
    });
    assert.equal(recoveredStatus, 200, 'the mounted provider must register request recovery');
    assert.equal(renewalRequests, 1);
    assert.equal(recoveryApiRequests, 2);
    await status.getByText('연결됨', { exact: true }).waitFor({ state: 'visible' });

    authRecoveryMode = 'expired';
    recoveryApiRequests = 0;
    const expiredStatus = await page.evaluate(async () => {
      const { localEngineClient } = await import('/src/localEngineClient.ts');
      return (await localEngineClient.request('/api/outputs/ui-auth-recovery-probe/json')).status;
    });
    assert.equal(expiredStatus, 401);
    assert.equal(renewalRequests, 2, 'failed renewal must not loop');
    assert.equal(recoveryApiRequests, 1, 'failed renewal must not replay the API request');
    await status.getByText('연결이 만료되었습니다').waitFor({ state: 'visible' });
    assert.deepEqual(await rail.locator('.writer-action-buttons').getByRole('button').allInnerTexts(), ['다시 확인', '다시 연결', '분석 시작']);
    assert.equal(await analyzeButton.isDisabled(), true);
    assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), '연결 상태 보존 회의');
    assert.equal(await page.getByLabel('회의 목적', { exact: true }).inputValue(), '연결 전 입력 보존 확인');
    await page.getByText('연결 확인.mp3').waitFor({ state: 'visible' });
    await verifySummaryReadinessAfterPairing(browser);
    await verifyMissingModelsAfterPairing(browser);
    await verifyReadinessNoResponse(browser);
    await verifyAutomaticEngineConnection(browser);
    await verifyIntroDismissals(browser);
    await verifyInputStage(browser);
    console.log('ok - local engine connection UI and auth recovery simulation');
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
