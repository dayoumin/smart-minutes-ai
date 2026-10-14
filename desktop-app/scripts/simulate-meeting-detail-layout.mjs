import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const shouldStartServer = !process.env.APP_URL;

const waitForApp = async (url, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until the dedicated Vite server is ready.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const startServer = async () => {
  if (!shouldStartServer) return null;
  try {
    await waitForApp(APP_URL, 1000);
    return null;
  } catch {
    // Start a server only when the configured port is unused.
  }
  const url = new URL(APP_URL);
  const child = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', `corepack pnpm exec vite --host ${url.hostname} --port ${url.port || '5173'}`],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  await waitForApp(APP_URL);
  return child;
};

const stopServer = async child => {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const killer = spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `taskkill /pid ${child.pid} /t /f`],
      { stdio: 'ignore', windowsHide: true },
    );
    killer.on('exit', resolve);
    killer.on('error', resolve);
  });
};

const json = body => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });

const installBaseRoutes = async page => {
  await page.route('**/api/**', route => route.fulfill({ status: 404, contentType: 'application/json', body: '{}' }));
  await page.route('**/api/health', route => route.fulfill(json({ ok: true })));
  await page.route('**/api/settings', route => route.fulfill(json({ diarization: { enabled: true, generate_during_analysis: true } })));
  await page.route('**/api/models/status', route => route.fulfill(json({ ready: true, models: [] })));
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill(json({ drafts: [] })));
};

const putMeetings = async (page, meetings) => page.evaluate(values => new Promise((resolve, reject) => {
  const request = indexedDB.open('MeetingHistoryDB', 2);
  request.onerror = () => reject(request.error);
  request.onupgradeneeded = () => {
    const db = request.result;
    if (!db.objectStoreNames.contains('meetings')) db.createObjectStore('meetings', { keyPath: 'id' });
    if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
  };
  request.onsuccess = () => {
    const db = request.result;
    const transaction = db.transaction('meetings', 'readwrite');
    const store = transaction.objectStore('meetings');
    values.forEach(value => store.put(value));
    transaction.oncomplete = () => {
      db.close();
      window.dispatchEvent(new Event('meetings:updated'));
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  };
}), meetings);

const segments = [
  { start: '00:00:03', end: '00:00:18', speaker: 'SPEAKER_00', text: '3분기 자원조사 결과를 정리하겠습니다.' },
  { start: '00:00:19', end: '00:00:41', speaker: 'SPEAKER_01', text: '고등어 어획량이 전 분기 대비 약 18% 줄었습니다. 수온이 평년보다 높게 유지되면서 어군이 북쪽으로 이동한 것으로 보입니다.' },
];

const baseMeeting = {
  date: '2026-10-14 13:00',
  participants: '',
  summary: '어획량 감소 원인과 장비 교정 일정을 정리했다.',
  segments,
  displaySegments: segments,
  speakerLabels: { SPEAKER_00: '김연구', SPEAKER_01: '박조사' },
  analysisStatus: 'completed',
  generationStatus: { summary: 'completed', topicSections: 'completed' },
};

const topicMeeting = {
  ...baseMeeting,
  id: 'layout-topic-meeting',
  title: '주제 칩 이동 확인',
  topics: ['어획량 감소', '장비 교정', '어획량 감소와 수온', '음향 장비 교정'],
  topicSections: [
    { topic: '어획량 감소와 수온', summary: '수온 상승으로 어군이 북상했다.' },
    { topic: '음향 장비 교정', summary: '10월 말까지 교정을 마친다.' },
  ],
};

const narrowMeeting = {
  ...baseMeeting,
  id: 'layout-narrow-meeting',
  title: '좁은 폭 메타 확인',
  meetingPurpose: '아주 긴 회의 목적 문장입니다. 상반기 사업 현황 점검과 결정사항, 후속 조치 담당자 지정까지 모두 다룹니다',
  sourceFile: '아주-긴-원본-파일-이름-2026-10-14-회의.m4a',
  analysisStatus: 'diarization_failed',
  diarizationRequested: true,
  jobId: 'layout-narrow-job',
};

const openMeeting = async (page, title) => {
  await page.locator('.barorok-navigation').getByText(title, { exact: true }).click();
  await page.locator('.meeting-detail-shell').getByRole('heading', { name: title }).waitFor({ timeout: 10000 });
};

const runTopicChipScenario = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 기록', exact: true }).first().waitFor({ timeout: 10000 });
    await putMeetings(page, [topicMeeting]);
    await openMeeting(page, topicMeeting.title);
    await page.getByRole('tab', { name: '기록 정리', exact: true }).click();

    const chips = page.locator('.summary-topic-list .topic-chip');
    assert.deepEqual(await chips.allTextContents(), ['어획량 감소와 수온', '음향 장비 교정'], 'summary chips should use deduplicated topic section titles');

    // Visit the topic sections once so their nodes unmount before the chip is used.
    await page.getByRole('tab', { name: '주제별 정리', exact: true }).click();
    await page.locator('#organize-mode-panel-topics').waitFor();
    await page.getByRole('tab', { name: '전체 요약', exact: true }).click();
    await page.locator('.summary-topic-list').getByRole('button', { name: '음향 장비 교정' }).click();

    await page.waitForFunction(() => document.activeElement?.classList.contains('topic-section-heading'));
    assert.equal(await page.getByRole('tab', { name: '주제별 정리', exact: true }).getAttribute('aria-selected'), 'true');
    assert.equal(await page.evaluate(() => document.activeElement?.textContent), '음향 장비 교정', 'focus should move to the opened topic heading');
    const sectionInViewport = await page.evaluate(() => {
      const heading = document.activeElement;
      const article = heading?.closest('article');
      if (!article?.isConnected) return false;
      const rect = article.getBoundingClientRect();
      return rect.bottom > 0 && rect.top < window.innerHeight;
    });
    assert.ok(sectionInViewport, 'the selected topic section should be connected and visible');
    console.log('ok - summary topic chip dedupes and opens the topic after a tab round-trip');
  } finally {
    await context.close();
  }
};

const runNarrowMetaScenario = async browser => {
  const context = await browser.newContext({ viewport: { width: 760, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 기록', exact: true }).first().waitFor({ timeout: 10000 });
    await putMeetings(page, [narrowMeeting]);
    await openMeeting(page, narrowMeeting.title);
    await page.locator('.meeting-status-grid').waitFor();
    const metrics = await page.evaluate(() => {
      const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
      const list = rect('.meeting-meta-list');
      const status = rect('.meeting-status-grid');
      const listElement = document.querySelector('.meeting-meta-list');
      return {
        intersects: Boolean(list && status
          && list.left < status.right && status.left < list.right
          && list.top < status.bottom && status.top < list.bottom),
        listOverflow: listElement ? listElement.scrollWidth - listElement.clientWidth : null,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.equal(metrics.intersects, false, 'meta list and status chips should not overlap');
    assert.ok(metrics.listOverflow !== null && metrics.listOverflow <= 1, `meta list overflowed by ${metrics.listOverflow}px`);
    assert.ok(metrics.documentOverflow <= 0, `document overflowed by ${metrics.documentOverflow}px`);
    console.log('ok - narrow meeting meta line wraps without overlap');
  } finally {
    await context.close();
  }
};

const runTranscriptRowScenario = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '새 기록', exact: true }).first().waitFor({ timeout: 10000 });
    await putMeetings(page, [{ ...topicMeeting, id: 'layout-row-meeting', title: '대화록 행 확인' }]);
    await openMeeting(page, '대화록 행 확인');
    await page.locator('.script-row').first().waitFor();
    const rowTops = async textSelector => page.locator('.script-row').first().evaluate((row, selector) => (
      ['.script-time-range', '.script-meta', selector].map(part => Math.round(row.querySelector(part).getBoundingClientRect().top))
    ), textSelector);
    const [timeTop, metaTop, textTop] = await rowTops('.script-text');
    assert.ok(timeTop === metaTop && metaTop === textTop, `wide transcript row should share one line: ${timeTop}/${metaTop}/${textTop}`);
    await page.getByRole('button', { name: '대화록 편집', exact: true }).click();
    const [editTimeTop, , editTextTop] = await rowTops('.script-edit-textarea');
    assert.ok(Math.abs(editTimeTop - editTextTop) <= 1, 'edit textarea should stay in the text column of the same row');
    console.log('ok - transcript rows keep time, speaker and text on one line');
  } finally {
    await context.close();
  }
};

const server = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  await runTopicChipScenario(browser);
  await runNarrowMetaScenario(browser);
  await runTranscriptRowScenario(browser);
} finally {
  await browser.close();
  await stopServer(server);
}
