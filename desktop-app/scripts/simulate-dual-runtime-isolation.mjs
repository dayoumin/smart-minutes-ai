import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { BRAND_NAME } from '../src/brand.ts';

// Shared frontend/IndexedDB verification with mocked engines and native bridge.
// Separate Chromium contexts model profiles; they do not prove real WebView
// persistence, executable startup order, or native process ownership.
assert.ok(process.env.APP_URL, 'Set APP_URL to the dedicated Vite QA URL.');
const appUrl = new URL(process.env.APP_URL);
assert.ok(['127.0.0.1', 'localhost'].includes(appUrl.hostname), 'Use a dedicated local source UI.');
const sharedId = 'dual-runtime-same-meeting';
const sharedJobId = 'dual-runtime-same-job';
const webToken = 'dual-runtime-browser-session-long-enough';
const desktopToken = 'dual-runtime-native-action-token';
const errors = [];
const network = [];
const browser = await chromium.launch({ headless: true });

const createRuntime = async kind => {
  const context = await browser.newContext({ viewport: { width: 1360, height: 860 } });
  const engine = {
    kind, online: true, deleted: [],
    base: `http://127.0.0.1:${kind === 'web' ? 17863 : 17864}`,
  };
  if (kind === 'desktop') {
    await context.addInitScript(({ base, token }) => {
      window.__TAURI__ = { core: { invoke: async command => {
        if (command === 'get_backend_base_url') return base;
        if (command === 'get_desktop_action_token') return token;
        if (command === 'write_frontend_log' || command === 'set_close_guard_active') return;
        throw new Error(`Unexpected native command: ${command}`);
      } } };
    }, { base: engine.base, token: desktopToken });
  }
  context.on('page', page => page.on('pageerror', error => errors.push(`${kind}: ${error.message}`)));
  await context.route('**/api/**', async route => {
    const request = route.request();
    const url = new URL(request.url());
    const method = request.method();
    const headers = request.headers();
    const cors = {
      'Access-Control-Allow-Origin': appUrl.origin,
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-LMO-Desktop-Action-Token',
      'Access-Control-Allow-Methods': 'GET, HEAD, POST, DELETE, OPTIONS',
    };
    const mutation = !['GET', 'HEAD', 'OPTIONS'].includes(method);
    const credential = kind === 'web' ? headers.authorization : headers['x-lmo-desktop-action-token'];
    network.push({ kind, base: url.origin, path: url.pathname, method, credentialKind: credential ? kind : 'none', online: engine.online });
    if (url.origin !== engine.base) errors.push(`${kind} reached foreign engine ${url.origin}`);
    if (kind === 'web' && headers['x-lmo-desktop-action-token']) errors.push('web forwarded a desktop token');
    if (kind === 'desktop' && headers.authorization) errors.push('desktop forwarded a browser token');
    if (method === 'OPTIONS') return route.fulfill({ status: 204, headers: cors });
    if (mutation && credential !== (kind === 'web' ? `Bearer ${webToken}` : desktopToken)) {
      errors.push(`${kind} mutation lacked its own credential`);
      return route.fulfill({ status: 401, headers: cors, body: '{}' });
    }
    if (!engine.online) return route.abort('connectionrefused');
    let data;
    if (method === 'DELETE' && url.pathname === `/api/outputs/${sharedJobId}`) {
      engine.deleted.push(sharedJobId);
      data = { job_id: sharedJobId, deleted: [] };
    } else if (url.pathname === '/api/models/status') data = { ready: true, models: [] };
    else if (url.pathname === '/api/settings') data = { diarization: { enabled: true, generate_during_analysis: true } };
    else if (url.pathname === '/api/analyze/draft-statuses') data = { drafts: [] };
    else if (url.pathname === '/api/stored-analyses') data = { analyses: [] };
    else if (url.pathname === '/api/health') data = { ok: true };
    else return route.fulfill({ status: 404, headers: cors, contentType: 'application/json', body: '{}' });
    return route.fulfill({ status: 200, headers: cors, contentType: 'application/json', body: JSON.stringify(data) });
  });
  return { context, engine, page: null };
};

const openPage = async runtime => {
  const page = await runtime.context.newPage();
  await page.goto(appUrl.href, { waitUntil: 'domcontentloaded' });
  assert.equal(await page.title(), BRAND_NAME, 'the intended LMO source UI must answer');
  await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor();
  await authorize(page, runtime.engine.kind);
  runtime.page = page;
  return page;
};

const authorize = async (page, kind) => {
  if (kind !== 'web') return;
  await page.evaluate(async token => {
    const { localEngineSessionCredentials } = await import('/src/localEngineClient.ts');
    localEngineSessionCredentials.replace({ session_token: token, expires_at: Date.now() / 1000 + 3600, capabilities: ['analysis', 'export'] });
  }, webToken);
};

const readState = page => page.evaluate(async id => {
  const { getAllMeetings, getMeetingById } = await import('/src/meetingRepository.ts');
  const { listPendingMeetingOutputCleanups } = await import('/src/meetingDeletion.ts');
  return { record: await getMeetingById(id), ids: (await getAllMeetings()).map(item => item.id), queue: listPendingMeetingOutputCleanups() };
}, sharedId);

const saveRecord = (page, title, summary, edit = false) => page.evaluate(async ({ id, jobId, title, summary, edit }) => {
  const repository = await import('/src/meetingRepository.ts');
  const existing = edit ? await repository.getMeetingById(id) : undefined;
  const record = {
    ...existing, id, jobId, title, summary, date: '2026-10-22T09:00:00.000Z', participants: '시험 참석자',
    analysisStatus: 'completed', diarizationApplied: true,
    segments: [{ start: '00:00:00', end: '00:00:05', speaker: '시험 참석자', text: summary }],
    transcript: summary,
  };
  await (edit ? repository.updateMeeting(record) : repository.addMeeting(record));
  window.dispatchEvent(new Event('meetings:updated'));
}, { id: sharedId, jobId: sharedJobId, title, summary, edit });

const showRecord = async (page, title) => {
  await page.getByText(title, { exact: true }).first().click();
  await page.getByRole('heading', { name: title, exact: true }).waitFor();
};

try {
  const web = await createRuntime('web');
  const desktop = await createRuntime('desktop');
  for (const runtime of [web, desktop]) await openPage(runtime);
  await saveRecord(web.page, '웹 전용 기록', '웹에서 보관하는 시험 본문');
  await saveRecord(desktop.page, '앱 전용 기록', '앱에서 보관하는 다른 시험 본문');
  await showRecord(web.page, '웹 전용 기록');
  await showRecord(desktop.page, '앱 전용 기록');

  await saveRecord(web.page, '웹 수정 기록', '웹에서 수정한 시험 본문', true);
  await saveRecord(desktop.page, '앱 수정 기록', '앱에서 수정한 다른 시험 본문', true);
  for (const runtime of [web, desktop]) {
    await runtime.page.reload({ waitUntil: 'domcontentloaded' });
    await authorize(runtime.page, runtime.engine.kind);
    const title = runtime.engine.kind === 'web' ? '웹 수정 기록' : '앱 수정 기록';
    await showRecord(runtime.page, title);
    await runtime.page.close();
    await openPage(runtime);
    await showRecord(runtime.page, title);
  }
  const desktopBefore = await readState(desktop.page);
  assert.equal(desktopBefore.record.summary, '앱에서 수정한 다른 시험 본문');
  assert.equal((await readState(web.page)).record.summary, '웹에서 수정한 시험 본문');

  web.engine.online = false;
  const webDeletion = await web.page.evaluate(async id => {
    const { getMeetingById } = await import('/src/meetingRepository.ts');
    const { deleteMeetingWithAnalysis } = await import('/src/meetingDeletion.ts');
    return deleteMeetingWithAnalysis(await getMeetingById(id));
  }, sharedId);
  assert.equal(webDeletion, 'deleted-engine-later');
  const offlineState = await readState(web.page);
  assert.equal(offlineState.record, undefined);
  assert.deepEqual(offlineState.queue, [sharedJobId]);
  assert.deepEqual(await readState(desktop.page), desktopBefore, 'web deletion cannot alter desktop records or its cleanup queue');

  web.engine.online = true;
  await authorize(web.page, 'web');
  await web.page.evaluate(async () => (await import('/src/meetingDeletion.ts')).flushPendingMeetingOutputCleanups());
  assert.deepEqual((await readState(web.page)).queue, []);
  assert.deepEqual(web.engine.deleted, [sharedJobId]);
  assert.deepEqual(desktop.engine.deleted, []);
  assert.deepEqual(await readState(desktop.page), desktopBefore);

  // The reverse mutation uses the same job ID, making a wrong engine base or
  // shared store observable instead of hiding it behind distinct fixture IDs.
  await saveRecord(web.page, '웹 복원 검사 기록', '앱 삭제와 무관하게 유지할 웹 시험 본문');
  const webBeforeNativeDeletion = await readState(web.page);
  const desktopDeletion = await desktop.page.evaluate(async id => {
    const { getMeetingById } = await import('/src/meetingRepository.ts');
    const { deleteMeetingWithAnalysis } = await import('/src/meetingDeletion.ts');
    return deleteMeetingWithAnalysis(await getMeetingById(id));
  }, sharedId);
  assert.equal(desktopDeletion, 'deleted');
  assert.deepEqual(desktop.engine.deleted, [sharedJobId]);
  assert.deepEqual((await readState(desktop.page)).ids, []);
  assert.deepEqual(await readState(web.page), webBeforeNativeDeletion);
  await web.page.reload({ waitUntil: 'domcontentloaded' });
  await authorize(web.page, 'web');
  await showRecord(web.page, '웹 복원 검사 기록');
  assert.ok(network.some(call => call.kind === 'web' && call.method === 'DELETE' && !call.online));
  assert.ok(network.some(call => call.kind === 'web' && call.method === 'DELETE' && call.online));
  assert.ok(network.some(call => call.kind === 'desktop' && call.method === 'DELETE'));
  assert.deepEqual(errors, [], 'page errors, foreign routing and credential violations must be absent');
  console.log(JSON.stringify({ scenario: 'dual-runtime-isolation', status: 'passed', apiCalls: network, limitation: 'Mock engines/native bridge and Chromium profiles; not executable/WebView QA.' }, null, 2));
} finally {
  await browser.close();
}
