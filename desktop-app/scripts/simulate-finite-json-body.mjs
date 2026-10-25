import assert from 'node:assert/strict';
import http from 'node:http';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// A compiled production web build with synthetic API data. No installed engine or user profile is used.
const dist = resolve(process.env.DIST_DIR || fileURLToPath(new URL('../../.tmp/cloudflare-web/dist', import.meta.url)));
const evidence = process.env.EVIDENCE_DIR;
let status = 200;
let stalled = true;
const requests = [];
const apiRequests = [];
const sockets = new Set();
const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }
  const path = new URL(req.url, 'http://localhost').pathname;
  if (path === '/api/settings') {
    const responseStatus = stalled ? status : 200;
    const item = { status: responseStatus, method: req.method, started: Date.now(), partialBytes: 0, closed: null };
    requests.push(item);
    res.on('close', () => { item.closed = Date.now(); });
    res.writeHead(responseStatus, { 'Content-Type': 'application/json' });
    if (stalled) {
      res.flushHeaders();
      const partial = '{"summary":';
      res.write(partial);
      item.partialBytes = Buffer.byteLength(partial);
    } else res.end(JSON.stringify({ summary: { enabled: false }, diarization: { enabled: false } }));
    return;
  }
  const relative = path === '/' ? 'index.html' : decodeURIComponent(path.slice(1));
  const file = resolve(dist, relative);
  if (!file.startsWith(dist + sep)) { res.writeHead(403).end(); return; }
  try {
    const bytes = await readFile(file);
    const type = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' }[extname(file)] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type }).end(bytes);
  } catch { res.writeHead(404).end(); }
});
server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
const origin = `http://127.0.0.1:${server.address().port}`;
let browser;
const results = [];
try {
  browser = await chromium.launch({ headless: true });
  for (status of [200, 500]) {
    stalled = true;
    const context = await browser.newContext();
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await page.route('**/api/**', route => {
      const path = new URL(route.request().url()).pathname;
      apiRequests.push({ path, method: route.request().method() });
      if (path === '/api/settings') return route.continue({ url: origin + '/api/settings' });
      const body = path === '/api/models/status' ? { ready: true, summary_ready: true, models: [] }
        : path === '/api/health' ? { ok: true }
        : path === '/api/analyze/draft-statuses' ? { drafts: [] }
        : path === '/api/probe' ? { product_id: 'barorok-local-engine', engine_version: 'synthetic-test', api_contract_version: 1,
          capabilities: ['analysis', 'model-management', 'meeting-storage', 'export'], auth_state: 'pairing-required', pairing_available: true }
        : { ok: true, active: false };
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(origin + '/?view=minutes', { waitUntil: 'domcontentloaded' });
    assert.equal(await page.title(), 'LMO 회의록');
    await page.getByRole('button', { name: '시작하기', exact: true }).click();
    const title = page.getByLabel('회의 제목', { exact: true });
    await title.fill(`body-deadline-${status}`);
    const initialCount = requests.length;
    await page.getByRole('complementary').getByRole('button', { name: '설정', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: '설정', exact: true });
    await dialog.waitFor();
    await page.getByText('설정을 불러오지 못했습니다.', { exact: false }).waitFor({ timeout: 24000 });
    const first = requests[initialCount];
    assert.ok(first && first.partialBytes > 0);
    const noticeMs = Date.now() - first.started;
    assert.ok(noticeMs >= 19000 && noticeMs < 24000, `real 20s deadline: ${noticeMs}`);
    assert.equal(requests.length, initialCount + 1, 'no replay before the existing 5s retry');
    if (evidence) { await mkdir(evidence, { recursive: true }); await page.screenshot({ path: resolve(evidence, `body-${status}-timeout.png`) }); }
    const closeStart = Date.now();
    await page.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden', timeout: 3000 });
    const closeMs = Date.now() - closeStart;
    assert.equal(await title.inputValue(), `body-deadline-${status}`);
    stalled = false;
    await page.getByRole('complementary').getByRole('button', { name: '설정', exact: true }).click();
    await dialog.getByRole('checkbox').first().waitFor({ timeout: 5000 });
    assert.equal(await page.getByText('설정을 불러오지 못했습니다.', { exact: false }).count(), 0);
    await page.keyboard.press('Escape');
    assert.equal(await title.inputValue(), `body-deadline-${status}`);
    assert.deepEqual(errors, []);
    results.push({ status, noticeMs, closeMs, partialBytes: first.partialBytes, inputPreserved: true, reopenedHealthy: true });
    await context.close();
  }
  assert.ok(requests.every(r => r.method === 'GET'), 'no settings writes');
  const analysisPosts = apiRequests.filter(r => r.method === 'POST' && r.path === '/api/analyze').length;
  assert.equal(analysisPosts, 0, 'opening or recovering settings must not start analysis');
  const report = { status: 'passed', kind: 'isolated-production-build-simulation', results, requests, apiRequests, analysisPosts };
  if (evidence) await writeFile(resolve(evidence, 'body-simulation.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise(resolve => server.close(resolve));
}
