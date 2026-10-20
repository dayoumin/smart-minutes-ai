import assert from 'node:assert/strict';
import { chromium } from 'playwright';

assert.ok(process.env.APP_URL, 'Set APP_URL to the dedicated Vite QA URL.');
const APP_URL = process.env.APP_URL;
const origin = new URL(APP_URL).origin;
const wav = Buffer.alloc(44 + 16000 * 2 * 20);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const calls = [];
const browser = await chromium.launch({ headless: true });
try {
  const context = await browser.newContext();
  const page = await context.newPage();
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    const common = { 'Access-Control-Allow-Origin': origin, 'Access-Control-Expose-Headers': 'Content-Range, Accept-Ranges, WWW-Authenticate' };
    if (request.method() === 'OPTIONS') return route.fulfill({ status: 204, headers: { ...common, 'Access-Control-Allow-Headers': 'Authorization, Range', 'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS' } });
    if (path.endsWith('/audio')) {
      calls.push({ method: request.method(), authorization: request.headers().authorization, range: request.headers().range });
      if (request.headers().authorization !== 'Bearer browser-audio-test-session-long-enough') {
        return route.fulfill({ status: 401, headers: { ...common, 'WWW-Authenticate': 'Bearer' }, body: '{}' });
      }
      if (request.method() === 'HEAD') return route.fulfill({ status: 200, headers: { ...common, 'Content-Length': String(wav.length), 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes' }, body: '' });
      const range = request.headers().range;
      const match = range && /^bytes=(\d+)-(\d*)$/.exec(range);
      const start = match ? Number(match[1]) : 0;
      const end = match && match[2] ? Math.min(Number(match[2]), wav.length - 1) : wav.length - 1;
      const headers = { ...common, 'Content-Type': 'audio/wav', 'Accept-Ranges': 'bytes', 'Content-Length': String(end - start + 1) };
      if (range) headers['Content-Range'] = 'bytes ' + start + '-' + end + '/' + wav.length;
      return route.fulfill({ status: range ? 206 : 200, headers, body: wav.subarray(start, end + 1) });
    }
    const data = path.endsWith('/models/status') ? { ready: true, models: [] }
      : path.endsWith('/settings') ? { privacy: { preserve_extracted_audio: true }, diarization: { generate_during_analysis: true } }
      : path.endsWith('/draft-statuses') ? { statuses: [] } : { ok: true };
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(data) });
  });
  await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.title(), '바로록');
  await page.evaluate(async () => {
    const { localEngineSessionCredentials } = await import('/src/localEngineClient.ts');
    localEngineSessionCredentials.replace({ session_token: 'browser-audio-test-session-long-enough', expires_at: Date.now() / 1000 + 300, capabilities: ['analysis', 'export'] });
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        if (!request.result.objectStoreNames.contains('meetings')) request.result.createObjectStore('meetings', { keyPath: 'id' });
        if (!request.result.objectStoreNames.contains('folders')) request.result.createObjectStore('folders', { keyPath: 'id' });
      };
      request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error);
    });
    const transaction = db.transaction('meetings', 'readwrite');
    for (const name of ['A', 'B']) transaction.objectStore('meetings').put({
      id: 'audio-meeting-' + name, jobId: 'audio-job-' + name, title: '인증 음성 회의 ' + name,
      date: '2026-10-15 09:00', sourceFile: 'audio.wav', summary: '', participants: '참석자1',
      segments: [{ start: '00:00:00', end: '00:00:20', speaker: '참석자1', text: '음성 재생 검증' }],
      transcript: '음성 재생 검증', analysisStatus: 'completed', diarizationApplied: true,
      outputFiles: { audio: '/api/outputs/audio-job-' + name + '/audio' },
    });
    await new Promise((resolve, reject) => { transaction.oncomplete = resolve; transaction.onerror = reject; });
    db.close();
    window.dispatchEvent(new Event('meetings:updated'));
  });
  await page.getByText('인증 음성 회의 A', { exact: true }).first().click();
  const audio = page.locator('audio[aria-label="추출 음성"]');
  try { await audio.waitFor({ state: 'visible' }); }
  catch (error) {
    console.error(await page.evaluate(() => ({
      text: document.body.innerText,
      audio: document.querySelector('audio')?.outerHTML,
      worker: navigator.serviceWorker.controller?.scriptURL,
    })));
    console.error('Audio request methods/ranges:', calls.map(({ method, range }) => ({ method, range })));
    throw error;
  }
  await page.waitForFunction(() => document.querySelector('audio')?.readyState >= 1);
  const oldUrl = await audio.getAttribute('src');
  assert.ok(oldUrl.includes('/__lmo_audio__/'));
  assert.equal(oldUrl.includes('Bearer'), false);
  await audio.evaluate(async element => { await element.play(); });
  await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0);
  await audio.evaluate(element => new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Audio seek did not finish.')), 10000);
    element.addEventListener('seeked', () => { clearTimeout(timeout); resolve(); }, { once: true });
    element.currentTime = 12;
  }));
  await page.waitForFunction(() => {
    const element = document.querySelector('audio');
    return element && !element.seeking && !element.paused && element.currentTime > 12.2;
  });
  assert.ok(calls.some(call => call.method === 'GET' && call.range));
  assert.ok(calls.filter(call => call.method === 'GET').every(call => call.authorization === 'Bearer browser-audio-test-session-long-enough'));
  await page.getByText('인증 음성 회의 B', { exact: true }).first().click();
  await page.waitForFunction(previous => {
    const element = document.querySelector('audio');
    return element && element.src !== previous && element.readyState >= 1;
  }, oldUrl);
  assert.equal(await page.evaluate(async url => (await fetch(url)).status, oldUrl), 404);
  assert.deepEqual(await page.evaluate(async () => await caches.keys()), []);
  assert.equal(await page.evaluate(async () => {
    const registrations = await navigator.serviceWorker.getRegistrations();
    return registrations.length;
  }), 1);
  const foreignContext = await browser.newContext();
  const foreignPage = await foreignContext.newPage();
  await foreignPage.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  const conflict = await foreignPage.evaluate(async () => {
    await navigator.serviceWorker.register('/local-audio-worker.js?foreign-owner=1', { scope: '/' });
    await navigator.serviceWorker.ready;
    const { createLocalAudioPlaybackSource } = await import('/src/localAudioPlayback.ts');
    try { await createLocalAudioPlaybackSource('unowned'); return false; } catch { return true; }
  });
  assert.equal(conflict, true);
  await foreignContext.close();
  console.log('ok - authenticated native audio playback, seek, transition and worker ownership');
} finally { await browser.close(); }
