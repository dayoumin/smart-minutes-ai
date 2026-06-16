import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const shouldStartServer = !process.env.APP_URL;
const PAGE_GOTO_TIMEOUT_MS = 60000;
const meetingId = 'codex-template-selection-flow';
const otherMeetingId = 'codex-template-selection-other-flow';

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
    if (child.exitCode === null) {
      child.kill();
    }
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
      summary_ready: true,
      summary_status: 'ready',
      summary_message: '',
      models: [
        { key: 'stt_faster_whisper', label: '음성 인식 기본 모델', installed: true, required: true },
        { key: 'llm', label: 'Gemma via Ollama', installed: true, configured_model: 'gemma4:e2b', installed_model: 'gemma4:e2b', installed_models: ['gemma4:e2b'], required: false },
      ],
    }),
  }));
};

const seedMeeting = async (page) => {
  await page.evaluate(async ({ meetingId, otherMeetingId }) => {
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
      jobId: 'codex-template-selection-job',
      date: '2026-06-12 10:30',
      title: '템플릿 선택 검증 회의록',
      summary: 'LMO 위해성 평가 검토 회의 요약입니다.',
      participants: '참석자01, 참석자02',
      meetingPurpose: 'LMO 위해성 평가 회의록 정리',
      sourceFile: 'template-selection.mp4',
      generationStatus: { summary: 'completed', topicSections: 'not_started', speakerContextSummaries: 'not_started' },
      segments: [
        {
          start: '00:00:01',
          end: '00:00:08',
          speaker: 'SPEAKER_00',
          displaySpeaker: '참석자01',
          text: 'LMO 위해성 평가와 심사 의견을 검토했습니다.',
        },
      ],
      editedDisplaySegments: [],
      actions: [],
      decisions: [],
      needsCheck: [],
    };
    const otherMeeting = {
      ...meeting,
      id: otherMeetingId,
      jobId: 'codex-template-selection-other-job',
      date: '2026-06-12 10:35',
      title: '다른 회의록',
      meetingPurpose: '다른 회의 정리',
      selectedReportTemplateId: 'standard-minutes',
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      tx.objectStore('meetings').put(meeting);
      tx.objectStore('meetings').put(otherMeeting);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { meetingId, otherMeetingId });
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

const patchMeeting = async (page, patch) => page.evaluate(async ({ meetingId, patch }) => {
  const request = indexedDB.open('MeetingHistoryDB', 1);
  const db = await new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  await new Promise((resolve, reject) => {
    const tx = db.transaction('meetings', 'readwrite');
    const store = tx.objectStore('meetings');
    const getRequest = store.get(meetingId);
    getRequest.onsuccess = () => {
      store.put({ ...getRequest.result, ...patch });
    };
    getRequest.onerror = () => reject(getRequest.error);
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
  db.close();
}, { meetingId, patch });

const run = async () => {
  let server;
  let browser;
  let page;
  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    await installRoutes(page);

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    assert.equal(await page.getByLabel('분석 전 정리 맥락 선택').count(), 0);
    assert.equal(await page.getByLabel('분석 전 정리 맥락 메뉴').count(), 0);
    assert.equal(await page.getByText('일반 회의').count(), 0);
    assert.equal(await page.getByText('대화 보관용 회의록').count(), 0);

    await seedMeeting(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('템플릿 선택 검증 회의록').first().click();
    await page.getByText('LMO 위해성 평가와 심사 의견을 검토했습니다.').waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
    await page.getByLabel('이번 정리 기준 선택', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '전체 요약', exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByLabel('후속 산출물 형식 선택').count(), 0);
    assert.equal(await page.getByText('대화 보관용 회의록').count(), 0);

    const contextSelect = page.getByLabel('이번 정리 기준 선택', { exact: true });
    assert.equal(await contextSelect.inputValue(), 'general');
    assert.equal(await page.getByLabel('선택한 정리 기준 설명').count(), 0);

    await page.getByRole('button', { name: '정리 맥락 메뉴', exact: true }).click();
    const initialContextMenu = page.getByRole('menu', { name: '정리 맥락 메뉴', exact: true });
    await initialContextMenu.waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement?.textContent?.includes('추가'));
    await initialContextMenu.getByRole('menuitem', { name: '추가', exact: true }).click();
    const contextDialog = page.getByRole('dialog', { name: '정리 맥락 추가' });
    await page.getByPlaceholder('예: LMO 심사 회의, 월간 사업 점검').fill('이사회 보고');
    await page.getByPlaceholder('예: 심사 안건, 위해성 평가 쟁점, 보완 요청, 결정사항을 중심으로 정리한다.').fill('보고 안건, 의사결정 배경, 후속 조치 중심으로 간결하게 정리한다.');
    await contextDialog.getByRole('button', { name: '저장', exact: true }).click();
    const contextDescription = page.getByLabel('선택한 정리 기준 설명');
    await contextDescription.getByText('이번 정리 기준: 이사회 보고', { exact: true }).waitFor({ timeout: 10000 });
    await contextDescription.getByText('보고 안건, 의사결정 배경, 후속 조치 중심으로 간결하게 정리한다.').waitFor({ timeout: 10000 });
    const customContextId = await contextSelect.inputValue();
    assert.equal(customContextId.startsWith('custom-context-'), true);

    await patchMeeting(page, {
      generationStatus: { summary: 'completed', topicSections: 'completed', speakerContextSummaries: 'completed' },
      topicSections: [{ topic: '기존 주제', summary: '기존 주제 정리' }],
      speakerContextSummaries: [{ speaker: 'SPEAKER_00', displaySpeaker: '참석자01', summary: '기존 참석자별 정리', keyPoints: [] }],
      participantSummaries: [{ speaker: 'SPEAKER_00', displaySpeaker: '참석자01', summary: '기존 참석자별 정리', keyPoints: [] }],
      transcriptEditMeta: {
        edited: false,
        summaryOutdated: false,
        topicSectionsOutdated: false,
        speakerContextOutdated: false,
      },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('템플릿 선택 검증 회의록').first().click();
    await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
    const refreshedContextSelect = page.getByLabel('이번 정리 기준 선택', { exact: true });
    await refreshedContextSelect.waitFor({ timeout: 10000 });
    assert.equal(await refreshedContextSelect.inputValue(), customContextId);

    await page.getByRole('button', { name: '정리 맥락 메뉴', exact: true }).click();
    const contextMenu = page.getByRole('menu', { name: '정리 맥락 메뉴', exact: true });
    await contextMenu.waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement?.textContent?.includes('추가'));
    await page.keyboard.press('ArrowDown');
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement?.textContent?.includes('변경'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'context-template-menu-button');
    assert.equal(await page.getByRole('menu', { name: '정리 맥락 메뉴', exact: true }).count(), 0);

    await page.getByRole('button', { name: '정리 맥락 메뉴', exact: true }).click();
    await page.getByRole('menuitem', { name: '변경', exact: true }).click();
    const editContextDialog = page.getByRole('dialog', { name: '정리 맥락 수정' });
    await editContextDialog.locator('textarea').fill('수정된 보고 안건과 후속 조치 중심으로 정리한다.');
    await editContextDialog.getByRole('button', { name: '저장', exact: true }).click();
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
      return record?.transcriptEditMeta?.summaryOutdated === true
        && record?.transcriptEditMeta?.topicSectionsOutdated === true
        && record?.transcriptEditMeta?.speakerContextOutdated === true;
    }, { meetingId }, { timeout: 10000 });

    await patchMeeting(page, {
      transcriptEditMeta: {
        edited: false,
        summaryOutdated: false,
        topicSectionsOutdated: false,
        speakerContextOutdated: false,
      },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('템플릿 선택 검증 회의록').first().click();
    await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
    await page.getByLabel('이번 정리 기준 선택', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByLabel('이번 정리 기준 선택', { exact: true }).inputValue(), customContextId);

    await page.getByRole('button', { name: '정리 맥락 메뉴', exact: true }).click();
    await page.getByRole('menuitem', { name: '삭제', exact: true }).click();
    const deleteDialog = page.getByRole('dialog', { name: '정리 맥락 삭제' });
    await deleteDialog.getByText('이사회 보고', { exact: true }).waitFor({ timeout: 10000 });
    await deleteDialog.getByRole('button', { name: '취소', exact: true }).click();
    assert.equal(await page.getByRole('dialog', { name: '정리 맥락 삭제' }).count(), 0);
    assert.equal((await contextSelect.inputValue()).startsWith('custom-context-'), true);

    await page.getByRole('button', { name: '정리 맥락 메뉴', exact: true }).click();
    await page.getByRole('menuitem', { name: '삭제', exact: true }).click();
    await page.getByRole('dialog', { name: '정리 맥락 삭제' }).getByRole('button', { name: '삭제', exact: true }).click();
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
      return record?.selectedContextTemplateId === 'general';
    }, { meetingId }, { timeout: 10000 });
    assert.equal(await contextSelect.inputValue(), 'general');
    assert.equal(await page.getByLabel('선택한 정리 기준 설명').count(), 0);
    await page.getByText('정리 맥락을 삭제했습니다.', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await page.waitForFunction(async ({ meetingId, customContextId }) => {
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
      return record?.selectedContextTemplateId === customContextId
        && record?.contextTemplate?.name === '이사회 보고'
        && record?.transcriptEditMeta?.summaryOutdated === false
        && record?.transcriptEditMeta?.topicSectionsOutdated === false
        && record?.transcriptEditMeta?.speakerContextOutdated === false;
    }, { meetingId, customContextId }, { timeout: 10000 });
    assert.equal(await contextSelect.inputValue(), customContextId);
    await contextDescription.getByText('이번 정리 기준: 이사회 보고', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByText('정리 맥락을 복원했습니다.', { exact: true }).waitFor({ timeout: 10000 });

    await page.getByRole('button', { name: '정리 맥락 메뉴', exact: true }).click();
    await page.getByRole('menuitem', { name: '삭제', exact: true }).click();
    await page.getByRole('dialog', { name: '정리 맥락 삭제' }).getByRole('button', { name: '삭제', exact: true }).click();
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
      return record?.selectedContextTemplateId === 'general';
    }, { meetingId }, { timeout: 10000 });
    assert.equal(await contextSelect.inputValue(), 'general');
    assert.equal(await page.getByLabel('선택한 정리 기준 설명').count(), 0);

    await contextSelect.selectOption('lmo-review');
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
      return record?.selectedContextTemplateId === 'lmo-review';
    }, { meetingId }, { timeout: 10000 });

    const record = await readMeeting(page);
    assert.equal(record.selectedContextTemplateId, 'lmo-review');
    assert.equal(record.contextTemplate?.name, 'LMO 심사');
    assert.deepEqual(record.selectedTermGlossaryIds, ['lmo']);
    assert.equal(record.termGlossaries?.[0]?.name, 'LMO');
    assert.equal(record.transcriptEditMeta?.summaryOutdated, true);
    await page.getByText('회의 정보, 대화록 또는 정리 맥락이 바뀌어 현재 전체 요약은 이전 기준일 수 있습니다.').waitFor({ timeout: 10000 });

    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('템플릿 선택 검증 회의록').first().click();
    await page.getByRole('tab', { name: '기록 정리', exact: true }).click();
    await page.getByLabel('이번 정리 기준 선택', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByLabel('이번 정리 기준 선택', { exact: true }).inputValue(), 'lmo-review');
    assert.equal(await page.getByLabel('후속 산출물 형식 선택').count(), 0);

    await patchMeeting(page, {
      generationStatus: { summary: 'completed', topicSections: 'completed', speakerContextSummaries: 'completed', meetingReport: 'not_started' },
      topicSections: [{ topic: '보고 주제', summary: '보고 주제 정리' }],
      speakerContextSummaries: [],
      participantSummaries: [],
      transcriptEditMeta: {
        edited: false,
        summaryOutdated: false,
        topicSectionsOutdated: false,
        speakerContextOutdated: false,
      },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('템플릿 선택 검증 회의록').first().click();
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    await page.getByLabel('보고서 생성 준비').getByText('보고 양식을 선택한 뒤 생성합니다.', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '보고 양식 메뉴', exact: true }).click();
    const initialReportMenu = page.getByRole('menu', { name: '보고 양식 메뉴', exact: true });
    await initialReportMenu.waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement?.textContent?.includes('추가'));
    await initialReportMenu.getByRole('menuitem', { name: '추가', exact: true }).click();
    const reportDialog = page.getByRole('dialog', { name: '보고 양식 추가' });
    await reportDialog.getByLabel('제목', { exact: true }).fill('삭제 검증 보고 양식');
    const reportTextareas = reportDialog.locator('textarea');
    assert.equal(await reportTextareas.count(), 2);
    await reportTextareas.nth(0).fill('검증용 보고 문체로 정리한다.');
    await reportTextareas.nth(1).fill('보고 개요\n후속 조치');
    await reportDialog.getByRole('button', { name: '저장', exact: true }).click();
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
      return record?.selectedReportTemplateId?.startsWith('custom-report-');
    }, { meetingId }, { timeout: 10000 });
    let reportRecord = await readMeeting(page);
    const customReportTemplateId = reportRecord.selectedReportTemplateId;
    assert.equal(customReportTemplateId.startsWith('custom-report-'), true);
    await patchMeeting(page, {
      generationStatus: { ...reportRecord.generationStatus, meetingReport: 'completed' },
      meetingReport: {
        templateId: customReportTemplateId,
        generatedAt: '2026-06-12T10:40:00.000Z',
        content: '삭제해도 보존되어야 하는 보고서 본문',
        sections: [{ title: '보고 개요', content: '삭제해도 보존되어야 하는 보고서 본문' }],
      },
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('템플릿 선택 검증 회의록').first().click();
    await page.getByRole('tab', { name: '보고서', exact: true }).click();
    await page.getByText('삭제해도 보존되어야 하는 보고서 본문').waitFor({ timeout: 10000 });

    await page.getByRole('button', { name: '보고 양식 메뉴', exact: true }).click();
    const reportMenu = page.getByRole('menu', { name: '보고 양식 메뉴', exact: true });
    await reportMenu.waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement?.textContent?.includes('추가'));
    await page.keyboard.press('End');
    await page.waitForFunction(() => document.activeElement?.getAttribute('role') === 'menuitem' && document.activeElement?.textContent?.includes('삭제'));
    await page.keyboard.press('Escape');
    await page.waitForFunction(() => document.activeElement?.id === 'report-template-menu-button');
    assert.equal(await page.getByRole('menu', { name: '보고 양식 메뉴', exact: true }).count(), 0);

    await page.getByRole('button', { name: '보고 양식 메뉴', exact: true }).click();
    await page.getByRole('menuitem', { name: '삭제', exact: true }).click();
    const reportDeleteDialog = page.getByRole('dialog', { name: '보고 양식 삭제' });
    await reportDeleteDialog.getByText('삭제 검증 보고 양식', { exact: true }).waitFor({ timeout: 10000 });
    await reportDeleteDialog.getByRole('button', { name: '삭제', exact: true }).click();
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
      return record?.selectedReportTemplateId === 'standard-minutes'
        && record?.meetingReport?.content === '삭제해도 보존되어야 하는 보고서 본문'
        && record?.generationStatus?.meetingReport === 'not_started';
    }, { meetingId }, { timeout: 10000 });
    reportRecord = await readMeeting(page);
    assert.equal(reportRecord.selectedReportTemplateId, 'standard-minutes');
    assert.equal(reportRecord.meetingReport?.templateId, customReportTemplateId);
    assert.equal(reportRecord.meetingReport?.content, '삭제해도 보존되어야 하는 보고서 본문');
    assert.equal(reportRecord.generationStatus?.meetingReport, 'not_started');
    await page.getByText('현재 보고서는 이전 기록 정리 또는 보고 양식 기준으로 생성되었습니다. 아래 기존 보고서는 보관용으로 표시됩니다.', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByText('삭제해도 보존되어야 하는 보고서 본문').waitFor({ timeout: 10000 });
    await page.getByText('보고 양식을 삭제했습니다.', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByText('다른 회의록', { exact: true }).first().click();
    await page.getByText('다른 회의 정리', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '되돌리기', exact: true }).click();
    await page.waitForFunction(async ({ meetingId, otherMeetingId, customReportTemplateId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 1);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const readRecord = async (id) => new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readonly');
        const getRequest = tx.objectStore('meetings').get(id);
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(getRequest.error);
      });
      const record = await readRecord(meetingId);
      const otherRecord = await readRecord(otherMeetingId);
      db.close();
      return record?.selectedReportTemplateId === customReportTemplateId
        && record?.reportTemplate?.name === '삭제 검증 보고 양식'
        && record?.meetingReport?.content === '삭제해도 보존되어야 하는 보고서 본문'
        && record?.generationStatus?.meetingReport === 'completed'
        && otherRecord?.selectedReportTemplateId === 'standard-minutes'
        && !otherRecord?.reportTemplate;
    }, { meetingId, otherMeetingId, customReportTemplateId }, { timeout: 10000 });
    reportRecord = await readMeeting(page);
    assert.equal(reportRecord.selectedReportTemplateId, customReportTemplateId);
    assert.equal(reportRecord.reportTemplate?.name, '삭제 검증 보고 양식');
    assert.equal(reportRecord.meetingReport?.content, '삭제해도 보존되어야 하는 보고서 본문');
    await page.getByText('보고 양식을 복원했습니다.', { exact: true }).waitFor({ timeout: 10000 });

    console.log('ok - template selection flow simulation');
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
