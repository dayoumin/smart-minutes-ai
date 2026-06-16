import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const shouldStartServer = !process.env.APP_URL;
const PAGE_GOTO_TIMEOUT_MS = 60000;
const meetingId = 'codex-report-tab-edge-flow';
const jobId = 'codex-report-tab-edge-job';
let summaryReady = false;
let reportAttemptCount = 0;

const waitForApp = async (url, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until Vite is ready.
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
    await Promise.race([
      new Promise(resolve => child.once('exit', resolve)),
      sleep(3000),
    ]);
    if (child.exitCode === null) child.kill();
    child.stdout?.destroy();
    child.stderr?.destroy();
    return;
  }

  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(2000),
  ]);
};

const startServer = async () => {
  if (!shouldStartServer) {
    await waitForApp(APP_URL);
    return null;
  }

  const url = new URL(APP_URL);
  const port = await getAvailablePort(url.hostname);
  url.port = String(port);
  APP_URL = url.toString();
  const command = `corepack pnpm exec vite --host ${url.hostname} --port ${url.port} --strictPort --configLoader runner`;
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

  child.stdout.on('data', data => {
    if (process.env.DEBUG_FLOW_TEST) process.stdout.write(data);
  });
  child.stderr.on('data', data => {
    if (process.env.DEBUG_FLOW_TEST) process.stderr.write(data);
  });

  await waitForApp(APP_URL);
  return child;
};

const installRoutes = async (page) => {
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));

  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      processing: { long_audio_chunk_seconds: 30, enable_long_audio_chunking: true },
      diarization: { enabled: true, generate_during_analysis: false },
      stt: { device: 'cpu' },
      summary: {
        provider: 'ollama',
        model: 'gemma4:e2b',
        model_options: [],
      },
      privacy: { preserve_extracted_audio: true, auto_save_hwpx_copy: false, auto_save_audio_copy: false },
    }),
  }));

  await page.route('**/api/models/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      ready: true,
      summary_ready: summaryReady,
      summary_status: summaryReady ? 'ready' : 'skipped',
      summary_message: summaryReady ? '' : '요약 모델이 준비되지 않아 대화록만 생성했습니다. 요약을 사용하려면 모델 상태를 확인해 주세요.',
      models: [
        { key: 'stt_faster_whisper', label: '음성 인식 기본 모델', installed: true, required: true },
        { key: 'llm', label: 'Gemma via Ollama', installed: summaryReady, configured_model: 'gemma4:e2b', installed_model: summaryReady ? 'gemma4:e2b' : null, installed_models: summaryReady ? ['gemma4:e2b'] : [], required: false },
      ],
    }),
  }));

  await page.route('**/api/outputs/*/audio', route => route.fulfill({
    status: 404,
    contentType: 'audio/wav',
    body: '',
  }));

  await page.route(`**/api/outputs/${jobId}/generate-report`, route => {
    reportAttemptCount += 1;
    if (reportAttemptCount === 1 || reportAttemptCount === 3) {
      return route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ detail: '보고서 생성 실패' }),
      });
    }

    const requestBody = JSON.parse(route.request().postData() ?? '{}');
    const templateId = requestBody.selectedReportTemplateId
      ?? requestBody.selected_report_template_id
      ?? requestBody.reportTemplate?.id
      ?? requestBody.report_template?.id
      ?? 'standard-minutes';
    const requestTemplate = requestBody.reportTemplate ?? requestBody.report_template ?? {};
    if (templateId === 'custom-report-edge') {
      assert.equal(requestTemplate.id, 'custom-report-edge');
      assert.equal(requestTemplate.name, '재생성 검증 보고 양식');
      assert.deepEqual(requestTemplate.sections, ['검증 개요', '보존 확인', '후속 조치']);
      assert.equal(requestTemplate.instructions, '보고서 보존 검증용 양식입니다.');
    }
    const responseSections = templateId === 'custom-report-edge'
      ? ['검증 개요', '보존 확인', '후속 조치']
      : ['보고 개요', '후속 조치'];
    const longWord = `긴본문${'가'.repeat(240)}`;
    const longContent = [
      responseSections[0],
      `보고서 본문은 긴 회의 내용을 여러 문단으로 다룹니다. ${templateId} ${longWord}`,
      '후속 조치와 담당자 확인이 필요합니다.',
    ].join('\n');

    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        meetingReport: {
          templateId,
          generatedAt: '2026-06-16T09:00:00.000Z',
          content: longContent,
          sections: responseSections.map((title, index) => ({
            title,
            content: index === 0 ? longContent : `${title} 확인이 필요합니다.`,
          })),
        },
        generationStatus: {
          summary: 'completed',
          topicSections: 'completed',
          speakerContextSummaries: 'completed',
          meetingReport: 'completed',
        },
        outputs: {},
      }),
    });
  });
};

const seedMeeting = async (page) => {
  await page.evaluate(async ({ meetingId, jobId }) => {
    window.localStorage.setItem('meetingReportTemplates', JSON.stringify([
      {
        id: 'custom-report-edge',
        name: '재생성 검증 보고 양식',
        purpose: '재생성 실패 시 기존 보고서 보존을 확인합니다.',
        instructions: '보고서 보존 검증용 양식입니다.',
        sections: ['검증 개요', '보존 확인', '후속 조치'],
        requiredSections: ['검증 개요', '보존 확인'],
        optionalSections: ['후속 조치'],
        tone: 'report',
        detailLevel: 'standard',
        updatedAt: '2026-06-16T09:00:00.000Z',
      },
    ]));

    const request = indexedDB.open('MeetingHistoryDB', 1);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) {
          db.createObjectStore('meetings', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const meeting = {
      id: meetingId,
      jobId,
      date: '2026-06-16 09:00',
      title: '보고서 탭 경계 상태 검증 회의록',
      summary: '장비 도입과 후속 검토 일정을 정리했습니다.',
      participants: '참석자01, 참석자02',
      meetingPurpose: '보고서 생성 흐름 검증',
      sourceFile: 'report-edge.mp4',
      topics: ['장비 도입'],
      topicSections: [
        {
          topic: '장비 도입',
          summary: '신규 장비 도입 필요성과 자료 전달 방식을 논의했습니다.',
          evidence: ['장비 도입 필요성이 언급되었습니다.'],
          actions: ['도입 일정 확인'],
        },
      ],
      speakerContextSummaries: [
        {
          speaker: 'SPEAKER_00',
          displaySpeaker: '참석자01',
          summary: '장비 도입 필요성을 설명했습니다.',
          keyPoints: ['도입 필요성'],
        },
      ],
      participantSummaries: [
        {
          speaker: 'SPEAKER_00',
          displaySpeaker: '참석자01',
          summary: '장비 도입 필요성을 설명했습니다.',
          keyPoints: ['도입 필요성'],
        },
      ],
      generationStatus: {
        summary: 'completed',
        topicSections: 'completed',
        speakerContextSummaries: 'completed',
        meetingReport: 'not_started',
      },
      transcriptEditMeta: {
        edited: false,
        summaryOutdated: false,
        topicSectionsOutdated: false,
        speakerContextOutdated: false,
      },
      segments: [
        {
          start: '00:00:01',
          end: '00:00:08',
          speaker: 'SPEAKER_00',
          displaySpeaker: '참석자01',
          text: '신규 장비 도입과 자료 전달 방식을 논의했습니다.',
        },
      ],
      editedDisplaySegments: [],
      actions: ['도입 일정 확인'],
      decisions: ['보고 자료를 다시 정리한다.'],
      needsCheck: [],
      selectedReportTemplateId: 'standard-minutes',
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      tx.objectStore('meetings').put(meeting);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { meetingId, jobId });
};

const readMeeting = async (page) => page.evaluate(async ({ meetingId }) => {
  const request = indexedDB.open('MeetingHistoryDB', 1);
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const record = await new Promise((resolve, reject) => {
    const tx = db.transaction('meetings', 'readonly');
    const getRequest = tx.objectStore('meetings').get(meetingId);
    getRequest.onsuccess = () => resolve(getRequest.result);
    getRequest.onerror = () => reject(getRequest.error);
  });
  db.close();
  return record;
}, { meetingId });

const assertNoHorizontalOverflow = async (page) => {
  const overflow = await page.evaluate(() => ({
    documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    reportOverflow: Array.from(document.querySelectorAll('.detail-report-result-section, .detail-report-content'))
      .map(element => element.scrollWidth - element.clientWidth),
  }));
  assert.ok(overflow.documentOverflow <= 2, `document horizontal overflow: ${JSON.stringify(overflow)}`);
  assert.ok(overflow.reportOverflow.every(value => value <= 2), `report horizontal overflow: ${JSON.stringify(overflow)}`);
};

const run = async () => {
  let server;
  let browser;
  let page;
  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 820 } });
    await installRoutes(page);

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    await seedMeeting(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('보고서 탭 경계 상태 검증 회의록').first().click();
    await page.getByRole('tab', { name: '보고서', exact: true }).click();

    const reportButton = page.getByRole('button', { name: '회의록 보고서 생성', exact: true });
    await page.getByText('요약 모델이 준비되지 않아 대화록만 생성했습니다. 요약을 사용하려면 모델 상태를 확인해 주세요.', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await reportButton.isDisabled(), true);

    summaryReady = true;
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('보고서 탭 경계 상태 검증 회의록').first().click();
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    await reportButton.waitFor({ timeout: 10000 });
    assert.equal(await reportButton.isDisabled(), false);
    assert.match(await reportButton.innerText(), /생성/);

    await reportButton.click();
    await page.getByText('보고서를 만들지 못했습니다. 정리 내용과 모델 준비 상태를 확인한 뒤 다시 생성해 주세요.', { exact: true }).waitFor({ timeout: 10000 });
    await page.waitForFunction(async ({ meetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 1);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readonly');
        const getRequest = tx.objectStore('meetings').get(meetingId);
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(getRequest.error);
      });
      db.close();
      return record?.generationStatus?.meetingReport === 'failed';
    }, { meetingId }, { timeout: 10000 });
    assert.match(await reportButton.innerText(), /다시 생성/);

    await reportButton.click();
    await page.getByText('후속 조치와 담당자 확인이 필요합니다.').first().waitFor({ timeout: 10000 });
    let record = await readMeeting(page);
    assert.equal(record.generationStatus.meetingReport, 'completed');
    assert.equal(record.meetingReport.templateId, 'standard-minutes');
    assert.equal(await page.getByText('보고서를 만들지 못했습니다. 정리 내용과 모델 준비 상태를 확인한 뒤 다시 생성해 주세요.', { exact: true }).count(), 0);
    await assertNoHorizontalOverflow(page);

    const reportSelect = page.getByLabel('보고 양식 선택', { exact: true });
    await reportSelect.selectOption('custom-report-edge');
    await page.waitForFunction(async ({ meetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 1);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readonly');
        const getRequest = tx.objectStore('meetings').get(meetingId);
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(getRequest.error);
      });
      db.close();
      return record?.selectedReportTemplateId === 'custom-report-edge'
        && record?.generationStatus?.meetingReport === 'not_started'
        && record?.meetingReport?.templateId === 'standard-minutes';
    }, { meetingId }, { timeout: 10000 });
    await page.getByText('현재 보고서는 이전 기록 정리 또는 보고 양식 기준으로 생성되었습니다. 아래 기존 보고서는 보관용으로 표시됩니다.', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByText('standard-minutes').waitFor({ timeout: 10000 });
    assert.match(await reportButton.innerText(), /다시 생성/);

    await reportButton.click();
    await page.getByText('보고서를 만들지 못했습니다. 정리 내용과 모델 준비 상태를 확인한 뒤 다시 생성해 주세요.', { exact: true }).waitFor({ timeout: 10000 });
    record = await readMeeting(page);
    assert.equal(record.generationStatus.meetingReport, 'failed');
    assert.equal(record.selectedReportTemplateId, 'custom-report-edge');
    assert.equal(record.meetingReport.templateId, 'standard-minutes');
    await page.getByText('standard-minutes').waitFor({ timeout: 10000 });

    await reportButton.click();
    await page.getByText('custom-report-edge').waitFor({ timeout: 10000 });
    record = await readMeeting(page);
    assert.equal(record.meetingReport.templateId, 'custom-report-edge');
    await assertNoHorizontalOverflow(page);

    console.log('ok - report tab edge flow simulation');
  } catch (error) {
    console.error(error);
    if (page) {
      console.error('body:', (await page.locator('body').innerText()).slice(0, 2000));
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
