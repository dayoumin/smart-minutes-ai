import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { mkdir } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BRAND_NAME, LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';


let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const shouldStartServer = !process.env.APP_URL;
const DAY_MS = 24 * 60 * 60 * 1000;

const waitForApp = async (url, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until ready.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const getAvailablePort = async (host) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, host, () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close(() => reject(new Error('Could not allocate a local test port.')));
      return;
    }
    const { port } = address;
    server.close(() => resolve(port));
  });
});

const startServer = async () => {
  if (!shouldStartServer) {
    await waitForApp(APP_URL);
    return null;
  }
  const url = new URL(APP_URL);
  url.port = String(await getAvailablePort(url.hostname));
  APP_URL = url.toString();
  const command = `corepack pnpm exec vite --host ${url.hostname} --port ${url.port} --strictPort --configLoader runner`;
  const child = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', command],
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

const stopServer = async (child) => {
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

const installBaseRoutes = async page => {
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ diarization: { enabled: true, generate_during_analysis: true } }),
  }));
  await page.route('**/api/models/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ready: true, models: [] }),
  }));
};

const assertNoHorizontalOverflow = async page => {
  const overflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    workspace: (() => {
      const element = document.querySelector('.barorok-workspace');
      return element ? element.scrollWidth - element.clientWidth : 0;
    })(),
  }));
  assert.ok(overflow.document <= 0, `document overflowed by ${overflow.document}px`);
  assert.ok(overflow.workspace <= 0, `workspace overflowed by ${overflow.workspace}px`);
};

const putMeeting = async (page, meeting) => page.evaluate(value => new Promise((resolve, reject) => {
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
    transaction.objectStore('meetings').put(value);
    transaction.oncomplete = () => {
      db.close();
      window.dispatchEvent(new Event('meetings:updated'));
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  };
}), meeting);

const readMeetingIds = async page => page.evaluate(() => new Promise((resolve, reject) => {
  const request = indexedDB.open('MeetingHistoryDB', 2);
  request.onerror = () => reject(request.error);
  request.onsuccess = () => {
    const db = request.result;
    const read = db.transaction('meetings', 'readonly').objectStore('meetings').getAllKeys();
    read.onsuccess = () => {
      db.close();
      resolve(read.result.map(String).sort());
    };
    read.onerror = () => reject(read.error);
  };
}));

const meetingAt = (id, title, time, meetingPurpose = '') => {
  const iso = new Date(time).toISOString();
  return {
    id,
    title,
    date: iso,
    participants: '',
    meetingPurpose,
    summary: '',
    segments: [],
    displaySegments: [],
    speakerLabels: {},
    createdAt: iso,
    updatedAt: iso,
  };
};

const runEmptyHomeScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.ocean-backdrop, .start-workspace, [data-shell-variant]').count(), 0);
    assert.equal(await page.getByRole('button', { name: `${BRAND_NAME} 첫 화면` }).getAttribute('aria-current'), 'page');
    // The empty list is a stable part of the work area, independent of file selection.
    await page.getByRole('region', { name: '최근 회의록' }).getByRole('heading', { name: '최근 회의록', exact: true }).waitFor();
    assert.equal(await page.locator('.recent-meeting-row, .writer-recovery').count(), 0);

    for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
      await page.setViewportSize(viewport);
      await settleHomePaint(page);
      const layout = await readHomeLayout(page);
      assert.ok(Math.abs(layout.info.width - 280) <= 1, `meeting information keeps a 280px column at ${viewport.width}px`);
      assert.ok(layout.info.right <= layout.work.left, 'meeting information sits left of the file work area');
      assert.ok(layout.drop.left >= layout.work.left && layout.cta.right <= layout.work.right + 1, 'file and start action stay in the right column');
      assert.ok(layout.cta.bottom <= viewport.height, 'analysis start stays visible on the supported desktop window');
      assert.ok(layout.titleBeforeDate && layout.dateBeforePurpose && layout.purposeBeforeFile, 'reading order is title, date, purpose, then file');
      assert.ok(layout.date.width >= 190 && layout.dateOverflow <= 1 && layout.date.right <= layout.info.right, 'date and time input fits without clipping');
      assert.equal(await page.locator('.writer-work-column .writer-local-promise').count(), 1, 'privacy guidance belongs to the file work area');
      await assertNoHorizontalOverflow(page);
      const optional = page.getByRole('button', { name: '참석자·주요 용어 (선택)' });
      await optional.click();
      await assertLongTermFits(page);
      const expanded = await readHomeLayout(page);
      assert.deepEqual(expanded.drop, layout.drop, 'opening optional information does not move file selection');
      assert.deepEqual(expanded.cta, layout.cta, 'opening optional information does not move analysis start');
      await page.getByRole('button', { name: '참석자·주요 용어 접기' }).click();
    }

    // Missing input is a recoverable validation action, never an unreachable disabled button.
    await page.getByLabel('회의 제목', { exact: true }).fill('');
    await page.getByLabel('일시', { exact: true }).fill('');
    await page.getByLabel('회의 목적', { exact: true }).fill('');
    const start = page.getByRole('button', { name: '분석 시작', exact: true });
    await page.waitForFunction(() => document.querySelector('.writer-start-button')?.getAttribute('aria-disabled') !== 'true');
    assert.equal(await start.isEnabled(), true, 'empty fields keep the validation action reachable');
    await start.click();
    await page.locator('.writer-action-row[data-state="required-fields"]').waitFor();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'meeting-title');
    const missing = await page.locator('#writer-form-error').innerText();
    assert.ok(missing.indexOf('회의 제목') < missing.indexOf('일시') && missing.indexOf('일시') < missing.indexOf('회의 목적') && missing.indexOf('회의 목적') < missing.indexOf('영상·음성 파일'), 'missing-field message follows the new reading order');
    await page.getByLabel('회의 제목', { exact: true }).fill('두 열 입력 검증');
    await start.click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'meeting-date');
    await page.getByLabel('일시', { exact: true }).fill('2026-10-23T10:00');
    await start.click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'meeting-purpose');
    await page.getByLabel('회의 목적', { exact: true }).fill('입력 순서 확인');
    await start.click();
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'meeting-file-drop');

    await page.setViewportSize({ width: 880, height: 768 });
    await settleHomePaint(page);
    const stacked = await readHomeLayout(page);
    assert.ok(stacked.info.bottom <= stacked.work.top + 1, 'below the supported two-column threshold the information stacks above the file area');
    await assertNoHorizontalOverflow(page);
    console.log('ok - new-record home keeps desktop columns, stable work controls, validation order and narrow fallback');
  } finally {
    await context.close();
  }
};

const settleHomePaint = page => page.evaluate(async () => {
  await document.fonts.ready;
  await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
});

const readHomeLayout = page => page.evaluate(() => {
  const rect = selector => {
    const r = document.querySelector(selector).getBoundingClientRect();
    return Object.fromEntries(['top', 'left', 'right', 'bottom', 'width'].map(key => [key, Math.round(r[key])]));
  };
  const before = (first, second) => Boolean(document.querySelector(first).compareDocumentPosition(document.querySelector(second)) & Node.DOCUMENT_POSITION_FOLLOWING);
  const date = document.querySelector('#meeting-date');
  return {
    info: rect('.writer-info-column'), work: rect('.writer-work-column'),
    drop: rect('.file-drop-zone, .selected-file-card'), cta: rect('.writer-start-button'), date: rect('#meeting-date'),
    dateOverflow: date.scrollWidth - date.clientWidth,
    titleBeforeDate: before('#meeting-title', '#meeting-date'), dateBeforePurpose: before('#meeting-date', '#meeting-purpose'),
    purposeBeforeFile: before('#meeting-purpose', '.file-drop-zone, .selected-file-card'),
  };
});

const homeAudioFixture = () => {
  const audio = Buffer.alloc(44 + 16000);
  audio.write('RIFF', 0); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(audio.length - 44, 40);
  return { name: 'weekly-meeting.wav', mimeType: 'audio/wav', buffer: audio };
};

const assertLongTermFits = async page => {
  const term = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCD';
  const input = page.getByLabel('주요 용어 (선택)');
  await input.fill(term);
  await input.press('Enter');
  await page.getByRole('button', { name: `${term} 용어 삭제`, exact: true }).waitFor();
  const metrics = await page.evaluate(() => {
    const field = document.querySelector('.writer-term-input');
    const info = document.querySelector('.writer-info-column');
    const chip = document.querySelector('.writer-term-chip');
    const remove = chip.querySelector('button');
    const fieldRect = field.getBoundingClientRect(), infoRect = info.getBoundingClientRect(), chipRect = chip.getBoundingClientRect(), removeRect = remove.getBoundingClientRect();
    const hit = document.elementFromPoint(removeRect.left + removeRect.width / 2, removeRect.top + removeRect.height / 2);
    return {
      fieldOverflow: field.scrollWidth - field.clientWidth,
      railOverflow: info.scrollWidth - info.clientWidth,
      chipInside: chipRect.left >= fieldRect.left && chipRect.right <= fieldRect.right + 1,
      removeInside: removeRect.right <= fieldRect.right + 1 && removeRect.right <= infoRect.right + 1,
      removeReachable: hit === remove || remove.contains(hit),
      chipWidth: Math.round(chipRect.width), fieldWidth: Math.round(fieldRect.width), railWidth: Math.round(infoRect.width),
    };
  });
  console.log(`40-character term layout: ${JSON.stringify(metrics)}`);
  assert.ok(metrics.fieldOverflow <= 1 && metrics.railOverflow <= 1 && metrics.chipInside && metrics.removeInside && metrics.removeReachable,
    `a supported 40-character term and its delete action must fit the information column: ${JSON.stringify(metrics)}`);
  await page.getByRole('button', { name: `${term} 용어 삭제`, exact: true }).click();
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'meeting-key-terms');
};

const runLongTermScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1024, height: 768 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor();
    await page.getByRole('button', { name: '참석자·주요 용어 (선택)' }).click();
    await assertLongTermFits(page);
    console.log('ok - the 40-character term and its delete action fit the information column');
  } finally { await context.close(); }
};

const runIHomeLayoutScene = async browser => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }, { width: 860, height: 900 }, { width: 2044, height: 1149 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await installBaseRoutes(page);
    await page.route('**/api/analyze/draft-statuses', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"drafts":[]}' }));
    await page.route('**/api/analyze/resume-candidates', route => route.fulfill({ status: 200, contentType: 'application/json', body: '{"candidates":[],"recommended_job_id":null}' }));
    try {
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor();
      const recent = page.getByRole('region', { name: '최근 회의록' });
      await recent.getByRole('heading', { name: '최근 회의록', exact: true }).waitFor();
      const longName = `주간업무협의-${'조사진행상황과다음일정'.repeat(12)}.wav`;
      for (const hasRecords of [false, true]) {
        if (hasRecords) {
          await putMeeting(page, meetingAt('i-recent-first', '첫 번째 최근 회의', Date.now() - DAY_MS));
          await putMeeting(page, meetingAt('i-recent-second', '두 번째 최근 회의', Date.now() - 2 * DAY_MS));
          await page.waitForFunction(() => document.querySelectorAll('.recent-meeting-row').length === 2);
        }
        for (const hasFile of [false, true]) {
          if (hasFile) {
            await page.getByLabel('회의 제목', { exact: true }).fill('주간 업무 협의');
            await page.getByLabel('회의 목적', { exact: true }).fill('조사 진행 상황과 다음 일정 확인');
            await page.setInputFiles('#meeting-file-input', { ...homeAudioFixture(), name: longName });
            await page.locator('.selected-file-card').getByText(longName, { exact: true }).waitFor();
          }
          await page.locator('.writer-action-row[data-state="ready"]').getByText('이 PC와 연결됨', { exact: true }).waitFor();
          await settleHomePaint(page);
          assert.equal(await recent.getByRole('heading', { name: '최근 회의록', exact: true }).count(), 1);
          assert.equal(await recent.locator('.recent-meeting-row').count(), hasRecords ? 2 : 0, 'file selection does not change whether records exist');
          const layout = await page.evaluate(() => {
            const rect = selector => {
              const r = document.querySelector(selector).getBoundingClientRect();
              return Object.fromEntries(['top', 'left', 'right', 'bottom', 'width'].map(key => [key, Math.round(r[key])]));
            };
            return {
              info: rect('.writer-info-column'), content: rect('.writer-upload-layout'), upload: rect('.writer-upload-section'), guide: rect('.writer-privacy'),
              action: rect('.writer-action-row'), cta: rect('.writer-start-button'), status: rect('.writer-status-title'), recent: rect('.recent-meetings'),
            };
          });
          assert.ok(Math.abs(layout.info.width - 248) <= 1, 'metadata reserves 224px for inputs and 24px padding');
          assert.ok(layout.upload.bottom <= layout.action.top + 1, 'file selection and analysis action stay connected');
          if (viewport.width >= 1440) {
            assert.ok(layout.upload.width > layout.guide.width && layout.guide.width === 288, 'the illustration supports the wider upload column');
            assert.ok(Math.abs(layout.guide.left - layout.upload.right - 32) <= 1, 'the PC illustration sits on the right with a stable gap');
          } else {
            assert.ok(Math.abs(layout.upload.width - layout.content.width) <= 1 && layout.action.bottom <= layout.guide.top + 1, 'narrow work area stacks the promise after the actions');
          }
          assert.ok(layout.cta.top >= layout.status.bottom + 12 && layout.cta.right <= layout.action.right + 1,
            `status has its own row above the right-aligned start action: ${JSON.stringify(layout)}`);
          assert.ok(layout.cta.top >= 0 && layout.cta.bottom <= viewport.height, 'analysis start is reachable inside the desktop viewport');
          assert.ok(layout.recent.top >= Math.max(layout.action.bottom, layout.guide.bottom) - 1, 'recent records follow the upload and guidance work');
          const guidance = page.getByRole('region', { name: '처리·보관 안내', exact: true });
          await guidance.getByRole('heading', { name: '이 PC에서 분석·요약합니다', exact: true }).waitFor();
          assert.equal(await guidance.getByRole('img').isVisible(), true, 'the PC boundary illustration makes local processing visible');
          const balance = await guidance.evaluate(el => {
            const screen = el.querySelector('.local-illustration-screen').getBoundingClientRect();
            const nodes = [...el.querySelectorAll('.local-illustration-node')].map(node => node.getBoundingClientRect());
            const centers = nodes.map(node => node.x + node.width / 2);
            return { left: nodes[0].left - screen.left, right: screen.right - nodes[2].right, gaps: [centers[1] - centers[0], centers[2] - centers[1]] };
          });
          assert.ok(Math.abs(balance.left - balance.right) <= 1 && Math.abs(balance.gaps[0] - balance.gaps[1]) <= 1,
            `the picture has symmetric side margins and equally spaced processing nodes: ${JSON.stringify(balance)}`);
          await guidance.getByText('회의 요약', { exact: false }).waitFor();
          for (const id of ['meeting-title', 'meeting-date', 'meeting-purpose']) {
            assert.equal(await page.locator(`label[for="${id}"] .writer-required-mark`).innerText(), '필수');
            assert.equal(await page.locator(`#${id}`).getAttribute('aria-required'), 'true');
          }
          if (!hasFile) await page.getByText('최대 2시간', { exact: true }).waitFor();
          assert.equal(await guidance.getByText('영상·음성 파일과 대화록을 외부 AI 서버로 보내지 않습니다.', { exact: true }).count(), 0, 'the approved layout omits the subtitle');
          assert.equal(await guidance.getByRole('button', { name: '처리·보관 방식 자세히', exact: true }).count(), 0, 'the persistent details link is removed');
          if (viewport.width < 1440) {
            const spacing = await guidance.evaluate(el => {
              const text = el.querySelector('.writer-local-promise > span').getBoundingClientRect();
              const picture = el.querySelector('.local-flow-illustration').getBoundingClientRect();
              return { gap: picture.left - text.right, topDifference: picture.top - text.top };
            });
            assert.ok(Math.abs(spacing.gap - 24) <= 1 && Math.abs(spacing.topDifference) <= 1,
              `narrow guidance keeps a fixed gap and top alignment: ${JSON.stringify(spacing)}`);
          }
          await assertNoHorizontalOverflow(page);
          if (hasFile) {
            const filename = await page.locator('.selected-file-main [title]').first().evaluate(el => {
              const style = getComputedStyle(el);
              return { overflow: el.scrollWidth - el.clientWidth, textOverflow: style.textOverflow, overflowX: style.overflowX };
            });
            assert.ok(filename.overflow > 0 && filename.textOverflow === 'ellipsis' && filename.overflowX === 'hidden', 'long names stay available in title while visually truncated');
          }
          const beforeOptional = await readHomeLayout(page);
          await page.getByRole('button', { name: '참석자·주요 용어 (선택)' }).click();
          const afterOptional = await readHomeLayout(page);
          assert.deepEqual(afterOptional.cta, beforeOptional.cta, 'optional inputs do not move analysis start');
          await page.getByRole('button', { name: '참석자·주요 용어 접기' }).click();
          if (process.env.NEW_RECORD_HOME_SCREENSHOTS) {
            await mkdir(process.env.NEW_RECORD_HOME_SCREENSHOTS, { recursive: true });
            await settleHomePaint(page);
            await page.screenshot({ path: `${process.env.NEW_RECORD_HOME_SCREENSHOTS}/I-home-${viewport.width}-${hasFile ? 'selected' : 'empty'}-${hasRecords ? 'records' : 'no-records'}.png`, animations: 'disabled' });
          }
          console.log(`ok - I home ${viewport.width}px file=${hasFile} records=${hasRecords}: ${JSON.stringify(layout)}`);
        }
        await page.getByRole('button', { name: `${longName} 제거`, exact: true }).click();
        await page.locator('.file-drop-zone').waitFor();
      }
    } finally { await context.close(); }
  }
};

// A capture-only path for comparing empty and selected-file home scenes without starting analysis.
const runEmptyHomeCapture = async browser => {
  for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
    const context = await browser.newContext({ viewport });
    const page = await context.newPage();
    await installBaseRoutes(page);
    try {
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
      await page.locator('.writer-shell').getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ state: 'visible', timeout: 10000 });
      await page.locator('.writer-field label').first().waitFor({ state: 'visible' });
      await settleHomePaint(page);
      await assertNoHorizontalOverflow(page);
      const typography = await page.evaluate(() => {
        const collect = selector => [...document.querySelectorAll(selector)].map(el => {
          const style = getComputedStyle(el);
          return { text: el.textContent.trim(), family: style.fontFamily, size: style.fontSize, weight: style.fontWeight, line: style.lineHeight, color: style.color };
        });
        return { labels: collect('.writer-field label'), headings: collect('.writer-section-heading h3') };
      });
      if (process.env.NEW_RECORD_HOME_SCREENSHOTS) {
        await mkdir(process.env.NEW_RECORD_HOME_SCREENSHOTS, { recursive: true });
        await page.screenshot({
          path: `${process.env.NEW_RECORD_HOME_SCREENSHOTS}/new-record-home-${viewport.width}.png`,
          animations: 'disabled',
        });
        await page.getByLabel('회의 제목', { exact: true }).fill('주간 업무 협의');
        await page.getByLabel('회의 목적', { exact: true }).fill('진행 상황과 다음 일정 확인');
        await page.setInputFiles('#meeting-file-input', homeAudioFixture());
        await page.locator('.selected-file-card').getByText('weekly-meeting.wav', { exact: true }).waitFor();
        await settleHomePaint(page);
        await assertNoHorizontalOverflow(page);
        await page.screenshot({
          path: `${process.env.NEW_RECORD_HOME_SCREENSHOTS}/new-record-home-${viewport.width}-selected.png`,
          animations: 'disabled',
        });
      }
      console.log(`ok - empty home capture ${viewport.width}x${viewport.height}: ${JSON.stringify(typography)}`);
    } finally { await context.close(); }
  }
};

const runRecentListScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    // Anchor to local midnight so the grouping does not depend on when the test runs.
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const today = todayStart.getTime();
    const meetings = [
      meetingAt('home-today-1', '오늘 오후 운영 회의', today + 2 * 60 * 1000, '주간 운영 점검'),
      meetingAt('home-today-2', '오늘 아침 회의', today + 60 * 1000),
      meetingAt('home-week-1', '최근 기획 회의', today - 2 * DAY_MS, '신규 과제 범위'),
      meetingAt('home-older-1', '지난달 회의 1', today - 30 * DAY_MS),
      meetingAt('home-older-2', '지난달 회의 2', today - 31 * DAY_MS),
      meetingAt('home-older-3', '지난달 회의 3', today - 32 * DAY_MS),
    ];
    // Editing or pinning bumps updatedAt; the list must still order by when the meeting was recorded.
    meetings[3].updatedAt = new Date().toISOString();
    for (const meeting of meetings) await putMeeting(page, meeting);

    const recent = page.getByRole('region', { name: '최근 회의록' });
    await recent.waitFor({ timeout: 10000 });
    assert.equal(await recent.evaluate(el => Boolean(el.closest('.writer-work-column'))), true, 'recent records stay in the file work column');
    await page.waitForFunction(() => document.querySelectorAll('.recent-meeting-row').length === 5);
    const groups = await recent.locator('.recent-meetings-group-label').allTextContents();
    assert.deepEqual(groups, ['오늘', '최근 7일', '이전']);
    const titles = await recent.locator('.recent-meeting-title').allTextContents();
    assert.deepEqual(titles, ['오늘 오후 운영 회의', '오늘 아침 회의', '최근 기획 회의', '지난달 회의 1', '지난달 회의 2']);
    await assertNoHorizontalOverflow(page);

    await recent.getByRole('button', { name: /최근 기획 회의/ }).click();
    await page.locator('.meeting-detail-shell').getByRole('heading', { name: '최근 기획 회의' }).waitFor({ timeout: 10000 });
    console.log('ok - recent meetings list groups the latest five and opens a meeting');
  } finally {
    await context.close();
  }
};

const runRecoveryScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const draft = {
    jobId: 'home-recovery-job',
    title: '이어갈 회의',
    date: '2026-08-13T09:00',
    participants: '',
    sourceFilename: 'recovery.wav',
    sourceSize: 1024,
    sourceLastModified: 123456,
    status: 'stopped',
    createdAt: '2026-08-13T09:00:00.000Z',
    updatedAt: '2026-08-13T09:05:00.000Z',
    resumeEligible: true,
    completedChunkCount: 1,
  };
  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);
  const page = await context.newPage();
  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ drafts: [{
      job_id: draft.jobId,
      status: 'stopped',
      stage: 'stopped',
      resume_supported: true,
      completed_chunk_count: 1,
      last_progress: { message: '중지됨', progress: 35 },
    }] }),
  }));
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await putMeeting(page, meetingAt('home-recovery-recent', '복구보다 오래된 최근 회의', Date.now() - DAY_MS));
    const recovery = page.locator('.writer-recovery');
    await recovery.getByText('이어서 할 분석', { exact: true }).waitFor({ timeout: 10000 });
    await recovery.getByRole('heading', { name: '이어갈 회의' }).waitFor();
    const recentAfterRecovery = page.getByRole('region', { name: '최근 회의록' });
    await recentAfterRecovery.waitFor({ timeout: 10000 });
    const order = await page.evaluate(() => {
      const card = document.querySelector('.writer-recovery')?.getBoundingClientRect();
      const list = document.querySelector('.recent-meetings')?.getBoundingClientRect();
      return { cardBottom: card?.bottom ?? 0, listTop: list?.top ?? 0 };
    });
    assert.ok(order.cardBottom <= order.listTop, 'the recovery card sits above the recent list, which stays reachable');
    await recovery.getByRole('button', { name: '이어서 분석', exact: true }).click();
    await page.getByRole('heading', { name: /이어하기|분석 상태/, level: 2 }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.writer-recovery, .recent-meetings').count(), 0, 'companion hides while choosing the resume file');
    console.log('ok - recovery card resumes the saved analysis');
  } finally {
    await context.close();
  }
};

const runPendingCancellationLockScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    window.localStorage.setItem('pendingAnalysisDraftCleanups', JSON.stringify(['home-pending-cancel-job']));
    window.localStorage.setItem('pendingCancelledAnalysisCleanups', JSON.stringify(['home-pending-cancel-job']));
  });
  const page = await context.newPage();
  let analyzeRequestCount = 0;
  page.on('request', request => {
    if (new URL(request.url()).pathname === '/api/analyze') analyzeRequestCount += 1;
  });
  await installBaseRoutes(page);
  await page.route('**/api/analyze/drafts/home-pending-cancel-job', route => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'analysis_job_active' }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const writerStartButton = page.getByRole('button', { name: '분석 시작', exact: true });
    await writerStartButton.waitFor({ timeout: 10000 });
    // The status row says why; the reason's text stays only as the recovery card's hidden description.
    await page.locator('.writer-action-row[data-state="other-analysis"]').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('#writer-local-engine-requirement .writer-status-title').innerText(), '진행 중인 분석이 있습니다');
    await page.locator('#writer-analysis-start-blocked.sr-only').waitFor({ state: 'attached', timeout: 10000 });
    assert.equal(await writerStartButton.isDisabled(), true);
    assert.equal(await page.locator('.sidebar-create-button').first().isDisabled(), true);

    await putMeeting(page, meetingAt('home-pending-recent', '정리 대기 중 최근 회의', Date.now() - 60 * 1000));
    const recentRow = page.getByRole('region', { name: '최근 회의록' }).getByRole('button', { name: /정리 대기 중 최근 회의/ });
    await recentRow.waitFor({ timeout: 10000 });
    assert.equal(await recentRow.isEnabled(), true);
    await recentRow.click();
    await page.locator('.meeting-detail-shell').getByRole('heading', { name: '정리 대기 중 최근 회의' }).waitFor({ timeout: 10000 });
    assert.equal(analyzeRequestCount, 0);
    console.log('ok - pending cancellation locks analysis but keeps recent meetings open');
  } finally {
    await context.close();
  }
};

const runAnalysisEntryPointScene = async browser => {
  // While an analysis runs, 새 회의록 is disabled and the 분석 중 card is the way back to the progress view.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
      if (url.pathname === '/api/analyze' && String(init?.method || 'GET').toUpperCase() === 'POST') {
        const encoder = new TextEncoder();
        const stream = new ReadableStream({
          start(controller) {
            controller.enqueue(encoder.encode(`event: progress\ndata: ${JSON.stringify({ type: 'progress', progress: 30, status: 'transcribing', message: 'Transcribing chunk 1/4...' })}\n\n`));
          },
        });
        return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
      }
      return originalFetch(input, init);
    };
  });
  const page = await context.newPage();
  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ drafts: [] }) }));
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ recommended_job_id: null, candidates: [] }) }));
  await page.route('**/api/analyze/preflight', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, level: 'ok', reason: 'enough_storage', required_bytes: 1, available_bytes: 1e9, message: 'ok' }) }));
  page.on('dialog', dialog => dialog.accept());
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    await putMeeting(page, meetingAt('entry-point-meeting', '진입점 확인 회의', Date.now() - DAY_MS));
    await page.getByLabel('회의 목적', { exact: true }).fill('분석 중 진입점 확인');
    await page.setInputFiles('#meeting-file-input', { name: 'entry-point.m4a', mimeType: 'audio/mp4', buffer: Buffer.from('entry') });
    await page.getByLabel('회의 제목', { exact: true }).fill('진입점 분석');
    await page.getByRole('button', { name: '분석 시작', exact: true }).click();
    await page.locator('.writer-analysis-panel').waitFor({ timeout: 10000 });
    const navigation = page.locator('.barorok-navigation');
    const createButton = navigation.getByRole('button', { name: '새 회의록', exact: true });
    await page.waitForFunction(() => document.querySelector('.barorok-navigation .sidebar-create-button')?.disabled === true);
    assert.equal(await navigation.getByText('진행 중인 분석 보기', { exact: true }).count(), 0, 'the create button keeps its name during analysis');
    assert.ok(await createButton.getAttribute('aria-describedby'), 'the disabled reason is linked for assistive tech');
    await navigation.getByText('진입점 확인 회의').first().click();
    await page.locator('.meeting-detail-shell').getByRole('heading', { name: '진입점 확인 회의' }).waitFor({ timeout: 10000 });
    await navigation.locator('.sidebar-analysis-card').click();
    await page.locator('.meeting-detail-shell').getByRole('heading', { name: '진입점 분석', level: 2, exact: true }).waitFor({ state: 'visible', timeout: 10000 });
    await page.locator('.meeting-detail-shell .writer-analysis-panel').waitFor({ state: 'visible', timeout: 10000 });
    console.log('ok - analysis keeps 새 회의록 disabled and the 분석 중 card returns to progress');
  } finally {
    await context.close();
  }
};

const runPrivacyNoteWithoutEngineScene = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  await page.route('**/api/**', route => route.abort('connectionrefused'));
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    // The processing promise is fixed copy, so it shows even before (or without) an engine answer.
    const privacyNote = page.getByRole('region', { name: '처리·보관 안내', exact: true });
    await privacyNote.getByRole('heading', { name: '이 PC에서 분석·요약합니다', exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await privacyNote.getByText('영상·음성 파일과 대화록을 외부 AI 서버로 보내지 않습니다.', { exact: true }).count(), 0, 'the approved layout omits the subtitle');
    const promiseOverflow = await privacyNote.evaluate(el => el.scrollHeight - el.clientHeight);
    assert.ok(promiseOverflow <= 1, 'privacy guidance is readable without clipping');
    assert.equal(await privacyNote.evaluate(el => Boolean(el.closest('.writer-work-column'))), true, 'privacy guidance stays beside the file work');
    // The short local-processing promise remains visible without a persistent details action.
    assert.equal(await page.getByText('외부 AI 서비스 없이', { exact: false }).count(), 0);
    assert.equal(await page.locator('.writer-file-support').getByText('이 PC', { exact: false }).count(), 0);
    assert.equal(await privacyNote.getByRole('img').isVisible(), true);
    const headerLayout = await page.evaluate(() => ({
      flowTop: Math.round(document.querySelector('.writer-privacy')?.getBoundingClientRect().top ?? -1),
      startBottom: Math.round(document.querySelector('.writer-start-button')?.getBoundingClientRect().bottom ?? Infinity),
      flowInWorkColumn: Boolean(document.querySelector('.writer-privacy')?.closest('.writer-work-column')),
    }));
    assert.equal(headerLayout.flowInWorkColumn, true);
    assert.ok(headerLayout.flowTop >= headerLayout.startBottom, 'the local-processing promise follows analysis start');
    assert.ok(headerLayout.startBottom <= 720, `analysis start must stay on the first 1280x720 screen (bottom ${headerLayout.startBottom})`);
    const helpTitle = '회의 파일과 대화록은 이 PC 밖으로 나가지 않습니다';
    // The first-visit notice belongs to the web connection build; the default dev UI opens straight to the writer.
    assert.equal(await page.getByRole('dialog', { name: helpTitle }).count(), 0, 'first-visit notice must not open without the connection build flag');

    assert.equal(await privacyNote.getByRole('button', { name: '처리·보관 방식 자세히', exact: true }).count(), 0);
    // The stacked fallback keeps privacy guidance readable without horizontal scrolling.
    await page.setViewportSize({ width: 800, height: 720 });
    assert.equal(await privacyNote.isVisible(), true, 'the promise line stays in a narrow window');
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0);
    await page.setViewportSize({ width: 1280, height: 720 });
    await settleHomePaint(page);
    console.log('ok - new-record home keeps the local processing note without a repeated details link');

    // 참석자·주요 용어 fold beside the 회의 정보 heading: closed by default, so the form keeps its height.
    const optionalToggle = page.getByRole('button', { name: '참석자·주요 용어 (선택)' });
    assert.equal(await optionalToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByLabel('참석자 (선택)').isVisible(), false, 'optional fields start folded');
    const readStartPosition = () => page.evaluate(() => {
      const button = document.querySelector('.writer-start-button');
      const scrollingAncestors = [];
      let parent = button.parentElement;
      while (parent) {
        if (parent.scrollTop) scrollingAncestors.push({ className: parent.className, scrollTop: parent.scrollTop });
        parent = parent.parentElement;
      }
      const bottom = Math.round(button.getBoundingClientRect().bottom);
      return { bottom, scrollingAncestors, contentBottom: bottom + scrollingAncestors.reduce((sum, ancestor) => sum + ancestor.scrollTop, 0) };
    });
    const startPositionFolded = await readStartPosition();
    const startBottomFolded = startPositionFolded.bottom;
    await optionalToggle.click();
    const foldButton = page.getByRole('button', { name: '참석자·주요 용어 접기' });
    assert.equal(await foldButton.getAttribute('aria-expanded'), 'true');
    assert.equal(await page.evaluate(() => Math.round(document.querySelector('.writer-start-button').getBoundingClientRect().bottom)), startBottomFolded, 'expanding optional inputs leaves the work action in place');
    assert.equal(await page.evaluate(() => window.localStorage.getItem('writerOptionalInfoOpen')), '1');
    await page.getByLabel('참석자 (선택)').fill('김수산, 이자원, 박해양');
    const keyTermInput = page.getByLabel('주요 용어 (선택)');
    await keyTermInput.fill('연근해 자원조사');
    await keyTermInput.press('Enter');
    // A comma turns the text before it into a chip; a repeat is not added twice.
    await keyTermInput.fill('수산과학원,연근해 자원조사,체장');
    const chips = page.locator('.writer-term-chip');
    assert.deepEqual(await chips.allTextContents(), ['연근해 자원조사', '수산과학원']);
    assert.equal(await keyTermInput.inputValue(), '체장');
    await keyTermInput.press('Enter');
    assert.deepEqual(await chips.allTextContents(), ['연근해 자원조사', '수산과학원', '체장']);
    // Backspace on an empty box removes the last chip; the x button removes a chosen one.
    await keyTermInput.press('Backspace');
    assert.deepEqual(await chips.allTextContents(), ['연근해 자원조사', '수산과학원']);
    await page.getByRole('button', { name: '연근해 자원조사 용어 삭제' }).click();
    assert.deepEqual(await chips.allTextContents(), ['수산과학원']);
    assert.equal(await page.evaluate(() => document.activeElement?.id), 'meeting-key-terms', 'removing a chip keeps focus in the term box');
    const toggleBox = await page.getByRole('button', { name: '참석자·주요 용어 접기' }).boundingBox();
    assert.ok(toggleBox && toggleBox.height >= 24, `the toggle keeps a 24px target (${toggleBox?.height})`);
    // Folding keeps the values and says what is inside instead of the plain label.
    await foldButton.click();
    const summaryToggle = page.getByRole('button', { name: '참석자 3명 · 용어 1개' });
    assert.equal(await summaryToggle.getAttribute('aria-expanded'), 'false');
    assert.equal(await page.getByRole('button', { name: '참석자·주요 용어 (선택)' }).count(), 0);
    await settleHomePaint(page);
    const startPositionRefolded = await readStartPosition();
    console.log(`optional action position: ${JSON.stringify({ before: startPositionFolded, after: startPositionRefolded })}`);
    assert.equal(startPositionRefolded.contentBottom, startPositionFolded.contentBottom,
      'folding preserves the action layout while allowing browser focus scrolling');
    assert.ok(startBottomFolded <= 720, `analysis start stays on the first 1280x720 screen while folded (${startBottomFolded})`);
    // The open state is remembered for the next visit; typed values are not.
    await summaryToggle.click();
    // Clear the inputs first so the unsaved-input guard does not hold the reload.
    await page.getByLabel('참석자 (선택)').fill('');
    await page.getByRole('button', { name: '수산과학원 용어 삭제' }).click();
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: '참석자·주요 용어 접기' }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByLabel('참석자 (선택)').inputValue(), '');
    assert.equal(await page.locator('.writer-term-chip').count(), 0);
    console.log('ok - new-record home folds optional participants and key terms');
  } finally {
    await context.close();
  }
};

const runEngineDownDeleteScene = async browser => {
  // Without an engine answer the record is deleted at once and its copy on this PC is deleted on the next answer.
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const jobId = 'engine-down-delete-job';
  const blockedJobId = 'engine-down-blocked-job';
  let engineUp = false;
  const deleteRequests = [];
  await page.route('**/api/**', route => {
    const request = route.request();
    const { pathname } = new URL(request.url());
    if (request.method() === 'DELETE' && pathname.startsWith('/api/outputs/')) {
      deleteRequests.push(`${engineUp ? 'answered' : 'refused'} ${decodeURIComponent(pathname.slice('/api/outputs/'.length))}`);
      return engineUp
        ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ deleted: [] }) })
        : route.abort('connectionrefused');
    }
    return route.abort('connectionrefused');
  });
  const dialogs = [];
  page.on('dialog', dialog => {
    dialogs.push({ type: dialog.type(), message: dialog.message() });
    void dialog.accept();
  });
  const waitFor = async (check, label) => {
    for (let attempt = 0; attempt < 300; attempt += 1) {
      if (await check()) return;
      await sleep(50);
    }
    throw new Error(`timed out waiting for ${label}`);
  };
  const pendingCleanups = () => page.evaluate(() => JSON.parse(window.localStorage.getItem('pendingMeetingOutputCleanups') ?? '[]'));
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 10000 });
    await putMeeting(page, { ...meetingAt('engine-down-delete', '엔진 꺼짐 삭제 회의', Date.now() - DAY_MS), jobId });
    await putMeeting(page, { ...meetingAt('engine-down-blocked', '정리 기억 실패 회의', Date.now() - 2 * DAY_MS), jobId: blockedJobId });
    await putMeeting(page, { ...meetingAt('engine-down-keep', '함께 남는 회의', Date.now() - 3 * DAY_MS), jobId: 'engine-down-keep-job' });
    const navigation = page.locator('.barorok-navigation');
    const menuTrigger = title => navigation.locator(`[data-sidebar-record-menu-trigger][aria-label^="${title},"]`);
    const deleteFromMenu = async title => {
      await menuTrigger(title).focus();
      await menuTrigger(title).press('Enter');
      await navigation.locator('[data-sidebar-record-menu]').getByRole('button', { name: '삭제', exact: true }).click();
    };
    await menuTrigger('엔진 꺼짐 삭제 회의').waitFor({ timeout: 10000 });
    assert.deepEqual(await readMeetingIds(page), ['engine-down-blocked', 'engine-down-delete', 'engine-down-keep']);
    assert.deepEqual(await pendingCleanups(), []);

    await deleteFromMenu('엔진 꺼짐 삭제 회의');
    await menuTrigger('엔진 꺼짐 삭제 회의').waitFor({ state: 'detached', timeout: 10000 });
    assert.deepEqual(dialogs.map(dialog => dialog.type), ['confirm'], 'deleting while the engine is off asks nothing more');
    assert.deepEqual(await readMeetingIds(page), ['engine-down-blocked', 'engine-down-keep']);
    assert.deepEqual(await pendingCleanups(), [jobId], 'the copy on this PC waits for the engine');
    assert.ok(deleteRequests.includes(`refused ${jobId}`));
    const toast = page.locator('.operation-toast');
    await toast.getByText(`회의록을 삭제했습니다. 이 PC의 분석 파일은 ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행되면 지웁니다.`, { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.locator('.barorok-navigation .operation-toast').count(), 0, 'the toast is outside the sidebar, above the page');

    // When this browser cannot remember the cleanup, the record stays so its analysis is never orphaned.
    await page.evaluate(() => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function setItemUnlessCleanup(key, value) {
        if (key === 'pendingMeetingOutputCleanups') throw new DOMException('blocked', 'QuotaExceededError');
        return setItem.call(this, key, value);
      };
      window.__restoreSetItem = () => { Storage.prototype.setItem = setItem; };
    });
    await deleteFromMenu('정리 기억 실패 회의');
    await waitFor(() => dialogs.length === 3, 'the storage alert');
    assert.deepEqual(dialogs.map(dialog => dialog.type), ['confirm', 'confirm', 'alert']);
    assert.match(dialogs[2].message, /기억하지 못해 회의록을 삭제하지 않았습니다/);
    assert.deepEqual(await readMeetingIds(page), ['engine-down-blocked', 'engine-down-keep']);
    assert.equal(await menuTrigger('정리 기억 실패 회의').count(), 1);
    assert.deepEqual(await pendingCleanups(), [jobId]);
    await page.evaluate(() => window.__restoreSetItem());

    // A queued job that a record uses again (the same file resumed) leaves the queue without being deleted.
    await page.evaluate(() => {
      const queued = JSON.parse(window.localStorage.getItem('pendingMeetingOutputCleanups') ?? '[]');
      window.localStorage.setItem('pendingMeetingOutputCleanups', JSON.stringify([...queued, 'engine-down-keep-job']));
    });

    // The next answer from the engine deletes the waiting copy without the user doing anything.
    engineUp = true;
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await waitFor(async () => (await pendingCleanups()).length === 0, 'the queued cleanup to finish');
    assert.ok(deleteRequests.includes(`answered ${jobId}`));
    assert.ok(!deleteRequests.includes(`answered ${blockedJobId}`), 'a kept record keeps its analysis');
    assert.ok(!deleteRequests.some(request => request.endsWith('engine-down-keep-job')), 'a job a record uses is never deleted from the queue');
    assert.deepEqual(await readMeetingIds(page), ['engine-down-blocked', 'engine-down-keep']);
    assert.equal(dialogs.length, 3, 'the background cleanup shows no dialog');
    console.log('ok - deleting with the engine off removes the record now and its PC copy on the next answer');
  } finally {
    await context.close();
  }
};

const run = async () => {
  if (process.env.NEW_RECORD_HOME_SCENARIO === 'capture') {
    assert.ok(process.env.APP_URL, 'Capture requires APP_URL pointing to a caller-owned server.');
  }
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  try {
    if (process.env.NEW_RECORD_HOME_SCENARIO === 'capture') {
      await runEmptyHomeCapture(browser);
      return;
    }
    if (process.env.NEW_RECORD_HOME_SCENARIO === 'processing-help') {
      await runPrivacyNoteWithoutEngineScene(browser);
      return;
    }
    if (process.env.NEW_RECORD_HOME_SCENARIO === 'analysis-entry') {
      await runAnalysisEntryPointScene(browser);
      return;
    }
    if (process.env.NEW_RECORD_HOME_SCENARIO === 'term-overflow') {
      await runLongTermScene(browser);
      return;
    }
    if (process.env.NEW_RECORD_HOME_SCENARIO === 'i-layout') {
      await runIHomeLayoutScene(browser);
      return;
    }
    await runEmptyHomeScene(browser);
    await runIHomeLayoutScene(browser);
    await runRecentListScene(browser);
    await runRecoveryScene(browser);
    await runPendingCancellationLockScene(browser);
    await runAnalysisEntryPointScene(browser);
    await runPrivacyNoteWithoutEngineScene(browser);
    await runEngineDownDeleteScene(browser);
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
