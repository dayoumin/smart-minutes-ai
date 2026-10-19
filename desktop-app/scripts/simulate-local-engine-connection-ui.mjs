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
          assert.equal(scenario, 'authorization', 'anonymous development recovery must not require pairing');
          return json({ pairing_id: 'writer-guidance-pairing', expires_in_seconds: 120 });
        }
        if (path === '/api/pair/complete') {
          assert.deepEqual(route.request().postDataJSON(), { pairing_id: 'writer-guidance-pairing', code: '123456' });
          return json({ session_token: token, expires_at: Math.floor(Date.now() / 1000) + 300,
            capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] });
        }
        if (path === '/api/analyze') throw new Error('Guidance must not start analysis');
        if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
        if (path === '/api/settings') return json({});
        return json({ detail: 'not used by writer guidance' }, 404);
      });
      await page.goto(url.toString(), { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
      await page.getByLabel('회의 제목 *').fill(`안내 상태 ${scenario}`);
      assert.equal(await page.getByRole('dialog', { name: '회의 내용은 내 PC에서 처리합니다' }).count(), 0, 'the first-visit notice is only for the connection build');
      await page.getByLabel('회의 목적 *').fill('입력과 파일을 보존하며 다음 동작 확인');
      await page.setInputFiles('#meeting-file-input', { name: 'guidance.mp3', mimeType: 'audio/mpeg', buffer: Buffer.from('guidance fixture') });
      const analyze = page.locator('.writer-start-button');
      if (scenario === 'anonymous') {
        await page.waitForFunction(() => !document.querySelector('.writer-start-button')?.disabled);
        assert.equal(await analyze.isEnabled(), true);
        assert.equal(probeCount, 0, 'a working anonymous development API keeps its existing flow');
        assert.equal(await page.locator('.local-engine-connection').count(), 0);
      } else {
        if (scenario === 'outage-recovery') {
          await page.getByText('바로록 연결 확인 중', { exact: true }).waitFor();
          assert.ok(healthCount > 0);
          await page.clock.runFor(47_000);
          await page.getByText('분석 기능의 응답이 없습니다. 연결 상태를 확인해 주세요.', { exact: true }).waitFor();
        } else {
          await page.locator('#writer-readiness-hint').getByText('연결 상태를 확인해야 분석을 시작할 수 있습니다.', { exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: '모델 받기', exact: true }).count(), 0);
        }
        assert.equal(await analyze.isDisabled(), true);
        await page.locator('.writer-action-bar').getByRole('button', { name: '연결 확인', exact: true }).click();
        const rail = page.locator('.local-engine-connection');
        if (scenario === 'outage-recovery') {
          await rail.getByText('분석 기능에 연결하지 못했습니다', { exact: true }).waitFor();
          await rail.getByText('설치했다면 Windows 시작 메뉴에서 바로록 연결을 실행한 뒤 다시 확인하세요.', { exact: true }).waitFor();
          assert.equal(await rail.locator('a[href=""]').count(), 0);
          healthUp = true;
          await rail.getByRole('button', { name: '연결 확인', exact: true }).click();
          await rail.waitFor({ state: 'hidden' });
          assert.equal(await analyze.isEnabled(), true, 'a recovered anonymous API is usable without reloading');
        } else {
          await rail.getByRole('button', { name: '연결 시작', exact: true }).click();
          const dialog = page.getByRole('dialog', { name: '이 브라우저 연결', exact: true });
          await dialog.getByLabel('연결 코드', { exact: true }).fill('123456');
          await dialog.getByRole('button', { name: '연결', exact: true }).click();
          await rail.getByText('연결됨', { exact: true }).waitFor();
          assert.equal(await rail.getByText('분석 준비 완료', { exact: true }).count(), 0);
          assert.equal(await analyze.isDisabled(), true, 'model readiness must complete after pairing');
          const deadline = Date.now() + 10_000;
          while (!heldModelCount && Date.now() < deadline) await sleep(50);
          assert.ok(heldModelCount > 0);
          modelReady = false;
          holdAuthenticatedModels = false;
          releaseModels();
          await page.locator('.writer-action-bar').getByRole('button', { name: '모델 받기', exact: true }).waitFor();
          assert.equal(await page.getByRole('button', { name: '준비 필요', exact: true }).isDisabled(), true);
          modelReady = true;
          await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
          await rail.getByText('분석 준비 완료', { exact: true }).waitFor();
          assert.equal(await analyze.isEnabled(), true);
        }
        assert.ok(probeCount > 0);
      }
      assert.equal(await page.getByLabel('회의 제목 *').inputValue(), `안내 상태 ${scenario}`);
      assert.equal(await page.getByLabel('회의 목적 *').inputValue(), '입력과 파일을 보존하며 다음 동작 확인');
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
    if (path === '/api/pair/start') return json({ pairing_id: 'summary-readiness-pairing', expires_in_seconds: 120 });
    if (path === '/api/pair/complete') {
      assert.deepEqual(route.request().postDataJSON(), { pairing_id: 'summary-readiness-pairing', code: '123456' });
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
    const rail = page.locator('.local-engine-connection');
    await rail.getByRole('button', { name: '연결 확인', exact: true }).click();
    await rail.getByRole('button', { name: '연결 시작', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '이 브라우저 연결', exact: true });
    await dialog.getByRole('textbox', { name: '연결 코드', exact: true }).fill('123456');
    await dialog.getByRole('button', { name: '연결', exact: true }).click();
    await rail.getByText('분석 준비 완료', { exact: true }).waitFor();
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
    if (path === '/api/pair/start') return json({ pairing_id: 'missing-models-pairing', expires_in_seconds: 120 });
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
    const rail = page.locator('.local-engine-connection');
    await rail.getByRole('button', { name: '연결 확인', exact: true }).click();
    await rail.getByRole('button', { name: '연결 시작', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '이 브라우저 연결', exact: true });
    await dialog.getByRole('textbox', { name: '연결 코드', exact: true }).fill('123456');
    await dialog.getByRole('button', { name: '연결', exact: true }).click();
    await rail.getByText('연결됨', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await rail.getByText('분석 준비 완료', { exact: true }).count(), 0, 'connected is not ready while a required model is missing');
    const actionBar = page.locator('.writer-action-bar');
    await actionBar.getByText('분석에 필요한 모델이 아직 없습니다. 모델을 받으면 바로 시작할 수 있습니다.', { exact: true }).waitFor({ timeout: 10000 });
    await actionBar.getByRole('button', { name: '모델 받기', exact: true }).click();
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

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;
  let probeMode = 'unreachable';
  let pairingStartCount = 0;
  let authRecoveryMode = 'off';
  let renewalRequests = 0;
  let recoveryApiRequests = 0;

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
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
    const introTitle = '회의 내용은 내 PC에서 처리합니다';
    const intro = page.getByRole('dialog', { name: introTitle });
    await intro.waitFor({ state: 'visible' });
    assert.equal(await page.evaluate(() => window.localStorage.getItem('localProcessingIntroSeen')), null, 'opening the notice is not yet a confirmation');
    await page.waitForFunction(() => document.activeElement?.textContent?.trim() === '시작하기');
    await intro.getByText('이를 위해 처음 한 번 ‘바로록 연결’ 설치와 분석에 필요한 파일 다운로드가 필요합니다.', { exact: true }).waitFor();
    const introFootnote = intro.getByText('웹사이트 접속과 프로그램·모델 다운로드에는 인터넷을 사용합니다.', { exact: true });
    assert.equal(await introFootnote.count(), 1);
    assert.equal(await intro.locator('#local-processing-details').count(), 0, 'first visit keeps the details folded');
    const detailsToggle = intro.getByRole('button', { name: '처리 방식 자세히 보기', exact: true });
    assert.equal(await detailsToggle.getAttribute('aria-expanded'), 'false');
    await detailsToggle.click();
    await intro.locator('#local-processing-details').waitFor({ state: 'visible' });
    const foldToggle = intro.getByRole('button', { name: '간단히 보기', exact: true });
    assert.equal(await foldToggle.getAttribute('aria-expanded'), 'true');
    assert.equal(await introFootnote.count(), 0, 'the internet row replaces the footnote while details are open');
    await intro.locator('dd').getByText('웹사이트를 열 때와 바로록 연결·분석 모델을 받을 때 사용합니다.', { exact: false }).waitFor();
    const introBox = await intro.boundingBox();
    assert.ok(introBox && introBox.y >= 0 && introBox.y + introBox.height <= 900, 'expanded notice must fit in the window');
    await intro.getByRole('button', { name: '시작하기', exact: true }).click();
    await intro.waitFor({ state: 'hidden' });
    assert.equal(await page.evaluate(() => window.localStorage.getItem('localProcessingIntroSeen')), '1', 'closing the notice is remembered in this browser');
    await page.reload({ waitUntil: 'networkidle', timeout: PAGE_GOTO_TIMEOUT_MS });
    const rail = page.locator('.local-engine-connection');
    await rail.getByText('이 PC에서 분석합니다').waitFor({ state: 'visible' });
    assert.equal(await page.getByRole('dialog', { name: introTitle }).count(), 0, 'the first-visit notice must not repeat in the same browser');
    const analyzeButton = page.getByRole('button', { name: '분석 시작', exact: true });
    assert.equal(await analyzeButton.isDisabled(), true);
    assert.equal(await analyzeButton.evaluate(element => element.classList.contains('writer-start-button-connection-pending')), true);
    // The writer states local processing once, beside the file picker, instead of repeating it in the connection rail.
    assert.equal(await page.getByText('음성·영상과 대화록은 이 PC에서 처리합니다.', { exact: true }).count(), 1);
    assert.equal(await rail.getByRole('button', { name: '로컬 분석 안내' }).count(), 0);

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
    await rail.getByRole('button', { name: '연결 확인', exact: true }).click();
    await rail.getByText('이 브라우저를 연결해 주세요').waitFor({ state: 'visible' });
    await rail.getByRole('button', { name: '연결 시작', exact: true }).click();

    const dialog = page.getByRole('dialog', { name: '이 브라우저 연결' });
    await dialog.waitFor({ state: 'visible' });
    const pairingCodeInput = dialog.getByRole('textbox', { name: '연결 코드', exact: true });
    await pairingCodeInput.waitFor({ state: 'visible' });
    await page.waitForFunction(() => document.activeElement?.id === 'local-engine-pairing-code');
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
    await page.waitForFunction(() => document.activeElement?.id === 'local-engine-pairing-code');
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
    authRecoveryMode = 'recover';
    const recoveredStatus = await page.evaluate(async () => {
      const { localEngineClient } = await import('/src/localEngineClient.ts');
      return (await localEngineClient.request('/api/outputs/ui-auth-recovery-probe/json')).status;
    });
    assert.equal(recoveredStatus, 200, 'the mounted provider must register request recovery');
    assert.equal(renewalRequests, 1);
    assert.equal(recoveryApiRequests, 2);
    await rail.getByText('분석 준비 완료').waitFor({ state: 'visible' });

    authRecoveryMode = 'expired';
    recoveryApiRequests = 0;
    const expiredStatus = await page.evaluate(async () => {
      const { localEngineClient } = await import('/src/localEngineClient.ts');
      return (await localEngineClient.request('/api/outputs/ui-auth-recovery-probe/json')).status;
    });
    assert.equal(expiredStatus, 401);
    assert.equal(renewalRequests, 2, 'failed renewal must not loop');
    assert.equal(recoveryApiRequests, 1, 'failed renewal must not replay the API request');
    await rail.getByText('연결이 만료되었습니다').waitFor({ state: 'visible' });
    assert.equal(await analyzeButton.isDisabled(), true);
    assert.equal(await page.getByLabel('회의 제목 *').inputValue(), '연결 상태 보존 회의');
    assert.equal(await page.getByLabel('회의 목적 *').inputValue(), '연결 전 입력 보존 확인');
    await page.getByText('연결 확인.mp3').waitFor({ state: 'visible' });
    await verifySummaryReadinessAfterPairing(browser);
    await verifyMissingModelsAfterPairing(browser);
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
