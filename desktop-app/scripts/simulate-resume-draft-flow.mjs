import assert from 'node:assert/strict';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/?view=minutes';
const shouldStartServer = !process.env.APP_URL;
const WRITER_CAPTURE_DIR = process.env.WRITER_CAPTURE_DIR ?? null;

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
  const command = `corepack pnpm exec vite --host ${url.hostname} --port ${url.port || '5173'}`;
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

  await page.route('**/api/analyze/preflight', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ok: true,
      level: 'ok',
      message: '',
    }),
  }));

  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      diarization: { enabled: true, generate_during_analysis: true },
      privacy: { preserve_extracted_audio: true, auto_save_audio_copy: false },
    }),
  }));

  await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
  }));
};

const createFixtureFile = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'smart-minutes-resume-draft-'));
  const filePath = join(dir, 'resume-draft-target.mp4');
  await writeFile(filePath, Buffer.alloc(25, 7));
  const fileStat = await stat(filePath);
  return {
    path: filePath,
    name: 'resume-draft-target.mp4',
    size: fileStat.size,
    lastModified: Math.trunc(fileStat.mtimeMs),
  };
};

const runWriterLayoutScenario = async (browser) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ drafts: [] }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /영상 또는 음성 파일 선택/ }).waitFor({ timeout: 10000 });
    await page.getByText('회의 정보', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByText('참석자 구분까지 이어서 실행', { exact: true }).count(), 0, 'participant separation should be owned by Settings');
    assert.equal(await page.getByRole('button', { name: '음성 추출', exact: true }).count(), 0, 'audio extraction stays implemented but hidden from the new-record surface');
    const startButton = page.getByRole('button', { name: '분석 시작' });
    await startButton.waitFor({ timeout: 10000 });

    let wideBaseline = null;
    for (const viewport of [{ width: 1280, height: 800 }, { width: 1440, height: 900 }, { width: 1600, height: 900 }, { width: 1280, height: 720 }, { width: 1024, height: 800 }]) {
      await page.setViewportSize(viewport);
      await page.waitForTimeout(100);
      const metrics = await page.evaluate(() => {
        const rect = selector => document.querySelector(selector)?.getBoundingClientRect();
        const overflowX = selector => {
          const element = document.querySelector(selector);
          return element ? element.scrollWidth - element.clientWidth : null;
        };
        const grid = rect('.writer-input-grid');
        const upload = rect('.writer-input-grid > .writer-section:first-child');
        const info = rect('.writer-info-column');
        const action = rect('.writer-action-bar');
        const title = rect('.writer-title');
        const fileButton = rect('.file-drop-zone');
        const startButton = rect('.writer-start-button');
        const backdrop = rect('.ocean-backdrop');
        const workspace = document.querySelector('.barorok-workspace-minutes');
        const frame = rect('.barorok-app-frame');
        const shell = rect('.barorok-shell-body');
        const navigation = rect('.barorok-navigation');
        const workspaceRect = rect('.barorok-workspace');
        return {
          horizontalOverflow: {
            document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
            frame: overflowX('.barorok-app-frame'),
            shell: overflowX('.barorok-shell-body'),
            navigation: overflowX('.barorok-navigation'),
            workspace: overflowX('.barorok-workspace'),
          },
          viewportBounds: [frame, shell, navigation, workspaceRect]
            .filter(Boolean)
            .map(element => ({ left: element.left, right: element.right })),
          scrollHeight: workspace?.scrollHeight ?? 0,
          clientHeight: workspace?.clientHeight ?? 0,
          overflowY: workspace ? getComputedStyle(workspace).overflowY : '',
          viewportHeight: window.innerHeight,
          grid: grid && { left: grid.left, right: grid.right },
          upload: upload && { top: upload.top, bottom: upload.bottom },
          info: info && { left: info.left, right: info.right, top: info.top, bottom: info.bottom },
          uploadWidth: upload?.width ?? null,
          infoWidth: info?.width ?? null,
          action: action && { left: action.left, right: action.right, top: action.top, bottom: action.bottom },
          startButton: startButton && { left: startButton.left, right: startButton.right, width: startButton.width },
          backdrop: backdrop && { left: backdrop.left, right: backdrop.right, top: backdrop.top, bottom: backdrop.bottom },
          visibleBottoms: [title?.bottom, fileButton?.bottom, info?.bottom, action?.bottom, startButton?.bottom],
        };
      });
      for (const [surface, overflow] of Object.entries(metrics.horizontalOverflow)) {
        assert.ok(overflow !== null && overflow <= 1, `${viewport.width}px ${surface} should not create horizontal overflow`);
      }
      assert.ok(
        metrics.viewportBounds.every(bounds => bounds.left >= -1 && bounds.right <= viewport.width + 1),
        `${viewport.width}px app surfaces should remain inside viewport bounds`,
      );
      assert.ok(metrics.grid && metrics.upload && metrics.info && metrics.action, 'writer layout elements should exist');
      if (viewport.width > 1024) {
        if (viewport.height >= 800) {
          assert.ok(metrics.visibleBottoms.every(bottom => typeof bottom === 'number' && bottom <= metrics.viewportHeight), `${viewport.width}x${viewport.height} initial controls should fit in the viewport`);
        } else {
          assert.ok(metrics.scrollHeight >= metrics.clientHeight, 'low-height writer should keep the CTA reachable through its single canvas scroll');
          assert.ok(['auto', 'scroll'].includes(metrics.overflowY), 'low-height writer should preserve canvas scrolling');
        }
        assert.ok(metrics.info.left > metrics.grid.left, `${viewport.width}px should use two columns`);
        assert.ok(Math.abs(metrics.action.right - metrics.info.right) <= 1, 'wide action should align with the meeting panel right edge');
        assert.ok(metrics.startButton && metrics.startButton.width >= 220 && metrics.startButton.width <= 240.5, 'wide CTA should keep the approved compact width');
        if (viewport.width === 1440) {
          wideBaseline = { uploadWidth: metrics.uploadWidth, infoWidth: metrics.infoWidth };
        }
        if (viewport.width === 1600) {
          assert.ok(wideBaseline, '1440 baseline should be measured before 1600');
          assert.ok(metrics.uploadWidth <= 584.5 && metrics.infoWidth <= 448.5, '1600 panels should stop at their approved maximum widths');
          assert.ok(metrics.backdrop && metrics.backdrop.right >= metrics.info.right, 'background plate should cover the complete writer rail');
        }
      } else {
        assert.ok(metrics.info.top >= metrics.upload.bottom - 1, '1024px should stack the writer sections in one column');
        assert.ok(metrics.action.top >= metrics.info.bottom - 1, '1024px action bar should follow the stacked content');
        assert.ok(metrics.scrollHeight >= metrics.clientHeight, '1024px should allow normal vertical scrolling when needed');
        assert.ok(['auto', 'scroll'].includes(metrics.overflowY), '1024px workspace should allow vertical scrolling');
      }
      if (WRITER_CAPTURE_DIR) {
        await mkdir(WRITER_CAPTURE_DIR, { recursive: true });
        await page.screenshot({ path: join(WRITER_CAPTURE_DIR, `new-record-ocean-${viewport.width}.png`), fullPage: true });
      }
    }
    await page.setViewportSize({ width: 1280, height: 800 });
    await startButton.click();
    await page.getByText(/필수 항목을 확인해 주세요/).waitFor({ timeout: 10000 });
    await page.locator('#writer-form-error').waitFor({ timeout: 10000 });
    assert.equal(await page.getByLabel('회의 제목 *').getAttribute('aria-invalid'), 'true');
    assert.equal(await page.getByLabel('회의 목적 *').getAttribute('aria-invalid'), 'true');
    const requiredFileButton = page.getByRole('button', { name: /필수: 영상 또는 음성 파일 선택/ });
    assert.equal(await requiredFileButton.getAttribute('aria-invalid'), 'true');
    assert.equal(await requiredFileButton.getAttribute('aria-describedby'), 'writer-form-error');
    assert.equal(await page.locator('#writer-form-error').count(), 1, 'invalid controls should reference a real error description');
    if (WRITER_CAPTURE_DIR) {
      await page.screenshot({ path: join(WRITER_CAPTURE_DIR, 'new-record-ocean-error-1280.png'), fullPage: true });
    }
    console.log('ok - writer responsive layout scenario');
  } finally {
    await context.close();
  }
};

const runLatestDiarizationSettingScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let settingsReadCount = 0;
  let submittedDiarizationValue = null;
  let releaseInitialSettings = () => {};
  const initialSettingsCanFinish = new Promise(resolve => {
    releaseInitialSettings = resolve;
  });

  await installBaseRoutes(page);
  await page.route('**/api/settings', async route => {
    settingsReadCount += 1;
    const isInitialRequest = settingsReadCount === 1;
    if (isInitialRequest) await initialSettingsCanFinish;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        diarization: { enabled: true, generate_during_analysis: isInitialRequest },
        privacy: { preserve_extracted_audio: true, auto_save_audio_copy: false },
      }),
    });
  });
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ drafts: [] }),
  }));
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [], recommended_job_id: null }),
  }));
  await page.route('**/api/analyze', async route => {
    const postData = (await route.request().postDataBuffer()).toString('utf-8');
    submittedDiarizationValue = postData.match(/name="diarization_during_analysis"\r\n\r\n([^\r\n]+)/)?.[1] ?? null;
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: ['event: done', 'data: [DONE]', '', ''].join('\n'),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    while (settingsReadCount < 1) {
      await sleep(25);
    }
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByLabel('회의 제목 *').fill('최신 설정 확인');
    await page.getByLabel('회의 목적 *').fill('분석 시작 직전 설정 재조회');
    await page.getByRole('button', { name: '분석 시작' }).click();
    await page.waitForFunction(() => document.body.innerText.includes('분석 진행'));
    const submissionDeadline = Date.now() + 5_000;
    while (submittedDiarizationValue === null && Date.now() < submissionDeadline) {
      await sleep(25);
    }
    assert.ok(settingsReadCount >= 2, 'analysis start should re-read settings after the initial page load');
    assert.equal(submittedDiarizationValue, 'false', 'analysis payload should use the latest Settings value');
    releaseInitialSettings();
    await page.waitForTimeout(100);
    assert.equal(await page.getByText('참석자 구분을 계속 진행합니다.', { exact: false }).count(), 0, 'progress guidance should not revert to an older settings response');
    console.log('ok - latest diarization setting scenario');
  } finally {
    await context.close();
  }
};

const runPartialRecordFailureScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let analysisJobId = null;

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ drafts: [] }),
  }));
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [], recommended_job_id: null }),
  }));
  await page.route('**/partial-result', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      job_id: analysisJobId,
      source_file: fixtureUpload.name,
      partial: true,
      summary: '대화록을 저장했습니다. 참석자 구분을 진행하고 있습니다.',
      segments: [{ start: '00:00', end: '00:02', speaker: '', text: '실패 전 저장된 대화록' }],
      display_segments: [{ start: '00:00', end: '00:02', speaker: '', text: '실패 전 저장된 대화록' }],
      diarization_requested: true,
    }),
  }));
  await page.route('**/api/analyze', async route => {
    const postData = (await route.request().postDataBuffer()).toString('utf-8');
    analysisJobId = postData.match(/name="job_id"\r\n\r\n([^\r\n]+)/)?.[1] ?? null;
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
      'event: progress',
      'data: {"type":"progress","progress":70,"status":"diarizing","message":"참석자 구분 중","transcript_ready":true}',
      '',
      'event: error',
      'data: {"type":"error","progress":70,"status":"error","message":"참석자 구분 테스트 오류"}',
      '',
      'event: done',
      'data: [DONE]',
      '',
      '',
      ].join('\n'),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByLabel('회의 제목 *').fill('중간 저장 실패 테스트');
    await page.getByLabel('회의 목적 *').fill('참석자 구분 실패 후 대화록 보존 확인');
    await page.getByRole('button', { name: '분석 시작' }).click();
    await page.getByRole('heading', { name: '분석을 마치지 못했습니다' }).waitFor({ timeout: 10000 });

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
    assert.equal(meetings.length, 1);
    assert.ok(analysisJobId);
    assert.equal(meetings[0].id, analysisJobId);
    assert.equal(meetings[0].jobId, analysisJobId);
    assert.equal(meetings[0].analysisStatus, 'diarization_failed');

    page.once('dialog', dialog => dialog.accept());
    await page.getByRole('button', { name: '중간 저장 실패 테스트', exact: true }).click();
    await page.getByText('실패 전 저장된 대화록', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByText('참석자 구분 실패', { exact: true }).first().waitFor({ timeout: 10000 });
    console.log('ok - partial record failure preservation scenario');
  } finally {
    await context.close();
  }
};

const runCancelledRecoveryImportRaceScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  let releaseRecoverableResult = () => {};
  const recoverableResultCanFinish = new Promise(resolve => {
    releaseRecoverableResult = resolve;
  });
  let markRecoverableResultRequested = () => {};
  const recoverableResultRequested = new Promise(resolve => {
    markRecoverableResultRequested = resolve;
  });
  const draft = {
    jobId: 'cancelled-recovery-race-job',
    title: '취소 경합 회의',
    date: '2026-05-13T09:30',
    meetingPurpose: '복구 응답 지연 중 취소 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'active',
    transcriptReady: true,
    createdAt: '2026-05-13T09:30:00.000Z',
    updatedAt: '2026-05-13T09:45:00.000Z',
    stage: 'diarizing',
    lastMessage: '참석자 구분 중',
    lastProgress: 70,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);
  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: draft.jobId,
        status: 'active',
        stage: 'diarizing',
        active: true,
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: { transcript_ready: true },
      }],
    }),
  }));
  await page.route('**/recoverable-result', async route => {
    markRecoverableResultRequested();
    await recoverableResultCanFinish;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: draft.jobId,
        source_file: fixtureUpload.name,
        partial: true,
        summary: '지연된 복구 결과',
        segments: [{ start: '00:00', end: '00:02', speaker: '', text: '취소 뒤 생성되면 안 됩니다.' }],
        display_segments: [{ start: '00:00', end: '00:02', speaker: '', text: '취소 뒤 생성되면 안 됩니다.' }],
        diarization_requested: true,
      }),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await recoverableResultRequested;
    await page.evaluate(jobId => {
      window.localStorage.setItem('analysisResumeDrafts', '[]');
      window.dispatchEvent(new CustomEvent('analysis-resume-drafts:updated', { detail: { jobId } }));
    }, draft.jobId);
    releaseRecoverableResult();
    await page.waitForTimeout(500);
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
    assert.equal(meetings.length, 0, 'a delayed recovery response must not recreate a cancelled meeting');
    console.log('ok - cancelled recovery import race scenario');
  } finally {
    await context.close();
  }
};

const runCompletedMeetingRejectsStalePartialScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  await context.addInitScript(() => {
    window.__meetingUpdateCount = 0;
    window.addEventListener('meetings:updated', () => {
      window.__meetingUpdateCount += 1;
    });
  });
  const page = await context.newPage();
  const draft = {
    jobId: 'completed-monotonic-job',
    title: '완료 상태 단조성',
    date: '2026-05-13T09:30',
    meetingPurpose: '늦은 partial 복구 방지',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'active',
    transcriptReady: true,
    createdAt: '2026-05-13T09:30:00.000Z',
    updatedAt: '2026-05-13T09:45:00.000Z',
    stage: 'diarizing',
    lastMessage: '참석자 구분 중',
    lastProgress: 70,
  };

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: draft.jobId,
        status: 'active',
        stage: 'diarizing',
        active: true,
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: { transcript_ready: true },
      }],
    }),
  }));
  await page.route('**/recoverable-result', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      job_id: draft.jobId,
      source_file: fixtureUpload.name,
      partial: true,
      summary: '늦게 도착한 partial 결과',
      segments: [{ start: '00:00', end: '00:02', speaker: '', text: '오래된 대화록' }],
      display_segments: [{ start: '00:00', end: '00:02', speaker: '', text: '오래된 대화록' }],
      diarization_requested: true,
    }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.evaluate(({ meeting, resumeDraft }) => new Promise((resolve, reject) => {
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
        transaction.objectStore('meetings').put(meeting);
        transaction.oncomplete = () => {
          db.close();
          window.__meetingUpdateCount = 0;
          window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([resumeDraft]));
          window.dispatchEvent(new Event('analysis-resume-drafts:updated'));
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    }), { meeting: {
      id: draft.jobId,
      jobId: draft.jobId,
      date: '2026-05-13 09:30',
      title: draft.title,
      participants: '',
      meetingPurpose: draft.meetingPurpose,
      summary: '이미 저장된 최종 결과',
      segments: [{ start: '00:00', end: '00:02', speaker: 'SPEAKER_00', text: '최종 대화록' }],
      displaySegments: [{ start: '00:00', end: '00:02', speaker: 'SPEAKER_00', text: '최종 대화록' }],
      speakerLabels: {},
      sourceFile: fixtureUpload.name,
      analysisStatus: 'completed',
      createdAt: '2026-05-13T09:30:00.000Z',
      updatedAt: '2026-05-13T10:00:00.000Z',
    }, resumeDraft: draft });
    await page.waitForFunction(() => window.__meetingUpdateCount >= 1, undefined, { timeout: 10000 });
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
    assert.equal(meetings.length, 1);
    assert.equal(meetings[0].analysisStatus, 'completed');
    assert.equal(meetings[0].summary, '이미 저장된 최종 결과');
    assert.equal(meetings[0].displaySegments[0].text, '최종 대화록');
    console.log('ok - completed meeting rejects stale partial scenario');
  } finally {
    await context.close();
  }
};

const runResumeDraftScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', error => console.error('resume draft scenario page error:', error));
  let analyzeRequestSnapshot = null;
  let resumeCandidatesCalled = false;

  const drafts = [{
    jobId: 'draft-job-001',
    title: '중단된 회의',
    date: '2026-05-13T09:30',
    meetingPurpose: '중단된 분석 이어하기 확인',
    selectedReportTemplateId: 'standard-minutes',
    selectedTermGlossaryIds: ['lmo'],
    sourceFilename: 'resume-draft-target.mp4',
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-13T09:30:00.000Z',
    updatedAt: '2026-05-13T09:45:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 2/4...',
    lastProgress: 45,
  }, {
    jobId: 'draft-job-older',
    title: '예전 실패 분석',
    date: '2026-05-13T08:00',
    meetingPurpose: '예전 실패 분석 재사용 확인',
    sourceFilename: 'resume-draft-target.mp4',
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'failed',
    createdAt: '2026-05-13T08:00:00.000Z',
    updatedAt: '2026-05-13T08:15:00.000Z',
    stage: 'failed',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 20,
    errorMessage: '이전 오류',
  }];

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify(value));
  }, drafts);

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [
        {
          job_id: 'draft-job-001',
          status: 'cancelled',
          stage: 'cancelled',
          updated_at: '2026-05-13T09:45:00.000Z',
          resume_supported: true,
          completed_chunk_count: 2,
          last_progress: {
            message: 'Transcribing chunk 2/4...',
            progress: 45,
            status: 'cancelled',
          },
        },
        {
          job_id: 'draft-job-older',
          status: 'failed',
          stage: 'failed',
          updated_at: '2026-05-13T08:15:00.000Z',
          resume_supported: true,
          completed_chunk_count: 1,
          last_progress: {
            message: 'Transcribing chunk 1/4...',
            progress: 20,
            status: 'failed',
          },
          last_error: '이전 오류',
        },
      ],
    }),
  }));
  await page.route('**/api/analyze/resume-candidates', route => {
    resumeCandidatesCalled = true;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        recommended_job_id: 'draft-job-001',
        candidates: [
          {
            job_id: 'draft-job-001',
            stage: 'transcribing',
            updated_at: '2026-05-13T10:10:00',
            resume_supported: true,
            active: false,
            chunk_count: 4,
            completed_chunk_count: 3,
            last_progress: {
              message: 'Transcribing chunk 3/4...',
              progress: 70,
              status: 'processing',
            },
          },
        ],
      }),
    });
  });

  await page.route('**/api/analyze', async route => {
    const postData = await route.request().postDataBuffer();
    analyzeRequestSnapshot = postData.toString('utf-8');
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        'event: progress',
        'data: {"type":"progress","progress":5,"message":"업로드 파일 저장 완료","status":"processing"}',
        '',
        'event: result',
        'data: {"type":"result","progress":100,"status":"completed","summary":"resume draft summary","segments":[],"meeting":{"source_file":"resume-draft-target.mp4","job_id":"draft-job-001"},"outputs":{"job_id":"draft-job-001","json":"/api/outputs/draft-job-001/json","txt":"/api/outputs/draft-job-001/txt","md":null,"docx":null,"hwpx":null},"resume":{"requested":true,"mode":"reused_stt","message":"이전 음성 인식 진행분을 재사용했습니다.","reused_chunk_count":3}}',
        '',
        'event: done',
        'data: [DONE]',
        '',
      ].join('\n'),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.setInputFiles('#meeting-file-input', {
      name: '이어하기-전-선택.mp3',
      mimeType: 'audio/mpeg',
      buffer: Buffer.from('previous selected file'),
    });
    await page.getByText('이어하기-전-선택.mp3', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: /미완료 분석 기록 2건/ }).click();
    page.once('dialog', dialog => dialog.accept());
    await page.locator('.sidebar-resume-draft-button').filter({ hasText: '중단된 회의' }).click();
    await page.getByRole('heading', { name: '이어하기' }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByText('이어하기-전-선택.mp3', { exact: true }).count(), 0);
    await page.getByRole('button', { name: /영상 또는 음성 파일 선택/ }).waitFor({ timeout: 10000 });
    await page.getByText('이전 분석 기록을 이어서 진행합니다. 같은 음성 파일을 다시 선택한 뒤 이어하기를 시작하세요.').waitFor({ timeout: 10000 });
    await page.getByText('같은 영상·음성 파일 선택 *').waitFor({ timeout: 10000 });
    await page.getByText('resume-draft-target.mp4 파일을 다시 선택해 주세요.').waitFor({ timeout: 10000 });
    await expectValue(page, '#meeting-title', '중단된 회의');
    await expectValue(page, '#meeting-purpose', '중단된 분석 이어하기 확인');
    assert.equal(await page.locator('#report-template').count(), 0);
    assert.equal(await page.locator('label.topic-chip').count(), 0);
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await expectValue(page, '#meeting-title', '중단된 회의');
    await page.getByText('같은 파일을 확인했습니다. 이어하기를 시작할 수 있습니다.').waitFor({ timeout: 10000 });
    await page.locator('.app-panel').first().getByRole('button', { name: '이어하기', exact: true }).click();
    await page.getByText('이전 음성 인식 진행분 3개 구간을 재사용했습니다.').waitFor({ timeout: 10000 });
    assert.equal(resumeCandidatesCalled, true);
    assert.match(analyzeRequestSnapshot ?? '', /name="job_id"\r\n\r\ndraft-job-001/);
    assert.match(analyzeRequestSnapshot ?? '', /name="resume_requested"\r\n\r\ntrue/);
    assert.match(analyzeRequestSnapshot ?? '', /name="selected_report_template_id"\r\n\r\nstandard-minutes/);
    assert.match(analyzeRequestSnapshot ?? '', /name="selected_term_glossary_ids"\r\n\r\n\[\]/);
    assert.match(analyzeRequestSnapshot ?? '', /name="report_template"\r\n\r\n[\s\S]*"id":"standard-minutes"/);
    assert.match(analyzeRequestSnapshot ?? '', /name="term_glossaries"\r\n\r\n\[\]/);
    const storedDrafts = await page.evaluate(() => window.localStorage.getItem('analysisResumeDrafts'));
    const parsedDrafts = JSON.parse(storedDrafts ?? '[]');
    assert.equal(parsedDrafts.length, 2);
    assert.equal(parsedDrafts.every(draft => draft.status === 'completed'), true);
    assert.equal(parsedDrafts.every(draft => draft.resumeUnavailableReason === 'completed'), true);
    console.log('ok - resume draft flow simulation');
  } catch (error) {
    console.error(error);
    console.error('analyzeRequestSnapshot:', analyzeRequestSnapshot);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runActiveDraftBackendSyncScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let recoveryEnabled = false;

  const drafts = [{
    jobId: 'active-draft-job-001',
    title: '진행 중이던 분석',
    date: '2026-05-13T09:30',
    meetingPurpose: '진행 중 분석 상태 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'active',
    createdAt: '2026-05-13T09:30:00.000Z',
    updatedAt: '2026-05-13T09:45:00.000Z',
    stage: 'transcribing',
    lastMessage: 'Transcribing chunk 2/4...',
    lastProgress: 45,
  }];

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify(value));
  }, drafts);

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [
        {
          job_id: 'active-draft-job-001',
          status: recoveryEnabled ? 'completed' : 'active',
          stage: recoveryEnabled ? 'completed' : 'diarizing',
          active: !recoveryEnabled,
          resume_supported: true,
          completed_chunk_count: 1,
        },
      ],
    }),
  }));
  await page.route('**/recoverable-result', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      job_id: 'active-draft-job-001',
      source_file: 'active-draft-job-001-upload.mp4',
      partial: false,
      summary: '복구된 회의록',
      segments: [{ start: '00:00', end: '00:02', speaker: 'SPEAKER_00', text: '복구된 대화록입니다.' }],
      display_segments: [{ start: '00:00', end: '00:02', speaker: 'SPEAKER_00', text: '복구된 대화록입니다.' }],
      diarization_applied: true,
      diarization_requested: true,
      outputs: { job_id: 'active-draft-job-001' },
    }),
  }));

  try {
    await waitForApp(APP_URL);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) db.createObjectStore('meetings', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('folders')) db.createObjectStore('folders', { keyPath: 'id' });
      };
      request.onsuccess = () => {
        const db = request.result;
        const transaction = db.transaction(['meetings', 'folders'], 'readwrite');
        transaction.objectStore('folders').put({
          id: 'edited-folder-001',
          name: '사용자 폴더',
          createdAt: '2026-05-13T09:10:00.000Z',
          updatedAt: '2026-05-13T09:20:00.000Z',
        });
        transaction.objectStore('meetings').put({
          id: 'existing-local-meeting-001',
          jobId: 'active-draft-job-001',
          date: '2026-05-13 09:30',
          title: '사용자가 수정한 제목',
          participants: '',
          meetingPurpose: '사용자가 수정한 회의 목적',
          summary: '대화록을 저장했습니다. 참석자 구분을 진행하고 있습니다.',
          segments: [{ start: '00:00', end: '00:02', speaker: '', text: '중간 저장 대화록' }],
          displaySegments: [{ start: '00:00', end: '00:02', speaker: '', text: '중간 저장 대화록' }],
          speakerLabels: {},
          sourceFile: 'resume-draft-target.mp4',
          folderId: 'edited-folder-001',
          pinned: true,
          editedDisplaySegments: [{ start: '00:00', end: '00:02', speaker: '', text: '사용자가 수정한 대화록' }],
          transcriptEditMeta: { edited: true, editedAt: '2026-05-13T09:20:00.000Z', updatedBy: 'user' },
          analysisStatus: 'diarization_in_progress',
          createdAt: '2026-05-13T09:10:00.000Z',
          updatedAt: '2026-05-13T09:20:00.000Z',
        });
        transaction.objectStore('meetings').put({
          id: 'active-draft-job-001',
          jobId: 'active-draft-job-001',
          date: '2026-05-13 09:00',
          title: '중복된 이전 제목',
          participants: '',
          meetingPurpose: '중복된 이전 목적',
          summary: '이전 중복 기록',
          segments: [],
          displaySegments: [],
          speakerLabels: {},
          sourceFile: 'resume-draft-target.mp4',
          analysisStatus: 'diarization_in_progress',
          createdAt: '2026-05-13T09:30:00.000Z',
          updatedAt: '2026-05-13T09:40:00.000Z',
        });
        transaction.oncomplete = () => {
          db.close();
          window.dispatchEvent(new Event('meetings:updated'));
          resolve();
        };
        transaction.onerror = () => reject(transaction.error);
      };
    }));
    await page.getByRole('button', { name: '사용자가 수정한 제목', exact: true }).click();
    await page.getByText('사용자가 수정한 대화록', { exact: true }).waitFor({ timeout: 10000 });

    recoveryEnabled = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => {
      const stored = window.localStorage.getItem('analysisResumeDrafts');
      const parsed = JSON.parse(stored ?? '[]');
      return parsed[0]?.status === 'completed';
    }, undefined, { timeout: 10000 });
    const storedDrafts = await page.evaluate(() => window.localStorage.getItem('analysisResumeDrafts'));
    const parsedDrafts = JSON.parse(storedDrafts ?? '[]');
    assert.equal(parsedDrafts.length, 1);
    assert.equal(parsedDrafts[0].status, 'completed');
    assert.equal(parsedDrafts[0].resumeUnavailableReason, 'completed');
    const recoveredMeetings = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('MeetingHistoryDB');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const getAllRequest = db.transaction('meetings', 'readonly').objectStore('meetings').getAll();
        getAllRequest.onerror = () => reject(getAllRequest.error);
        getAllRequest.onsuccess = () => resolve(getAllRequest.result);
      };
    }));
    assert.equal(recoveredMeetings.length, 1);
    assert.equal(recoveredMeetings[0].id, 'existing-local-meeting-001');
    assert.equal(recoveredMeetings[0].jobId, 'active-draft-job-001');
    assert.equal(recoveredMeetings[0].analysisStatus, 'completed');
    assert.equal(recoveredMeetings[0].title, '사용자가 수정한 제목');
    assert.equal(recoveredMeetings[0].meetingPurpose, '사용자가 수정한 회의 목적');
    assert.equal(recoveredMeetings[0].folderId, 'edited-folder-001');
    assert.equal(recoveredMeetings[0].pinned, true);
    assert.equal(recoveredMeetings[0].sourceFile, 'resume-draft-target.mp4');
    assert.equal(recoveredMeetings[0].editedDisplaySegments[0].text, '사용자가 수정한 대화록');
    assert.equal(recoveredMeetings[0].transcriptEditMeta.updatedBy, 'user');
    assert.equal(recoveredMeetings[0].summary, '복구된 회의록');

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(500);
    const meetingsAfterSecondReload = await page.evaluate(() => new Promise((resolve, reject) => {
      const request = indexedDB.open('MeetingHistoryDB');
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result;
        const getAllRequest = db.transaction('meetings', 'readonly').objectStore('meetings').getAll();
        getAllRequest.onerror = () => reject(getAllRequest.error);
        getAllRequest.onsuccess = () => resolve(getAllRequest.result);
      };
    }));
    assert.equal(meetingsAfterSecondReload.length, 1);
    assert.equal(meetingsAfterSecondReload[0].id, 'existing-local-meeting-001');
    assert.equal(meetingsAfterSecondReload[0].analysisStatus, 'completed');
    assert.equal(meetingsAfterSecondReload[0].title, '사용자가 수정한 제목');
    assert.equal(meetingsAfterSecondReload[0].meetingPurpose, '사용자가 수정한 회의 목적');
    assert.equal(meetingsAfterSecondReload[0].folderId, 'edited-folder-001');
    assert.equal(meetingsAfterSecondReload[0].pinned, true);
    await expectNoText(page, '진행 중이던 분석 기록');
    console.log('ok - active draft backend sync scenario');
  } finally {
    await context.close();
  }
};

const runRemoteTerminalTranscriptRecoveryScenario = async (browser, fixtureUpload) => {
  for (const testCase of [
    { name: 'failed', remoteStatus: 'failed', recoverableStatus: 200, expectedAnalysisStatus: 'diarization_failed', expectedLabel: '참석자 구분 실패' },
    { name: 'stopped', remoteStatus: 'stopped', recoverableStatus: 200, expectedAnalysisStatus: 'diarization_stopped', expectedLabel: '구분 중지' },
    { name: 'failed-recovery-unavailable', remoteStatus: 'failed', recoverableStatus: 500, expectedAnalysisStatus: 'diarization_failed', expectedLabel: '참석자 구분 실패' },
    { name: 'stopped-recovery-unavailable', remoteStatus: 'stopped', recoverableStatus: 500, expectedAnalysisStatus: 'diarization_stopped', expectedLabel: '구분 중지' },
    { name: 'cancelled-crash-recovery', remoteStatus: 'missing', recoverableStatus: 404, expectedAnalysisStatus: null, expectedLabel: null, pendingCancellation: true },
  ]) {
    const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
    const page = await context.newPage();
    const jobId = `remote-${testCase.name}-job`;
    let draftStatusRequestCount = 0;
    let recoverableResultRequestCount = 0;
    let releaseRemoteStatus = () => {};
    const remoteStatusCanReturn = new Promise(resolve => {
      releaseRemoteStatus = resolve;
    });
    let releaseCleanup = () => {};
    const cleanupCanReturn = new Promise(resolve => {
      releaseCleanup = resolve;
    });
    await context.addInitScript(({ jobId: storedJobId, fixture, pendingCancellation }) => {
      window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([{
        jobId: storedJobId,
        title: `${storedJobId} 회의록`,
        date: '2026-05-13T09:30',
        meetingPurpose: '원격 종료 상태 복구 확인',
        sourceFilename: fixture.name,
        sourceSize: fixture.size,
        sourceLastModified: fixture.lastModified,
        status: 'active',
        createdAt: '2026-05-13T09:30:00.000Z',
        updatedAt: '2026-05-13T09:45:00.000Z',
        stage: 'diarizing',
        transcriptReady: true,
      }]));
      if (pendingCancellation) {
        window.localStorage.setItem('pendingCancelledAnalysisCleanups', JSON.stringify([storedJobId]));
        window.localStorage.setItem('pendingAnalysisDraftCleanups', JSON.stringify([storedJobId]));
      }
    }, { jobId, fixture: fixtureUpload, pendingCancellation: Boolean(testCase.pendingCancellation) });
    await installBaseRoutes(page);
    await page.route('**/api/analyze/drafts/*', async route => {
      await cleanupCanReturn;
      return route.fulfill({ status: 404, contentType: 'application/json', body: '{}' });
    });
    await page.route('**/api/analyze/draft-statuses', async route => {
      draftStatusRequestCount += 1;
      await remoteStatusCanReturn;
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ drafts: [{
          job_id: jobId,
          status: testCase.remoteStatus,
          stage: testCase.remoteStatus,
          active: false,
          resume_supported: true,
          completed_chunk_count: 1,
          last_progress: { transcript_ready: true },
        }] }),
      });
    });
    await page.route('**/recoverable-result', route => {
      recoverableResultRequestCount += 1;
      return route.fulfill({
        status: testCase.recoverableStatus,
        contentType: 'application/json',
        body: JSON.stringify({
          job_id: jobId,
          source_file: fixtureUpload.name,
          partial: true,
          summary: '중간 저장 회의록',
          segments: [{ start: '00:00', end: '00:02', speaker: '', text: '복구된 중간 대화록' }],
          display_segments: [{ start: '00:00', end: '00:02', speaker: '', text: '복구된 중간 대화록' }],
          diarization_applied: false,
          diarization_requested: true,
          outputs: { job_id: jobId },
        }),
      });
    });
    try {
      await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
      await page.evaluate(({ meetingJobId }) => new Promise((resolve, reject) => {
        const request = indexedDB.open('MeetingHistoryDB', 2);
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result;
          const transaction = db.transaction('meetings', 'readwrite');
          transaction.objectStore('meetings').put({
            id: meetingJobId,
            jobId: meetingJobId,
            date: '2026-05-13 09:30',
            title: `${meetingJobId} 회의록`,
            participants: '',
            meetingPurpose: '원격 종료 상태 복구 확인',
            summary: '중간 저장 회의록',
            segments: [{ start: '00:00', end: '00:02', speaker: '', text: '저장된 중간 대화록' }],
            displaySegments: [{ start: '00:00', end: '00:02', speaker: '', text: '저장된 중간 대화록' }],
            analysisStatus: 'diarization_in_progress',
          });
          transaction.oncomplete = () => { db.close(); resolve(); };
          transaction.onerror = () => reject(transaction.error);
        };
      }), { meetingJobId: jobId });
      releaseCleanup();
      releaseRemoteStatus();
      if (testCase.pendingCancellation) {
        await page.waitForFunction(expectedJobId => {
          const drafts = JSON.parse(window.localStorage.getItem('analysisResumeDrafts') ?? '[]');
          return drafts.every(draft => draft.jobId !== expectedJobId);
        }, jobId, { timeout: 10000 });
      } else {
        await page.waitForFunction(({ expectedStatus, expectedJobId }) => {
          const drafts = JSON.parse(window.localStorage.getItem('analysisResumeDrafts') ?? '[]');
          return drafts.some(draft => draft.jobId === expectedJobId && draft.status === expectedStatus);
        }, { expectedStatus: testCase.remoteStatus, expectedJobId: jobId }, { timeout: 10000 });
      }
      await page.waitForFunction(({ expectedAnalysisStatus, expectedJobId }) => new Promise(resolve => {
        const request = indexedDB.open('MeetingHistoryDB');
        request.onerror = () => resolve(false);
        request.onsuccess = () => {
          const db = request.result;
          const getAllRequest = db.transaction('meetings', 'readonly').objectStore('meetings').getAll();
          getAllRequest.onerror = () => resolve(false);
          getAllRequest.onsuccess = () => resolve(expectedAnalysisStatus
            ? getAllRequest.result.some(meeting => meeting.jobId === expectedJobId && meeting.analysisStatus === expectedAnalysisStatus)
            : getAllRequest.result.every(meeting => meeting.jobId !== expectedJobId));
        };
      }), { expectedAnalysisStatus: testCase.expectedAnalysisStatus, expectedJobId: jobId }, { timeout: 10000 });
      if (testCase.expectedLabel) {
        await page.getByText(testCase.expectedLabel, { exact: true }).first().waitFor({ timeout: 10000 });
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
      if (testCase.expectedAnalysisStatus) {
        assert.equal(meetings.length, 1);
        assert.equal(meetings[0].jobId, jobId);
        assert.equal(meetings[0].analysisStatus, testCase.expectedAnalysisStatus);
      } else {
        assert.equal(meetings.filter(meeting => meeting.jobId === jobId).length, 0);
      }
      await page.waitForTimeout(300);
      assert.ok(draftStatusRequestCount <= 2, `${testCase.name} should stabilize draft status synchronization`);
      assert.ok(recoverableResultRequestCount <= 2, `${testCase.name} should stabilize recoverable-result synchronization`);
    } catch (error) {
      console.error(`remote ${testCase.name} body:`, (await page.locator('body').innerText()).slice(0, 3000));
      throw error;
    } finally {
      await context.close();
    }
  }
  console.log('ok - remote terminal transcript recovery scenario');
};

const runInvalidResumeDraftScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let analyzeCalled = false;

  const draft = {
    jobId: 'stale-draft-job-001',
    title: '오래된 분석',
    date: '2026-05-13T09:30',
    meetingPurpose: '오래된 분석 정리 확인',
    sourceFilename: 'resume-draft-target.mp4',
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'failed',
    createdAt: '2026-05-13T09:30:00.000Z',
    updatedAt: '2026-05-13T09:45:00.000Z',
    stage: 'failed',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 20,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [
        {
          job_id: 'stale-draft-job-001',
          status: 'failed',
          stage: 'failed',
          updated_at: '2026-05-13T09:45:00.000Z',
          resume_supported: true,
          completed_chunk_count: 1,
          last_progress: {
            message: 'Transcribing chunk 1/4...',
            progress: 20,
            status: 'failed',
          },
        },
      ],
    }),
  }));
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ candidates: [], recommended_job_id: null }),
  }));
  await page.route('**/api/analyze', route => {
    analyzeCalled = true;
    return route.abort();
  });

    try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await selectSidebarResumeDraft(page, '오래된 분석');
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.locator('.app-panel').first().getByRole('button', { name: '이어하기', exact: true }).click();
    await page.getByText('이전 분석 기록을 이어서 진행할 수 없습니다. 현재 재사용 후보로 확인되지 않았습니다. 새 분석으로 시작할 수 있습니다.').waitFor({ timeout: 10000 });
    await page.waitForFunction(() => {
      const stored = window.localStorage.getItem('analysisResumeDrafts');
      const parsed = JSON.parse(stored ?? '[]');
      return parsed[0]?.status === 'unavailable' && parsed[0]?.resumeUnavailableReason === 'not-candidate';
    }, undefined, { timeout: 10000 });
    assert.equal(analyzeCalled, false);
    const storedDrafts = await page.evaluate(() => window.localStorage.getItem('analysisResumeDrafts'));
    const parsedDrafts = JSON.parse(storedDrafts ?? '[]');
    assert.equal(parsedDrafts.length, 1);
    assert.equal(parsedDrafts[0].status, 'unavailable');
    assert.equal(parsedDrafts[0].resumeUnavailableReason, 'not-candidate');
    console.log('ok - invalid resume draft scenario');
  } finally {
    await context.close();
  }
};

const runSuppressedResumeCandidateScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  page.on('pageerror', error => console.error('suppressed scenario page error:', error));
  let analyzeRequestSnapshot = null;
  let dialogShown = false;

  const suppressedKey = `${fixtureUpload.name}::${fixtureUpload.size}::${fixtureUpload.lastModified}`;

  await context.addInitScript(value => {
    window.localStorage.setItem('suppressedResumeCandidateKeys', JSON.stringify([value]));
    window.localStorage.setItem('analysisResumeDrafts', '[]');
  }, suppressedKey);

  page.on('dialog', async dialog => {
    dialogShown = true;
    await dialog.dismiss();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      recommended_job_id: 'suppressed-job-001',
      candidates: [
        {
          job_id: 'suppressed-job-001',
          stage: 'transcribing',
          updated_at: '2026-05-13T10:10:00',
          resume_supported: true,
          active: false,
          chunk_count: 4,
          completed_chunk_count: 2,
          last_progress: {
            message: 'Transcribing chunk 2/4...',
            progress: 55,
            status: 'processing',
          },
        },
      ],
    }),
  }));

  await page.route('**/api/analyze', async route => {
    const postData = await route.request().postDataBuffer();
    analyzeRequestSnapshot = postData.toString('utf-8');
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        'event: progress',
        'data: {"type":"progress","progress":5,"message":"업로드 파일 저장 완료","status":"processing"}',
        '',
        'event: result',
        'data: {"type":"result","progress":100,"status":"completed","summary":"fresh summary","segments":[{"start":"00:00","end":"00:02","speaker":"SPEAKER_00","text":"회의를 시작합니다."}],"generation_status":{"summary":"completed"},"meeting":{"source_file":"resume-draft-target.mp4","job_id":"fresh-job-001"},"outputs":{"job_id":"fresh-job-001","json":"/api/outputs/fresh-job-001/json","txt":"/api/outputs/fresh-job-001/txt","md":null,"docx":null,"hwpx":null},"resume":{"requested":false,"mode":"fresh_start","message":"","reused_chunk_count":0}}',
        '',
        'event: done',
        'data: [DONE]',
        '',
      ].join('\n'),
    });
  });

  try {
    await waitForApp(APP_URL);
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('회의 제목 *').fill('suppressed resume candidate');
    await page.getByLabel('회의 목적 *').fill('재개 후보 숨김 동작을 확인');
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByRole('button', { name: '분석 시작' }).click();
    await page.getByText('분석이 완료되었습니다').waitFor({ timeout: 10000 });
    const completionPanel = page.locator('.writer-panel .writer-completion-panel');
    await completionPanel.waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.writer-panel .writer-action-bar').count(), 0, 'the ready command bar must not compete with the completed result');
    await completionPanel.getByRole('button', { name: '결과 보기' }).waitFor({ timeout: 10000 });
    await page.getByText('기록 정리에서 핵심 결과를 확인하세요.', { exact: false }).waitFor({ timeout: 10000 });
    assert.equal(dialogShown, false);
    assert.match(analyzeRequestSnapshot ?? '', /name="resume_requested"\r\n\r\nfalse/);
    await page.getByRole('button', { name: '결과 보기' }).click();
    await page.getByRole('tab', { name: '기록 정리' }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('tab', { name: '기록 정리' }).getAttribute('aria-selected'), 'true');
    await page.locator('.meeting-detail-shell').getByText('fresh summary', { exact: true }).waitFor({ timeout: 10000 });
    console.log('ok - suppressed resume candidate scenario');
  } finally {
    await context.close();
  }
};

const runSuppressedActiveCandidateBlocksFreshStartScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let analyzeCalled = false;
  const suppressedKey = `${fixtureUpload.name}::${fixtureUpload.size}::${fixtureUpload.lastModified}`;

  await context.addInitScript(value => {
    window.localStorage.setItem('suppressedResumeCandidateKeys', JSON.stringify([value]));
    window.localStorage.setItem('analysisResumeDrafts', '[]');
  }, suppressedKey);

  await installBaseRoutes(page);
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      recommended_job_id: 'suppressed-active-job',
      candidates: [{
        job_id: 'suppressed-active-job',
        stage: 'transcribing',
        updated_at: '2026-05-14T12:00:00.000Z',
        resume_supported: true,
        active: true,
        chunk_count: 4,
        completed_chunk_count: 2,
        last_progress: {
          message: 'Transcribing chunk 2/4...',
          progress: 50,
          status: 'processing',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze', route => {
    analyzeCalled = true;
    return route.abort();
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByLabel('회의 제목 *').fill('suppressed active candidate');
    await page.getByLabel('회의 목적 *').fill('진행 중 후보는 억제와 무관하게 차단');
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByRole('button', { name: '분석 시작' }).click();
    await page.getByText('같은 파일의 분석이 이미 진행 중입니다. 완료되거나 취소된 뒤 다시 시도해 주세요.').waitFor({ timeout: 10000 });
    assert.equal(analyzeCalled, false);
    console.log('ok - suppressed active candidate blocks fresh start scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runSelectedResumeFreshStartScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let analyzeRequestSnapshot = null;
  let dialogShown = false;

  const draft = {
    jobId: 'fresh-choice-draft-job',
    title: '새 분석 선택 회의',
    date: '2026-05-14T10:00',
    meetingPurpose: '이어하기 대신 새 분석 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-14T10:00:00.000Z',
    updatedAt: '2026-05-14T10:15:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 2/4...',
    lastProgress: 50,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);

  page.on('dialog', async dialog => {
    dialogShown = true;
    await dialog.dismiss();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: 'fresh-choice-draft-job',
        status: 'cancelled',
        stage: 'cancelled',
        updated_at: '2026-05-14T10:15:00.000Z',
        resume_supported: true,
        completed_chunk_count: 2,
        last_progress: {
          message: 'Transcribing chunk 2/4...',
          progress: 50,
          status: 'cancelled',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      recommended_job_id: 'fresh-choice-draft-job',
      candidates: [{
        job_id: 'fresh-choice-draft-job',
        stage: 'transcribing',
        updated_at: '2026-05-14T10:15:00.000Z',
        resume_supported: true,
        active: false,
        chunk_count: 4,
        completed_chunk_count: 2,
        last_progress: {
          message: 'Transcribing chunk 2/4...',
          progress: 50,
          status: 'cancelled',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze', async route => {
    const postData = await route.request().postDataBuffer();
    analyzeRequestSnapshot = postData.toString('utf-8');
    return route.fulfill({
      status: 200,
      contentType: 'text/event-stream',
      body: [
        'event: progress',
        'data: {"type":"progress","progress":5,"message":"업로드 파일 저장 완료","status":"processing"}',
        '',
        'event: result',
        'data: {"type":"result","progress":100,"status":"completed","summary":"정리는 회의 기록에서 별도로 실행할 수 있습니다.","segments":[{"start":"00:00","end":"00:02","speaker":"SPEAKER_00","text":"후속 회의를 시작합니다."}],"generation_status":{"summary":"skipped"},"meeting":{"source_file":"resume-draft-target.mp4","job_id":"fresh-choice-new-job"},"outputs":{"job_id":"fresh-choice-new-job","json":"/api/outputs/fresh-choice-new-job/json","txt":"/api/outputs/fresh-choice-new-job/txt","md":null,"docx":null,"hwpx":null},"resume":{"requested":false,"mode":"fresh_start","message":"","reused_chunk_count":0}}',
        '',
        'event: done',
        'data: [DONE]',
        '',
      ].join('\n'),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /미완료 분석 기록 1건/ }).click();
    await page.locator('.sidebar-resume-draft-button').filter({ hasText: '새 분석 선택 회의' }).click();
    await page.getByRole('heading', { name: '이어하기' }).waitFor({ timeout: 10000 });
    await page.setInputFiles('#meeting-file-input', fixtureUpload.path);
    await page.getByRole('button', { name: '새 분석', exact: true }).click();
    await page.getByRole('heading', { name: '새 회의록' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '분석 시작' }).click();
    await page.getByText('분석이 완료되었습니다').waitFor({ timeout: 10000 });
    await page.getByText('대화록을 확인하고 필요한 정리를 실행하세요.', { exact: false }).waitFor({ timeout: 10000 });
    const completionPanel = page.locator('.writer-panel .writer-completion-panel');
    await completionPanel.waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.writer-panel .writer-action-bar').count(), 0, 'the completed result should stay in the writer action slot');
    await completionPanel.getByRole('button', { name: '결과 보기' }).waitFor({ timeout: 10000 });
    assert.equal(dialogShown, false);
    assert.doesNotMatch(analyzeRequestSnapshot ?? '', /name="job_id"\r\n\r\nfresh-choice-draft-job/);
    assert.match(analyzeRequestSnapshot ?? '', /name="resume_requested"\r\n\r\nfalse/);
    await page.getByRole('button', { name: '결과 보기' }).click();
    await page.getByRole('tab', { name: '대화록' }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('tab', { name: '대화록' }).getAttribute('aria-selected'), 'true');
    await page.getByText('후속 회의를 시작합니다.', { exact: true }).waitFor({ timeout: 10000 });
    console.log('ok - selected resume can start fresh scenario');
  } catch (error) {
    console.error(error);
    console.error('analyzeRequestSnapshot:', analyzeRequestSnapshot);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runActiveDraftDeleteAfterBackendErrorScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const draft = {
    jobId: 'stale-active-delete-job',
    title: '삭제할 진행 기록',
    date: '2026-05-15T11:00',
    meetingPurpose: '오래된 진행 기록 삭제 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'active',
    createdAt: '2026-05-15T11:00:00.000Z',
    updatedAt: '2026-05-15T11:10:00.000Z',
    stage: 'transcribing',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /진행 중이던 분석 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 500,
    contentType: 'text/plain',
    body: 'Python interpreter failed to start',
  }));
  await page.route('**/api/analyze/drafts/stale-active-delete-job', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ job_id: 'stale-active-delete-job', deleted: ['jobs/stale-active-delete-job'] }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('button', { name: /미완료 분석 기록 1건/ }).click();
    await page.locator('.sidebar-resume-draft-button').filter({ hasText: '삭제할 진행 기록' }).click();
    await page.getByRole('heading', { name: '분석 상태' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '삭제할 진행 기록 분석 기록 삭제', exact: true }).click();
    await expectLocalStorageJson(page, 'analysisResumeDrafts', []);
    const bodyText = await page.locator('body').innerText();
    assert.doesNotMatch(bodyText, /Python interpreter/);
    console.log('ok - active draft delete after backend error scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runLocalOnlyDeleteRetriesPendingCleanupScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();
  let deleteCalls = 0;

  const draft = {
    jobId: 'pending-cleanup-delete-job',
    title: '나중에 정리할 기록',
    date: '2026-05-15T11:20',
    meetingPurpose: '백엔드 일시 실패 후 정리 재시도 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-15T11:20:00.000Z',
    updatedAt: '2026-05-15T11:25:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
    window.localStorage.setItem('pendingAnalysisDraftCleanups', '[]');
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /이전 분석 진행 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: 'pending-cleanup-delete-job',
        status: 'cancelled',
        stage: 'cancelled',
        updated_at: '2026-05-15T11:25:00.000Z',
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: {
          message: 'Transcribing chunk 1/4...',
          progress: 25,
          status: 'cancelled',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze/drafts/**', route => {
    deleteCalls += 1;
    if (deleteCalls === 1) return route.abort('failed');
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: 'pending-cleanup-delete-job', deleted: ['jobs/pending-cleanup-delete-job'] }),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await selectSidebarResumeDraft(page, '나중에 정리할 기록');
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: '나중에 정리할 기록 분석 기록 삭제', exact: true }).click();
    await expectLocalStorageJson(page, 'analysisResumeDrafts', []);
    await page.waitForFunction(() => {
      const pendingRaw = window.localStorage.getItem('pendingAnalysisDraftCleanups');
      return pendingRaw === '[]';
    }, undefined, { timeout: 10000 });
    assert.equal(deleteCalls >= 2, true);
    console.log('ok - local-only delete retries pending cleanup scenario');
  } catch (error) {
    console.error(error);
    console.error('deleteCalls:', deleteCalls);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runDeleteServerErrorKeepsDraftScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const draft = {
    jobId: 'delete-server-error-job',
    title: '삭제 실패 기록',
    date: '2026-05-15T11:30',
    meetingPurpose: '삭제 실패 시 유지 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-15T11:30:00.000Z',
    updatedAt: '2026-05-15T11:35:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /이전 분석 진행 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: 'delete-server-error-job',
        status: 'cancelled',
        stage: 'cancelled',
        updated_at: '2026-05-15T11:35:00.000Z',
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: {
          message: 'Transcribing chunk 1/4...',
          progress: 25,
          status: 'cancelled',
        },
      }],
    }),
  }));
  let deleteRouteCalled = false;
  await page.route('**/api/analyze/drafts/**', route => {
    deleteRouteCalled = true;
    return route.fulfill({
    status: 500,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'delete failed' }),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await selectSidebarResumeDraft(page, '삭제 실패 기록');
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: '삭제 실패 기록 분석 기록 삭제', exact: true }).click();
    await page.getByText('분석 임시 파일을 정리하지 못했습니다.').waitFor({ timeout: 10000 });
    assert.equal(deleteRouteCalled, true);
    await page.waitForFunction(() => {
      const stored = window.localStorage.getItem('analysisResumeDrafts');
      const parsed = JSON.parse(stored ?? '[]');
      return parsed.length === 1 && parsed[0]?.jobId === 'delete-server-error-job';
    }, undefined, { timeout: 10000 });
    console.log('ok - delete server error keeps draft scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runActiveDraftNetworkFailureKeepsDraftScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const draft = {
    jobId: 'active-network-delete-job',
    title: '확인 불가 진행 기록',
    date: '2026-05-15T11:45',
    meetingPurpose: '진행 상태 확인 실패 시 삭제 보류',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'active',
    createdAt: '2026-05-15T11:45:00.000Z',
    updatedAt: '2026-05-15T11:50:00.000Z',
    stage: 'transcribing',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
    window.localStorage.setItem('pendingAnalysisDraftCleanups', '[]');
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /진행 중이던 분석 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 500,
    contentType: 'text/plain',
    body: 'backend unavailable',
  }));
  await page.route('**/api/analyze/drafts/**', route => route.abort('failed'));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await selectSidebarResumeDraft(page, '확인 불가 진행 기록');
    await page.getByRole('button', { name: '확인 불가 진행 기록 분석 기록 삭제', exact: true }).click();
    await page.waitForFunction(() => {
      const drafts = JSON.parse(window.localStorage.getItem('analysisResumeDrafts') ?? '[]');
      const pending = JSON.parse(window.localStorage.getItem('pendingAnalysisDraftCleanups') ?? '[]');
      return drafts.length === 1 && drafts[0]?.jobId === 'active-network-delete-job' && pending.length === 0;
    }, undefined, { timeout: 10000 });
    console.log('ok - active draft network failure keeps draft scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runDeleteDoesNotSuppressFileCandidateScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const draft = {
    jobId: 'delete-no-suppress-job',
    title: '삭제만 할 기록',
    date: '2026-05-15T11:55',
    meetingPurpose: '삭제가 후보 숨김으로 이어지지 않는지 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-15T11:55:00.000Z',
    updatedAt: '2026-05-15T11:58:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
    window.localStorage.setItem('suppressedResumeCandidateKeys', '[]');
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /이전 분석 진행 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: 'delete-no-suppress-job',
        status: 'cancelled',
        stage: 'cancelled',
        updated_at: '2026-05-15T11:58:00.000Z',
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: {
          message: 'Transcribing chunk 1/4...',
          progress: 25,
          status: 'cancelled',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze/drafts/delete-no-suppress-job', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ job_id: 'delete-no-suppress-job', deleted: ['jobs/delete-no-suppress-job'] }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await selectSidebarResumeDraft(page, '삭제만 할 기록');
    await page.waitForTimeout(800);
    await page.getByRole('button', { name: '삭제만 할 기록 분석 기록 삭제', exact: true }).click();
    await expectLocalStorageJson(page, 'analysisResumeDrafts', []);
    await expectLocalStorageJson(page, 'suppressedResumeCandidateKeys', []);
    console.log('ok - delete does not suppress file candidate scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const runCancelledDraftImmediateDeleteScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 960 } });
  const page = await context.newPage();

  const draft = {
    jobId: 'cancelled-immediate-delete-job',
    title: '방금 중단한 기록',
    date: '2026-05-15T12:00',
    meetingPurpose: '중단 직후 삭제 확인',
    sourceFilename: fixtureUpload.name,
    sourceSize: fixtureUpload.size,
    sourceLastModified: fixtureUpload.lastModified,
    status: 'cancelled',
    createdAt: '2026-05-15T12:00:00.000Z',
    updatedAt: '2026-05-15T12:05:00.000Z',
    stage: 'cancelled',
    lastMessage: 'Transcribing chunk 1/4...',
    lastProgress: 25,
  };

  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
  }, draft);

  page.on('dialog', async dialog => {
    assert.match(dialog.message(), /이전 분석 진행 기록을 삭제할까요/);
    await dialog.accept();
  });

  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      drafts: [{
        job_id: 'cancelled-immediate-delete-job',
        status: 'cancelled',
        stage: 'cancelled',
        updated_at: '2026-05-15T12:05:00.000Z',
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: {
          message: 'Transcribing chunk 1/4...',
          progress: 25,
          status: 'cancelled',
        },
      }],
    }),
  }));
  await page.route('**/api/analyze/drafts/cancelled-immediate-delete-job', route => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'analysis_job_active' }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await selectSidebarResumeDraft(page, '방금 중단한 기록');
    await page.getByRole('button', { name: '방금 중단한 기록 분석 기록 삭제', exact: true }).click();
    await expectLocalStorageJson(page, 'analysisResumeDrafts', []);
    const bodyText = await page.locator('body').innerText();
    assert.doesNotMatch(bodyText, /아직 진행 중인 분석입니다/);
    console.log('ok - cancelled draft immediate delete scenario');
  } catch (error) {
    console.error(error);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 4000));
    throw error;
  } finally {
    await context.close();
  }
};

const expectValue = async (page, selector, expected) => {
  await page.waitForFunction(
    ({ selector: nextSelector, expected: nextExpected }) => {
      const element = document.querySelector(nextSelector);
      return (
        element instanceof HTMLInputElement
        || element instanceof HTMLSelectElement
        || element instanceof HTMLTextAreaElement
      ) && element.value === nextExpected;
    },
    { selector, expected },
  );
};

const expectLocalStorageJson = async (page, key, expected) => {
  await page.waitForFunction(
    ({ storageKey, expectedValue }) => {
      const raw = window.localStorage.getItem(storageKey);
      return raw === JSON.stringify(expectedValue);
    },
    { storageKey: key, expectedValue: expected },
  );
};

const selectSidebarResumeDraft = async (page, title) => {
  const toggle = page.getByRole('button', { name: /미완료 분석 기록 \d+건/ });
  if (await toggle.getAttribute('aria-expanded') !== 'true') {
    await toggle.click();
  }
  await page.locator('.sidebar-resume-draft-button').filter({ hasText: title }).click();
  await page.getByRole('heading', { name: /이어하기|분석 상태/ }).waitFor({ timeout: 10000 });
};

const createRecoveryDraft = (jobId, title, fixtureUpload, overrides = {}) => ({
  jobId,
  title,
  date: '2026-08-13T09:00',
  participants: '',
  meetingPurpose: '복구 계약 확인',
  sourceFilename: fixtureUpload.name,
  sourceSize: fixtureUpload.size,
  sourceLastModified: fixtureUpload.lastModified,
  status: 'active',
  createdAt: '2026-08-13T09:00:00.000Z',
  updatedAt: '2026-08-13T09:05:00.000Z',
  stage: 'transcribing',
  lastMessage: '음성 인식 중',
  lastProgress: 30,
  resumeEligible: true,
  completedChunkCount: 1,
  ...overrides,
});

const runPendingCancelledCleanupKeepsGlobalLockScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const draft = createRecoveryDraft('pending-cancel-lock-job', '취소 정리 대기', fixtureUpload, {
    status: 'cancelled',
    stage: 'cancelled',
  });
  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
    window.localStorage.setItem('pendingAnalysisDraftCleanups', JSON.stringify([value.jobId]));
    window.localStorage.setItem('pendingCancelledAnalysisCleanups', JSON.stringify([value.jobId]));
  }, draft);
  const page = await context.newPage();
  await installBaseRoutes(page);
  await page.route('**/api/analyze/drafts/pending-cancel-lock-job', route => route.fulfill({
    status: 409,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'analysis_job_active' }),
  }));
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ drafts: [{
      job_id: draft.jobId,
      status: 'active',
      stage: 'transcribing',
      active: true,
      resume_supported: true,
      completed_chunk_count: 1,
      last_progress: { message: '음성 인식 중', progress: 30 },
    }] }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    const createButton = page.getByRole('button', { name: '새 기록', exact: true });
    await createButton.waitFor({ timeout: 10000 });
    assert.equal(await createButton.isDisabled(), true, 'pending cancellation must keep new analysis locked');
    await page.waitForTimeout(400);
    const stored = await page.evaluate(() => ({
      drafts: JSON.parse(window.localStorage.getItem('analysisResumeDrafts') || '[]'),
      pending: JSON.parse(window.localStorage.getItem('pendingCancelledAnalysisCleanups') || '[]'),
    }));
    assert.equal(stored.drafts.some(item => item.jobId === draft.jobId), true);
    assert.deepEqual(stored.pending, [draft.jobId]);
    console.log('ok - pending cancelled cleanup keeps global lock scenario');
  } finally {
    await context.close();
  }
};

const runCompletedJobPreservesSameFileActiveJobScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const completedDraft = createRecoveryDraft('same-file-completed-job', '완료된 분석', fixtureUpload);
  const activeDraft = createRecoveryDraft('same-file-active-job', '계속 진행 중인 분석', fixtureUpload, {
    updatedAt: '2026-08-13T09:06:00.000Z',
  });
  await context.addInitScript(values => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify(values));
  }, [completedDraft, activeDraft]);
  const page = await context.newPage();
  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ drafts: [
      {
        job_id: completedDraft.jobId,
        status: 'completed',
        stage: 'completed',
        resume_supported: false,
        completed_chunk_count: 2,
        last_progress: { message: '완료', progress: 100, transcript_ready: true },
      },
      {
        job_id: activeDraft.jobId,
        status: 'active',
        stage: 'transcribing',
        active: true,
        resume_supported: true,
        completed_chunk_count: 1,
        last_progress: { message: '음성 인식 중', progress: 40 },
      },
    ] }),
  }));
  await page.route('**/api/analyze/same-file-completed-job/recoverable-result', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      job_id: completedDraft.jobId,
      source_file: fixtureUpload.name,
      summary: '완료 결과',
      segments: [{ start: '00:00', end: '00:01', speaker: '', text: '완료된 대화록' }],
      display_segments: [{ start: '00:00', end: '00:01', speaker: '', text: '완료된 대화록' }],
      outputs: { job_id: completedDraft.jobId },
    }),
  }));

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(({ completedJobId, activeJobId }) => {
      const drafts = JSON.parse(window.localStorage.getItem('analysisResumeDrafts') || '[]');
      return drafts.find(item => item.jobId === completedJobId)?.status === 'completed'
        && drafts.find(item => item.jobId === activeJobId)?.status === 'active';
    }, { completedJobId: completedDraft.jobId, activeJobId: activeDraft.jobId });
    await page.waitForTimeout(300);
    const statuses = await page.evaluate(() => Object.fromEntries(
      JSON.parse(window.localStorage.getItem('analysisResumeDrafts') || '[]')
        .map(item => [item.jobId, item.status]),
    ));
    assert.equal(statuses[completedDraft.jobId], 'completed');
    assert.equal(statuses[activeDraft.jobId], 'active');
    assert.equal(await page.getByRole('button', { name: '새 기록', exact: true }).isDisabled(), true);
    console.log('ok - completed job preserves same-file active job scenario');
  } finally {
    await context.close();
  }
};

const runCompletedImportFailureIsBoundedScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const draft = createRecoveryDraft('completed-import-failure-job', '결과 가져오기 실패', fixtureUpload, {
    status: 'stopped',
    stage: 'stopped',
  });
  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
    const originalSetItem = Storage.prototype.setItem;
    let recoveringResultWriteFailed = false;
    Storage.prototype.setItem = function setItem(key, nextValue) {
      if (
        key === 'analysisResumeDrafts'
        && !recoveringResultWriteFailed
        && String(nextValue).includes('recovering-result')
      ) {
        recoveringResultWriteFailed = true;
        throw new DOMException('simulated recovering-result write failure', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, nextValue);
    };
    window.__recoveringResultWriteFailed = () => recoveringResultWriteFailed;
  }, draft);
  const page = await context.newPage();
  let recoverableRequestCount = 0;
  await installBaseRoutes(page);
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ drafts: [{
      job_id: draft.jobId,
      status: 'completed',
      stage: 'completed',
      resume_supported: false,
      completed_chunk_count: 2,
      last_progress: { message: '완료', progress: 100, transcript_ready: true },
    }] }),
  }));
  await page.route('**/api/analyze/completed-import-failure-job/recoverable-result', route => {
    recoverableRequestCount += 1;
    if (recoverableRequestCount > 2) {
      return route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          job_id: draft.jobId,
          source_file: fixtureUpload.name,
          summary: '재시도 후 가져온 완료 결과',
          segments: [{ start: '00:00', end: '00:01', speaker: '', text: '복구된 대화록' }],
          display_segments: [{ start: '00:00', end: '00:01', speaker: '', text: '복구된 대화록' }],
          outputs: { job_id: draft.jobId },
        }),
      });
    }
    return route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'temporary failure' }),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(jobId => {
      const drafts = JSON.parse(window.localStorage.getItem('analysisResumeDrafts') || '[]');
      return drafts.find(item => item.jobId === jobId)?.errorMessage?.includes('가져오지 못했습니다');
    }, draft.jobId);
    await page.waitForTimeout(800);
    assert.ok(recoverableRequestCount <= 2, `completed import retry must be bounded, got ${recoverableRequestCount}`);
    assert.equal(await page.evaluate(() => window.__recoveringResultWriteFailed()), true);
    const pendingDraft = await page.evaluate(jobId => JSON.parse(
      window.localStorage.getItem('analysisResumeDrafts') || '[]',
    ).find(item => item.jobId === jobId), draft.jobId);
    assert.equal(pendingDraft.stage, 'recovering-result');
    assert.equal(pendingDraft.resumeEligible, false);
    const recoveryButton = page.locator('.sidebar-resume-draft-button').filter({ hasText: draft.title });
    if (await recoveryButton.count()) {
      assert.equal(await recoveryButton.isDisabled(), true);
    }
    await page.waitForFunction(jobId => {
      const drafts = JSON.parse(window.localStorage.getItem('analysisResumeDrafts') || '[]');
      return drafts.find(item => item.jobId === jobId)?.status === 'completed';
    }, draft.jobId, { timeout: 15000 });
    assert.equal(recoverableRequestCount, 3);
    console.log('ok - completed import failure is bounded scenario');
  } finally {
    await context.close();
  }
};

const runCleanupLocalRemovalFailureRetriesScenario = async (browser, fixtureUpload) => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const draft = createRecoveryDraft('cleanup-local-removal-retry-job', '로컬 정리 재시도', fixtureUpload, {
    status: 'cancelled',
    stage: 'cancelled',
  });
  await context.addInitScript(value => {
    window.localStorage.setItem('analysisResumeDrafts', JSON.stringify([value]));
    window.localStorage.setItem('pendingAnalysisDraftCleanups', JSON.stringify([value.jobId]));
    window.localStorage.setItem('pendingCancelledAnalysisCleanups', JSON.stringify([value.jobId]));
    const originalSetItem = Storage.prototype.setItem;
    window.__allowCleanupStorageWrites = false;
    Storage.prototype.setItem = function setItem(key, nextValue) {
      if (
        !window.__allowCleanupStorageWrites
        && key === 'analysisResumeDrafts'
        && nextValue === '[]'
      ) {
        throw new DOMException('simulated quota failure', 'QuotaExceededError');
      }
      return originalSetItem.call(this, key, nextValue);
    };
  }, draft);
  const page = await context.newPage();
  let deleteRequestCount = 0;
  await installBaseRoutes(page);
  await page.route('**/api/analyze/drafts/cleanup-local-removal-retry-job', route => {
    deleteRequestCount += 1;
    return route.fulfill({
      status: deleteRequestCount === 1 ? 200 : 404,
      contentType: 'application/json',
      body: JSON.stringify({ job_id: draft.jobId }),
    });
  });

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.waitForFunction(() => window.__allowCleanupStorageWrites === false);
    await page.waitForTimeout(300);
    const retained = await page.evaluate(() => ({
      drafts: JSON.parse(window.localStorage.getItem('analysisResumeDrafts') || '[]'),
      pending: JSON.parse(window.localStorage.getItem('pendingCancelledAnalysisCleanups') || '[]'),
    }));
    assert.equal(retained.drafts.some(item => item.jobId === draft.jobId), true);
    assert.deepEqual(retained.pending, [draft.jobId]);
    assert.equal(await page.getByRole('button', { name: '새 기록', exact: true }).isDisabled(), true);

    await page.evaluate(() => {
      window.__allowCleanupStorageWrites = true;
      window.dispatchEvent(new Event('analysis-recovery:sync-requested'));
    });
    await page.waitForFunction(() => (
      window.localStorage.getItem('analysisResumeDrafts') === '[]'
      && window.localStorage.getItem('pendingCancelledAnalysisCleanups') === '[]'
    ));
    assert.ok(deleteRequestCount >= 1 && deleteRequestCount <= 2);
    assert.equal(await page.getByRole('button', { name: '새 기록', exact: true }).isDisabled(), false);
    console.log('ok - cleanup local removal failure retries scenario');
  } finally {
    await context.close();
  }
};

const expectNoText = async (page, text) => {
  await page.waitForFunction(nextText => !document.body?.innerText.includes(nextText), text);
};

const run = async () => {
  const requestedScenarios = new Set(process.argv.slice(2).filter(argument => argument !== '--'));
  const scenarios = [
    ['writer-layout', runWriterLayoutScenario],
    ['latest-diarization-setting', runLatestDiarizationSettingScenario],
    ['partial-record-failure', runPartialRecordFailureScenario],
    ['cancelled-recovery-import-race', runCancelledRecoveryImportRaceScenario],
    ['completed-meeting-rejects-stale-partial', runCompletedMeetingRejectsStalePartialScenario],
    ['resume-draft', runResumeDraftScenario],
    ['active-draft-backend-sync', runActiveDraftBackendSyncScenario],
    ['remote-terminal-transcript-recovery', runRemoteTerminalTranscriptRecoveryScenario],
    ['invalid-resume-draft', runInvalidResumeDraftScenario],
    ['suppressed-resume-candidate', runSuppressedResumeCandidateScenario],
    ['suppressed-active-candidate-blocks-fresh-start', runSuppressedActiveCandidateBlocksFreshStartScenario],
    ['selected-resume-fresh-start', runSelectedResumeFreshStartScenario],
    ['active-draft-delete-after-backend-error', runActiveDraftDeleteAfterBackendErrorScenario],
    ['local-only-delete-retries-pending-cleanup', runLocalOnlyDeleteRetriesPendingCleanupScenario],
    ['delete-server-error-keeps-draft', runDeleteServerErrorKeepsDraftScenario],
    ['active-draft-network-failure-keeps-draft', runActiveDraftNetworkFailureKeepsDraftScenario],
    ['delete-does-not-suppress-file-candidate', runDeleteDoesNotSuppressFileCandidateScenario],
    ['cancelled-draft-immediate-delete', runCancelledDraftImmediateDeleteScenario],
    ['pending-cancelled-cleanup-keeps-global-lock', runPendingCancelledCleanupKeepsGlobalLockScenario],
    ['completed-job-preserves-same-file-active-job', runCompletedJobPreservesSameFileActiveJobScenario],
    ['completed-import-failure-is-bounded', runCompletedImportFailureIsBoundedScenario],
    ['cleanup-local-removal-failure-retries', runCleanupLocalRemovalFailureRetriesScenario],
  ];
  const selectedScenarios = requestedScenarios.size === 0
    ? scenarios
    : scenarios.filter(([name]) => requestedScenarios.has(name));
  if (selectedScenarios.length !== (requestedScenarios.size || scenarios.length)) {
    const knownScenarios = scenarios.map(([name]) => name).join(', ');
    throw new Error(`Unknown scenario filter. Available scenarios: ${knownScenarios}`);
  }

  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const fixtureUpload = await createFixtureFile();

  try {
    for (const [, scenario] of selectedScenarios) {
      await scenario(browser, fixtureUpload);
    }
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
