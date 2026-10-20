import assert from 'node:assert/strict';
import { chromium } from 'playwright';

// Focused frontend regression only: metadata and API replies are controlled fixtures.
// Requires an existing Vite server; never starts a server or calls an actual engine.
assert.ok(process.env.APP_URL, 'Set APP_URL to the dedicated Vite QA URL.');
const appUrl = new URL(process.env.APP_URL);
assert.equal(appUrl.protocol, 'http:');
assert.ok(['127.0.0.1', 'localhost'].includes(appUrl.hostname));
const limitMessage = '2시간 이하의 음성·영상 파일을 선택해 주세요.';
const unavailableMessage = '파일 길이를 확인하지 못했습니다. 재생 가능한 음성·영상 파일을 선택해 주세요.';
const resumeBytes = Buffer.alloc(64, 0x37);
const boundaryBytes = Buffer.alloc(64, 0x23);
const unknownBytes = Buffer.alloc(64, 0x51);
const draft = {
  jobId: 'media-limit-resume-job', title: '이어하기 보존 확인', date: '2026-10-18T09:30',
  meetingPurpose: '2시간 경계 재개 검사', participants: '',
  sourceFilename: 'resume-boundary.wav', sourceSize: resumeBytes.length,
  sourceLastModified: Date.UTC(2026, 9, 18), status: 'stopped', stage: 'stopped',
  createdAt: '2026-10-18T09:30:00.000Z', updatedAt: '2026-10-18T09:35:00.000Z',
  resumeEligible: true, completedChunkCount: 2, lastProgress: 40,
};

const browser = await chromium.launch({ headless: true });
const openCase = async (resume = false) => {
  const context = await browser.newContext();
  const requests = [];
  const unexpectedApi = [];
  const errors = [];
  await context.addInitScript(({ draft, resume }) => {
    if (resume) localStorage.setItem('analysisResumeDrafts', JSON.stringify([draft]));
    const names = new Map();
    const originalUrl = URL.createObjectURL.bind(URL);
    URL.createObjectURL = blob => {
      const url = originalUrl(blob);
      names.set(url, blob.name);
      return url;
    };
    const originalCreate = document.createElement.bind(document);
    document.createElement = (tag, options) => {
      const element = originalCreate(tag, options);
      if (tag === 'audio' || tag === 'video') {
        Object.defineProperty(element, 'src', { set(url) {
          const name = names.get(url);
          const duration = name === 'over.wav' ? 7200.001
            : name === 'unknown.wav' ? Infinity : 7200;
          Object.defineProperty(element, 'duration', { configurable: true, value: duration });
          queueMicrotask(() => element.dispatchEvent(new Event('loadedmetadata')));
        } });
      }
      return element;
    };
  }, { draft, resume });
  const page = await context.newPage();
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      return url.origin === appUrl.origin ? route.continue() : route.abort();
    }
    const reply = (body, status = 200) => route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    if (request.method() === 'OPTIONS') return reply({});
    if (url.pathname === '/api/health') return reply({ ok: true });
    if (url.pathname === '/api/settings') return reply({
      diarization: { enabled: true, generate_during_analysis: false },
      privacy: { preserve_extracted_audio: true, auto_save_audio_copy: false },
    });
    if (url.pathname === '/api/models/status') return reply({
      ready: true, summary_ready: true,
      models: [{ key: 'stt_faster_whisper', installed: true, required: true }],
    });
    if (url.pathname === '/api/analyze/preflight') return reply({ ok: true, level: 'ok' });
    if (url.pathname === '/api/analyze/draft-statuses') return reply({ drafts: resume ? [{
      job_id: draft.jobId, status: 'stopped', stage: 'stopped', resume_supported: true,
      completed_chunk_count: 2, active: false,
    }] : [] });
    if (url.pathname === '/api/analyze/resume-candidates') return reply({
      recommended_job_id: resume ? draft.jobId : null,
      candidates: resume ? [{ job_id: draft.jobId, stage: 'stopped', active: false,
        resume_supported: true, completed_chunk_count: 2, chunk_count: 240 }] : [],
    });
    if (url.pathname === '/api/analyze') {
      const form = await new Response(request.postDataBuffer(), {
        headers: { 'Content-Type': request.headers()['content-type'] },
      }).formData();
      const file = form.get('file');
      assert.ok(file && typeof file !== 'string');
      requests.push({ name: file.name, bytes: Buffer.from(await file.arrayBuffer()),
        jobId: form.get('job_id'), resumeRequested: form.get('resume_requested') });
      return file.name === 'unknown.wav'
        ? reply({ detail: { code: 'media_duration_unavailable', message: unavailableMessage, max_duration_seconds: 7200 } }, 422)
        : reply({ detail: { code: 'duration_limit_exceeded', message: limitMessage, max_duration_seconds: 7200, duration_seconds: 7200.25 } }, 413);
    }
    if (url.pathname.startsWith('/api/dev/')) return reply({}, 404);
    // The connection provider's background reconnect; this development-UI regression runs without an engine.
    if (url.pathname === '/api/probe') return route.abort('connectionrefused');
    unexpectedApi.push(`${request.method()} ${url.pathname}`);
    return route.abort();
  });
  await page.goto(appUrl.href, { waitUntil: 'domcontentloaded' });
  await page.getByRole('heading', { name: '새 회의록', exact: true }).waitFor();
  return { context, page, requests, unexpectedApi, errors };
};
const waitEnabled = async page => page.waitForFunction(() => {
  const button = document.querySelector('.writer-start-button');
  return button && !button.disabled;
});
const expectSelectedFile = (page, name) => page.locator('.selected-file-card').getByText(name, { exact: true }).waitFor();

try {
  const first = await openCase();
  try {
    const { page, requests } = first;
    await page.locator('#meeting-title').fill('입력 보존 확인');
    await page.locator('#meeting-purpose').fill('길이 확인 오류 후 원래 입력 유지');
    await page.setInputFiles('#meeting-file-input', { name: 'over.wav', mimeType: 'audio/wav', buffer: Buffer.alloc(64) });
    await page.locator('#writer-form-error').filter({ hasText: `선택한 파일은 약 2시간 1분입니다. ${limitMessage}` }).waitFor();
    assert.equal(await page.locator('.writer-start-button').isDisabled(), true);
    await expectSelectedFile(page, 'over.wav');
    assert.equal(requests.length, 0);

    await page.setInputFiles('#meeting-file-input', { name: 'boundary.wav', mimeType: 'audio/wav', buffer: boundaryBytes });
    await waitEnabled(page);
    assert.equal(await page.getByText('선택한 파일은 약', { exact: false }).count(), 0);
    await page.locator('.writer-start-button').click();
    await page.getByRole('alert').filter({ hasText: limitMessage }).waitFor();
    assert.equal(requests.length, 1, 'exactly 7200s reaches authoritative server validation');
    await page.getByRole('button', { name: '입력 확인', exact: true }).click();
    // The conditional input is remounted after analysis; the selected React File is what must survive.
    await expectSelectedFile(page, 'boundary.wav');
    assert.equal(await page.locator('#meeting-title').inputValue(), '입력 보존 확인');
    assert.equal(await page.locator('#meeting-purpose').inputValue(), '길이 확인 오류 후 원래 입력 유지');
    await page.locator('.writer-start-button').click();
    await page.getByRole('alert').filter({ hasText: limitMessage }).waitFor();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].name, 'boundary.wav');
    assert.deepEqual(requests[0].bytes, boundaryBytes);
    assert.deepEqual(requests[1].bytes, boundaryBytes, 'retry submits the same file without selecting it again');
    await page.getByRole('button', { name: '입력 확인', exact: true }).click();

    await page.setInputFiles('#meeting-file-input', { name: 'unknown.wav', mimeType: 'audio/wav', buffer: unknownBytes });
    await waitEnabled(page);
    await page.locator('.writer-start-button').click();
    await page.getByRole('alert').filter({ hasText: unavailableMessage }).waitFor();
    assert.equal(requests.length, 3, 'unknown metadata is not treated as a valid duration or blocked locally');
    await page.getByRole('button', { name: '입력 확인', exact: true }).click();
    await expectSelectedFile(page, 'unknown.wav');
    assert.equal(await page.locator('#meeting-title').inputValue(), '입력 보존 확인');
    assert.equal(await page.locator('#meeting-purpose').inputValue(), '길이 확인 오류 후 원래 입력 유지');
    await page.locator('.writer-start-button').click();
    await page.getByRole('alert').filter({ hasText: unavailableMessage }).waitFor();
    assert.equal(requests.length, 4);
    assert.equal(requests[3].name, 'unknown.wav');
    assert.deepEqual(requests[2].bytes, unknownBytes);
    assert.deepEqual(requests[3].bytes, unknownBytes);
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('analysisResumeDrafts') || '[]')), [], 'rejected new uploads must not leave a resumable draft');
    assert.deepEqual(first.errors, []);
    assert.deepEqual(first.unexpectedApi, []);
  } finally { await first.context.close(); }

  const resumed = await openCase(true);
  try {
    const { page, requests } = resumed;
    await page.getByRole('button', { name: /이어서 할 분석 1건/ }).click();
    await page.locator('.sidebar-resume-draft-button').filter({ hasText: draft.title }).click();
    await page.getByRole('heading', { name: '이어하기', exact: true }).waitFor();
    // Keep an explicit mtime for resume identity and in-memory bytes for CDP multipart inspection.
    await page.locator('#meeting-file-input').evaluate((input, fixture) => {
      const files = new DataTransfer();
      files.items.add(new File([new Uint8Array(fixture.bytes)], fixture.name, {
        type: 'audio/wav', lastModified: fixture.lastModified,
      }));
      input.files = files.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
    }, { name: draft.sourceFilename, bytes: [...resumeBytes], lastModified: draft.sourceLastModified });
    await waitEnabled(page);
    assert.equal(await page.locator('.writer-start-button').innerText(), '이어하기');
    await page.locator('.writer-start-button').click();
    await page.getByRole('alert').filter({ hasText: limitMessage }).waitFor();
    assert.equal(requests.length, 1);
    assert.equal(requests[0].jobId, draft.jobId);
    assert.equal(requests[0].resumeRequested, 'true');
    assert.deepEqual(requests[0].bytes, resumeBytes);
    await page.getByRole('button', { name: '입력 확인', exact: true }).click();
    await expectSelectedFile(page, draft.sourceFilename);
    assert.equal(await page.locator('#meeting-title').inputValue(), draft.title);
    assert.equal(await page.locator('#meeting-purpose').inputValue(), draft.meetingPurpose);
    assert.equal(await page.locator('.writer-start-button').innerText(), '이어하기');
    await page.locator('.writer-start-button').click();
    await page.getByRole('alert').filter({ hasText: limitMessage }).waitFor();
    assert.equal(requests.length, 2);
    assert.equal(requests[1].name, draft.sourceFilename);
    assert.equal(requests[1].jobId, draft.jobId);
    assert.equal(requests[1].resumeRequested, 'true');
    assert.deepEqual(requests[1].bytes, resumeBytes);
    const retained = await page.evaluate(id => JSON.parse(localStorage.getItem('analysisResumeDrafts') || '[]').find(d => d.jobId === id), draft.jobId);
    assert.equal(retained.completedChunkCount, 2);
    assert.equal(retained.sourceFilename, draft.sourceFilename);
    assert.equal(retained.status, 'stopped');
    assert.equal(retained.stage, 'stopped');
    assert.equal(retained.lastProgress, 40);
    assert.deepEqual(resumed.errors, []);
    assert.deepEqual(resumed.unexpectedApi, []);
  } finally { await resumed.context.close(); }
  console.log('PASS: 7200s boundary, excess, unknown metadata, resume identity, and rejected-file/input preservation (mocked metadata/API).');
} finally {
  await browser.close();
}
