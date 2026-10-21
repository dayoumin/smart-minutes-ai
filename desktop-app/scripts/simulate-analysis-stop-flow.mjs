import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';
import { BRAND_NAME, LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/?view=minutes';

const PROCESSING_HELP_TITLE = '회의 파일과 대화록은 이 PC 밖으로 나가지 않습니다';
// Storage wording follows the engine setting and lives in the 처리 방식 help, not on the writer surface.
const openProcessingHelp = async page => {
  await page.locator('.writer-local-promise').getByRole('button', { name: '처리 방식', exact: true }).click();
  const help = page.getByRole('dialog', { name: PROCESSING_HELP_TITLE });
  await help.waitFor({ state: 'visible', timeout: 10000 });
  return help;
};
const closeProcessingHelp = async (page, help) => {
  await page.keyboard.press('Escape');
  await help.waitFor({ state: 'hidden', timeout: 10000 });
};
const shouldStartServer = !process.env.APP_URL;

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

const assertProjectPage = async (page) => {
  const title = await page.title();
  if (title !== BRAND_NAME) {
    throw new Error(`Unexpected app at ${APP_URL}: ${title || '(no title)'}`);
  }
};

const stopServer = async (child) => {
  if (!child || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `taskkill /pid ${child.pid} /t /f`],
        { stdio: 'ignore', windowsHide: true },
      );
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    return;
  }

  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(2000),
  ]);
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
  const command = `corepack pnpm run dev --host ${url.hostname} --port ${url.port} --strictPort --configLoader runner`;
  const child = process.platform === 'win32'
    ? spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', command],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, BROWSER: 'none' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    : spawn(
      'corepack',
      ['pnpm', 'exec', 'vite', '--host', url.hostname, '--port', url.port, '--strictPort', '--configLoader', 'runner'],
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

const createFixtureFile = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-minutes-analysis-stop-'));
  const filePath = join(dir, 'analysis-stop-target.mp4');
  await writeFile(filePath, Buffer.alloc(128, 4));
  const fileStat = await stat(filePath);
  return {
    path: filePath,
    name: 'analysis-stop-target.mp4',
    size: fileStat.size,
    lastModified: Math.trunc(fileStat.mtimeMs),
  };
};

const installBaseRoutes = async (page) => {
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));

  await page.route('**/api/models/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ready: true,
      models: [
        { key: 'stt_faster_whisper', label: '음성 인식 기본 모델', installed: true, required: true },
      ],
    }),
  }));
  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      privacy: { preserve_extracted_audio: false },
    }),
  }));


  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ recommended_job_id: null, candidates: [] }),
  }));

  await page.route('**/api/analyze/preflight', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      level: 'ok',
      reason: 'enough_storage',
      required_bytes: 1024,
      available_bytes: 1024 * 1024,
      message: '저장 공간을 확인했습니다.',
    }),
  }));

  await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
  }));
};

const multipartField = (body, name) => {
  const match = body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([^\\r]+)`));
  return match?.[1] ?? null;
};

const readLocalStorageJson = async (page, key) => page.evaluate(storageKey => {
  const raw = window.localStorage.getItem(storageKey);
  return raw ? JSON.parse(raw) : null;
}, key);

const runScenario = async (
  browser,
  fixture,
  action,
  {
    cancelAccepted = true,
    delayPartialDuringCancel = false,
    completedResultAfterStop = false,
    delayStopDecisionResponse = false,
    keepPendingCancellation = false,
  } = {},
) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  await context.addInitScript(() => {
    const originalCreateElement = document.createElement.bind(document);
    window.__meetingMetadataMedia = [];
    window.__meetingUpdateCount = 0;
    window.__meetingStatusesWritten = [];
    window.addEventListener('meetings:updated', () => {
      window.__meetingUpdateCount += 1;
    });
    const originalPut = IDBObjectStore.prototype.put;
    IDBObjectStore.prototype.put = function put(value, key) {
      if (this.name === 'meetings' && value?.analysisStatus) {
        window.__meetingStatusesWritten.push(value.analysisStatus);
      }
      return key === undefined
        ? originalPut.call(this, value)
        : originalPut.call(this, value, key);
    };
    document.createElement = (tagName, options) => {
      const element = originalCreateElement(tagName, options);
      if (tagName === 'audio' || tagName === 'video') {
        element.__testDuration = Number.NaN;
        Object.defineProperty(element, 'duration', {
          configurable: true,
          get: () => element.__testDuration,
        });
        element.__testSrc = '';
        Object.defineProperty(element, 'src', {
          configurable: true,
          get: () => element.__testSrc,
          set: value => {
            element.__testSrc = value;
          },
        });
        window.__meetingMetadataMedia.push(element);
      }
      return element;
    };
  });
  const page = await context.newPage();
  let releaseAnalyzeResponse = () => {};
  const analyzeCanFinish = new Promise(resolve => {
    releaseAnalyzeResponse = resolve;
  });
  let markAnalyzeStarted = () => {};
  const analyzeStarted = new Promise(resolve => {
    markAnalyzeStarted = resolve;
  });
  let releaseModelStatusResponse = () => {};
  const modelStatusCanFinish = new Promise(resolve => {
    releaseModelStatusResponse = resolve;
  });
  let markModelStatusRequested = () => {};
  const modelStatusRequested = new Promise(resolve => {
    markModelStatusRequested = resolve;
  });
  let analyzeJobId = null;
  let analyzeOptionalFields = null;
  let analyzeRequestCount = 0;
  let cancelRequestCount = 0;
  const cancelRequestBodies = [];
  let markCancelRequested = () => {};
  const cancelRequested = new Promise(resolve => {
    markCancelRequested = resolve;
  });
  let releaseStopDecisionResponse = () => {};
  const stopDecisionCanFinish = new Promise(resolve => {
    releaseStopDecisionResponse = resolve;
  });
  let releasePendingStopMessage = () => {};
  const pendingStopMessageChecked = new Promise(resolve => {
    releasePendingStopMessage = resolve;
  });
  let releasePartialResponse = () => {};
  const partialResponseCanFinish = new Promise(resolve => {
    releasePartialResponse = resolve;
  });
  let markPartialRequested = () => {};
  const partialRequested = new Promise(resolve => {
    markPartialRequested = resolve;
  });

  try {
    await installBaseRoutes(page);
    await page.route(/\/api\/analyze\/drafts\/[^/]+$/, route => route.fulfill({
      status: keepPendingCancellation ? 409 : 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: analyzeJobId, deleted: !keepPendingCancellation }),
    }));

    await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        drafts: analyzeJobId ? [{
          job_id: analyzeJobId,
          status: action === 'stop' && cancelRequestCount > 0 ? 'active' : 'cancelled',
          stage: action === 'stop' && cancelRequestCount > 0 ? 'transcribing' : 'cancelled',
          active: action === 'stop' && cancelRequestCount > 0,
          updated_at: new Date().toISOString(),
          resume_supported: true,
          completed_chunk_count: 1,
          last_progress: {
            message: 'Transcribing chunk 2/4...',
            progress: 42,
            status: 'cancelled',
          },
        }] : [],
      }),
    }));
    await page.route('**/partial-result', async route => {
      markPartialRequested();
      if (delayPartialDuringCancel) await partialResponseCanFinish;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
        job_id: analyzeJobId,
        source_file: fixture.name,
        partial: true,
        summary: '대화록을 저장했습니다. 참석자 구분을 진행하고 있습니다.',
        segments: [{ start: '00:00', end: '00:02', speaker: '', text: '중지 전 저장된 대화록' }],
        display_segments: [{ start: '00:00', end: '00:02', speaker: '', text: '중지 전 저장된 대화록' }],
        diarization_requested: true,
        }),
      });
    });

    await page.route('**/api/analyze', async route => {
      analyzeRequestCount += 1;
      const postData = (await route.request().postDataBuffer()).toString('utf-8');
      analyzeJobId = multipartField(postData, 'job_id');
      analyzeOptionalFields = {
        participants: multipartField(postData, 'participants'),
        termGlossaries: JSON.parse(multipartField(postData, 'term_glossaries') ?? '[]'),
      };
      markAnalyzeStarted();
      if (!delayPartialDuringCancel) await analyzeCanFinish;
      const terminalStatus = action === 'stop' ? 'stopped' : 'cancelled';
      const terminalMessage = action === 'stop'
        ? '분석을 중지했습니다. 같은 파일을 선택하면 이어서 진행할 수 있습니다.'
        : '분석이 취소되었습니다.';
      const body = completedResultAfterStop
        ? [
          'event: progress',
          `data: ${JSON.stringify({ type: 'progress', progress: 70, status: 'diarizing', message: '중지 승인 대기 중 최종 결과 도착', transcript_ready: true })}`,
          '',
          'event: result',
          `data: ${JSON.stringify({
            type: 'result',
            progress: 100,
            status: 'completed',
            summary: '중지 승인 뒤 도착한 완료 결과',
            segments: [{ start: '00:00', end: '00:02', speaker: 'SPEAKER_00', text: '완료 직전 대화록' }],
            meeting: { source_file: fixture.name, job_id: analyzeJobId },
            outputs: { job_id: analyzeJobId },
          })}`,
          '',
          'event: done',
          'data: [DONE]',
          '',
          '',
        ].join('\n')
        : [
          'event: progress',
          `data: ${JSON.stringify({ type: 'progress', progress: 70, status: 'diarizing', message: '참석자 구분 중', transcript_ready: true })}`,
          '',
          `event: ${terminalStatus}`,
          `data: ${JSON.stringify({ type: terminalStatus, action, progress: 42, status: terminalStatus, message: terminalMessage })}`,
          '',
          'event: done',
          'data: [DONE]',
          '',
          '',
        ].join('\n');
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body,
      });
    });

    await page.route(/\/api\/analyze\/[^/]+\/cancel$/, async route => {
      cancelRequestCount += 1;
      cancelRequestBodies.push(JSON.parse(route.request().postData() ?? '{}'));
      markCancelRequested();
      // The pending message lasts only until the decision arrives; an instant rejection replaces it before it can be read.
      await pendingStopMessageChecked;
      if (delayStopDecisionResponse) await stopDecisionCanFinish;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ job_id: analyzeJobId, action, cancel_requested: cancelAccepted }),
      });
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await assertProjectPage(page);
    const writerSectionHeadings = await page.locator('.writer-section-heading h3').allTextContents();
    assert.deepEqual(writerSectionHeadings.slice(0, 2), ['영상·음성 파일', '회의 정보']);
    const processingHelp = await openProcessingHelp(page);
    await processingHelp.getByText('회의록은 이 PC에만 보관하고, 분석용 임시 음성은 완료 후 삭제합니다.', { exact: true }).waitFor({ timeout: 10000 });
    await closeProcessingHelp(page, processingHelp);
    const titleInput = page.getByLabel('회의 제목', { exact: true });
    await page.getByLabel('회의 목적', { exact: true }).fill('분석 중 중지와 취소 동작 확인');
    // Optional inputs: participants as typed text, key terms as chips (one left typed to prove it still counts).
    await page.getByRole('button', { name: '참석자·주요 용어 (선택)' }).click();
    await page.getByLabel('참석자 (선택)').fill('김수산, 이자원');
    const keyTermInput = page.getByLabel('주요 용어 (선택)');
    await keyTermInput.fill('연근해 자원조사');
    await keyTermInput.press('Enter');
    await keyTermInput.fill('수산과학원');
    const fileChooserPromise = page.waitForEvent('filechooser');
    await page.getByRole('button', { name: /영상 또는 음성 파일 선택/ }).press('Enter');
    const fileChooser = await fileChooserPromise;
    await fileChooser.setFiles(fixture.path);
    assert.equal(await titleInput.inputValue(), fixture.name.replace(/\.[^.]+$/, ''), 'filename should fill an empty meeting title');
    await page.setInputFiles('#meeting-file-input', {
      name: '지원하지-않는-파일.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('not media'),
    });
    await page.getByText('지원하지 않는 형식이라 기존 파일을 유지했습니다. 지원하는 음성 파일을 선택해 주세요.').waitFor({ timeout: 10000 });
    assert.equal(await titleInput.inputValue(), fixture.name.replace(/\.[^.]+$/, ''), 'an invalid replacement should preserve the current title');
    await page.getByText(fixture.name, { exact: true }).waitFor({ timeout: 10000 });
    await page.setInputFiles('#meeting-file-input', {
      name: '교체한 회의.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('replacement audio'),
    });
    assert.equal(await titleInput.inputValue(), '교체한 회의', 'replacing a file should refresh an auto-filled title');

    await page.setInputFiles('#meeting-file-input', {
      name: '이전 메타데이터.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('older metadata'),
    });
    await page.setInputFiles('#meeting-file-input', {
      name: '최신 메타데이터.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('latest metadata'),
    });
    await page.evaluate(() => {
      const [olderMedia, latestMedia] = window.__meetingMetadataMedia.slice(-2);
      latestMedia.__testDuration = 222;
      latestMedia.onloadedmetadata?.();
      olderMedia.__testDuration = 111;
      olderMedia.onloadedmetadata?.();
    });
    const selectedFileCard = page.locator('.selected-file-card');
    await selectedFileCard.getByText(/3분 42초/).waitFor({ timeout: 10000 });
    assert.equal(await selectedFileCard.getByText(/1분 51초/).count(), 0, 'stale metadata must not replace the latest duration');
    await page.setInputFiles('#meeting-file-input', {
      name: '잘못된-메타데이터-교체.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('invalid metadata replacement'),
    });
    await selectedFileCard.getByText(/3분 42초/).waitFor({ timeout: 10000 });

    await page.getByRole('button', { name: '최신 메타데이터.mp3 제거' }).click();
    assert.equal(await titleInput.inputValue(), '', 'removing a file should clear an auto-filled title');

    const dropZone = page.getByRole('button', { name: /영상 또는 음성 파일 선택/ });
    const dataTransfer = await page.evaluateHandle(() => {
      const transfer = new DataTransfer();
      transfer.items.add(new File(['drop audio'], '드롭한 회의.mp3', { type: 'audio/mpeg' }));
      return transfer;
    });
    await dropZone.dispatchEvent('dragenter', { dataTransfer });
    await page.waitForFunction(() => document.querySelector('.file-drop-zone')?.classList.contains('file-drop-zone-active'));
    await dropZone.dispatchEvent('drop', { dataTransfer });
    await dataTransfer.dispose();
    await page.getByText('드롭한 회의.mp3', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await titleInput.inputValue(), '드롭한 회의', 'dropping a file should update an auto-filled title');
    await page.getByRole('button', { name: '드롭한 회의.mp3 제거' }).click();

    await page.setInputFiles('#meeting-file-input', {
      name: '교체한 회의.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('replacement audio'),
    });
    await titleInput.fill(`${action} 분석 중지 테스트`);
    await page.getByRole('button', { name: '교체한 회의.mp3 제거' }).click();
    assert.equal(await titleInput.inputValue(), `${action} 분석 중지 테스트`, 'removing a file should preserve a user-edited title');
    await page.setInputFiles('#meeting-file-input', fixture.path);
    assert.equal(await titleInput.inputValue(), `${action} 분석 중지 테스트`, 'replacing a file should preserve a user-edited title');
    await page.unroute('**/api/models/status');
    await page.route('**/api/models/status', async route => {
      markModelStatusRequested();
      await modelStatusCanFinish;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          ready: true,
          models: [
            { key: 'stt_faster_whisper', label: '음성 인식 기본 모델', installed: true, required: true },
          ],
        }),
      });
    });

    await page.getByRole('button', { name: '분석 시작' }).click();
    await modelStatusRequested;
    const analysisPanel = page.locator('.writer-analysis-panel');
    await analysisPanel.waitFor({ timeout: 10000 });
    await page.getByRole('heading', { name: `${action} 분석 중지 테스트`, exact: true }).waitFor({ timeout: 10000 });
    assert.notEqual((await analysisPanel.innerText()).trim(), '', 'analysis panel should show the current step before model status responds');
    assert.equal(analyzeJobId, null, 'analysis request should wait for model status');
    releaseModelStatusResponse();
    await analyzeStarted;
    // The analysis request carries both optional inputs; key terms travel as the reserved per-meeting glossary.
    assert.equal(analyzeOptionalFields.participants, '김수산, 이자원');
    assert.equal(analyzeOptionalFields.termGlossaries.length, 1);
    assert.equal(analyzeOptionalFields.termGlossaries[0].id, 'meeting-key-terms');
    assert.deepEqual(analyzeOptionalFields.termGlossaries[0].entries.map(entry => entry.canonical), ['연근해 자원조사', '수산과학원']);
    const runningDraft = (await readLocalStorageJson(page, 'analysisResumeDrafts') ?? []).find(draft => draft.jobId === analyzeJobId);
    assert.equal(runningDraft?.participants, '김수산, 이자원', 'the resume draft keeps participants');
    assert.deepEqual(runningDraft?.termGlossaries?.[0]?.entries?.map(entry => entry.canonical), ['연근해 자원조사', '수산과학원']);
    if (delayPartialDuringCancel) await partialRequested;
    const stopMenuButton = page.getByRole('button', { name: '중지/취소' });
    await stopMenuButton.waitFor({ timeout: 10000 });
    // The shared detail owns the meeting identity; the old progress file row stays hidden.
    const localNote = analysisPanel.locator('.writer-analysis-local-note');
    assert.equal(await localNote.isVisible(), false, 'the shared detail does not add a second footer');
    assert.equal(await page.locator('.writer-local-promise').count(), 0, 'the title promise belongs to the input screen');
    const progressLayout = await page.evaluate(() => {
      const panel = document.querySelector('.writer-analysis-panel');
      const stopButton = panel?.querySelector('button[aria-label="중지/취소"]');
      return {
        panelBottom: panel?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
        stopButtonBottom: stopButton?.getBoundingClientRect().bottom ?? Number.POSITIVE_INFINITY,
        viewportHeight: window.innerHeight,
        overflowX: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.equal(progressLayout.overflowX, 0, 'analysis progress should not create horizontal overflow');
    assert.ok(progressLayout.panelBottom <= progressLayout.viewportHeight, 'analysis panel should fit within the 1280x720 viewport');
    assert.ok(progressLayout.stopButtonBottom <= progressLayout.viewportHeight, 'stop action should remain visible at 1280x720');
    await stopMenuButton.click();
    await page.getByText('분석을 어떻게 처리할까요?').waitFor({ timeout: 10000 });
    await page.locator('.analysis-stop-panel').getByText('취소하면 이번 분석의 임시 대화록은 삭제합니다. 완료·중지·실패한 회의록, 본문을 수정·확정한 대화록과 정리 결과는 남깁니다.', { exact: false }).waitFor({ timeout: 10000 });

    if (action === 'stop') {
      await page.locator('.analysis-stop-panel').getByRole('button', { name: '이어하기 기록을 남기고 분석 중지' }).click();
      await page.getByRole('main').getByText('현재 처리 중인 구간이 끝나면 이어하기 기록으로 남깁니다.').waitFor({ timeout: 10000 });
    } else {
      await page.locator('.analysis-stop-panel').getByRole('button', { name: '진행 중 기록을 끝내고 분석 취소' }).click();
      await page.getByRole('main').getByText('현재 처리 중인 구간이 끝나면 진행 중 기록을 끝냅니다.').waitFor({ timeout: 10000 });
    }
    releasePendingStopMessage();

    await cancelRequested;
    assert.equal(cancelRequestCount, 1);
    assert.deepEqual(cancelRequestBodies, [{ action }]);
    if (delayPartialDuringCancel) releasePartialResponse();
    if (delayStopDecisionResponse) {
      releaseAnalyzeResponse();
      await page.waitForFunction(() => window.__meetingUpdateCount >= 1, undefined, { timeout: 10000 });
      assert.equal(await page.locator('.meeting-analysis-summary').getByText('분석 완료', { exact: true }).count(), 0);
      releaseStopDecisionResponse();
    }
    if (!cancelAccepted) {
      await page.getByRole('status').getByText('중지할 분석을 찾지 못했습니다.', { exact: true }).waitFor({ timeout: 10000 });
      await page.locator('.analysis-stop-panel').waitFor({ state: 'detached' });
      if (!completedResultAfterStop) {
        await stopMenuButton.waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll('button')).some(
          button => button.getAttribute('aria-label') === '중지/취소' && !button.disabled,
        )), true);
      }
      const rejectedStopDrafts = await readLocalStorageJson(page, 'analysisResumeDrafts') ?? [];
      assert.equal(
        rejectedStopDrafts.some(draft => draft.status === 'stopped'),
        false,
        'a rejected stop request must not create a stopped resume draft',
      );
      releaseAnalyzeResponse();
      if (completedResultAfterStop) {
        await page.locator('.meeting-analysis-summary').getByText('분석 완료', { exact: true }).waitFor({ timeout: 10000 });
        const completedMeetings = await page.evaluate(() => new Promise((resolve, reject) => {
          const request = indexedDB.open('MeetingHistoryDB');
          request.onerror = () => reject(request.error);
          request.onsuccess = () => {
            const db = request.result;
            const getAllRequest = db.transaction('meetings', 'readonly').objectStore('meetings').getAll();
            getAllRequest.onerror = () => reject(getAllRequest.error);
            getAllRequest.onsuccess = () => resolve(getAllRequest.result);
          };
        }));
        assert.equal(completedMeetings.length, 1);
        assert.equal(completedMeetings[0].analysisStatus, 'completed');
      }
      console.log(`ok - analysis ${action} rejected request recovery simulation`);
      return;
    }
    if (action === 'stop') {
      await page.waitForFunction(() => {
        const raw = window.localStorage.getItem('analysisResumeDrafts');
        const drafts = raw ? JSON.parse(raw) : [];
        return drafts.some(draft => draft.status === 'stopped');
      });
      const draftsBeforeFinalCancel = await readLocalStorageJson(page, 'analysisResumeDrafts');
      assert.equal(draftsBeforeFinalCancel.length, 1);
      assert.equal(draftsBeforeFinalCancel[0].status, 'stopped');
    }
    releaseAnalyzeResponse();

    if (action === 'cancel' && keepPendingCancellation) {
      await page.getByText('분석을 취소했습니다.').waitFor({ timeout: 10000 });
      const restartButton = page.getByRole('button', { name: '분석 시작', exact: true });
      await restartButton.waitFor({ state: 'visible', timeout: 10000 });
      assert.equal(await restartButton.isDisabled(), true, 'pending cancellation must keep analysis start disabled');
      await restartButton.evaluate(button => button.click());
      await page.waitForTimeout(100);
      assert.equal(analyzeRequestCount, 1, 'pending cancellation must prevent a second analyze request');
      assert.deepEqual(await readLocalStorageJson(page, 'pendingCancelledAnalysisCleanups'), [analyzeJobId]);
      console.log('ok - pending cancellation transition keeps writer locked');
      return;
    }

    if (action === 'stop') {
      await page.getByText('분석을 중지했습니다. 같은 파일을 선택하면 이어서 진행할 수 있습니다.').waitFor({ timeout: 10000 });
      const drafts = await readLocalStorageJson(page, 'analysisResumeDrafts');
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].status, 'stopped');
      assert.equal(drafts[0].jobId, analyzeJobId);
      assert.equal(await page.locator('.meeting-analysis-summary').getByText('분석 완료', { exact: true }).count(), 0, 'accepted stop must not claim completion');
      assert.equal(
        (await page.evaluate(() => window.__meetingStatusesWritten)).includes('completed'),
        false,
        'an accepted stop must prevent any completed meeting write',
      );
    } else {
      await page.getByText('분석을 취소했습니다.').waitFor({ timeout: 10000 });
      assert.deepEqual(await readLocalStorageJson(page, 'analysisResumeDrafts'), []);
      await page.waitForFunction(() => {
        const pending = JSON.parse(window.localStorage.getItem('pendingAnalysisDraftCleanups') ?? '[]');
        const cancelled = JSON.parse(window.localStorage.getItem('pendingCancelledAnalysisCleanups') ?? '[]');
        return pending.length === 0 && cancelled.length === 0;
      }, undefined, { timeout: 10000 });
      assert.deepEqual(await readLocalStorageJson(page, 'pendingAnalysisDraftCleanups'), []);
      assert.deepEqual(await readLocalStorageJson(page, 'pendingCancelledAnalysisCleanups'), []);
      assert.deepEqual(
        await readLocalStorageJson(page, 'suppressedResumeCandidateKeys'),
        [`${fixture.name}::${fixture.size}::${fixture.lastModified}`],
      );
    }

    const meetings = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('MeetingHistoryDB');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const getAllRequest = db.transaction('meetings', 'readonly').objectStore('meetings').getAll();
        getAllRequest.onerror = () => reject(getAllRequest.error);
        getAllRequest.onsuccess = () => resolve(getAllRequest.result);
      };
    }));
    if (action === 'stop') {
      assert.equal(meetings.length, 1, 'stopping after transcript readiness should retain one meeting');
      assert.equal(meetings[0].jobId, analyzeJobId);
      assert.equal(meetings[0].analysisStatus, 'diarization_stopped');
      page.once('dialog', dialog => dialog.accept());
      await page.getByRole('button', { name: `${action} 분석 중지 테스트`, exact: true }).click();
      await page.getByText('중지 전 저장된 대화록', { exact: true }).waitFor({ timeout: 10000 });
      await page.getByText('중지됨', { exact: true }).first().waitFor({ timeout: 10000 });
    } else {
      assert.equal(meetings.length, 0, 'explicit cancellation should remove the intermediate meeting');
    }

    console.log(`ok - analysis ${action} flow simulation`);
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
};

const runFailureScenario = async (browser, fixture) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  let analyzeAttempt = 0;

  try {
    await installBaseRoutes(page);
    await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ drafts: [] }),
    }));
    await page.route('**/api/analyze', route => {
      analyzeAttempt += 1;
      const body = analyzeAttempt < 3
        ? [
            'event: progress',
            'data: {"type":"progress","progress":34,"status":"transcribing","message":"Transcribing chunk 1/3..."}',
            '',
            'event: error',
            'data: {"type":"error","progress":34,"status":"error","message":"테스트 분석 오류가 발생했습니다."}',
            '',
            'event: done',
            'data: [DONE]',
            '',
            '',
          ].join('\n')
        : [
            'event: result',
            `data: ${JSON.stringify({
              type: 'result',
              progress: 100,
              status: 'completed',
              summary: '',
              segments: [],
              meeting: { source_file: fixture.name, job_id: 'failure-retry-job' },
              outputs: {
                job_id: 'failure-retry-job',
                json: '/api/outputs/failure-retry-job/json',
                txt: '/api/outputs/failure-retry-job/txt',
                md: null,
                docx: null,
                hwpx: null,
              },
            })}`,
            '',
            'event: done',
            'data: [DONE]',
            '',
            '',
          ].join('\n');
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body,
      });
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await assertProjectPage(page);
    await page.getByLabel('회의 목적', { exact: true }).fill('분석 실패 후 복구 화면 확인');
    await page.setInputFiles('#meeting-file-input', fixture.path);
    const originalTitle = await page.getByLabel('회의 제목', { exact: true }).inputValue();
    await page.getByRole('button', { name: '분석 시작' }).click();

    await page.locator('.writer-analysis-panel-error').waitFor({ timeout: 10000 });
    const failurePanel = page.locator('.writer-analysis-panel-error');
    await failurePanel.getByText('테스트 분석 오류가 발생했습니다.', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await failurePanel.locator('.writer-analysis-local-note').count(), 0, 'a failed run does not say it is still analyzing');
    assert.equal(await page.locator('.resume-drafts-panel').count(), 0, 'resume draft lists belong only in the sidebar');
    await failurePanel.getByRole('button', { name: '다시 시도' }).waitFor({ timeout: 10000 });
    await failurePanel.getByRole('button', { name: '입력 확인' }).click();

    await page.getByRole('heading', { name: '새 회의록' }).waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.id === 'meeting-title');
    assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), originalTitle, 'failure recovery should preserve the title');
    await page.locator('.selected-file-card').getByText(fixture.name, { exact: true }).waitFor({ timeout: 10000 });
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflowX, 0, 'failure state should not create horizontal overflow');

    await page.getByRole('button', { name: '분석 시작' }).click();
    await page.locator('.writer-analysis-panel-error').waitFor({ timeout: 10000 });
    await page.locator('.writer-analysis-panel-error').getByRole('button', { name: '다시 시도' }).click();
    await page.locator('.meeting-analysis-summary').getByText('분석 완료', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('heading', { name: originalTitle, exact: true }).waitFor({ timeout: 10000 });
    assert.equal(analyzeAttempt, 3, 'retry should start one new analysis request');
    assert.equal(await page.getByLabel('회의 제목', { exact: true }).count(), 0, 'retry completion should replace the input form');

    console.log('ok - analysis failure recovery simulation');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
};

// Admission is not a takeover of the previous job. Both ACK/terminal orders must
// leave its browser record and local resume progress untouched (API is mocked).
const runAdmissionScenario = async (browser, fixture, action, { terminalFirst = false, existing = true, missingTerminal = false } = {}) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const draft = {
    jobId: 'admission-existing-job', title: '이전 진행분 보존', date: '2026-10-18T09:30',
    meetingPurpose: '인수 전 중지 검사', participants: '', sourceFilename: fixture.name,
    sourceSize: fixture.size, sourceLastModified: fixture.lastModified, status: 'stopped', stage: 'stopped',
    completedChunkCount: 2, lastProgress: 42, lastMessage: 'Transcribing chunk 2/4...',
    resumeEligible: true, createdAt: '2026-10-18T00:30:00.000Z', updatedAt: '2026-10-18T00:35:00.000Z',
  };
  await context.addInitScript(({ draft, existing }) => {
    if (existing) localStorage.setItem('analysisResumeDrafts', JSON.stringify([draft]));
  }, { draft, existing });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  let analyzeJobId;
  let deletes = 0;
  let markAnalyze;
  const analyzeStarted = new Promise(resolve => { markAnalyze = resolve; });
  let releaseAnalyze;
  const analyzeCanFinish = new Promise(resolve => { releaseAnalyze = resolve; });
  let markCancel;
  const cancelRequested = new Promise(resolve => { markCancel = resolve; });
  let releaseAck;
  const ackCanFinish = new Promise(resolve => { releaseAck = resolve; });
  let markTerminal;
  const terminalSent = new Promise(resolve => { markTerminal = resolve; });
  const readMeetings = () => page.evaluate(() => new Promise((resolve, reject) => {
    const open = indexedDB.open('MeetingHistoryDB');
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction('meetings', 'readonly');
      const get = tx.objectStore('meetings').getAll();
      get.onsuccess = () => resolve(get.result);
      get.onerror = () => reject(get.error);
      tx.oncomplete = () => db.close();
    };
  }));
  try {
    await installBaseRoutes(page);
    await page.route('**/api/analyze/draft-statuses', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ drafts: existing ? [{
      job_id: draft.jobId, status: 'stopped', stage: 'stopped', resume_supported: true, active: false,
      completed_chunk_count: 2, last_progress: { progress: 42, message: draft.lastMessage, status: 'stopped' },
    }] : [] }) }));
    await page.route('**/api/analyze/resume-candidates', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
      recommended_job_id: existing ? draft.jobId : null,
      candidates: existing ? [{ job_id: draft.jobId, stage: 'stopped', active: false, resume_supported: true, chunk_count: 4, completed_chunk_count: 2 }] : [],
    }) }));
    await page.route(/\/api\/analyze\/drafts\/[^/]+$/, route => {
      deletes += 1;
      return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/analyze', async route => {
      analyzeJobId = multipartField(route.request().postDataBuffer().toString('utf8'), 'job_id');
      markAnalyze();
      await analyzeCanFinish;
      const status = action === 'stop' ? 'stopped' : 'cancelled';
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: missingTerminal ? '' : [
        `event: ${status}`,
        `data: ${JSON.stringify({ type: status, status, action, preserve_existing: true, progress: 0, eta_seconds: null, message: '분석 요청을 중단했습니다.' })}`,
        '', 'event: done', 'data: [DONE]', '', '',
      ].join('\n') });
      markTerminal();
    });
    await page.route(/\/api\/analyze\/[^/]+\/cancel$/, async route => {
      markCancel();
      if (terminalFirst) await ackCanFinish;
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
        job_id: analyzeJobId, action, cancel_requested: true, preserve_existing: true,
      }) });
    });
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await assertProjectPage(page);
    if (existing) {
      await page.evaluate(record => new Promise((resolve, reject) => {
        const open = indexedDB.open('MeetingHistoryDB');
        open.onerror = () => reject(open.error);
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction('meetings', 'readwrite');
          tx.objectStore('meetings').put(record);
          tx.oncomplete = () => { db.close(); resolve(); };
          tx.onerror = () => reject(tx.error);
        };
      }), { id: draft.jobId, jobId: draft.jobId, title: draft.title, date: draft.date, participants: '',
        summary: '이전 요약 보존', segments: [{ start: '00:00', end: '00:02', speaker: 'SPEAKER_00', text: '이전 대화록 보존' }],
        speakerLabels: { SPEAKER_00: '기존 참석자' }, analysisStatus: 'diarization_stopped', createdAt: draft.createdAt, updatedAt: draft.updatedAt });
      await page.getByRole('button', { name: /이어서 할 분석 1건/ }).click();
      await page.locator('.sidebar-resume-draft-button').filter({ hasText: draft.title }).click();
      await page.getByRole('heading', { name: '이어하기', exact: true }).waitFor();
    } else {
      await page.locator('#meeting-title').fill('인수 전 새 분석 취소');
      await page.locator('#meeting-purpose').fill('인수 전 중지 검사');
    }
    await page.setInputFiles('#meeting-file-input', fixture.path);
    await page.waitForFunction(() => {
      const button = document.querySelector('.writer-start-button');
      return Boolean(button && button.getAttribute('aria-disabled') !== 'true');
    });
    const beforeDrafts = await readLocalStorageJson(page, 'analysisResumeDrafts') ?? [];
    const beforeMeetings = await readMeetings();
    await page.locator('.writer-start-button').click();
    await analyzeStarted;
    if (existing) assert.equal(analyzeJobId, draft.jobId);
    await page.getByRole('button', { name: '중지/취소', exact: true }).click();
    await page.locator('.analysis-stop-panel').getByRole('button', { name: action === 'stop'
      ? '이어하기 기록을 남기고 분석 중지' : '진행 중 기록을 끝내고 분석 취소' }).click();
    await cancelRequested;
    if (terminalFirst) {
      releaseAnalyze();
      await terminalSent;
      assert.equal(deletes, 0, 'terminal must not release cleanup ownership before ACK');
      releaseAck();
    } else {
      await page.waitForFunction(({ jobId, existing }) => {
        const drafts = JSON.parse(localStorage.getItem('analysisResumeDrafts') || '[]');
        const pending = JSON.parse(localStorage.getItem('pendingCancelledAnalysisCleanups') || '[]');
        return !pending.includes(jobId) && (existing ? drafts.some(d => d.jobId === jobId && d.status === 'stopped' && d.lastProgress === 42) : drafts.length === 0);
      }, { jobId: analyzeJobId, existing });
      assert.equal(deletes, 0);
      assert.deepEqual(await readMeetings(), beforeMeetings, 'ACK must preserve the previous meeting before terminal');
      releaseAnalyze();
    }
    if (missingTerminal) {
      await page.locator('.writer-analysis-panel-error').waitFor();
      await page.getByRole('button', { name: '입력 확인', exact: true }).click();
    } else {
      await page.getByRole('status').getByText(action === 'stop'
        ? '분석을 중지했습니다. 같은 파일을 선택하면 이어서 진행할 수 있습니다.' : '분석을 취소했습니다.', { exact: true }).waitFor();
    }
    await page.locator('.writer-start-button').waitFor({ state: 'visible' });
    assert.deepEqual(await readLocalStorageJson(page, 'analysisResumeDrafts') ?? [], beforeDrafts);
    assert.deepEqual(await readMeetings(), beforeMeetings);
    for (const key of ['pendingAnalysisDraftCleanups', 'pendingCancelledAnalysisCleanups', 'suppressedResumeCandidateKeys']) {
      assert.deepEqual(await readLocalStorageJson(page, key) ?? [], [], `${key} must not retain admission cancellation`);
    }
    assert.equal(deletes, 0);
    assert.deepEqual(errors, []);
    console.log(`ok - admission ${action} preserves ${existing ? 'existing data' : 'empty initial state'} (${missingTerminal ? 'ACK then EOF' : terminalFirst ? 'terminal first' : 'ACK first'}, mocked API)`);
  } finally {
    releaseAnalyze();
    releaseAck();
    await context.close();
  }
};

const sseBody = events => [
  ...events.flatMap(({ event, data }) => [`event: ${event}`, `data: ${JSON.stringify(data)}`, '']),
  'event: done',
  'data: [DONE]',
  '',
  '',
].join('\n');

const errorEvent = (message, code) => ({
  event: 'error',
  data: { type: 'error', progress: 34, status: 'error', message, ...(code ? { code } : {}) },
});

const MEMORY_MESSAGE = '이 PC의 메모리가 부족합니다. 다른 프로그램을 닫은 뒤 다시 시도해 주세요.';

// Each cause leads with its own next step, and raw engine text never reaches the card (WR-5, WR-3).
const FAILURE_CAUSES = [
  {
    name: 'memory',
    events: [errorEvent('CUDA failed with error out of memory', 'insufficient_memory')],
    message: MEMORY_MESSAGE,
    primary: '다시 시도',
  },
  {
    name: 'disk-space',
    events: [errorEvent('[Errno 28] No space left on device', 'insufficient_storage')],
    message: '저장 공간이 부족합니다. 파일을 정리해 공간을 확보한 뒤 다시 시도해 주세요.',
    primary: '다시 시도',
  },
  {
    name: 'unsupported-file',
    events: [errorEvent('ffmpeg conversion failed: Invalid data found when processing input', 'unsupported_media')],
    message: '이 파일은 읽을 수 없습니다. 재생되는 음성·영상 파일을 선택해 주세요.',
    primary: '다른 파일 선택',
  },
  {
    name: 'older-engine-without-code',
    events: [errorEvent('RuntimeError: CUDA out of memory. Tried to allocate 2.00 GiB')],
    message: MEMORY_MESSAGE,
    primary: '다시 시도',
  },
  {
    // On the GPU, running out of memory again is the likely result of a retry: 분석 장치 (CPU) leads.
    name: 'gpu-memory',
    gpuSelected: true,
    events: [errorEvent('CUDA failed with error out of memory', 'insufficient_memory')],
    message: 'GPU 메모리가 부족해 분석을 마치지 못했습니다.',
    primary: '분석 장치 설정',
  },
  {
    name: 'gpu-selected-host-memory',
    gpuSelected: true,
    events: [errorEvent('std::bad_alloc', 'insufficient_memory')],
    message: MEMORY_MESSAGE,
    primary: '다시 시도',
  },
  {
    name: 'gpu-runtime',
    gpuSelected: true,
    events: [errorEvent('Failed to load faster-whisper model: Library cublas64_12.dll is not found or cannot be loaded', 'gpu_unavailable')],
    message: 'GPU로 분석하지 못했습니다. 설정에서 분석 장치를 CPU로 바꾸면 분석할 수 있습니다.',
    primary: '분석 장치 설정',
  },
  {
    name: 'engine-disconnected',
    abortAnalyze: true,
    message: `이 PC의 분석 기능에 연결하지 못했습니다. ${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인한 뒤 다시 시도해 주세요.`,
    primary: '다시 확인',
  },
  ...[false, true].map(gpuSelected => ({
    name: gpuSelected ? 'transcript-saved-gpu' : 'transcript-saved',
    gpuSelected,
    events: [
      { event: 'progress', data: { type: 'progress', progress: 70, status: 'diarizing', message: '참석자 구분 중', transcript_ready: true } },
      errorEvent('CUDA failed with error out of memory', 'insufficient_memory'),
    ],
    message: '대화록은 저장했습니다. 메모리가 부족해 참석자 구분을 마치지 못했습니다.',
    primary: '결과 보기',
  })),
];

const runFailureCauseScenarios = async (browser, fixture) => {
  for (const scenario of FAILURE_CAUSES) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    try {
      await installBaseRoutes(page);
      if (scenario.gpuSelected) {
        await page.route('**/api/models/status', route => route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            ready: true,
            models: [{ key: 'stt_faster_whisper', label: '음성 인식 기본 모델', installed: true, required: true }],
            selected_stt_device: 'cuda',
            stt_device_status: { gpu_detected: true, gpu_usable: true },
          }),
        }));
        await page.route('**/api/settings', route => route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({ stt: { device: 'cuda' }, privacy: { preserve_extracted_audio: false } }),
        }));
      }
      await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ drafts: [] }),
      }));
      let analyzeJobId = null;
      await page.route('**/partial-result', route => route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job_id: analyzeJobId,
          source_file: fixture.name,
          partial: true,
          segments: [{ start: '00:00', end: '00:02', speaker: '', text: '실패 전 저장된 대화록' }],
          display_segments: [{ start: '00:00', end: '00:02', speaker: '', text: '실패 전 저장된 대화록' }],
          diarization_requested: true,
        }),
      }));
      await page.route('**/api/analyze', async route => {
        if (scenario.abortAnalyze) return route.abort('connectionrefused');
        analyzeJobId = multipartField((await route.request().postDataBuffer()).toString('utf-8'), 'job_id');
        return route.fulfill({ status: 200, contentType: 'text/event-stream', body: sseBody(scenario.events) });
      });

      await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
      await assertProjectPage(page);
      await page.getByLabel('회의 목적', { exact: true }).fill(`원인별 실패 확인: ${scenario.name}`);
      await page.setInputFiles('#meeting-file-input', fixture.path);
      const meetingTitle = await page.getByLabel('회의 제목', { exact: true }).inputValue();
      await page.getByRole('button', { name: '분석 시작' }).click();

      await page.locator('.writer-analysis-panel-error').waitFor({ timeout: 10000 });
      const failurePanel = page.locator('.writer-analysis-panel-error');
      await failurePanel.getByText(scenario.message, { exact: true }).waitFor({ timeout: 10000 });
      const panelText = await failurePanel.innerText();
      assert.doesNotMatch(panelText, /CUDA|Errno|ffmpeg|Failed to fetch|RuntimeError/, `${scenario.name}: raw engine text must not reach the card`);
      const firstAction = failurePanel.locator('.writer-analysis-result-actions button').first();
      assert.equal((await firstAction.innerText()).trim(), scenario.primary, `${scenario.name}: primary action follows the cause`);
      assert.match(await firstAction.getAttribute('class'), /btn-primary/, `${scenario.name}: the cause's action is the primary button`);
      assert.equal(await failurePanel.locator('.writer-analysis-result-actions .btn-primary').count(), 1, `${scenario.name}: one primary action`);

      if (scenario.name === 'memory') {
        // A readiness pass (window focus) must not dismiss the card the user still has to act on.
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await page.waitForTimeout(1500);
        assert.equal(await failurePanel.getByText(scenario.message, { exact: true }).isVisible(), true, 'focus keeps the failure card');
      }
      if (scenario.name.startsWith('transcript-saved')) {
        assert.equal(await failurePanel.getByRole('button', { name: '다시 시도' }).count(), 0, 'with the transcript saved, rerunning the analysis is not offered');
        await firstAction.click();
        await page.locator('.meeting-detail-title').getByText(meetingTitle, { exact: true }).waitFor({ timeout: 10000 });
        await page.getByText('실패 전 저장된 대화록', { exact: true }).waitFor({ timeout: 10000 });
      } else if (scenario.name === 'unsupported-file') {
        const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 5000 }), firstAction.click()]);
        assert.ok(chooser, 'another file can be chosen right away');
        await page.getByRole('heading', { name: '새 회의록' }).waitFor({ timeout: 10000 });
        assert.equal(await page.locator('.selected-file-card').count(), 0, 'the unreadable file is no longer selected');
        assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), meetingTitle, 'the other inputs are kept');
      } else if (scenario.name === 'gpu-memory') {
        await failurePanel.getByText('분석 장치를 CPU로 바꾸면', { exact: false }).waitFor({ timeout: 5000 });
        assert.equal(await failurePanel.getByRole('button', { name: '다시 시도' }).count(), 1, 'a retry stays available as the secondary action');
        await firstAction.click();
        await page.getByRole('dialog', { name: '설정' }).waitFor({ timeout: 10000 });
        await page.waitForFunction(() => document.activeElement?.closest('#settings-analysis-device') !== null, undefined, { timeout: 10000 });
      } else if (scenario.name === 'engine-disconnected') {
        await firstAction.click();
        await page.getByRole('heading', { name: '새 회의록' }).waitFor({ timeout: 10000 });
        assert.equal(await page.getByRole('button', { name: '분석 시작' }).isEnabled(), true, 'once the engine answers, 분석 시작 is ready again');
      }
      console.log(`ok - analysis failure cause: ${scenario.name}`);
    } catch (error) {
      console.error(`failed - analysis failure cause: ${scenario.name}`);
      console.error(error);
      process.exitCode = 1;
    } finally {
      await context.close();
    }
  }
};

// 중지 works before the analysis stream starts and returns at once, even if the engine stopped answering (WR-6).
const runPreparationStopScenario = async (browser, fixture) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  let releasePreflight = () => {};
  try {
    await installBaseRoutes(page);
    await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ drafts: [] }),
    }));
    let markPreflightRequested = () => {};
    const preflightRequested = new Promise(resolve => { markPreflightRequested = resolve; });
    const preflightHeld = new Promise(resolve => { releasePreflight = resolve; });
    await page.route('**/api/analyze/preflight', async route => {
      markPreflightRequested();
      await preflightHeld;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true, level: 'ok' }) }).catch(() => {});
    });
    let analyzeRequests = 0;
    await page.route('**/api/analyze', route => {
      analyzeRequests += 1;
      return route.abort('failed');
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await assertProjectPage(page);
    await page.getByLabel('회의 목적', { exact: true }).fill('준비 단계 중지 확인');
    await page.setInputFiles('#meeting-file-input', fixture.path);
    const meetingTitle = await page.getByLabel('회의 제목', { exact: true }).inputValue();
    await page.getByRole('button', { name: '분석 시작' }).click();
    await preflightRequested;

    const panel = page.locator('.writer-analysis-panel');
    const stopButton = panel.getByRole('button', { name: '중지', exact: true });
    await stopButton.waitFor({ timeout: 10000 });
    assert.equal(await panel.getByRole('button', { name: '중지/취소' }).count(), 0, 'no stop-or-cancel choice before a job exists');
    const stoppedAt = Date.now();
    await stopButton.click();
    await page.getByRole('heading', { name: '새 회의록' }).waitFor({ timeout: 3000 });
    assert.ok(Date.now() - stoppedAt < 3000, 'stopping the preparation returns to the form at once');
    await page.getByText('분석을 중지했습니다.', { exact: true }).waitFor({ timeout: 5000 });
    assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), meetingTitle, 'the inputs are kept');
    assert.equal(analyzeRequests, 0, 'a stopped preparation never starts the analysis');
    const drafts = await readLocalStorageJson(page, 'analysisResumeDrafts');
    assert.equal(Array.isArray(drafts) ? drafts.length : 0, 0, 'nothing to resume after stopping before the stream');
    console.log('ok - analysis preparation stop simulation');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    releasePreflight();
    await context.close();
  }
};

// Until the engine answers, the status line says why 분석 시작 is off, long before the 45s notice (WR-7).
const runEngineCheckingScenario = async (browser, fixture) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
  const page = await context.newPage();
  try {
    await installBaseRoutes(page);
    let engineUp = false;
    await page.route('**/api/health', route => (engineUp
      ? route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ ok: true }) })
      : route.abort('connectionrefused')));

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await assertProjectPage(page);
    await page.getByLabel('회의 목적', { exact: true }).fill('연결 확인 중 줄 확인');
    await page.setInputFiles('#meeting-file-input', fixture.path);
    const row = page.locator('.writer-action-row');
    const checkingLine = page.locator('.writer-action-row[data-state="readiness-checking"]');
    await checkingLine.waitFor({ timeout: 5000 });
    assert.equal(await page.locator('#writer-local-engine-requirement .writer-status-title').innerText(), '분석 준비 확인 중');
    const startButton = page.getByRole('button', { name: '분석 시작' });
    assert.equal(await startButton.getAttribute('aria-disabled'), 'true', '분석 시작 waits for the engine');
    assert.equal(await startButton.getAttribute('aria-describedby'), 'writer-local-engine-requirement', 'the blocked button says why');
    assert.equal(await row.getByRole('button', { name: /다시 확인|문제 해결/ }).count(), 0, 'no recovery button before the 45s notice');

    engineUp = true;
    await checkingLine.waitFor({ state: 'detached', timeout: 5000 });
    assert.equal(await row.getAttribute('data-state'), 'ready');
    const startEnabled = () => page.waitForFunction(() => {
      const button = [...document.querySelectorAll('button')].find(element => element.textContent?.trim() === '분석 시작');
      return Boolean(button && button.getAttribute('aria-disabled') !== 'true');
    }, null, { timeout: 5000 });
    await startEnabled();

    // The engine goes away after it was ready: once a start is stopped, the checking line must have a running check
    // behind it, so 분석 시작 comes back by itself when the engine answers again.
    engineUp = false;
    await startButton.click();
    await page.locator('.writer-analysis-panel').getByRole('button', { name: '중지', exact: true }).click();
    await page.getByRole('heading', { name: '새 회의록' }).waitFor({ timeout: 5000 });
    await checkingLine.waitFor({ timeout: 5000 });
    engineUp = true;
    await checkingLine.waitFor({ state: 'detached', timeout: 5000 });
    await startEnabled();
    console.log('ok - engine checking line simulation');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
};

const runDetailContinuityScenario = async (browser, fixture, background = false, viewportWidth = 1280, audioFailure = false) => {
  const context = await browser.newContext({ viewport: { width: viewportWidth, height: 720 } });
  const page = await context.newPage();
  let releaseSettings;
  let releaseResult;
  const settingsReady = new Promise(resolve => { releaseSettings = resolve; });
  const resultReady = new Promise(resolve => { releaseResult = resolve; });
  let markAnalyzeStarted;
  const analyzeStarted = new Promise(resolve => { markAnalyzeStarted = resolve; });
  const title = '진행부터 같은 회의록';
  let jobId;
  const anchors = () => page.evaluate(() => Object.fromEntries(
    ['.meeting-detail-title', '.detail-main-nav', '.detail-search-field', '.detail-command-bar-script'].map(selector => {
      const element = document.querySelector(selector);
      if (!element) throw new Error(`Missing continuity anchor ${selector}; title=${document.querySelector('.meeting-detail-title')?.textContent}`);
      const box = element.getBoundingClientRect();
      return [selector, { x: box.x, y: box.y }];
    }),
  ));
  const assertSameAnchors = (before, after, phase) => {
    for (const selector of Object.keys(before)) {
      assert.ok(Math.abs(before[selector].x - after[selector].x) <= 1, `${phase}: ${selector} stays in the same column`);
      assert.ok(Math.abs(before[selector].y - after[selector].y) <= 1, `${phase}: ${selector} stays at the same height (${before[selector].y} -> ${after[selector].y})`);
    }
  };
  const captureState = async state => {
    if (background || !process.env.ANALYSIS_CONTINUITY_SCREENSHOT_DIR) return;
    await page.locator('.meeting-detail-title').focus();
    await page.mouse.move(viewportWidth - 8, 712);
    await page.screenshot({ path: join(process.env.ANALYSIS_CONTINUITY_SCREENSHOT_DIR, `detail-${state}-${viewportWidth}.png`), animations: 'disabled' });
  };
  try {
    await installBaseRoutes(page);
    if (audioFailure) await page.route('**/api/outputs/*/audio', route => route.fulfill({status: 403, contentType: 'application/json', body: JSON.stringify({detail: 'audio unavailable in this session'})}));
    await page.route('**/api/analyze', async route => {
      jobId = multipartField(route.request().postDataBuffer().toString('utf8'), 'job_id');
      assert.ok(jobId);
      markAnalyzeStarted();
      await resultReady;
      const result = {
        type: 'result', status: 'completed', progress: 100,
        segments: Array.from({ length: 12 }, (_, index) => ({
          start: `00:00:${String(index).padStart(2, '0')}`,
          end: `00:00:${String(index + 1).padStart(2, '0')}`,
          speaker: `SPEAKER_${String(index).padStart(2, '0')}`,
          text: index === 0 ? '같은 화면에서 준비된 첫 대화입니다.' : `화면 위치를 유지한 ${index + 1}번째 대화입니다. 긴 대화록에서도 제목과 회의 정보를 다시 확인할 수 있어야 합니다. `.repeat(6),
        })),
        summary: '', diarization_applied: true, diarization_requested: true,
        meeting: { job_id: jobId, source_file: fixture.name },
        outputs: { job_id: jobId, json: `/api/outputs/${jobId}/json`, audio: audioFailure ? `/api/outputs/${jobId}/audio` : null },
      };
      await route.fulfill({ status: 200, contentType: 'text/event-stream', body: `event: result\ndata: ${JSON.stringify(result)}\n\nevent: done\ndata: [DONE]\n\n` });
    });
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await assertProjectPage(page);
    await page.setInputFiles('#meeting-file-input', fixture.path);
    await page.getByLabel('회의 제목', { exact: true }).fill(title);
    await page.getByLabel('회의 목적', { exact: true }).fill('분석 전 입력한 목적을 결과에서도 유지');
    await page.route('**/api/settings', async route => {
      await settingsReady;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ privacy: { preserve_extracted_audio: false }, diarization: { generate_during_analysis: true } }) });
    });
    await page.getByRole('button', { name: '분석 시작', exact: true }).click();
    await page.getByRole('heading', { name: title, exact: true }).waitFor();
    const preparing = await anchors();
    assert.equal(await page.locator('.meeting-detail-overview-main').evaluate(el => getComputedStyle(el).borderTopWidth), '1px', 'meeting information has the approved quiet border');
    const fileMetadata = await page.locator('.meeting-meta-value-source').innerText();
    assert.match(fileMetadata, /MP4/);
    assert.ok(!fileMetadata.includes(fixture.name), 'the source row shows metadata instead of repeating its title');
    await page.evaluate(() => { window.__continuityFrame = document.querySelector('.meeting-detail-frame'); });
    assert.notEqual(await page.locator('.detail-command-bar-script').getAttribute('inert'), null, 'result editing is locked while preparing');
    const beforeSave = await page.evaluate(async () => (await import('/src/meetingRepository.ts')).getAllMeetings());
    assert.equal(beforeSave.length, 0, 'the preview is not persisted as a finished meeting');
    releaseSettings();
    await analyzeStarted;
    assertSameAnchors(preparing, await anchors(), 'running');
    await page.locator('.meeting-analysis-status').getByRole('button', { name: '중지/취소', exact: true }).waitFor();
    await captureState('running');
    assert.equal(await page.locator('.sidebar-analysis-card').count(), 0, 'the open analysis does not repeat in the sidebar');
    if (background) {
      await page.evaluate(async () => {
        const { addMeeting } = await import('/src/meetingRepository.ts');
        await addMeeting({ id: 'continuity-other', title: '다른 회의록', date: '2026-10-20', summary: '', participants: '', segments: [] });
        window.dispatchEvent(new CustomEvent('meetings:updated'));
      });
      page.once('dialog', dialog => dialog.accept());
      await page.locator('.sidebar-record-row').getByRole('button', { name: '다른 회의록', exact: true }).click();
      await page.getByRole('heading', { name: '다른 회의록', exact: true }).waitFor();
    }
    releaseResult();
    await page.waitForFunction(async id => (await (await import('/src/meetingRepository.ts')).getMeetingById(id))?.analysisStatus === 'completed', jobId);
    if (background) {
      assert.equal(await page.getByRole('heading', { name: '다른 회의록', exact: true }).count(), 1, 'background completion preserves the current meeting');
      await page.locator('.sidebar-record-row').getByRole('button', { name: title, exact: true }).click();
    }
    await page.locator('.meeting-analysis-status').getByText('분석 완료', { exact: false }).waitFor();
    await page.getByText('같은 화면에서 준비된 첫 대화입니다.', { exact: true }).waitFor();
    if (audioFailure) await page.locator('.meeting-audio-error').waitFor();
    if (!background) {
      assert.equal(await page.evaluate(() => window.__continuityFrame === document.querySelector('.meeting-detail-frame')), true, 'completion keeps the same detail element');
      assertSameAnchors(preparing, await anchors(), 'completed');
      await page.locator('.sidebar-record-row-active').getByRole('button', { name: title, exact: true }).waitFor();
      assert.equal(await page.locator('.detail-command-bar-script').getAttribute('inert'), null, 'completion has unlocked result controls before capture');
      await captureState('completed');
      await page.getByRole('button', { name: '회의 정보 수정', exact: true }).click();
      await page.getByLabel('회의 제목', { exact: true }).fill('아직 저장하지 않은 제목');
      page.once('dialog', dialog => dialog.dismiss());
      await page.getByRole('button', { name: '새 회의록', exact: true }).click();
      assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), '아직 저장하지 않은 제목', 'navigation preserves an unsaved completed-result edit');
      await page.getByRole('button', { name: '수정 취소', exact: true }).click();
      await page.locator('.sidebar-record-row').getByRole('button', { name: title, exact: true }).click();
      await page.locator('.meeting-analysis-status').getByText('분석 완료', { exact: true }).waitFor();
      assertSameAnchors(preparing, await anchors(), 'reopened result');
      await captureState('reopened');
    }
    assert.equal(await page.locator('.detail-command-bar-script').getAttribute('inert'), null, 'saved results can be edited');
    await page.getByText('분석 전 입력한 목적을 결과에서도 유지', { exact: true }).waitFor();
    const saved = await page.evaluate(async id => (await import('/src/meetingRepository.ts')).getMeetingById(id), jobId);
    assert.equal(saved.title, title);
    assert.ok(saved.selectedReportTemplateId, 'the report choice survives analysis');
    assert.equal(saved.segments.length, 12);
    assert.equal(typeof saved.analysisElapsedMs, 'number');
    assert.ok(saved.sourceFileMetadata.sizeBytes > 0);
    assert.equal(await page.locator('.meeting-meta-value-source').innerText(), fileMetadata, 'metadata survives completion and reopening');
    const elapsedText = await page.locator('.meeting-analysis-duration').innerText();
    assert.match(elapsedText, /^소요 /);
    if (!background) {
      const workspace = page.locator('.barorok-workspace');
      const topButton = page.getByRole('button', { name: '맨 위로', exact: true });
      await page.emulateMedia({ reducedMotion: 'reduce' });
      assert.equal(await topButton.count(), 0, 'top button is absent at the top');
      await workspace.evaluate(el => { el.scrollTop = el.clientHeight - 10; });
      assert.equal(await topButton.count(), 0, 'top button stays absent before one viewport');
      await workspace.evaluate(el => { el.scrollTop = el.clientHeight + 30; });
      await topButton.waitFor();
      const topBounds = await topButton.boundingBox();
      const workspaceBounds = await workspace.boundingBox();
      assert.ok(topBounds.y >= workspaceBounds.y && topBounds.y + topBounds.height <= workspaceBounds.y + workspaceBounds.height, 'top button is inside the visible workspace, not at the end of the long document');
      assert.ok(topBounds.x >= workspaceBounds.x && topBounds.x + topBounds.width <= workspaceBounds.x + workspaceBounds.width, 'top button stays inside the workspace width');
      if (process.env.ANALYSIS_CONTINUITY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.ANALYSIS_CONTINUITY_SCREENSHOT_DIR, `detail-scrolled-${viewportWidth}.png`) });
      await topButton.click();
      await page.waitForFunction(() => document.querySelector('.barorok-workspace').scrollTop === 0);
      await topButton.waitFor({ state: 'detached' });
      assert.equal(await page.locator('.meeting-detail-title').evaluate(el => el === document.activeElement), true, 'returning to the top retains keyboard focus');
      await page.evaluate(async () => {
        const { addMeeting } = await import('/src/meetingRepository.ts');
        await addMeeting({ id: 'continuity-short', title: '짧은 회의록', date: '2026-10-20', summary: '', participants: '', segments: [] });
        window.dispatchEvent(new CustomEvent('meetings:updated'));
      });
      await page.locator('.sidebar-record-row').getByRole('button', { name: '짧은 회의록', exact: true }).click();
      await page.getByRole('heading', { name: '짧은 회의록', exact: true }).waitFor();
      await workspace.evaluate(el => { el.scrollTop = el.scrollHeight; });
      assert.equal(await topButton.count(), 0, 'short records do not show the top button');
      await page.locator('.sidebar-record-row').getByRole('button', { name: title, exact: true }).click();
      await page.locator('.meeting-analysis-duration').waitFor();
      await workspace.evaluate(el => { el.scrollTop = 0; });
      assert.equal(await page.locator('.meeting-analysis-duration').innerText(), elapsedText);
      await page.getByRole('button', { name: '참석자 12명 전체 보기' }).click();
      assert.equal(await page.locator('.meeting-participant-popover li').count(), 12);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.meeting-participant-popover').count(), 0);
    }
    for (const width of [1280, 760]) {
      await page.setViewportSize({ width, height: 720 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth), 0, 'detail has no horizontal overflow');
      if (process.env.ANALYSIS_CONTINUITY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.ANALYSIS_CONTINUITY_SCREENSHOT_DIR, `detail-${background ? 'background' : 'foreground'}-${width}.png`) });
    }
  } catch (error) {
    if (process.env.ANALYSIS_CONTINUITY_SCREENSHOT_DIR) await page.screenshot({ path: join(process.env.ANALYSIS_CONTINUITY_SCREENSHOT_DIR, 'continuity-failure.png') });
    throw error;
  } finally {
    releaseSettings();
    releaseResult();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }
  console.log(`ok - analysis detail continuity (${background ? 'background completion' : 'preparation, running, completed, reopened result'}, ${viewportWidth}px)`);
};

const runDiarizationContinuityScenario = async (browser, width) => {
  const context = await browser.newContext({ viewport: { width, height: 720 } });
  const page = await context.newPage();
  let finish;
  const ready = new Promise(resolve => { finish = resolve; });
  let processing = false;
  const id = `speaker-continuity-${width}`;
  const title = '참석자 구분도 같은 화면';
  const segments = [{ start: '00:00:00', end: '00:00:03', speaker: '참석자', text: '첫 번째 발화입니다.' }, { start: '00:00:03', end: '00:00:06', speaker: '참석자', text: '두 번째 발화입니다.' }];
  const audio = Buffer.alloc(16044);
  audio.write('RIFF'); audio.writeUInt32LE(audio.length - 8, 4); audio.write('WAVEfmt ', 8);
  audio.writeUInt32LE(16, 16); audio.writeUInt16LE(1, 20); audio.writeUInt16LE(1, 22);
  audio.writeUInt32LE(8000, 24); audio.writeUInt32LE(16000, 28); audio.writeUInt16LE(2, 32); audio.writeUInt16LE(16, 34);
  audio.write('data', 36); audio.writeUInt32LE(16000, 40);
  const anchors = () => page.evaluate(() => Object.fromEntries(['.meeting-detail-title', '.detail-main-nav', '.detail-search-field', '.detail-command-bar-script'].map(selector => {
    const { x, y } = document.querySelector(selector).getBoundingClientRect();
    return [selector, { x, y }];
  })));
  const same = (a, b, phase) => {
    for (const key of Object.keys(a)) for (const axis of ['x', 'y']) assert.ok(Math.abs(a[key][axis] - b[key][axis]) <= 1, `${phase}: ${key} ${axis}`);
  };
  try {
    await installBaseRoutes(page);
    await page.route('**/api/outputs/*/audio', route => route.fulfill({ status: 200, contentType: 'audio/wav', body: audio }));
    await page.route('**/api/outputs/*/generation-progress/diarization', route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ active: processing, progress: processing ? 30 : 0, status: processing ? 'processing' : 'not_started', message: processing ? '참석자 음성 구간 분석 중' : '' }) }));
    await page.route('**/api/outputs/*/generate-diarization', async route => {
      processing = true;
      await ready;
      processing = false;
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ segments: segments.map((s, i) => ({ ...s, speaker: `SPEAKER_0${i}` })), diarizationApplied: true, diarizationDeferred: false, diarizationRequested: true }) });
    });
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await assertProjectPage(page);
    await page.evaluate(async ({ id, title, segments }) => {
      const { addMeeting } = await import('/src/meetingRepository.ts');
      await addMeeting({ id, jobId: id, title, date: '2026-10-21', participants: '', meetingPurpose: '실행 전후 위치와 결과 보존', summary: '', segments, sourceFile: 'sample.wav', outputFiles: { job_id: id, audio: `/api/outputs/${id}/audio` }, sourceFileMetadata: { kind: 'audio', sizeBytes: 1000, durationSeconds: 6 }, analysisStatus: 'completed', analysisElapsedMs: 12000, diarizationDeferred: true, diarizationRequested: true });
      window.dispatchEvent(new CustomEvent('meetings:updated'));
    }, { id, title, segments });
    const open = async () => { await page.locator('.sidebar-record-row').getByRole('button', { name: title, exact: true }).click(); await page.getByRole('heading', { name: title, exact: true }).waitFor(); };
    await open();
    const before = await anchors();
    await page.getByRole('button', { name: '참석자 구분 실행', exact: true }).click();
    const stop = page.getByRole('button', { name: '참석자 구분 중지/취소', exact: true });
    await stop.waitFor();
    assert.ok(await stop.evaluate(el => document.activeElement === el), 'execution focus moves to the stop control');
    assert.equal(await stop.count(), 1, 'one stop control');
    assert.equal((await stop.innerText()).trim(), '', 'the stop control is an animated symbol');
    same(before, await anchors(), 'running');
    assert.equal(await page.locator('.meeting-analysis-status').getByRole('progressbar').count(), 1, 'progress stays inside the reserved status property');
    assert.ok(await page.locator('.meeting-analysis-status').evaluate(el => el.scrollHeight <= el.clientHeight));
    await stop.click();
    assert.ok(await page.locator('.diarization-stop-panel').getByRole('button', { name: '중지', exact: true }).evaluate(el => document.activeElement === el), 'stop choice receives focus');
    await page.locator('.diarization-stop-panel').getByRole('button', { name: '계속', exact: true }).click();
    assert.ok(await stop.evaluate(el => document.activeElement === el), 'continue restores the stop control focus');
    same(before, await anchors(), 'continue after stop choice');
    let readingScroll;
    if (width === 760) {
      await page.getByText('첫 번째 발화입니다.', { exact: false }).last().click();
      assert.ok(await page.evaluate(() => document.activeElement === document.body), 'reading the transcript leaves the progress control');
      readingScroll = await page.locator('.barorok-workspace').evaluate(el => el.scrollTop);
    }
    finish();
    await page.waitForFunction(async id => (await (await import('/src/meetingRepository.ts')).getMeetingById(id))?.diarizationApplied === true, id);
    await stop.waitFor({ state: 'detached' });
    if (width === 760) {
      assert.ok(await page.evaluate(() => document.activeElement === document.body), 'completion must not steal transcript reading focus');
      assert.ok(Math.abs(await page.locator('.barorok-workspace').evaluate(el => el.scrollTop) - readingScroll) <= 1, 'completion preserves the reading position');
      await page.locator('.barorok-workspace').evaluate(el => { el.scrollTop = 0; });
    } else {
      assert.ok(await page.locator('.meeting-detail-title').evaluate(el => document.activeElement === el), 'completion returns owned progress focus to the title');
    }
    same(before, await anchors(), 'completed');
    const completed = await page.evaluate(async id => (await import('/src/meetingRepository.ts')).getMeetingById(id), id);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await open();
    same(before, await anchors(), 'reopened');
    const reopened = await page.evaluate(async id => (await import('/src/meetingRepository.ts')).getMeetingById(id), id);
    assert.deepEqual(reopened.segments, completed.segments);
    assert.equal(reopened.diarizationApplied, true);
    assert.equal(reopened.diarizationDeferred, false);
    console.log(`ok - on-demand speaker progress, stop choice, completion and reopen stay stable (${width}px)`);
  } catch (error) {
    console.error((await page.locator('body').innerText()).slice(0, 1800));
    throw error;
  } finally {
    finish();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await context.close();
  }
};

const server = await startServer();
const fixture = await createFixtureFile();
const browser = await chromium.launch();
try {
  if (process.argv.includes('diarization-continuity')) {
    await runDiarizationContinuityScenario(browser, 1280);
    await runDiarizationContinuityScenario(browser, 760);
  } else if (process.argv.includes('detail-continuity')) {
    await runDetailContinuityScenario(browser, fixture);
    await runDetailContinuityScenario(browser, fixture, false, 760);
    await runDetailContinuityScenario(browser, fixture, true);
    await runDetailContinuityScenario(browser, fixture, false, 760, true);
  } else if (process.argv.includes('stop-actions')) {
    await runScenario(browser, fixture, 'stop');
    await runScenario(browser, fixture, 'cancel', { delayPartialDuringCancel: true });
  } else if (process.argv.includes('admission-preservation')) {
    await runAdmissionScenario(browser, fixture, 'stop');
    await runAdmissionScenario(browser, fixture, 'cancel');
    await runAdmissionScenario(browser, fixture, 'cancel', { terminalFirst: true });
    await runAdmissionScenario(browser, fixture, 'cancel', { existing: false });
    await runAdmissionScenario(browser, fixture, 'cancel', { missingTerminal: true });
    await runScenario(browser, fixture, 'stop');
    await runScenario(browser, fixture, 'cancel', { delayPartialDuringCancel: true });
  } else if (process.argv.includes('pending-cancellation-transition')) {
    await runScenario(browser, fixture, 'cancel', {
      delayPartialDuringCancel: true,
      keepPendingCancellation: true,
    });
  } else if (process.argv.includes('failure-recovery')) {
    await runFailureScenario(browser, fixture);
  } else if (process.argv.includes('failure-causes')) {
    await runFailureCauseScenarios(browser, fixture);
  } else if (process.argv.includes('preparation')) {
    await runPreparationStopScenario(browser, fixture);
    await runEngineCheckingScenario(browser, fixture);
  } else {
    await runScenario(browser, fixture, 'stop', { cancelAccepted: false });
    await runScenario(browser, fixture, 'stop', {
      cancelAccepted: false,
      completedResultAfterStop: true,
      delayStopDecisionResponse: true,
    });
    await runScenario(browser, fixture, 'stop');
    await runScenario(browser, fixture, 'stop', {
      completedResultAfterStop: true,
      delayStopDecisionResponse: true,
    });
    await runScenario(browser, fixture, 'cancel', { delayPartialDuringCancel: true });
    await runScenario(browser, fixture, 'cancel', {
      delayPartialDuringCancel: true,
      keepPendingCancellation: true,
    });
    await runFailureScenario(browser, fixture);
    await runFailureCauseScenarios(browser, fixture);
    await runPreparationStopScenario(browser, fixture);
    await runEngineCheckingScenario(browser, fixture);
  }
} finally {
  await browser.close();
  await stopServer(server);
  // Descendants can retain inherited Windows pipes after the launcher has exited.
  server?.stdout?.destroy();
  server?.stderr?.destroy();
}
