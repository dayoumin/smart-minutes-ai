import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, writeFile, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { build } from 'vite';
import { chromium } from 'playwright';

// Use the production transport without Vite's live-reload WebSocket or request
// interception, either of which can prevent a genuine BFCache round trip.
const appRoot = fileURLToPath(new URL('../', import.meta.url));
const root = path.resolve(appRoot, '../.tmp/audio-back-navigation');
const dist = path.join(root, 'dist');
const wav = Buffer.alloc(44 + 16000 * 2 * 20);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
let audioRequests = 0;
const server = createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://localhost').pathname;
  if (pathname === '/api/outputs/back-navigation/audio') {
    if (request.headers.authorization !== 'Bearer back-navigation-test-session-long-enough') {
      response.writeHead(401, { 'WWW-Authenticate': 'Bearer' }).end(); return;
    }
    audioRequests++;
    const match = /^bytes=(\d+)-(\d*)$/.exec(request.headers.range ?? '');
    const start = match ? Number(match[1]) : 0;
    const end = match?.[2] ? Math.min(Number(match[2]), wav.length - 1) : wav.length - 1;
    const headers = { 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': end - start + 1 };
    if (match) headers['Content-Range'] = `bytes ${start}-${end}/${wav.length}`;
    response.writeHead(match ? 206 : 200, headers);
    response.end(request.method === 'HEAD' ? undefined : wav.subarray(start, end + 1)); return;
  }
  try {
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    const file = path.resolve(dist, relative);
    if (!file.startsWith(dist + path.sep)) { response.writeHead(404).end(); return; }
    const data = await readFile(file);
    const type = file.endsWith('.js') ? 'text/javascript; charset=utf-8' : file.endsWith('.html') ? 'text/html; charset=utf-8' : 'application/octet-stream';
    response.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'max-age=0' }).end(data);
  } catch { response.writeHead(404).end(); }
});
const away = createServer((_request, response) => response.writeHead(200, { 'Content-Type': 'text/html' }).end('<title>Away</title><p>Another page</p>'));
const listen = instance => new Promise(resolve => instance.listen(0, '127.0.0.1', resolve));
let browser;
try {
  await Promise.all([listen(server), listen(away)]);
  const origin = `http://127.0.0.1:${server.address().port}`;
  const awayUrl = `http://127.0.0.1:${away.address().port}`;
  await mkdir(root, { recursive: true });
  const transport = path.join(appRoot, 'src/localAudioPlayback.ts').replaceAll('\\', '/');
  const client = path.join(appRoot, 'src/localEngineClient.ts').replaceAll('\\', '/');
  await writeFile(path.join(root, 'index.html'), `<!doctype html><title>바로록 음성 복원 검사</title>
    <audio controls aria-label="검사 음성"></audio><a href="${awayUrl}">다른 페이지</a>
    <script type="module">
      import { createLocalAudioPlaybackSource } from '${transport}';
      import { localEngineSessionCredentials } from '${client}';
      window.restored = false;
      window.instance = crypto.randomUUID();
      addEventListener('pageshow', event => { window.restored = event.persisted; });
      localEngineSessionCredentials.replace({session_token:'back-navigation-test-session-long-enough',expires_at:Date.now()/1000+300,capabilities:['export']});
      window.createSource = createLocalAudioPlaybackSource;
      window.source = await createLocalAudioPlaybackSource('back-navigation');
      document.querySelector('audio').src = window.source.url;
    </script>`, 'utf8');
  await build({
    configFile: false, root, publicDir: false, logLevel: 'warn',
    define: { 'import.meta.env.VITE_API_BASE_URL': JSON.stringify(origin) },
    build: { outDir: dist, emptyOutDir: true },
  });
  await copyFile(path.join(appRoot, 'public/local-audio-worker.js'), path.join(dist, 'local-audio-worker.js'));
  console.log('Production audio transport ready; launching Chromium');
  browser = await chromium.launch({ headless: true, channel: 'chromium', ignoreDefaultArgs: ['--disable-back-forward-cache'] });
  const page = await browser.newPage();
  page.setDefaultTimeout(15000);
  page.setDefaultNavigationTimeout(15000);
  page.on('pageerror', error => console.error('Page error:', error.message));
  await page.goto(origin);
  console.log('Audio test document loaded:', origin);
  const audio = page.locator('audio');
  await page.waitForFunction(() => document.querySelector('audio').readyState >= 1);
  await audio.evaluate(element => element.play());
  await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.1);
  await audio.evaluate(element => element.pause());
  const original = await page.evaluate(() => ({ instance: window.instance, url: window.source.url }));
  await page.getByRole('link', { name: '다른 페이지' }).click();
  await page.waitForURL(awayUrl + '/');
  console.log('Navigated away; returning through browser Back');
  await page.goBack({ waitUntil: 'commit' });
  await page.waitForFunction(() => window.restored === true);
  assert.equal(await page.evaluate(() => window.instance), original.instance, 'Must restore the original document, not reload it');
  const status = await page.evaluate(async url => (await fetch(url)).status, original.url);
  console.log(JSON.stringify({ bfcacheRestored: true, restoredAudioStatus: status, audioRequests }));
  assert.equal(status, 200, 'The restored audio source must still resolve after browser Back');
  await audio.evaluate(async element => { element.load(); await element.play(); });
  await page.waitForFunction(() => document.querySelector('audio').currentTime > 0.1);
  await page.evaluate(() => window.source.dispose());
  assert.equal(await page.evaluate(async url => (await fetch(url)).status, original.url), 404, 'Explicit disposal must still revoke playback');
  // A permanently departing document must continue to release its source.
  const released = await page.evaluate(async () => {
    document.querySelector('audio').pause();
    const source = await window.createSource('back-navigation');
    if ((await fetch(source.url)).status !== 200) throw new Error('Fresh source is unavailable');
    window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: false }));
    return (await fetch(source.url)).status;
  });
  assert.equal(released, 404);
  console.log('ok - genuine browser Back restores audio playback; explicit disposal remains effective');
} finally {
  await browser?.close();
  server.closeAllConnections(); away.closeAllConnections();
  await Promise.all([new Promise(resolve => server.close(resolve)), new Promise(resolve => away.close(resolve))]);
}
