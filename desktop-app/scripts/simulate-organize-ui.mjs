import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

// The caller owns the Vite server and its lifecycle. Never attach to a default port.
const appUrl = process.env.APP_URL;
assert.ok(appUrl, 'Set APP_URL to the caller-owned UI server before running this simulation.');
const preparationMessage = '요약 프로그램이 아직 준비되지 않았습니다. 잠시 후 정리를 다시 눌러 주세요.';
const reviewMessage = 'AI가 정리한 내용에는 누락이나 잘못된 해석이 있을 수 있습니다. 중요한 내용은 대화록과 대조해 주세요.';
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const segments = [
  { start: '00:00:03', end: '00:00:18', speaker: 'SPEAKER_00', text: '이번 주 조사 진행 상황과 다음 일정을 확인했습니다.' },
  { start: '00:00:19', end: '00:00:41', speaker: 'SPEAKER_01', text: '금요일까지 조사 자료를 공유하겠습니다.' },
];
const meeting = (id, extra = {}) => ({
  id, jobId: id, title: `기록 정리 검증 ${id}`, date: '2026-10-22 10:00',
  participants: '', meetingPurpose: '조사 일정 확인', summary: '', segments, displaySegments: segments,
  speakerLabels: { SPEAKER_00: '김연구', SPEAKER_01: '박조사' },
  analysisStatus: 'completed', diarizationApplied: true,
  generationStatus: { summary: 'not_started', topicSections: 'not_started', speakerContextSummaries: 'not_started' },
  ...extra,
});

const putMeetings = (page, meetings) => page.evaluate(values => new Promise((resolve, reject) => {
  const request = indexedDB.open('MeetingHistoryDB', 2);
  request.onerror = () => reject(request.error);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('meetings')) db.createObjectStore('meetings', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
  };
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction('meetings', 'readwrite');
    values.forEach(value => tx.objectStore('meetings').put(value));
    tx.oncomplete = () => { db.close(); window.dispatchEvent(new Event('meetings:updated')); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  };
}), meetings);

const readMeeting = (page, id) => page.evaluate(key => new Promise((resolve, reject) => {
  const request = indexedDB.open('MeetingHistoryDB', 2);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction('meetings', 'readonly');
    const get = tx.objectStore('meetings').get(key);
    get.onerror = () => reject(get.error);
    get.onsuccess = () => resolve(get.result);
    tx.oncomplete = () => db.close();
  };
}), id);

const openOrganize = async (page, record) => {
  const expand = page.getByRole('button', { name: '메뉴 펼치기', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator('.barorok-navigation').getByText(record.title, { exact: true }).click();
  await page.locator('.meeting-detail-shell').getByRole('heading', { name: record.title, exact: true }).waitFor();
  await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
  await page.getByRole('tab', { name: '전체 요약', exact: true }).click();
};

const anchors = page => page.evaluate(() => {
  const rect = selector => {
    const { top, left } = document.querySelector(selector).getBoundingClientRect();
    return [Math.round(top), Math.round(left)];
  };
  return { nav: rect('.detail-main-nav'), toolbar: rect('.detail-command-bar-organize') };
});

const screenshot = async (page, width, state) => {
  if (!process.env.ORGANIZE_SCREENSHOTS) return;
  await mkdir(process.env.ORGANIZE_SCREENSHOTS, { recursive: true });
  await page.screenshot({ path: `${process.env.ORGANIZE_SCREENSHOTS}/organize-${width}-${state}.png` });
};

const assertToolbarFits = async (page, width, state) => {
  const overflow = await page.locator('.detail-command-bar-organize').evaluate(el => {
    const bounds = el.getBoundingClientRect();
    return {
      toolbar: el.scrollWidth - el.clientWidth,
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      controlsInside: [...el.querySelectorAll('button, select')].every(control => {
        const rect = control.getBoundingClientRect();
        return rect.left >= bounds.left - 1 && rect.right <= bounds.right + 1;
      }),
    };
  });
  assert.ok(overflow.toolbar <= 1 && overflow.document <= 0 && overflow.controlsInside,
    `${width}px ${state} controls fit: ${JSON.stringify(overflow)}`);
};

const run = async (browser, width) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  let ready = false;
  let modelReads = 0;
  const attempts = new Map();
  const exportBodies = [];
  const fresh = meeting('first-run');
  const existing = meeting('existing-result', { summary: '기존 전체 요약은 보존되어야 합니다.', generationStatus: { summary: 'completed' } });
  const refresh = meeting('ready-refresh');
  const failure = meeting('real-failure');
  const topicOnly = meeting('topic-only', {
    topicSections: [{ topic: '조사 일정', summary: '금요일까지 자료를 공유합니다.' }],
    generationStatus: { summary: 'not_started', topicSections: 'completed' },
  });
  const legacySpeaker = meeting('legacy-speaker-only', {
    participantSummaries: [{ participant: 'SPEAKER_00', summary: '조사 진행 상황을 설명했습니다.', key_points: ['다음 일정 확인'] }],
  });
  const topicNew = meeting('topic-new', { summary: '조사 일정을 확인했습니다.', generationStatus: { summary: 'completed', topicSections: 'not_started' } });
  const speakerNew = meeting('speaker-new', {
    summary: '조사 일정을 확인했습니다.', topicSections: topicOnly.topicSections,
    generationStatus: { summary: 'completed', topicSections: 'completed', speakerContextSummaries: 'not_started' },
  });
  const speakerExisting = meeting('speaker-existing', {
    summary: '조사 일정을 확인했습니다.', topicSections: topicOnly.topicSections,
    speakerContextSummaries: [{ speaker: 'SPEAKER_00', display_name: '김연구', summary: '기존 참석자별 설명입니다.', key_points: ['기존 핵심 발언'] }],
    generationStatus: { summary: 'completed', topicSections: 'completed', speakerContextSummaries: 'completed' },
  });

  await page.route('**/api/**', route => route.fulfill(json({}, 404)));
  await page.route('**/api/health', route => route.fulfill(json({ ok: true })));
  await page.route('**/api/settings', route => route.fulfill(json({ summary: { enabled: true }, diarization: { enabled: true } })));
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill(json({ drafts: [] })));
  await page.route('**/api/models/status', route => {
    modelReads += 1;
    return route.fulfill(json({
      ready: true, models: [], summary_ready: ready, summary_reason: ready ? 'ready' : 'runtime_preparing',
      summary_message: ready ? '' : preparationMessage,
      ollama_connection: { status: ready ? 'managed_running' : 'managed_stopped', can_auto_start: true, managed_runtime_available: true },
    }));
  });
  await page.route('**/api/outputs/*/generate-summary', route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const count = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, count);
    if (id === failure.id) return route.fulfill(json({ detail: { code: 'generation_internal_error', retryable: true, user_action: 'retry' } }, 500));
    if (id === fresh.id && count > 1) return route.fulfill(json({ summary: '이번 주 조사 상황을 확인하고 금요일 자료 공유를 결정했습니다.', generationStatus: { summary: 'completed' } }));
    return route.fulfill(json({ detail: { code: 'runtime_preparing', retryable: true, user_action: 'retry', message: preparationMessage } }, 503));
  });
  for (const endpoint of ['generate-topic-sections', 'generate-topic-section', 'generate-speaker-context']) {
    await page.route(`**/api/outputs/*/${endpoint}`, route => route.fulfill(json({
      detail: { code: 'runtime_preparing', retryable: true, user_action: 'retry', message: preparationMessage },
    }, 503)));
  }
  await page.route('**/api/export-record/**', async route => {
    exportBodies.push(JSON.parse(route.request().postData() ?? '{}'));
    return route.fulfill(json({ saved_path: `C:\\Downloads\\organize-${width}.md` }));
  });

  try {
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor();
    await putMeetings(page, [fresh, existing, refresh, failure, topicOnly, legacySpeaker, topicNew, speakerNew, speakerExisting]);
    await openOrganize(page, fresh);
    const panel = page.locator('#meeting-detail-panel-summary');
    const status = panel.locator('.detail-report-status');
    const runButton = panel.getByRole('button', { name: '전체 요약 정리', exact: true });
    assert.equal(await page.getByRole('combobox', { name: '이번 정리 기준 선택' }).locator('option:checked').innerText(), '기본 정리');
    assert.equal(await panel.getByText(reviewMessage, { exact: true }).count(), 1, 'keep the common AI review guidance');
    assert.equal(await panel.locator('.detail-organize-output-actions .detail-download-control > button').isDisabled(), true,
      'an untouched record without any organized results cannot be saved');
    const before = await anchors(page);
    await assertToolbarFits(page, width, 'initial');
    await screenshot(page, width, 'initial');
    await runButton.click();
    await status.getByText(preparationMessage, { exact: true }).waitFor();
    assert.match(await status.getAttribute('class'), /detail-report-status-warning/);
    assert.doesNotMatch(await status.getAttribute('class'), /detail-report-status-error/);
    assert.equal((await readMeeting(page, fresh.id)).generationStatus.summary, 'not_started');
    assert.equal(await panel.getByText('정리를 실행해 주세요.', { exact: false }).count(), 0, 'preparation must not also look like an untouched first run');
    assert.deepEqual(await anchors(page), before, 'preparation keeps tab and toolbar anchors stable');
    assert.equal(await runButton.isEnabled(), true, 'manual retry remains available');
    await screenshot(page, width, 'preparing');
    await runButton.click();
    await panel.getByText('이번 주 조사 상황을 확인하고 금요일 자료 공유를 결정했습니다.', { exact: true }).waitFor();
    assert.equal((await readMeeting(page, fresh.id)).generationStatus.summary, 'completed');
    assert.equal(await status.getByText(preparationMessage, { exact: true }).count(), 0);
    assert.deepEqual(await anchors(page), before, 'completed retry keeps the same navigation anchors');
    await screenshot(page, width, 'completed');

    await openOrganize(page, existing);
    await runButton.click();
    await status.getByText(preparationMessage, { exact: true }).waitFor();
    const preserved = await readMeeting(page, existing.id);
    assert.equal(preserved.generationStatus.summary, 'completed');
    assert.equal(preserved.summary, existing.summary);
    await panel.getByText(existing.summary, { exact: true }).waitFor();

    // These routes share the typed preparation error but each handler owns its prior-result status.
    for (const [record, tabName, actionName, statusKey, expectedState, resultKey] of [
      [topicNew, '주제별 정리', '주제별 정리', 'topicSections', 'not_started', null],
      [topicOnly, '주제별 정리', '주제별 정리', 'topicSections', 'completed', 'topicSections'],
      [topicOnly, '주제별 정리', '주제 추가 정리', 'topicSections', 'completed', 'topicSections'],
      [speakerNew, '참석자별 정리', '참석자별 정리', 'speakerContextSummaries', 'not_started', null],
      [speakerExisting, '참석자별 정리', '참석자별 정리', 'speakerContextSummaries', 'completed', 'speakerContextSummaries'],
    ]) {
      await openOrganize(page, record);
      await page.getByRole('tab', { name: tabName, exact: true }).click();
      if (actionName === '주제 추가 정리') {
        await panel.getByRole('textbox', { name: '추가로 정리할 주제 제목', exact: true }).fill('다음 조사 준비');
      }
      const action = panel.getByRole('button', { name: actionName, exact: true });
      assert.equal(await action.isEnabled(), true, `${record.id} satisfies ${actionName} prerequisites`);
      await action.click();
      await status.getByText(preparationMessage, { exact: true }).waitFor();
      assert.match(await status.getAttribute('class'), /detail-report-status-warning/);
      assert.doesNotMatch(await status.getAttribute('class'), /detail-report-status-error/);
      const stored = await readMeeting(page, record.id);
      assert.equal(stored.generationStatus[statusKey], expectedState, `${actionName} preparation preserves the appropriate prior status`);
      if (resultKey) assert.deepEqual(stored[resultKey], record[resultKey], `${actionName} preparation preserves prior content`);
      assert.equal(await panel.getByText('정리를 실행해 주세요.', { exact: false }).count(), 0,
        `${actionName} preparation does not show a conflicting initial-run instruction`);
      await assertToolbarFits(page, width, actionName);
    }

    await openOrganize(page, refresh);
    await runButton.click();
    await status.getByText(preparationMessage, { exact: true }).waitFor();
    const readsBefore = modelReads;
    ready = true;
    const response = page.waitForResponse(res => res.url().endsWith('/api/models/status') && res.ok());
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await response;
    await status.getByText(preparationMessage, { exact: true }).waitFor({ state: 'hidden' });
    assert.ok(modelReads > readsBefore, 'readiness refresh reached the model-status endpoint');

    await openOrganize(page, failure);
    await runButton.click();
    await page.waitForFunction(() => document.querySelector('#meeting-detail-panel-summary .detail-report-status-error'));
    assert.equal((await readMeeting(page, failure.id)).generationStatus.summary, 'failed', 'a real failure remains failed');
    assert.doesNotMatch(await status.innerText(), /Ollama|Internal Server Error|generation_internal_error/);
    await screenshot(page, width, 'error');

    for (const [record, tabName, field] of [[topicOnly, '주제별 정리', 'topicSections'], [legacySpeaker, '참석자별 정리', 'participantSummaries']]) {
      await openOrganize(page, record);
      await page.getByRole('tab', { name: tabName, exact: true }).click();
      const save = panel.locator('.detail-organize-output-actions .detail-download-control > button');
      assert.equal(await save.isEnabled(), true, `${field} results can be saved without a whole summary`);
      assert.equal((await save.innerText()).trim(), '파일 저장');
      assert.match(await save.getAttribute('aria-label'), /^기록 정리 .*파일을 다운로드 폴더에 저장$/);
      await assertToolbarFits(page, width, field);
      await screenshot(page, width, field);
      const callsBefore = exportBodies.length;
      await save.click();
      await page.getByRole('dialog', { name: '기록 정리 파일 이름 지정' }).getByRole('button', { name: '파일 저장', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('.detail-organize-output-actions .detail-download-control > button')?.textContent.includes('저장됨'));
      assert.equal(exportBodies.length, callsBefore + 1);
      const body = exportBodies.at(-1);
      assert.equal(body.exportScope, 'organized', 'shared file save retains the full organized record scope');
      assert.deepEqual(body[field], record[field], `${field} survives the export payload`);
    }
    console.log(`ok - organize UI at ${width}px (all organize preparation paths, retry, preserved results, ready refresh, failure, partial exports)`);
  } finally {
    await context.close();
  }
};

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 1024]) await run(browser, width);
} finally {
  await browser.close();
}
