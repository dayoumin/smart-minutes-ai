import assert from 'node:assert/strict';
import { chromium } from 'playwright';

const url = process.env.APP_URL;
assert.ok(url, 'Set APP_URL to the caller-owned Vite server.');
const origin = new URL(url).origin;
const completedSummary = process.argv.includes('--completed');
const preparingRuntime = process.argv.includes('--preparing');
const managedRuntime = process.argv.includes('--managed');
const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
const wav = Buffer.alloc(44 + 16000 * 2 * 2);
wav.write('RIFF'); wav.writeUInt32LE(wav.length - 8, 4); wav.write('WAVEfmt ', 8);
wav.writeUInt32LE(16, 16); wav.writeUInt16LE(1, 20); wav.writeUInt16LE(1, 22);
wav.writeUInt32LE(16000, 24); wav.writeUInt32LE(32000, 28); wav.writeUInt16LE(2, 32);
wav.writeUInt16LE(16, 34); wav.write('data', 36); wav.writeUInt32LE(wav.length - 44, 40);
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage();
  await page.addInitScript(base => {
    window.__TAURI__ = { core: { invoke: async command => {
      if (command === 'get_backend_base_url') return base;
      if (command === 'get_desktop_action_token') return 'qa-native-startup-token';
      return undefined;
    } } };
  }, origin);
  let ready = false;
  let modelFailures = 0;
  let audioFailures = 0;
  let audioHeads = 0;
  let modelReads = 0;
  await page.route('**/api/**', async route => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    if (!ready && ['/api/health', '/api/models/status', '/api/outputs/startup-job/audio'].includes(path)) {
      if (path.endsWith('/models/status')) modelFailures++;
      if (path.endsWith('/audio')) audioFailures++;
      return route.abort('connectionrefused');
    }
    if (path.endsWith('/audio')) {
      if (request.method() === 'HEAD') audioHeads++;
      return route.fulfill({ status: 200, headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(wav.length) }, body: request.method() === 'HEAD' ? '' : wav });
    }
    if (path === '/api/models/status') {
      modelReads++;
      const summaryReady = !managedRuntime && (!preparingRuntime || modelReads > 2);
      return route.fulfill(json({ ready: true, models: [], summary_ready: summaryReady, summary_reason: summaryReady ? '' : 'server_unreachable',
        ...(managedRuntime ? { ollama_connection: { status: 'managed_stopped', can_auto_start: true, managed_runtime_available: true } } : {}) }));
    }
    if (path === '/api/settings') return route.fulfill(json({ summary: { enabled: true }, diarization: { enabled: true } }));
    return route.fulfill(json({ ok: true, statuses: [], active: false }));
  });
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.title(), 'LMO 회의록');
  await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor();
  await page.evaluate(async completed => {
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => { request.onsuccess = () => resolve(request.result); request.onerror = () => reject(request.error); });
    const tx = db.transaction('meetings', 'readwrite');
    const guidance = '대화록 생성이 완료되었습니다. 정리는 회의 기록에서 별도로 실행해 주세요.';
    tx.objectStore('meetings').put({ id: 'startup-meeting', jobId: 'startup-job', title: '재시작 자동 복구 검사', date: '2026-10-23',
      summary: completed ? '기존 요약 결과입니다.' : guidance, needsCheck: completed ? [] : [guidance], participants: '', analysisStatus: 'completed', diarizationApplied: true,
      generationStatus: { summary: completed ? 'completed' : 'skipped' }, outputFiles: { audio: '/api/outputs/startup-job/audio' },
      segments: [{ start: '00:00:00', end: '00:00:02', speaker: 'A', text: '재시작 검사' }] });
    await new Promise((resolve, reject) => { tx.oncomplete = resolve; tx.onerror = reject; });
    db.close(); window.dispatchEvent(new Event('meetings:updated'));
  }, completedSummary);
  await page.getByText('재시작 자동 복구 검사', { exact: true }).first().click();
  // Both real consumers have encountered an unavailable native engine before it starts.
  await assertEventually(() => modelFailures > 0 && audioFailures > 0);
  await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
  assert.equal(await page.getByRole('button', { name: '전체 요약 정리', exact: true }).isDisabled(), true,
    'Even a previously completed summary must wait for the first model check');
  ready = true;
  const audio = page.locator('audio');
  await audio.waitFor({ state: 'attached', timeout: 15000 });
  await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
  await page.getByRole('button', { name: '전체 요약 정리', exact: true }).waitFor();
  await assertEventually(() => page.getByRole('button', { name: '전체 요약 정리', exact: true }).isEnabled());
  assert.equal(await page.getByText('음성을 확인하지 못했습니다. 연결을 확인한 뒤 다시 시도해 주세요.', { exact: true }).count(), 0);
  await audio.evaluate(async element => element.play());
  await page.waitForFunction(() => document.querySelector('audio')?.currentTime > 0.1);
  const source = await audio.getAttribute('src');
  const previousHeads = audioHeads;
  const previousModels = modelReads;
  await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
  await assertEventually(() => modelReads > previousModels);
  assert.equal(audioHeads, previousHeads, 'background checks must not restart available audio');
  assert.equal(await audio.getAttribute('src'), source);
  await audio.evaluate(element => element.pause());
  console.log('ok - native startup failures recover summary/audio without user refresh; background checks preserve playback');
} finally { await browser.close(); }

async function assertEventually(check) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  assert.fail('Expected condition did not become true');
}
