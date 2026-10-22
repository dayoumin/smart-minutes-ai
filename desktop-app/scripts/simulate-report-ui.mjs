import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { chromium } from 'playwright';

const appUrl = process.env.APP_URL;
assert.ok(appUrl, 'Set APP_URL to the caller-owned UI server; this script does not start or stop servers.');
const baseline = process.env.REPORT_UI_BASELINE === '1';
const preparing = '요약 프로그램이 아직 준비되지 않았습니다. 잠시 후 생성을 다시 눌러 주세요.';
const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });
const segments = [
  { start: '00:00:03', end: '00:00:18', speaker: 'SPEAKER_00', text: '이번 주 조사 진행 상황과 다음 일정을 확인했습니다.' },
  { start: '00:00:19', end: '00:00:41', speaker: 'SPEAKER_01', text: '금요일까지 조사 자료를 공유하겠습니다.' },
];
const report = {
  templateId: 'standard-minutes', templateName: '기본 보고서', generatedAt: '2026-10-22T01:00:00.000Z',
  content: '조사 진행 상황과 다음 주 계획을 공유했습니다.',
  sections: [{ title: '보고 개요', content: '조사 진행 상황과 다음 주 계획을 공유했습니다.' }, { title: '후속 조치', content: '금요일까지 자료를 취합하고 담당자가 다음 일정을 확인합니다.' }],
};
const record = (id, extra = {}) => ({
  id, jobId: id, title: `보고서 검증 ${id}`, date: '2026-10-22 10:00', participants: '',
  meetingPurpose: '조사 일정과 담당자 확인', summary: '조사 상황을 확인하고 금요일 자료 공유를 결정했습니다.',
  segments, displaySegments: segments, speakerLabels: { SPEAKER_00: '김연구', SPEAKER_01: '박조사' },
  analysisStatus: 'completed', diarizationApplied: true,
  generationStatus: { summary: 'completed', topicSections: 'not_started', speakerContextSummaries: 'not_started', meetingReport: 'not_started' },
  ...extra,
});

const putRecords = (page, records) => page.evaluate(values => new Promise((resolve, reject) => {
  const request = indexedDB.open('MeetingHistoryDB', 2);
  request.onerror = () => reject(request.error);
  request.onupgradeneeded = () => {
    const db = request.result;
    for (const name of ['meetings', 'folders']) if (!db.objectStoreNames.contains(name)) db.createObjectStore(name, { keyPath: 'id' });
  };
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction('meetings', 'readwrite');
    values.forEach(value => tx.objectStore('meetings').put(value));
    tx.oncomplete = () => { db.close(); window.dispatchEvent(new Event('meetings:updated')); resolve(); };
    tx.onerror = () => { db.close(); reject(tx.error); };
  };
}), records);

const readRecord = (page, id) => page.evaluate(key => new Promise((resolve, reject) => {
  const request = indexedDB.open('MeetingHistoryDB', 2);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const tx = db.transaction('meetings', 'readonly');
    const get = tx.objectStore('meetings').get(key);
    get.onsuccess = () => resolve(get.result);
    get.onerror = () => reject(get.error);
    tx.oncomplete = () => db.close();
  };
}), id);

const openReport = async (page, meeting) => {
  const expand = page.getByRole('button', { name: '메뉴 펼치기', exact: true });
  if (await expand.isVisible()) await expand.click();
  await page.locator('.barorok-navigation').getByText(meeting.title, { exact: true }).click();
  await page.locator('.meeting-detail-shell').getByRole('heading', { name: meeting.title, exact: true }).waitFor();
  const reportTab = page.getByRole('tab', { name: '보고서', exact: true });
  await reportTab.click();
  try {
    await page.waitForFunction(() => document.getElementById('meeting-detail-tab-report')?.getAttribute('aria-selected') === 'true');
    await page.locator('#meeting-detail-panel-report').waitFor({ state: 'visible' });
  } catch (error) {
    console.error('Report tab state:', await reportTab.evaluate(el => ({ className: el.className, selected: el.getAttribute('aria-selected') })));
    throw error;
  }
};

const shot = async (page, width, state) => {
  if (!process.env.REPORT_UI_SCREENSHOTS) return;
  await mkdir(process.env.REPORT_UI_SCREENSHOTS, { recursive: true });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({ path: `${process.env.REPORT_UI_SCREENSHOTS}/report-${width}-${state}.png`, animations: 'disabled' });
};
const anchors = page => page.evaluate(() => Object.fromEntries(['.detail-main-nav', '.detail-command-bar-report'].map(selector => {
  const { top, left } = document.querySelector(selector).getBoundingClientRect();
  return [selector, [Math.round(top), Math.round(left)]];
})));
const assertFits = async (page, width) => {
  const metrics = await page.locator('.detail-command-bar-report').evaluate(el => {
    const bounds = el.getBoundingClientRect();
    return {
      document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      toolbar: el.scrollWidth - el.clientWidth,
      controlsInside: [...el.querySelectorAll('button, select')].every(control => {
        const r = control.getBoundingClientRect();
        return r.left >= bounds.left - 1 && r.right <= bounds.right + 1;
      }),
    };
  });
  assert.ok(metrics.document <= 0 && metrics.toolbar <= 1 && metrics.controlsInside, `${width}px report controls fit: ${JSON.stringify(metrics)}`);
};

const assertTypography = async page => {
  const metrics = await page.evaluate(() => {
    const details = selector => {
      const el = document.querySelector(selector);
      const style = getComputedStyle(el);
      return { family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, line: style.lineHeight, color: style.color };
    };
    const label = document.querySelector('.meeting-meta-label');
    let background = label;
    while (background && ['rgba(0, 0, 0, 0)', 'transparent'].includes(getComputedStyle(background).backgroundColor)) background = background.parentElement;
    return {
      label: details('.meeting-meta-label'), value: details('.meeting-meta-value'),
      button: details('#meeting-detail-panel-report .detail-download-control > button'),
      select: details('#meeting-detail-panel-report select'),
      body: details('.detail-report-result-section p, .detail-report-content'),
      background: background ? getComputedStyle(background).backgroundColor : 'rgb(255, 255, 255)',
    };
  });
  for (const key of ['label', 'value', 'button', 'body']) {
    assert.match(metrics[key].family, /Pretendard/i, `${key} uses the bundled UI font`);
    assert.equal(metrics[key].family, metrics.label.family, `${key} shares the detail font family`);
  }
  assert.equal(metrics.label.size, '14px');
  assert.equal(metrics.label.weight, '600');
  assert.equal(metrics.button.size, '14px');
  assert.equal(metrics.select.size, '14px');
  assert.equal(metrics.body.size, '15px');
  assert.equal(metrics.body.line, '28px');
  const luminance = color => {
    const rgb = color.match(/[\d.]+/g).slice(0, 3).map(Number).map(value => {
      const s = value / 255;
      return s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
    });
    return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
  };
  const a = luminance(metrics.label.color), b = luminance(metrics.background);
  assert.ok((Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05) >= 4.5, 'metadata labels meet normal-text contrast');
  await page.getByRole('tab', { name: '대화록', exact: true }).click();
  assert.equal(await page.locator('.script-text').first().evaluate(el => getComputedStyle(el).fontSize), '15px');
  assert.equal(await page.locator('.script-time-range').first().evaluate(el => getComputedStyle(el).fontSize), '12px');
  await page.getByRole('tab', { name: '보고서', exact: true }).click();
};

const run = async (browser, width) => {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const page = await context.newPage();
  page.setDefaultTimeout(10000);
  const fresh = record('first-report');
  const existing = record('existing-report', { meetingReport: report, generationStatus: { summary: 'completed', meetingReport: 'completed' } });
  const archived = record('archived-report', { meetingReport: { ...report, content: '보관된 보고서 내용입니다.' }, generationStatus: { summary: 'completed', meetingReport: 'completed' }, transcriptEditMeta: { summaryOutdated: true } });
  const refresh = record('refresh-report');
  const failure = record('failed-report');
  const attempts = new Map(), generationBodies = [], exportBodies = [];
  let ready = false;
  let releaseRetry, releaseExisting;
  const retryGate = new Promise(resolve => { releaseRetry = resolve; });
  const existingGate = new Promise(resolve => { releaseExisting = resolve; });
  await page.route('**/api/**', route => route.fulfill(json({}, 404)));
  await page.route('**/api/health', route => route.fulfill(json({ ok: true })));
  await page.route('**/api/settings', route => route.fulfill(json({ summary: { enabled: true }, diarization: { enabled: true } })));
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill(json({ drafts: [] })));
  await page.route('**/api/models/status', route => route.fulfill(json({ ready: true, models: [], summary_ready: ready, summary_reason: ready ? 'ready' : 'runtime_preparing', ollama_connection: { status: ready ? 'managed_running' : 'managed_stopped', can_auto_start: true, managed_runtime_available: true } })));
  await page.route('**/api/outputs/*/generate-report', async route => {
    const id = new URL(route.request().url()).pathname.split('/').at(-2);
    const count = (attempts.get(id) ?? 0) + 1;
    attempts.set(id, count);
    generationBodies.push(JSON.parse(route.request().postData() ?? '{}'));
    if (id === fresh.id && count > 1) {
      await retryGate;
      return route.fulfill(json({ meetingReport: report, generationStatus: { summary: 'completed', meetingReport: 'completed' } }));
    }
    if (id === existing.id) await existingGate;
    if (id === failure.id) return route.fulfill(json({ detail: { code: 'generation_internal_error', retryable: true, user_action: 'retry' } }, 500));
    return route.fulfill(json({ detail: { code: 'runtime_preparing', message: preparing, retryable: true, user_action: 'retry' } }, 503));
  });
  await page.route('**/api/export-record/**', route => {
    exportBodies.push(JSON.parse(route.request().postData() ?? '{}'));
    return route.fulfill(json({ saved_path: `C:\\Downloads\\report-${width}.md` }));
  });
  try {
    await page.goto(appUrl, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor();
    await putRecords(page, [fresh, existing, archived, refresh, failure]);
    await openReport(page, fresh);
    await shot(page, width, 'initial');
    if (baseline) {
      await openReport(page, existing);
      await page.locator('.detail-report-result').waitFor();
      await shot(page, width, 'existing');
      console.log(`ok - report UI baseline at ${width}px`);
      return;
    }
    const panel = page.locator('#meeting-detail-panel-report');
    const status = panel.locator('.detail-report-status');
    const generate = panel.getByRole('button', { name: '회의록 보고서 생성', exact: true });
    const save = panel.locator('.detail-download-control > button');
    const initialAnchors = await anchors(page);
    await assertFits(page, width);
    assert.equal(await save.isDisabled(), true, 'an empty report cannot be saved');
    await generate.click();
    await status.getByText(preparing, { exact: true }).waitFor();
    assert.match(await status.getAttribute('class'), /detail-report-status-warning/);
    assert.equal((await readRecord(page, fresh.id)).generationStatus.meetingReport, 'not_started');
    assert.deepEqual(await anchors(page), initialAnchors, 'preparation keeps navigation anchors');
    await shot(page, width, 'preparing');
    await generate.click();
    await page.waitForFunction(() => document.querySelector('#meeting-detail-panel-report .detail-report-status')?.textContent.includes('보고서를 생성 중'));
    assert.equal(await save.isDisabled(), true, 'download is blocked while generating');
    assert.deepEqual(await anchors(page), initialAnchors, 'running keeps navigation anchors');
    releaseRetry();
    await panel.getByText(report.sections[0].content, { exact: true }).waitFor();
    assert.equal((await readRecord(page, fresh.id)).generationStatus.meetingReport, 'completed');
    assert.equal(await save.isEnabled(), true);
    assert.equal((await save.innerText()).trim(), '파일 저장');
    assert.deepEqual(await anchors(page), initialAnchors, 'completed keeps navigation anchors');
    assert.equal(generationBodies.at(-1).summary, fresh.summary);
    assert.deepEqual(generationBodies.at(-1).segments, fresh.segments, 'generation includes the canonical transcript');
    await assertTypography(page);
    await shot(page, width, 'completed');

    await openReport(page, existing);
    await generate.click();
    await page.waitForFunction(() => document.querySelector('#meeting-detail-panel-report .detail-report-status')?.textContent.includes('보고서를 생성 중'));
    assert.equal(await save.isDisabled(), true, 'existing report is protected from download during regeneration');
    releaseExisting();
    await status.getByText(preparing, { exact: true }).waitFor();
    const preserved = await readRecord(page, existing.id);
    assert.equal(preserved.generationStatus.meetingReport, 'completed');
    assert.deepEqual(preserved.meetingReport, report);
    assert.equal(await save.isEnabled(), true, 'preserved result stays downloadable after preparation failure');

    await openReport(page, refresh);
    await generate.click();
    await status.getByText(preparing, { exact: true }).waitFor();
    ready = true;
    const response = page.waitForResponse(res => res.url().endsWith('/api/models/status') && res.ok());
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await response;
    await status.getByText(preparing, { exact: true }).waitFor({ state: 'hidden' });

    await openReport(page, failure);
    const errorAnchors = await anchors(page);
    await generate.click();
    await page.waitForFunction(() => document.querySelector('#meeting-detail-panel-report .detail-report-status-error'));
    assert.equal((await readRecord(page, failure.id)).generationStatus.meetingReport, 'failed');
    assert.deepEqual(await anchors(page), errorAnchors, 'error keeps navigation anchors');
    await shot(page, width, 'error');

    for (const meeting of [fresh, archived]) {
      await openReport(page, meeting);
      assert.equal(await save.isEnabled(), true, 'completed and archived reports are downloadable');
      await assertFits(page, width);
      const stored = await readRecord(page, meeting.id);
      await save.click();
      await page.getByRole('dialog', { name: '보고서 파일 이름 지정' }).getByRole('button', { name: '파일 저장', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('#meeting-detail-panel-report .detail-download-control > button')?.textContent.includes('저장됨'));
      assert.equal(exportBodies.at(-1).exportScope, 'report');
      assert.deepEqual(exportBodies.at(-1).meetingReport, stored.meetingReport, 'export uses the latest locally stored report');
    }
    console.log(`ok - report UI ${width}px (preparation/retry, preservation, readiness, failure, export, typography)`);
  } finally {
    releaseRetry(); releaseExisting();
    await context.close();
  }
};

const browser = await chromium.launch({ headless: true });
try {
  for (const width of [1440, 1024]) await run(browser, width);
} finally { await browser.close(); }
