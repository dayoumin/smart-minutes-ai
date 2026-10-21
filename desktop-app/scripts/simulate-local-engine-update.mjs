import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const outputDir = resolve(process.env.EVIDENCE_DIR ?? '../.tmp/engine-update-20261021/evidence');
await mkdir(outputDir, { recursive: true });
let server;
let browser;
let appUrl = process.env.APP_URL;
const report = { scenarios: [], errors: [] };
const latestVersion = '0.1.10-beta-20261021';
const downloadPath = `/downloads/Barorok-Local-Engine-Setup-${latestVersion}.exe`;

try {
  if (!appUrl) {
    const port = await new Promise((resolvePort, reject) => {
      const listener = net.createServer();
      listener.on('error', reject);
      listener.listen(0, '127.0.0.1', () => {
        const address = listener.address();
        listener.close(() => resolvePort(address.port));
      });
    });
    appUrl = `http://127.0.0.1:${port}/?view=minutes&localEngineConnection=1`;
    const args = ['pnpm', 'exec', 'vite', '--host', '127.0.0.1', '--port', String(port), '--strictPort', '--configLoader', 'runner'];
    server = spawn('corepack', args, { cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, BROWSER: 'none' }, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, shell: process.platform === 'win32' });
    report.server = { command: `corepack ${args.join(' ')}`, cwd: fileURLToPath(new URL('..', import.meta.url)), port, pid: server.pid };
    let logs = '';
    server.stdout.on('data', data => { logs += data; });
    server.stderr.on('data', data => { logs += data; });
    const deadline = Date.now() + 30000;
    let ready = false;
    while (Date.now() < deadline) {
      try { if ((await fetch(appUrl, { signal: AbortSignal.timeout(5000) })).ok) { ready = true; break; } } catch { /* startup */ }
      if (server.exitCode !== null) break;
      await sleep(300);
    }
    assert.ok(ready, `Simulation Vite server did not become ready: ${logs}`);
  }
  report.appUrl = appUrl;
  browser = await chromium.launch({ headless: true });
  for (const scenario of ['old', 'old-unpaired', 'latest', 'newer', 'metadata-unavailable', 'engine-off', 'browser-blocked']) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(20000);
    page.on('pageerror', error => report.errors.push(error.message));
    let engineVersion = scenario === 'latest' ? latestVersion : scenario === 'newer' ? '0.1.11-beta-20261022' : '0.1.9-beta-20261020';
    let modelsReady = true;
    let manifestRequests = 0;
    const downloads = [];
    const origin = new URL(appUrl).origin;
    await page.addInitScript(({ blocked }) => {
      localStorage.setItem('localProcessingIntroSeen', '1');
      const query = navigator.permissions.query.bind(navigator.permissions);
      navigator.permissions.query = descriptor => descriptor?.name === 'loopback-network'
        ? Promise.resolve({ state: blocked ? 'denied' : 'granted' }) : query(descriptor);
    }, { blocked: scenario === 'browser-blocked' });
    await page.route('**/downloads/**', route => {
      const request = route.request();
      const path = new URL(request.url()).pathname;
      if (path === '/downloads/engine-beta.json') {
        manifestRequests += 1;
        assert.equal(request.headers().authorization, undefined, 'no engine credential goes to the website');
        return route.fulfill({ status: scenario === 'metadata-unavailable' ? 503 : 200, contentType: 'application/json',
          body: JSON.stringify({ engineVersion: latestVersion, origin, downloadPath, bytes: 442841356,
            sha256: 'dca637330e3f010d346b9d60ea426e50fb59cab304266c3ef026b776a9979f6b' }) });
      }
      downloads.push(path);
      return route.fulfill({ status: 200, contentType: 'application/octet-stream',
        headers: { 'Content-Disposition': 'attachment; filename="update-simulation.exe"' }, body: 'simulation only; not executable' });
    });
    const grant = { session_token: 'engine-update-simulation-token', expires_at: Math.floor(Date.now() / 1000) + 300,
      capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'] };
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      const json = body => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
      if (scenario === 'engine-off' || scenario === 'browser-blocked') return route.abort('connectionrefused');
      if (path === '/api/probe') return json({ product_id: 'barorok-local-engine', engine_version: engineVersion,
        api_contract_version: 1, capabilities: grant.capabilities, auth_state: 'pairing-required', pairing_available: true,
        ...(scenario === 'old-unpaired' ? {} : { pairing_mode: 'browser-connection' }), update_required: false });
      if (path === '/api/pair/start') return json({ mode: 'browser-connection', pairing_id: 'update-simulation', expires_in_seconds: 120 });
      if (path === '/api/pair/complete' || path === '/api/session/renew') return json(grant);
      if (path === '/api/models/status') return json({ ready: modelsReady, models: [{ key: 'stt_faster_whisper',
        label: '음성 인식', required: true, installed: modelsReady, downloadable: true }], errors: [] });
      if (path === '/api/analyze/draft-statuses') return json({ drafts: [] });
      if (path === '/api/settings') return json({ diarization_generate_during_analysis: false });
      if (path === '/api/analyze') throw new Error('This simulation must never submit audio for analysis');
      return json({ ok: true });
    });
    const row = page.locator('.writer-action-row');
    const start = page.locator('.writer-start-button');
    const waitState = async state => { await page.locator(`.writer-action-row[data-state="${state}"]`).waitFor(); };
    await page.goto(appUrl, { waitUntil: 'networkidle', timeout: 60000 });
    assert.ok((await page.title()).includes('회의록'), 'the intended project page is loaded');
    const expected = scenario === 'old' || scenario === 'old-unpaired' ? 'update-available' : scenario === 'browser-blocked' ? 'browser-blocked'
      : scenario === 'engine-off' ? 'intro' : 'ready';
    await waitState(expected);
    assert.ok(manifestRequests >= 1, 'visiting the website checks its current release');
    const result = { scenario, state: await row.getAttribute('data-state'), text: await row.innerText(), manifestRequests };
    await page.getByLabel('회의 제목', { exact: true }).fill('주간 업무 회의');
    await page.getByLabel('회의 목적', { exact: true }).fill('진행 현황과 다음 주 업무 확인');
    if (scenario === 'old') {
      const link = row.getByRole('link', { name: '최신 설치 파일 받기', exact: true });
      assert.equal(await link.getAttribute('href'), origin + downloadPath);
      assert.equal(await start.getAttribute('aria-disabled'), null, 'compatible old versions remain usable');
      const boxes = {};
      for (const width of [1280, 760]) {
        await page.setViewportSize({ width, height: 900 });
        await page.evaluate(() => document.fonts.ready);
        await row.scrollIntoViewIfNeeded();
        const startBox = await start.boundingBox();
        const linkBox = await link.boundingBox();
        const dimensions = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        assert.equal(dimensions.scroll, dimensions.client, `${width}px has no horizontal overflow`);
        assert.ok(linkBox.x + linkBox.width <= startBox.x + 1, 'update and start controls do not overlap');
        boxes[width] = await start.evaluate(element => {
          const box = element.getBoundingClientRect();
          return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height };
        });
        await page.screenshot({ path: join(outputDir, `update-available-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await row.getByRole('button', { name: '문제 해결 도움말' }).click();
      assert.match(await page.locator('#writer-status-help').innerText(), /다운로드한 설치 파일을 실행/);
      await page.screenshot({ path: join(outputDir, 'update-help-1280.png'), fullPage: true });
      await row.getByRole('button', { name: '문제 해결 도움말' }).click();
      const downloadEvent = page.waitForEvent('download');
      await link.click();
      const download = await downloadEvent;
      assert.deepEqual(downloads, [downloadPath]);
      await download.delete();
      result.download = downloadPath;
      modelsReady = false;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await waitState('models-missing');
      assert.equal(await row.getByRole('link', { name: '최신 설치 파일 받기' }).count(), 0, 'a required model problem has priority');
      modelsReady = true;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await waitState('update-available');
      engineVersion = latestVersion;
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await waitState('ready');
      assert.equal(await row.getByRole('link').count(), 0, 'the notice disappears after installation is detected');
      assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), '주간 업무 회의');
      for (const width of [1280, 760]) {
        await page.setViewportSize({ width, height: 900 });
        const readyBox = await start.evaluate(element => {
          const box = element.getBoundingClientRect();
          return { x: box.x + scrollX, y: box.y + scrollY, width: box.width, height: box.height };
        });
        assert.deepEqual(readyBox, boxes[width], `${width}px keeps 분석 시작 in place after updating`);
      }
      await page.setViewportSize({ width: 1280, height: 900 });
      await page.screenshot({ path: join(outputDir, 'updated-1280.png'), fullPage: true });
      result.afterUpdate = await row.innerText();
    } else {
      assert.equal(await row.getByRole('link', { name: '최신 설치 파일 받기' }).count(), scenario === 'old-unpaired' ? 1 : 0);
      if (expected === 'ready') assert.equal(await start.getAttribute('aria-disabled'), null);
    }
    report.scenarios.push(result);
    await context.close();
  }
  assert.deepEqual(report.errors, []);
  console.log('ok - seven engine-update UI scenarios, download, model priority, installation detection and 1280/760 layout');
} finally {
  await browser?.close();
  if (server && server.exitCode === null) {
    console.log(`Closing this simulation's Vite server PID ${server.pid}; no persistent dev server to restore.`);
    const cleanupExit = await new Promise(resolveExit => {
      const killer = spawn('taskkill.exe', ['/pid', String(server.pid), '/t', '/f'], { windowsHide: true, stdio: 'ignore' });
      killer.on('exit', resolveExit);
      killer.on('error', () => resolveExit(-1));
    });
    report.server.cleanupExit = cleanupExit;
    if (cleanupExit !== 0) console.error(`Vite cleanup needs permission for this simulation's PID ${server.pid}.`);
    server.stdout.destroy();
    server.stderr.destroy();
    server.unref();
  }
  await writeFile(join(outputDir, 'simulation-report.json'), JSON.stringify(report, null, 2));
}
