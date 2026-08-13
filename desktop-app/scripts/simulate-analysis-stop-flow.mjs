import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/?view=minutes';
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
  if (title !== '바로록') {
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

const startServer = async () => {
  if (!shouldStartServer) return null;

  try {
    await waitForApp(APP_URL, 1000);
    return null;
  } catch {
    // Start local Vite server.
  }

  const url = new URL(APP_URL);
  const command = `corepack pnpm run dev --host ${url.hostname} --port ${url.port || '5173'} --strictPort --configLoader runner`;
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
      ['pnpm', 'exec', 'vite', '--host', url.hostname, '--port', url.port || '5173'],
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
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: analyzeJobId, deleted: true }),
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
      const postData = (await route.request().postDataBuffer()).toString('utf-8');
      analyzeJobId = multipartField(postData, 'job_id');
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
    assert.deepEqual(writerSectionHeadings.slice(0, 2), ['영상·음성 파일 *', '회의 정보']);
    await page.getByText('분석용 임시 음성은 완료 후 삭제됩니다.', { exact: true }).waitFor({ timeout: 10000 });
    const titleInput = page.getByLabel('회의 제목 *');
    await page.getByLabel('회의 목적 *').fill('분석 중 중지와 취소 동작 확인');
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
    await page.getByRole('heading', { name: '분석 진행' }).waitFor({ timeout: 10000 });
    assert.notEqual((await analysisPanel.innerText()).trim(), '', 'analysis panel should show the current step before model status responds');
    assert.equal(analyzeJobId, null, 'analysis request should wait for model status');
    releaseModelStatusResponse();
    await analyzeStarted;
    if (delayPartialDuringCancel) await partialRequested;
    const stopMenuButton = page.getByRole('button', { name: '중지/취소' });
    await stopMenuButton.waitFor({ timeout: 10000 });
    const progressLayout = await page.evaluate(() => {
      const panel = document.querySelector('.writer-analysis-panel');
      const stopButton = Array.from(document.querySelectorAll('button')).find(button => button.textContent?.includes('중지/취소'));
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

    if (action === 'stop') {
      await page.locator('.analysis-stop-panel').getByRole('button', { name: '이어하기 기록을 남기고 분석 중지' }).click();
      await page.getByRole('main').getByText('현재 처리 중인 구간이 끝나면 이어하기 기록으로 남깁니다.').waitFor({ timeout: 10000 });
    } else {
      await page.locator('.analysis-stop-panel').getByRole('button', { name: '이어하기 기록을 남기지 않고 분석 취소' }).click();
      await page.getByRole('main').getByText('현재 처리 중인 구간이 끝나면 이어하기 기록을 제거합니다.').waitFor({ timeout: 10000 });
    }

    await cancelRequested;
    assert.equal(cancelRequestCount, 1);
    assert.deepEqual(cancelRequestBodies, [{ action }]);
    if (delayPartialDuringCancel) releasePartialResponse();
    if (delayStopDecisionResponse) {
      releaseAnalyzeResponse();
      await page.waitForFunction(() => window.__meetingUpdateCount >= 1, undefined, { timeout: 10000 });
      assert.equal(await page.locator('.writer-completion-panel').count(), 0);
      releaseStopDecisionResponse();
    }
    if (!cancelAccepted) {
      await page.getByRole('status').getByText('중지할 분석을 찾지 못했습니다.', { exact: true }).waitFor({ timeout: 10000 });
      await page.locator('.analysis-stop-panel').waitFor({ state: 'detached' });
      if (!completedResultAfterStop) {
        await stopMenuButton.waitFor({ state: 'visible' });
        assert.equal(await page.evaluate(() => Array.from(document.querySelectorAll('button')).some(
          button => button.textContent?.includes('중지/취소') && !button.disabled,
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
        await page.locator('.writer-completion-panel').waitFor({ timeout: 10000 });
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

    if (action === 'stop') {
      await page.getByText('분석을 중지했습니다. 같은 파일을 선택하면 이어서 진행할 수 있습니다.').waitFor({ timeout: 10000 });
      const drafts = await readLocalStorageJson(page, 'analysisResumeDrafts');
      assert.equal(drafts.length, 1);
      assert.equal(drafts[0].status, 'stopped');
      assert.equal(drafts[0].jobId, analyzeJobId);
      assert.equal(await page.locator('.writer-completion-panel').count(), 0, 'accepted stop must not show completion UI');
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
    await page.getByLabel('회의 목적 *').fill('분석 실패 후 복구 화면 확인');
    await page.setInputFiles('#meeting-file-input', fixture.path);
    const originalTitle = await page.getByLabel('회의 제목 *').inputValue();
    await page.getByRole('button', { name: '분석 시작' }).click();

    await page.getByRole('heading', { name: '분석을 마치지 못했습니다' }).waitFor({ timeout: 10000 });
    const failurePanel = page.locator('.writer-analysis-panel-error');
    await failurePanel.getByText('테스트 분석 오류가 발생했습니다.', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.resume-drafts-panel').count(), 0, 'resume draft lists belong only in the sidebar');
    await failurePanel.getByRole('button', { name: '다시 시도' }).waitFor({ timeout: 10000 });
    await failurePanel.getByRole('button', { name: '입력 확인' }).click();

    await page.getByRole('heading', { name: '새 회의록' }).waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.id === 'meeting-title');
    assert.equal(await page.getByLabel('회의 제목 *').inputValue(), originalTitle, 'failure recovery should preserve the title');
    await page.locator('.selected-file-card').getByText(fixture.name, { exact: true }).waitFor({ timeout: 10000 });
    const overflowX = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    assert.equal(overflowX, 0, 'failure state should not create horizontal overflow');

    await page.getByRole('button', { name: '분석 시작' }).click();
    await page.getByRole('heading', { name: '분석을 마치지 못했습니다' }).waitFor({ timeout: 10000 });
    await page.locator('.writer-analysis-panel-error').getByRole('button', { name: '다시 시도' }).click();
    await page.getByRole('heading', { name: '분석 완료' }).waitFor({ timeout: 10000 });
    await page.locator('.writer-completion-panel').getByText(originalTitle, { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(analyzeAttempt, 3, 'retry should start one new analysis request');
    assert.equal(await page.getByLabel('회의 제목 *').count(), 0, 'retry completion should replace the input form');

    console.log('ok - analysis failure recovery simulation');
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    await context.close();
  }
};

const server = await startServer();
const fixture = await createFixtureFile();
const browser = await chromium.launch();
try {
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
  await runFailureScenario(browser, fixture);
} finally {
  await browser.close();
  await stopServer(server);
}
