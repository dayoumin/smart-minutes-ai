import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const shouldStartServer = !process.env.APP_URL;
const PAGE_GOTO_TIMEOUT_MS = 60000;
const meetingId = 'codex-detail-flow-simulation';
const jobId = 'codex-detail-flow-job';
const skippedMeetingId = 'codex-detail-flow-summary-skipped';
const skippedJobId = 'codex-detail-flow-summary-skipped-job';
const existingContentModelMissingMeetingId = 'codex-detail-flow-existing-content-model-missing';
const existingContentModelMissingJobId = 'codex-detail-flow-existing-content-model-missing-job';
const otherMeetingId = 'codex-detail-flow-other-meeting';
const otherJobId = 'codex-detail-flow-other-job';
const cancelMeetingId = 'codex-detail-flow-diarization-cancel';
const cancelJobId = 'codex-detail-flow-diarization-cancel-job';
const audioMissingMeetingId = 'codex-detail-flow-diarization-audio-missing';
const audioMissingJobId = 'codex-detail-flow-diarization-audio-missing-job';
const legacyParticipantMeetingId = 'codex-detail-flow-legacy-participant';
const legacyParticipantJobId = 'codex-detail-flow-legacy-participant-job';
const formats = ['hwpx', 'md', 'txt', 'docx'];
let summaryReady = false;
let releaseTopicSectionsResponse = () => {};
const topicSectionsResponseDelay = new Promise(resolve => {
  releaseTopicSectionsResponse = resolve;
});
let markTopicSectionsRequested = () => {};
const topicSectionsRequested = new Promise(resolve => {
  markTopicSectionsRequested = resolve;
});
let releaseDiarizationResponse = () => {};
let diarizationStopRequested = false;
let diarizationFinished = false;
const diarizationResponseDelay = new Promise(resolve => {
  releaseDiarizationResponse = () => {
    diarizationFinished = true;
    resolve();
  };
});
let markDiarizationRequested = () => {};
const diarizationRequested = new Promise(resolve => {
  markDiarizationRequested = resolve;
});
const diarizationStopBodies = [];
let releaseCancelDiarizationResponse = () => {};
let cancelDiarizationStopRequested = false;
let cancelDiarizationFinished = false;
const cancelDiarizationResponseDelay = new Promise(resolve => {
  releaseCancelDiarizationResponse = () => {
    cancelDiarizationFinished = true;
    resolve();
  };
});
let markCancelDiarizationRequested = () => {};
const cancelDiarizationRequested = new Promise(resolve => {
  markCancelDiarizationRequested = resolve;
});
const cancelDiarizationStopBodies = [];
let markAudioMissingDiarizationRequested = () => {};
const audioMissingDiarizationRequested = new Promise(resolve => {
  markAudioMissingDiarizationRequested = resolve;
});

const contentTypeByFormat = {
  hwpx: 'application/hwp+zip',
  md: 'text/markdown; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

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
    // Start a local Vite server when the app is not already available.
  }

  const url = new URL(APP_URL);
  const command = `corepack pnpm exec vite --host ${url.hostname} --port ${url.port || '5173'} --strictPort --configLoader runner`;
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
      ['pnpm', 'exec', 'vite', '--host', url.hostname, '--port', url.port || '5173', '--strictPort', '--configLoader', 'runner'],
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

const seedMeeting = async (page) => {
  await page.evaluate(async ({ meetingId, jobId }) => {
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
      date: '2026-05-07 23:55',
      title: '시뮬레이션 회의록',
      summary: '기본 회의 요약입니다.',
      participants: '화자1, 화자2',
      meetingPurpose: 'AI 시스템 통제권 논의 정리',
      sourceFile: 'simulation.mp4',
      topics: [],
      topicSections: [],
      speakerContextSummaries: [],
      generationStatus: { summary: 'completed', topicSections: 'not_started', speakerContextSummaries: 'not_started' },
      speakerLabels: { '화자1': '김검토' },
      segments: [
        {
          start: '00:00:01',
          end: '00:00:08',
          speaker: '화자1',
          text: 'AI 시스템 통제권과 지식 확장을 논의했습니다.',
        },
        {
          start: '00:00:09',
          end: '00:00:14',
          speaker: '화자2',
          text: '후속 검토 일정이 필요합니다.',
        },
      ],
      editedDisplaySegments: [
        {
          start: '00:00:01',
          end: '00:00:08',
          speaker: '화자1',
          displaySpeaker: '김검토',
          text: '사용자가 다듬은 대화록입니다. 통제권과 지식 확장 기준을 길게 설명했습니다.',
        },
        {
          start: '00:00:09',
          end: '00:00:14',
          speaker: '화자2',
          displaySpeaker: '참석자02',
          text: '후속 일정을 확인했습니다.',
        },
        {
          start: '00:00:15',
          end: '00:00:22',
          speaker: '화자1',
          displaySpeaker: '김검토',
          text: '보안 보완 방안을 다시 검토하자고 제안했습니다.',
        },
      ],
      actions: [],
      decisions: [],
      needsCheck: [],
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

const seedSkippedSummaryMeeting = async (page) => {
  await page.evaluate(async ({ skippedMeetingId, skippedJobId }) => {
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
      id: skippedMeetingId,
      jobId: skippedJobId,
      date: '2026-05-07 23:58',
      title: '요약 AI 미준비 회의록',
      summary: '요약 AI가 준비되지 않아 대화록만 생성했습니다.',
      participants: '화자1, 화자2',
      meetingPurpose: '회사 PC 요약 AI 미준비 상태 확인',
      sourceFile: 'summary-skipped.mp4',
      topics: [],
      topicSections: [],
      speakerContextSummaries: [],
      generationStatus: { summary: 'skipped', topicSections: 'skipped', speakerContextSummaries: 'skipped' },
      speakerLabels: { '화자1': '김검토' },
      segments: [
        {
          start: '00:00:01',
          end: '00:00:08',
          speaker: '화자1',
          text: '요약 AI가 없어도 대화록은 확인할 수 있습니다.',
        },
      ],
      editedDisplaySegments: [],
      actions: [],
      decisions: [],
      needsCheck: [],
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      tx.objectStore('meetings').put(meeting);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { skippedMeetingId, skippedJobId });
};

const seedExistingContentModelMissingMeeting = async (page) => {
  await page.evaluate(async ({ existingContentModelMissingMeetingId, existingContentModelMissingJobId }) => {
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
      id: existingContentModelMissingMeetingId,
      jobId: existingContentModelMissingJobId,
      date: '2026-05-08 00:00',
      title: '기존 정리 모델 미준비 회의록',
      summary: '이미 저장된 전체 요약입니다.',
      participants: '화자1',
      meetingPurpose: '기존 정리 결과 표시와 재생성 잠금 확인',
      sourceFile: 'existing-content-model-missing.mp4',
      topics: ['기존 주제'],
      topicSections: [
        {
          topic: '기존 주제',
          summary: '이미 저장된 주제별 정리입니다.',
          evidence: ['기존 근거입니다.'],
          actions: [],
        },
      ],
      speakerContextSummaries: [
        {
          speaker: '화자1',
          displaySpeaker: '참석자01',
          summary: '이미 저장된 참석자별 정리입니다.',
          keyPoints: ['기존 참석자 핵심 발언입니다.'],
          actions: [],
        },
      ],
      participantSummaries: [],
      generationStatus: { summary: 'completed', topicSections: 'completed', speakerContextSummaries: 'completed' },
      transcriptEditMeta: { edited: true, summaryOutdated: true, topicSectionsOutdated: true, speakerContextOutdated: true },
      speakerLabels: {},
      segments: [
        {
          start: '00:00:01',
          end: '00:00:04',
          speaker: '화자1',
          text: '기존 정리 결과가 있는 대화록입니다.',
        },
      ],
      editedDisplaySegments: [],
      actions: [],
      decisions: [],
      needsCheck: [],
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      tx.objectStore('meetings').put(meeting);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { existingContentModelMissingMeetingId, existingContentModelMissingJobId });
};

const seedOtherMeeting = async (page) => {
  await page.evaluate(async ({ otherMeetingId, otherJobId }) => {
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
      id: otherMeetingId,
      jobId: otherJobId,
      date: '2026-05-08 00:01',
      title: '다른 회의록',
      summary: '다른 회의 요약입니다.',
      participants: '화자1',
      meetingPurpose: '진행 중 상태 분리 확인',
      sourceFile: 'other.mp4',
      topics: [],
      topicSections: [],
      speakerContextSummaries: [],
      generationStatus: { summary: 'completed', topicSections: 'not_started', speakerContextSummaries: 'not_started' },
      speakerLabels: {},
      segments: [
        {
          start: '00:00:01',
          end: '00:00:04',
          speaker: '화자1',
          text: '다른 회의 내용입니다.',
        },
      ],
      editedDisplaySegments: [],
      actions: [],
      decisions: [],
      needsCheck: [],
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      tx.objectStore('meetings').put(meeting);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { otherMeetingId, otherJobId });
};

const seedDiarizationCancelMeeting = async (page) => {
  await page.evaluate(async ({ cancelMeetingId, cancelJobId }) => {
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
      id: cancelMeetingId,
      jobId: cancelJobId,
      date: '2026-05-08 00:03',
      title: '참석자 구분 취소 회의록',
      summary: '참석자 구분 취소 흐름 확인용 회의록입니다.',
      participants: '화자1',
      meetingPurpose: '참석자 구분 취소 상태 확인',
      sourceFile: 'cancel-diarization.mp4',
      topics: [],
      topicSections: [],
      speakerContextSummaries: [],
      generationStatus: { summary: 'completed', topicSections: 'not_started', speakerContextSummaries: 'not_started' },
      speakerLabels: {},
      segments: [
        {
          start: '00:00:01',
          end: '00:00:04',
          speaker: '화자1',
          text: '참석자 구분 취소 상태를 확인합니다.',
        },
      ],
      editedDisplaySegments: [],
      actions: [],
      decisions: [],
      needsCheck: [],
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      tx.objectStore('meetings').put(meeting);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { cancelMeetingId, cancelJobId });
};

const seedAudioMissingDiarizationMeeting = async (page) => {
  await page.evaluate(async ({ audioMissingMeetingId, audioMissingJobId }) => {
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
      id: audioMissingMeetingId,
      jobId: audioMissingJobId,
      date: '2026-05-08 00:04',
      title: '원본 음성 누락 회의록',
      summary: '참석자 구분 원본 음성 누락 확인용 회의록입니다.',
      participants: '화자1',
      meetingPurpose: '참석자 구분 원본 음성 누락 확인',
      sourceFile: 'audio-missing-diarization.mp4',
      topics: [],
      topicSections: [],
      speakerContextSummaries: [],
      generationStatus: { summary: 'completed', topicSections: 'not_started', speakerContextSummaries: 'not_started' },
      speakerLabels: {},
      segments: [
        {
          start: '00:00:01',
          end: '00:00:04',
          speaker: '화자1',
          text: '원본 음성이 사라진 참석자 구분 상태를 확인합니다.',
        },
      ],
      editedDisplaySegments: [],
      actions: [],
      decisions: [],
      needsCheck: [],
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      tx.objectStore('meetings').put(meeting);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { audioMissingMeetingId, audioMissingJobId });
};

const seedLegacyParticipantMeeting = async (page) => {
  await page.evaluate(async ({ legacyParticipantMeetingId, legacyParticipantJobId }) => {
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
      id: legacyParticipantMeetingId,
      jobId: legacyParticipantJobId,
      date: '2026-05-08 00:02',
      title: '기본 별칭 참석자 회의록',
      summary: '기본 별칭 참석자 요약입니다.',
      participants: '화자1',
      meetingPurpose: '기본 별칭 fallback 확인',
      sourceFile: 'legacy-participant.mp4',
      topics: ['기본 별칭'],
      topicSections: [],
      speakerContextSummaries: [],
      participantSummaries: [
        {
          participant: '참석자01',
          summary: '기본 별칭 참석자 요약입니다.',
          key_points: ['기본 별칭으로 저장된 참석자 요약'],
          actions: [],
        },
      ],
      generationStatus: { summary: 'completed', topicSections: 'completed', speakerContextSummaries: 'completed' },
      speakerLabels: { '화자1': '김검토' },
      segments: [],
      editedDisplaySegments: [
        {
          start: '00:00:01',
          end: '00:00:08',
          speaker: '화자1',
          displaySpeaker: '김검토',
          text: '기본 별칭 fallback을 확인하는 대화록입니다.',
        },
      ],
      actions: [],
      decisions: [],
      needsCheck: [],
    };

    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      tx.objectStore('meetings').put(meeting);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { legacyParticipantMeetingId, legacyParticipantJobId });
};

const installRoutes = async (page) => {
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));

  await page.route('**/api/dev/asr-benchmarks**', route => {
    return route.fulfill({
      status: 404,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
    });
  });

  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      processing: { long_audio_chunk_seconds: 30, enable_long_audio_chunking: true },
      diarization: { enabled: false },
      stt: { device: 'cpu' },
      summary: {
        provider: 'ollama',
        model: 'gemma4:e2b',
        model_options: [
          {
            model: 'gemma4:e2b',
            label: '권장 2B',
            description: '용량과 속도를 우선할 때 사용합니다.',
            url: 'https://ollama.com/library/gemma4%3Ae2b',
            command: 'ollama run gemma4:e2b',
          },
          {
            model: 'gemma4:e4b',
            label: '선택 4B',
            description: 'PC 여유가 있으면 더 큰 모델을 사용할 수 있습니다.',
            url: 'https://ollama.com/library/gemma4%3Ae4b',
            command: 'ollama run gemma4:e4b',
          },
        ],
      },
      preprocessing: { enabled: true, normalize_audio: true, normalization_mode: 'auto' },
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
      summary_message: summaryReady ? '' : '요약 AI가 준비되지 않아 대화록만 생성했습니다. 요약을 사용하려면 분석 준비를 확인해 주세요.',
      models: [
        { key: 'stt_faster_whisper', label: '음성 인식 기본 모델', installed: true, required: true },
        {
          key: 'llm',
          label: 'Gemma via Ollama',
          installed: summaryReady,
          required: false,
          manual_note: 'Ollama 설치 후 Gemma 모델을 준비하면 전체 요약과 주제별 정리를 사용할 수 있습니다.',
          install_url: 'https://ollama.com/library/gemma4%3Ae2b',
          install_command: 'ollama run gemma4:e2b',
          install_options: [
            {
              label: '권장 2B',
              description: '용량과 속도를 우선할 때 사용합니다.',
              url: 'https://ollama.com/library/gemma4%3Ae2b',
              command: 'ollama run gemma4:e2b',
            },
            {
              label: '선택 4B',
              description: 'PC 여유가 있으면 더 큰 모델을 사용할 수 있습니다.',
              url: 'https://ollama.com/library/gemma4%3Ae4b',
              command: 'ollama run gemma4:e4b',
            },
            {
              label: '모델 목록',
              description: 'Ollama에서 Gemma 4 모델을 비교합니다.',
              url: 'https://ollama.com/library/gemma4',
              command: '',
            },
          ],
        },
      ],
    }),
  }));

  await page.route('**/api/outputs/*/audio', route => {
    const url = route.request().url();
    const hasAudio = url.includes(`/api/outputs/${jobId}/audio`)
      || url.includes(`/api/outputs/${cancelJobId}/audio`)
      || url.includes(`/api/outputs/${audioMissingJobId}/audio`);
    return route.fulfill({
      status: hasAudio ? 200 : 404,
      contentType: 'audio/wav',
      body: hasAudio ? 'RIFF' : '',
    });
  });

  await page.route(`**/api/outputs/${jobId}/generate-topic-sections`, async route => {
    markTopicSectionsRequested();
    await topicSectionsResponseDelay;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        topics: ['AI 시스템 통제권'],
        topic_sections: [
          {
            topic: 'AI 시스템 통제권',
            summary: 'AI 시스템 통제권과 지식 확장 방향을 정리했습니다.',
            evidence: ['화자1이 시스템 통제권을 언급했습니다.'],
            actions: ['보안 보완 방안 확인'],
          },
          {
            topic: '보안 보완 방안',
            summary: '보안 보완 방안과 후속 확인 항목을 정리했습니다.',
            evidence: ['보안 보완 방안을 확인하기로 했습니다.'],
            actions: ['후속 확인 항목 정리'],
          },
        ],
        generation_status: { topic_sections: 'completed', speaker_context_summaries: 'not_started' },
        outputs: {},
      }),
    });
  });

  await page.route(`**/api/outputs/${jobId}/generate-diarization`, async route => {
    markDiarizationRequested();
    await diarizationResponseDelay;
    try {
      return await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'diarization_deferred' }),
      });
    } catch {
      return undefined;
    }
  });

  await page.route(`**/api/outputs/${jobId}/generation-stop/diarization`, route => {
    const stopBody = JSON.parse(route.request().postData() ?? '{}');
    diarizationStopBodies.push(stopBody);
    diarizationStopRequested = true;
    const action = stopBody.action ?? 'defer';
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: jobId,
        kind: 'diarization',
        action,
        status: 'stopping',
        active: true,
        running: true,
        accepted: true,
        message: action === 'defer'
          ? '참석자 구분을 중지하고 있습니다. 원본 음성이 남아 있으면 이 회의록에서 다시 실행할 수 있습니다.'
          : '참석자 구분 실행을 취소하고 있습니다. 나중에 다시 실행할 수 있습니다.',
      }),
    });
  });

  await page.route(`**/api/outputs/${jobId}/generation-progress/diarization`, route => {
    const active = diarizationStopRequested && !diarizationFinished;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: jobId,
        kind: 'diarization',
        progress: active ? 30 : 30,
        message: active
          ? '참석자 구분을 중지하고 있습니다. 원본 음성이 남아 있으면 이 회의록에서 다시 실행할 수 있습니다.'
          : '참석자 구분을 멈췄습니다. 원본 음성이 남아 있으면 이 회의록에서 다시 실행할 수 있습니다.',
        status: active ? 'stopping' : 'deferred',
        active,
      }),
    });
  });

  await page.route(`**/api/outputs/${cancelJobId}/generate-diarization`, async route => {
    markCancelDiarizationRequested();
    await cancelDiarizationResponseDelay;
    try {
      return await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'diarization_cancelled' }),
      });
    } catch {
      return undefined;
    }
  });

  await page.route(`**/api/outputs/${audioMissingJobId}/generate-diarization`, route => {
    markAudioMissingDiarizationRequested();
    return route.fulfill({
      status: 409,
      contentType: 'application/json',
      body: JSON.stringify({ detail: 'audio_required_for_diarization' }),
    });
  });

  await page.route(`**/api/outputs/${cancelJobId}/generation-stop/diarization`, route => {
    const stopBody = JSON.parse(route.request().postData() ?? '{}');
    cancelDiarizationStopBodies.push(stopBody);
    cancelDiarizationStopRequested = true;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: cancelJobId,
        kind: 'diarization',
        action: stopBody.action ?? 'cancel',
        status: 'stopping',
        active: true,
        running: true,
        accepted: true,
        message: '참석자 구분 실행을 취소하고 있습니다. 나중에 다시 실행할 수 있습니다.',
      }),
    });
  });

  await page.route(`**/api/outputs/${cancelJobId}/generation-progress/diarization`, route => {
    const active = cancelDiarizationStopRequested && !cancelDiarizationFinished;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        job_id: cancelJobId,
        kind: 'diarization',
        progress: active ? 30 : 30,
        message: active
          ? '참석자 구분 실행을 취소하고 있습니다. 나중에 다시 실행할 수 있습니다.'
          : '참석자 구분을 취소했습니다.',
        status: active ? 'stopping' : 'cancelled',
        active,
      }),
    });
  });

  await page.route(`**/api/outputs/${jobId}/generate-speaker-context`, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      speaker_context_summaries: [
        {
          speaker: '화자1',
          display_name: '화자1',
          role_in_meeting: '주요 의견 제안자',
          summary: 'AI 시스템 통제권과 지식 확장에 대한 핵심 의견을 제시했습니다.',
          key_points: ['통제권 이동 방식 검토'],
          actions: ['보안 보완 방안 확인'],
          needs_check: ['실제 담당자 이름 확인'],
        },
        {
          speaker: '화자2',
          display_name: '화자2',
          role_in_meeting: '일정 확인자',
          summary: '후속 검토 일정 확인을 요청했습니다.',
          key_points: ['후속 일정 확인'],
          actions: ['검토 일정 공유'],
          needs_check: [],
        },
      ],
      participant_summaries: [
        {
          participant: '화자1',
          summary: 'AI 시스템 통제권과 지식 확장에 대한 핵심 의견을 제시했습니다.',
          key_points: ['통제권 이동 방식 검토'],
          actions: ['보안 보완 방안 확인'],
        },
      ],
      generation_status: { topic_sections: 'completed', speaker_context_summaries: 'completed' },
      outputs: {},
    }),
  }));
};

const run = async () => {
  const server = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
  const exportCalls = [];
  const exportBodies = [];
  const apiCalls = [];
  page.on('request', request => {
    if (request.url().includes('/api/')) {
      apiCalls.push(`${request.method()} ${request.url()}`);
    }
  });

  try {
    await installRoutes(page);
    for (const format of formats) {
      await page.route(`**/api/export-record/${format}/save-copy`, route => {
        exportCalls.push(`${format}:save-copy`);
        exportBodies.push(JSON.parse(route.request().postData() ?? '{}'));
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            kind: format,
            saved_path: `C:\\Users\\User\\Downloads\\simulation.${format}`,
            size_bytes: 16,
          }),
        });
      });
      await page.route(`**/api/export-record/${format}`, route => {
        exportCalls.push(format);
        return route.fulfill({
          status: 200,
          contentType: contentTypeByFormat[format],
          headers: { 'content-disposition': `attachment; filename="simulation.${format}"` },
          body: `simulation ${format}`,
        });
      });
    }

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    await seedMeeting(page);
    await seedSkippedSummaryMeeting(page);
    await seedExistingContentModelMissingMeeting(page);
    await seedOtherMeeting(page);
    await seedDiarizationCancelMeeting(page);
    await seedAudioMissingDiarizationMeeting(page);
    await seedLegacyParticipantMeeting(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    await page.getByText('요약 AI 미준비 회의록').first().click();
    await page.getByText('요약 AI가 없어도 대화록은 확인할 수 있습니다.').waitFor({ timeout: 10000 });
    const skippedOrganizeTab = page.getByRole('tab', { name: '기록 정리' });
    assert.equal(await skippedOrganizeTab.isDisabled(), false);
    await skippedOrganizeTab.click();
    await page.getByText('분석 준비 필요').waitFor({ timeout: 10000 });
    await page.getByText('요약 AI가 준비되지 않아 대화록만 생성했습니다. 요약을 사용하려면 분석 준비를 확인해 주세요.').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '분석 준비' }).click();
    const settingsModelsTab = page.getByRole('tab', { name: '분석 준비' });
    await settingsModelsTab.waitFor({ timeout: 10000 });
    assert.equal(await settingsModelsTab.getAttribute('aria-selected'), 'true');
    await page.getByText('회의 요약').waitFor({ timeout: 10000 });
    await page.getByText('회의 요약 모델').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '추천 모델' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '모델명 직접 입력' }).click();
    await page.getByPlaceholder('예: llama3.2:3b').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '추천 모델' }).click();
    await page.getByRole('link', { name: /권장 2B/ }).waitFor({ timeout: 10000 });
    await page.getByRole('link', { name: /선택 4B/ }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '설정 닫기' }).click();
    assert.equal(await page.getByRole('button', { name: '전체 요약 정리' }).isDisabled(), true);

    await page.getByText('기존 정리 모델 미준비 회의록').first().click();
    await page.getByText('기존 정리 결과가 있는 대화록입니다.').waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '기록 정리' }).click();
    await page.getByText('이미 저장된 전체 요약입니다.').waitFor({ timeout: 10000 });
    await page.getByText('분석 준비 필요').waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('button', { name: '전체 요약 정리' }).isDisabled(), true);
    await page.getByRole('tab', { name: '주제별 정리' }).click();
    await page.getByText('이미 저장된 주제별 정리입니다.').waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('button', { name: '주제별 정리' }).isDisabled(), true);
    await page.getByRole('tab', { name: '참석자별 정리' }).click();
    await page.getByText('이미 저장된 참석자별 정리입니다.').waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('button', { name: '참석자별 정리', exact: true }).isDisabled(), true);
    await page.getByRole('button', { name: '분석 준비' }).click();
    summaryReady = true;
    await page.getByRole('button', { name: '상태 새로고침' }).click();
    await page.getByRole('button', { name: '설정 닫기' }).click();
    await page.getByRole('tab', { name: '전체 요약' }).click();
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === '전체 요약 정리');
      return button && !button.disabled;
    }, null, { timeout: 10000 });

    await page.getByText('원본 음성 누락 회의록').first().click();
    await page.getByText('참석자 구분 원본 음성 누락 확인').waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '기록 정리' }).click();
    const audioRequiredButton = page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 실행' });
    await audioRequiredButton.waitFor({ timeout: 10000 });
    await page.waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll('section.detail-action-row button'));
      return buttons.some(button => button.textContent?.includes('실행') && !button.disabled);
    }, null, { timeout: 10000 });
    assert.equal(await audioRequiredButton.isDisabled(), false);
    await audioRequiredButton.click();
    await audioMissingDiarizationRequested;
    await page.getByText('참석자 구분에 필요한 원본 음성을 찾지 못했습니다. 다시 분석해 주세요.').first().waitFor({ timeout: 10000 });
    await page.getByText('원본 필요').first().waitFor({ timeout: 10000 });
    await page.getByText('저장된 음성 파일이 없습니다. 영상에서 음성만 필요하면 작성 화면에서 음성 추출을 사용하세요.').waitFor({ timeout: 10000 });
    assert.equal(await audioRequiredButton.isDisabled(), true);

    await page.getByText('참석자 구분 취소 회의록').first().click();
    await page.getByText('참석자 구분 취소 상태 확인').waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '기록 정리' }).click();
    await page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 실행' }).click();
    await cancelDiarizationRequested;
    const cancelRunningButton = page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 중지/취소' });
    await cancelRunningButton.waitFor({ timeout: 10000 });
    assert.equal(await cancelRunningButton.isDisabled(), false);
    await cancelRunningButton.click();
    const cancelPanel = page.locator('.diarization-stop-panel');
    await cancelPanel.getByText('중지하면 원본 음성이 남아 있을 때 다시 실행할 수 있고, 취소하면 이번 실행만 멈춥니다.').waitFor({ timeout: 10000 });
    await cancelPanel.getByRole('button', { name: '취소' }).click();
    await page.getByText('참석자 구분 실행을 취소하고 있습니다. 나중에 다시 실행할 수 있습니다.').first().waitFor({ timeout: 10000 });
    releaseCancelDiarizationResponse();
    assert.deepEqual(cancelDiarizationStopBodies, [{ action: 'cancel' }]);
    const cancelledRecord = await page.evaluate(async ({ cancelMeetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 1);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readonly');
        const getRequest = tx.objectStore('meetings').get(cancelMeetingId);
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(getRequest.error);
      });
      db.close();
      return record;
    }, { cancelMeetingId });
    assert.equal(cancelledRecord.diarizationRequested, true);
    assert.equal(cancelledRecord.diarizationDeferred, false);
    assert.equal(cancelledRecord.diarizationApplied, false);
    await page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 실행' }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 실행' }).isDisabled(), false);

    await page.getByText('시뮬레이션 회의록').first().click();
    await page.getByText('사용자가 다듬은 대화록입니다.').waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '기록 정리' }).click();

    const diarizationButton = page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 실행' });
    await diarizationButton.click();
    await diarizationRequested;
    const stopDiarizationButton = page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 중지/취소' });
    await stopDiarizationButton.waitFor({ timeout: 10000 });
    assert.equal(await stopDiarizationButton.isDisabled(), false);
    await stopDiarizationButton.click();
    await page.getByText('참석자 구분을 어떻게 처리할까요?').waitFor({ timeout: 10000 });
    await page.getByText('예상 남은 시간').waitFor({ timeout: 10000 });
    await page.locator('.diarization-stop-panel').getByRole('button', { name: '중지', exact: true }).click();
    await page.getByText('참석자 구분을 중지하고 있습니다. 원본 음성이 남아 있으면 이 회의록에서 다시 실행할 수 있습니다.').first().waitFor({ timeout: 10000 });
    const stoppingDiarizationButton = page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 중지 중' });
    await stoppingDiarizationButton.waitFor({ timeout: 10000 });
    assert.equal(await stoppingDiarizationButton.isDisabled(), true);
    releaseDiarizationResponse();
    assert.deepEqual(diarizationStopBodies, [{ action: 'defer' }]);
    const deferredRecord = await page.evaluate(async ({ meetingId }) => {
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
    assert.equal(deferredRecord.diarizationDeferred, true);
    assert.equal(deferredRecord.diarizationApplied, false);
    assert.equal(deferredRecord.diarizationRequested, true);
    await page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 실행' }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 실행' }).isDisabled(), false);

    await page.getByRole('tab', { name: '주제별 정리' }).click();

    const topicButton = page.getByRole('button', { name: '주제별 정리' });
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === '주제별 정리');
      return button && !button.disabled;
    }, null, { timeout: 10000 });
    await topicButton.click();
    await topicSectionsRequested;
    const runningTopicButton = page.getByRole('button', { name: '주제별 정리 중' });
    await runningTopicButton.waitFor({ timeout: 10000 });
    assert.equal(await runningTopicButton.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '주제 추가 정리' }).isDisabled(), true);
    assert.equal(await page.locator('button:has-text("정리 중") .animate-spin').count(), 1);
    assert.equal(await page.locator('button:has-text("추가 정리") .animate-spin').count(), 0);

    await page.getByText('다른 회의록').first().click();
    await page.getByRole('heading', { name: '다른 회의록' }).waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '기록 정리' }).click();
    await page.getByRole('tab', { name: '주제별 정리' }).click();
    assert.equal(await page.getByRole('button', { name: '주제별 정리 중' }).count(), 0);
    const otherTopicButton = page.getByRole('button', { name: '주제별 정리' });
    assert.equal(await otherTopicButton.isDisabled(), true);
    assert.equal(await page.locator('button:has-text("정리 중") .animate-spin').count(), 0);

    await page.getByText('시뮬레이션 회의록').first().click();
    await page.getByText('사용자가 다듬은 대화록입니다.').waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '기록 정리' }).click();
    await page.getByRole('tab', { name: '주제별 정리' }).click();
    releaseTopicSectionsResponse();
    await page.getByText('AI 시스템 통제권과 지식 확장 방향을 정리했습니다.').waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '참석자별 정리' }).click();
    const speakerButton = page.getByRole('button', { name: '참석자별 정리', exact: true });
    assert.equal(await speakerButton.isDisabled(), false);

    await speakerButton.click();
    await page.getByText('AI 시스템 통제권과 지식 확장에 대한 핵심 의견을 제시했습니다.').waitFor({ timeout: 10000 });
    await page.getByText('주요 의견 제안자').waitFor({ timeout: 10000 });
    const speakerSummaryCards = page.locator('article.detail-subtle-card');
    const kimCard = speakerSummaryCards.filter({ hasText: '김검토' });
    const participantCard = speakerSummaryCards.filter({ hasText: '참석자02' });
    assert.equal(await kimCard.count(), 1);
    assert.equal(await participantCard.count(), 1);
    await kimCard.getByText('발언 2회 · 텍스트 비중 83%').waitFor({ timeout: 10000 });
    await participantCard.getByText('발언 1회 · 텍스트 비중 17%').waitFor({ timeout: 10000 });
    await page.getByText('핵심 발언').first().waitFor({ timeout: 10000 });

    await page.getByRole('button', { name: '회의록 HWPX 파일을 다운로드 폴더에 저장' }).click();
    for (let attempt = 0; attempt < 50 && exportCalls.length === 0; attempt += 1) {
      await sleep(100);
    }
    await page.getByText('저장됨', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByText('HWPX 파일을 다운로드 폴더에 저장했습니다.').count(), 0);

    assert.deepEqual(exportCalls, ['hwpx:save-copy']);
    assert.equal(exportBodies[0]?.meetingPurpose, 'AI 시스템 통제권 논의 정리');
    assert.equal(exportBodies[0]?.speakerLabels?.['화자1'], '김검토');
    assert.equal(exportBodies[0]?.displaySegments?.[0]?.text, '사용자가 다듬은 대화록입니다. 통제권과 지식 확장 기준을 길게 설명했습니다.');

    await page.getByText('기본 별칭 참석자 회의록').first().click();
    await page.getByRole('heading', { name: '기본 별칭 참석자 회의록' }).waitFor({ timeout: 10000 });
    await page.getByRole('tab', { name: '기록 정리' }).click();
    await page.getByRole('tab', { name: '참석자별 정리' }).click();
    const legacyCard = page.locator('article.detail-subtle-card').filter({ hasText: '참석자01' });
    assert.equal(await legacyCard.count(), 1);
    await legacyCard.getByText('발언 1회 · 텍스트 비중 100%').waitFor({ timeout: 10000 });

    console.log('ok - meeting detail flow simulation');
  } catch (error) {
    console.error(error);
    console.error('api calls:', apiCalls);
    console.error('body:', (await page.locator('body').innerText()).slice(0, 2000));
    throw error;
  } finally {
    await browser.close();
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
