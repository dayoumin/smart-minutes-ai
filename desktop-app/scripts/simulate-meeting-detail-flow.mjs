import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import net from 'node:net';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const shouldStartServer = !process.env.APP_URL;
const PAGE_GOTO_TIMEOUT_MS = 60000;
const designCaptureDir = process.env.MEETING_DETAIL_CAPTURE_DIR;
const designCaptureOnly = process.env.MEETING_DETAIL_CAPTURE_ONLY === '1';
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
const unlabeledAudioMissingMeetingId = 'codex-detail-flow-unlabeled-audio-missing';
const unlabeledAudioMissingJobId = 'codex-detail-flow-unlabeled-audio-missing-job';
const legacyParticipantMeetingId = 'codex-detail-flow-legacy-participant';
const legacyParticipantJobId = 'codex-detail-flow-legacy-participant-job';
const initialAnalysisMeetingId = 'codex-detail-flow-initial-analysis';
const initialAnalysisJobId = 'codex-detail-flow-initial-analysis-job';
const formats = ['hwpx', 'md', 'txt', 'docx'];
let summaryReady = false;
let topicSectionsFailureCode = null;
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

const seedMeeting = async (page) => {
  await page.evaluate(async ({ meetingId, jobId }) => {
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) {
          db.createObjectStore('meetings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
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
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) {
          db.createObjectStore('meetings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
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
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) {
          db.createObjectStore('meetings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
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
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) {
          db.createObjectStore('meetings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
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
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) {
          db.createObjectStore('meetings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
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

const seedInitialAnalysisMeeting = async (page) => {
  await page.evaluate(async ({ initialAnalysisMeetingId, initialAnalysisJobId }) => {
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const meeting = {
      id: initialAnalysisMeetingId,
      jobId: initialAnalysisJobId,
      date: '2026-05-08 00:04',
      title: '최초 분석 진행 회의록',
      summary: '최초 분석 참석자 구분 진행 상태를 확인합니다.',
      meetingPurpose: '최초 분석 상태 보존',
      sourceFile: 'initial-analysis.mp4',
      analysisStatus: 'diarization_in_progress',
      diarizationApplied: false,
      segments: [{ start: '00:00:01', end: '00:00:04', speaker: '화자1', text: '분석이 진행 중입니다.' }],
      topics: [], actions: [], decisions: [], needsCheck: [],
    };
    await new Promise((resolve, reject) => {
      const tx = db.transaction('meetings', 'readwrite');
      tx.objectStore('meetings').put(meeting);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  }, { initialAnalysisMeetingId, initialAnalysisJobId });
};

const seedAudioMissingDiarizationMeeting = async (page) => {
  await page.evaluate(async ({ audioMissingMeetingId, audioMissingJobId }) => {
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) {
          db.createObjectStore('meetings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
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

const seedUnlabeledAudioMissingMeeting = async (page) => {
  await page.evaluate(async ({ unlabeledAudioMissingMeetingId, unlabeledAudioMissingJobId }) => {
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) {
          db.createObjectStore('meetings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });

    const meeting = {
      id: unlabeledAudioMissingMeetingId,
      jobId: unlabeledAudioMissingJobId,
      date: '2026-05-08 00:05',
      title: '참석자 표식 없는 회의록',
      summary: '참석자 표식이 없는 원본 음성 누락 확인용 회의록입니다.',
      participants: '',
      meetingPurpose: '참석자 표식 없는 원본 음성 누락 확인',
      sourceFile: 'unlabeled-audio-missing.mp4',
      topics: [],
      topicSections: [],
      speakerContextSummaries: [],
      generationStatus: { summary: 'completed', topicSections: 'not_started', speakerContextSummaries: 'not_started' },
      speakerLabels: {},
      segments: [
        {
          start: '00:00:01',
          end: '00:00:04',
          speaker: '',
          text: '참석자 표식이 없는 대화록입니다.',
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
  }, { unlabeledAudioMissingMeetingId, unlabeledAudioMissingJobId });
};

const seedLegacyParticipantMeeting = async (page) => {
  await page.evaluate(async ({ legacyParticipantMeetingId, legacyParticipantJobId }) => {
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains('meetings')) {
          db.createObjectStore('meetings', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('folders')) {
          db.createObjectStore('folders', { keyPath: 'id' });
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


const seedSidebarMenuMeetings = async (page) => {
  await page.evaluate(async () => {
    const folder = {
      id: 'sidebar-review-folder',
      name: '통합 검수 폴더',
      createdAt: '2026-05-08T00:00:00.000Z',
      updatedAt: '2026-05-08T00:00:00.000Z',
    };
    const request = indexedDB.open('MeetingHistoryDB', 2);
    const db = await new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
    const records = [
      { id: 'sidebar-old-pinned', date: '2026-04-01 09:00', title: '오래된 고정 회의', pinned: true },
      { id: 'sidebar-duplicate-later', date: '2026-05-08 00:09', title: '반복 주간회의', pinned: false },
      { id: 'sidebar-duplicate-earlier', date: '2026-05-08 00:08', title: '반복 주간회의', pinned: false },
      { id: 'sidebar-recent-filler', date: '2026-05-08 00:07', title: '최근 회의 기록', pinned: false },
      {
        id: 'sidebar-relative-time',
        date: '2026-05-08 00:06',
        title: '경과 시간 검수 회의',
        pinned: false,
        createdAt: new Date(Date.now() - (2 * 86_400_000)).toISOString(),
      },
    ].map(record => ({
      ...record,
      summary: '',
      participants: '',
      meetingPurpose: '',
      sourceFile: 'sidebar-focus.wav',
      topics: [],
      topicSections: [],
      speakerContextSummaries: [],
      participantSummaries: [],
      speakerLabels: {},
      segments: [],
    }));
    await new Promise((resolve, reject) => {
      const tx = db.transaction(['meetings', 'folders'], 'readwrite');
      const meetingStore = tx.objectStore('meetings');
      const folderStore = tx.objectStore('folders');
      records.forEach(record => meetingStore.put(record));
      folderStore.put(folder);
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
    db.close();
  });
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
      diarization: { enabled: true, generate_during_analysis: false },
      stt: { device: 'cpu' },
      summary: {
        provider: 'ollama',
        model: 'gemma4:e2b',
        model_options: [
          {
            model: 'gemma4:e2b',
            label: '2B',
            description: '용량과 속도를 우선할 때 사용합니다.',
            url: 'https://ollama.com/library/gemma4%3Ae2b',
            command: 'ollama run gemma4:e2b',
          },
          {
            model: 'gemma4:e4b',
            label: '4B',
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
      summary_message: summaryReady ? '' : '요약 모델이 준비되지 않아 대화록만 생성했습니다. 요약을 사용하려면 모델 상태를 확인해 주세요.',
      models: [
        { key: 'stt_faster_whisper', label: '음성 인식 기본 모델', installed: true, required: true },
        {
          key: 'llm',
          label: 'Gemma via Ollama',
          installed: summaryReady,
          configured_model: 'gemma4:e2b',
          installed_model: summaryReady ? 'gemma4:e2b' : null,
          installed_models: summaryReady ? ['gemma4:e2b'] : [],
          required: false,
          manual_note: 'Ollama 설치 후 Gemma 모델을 준비하면 전체 요약과 주제별 정리를 사용할 수 있습니다.',
          install_url: 'https://ollama.com/library/gemma4%3Ae2b',
          install_command: 'ollama run gemma4:e2b',
          install_options: [
            {
              label: '2B',
              description: '용량과 속도를 우선할 때 사용합니다.',
              model: 'gemma4:e2b',
              url: 'https://ollama.com/library/gemma4%3Ae2b',
              command: 'ollama run gemma4:e2b',
            },
            {
              label: '4B',
              description: 'PC 여유가 있으면 더 큰 모델을 사용할 수 있습니다.',
              model: 'gemma4:e4b',
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
    if (topicSectionsFailureCode) {
      return route.fulfill({
        status: 504,
        contentType: 'application/json',
        body: JSON.stringify({
          detail: {
            code: topicSectionsFailureCode,
            message: 'raw backend detail',
            retryable: true,
            user_action: 'retry',
            generation_kind: 'topic_sections',
          },
        }),
      });
    }
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

  await page.route(`**/api/outputs/${initialAnalysisJobId}/generation-progress/diarization`, route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      job_id: initialAnalysisJobId,
      kind: 'diarization',
      progress: 0,
      message: '',
      status: 'idle',
      active: false,
    }),
  }));

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
  let server = null;
  let browser = null;
  let page = null;
  const exportCalls = [];
  const exportBodies = [];
  const apiCalls = [];

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    const loadErrorContext = await browser.newContext({ viewport: { width: 1200, height: 800 } });
    const loadErrorPage = await loadErrorContext.newPage();
    try {
      await loadErrorPage.addInitScript(() => {
        window.__meetingDbOriginalOpen = indexedDB.open.bind(indexedDB);
        window.__meetingDbOpenShouldFail = true;
        Object.defineProperty(indexedDB, 'open', {
          configurable: true,
          value: (...args) => {
            if (!window.__meetingDbOpenShouldFail) return window.__meetingDbOriginalOpen(...args);
            const failedRequest = {
              error: new DOMException('simulated IndexedDB failure', 'UnknownError'),
              onerror: null,
              onsuccess: null,
              onupgradeneeded: null,
            };
            queueMicrotask(() => failedRequest.onerror?.(new Event('error')));
            return failedRequest;
          },
        });
      });
      await installRoutes(loadErrorPage);
      await loadErrorPage.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
      const recoveryMeetingId = 'codex-load-error-recovery';
      await loadErrorPage.evaluate((targetMeetingId) => {
        window.dispatchEvent(new CustomEvent('meetings:updated', {
          detail: { id: targetMeetingId, openHistory: true, detailTab: 'script' },
        }));
      }, recoveryMeetingId);
      await loadErrorPage.getByRole('heading', { name: '회의 기록을 불러오지 못했습니다' }).waitFor({ timeout: 10000 });
      assert.equal(await loadErrorPage.getByRole('heading', { name: '선택된 회의록이 없습니다' }).count(), 0);
      const retryMeetingLoadButton = loadErrorPage.getByRole('button', { name: '다시 시도', exact: true });
      await retryMeetingLoadButton.waitFor({ timeout: 10000 });
      await loadErrorPage.evaluate(async ({ recoveryMeetingId }) => {
        window.__meetingDbOpenShouldFail = false;
        const request = indexedDB.open('MeetingHistoryDB', 2);
        const db = await new Promise((resolve, reject) => {
          request.onupgradeneeded = () => {
            if (!request.result.objectStoreNames.contains('meetings')) {
              request.result.createObjectStore('meetings', { keyPath: 'id' });
            }
            if (!request.result.objectStoreNames.contains('folders')) {
              request.result.createObjectStore('folders', { keyPath: 'id' });
            }
          };
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        await new Promise((resolve, reject) => {
          const tx = db.transaction('meetings', 'readwrite');
          tx.objectStore('meetings').put({
            id: recoveryMeetingId,
            date: '2026-05-08 00:11',
            title: '회의 기록 복구 검증',
            summary: '재시도로 회의 기록을 불러왔습니다.',
            participants: '',
            meetingPurpose: '초기 로딩 복구 확인',
            sourceFile: 'load-recovery.wav',
            topics: [],
            segments: [],
          });
          tx.oncomplete = resolve;
          tx.onerror = () => reject(tx.error);
        });
        db.close();
      }, { recoveryMeetingId });
      await retryMeetingLoadButton.click();
      await loadErrorPage.getByRole('heading', { name: '회의 기록 복구 검증' }).waitFor({ timeout: 10000 });
    } finally {
      await loadErrorContext.close();
    }

    page = await browser.newPage({ viewport: { width: 1200, height: 800 } });
    page.on('request', request => {
      if (request.url().includes('/api/')) {
        apiCalls.push(`${request.method()} ${request.url()}`);
      }
    });
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
    await seedInitialAnalysisMeeting(page);
    await seedAudioMissingDiarizationMeeting(page);
    await seedUnlabeledAudioMissingMeeting(page);
    await seedLegacyParticipantMeeting(page);
    await seedSidebarMenuMeetings(page);
    await page.reload({ waitUntil: 'domcontentloaded' });

    assert.equal(
      await page.locator('.sidebar-folder-toolbar [data-sidebar-folder-menu-trigger]').count(),
      0,
      'folder create action should not render a management menu',
    );
    await page.getByRole('button', { name: '폴더 만들기', exact: true }).click();
    await page.getByLabel('새 폴더 이름').fill('UI 검수 폴더');
    await page.getByRole('button', { name: '만들기', exact: true }).click();
    const createdFolderButton = page.getByRole('button', { name: 'UI 검수 폴더', exact: true });
    await createdFolderButton.waitFor({ state: 'visible' });
    let folderMenuName = 'UI 검수 폴더';
    const getFolderMenuTrigger = () => page.getByRole('button', { name: `${folderMenuName} 폴더 메뉴`, exact: true });
    const folderMenu = page.locator('[data-sidebar-folder-menu]');
    const openFolderMenu = async () => {
      const trigger = getFolderMenuTrigger();
      await trigger.focus();
      await trigger.press('Enter');
      await folderMenu.waitFor({ state: 'visible' });
    };
    const folderOrderBeforeMove = await page.locator('.sidebar-folder-list .sidebar-folder-button span').allTextContents();
    const createdFolderIndexBeforeMove = folderOrderBeforeMove.indexOf('UI 검수 폴더');
    const previousFolderName = folderOrderBeforeMove[createdFolderIndexBeforeMove - 1];
    assert.ok(createdFolderIndexBeforeMove > 0 && previousFolderName);
    await openFolderMenu();
    assert.equal(
      await folderMenu.getByRole('menuitem', { name: '아래로 이동', exact: true }).isDisabled(),
      true,
      'last folder in the group should not move further down',
    );
    const moveFolderUp = folderMenu.getByRole('menuitem', { name: '위로 이동', exact: true });
    assert.equal(await moveFolderUp.isDisabled(), false);
    await moveFolderUp.click();
    await folderMenu.waitFor({ state: 'detached' });
    await page.waitForFunction(({ movedName, targetName }) => {
      const names = Array.from(document.querySelectorAll('.sidebar-folder-list .sidebar-folder-button span'))
        .map(element => element.textContent?.trim());
      return names.indexOf(movedName) === names.indexOf(targetName) - 1;
    }, { movedName: 'UI 검수 폴더', targetName: previousFolderName });
    const folderOrderAfterMove = await page.locator('.sidebar-folder-list .sidebar-folder-button span').allTextContents();
    assert.equal(folderOrderAfterMove.indexOf('UI 검수 폴더'), createdFolderIndexBeforeMove - 1);
    assert.equal(folderOrderAfterMove[createdFolderIndexBeforeMove], previousFolderName);

    const previousFolderButton = page.getByRole('button', { name: previousFolderName, exact: true });
    await createdFolderButton.dragTo(previousFolderButton, {
      targetPosition: { x: 40, y: 28 },
    });
    await page.waitForFunction(({ movedName, targetName }) => {
      const names = Array.from(document.querySelectorAll('.sidebar-folder-list .sidebar-folder-button span'))
        .map(element => element.textContent?.trim());
      return names.indexOf(movedName) === names.indexOf(targetName) + 1;
    }, { movedName: 'UI 검수 폴더', targetName: previousFolderName });
    assert.equal(await page.evaluate(async ({ previousFolderName }) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const folders = await new Promise((resolve, reject) => {
        const tx = db.transaction('folders', 'readonly');
        const getRequest = tx.objectStore('folders').getAll();
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(getRequest.error);
      });
      db.close();
      const movedFolder = folders.find(folder => folder.name === 'UI 검수 폴더');
      const previousFolder = folders.find(folder => folder.name === previousFolderName);
      return Number.isFinite(movedFolder?.sortOrder)
        && Number.isFinite(previousFolder?.sortOrder)
        && movedFolder.sortOrder > previousFolder.sortOrder;
    }, { previousFolderName }), true, 'mouse-dragged folder order should persist');
    await openFolderMenu();
    await folderMenu.getByRole('menuitem', { name: '상단 고정', exact: true }).click();
    await folderMenu.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(async () => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const folder = await new Promise((resolve, reject) => {
        const tx = db.transaction('folders', 'readonly');
        const getRequest = tx.objectStore('folders').get(
          Array.from(document.querySelectorAll('[data-sidebar-folder-menu-trigger]'))
            .find(trigger => trigger.getAttribute('aria-label') === 'UI 검수 폴더 폴더 메뉴')
            ?.getAttribute('aria-controls')
            ?.replace('sidebar-folder-menu-', ''),
        );
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(getRequest.error);
      });
      db.close();
      return folder?.pinned === true;
    }), true, 'folder pin state should persist');
    await openFolderMenu();
    const renameFolderDialog = new Promise((resolve, reject) => {
      page.once('dialog', async dialog => {
        try {
          assert.equal(dialog.type(), 'prompt');
          await dialog.accept('UI 검수 폴더 변경');
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await folderMenu.getByRole('menuitem', { name: '이름 변경', exact: true }).click();
    await renameFolderDialog;
    folderMenuName = 'UI 검수 폴더 변경';
    const renamedFolderButton = page.getByRole('button', { name: 'UI 검수 폴더 변경', exact: true });
    await renamedFolderButton.waitFor({ state: 'visible' });
    await openFolderMenu();
    const deleteFolderDialog = new Promise((resolve, reject) => {
      page.once('dialog', async dialog => {
        try {
          assert.equal(dialog.type(), 'confirm');
          await dialog.accept();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await folderMenu.getByRole('menuitem', { name: '삭제', exact: true }).click();
    await deleteFolderDialog;
    await renamedFolderButton.waitFor({ state: 'detached' });

    const relativeTimeRecordButton = page.getByTitle('경과 시간 검수 회의', { exact: true });
    const relativeTimeRecordRow = relativeTimeRecordButton.locator('xpath=..');
    const relativeTimeAge = relativeTimeRecordRow.locator('[data-sidebar-record-age]');
    await relativeTimeAge.getByText('2일', { exact: true }).waitFor({ timeout: 10000 });
    await relativeTimeRecordRow.hover();
    await page.waitForFunction(
      element => getComputedStyle(element).opacity === '0',
      await relativeTimeAge.elementHandle(),
    );
    await page.waitForFunction(
      element => getComputedStyle(element).opacity === '1',
      await relativeTimeRecordRow.locator('[data-sidebar-record-menu-trigger]').elementHandle(),
    );
    await page.evaluate(async () => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readwrite');
        tx.objectStore('meetings').delete('sidebar-relative-time');
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      window.dispatchEvent(new Event('meetings:updated'));
    });
    await relativeTimeRecordButton.waitFor({ state: 'detached' });

    const sidebarRecordMenuTriggers = page.locator('[data-sidebar-record-menu-trigger]');
    await sidebarRecordMenuTriggers.first().waitFor({ timeout: 10000 });
    await page.getByRole('main').hover();
    await page.waitForFunction(
      element => getComputedStyle(element).opacity === '0',
      await sidebarRecordMenuTriggers.first().elementHandle(),
    );
    await sidebarRecordMenuTriggers.first().locator('xpath=..').hover();
    await page.waitForFunction(
      element => getComputedStyle(element).opacity === '1',
      await sidebarRecordMenuTriggers.first().elementHandle(),
    );
    const sidebarRecordMenuLabels = await sidebarRecordMenuTriggers.evaluateAll(triggers => triggers.map(trigger => ({
      label: trigger.getAttribute('aria-label') ?? '',
      title: trigger.closest('.group')?.querySelector('button[title]:not([data-sidebar-record-menu-trigger])')?.getAttribute('title') ?? '',
    })));
    assert.equal(sidebarRecordMenuLabels.every(({ label, title }) => Boolean(title) && label.startsWith(title)), true);
    assert.equal(new Set(sidebarRecordMenuLabels.map(({ label }) => label)).size, sidebarRecordMenuLabels.length);
    assert.deepEqual(sidebarRecordMenuLabels.filter(({ title }) => title === '반복 주간회의').map(({ label }) => label).sort(), [
      '반복 주간회의, 2026-05-08 00:08 회의록 메뉴',
      '반복 주간회의, 2026-05-08 00:09 회의록 메뉴',
    ]);

    let sidebarMenuTriggerLabel = '오래된 고정 회의, 2026-04-01 09:00 회의록 메뉴';
    const sidebarMenuFallbackLabel = '반복 주간회의, 2026-05-08 00:09 회의록 메뉴';
    const getSidebarMenuTrigger = () => page.getByRole('button', { name: sidebarMenuTriggerLabel, exact: true });
    const sidebarRecordMenu = page.locator('[data-sidebar-record-menu]');
    const waitForSidebarMenuTriggerFocus = async () => {
      const trigger = getSidebarMenuTrigger();
      await page.waitForFunction(element => document.activeElement === element, await trigger.elementHandle());
    };
    const openSidebarRecordMenu = async () => {
      const trigger = getSidebarMenuTrigger();
      await trigger.focus();
      await trigger.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-sidebar-record-menu]')?.contains(document.activeElement));
      return sidebarRecordMenu.getByRole('button');
    };

    await page.evaluate(async () => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readwrite');
        const store = tx.objectStore('meetings');
        const getRequest = store.get('sidebar-recent-filler');
        getRequest.onsuccess = () => {
          store.put({
            ...getRequest.result,
            summary: '백그라운드에서 갱신된 최신 요약',
            updatedAt: new Date().toISOString(),
          });
        };
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    });
    const pinPreservationTrigger = page.getByRole('button', {
      name: '최근 회의 기록, 2026-05-08 00:07 회의록 메뉴',
      exact: true,
    });
    const openPinPreservationMenu = async () => {
      await pinPreservationTrigger.focus();
      await pinPreservationTrigger.press('Enter');
      await page.waitForFunction(() => document.querySelector('[data-sidebar-record-menu]')?.contains(document.activeElement));
      return sidebarRecordMenu.getByRole('button');
    };
    let pinPreservationItems = await openPinPreservationMenu();
    await pinPreservationItems.first().click();
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(async () => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readonly');
        const getRequest = tx.objectStore('meetings').get('sidebar-recent-filler');
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(getRequest.error);
      });
      db.close();
      return record?.summary === '백그라운드에서 갱신된 최신 요약' && record?.pinned === true;
    }), true, 'pinning should patch only pinned and preserve the latest meeting data');
    pinPreservationItems = await openPinPreservationMenu();
    await pinPreservationItems.first().click();
    await sidebarRecordMenu.waitFor({ state: 'detached' });

    let sidebarMenuItems = await openSidebarRecordMenu();
    assert.equal(await sidebarMenuItems.first().evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Escape');
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    await waitForSidebarMenuTriggerFocus();

    sidebarMenuItems = await openSidebarRecordMenu();
    await page.keyboard.press('Shift+Tab');
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    await waitForSidebarMenuTriggerFocus();

    sidebarMenuItems = await openSidebarRecordMenu();
    await sidebarMenuItems.last().focus();
    await page.keyboard.press('Tab');
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    await waitForSidebarMenuTriggerFocus();

    sidebarMenuItems = await openSidebarRecordMenu();
    await page.keyboard.press('Tab');
    assert.equal(await sidebarMenuItems.nth(1).evaluate(element => document.activeElement === element), true);
    await page.keyboard.press('Tab');
    const sidebarFolderSelect = sidebarRecordMenu.getByLabel('오래된 고정 회의 폴더');
    assert.equal(await sidebarFolderSelect.evaluate(element => document.activeElement === element), true);
    await sidebarFolderSelect.selectOption('sidebar-review-folder');
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    await waitForSidebarMenuTriggerFocus();
    assert.equal(await page.evaluate(async () => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const record = await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readonly');
        const getRequest = tx.objectStore('meetings').get('sidebar-old-pinned');
        getRequest.onsuccess = () => resolve(getRequest.result);
        getRequest.onerror = () => reject(getRequest.error);
      });
      db.close();
      return record?.folderId === 'sidebar-review-folder';
    }), true, 'keyboard folder move should persist the selected folder');
    const reviewFolderButton = page.getByRole('button', { name: '통합 검수 폴더', exact: true });
    await reviewFolderButton.click();
    await getSidebarMenuTrigger().waitFor({ state: 'visible' });
    sidebarMenuItems = await openSidebarRecordMenu();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await sidebarRecordMenu.getByLabel('오래된 고정 회의 폴더').selectOption('');
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    const createMeetingButton = page.getByRole('button', { name: '새 기록', exact: true });
    await page.waitForFunction(element => document.activeElement === element, await createMeetingButton.elementHandle());
    await reviewFolderButton.click();

    sidebarMenuItems = await openSidebarRecordMenu();
    const renameDialogDismissed = new Promise((resolve, reject) => {
      page.once('dialog', async dialog => {
        try {
          assert.equal(dialog.type(), 'prompt');
          await dialog.dismiss();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await sidebarMenuItems.nth(1).click();
    await renameDialogDismissed;
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    await waitForSidebarMenuTriggerFocus();

    sidebarMenuItems = await openSidebarRecordMenu();
    const deleteDialogDismissed = new Promise((resolve, reject) => {
      page.once('dialog', async dialog => {
        try {
          assert.equal(dialog.type(), 'confirm');
          await dialog.dismiss();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await sidebarMenuItems.last().click();
    await deleteDialogDismissed;
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    await waitForSidebarMenuTriggerFocus();

    sidebarMenuItems = await openSidebarRecordMenu();
    await sidebarMenuItems.first().click();
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    await getSidebarMenuTrigger().waitFor({ state: 'detached' });
    const sidebarMenuFallbackTrigger = page.getByRole('button', { name: sidebarMenuFallbackLabel, exact: true });
    await page.waitForFunction(element => document.activeElement === element, await sidebarMenuFallbackTrigger.elementHandle());
    sidebarMenuTriggerLabel = sidebarMenuFallbackLabel;

    sidebarMenuItems = await openSidebarRecordMenu();
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await page.keyboard.press('Tab');
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    assert.equal(await page.evaluate(() => {
      const activeElement = document.activeElement;
      return activeElement instanceof HTMLElement && activeElement !== document.body && !activeElement.closest('[data-sidebar-record-menu]');
    }), true);

    await page.evaluate(async () => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('folders', 'readwrite');
        const store = tx.objectStore('folders');
        Array.from({ length: 18 }, (_, index) => ({
          id: `sidebar-overflow-folder-${index}`,
          name: `스크롤 검수 폴더 ${String(index + 1).padStart(2, '0')}`,
          createdAt: '2026-05-08T00:00:00.000Z',
          updatedAt: '2026-05-08T00:00:00.000Z',
          sortOrder: 100 + index,
        })).forEach(folder => store.put(folder));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      window.dispatchEvent(new Event('meetings:updated'));
    });
    await page.getByRole('button', { name: '스크롤 검수 폴더 18', exact: true }).waitFor({ state: 'attached' });
    await page.setViewportSize({ width: 800, height: 720 });
    const sidebarContentScroll = page.locator('.sidebar-content-scroll');
    assert.equal(await sidebarContentScroll.evaluate(element => element.scrollHeight > element.clientHeight), true);
    const lastOverflowFolderMenuTrigger = page.getByRole('button', {
      name: '스크롤 검수 폴더 18 폴더 메뉴',
      exact: true,
    });
    await sidebarContentScroll.evaluate(element => {
      element.scrollTop = element.scrollHeight;
    });
    await lastOverflowFolderMenuTrigger.focus();
    await lastOverflowFolderMenuTrigger.press('Enter');
    await folderMenu.waitFor({ state: 'visible' });
    assert.equal(await folderMenu.getByRole('menuitem').last().isVisible(), true);
    const lastFolderMenuBounds = await page.evaluate(() => {
      const menu = document.querySelector('[data-sidebar-folder-menu]')?.getBoundingClientRect();
      return menu
        ? {
            inside: menu.top >= 0
              && menu.left >= 0
              && menu.right <= window.innerWidth
              && menu.bottom <= window.innerHeight,
            menuTop: menu.top,
            menuBottom: menu.bottom,
          }
        : { inside: false };
    });
    assert.equal(
      lastFolderMenuBounds.inside,
      true,
      `last folder menu should stay inside the viewport: ${JSON.stringify(lastFolderMenuBounds)}`,
    );
    await page.keyboard.press('Escape');
    await folderMenu.waitFor({ state: 'detached' });
    await page.getByRole('button', { name: '스크롤 검수 폴더 18', exact: true }).click();
    await page.waitForFunction(() => {
      const scroll = document.querySelector('.sidebar-content-scroll')?.getBoundingClientRect();
      const emptyState = Array.from(document.querySelectorAll('[data-sidebar-records] div'))
        .find(element => element.textContent?.trim() === '이 폴더에는 회의록이 없습니다.')
        ?.getBoundingClientRect();
      return Boolean(scroll && emptyState && emptyState.top >= scroll.top && emptyState.bottom <= scroll.bottom);
    });
    await page.getByRole('button', { name: '스크롤 검수 폴더 18', exact: true }).click();
    await page.waitForFunction(() => document.querySelectorAll('[data-sidebar-record-menu-trigger]').length > 0);

    const narrowSidebarMenuTrigger = page.locator('[data-sidebar-record-menu-trigger]').last();
    await narrowSidebarMenuTrigger.scrollIntoViewIfNeeded();
    await narrowSidebarMenuTrigger.focus();
    await narrowSidebarMenuTrigger.press('Enter');
    await sidebarRecordMenu.waitFor({ state: 'visible' });
    const narrowMenuBounds = await sidebarRecordMenu.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return { left: bounds.left, right: bounds.right, top: bounds.top, bottom: bounds.bottom };
    });
    assert.equal(narrowMenuBounds.left >= 0 && narrowMenuBounds.right <= 800, true);
    assert.equal(narrowMenuBounds.top >= 0 && narrowMenuBounds.bottom <= 720, true);
    assert.equal(await sidebarRecordMenu.getByRole('button').first().isVisible(), true);
    await page.keyboard.press('Escape');
    await sidebarRecordMenu.waitFor({ state: 'detached' });
    await page.setViewportSize({ width: 1200, height: 800 });
    await page.evaluate(async () => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction(['meetings', 'folders'], 'readwrite');
        const store = tx.objectStore('meetings');
        ['sidebar-old-pinned', 'sidebar-duplicate-later', 'sidebar-duplicate-earlier', 'sidebar-recent-filler'].forEach(id => store.delete(id));
        const folderStore = tx.objectStore('folders');
        folderStore.delete('sidebar-review-folder');
        Array.from({ length: 18 }, (_, index) => `sidebar-overflow-folder-${index}`)
          .forEach(id => folderStore.delete(id));
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      window.dispatchEvent(new Event('meetings:updated'));
    });
    await page.waitForFunction(() => document.querySelectorAll('[data-sidebar-record-menu-trigger]').length >= 8);


    const cacheMissMeetingId = 'codex-detail-flow-cache-miss-meeting';
    await page.evaluate(async ({ cacheMissMeetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readwrite');
        tx.objectStore('meetings').put({
          id: cacheMissMeetingId,
          date: '2026-05-08 00:10',
          title: '새 회의 전환 검증',
          summary: '캐시에 없는 새 회의입니다.',
          participants: '',
          meetingPurpose: '캐시 미스 전환 확인',
          sourceFile: 'cache-miss.wav',
          topics: [],
          segments: [],
        });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      window.__cacheMissSkeletonSeen = false;
      window.__previousMeetingVisibleDuringSkeleton = false;
      window.__cacheMissSkeletonObserver = new MutationObserver(() => {
        if (!document.querySelector('.meeting-detail-shell[aria-busy="true"]')) return;
        window.__cacheMissSkeletonSeen = true;
        if (document.querySelector('.meeting-detail-shell')?.textContent?.includes('요약 AI 미준비 회의록')) {
          window.__previousMeetingVisibleDuringSkeleton = true;
        }
      });
      window.__cacheMissSkeletonObserver.observe(document.body, { childList: true, subtree: true });
      window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: { id: cacheMissMeetingId, openHistory: true, detailTab: 'script' },
      }));
    }, { cacheMissMeetingId });
    await page.getByRole('heading', { name: '새 회의 전환 검증' }).waitFor({ timeout: 10000 });
    const cacheMissTransitionState = await page.evaluate(() => {
      window.__cacheMissSkeletonObserver?.disconnect();
      return {
        skeletonSeen: window.__cacheMissSkeletonSeen,
        previousMeetingVisibleDuringSkeleton: window.__previousMeetingVisibleDuringSkeleton,
      };
    });
    assert.equal(cacheMissTransitionState.skeletonSeen, true);
    assert.equal(cacheMissTransitionState.previousMeetingVisibleDuringSkeleton, false);
    await page.evaluate((targetMeetingId) => {
      window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: { id: targetMeetingId, openHistory: true, detailTab: 'script' },
      }));
    }, skippedMeetingId);
    await page.getByRole('heading', { name: '요약 AI 미준비 회의록' }).waitFor({ timeout: 10000 });
    const meetingSearchInput = page.getByRole('textbox', { name: '현재 회의에서 검색' });
    await meetingSearchInput.fill('확인');
    await page.getByText('요약 AI가 없어도 대화록은 확인할 수 있습니다.').waitFor({ state: 'visible' });
    const clearMeetingSearchButton = page.getByRole('button', { name: '검색어 지우기' });
    await clearMeetingSearchButton.waitFor({ state: 'visible' });
    await clearMeetingSearchButton.click();
    assert.equal(await meetingSearchInput.inputValue(), '');
    await meetingSearchInput.fill('일치하지 않는 검색어');
    await page.getByText('검색과 일치하는 대화록이 없습니다.').waitFor({ state: 'visible' });
    await meetingSearchInput.fill('대화록');
    await meetingSearchInput.press('Escape');
    assert.equal(await meetingSearchInput.inputValue(), '');
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '현재 회의에서 검색');
    assert.equal(await clearMeetingSearchButton.count(), 0);
    if (designCaptureDir) {
      await mkdir(designCaptureDir, { recursive: true });
      for (const width of [1024, 1280, 1440, 1920]) {
        await page.setViewportSize({ width, height: 900 });
        const horizontalOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        assert.equal(horizontalOverflow, 0, `${width}px viewport should not overflow horizontally`);
        await page.screenshot({
          path: resolve(designCaptureDir, `meeting-detail-${width}.png`),
          fullPage: true,
        });
      }
      await page.evaluate((targetMeetingId) => {
        window.dispatchEvent(new CustomEvent('meetings:updated', {
          detail: { id: targetMeetingId, openHistory: true, detailTab: 'summary' },
        }));
      }, meetingId);
      await page.getByRole('heading', { name: '시뮬레이션 회의록' }).waitFor({ timeout: 10000 });
      await page.getByRole('tab', { name: '기록 정리' }).click();
      for (const width of [1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const summaryHorizontalOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        assert.equal(summaryHorizontalOverflow, 0, `${width}px summary viewport should not overflow horizontally`);
        await page.screenshot({
          path: resolve(designCaptureDir, `meeting-summary-${width}.png`),
          fullPage: true,
        });
      }
      await page.getByRole('tab', { name: '보고서' }).click();
      for (const width of [1024, 1280, 1440]) {
        await page.setViewportSize({ width, height: 900 });
        const reportHorizontalOverflow = await page.evaluate(
          () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
        );
        assert.equal(reportHorizontalOverflow, 0, `${width}px report viewport should not overflow horizontally`);
        await page.screenshot({
          path: resolve(designCaptureDir, `meeting-report-${width}.png`),
          fullPage: true,
        });
      }
      await page.setViewportSize({ width: 1200, height: 800 });
      if (designCaptureOnly) {
        console.log(`ok - meeting detail design capture: ${designCaptureDir}`);
        return;
      }
    }
    await page.evaluate(async ({ cacheMissMeetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readwrite');
        tx.objectStore('meetings').delete(cacheMissMeetingId);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      window.dispatchEvent(new Event('meetings:updated'));
    }, { cacheMissMeetingId });



    await page.getByText('요약 AI 미준비 회의록').first().click();
    await page.getByText('요약 AI가 없어도 대화록은 확인할 수 있습니다.').waitFor({ timeout: 10000 });
    const skippedOrganizeTab = page.locator('.tab-list').getByRole('tab', { name: '기록 정리' });
    assert.equal(await skippedOrganizeTab.isDisabled(), false);
    await skippedOrganizeTab.click();
    await page.getByText('모델 필요').waitFor({ timeout: 10000 });
    await page.getByText('요약 모델이 준비되지 않아 대화록만 생성했습니다. 요약을 사용하려면 모델 상태를 확인해 주세요.').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '모델', exact: true }).click();
    const settingsModelsTab = page.getByRole('tab', { name: '모델' });
    await settingsModelsTab.waitFor({ timeout: 10000 });
    assert.equal(await settingsModelsTab.getAttribute('aria-selected'), 'true');
    await page.getByText('회의 요약 모델', { exact: true }).waitFor({ timeout: 10000 });
    await page.getByText('모델 선택', { exact: true }).waitFor({ timeout: 10000 });
    await page.locator('#settings-models-panel select').first().waitFor({ timeout: 10000 });
    await page.getByPlaceholder('예: llama3.2:3b').waitFor({ timeout: 10000 });
    await page.locator('#settings-models-panel option[value="gemma4:e2b"]').waitFor({ state: 'attached', timeout: 10000 });
    await page.locator('#settings-models-panel option[value="gemma4:e4b"]').waitFor({ state: 'attached', timeout: 10000 });
    await page.getByRole('link', { name: 'gemma4:e2b 모델 페이지' }).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '설정 닫기' }).click();
    assert.equal(await page.getByRole('button', { name: '전체 요약 정리' }).isDisabled(), true);

    await page.getByText('기존 정리 모델 미준비 회의록').first().click();
    await page.getByText('기존 정리 결과가 있는 대화록입니다.').waitFor({ timeout: 10000 });
    await page.locator('.tab-list').getByRole('tab', { name: '기록 정리' }).click();
    await page.getByText('이미 저장된 전체 요약입니다.').waitFor({ timeout: 10000 });
    await page.getByText('모델 필요').waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('button', { name: '전체 요약 정리' }).isDisabled(), true);
    await page.locator('.detail-mode-switch').getByRole('tab', { name: '주제별 정리' }).click();
    await page.getByText('이미 저장된 주제별 정리입니다.').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('button.detail-action-button[aria-label="주제별 정리"]').isDisabled(), true);
    await page.locator('.detail-mode-switch').getByRole('tab', { name: '참석자별 정리' }).click();
    await page.getByText('이미 저장된 참석자별 정리입니다.').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('button.detail-action-button[aria-label="참석자별 정리"]').isDisabled(), true);
    await page.getByRole('button', { name: '모델', exact: true }).click();
    summaryReady = true;
    await page.getByRole('button', { name: '설정 닫기' }).click();
    await page.getByRole('button', { name: '모델', exact: true }).click();
    await page.getByText('권장 항목으로 시작할 수 있습니다.').waitFor({ timeout: 12000 });
    await page.getByRole('button', { name: '설정 닫기' }).click();
    await page.locator('.detail-mode-switch').getByRole('tab', { name: '전체 요약' }).click();

    await page.getByText('원본 음성 누락 회의록').first().click();
    await page.getByText('참석자 구분 원본 음성 누락 확인').waitFor({ timeout: 10000 });
    await page.locator('.tab-list').getByRole('tab', { name: '기록 정리' }).click();
    const topDiarizationButton = page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 실행' });
    const detailDiarizationButton = page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 실행' });
    const audioRequiredButton = topDiarizationButton;
    await audioRequiredButton.waitFor({ timeout: 10000 });
    await page.waitForFunction(() => {
      const buttons = Array.from(document.querySelectorAll('.meeting-status-grid button'));
      return buttons.some(button => button.textContent?.includes('실행') && !button.disabled);
    }, null, { timeout: 10000 });
    assert.equal(await audioRequiredButton.isDisabled(), false);
    assert.equal(await detailDiarizationButton.count(), 0);
    await audioRequiredButton.click();
    await audioMissingDiarizationRequested;
    await page.getByText('참석자 구분에 필요한 원본 음성을 찾지 못했습니다. 음성 파일을 다시 분석해 주세요.').first().waitFor({ timeout: 10000 });
    await page.getByText('제외됨', { exact: true }).first().waitFor({ timeout: 10000 });
    assert.equal(await detailDiarizationButton.count(), 0);

    await page.getByText('참석자 표식 없는 회의록').first().click();
    await page.getByText('참석자 표식 없는 원본 음성 누락 확인').waitFor({ timeout: 10000 });
    await page.locator('.tab-list').getByRole('tab', { name: '기록 정리' }).click();
    await page.getByText('재실행 불가').first().waitFor({ timeout: 10000 });
    await page.getByText('저장된 음성 파일이 없어 참석자 구분을 다시 실행할 수 없습니다.').waitFor({ timeout: 10000 });
    assert.equal(await page.locator('section.detail-action-row').getByRole('button', { name: '참석자 구분 실행' }).count(), 0);

    await page.getByText('최초 분석 진행 회의록').first().click();
    await page.getByText('최초 분석 상태 보존').waitFor({ timeout: 10000 });
    await page.getByText('진행 중', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.evaluate(async ({ initialAnalysisMeetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const status = await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readonly');
        const getRequest = tx.objectStore('meetings').get(initialAnalysisMeetingId);
        getRequest.onsuccess = () => resolve(getRequest.result?.analysisStatus);
        getRequest.onerror = () => reject(getRequest.error);
      });
      db.close();
      return status;
    }, { initialAnalysisMeetingId }), 'diarization_in_progress');

    await page.evaluate(async ({ cancelMeetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readwrite');
        const store = tx.objectStore('meetings');
        const getRequest = store.get(cancelMeetingId);
        getRequest.onsuccess = () => store.put({ ...getRequest.result, analysisStatus: 'diarization_in_progress' });
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
      window.dispatchEvent(new Event('meetings:updated'));
    }, { cancelMeetingId });
    await page.getByText('참석자 구분 취소 회의록').first().click();
    await page.getByText('참석자 구분 취소 상태 확인').waitFor({ timeout: 10000 });
    await page.locator('.tab-list').getByRole('tab', { name: '기록 정리' }).click();
    const reconciledDiarizationButton = page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 실행' });
    await reconciledDiarizationButton.waitFor({ timeout: 10000 });
    assert.equal(await reconciledDiarizationButton.isDisabled(), false);
    assert.equal(await page.evaluate(async ({ cancelMeetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
      const db = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const status = await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readonly');
        const getRequest = tx.objectStore('meetings').get(cancelMeetingId);
        getRequest.onsuccess = () => resolve(getRequest.result?.analysisStatus);
        getRequest.onerror = () => reject(getRequest.error);
      });
      db.close();
      return status;
    }, { cancelMeetingId }), 'diarization_stopped');
    await reconciledDiarizationButton.click();
    await cancelDiarizationRequested;
    const cancelRunningButton = page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 중지/취소' });
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
      const request = indexedDB.open('MeetingHistoryDB', 2);
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
    await page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 실행' }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 실행' }).isDisabled(), false);
    await page.evaluate(async ({ cancelMeetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
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
      record.diarizationSkipped = true;
      record.diarizationSkipReason = 'runtime_error';
      record.diarizationSkipMessage = '참석자 구분 중 문제가 발생했습니다. 원본 음성과 모델 상태를 확인한 뒤 다시 실행해 주세요.';
      await new Promise((resolve, reject) => {
        const tx = db.transaction('meetings', 'readwrite');
        tx.objectStore('meetings').put(record);
        tx.oncomplete = resolve;
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    }, { cancelMeetingId });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await page.getByText('참석자 구분 취소 회의록').first().click();
    await page.getByText('참석자 구분 취소 상태 확인').waitFor({ timeout: 10000 });
    await page.locator('.tab-list').getByRole('tab', { name: '기록 정리' }).click();
    await page.getByText('재실행 필요', { exact: true }).waitFor({ timeout: 10000 });
    const runtimeRetryButton = page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 실행' });
    await runtimeRetryButton.waitFor({ timeout: 10000 });
    assert.equal(await runtimeRetryButton.isDisabled(), false);

    await page.getByText('시뮬레이션 회의록').first().click();
    await page.getByText('사용자가 다듬은 대화록입니다.').waitFor({ timeout: 10000 });
    const sourceFileValue = page.locator('.meeting-meta-value-source');
    assert.equal(await sourceFileValue.getAttribute('title'), 'simulation.mp4');
    const sourceFileStyle = await sourceFileValue.evaluate(element => ({
      overflow: getComputedStyle(element).overflow,
      textOverflow: getComputedStyle(element).textOverflow,
      whiteSpace: getComputedStyle(element).whiteSpace,
    }));
    assert.deepEqual(sourceFileStyle, {
      overflow: 'hidden',
      textOverflow: 'ellipsis',
      whiteSpace: 'nowrap',
    });
    assert.equal(
      await page.locator('#meeting-detail-panel-script').getByRole('heading', { name: '대화록', exact: true }).count(),
      0,
    );
    await page.getByRole('button', { name: '참석자 이름 변경', exact: true }).waitFor({ state: 'visible' });
    const reportTab = page.locator('.tab-list').getByRole('tab', { name: '보고서' });
    await reportTab.click();
    assert.equal(
      await page.locator('#meeting-detail-panel-report').getByRole('heading', { name: '보고서', exact: true }).count(),
      0,
    );
    await page.locator('.tab-list').getByRole('tab', { name: '기록 정리' }).click();

    const diarizationButton = page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 실행' });
    await diarizationButton.click();
    await diarizationRequested;
    await page.locator('.tab-list').getByRole('tab', { name: '대화록' }).click();
    await page.getByText('경과 시간').waitFor({ timeout: 10000 });
    const stopDiarizationButton = page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 중지/취소' });
    await stopDiarizationButton.waitFor({ timeout: 10000 });
    assert.equal(await stopDiarizationButton.isDisabled(), false);
    await stopDiarizationButton.click();
    await page.getByText('참석자 구분을 어떻게 처리할까요?').waitFor({ timeout: 10000 });
    await page.getByText('경과 시간').waitFor({ timeout: 10000 });
    await page.getByText('추정 남은 시간').waitFor({ timeout: 10000 });
    await page.locator('.diarization-stop-panel').getByRole('button', { name: '중지', exact: true }).click();
    await page.getByText('참석자 구분을 중지하고 있습니다. 원본 음성이 남아 있으면 이 회의록에서 다시 실행할 수 있습니다.').first().waitFor({ timeout: 10000 });
    const stoppingDiarizationButton = page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 중지 중' });
    await stoppingDiarizationButton.waitFor({ timeout: 10000 });
    assert.equal(await stoppingDiarizationButton.isDisabled(), true);
    releaseDiarizationResponse();
    assert.deepEqual(diarizationStopBodies, [{ action: 'defer' }]);
    const deferredRecord = await page.evaluate(async ({ meetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
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
    await page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 실행' }).waitFor({ timeout: 10000 });
    assert.equal(await page.locator('.meeting-status-grid').getByRole('button', { name: '참석자 구분 실행' }).isDisabled(), false);

    await page.locator('.tab-list').getByRole('tab', { name: '기록 정리' }).click();
    await page.locator('.detail-mode-switch').getByRole('tab', { name: '주제별 정리' }).click();

    const topicButton = page.locator('button.detail-action-button[aria-label="주제별 정리"]');
    await page.waitForFunction(() => {
      const button = Array.from(document.querySelectorAll('button')).find(item => item.getAttribute('aria-label') === '주제별 정리');
      return button && !button.disabled;
    }, null, { timeout: 10000 });
    await topicButton.click();
    await topicSectionsRequested;
    const runningTopicButton = page.getByRole('button', { name: '주제별 정리 중' });
    await runningTopicButton.waitFor({ timeout: 10000 });
    assert.equal(await runningTopicButton.isDisabled(), true);
    assert.equal(await page.getByRole('button', { name: '주제 추가 정리' }).count(), 0);
    assert.equal(await page.locator('button:has-text("정리 중") .animate-spin').count(), 1);
    assert.equal(await page.locator('button:has-text("추가 정리") .animate-spin').count(), 0);

    await page.getByText('다른 회의록').first().click();
    await page.getByRole('heading', { name: '다른 회의록' }).waitFor({ timeout: 10000 });
    await page.locator('.tab-list').getByRole('tab', { name: '기록 정리' }).click();
    await page.locator('.detail-mode-switch').getByRole('tab', { name: '주제별 정리' }).click();
    assert.equal(await page.getByRole('button', { name: '주제별 정리 중' }).count(), 0);
    const otherTopicButton = page.locator('button.detail-action-button[aria-label="주제별 정리"]');
    assert.equal(await otherTopicButton.isDisabled(), true);
    assert.equal(await page.locator('button:has-text("정리 중") .animate-spin').count(), 0);

    await page.getByText('시뮬레이션 회의록').first().click();
    await page.getByText('사용자가 다듬은 대화록입니다.').waitFor({ timeout: 10000 });
    await page.locator('.tab-list').getByRole('tab', { name: '기록 정리' }).click();
    await page.locator('.detail-mode-switch').getByRole('tab', { name: '주제별 정리' }).click();
    releaseTopicSectionsResponse();
    await page.getByText('AI 시스템 통제권과 지식 확장 방향을 정리했습니다.').waitFor({ timeout: 10000 });
    topicSectionsFailureCode = 'request_timeout';
    await topicButton.click();
    await page.getByText('정리 시간이 초과되었습니다. 기존 대화록과 정리 결과는 보존되었습니다. 잠시 후 다시 시도해 주세요.').waitFor({ timeout: 10000 });
    const preservedTopicRecord = await page.evaluate(async ({ meetingId }) => {
      const request = indexedDB.open('MeetingHistoryDB', 2);
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
    assert.equal(preservedTopicRecord.generationStatus.topicSections, 'completed');
    assert.equal(preservedTopicRecord.topicSections.length, 2);
    topicSectionsFailureCode = null;
    await page.locator('.detail-mode-switch').getByRole('tab', { name: '참석자별 정리' }).click();
    const speakerButton = page.locator('button.detail-action-button[aria-label="참석자별 정리"]');
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

    await page.getByRole('button', { name: '기록 정리 HWPX 파일을 다운로드 폴더에 저장' }).click();
    await page.getByRole('button', { name: '파일 저장', exact: true }).click();
    for (let attempt = 0; attempt < 50 && exportCalls.length === 0; attempt += 1) {
      await sleep(100);
    }
    await page.locator('button.detail-download-button svg.lucide-check').waitFor({ timeout: 10000 });
    assert.equal(await page.getByText('HWPX 파일을 다운로드 폴더에 저장했습니다.').count(), 0);

    assert.deepEqual(exportCalls, ['hwpx:save-copy']);
    assert.equal(exportBodies[0]?.exportScope, 'organized');
    assert.match(exportBodies[0]?.title ?? '', /_기록정리$/);
    assert.equal(exportBodies[0]?.meetingPurpose, 'AI 시스템 통제권 논의 정리');
    assert.equal(exportBodies[0]?.speakerLabels?.['화자1'], '김검토');
    assert.equal(exportBodies[0]?.displaySegments?.[0]?.text, '사용자가 다듬은 대화록입니다. 통제권과 지식 확장 기준을 길게 설명했습니다.');

    await page.locator('.tab-list').getByRole('tab', { name: '대화록' }).click();
    await page.getByRole('button', { name: '대화록 TXT 파일을 다운로드 폴더에 저장' }).click();
    await page.getByRole('button', { name: '파일 저장', exact: true }).click();
    for (let attempt = 0; attempt < 50 && exportCalls.length === 1; attempt += 1) {
      await sleep(100);
    }
    assert.deepEqual(exportCalls, ['hwpx:save-copy', 'txt:save-copy']);
    assert.equal(exportBodies[1]?.exportScope, 'transcript');
    assert.match(exportBodies[1]?.title ?? '', /_대화록$/);

    await page.getByRole('button', { name: '대화록 편집' }).click();
    const unsavedTranscriptDraft = page.getByLabel('김검토 대화록 수정').first();
    await unsavedTranscriptDraft.fill('저장하지 않은 대화록 편집 내용');
    await unsavedTranscriptDraft.focus();
    await page.evaluate((targetMeetingId) => {
      window.__meetingDetailSkeletonSeen = Boolean(document.querySelector('.meeting-detail-shell[aria-busy="true"]'));
      window.__meetingDetailSkeletonObserver = new MutationObserver(() => {
        if (document.querySelector('.meeting-detail-shell[aria-busy="true"]')) {
          window.__meetingDetailSkeletonSeen = true;
        }
      });
      window.__meetingDetailSkeletonObserver.observe(document.body, { childList: true, subtree: true });
      window.dispatchEvent(new CustomEvent('meetings:updated', { detail: { id: targetMeetingId } }));
    }, meetingId);
    await sleep(250);
    const backgroundRefreshState = await page.evaluate(() => {
      window.__meetingDetailSkeletonObserver?.disconnect();
      return {
        skeletonSeen: window.__meetingDetailSkeletonSeen,
        activeLabel: document.activeElement?.getAttribute('aria-label') ?? '',
      };
    });
    assert.equal(backgroundRefreshState.skeletonSeen, false);
    assert.equal(backgroundRefreshState.activeLabel, '김검토 대화록 수정');
    assert.equal(await unsavedTranscriptDraft.inputValue(), '저장하지 않은 대화록 편집 내용');
    const failedTransitionMeetingId = 'codex-detail-flow-failed-transition';
    await page.evaluate(() => {
      window.__guardCancelSkeletonSeen = false;
      window.__guardCancelSkeletonObserver = new MutationObserver(() => {
        if (document.querySelector('.meeting-detail-shell[aria-busy="true"]')) {
          window.__guardCancelSkeletonSeen = true;
        }
      });
      window.__guardCancelSkeletonObserver.observe(document.body, { childList: true, subtree: true });
    });
    const cancelledLeaveDialog = new Promise((resolve, reject) => {
      page.once('dialog', async dialog => {
        try {
          assert.equal(dialog.type(), 'confirm');
          assert.match(dialog.message(), /저장되지 않은 변경/);
          await dialog.dismiss();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await page.evaluate((targetMeetingId) => {
      window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: { id: targetMeetingId, openHistory: true, detailTab: 'script' },
      }));
    }, failedTransitionMeetingId);
    await cancelledLeaveDialog;
    await sleep(100);
    const cancelledTransitionState = await page.evaluate(() => {
      window.__guardCancelSkeletonObserver?.disconnect();
      return {
        skeletonSeen: window.__guardCancelSkeletonSeen,
        activeLabel: document.activeElement?.getAttribute('aria-label') ?? '',
      };
    });
    assert.equal(cancelledTransitionState.skeletonSeen, false);
    assert.equal(cancelledTransitionState.activeLabel, '김검토 대화록 수정');
    assert.equal(await page.getByRole('heading', { name: '시뮬레이션 회의록' }).count(), 1);
    assert.equal(await unsavedTranscriptDraft.inputValue(), '저장하지 않은 대화록 편집 내용');
    await page.waitForFunction(() => document.querySelector('button[aria-current="page"]')?.getAttribute('title') === '시뮬레이션 회의록');
    let unexpectedRefreshDialogCount = 0;
    const handleUnexpectedRefreshDialog = async dialog => {
      unexpectedRefreshDialogCount += 1;
      await dialog.dismiss();
    };
    page.on('dialog', handleUnexpectedRefreshDialog);
    await page.evaluate(() => window.dispatchEvent(new Event('meetings:updated')));
    await sleep(150);
    page.off('dialog', handleUnexpectedRefreshDialog);
    assert.equal(unexpectedRefreshDialogCount, 0);
    assert.equal(await unsavedTranscriptDraft.inputValue(), '저장하지 않은 대화록 편집 내용');

    const acceptedMissingTargetDialog = new Promise((resolve, reject) => {
      page.once('dialog', async dialog => {
        try {
          assert.equal(dialog.type(), 'confirm');
          await dialog.accept();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await page.evaluate((targetMeetingId) => {
      window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: { id: targetMeetingId, openHistory: true, detailTab: 'script' },
      }));
    }, failedTransitionMeetingId);
    await acceptedMissingTargetDialog;
    await page.getByText('선택한 회의록을 찾지 못했습니다. 회의 기록을 새로고침한 뒤 다시 시도해 주세요.').waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.querySelector('button[aria-current="page"]')?.getAttribute('title') === '시뮬레이션 회의록');
    assert.equal(await page.getByRole('heading', { name: '시뮬레이션 회의록' }).count(), 1);
    assert.equal(await unsavedTranscriptDraft.inputValue(), '저장하지 않은 대화록 편집 내용');
    await page.evaluate(() => {
      window.__failedTransitionOriginalOpen = indexedDB.open.bind(indexedDB);
      window.__failedTransitionDbOpen = true;
      Object.defineProperty(indexedDB, 'open', {
        configurable: true,
        value: (...args) => {
          if (!window.__failedTransitionDbOpen) return window.__failedTransitionOriginalOpen(...args);
          const failedRequest = {
            error: new DOMException('simulated IndexedDB failure', 'UnknownError'),
            onerror: null,
            onsuccess: null,
            onupgradeneeded: null,
          };
          queueMicrotask(() => failedRequest.onerror?.(new Event('error')));
          return failedRequest;
        },
      });
    });
    const acceptedLeaveDialog = new Promise((resolve, reject) => {
      page.once('dialog', async dialog => {
        try {
          assert.equal(dialog.type(), 'confirm');
          await dialog.accept();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await page.evaluate((targetMeetingId) => {
      window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: { id: targetMeetingId, openHistory: true, detailTab: 'script' },
      }));
    }, failedTransitionMeetingId);
    await acceptedLeaveDialog;
    await page.getByText('회의 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.').waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('heading', { name: '시뮬레이션 회의록' }).count(), 1);
    assert.equal(await unsavedTranscriptDraft.inputValue(), '저장하지 않은 대화록 편집 내용');
    await page.waitForFunction(() => document.querySelector('button[aria-current="page"]')?.getAttribute('title') === '시뮬레이션 회의록');
    await page.evaluate(() => {
      window.__failedTransitionDbOpen = false;
      Object.defineProperty(indexedDB, 'open', {
        configurable: true,
        value: window.__failedTransitionOriginalOpen,
      });
      delete window.__failedTransitionOriginalOpen;
      delete window.__failedTransitionDbOpen;
      window.dispatchEvent(new Event('meetings:updated'));
    });
    await sleep(100);
    assert.equal(await unsavedTranscriptDraft.inputValue(), '저장하지 않은 대화록 편집 내용');
    await page.evaluate((targetMeetingId) => {
      window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: {
          id: targetMeetingId,
          openHistory: true,
          detailTab: 'summary',
        },
      }));
    }, meetingId);
    const organizedDetailTab = page.locator('.tab-list').getByRole('tab', { name: '기록 정리' });
    await page.waitForFunction(element => element.getAttribute('aria-selected') === 'true', await organizedDetailTab.elementHandle());
    assert.equal(await organizedDetailTab.getAttribute('aria-selected'), 'true');
    await page.evaluate((targetMeetingId) => {
      window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: {
          id: targetMeetingId,
          openHistory: true,
          detailTab: 'script',
        },
      }));
    }, meetingId);
    const transcriptDetailTab = page.locator('.tab-list').getByRole('tab', { name: '대화록' });
    await page.waitForFunction(element => element.getAttribute('aria-selected') === 'true', await transcriptDetailTab.elementHandle());
    assert.equal(await transcriptDetailTab.getAttribute('aria-selected'), 'true');
    assert.equal(await unsavedTranscriptDraft.inputValue(), '저장하지 않은 대화록 편집 내용');
    await page.evaluate(() => {
      window.__pinRefreshOriginalOpen = indexedDB.open.bind(indexedDB);
      window.__pinRefreshOpenCount = 0;
      Object.defineProperty(indexedDB, 'open', {
        configurable: true,
        value: (...args) => {
          window.__pinRefreshOpenCount += 1;
          if (window.__pinRefreshOpenCount <= 2) return window.__pinRefreshOriginalOpen(...args);
          const failedRequest = {
            error: new DOMException('simulated pin refresh failure', 'UnknownError'),
            onerror: null,
            onsuccess: null,
            onupgradeneeded: null,
          };
          queueMicrotask(() => failedRequest.onerror?.(new Event('error')));
          return failedRequest;
        },
      });
    });
    let nonNavigationDialogCount = 0;
    const handleNonNavigationDialog = async dialog => {
      nonNavigationDialogCount += 1;
      await dialog.dismiss();
    };
    page.on('dialog', handleNonNavigationDialog);
    const otherMeetingMenuTrigger = page.getByRole('button', {
      name: '다른 회의록, 2026-05-08 00:01 회의록 메뉴',
      exact: true,
    });
    await otherMeetingMenuTrigger.focus();
    await otherMeetingMenuTrigger.press('Enter');
    await sidebarRecordMenu.getByRole('button', { name: '상단 고정', exact: true }).click();
    await page.getByText('회의 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.').waitFor({ timeout: 10000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '다른 회의록, 2026-05-08 00:01 회의록 메뉴');
    page.off('dialog', handleNonNavigationDialog);
    assert.equal(nonNavigationDialogCount, 0);
    assert.equal(await page.getByRole('heading', { name: '시뮬레이션 회의록' }).count(), 1);
    assert.equal(await unsavedTranscriptDraft.inputValue(), '저장하지 않은 대화록 편집 내용');
    await page.evaluate(() => {
      Object.defineProperty(indexedDB, 'open', {
        configurable: true,
        value: window.__pinRefreshOriginalOpen,
      });
      delete window.__pinRefreshOriginalOpen;
      delete window.__pinRefreshOpenCount;
    });
    await unsavedTranscriptDraft.focus();
    await page.evaluate(() => window.dispatchEvent(new Event('meetings:updated')));
    await page.getByText('회의 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.').waitFor({ state: 'detached', timeout: 10000 });
    await sleep(150);
    assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('aria-label')), '김검토 대화록 수정');

    let sidebarLeaveDialogCount = 0;
    const handleSidebarLeaveDialog = async dialog => {
      sidebarLeaveDialogCount += 1;
      assert.equal(dialog.type(), 'confirm');
      await dialog.accept();
    };
    page.on('dialog', handleSidebarLeaveDialog);
    await page.getByText('다른 회의록').first().click();
    await page.getByRole('heading', { name: '다른 회의록' }).waitFor({ timeout: 10000 });
    page.off('dialog', handleSidebarLeaveDialog);
    assert.equal(sidebarLeaveDialogCount, 1);
    await page.getByRole('button', { name: '회의 정보 수정' }).click();
    await page.locator('.meeting-detail-shell').getByRole('textbox', { name: '회의 제목', exact: true }).fill('');
    await page.getByRole('button', { name: '저장', exact: true }).click();
    await page.getByText('회의 제목과 일시는 비워둘 수 없습니다.').waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '수정 취소' }).click();

    const staleRequestMeetingId = 'codex-detail-flow-stale-request';
    await page.evaluate(() => {
      window.__heldMeetingOpenOriginal = indexedDB.open.bind(indexedDB);
      window.__heldMeetingOpenRequests = [];
      Object.defineProperty(indexedDB, 'open', {
        configurable: true,
        value: () => {
          const request = {
            error: new DOMException('simulated stale IndexedDB failure', 'UnknownError'),
            onerror: null,
            onsuccess: null,
            onupgradeneeded: null,
          };
          window.__heldMeetingOpenRequests.push(request);
          return request;
        },
      });
    });
    await page.evaluate((targetMeetingId) => {
      window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: { id: targetMeetingId, openHistory: true, detailTab: 'script' },
      }));
    }, staleRequestMeetingId);
    await page.waitForFunction(() => (window.__heldMeetingOpenRequests?.length ?? 0) > 0);
    await page.evaluate((targetMeetingId) => {
      Object.defineProperty(indexedDB, 'open', {
        configurable: true,
        value: window.__heldMeetingOpenOriginal,
      });
      window.dispatchEvent(new CustomEvent('meetings:updated', {
        detail: { id: targetMeetingId, openHistory: true, detailTab: 'script' },
      }));
    }, legacyParticipantMeetingId);
    await page.getByRole('heading', { name: '기본 별칭 참석자 회의록' }).waitFor({ timeout: 10000 });
    await page.evaluate(() => {
      const heldRequests = window.__heldMeetingOpenRequests ?? [];
      heldRequests.forEach(request => queueMicrotask(() => request.onerror?.(new Event('error'))));
      delete window.__heldMeetingOpenOriginal;
      delete window.__heldMeetingOpenRequests;
    });
    await sleep(200);
    assert.equal(await page.getByRole('heading', { name: '기본 별칭 참석자 회의록' }).count(), 1);
    assert.equal(await page.getByText('회의 기록을 불러오지 못했습니다. 잠시 후 다시 시도해 주세요.').count(), 0);
    assert.equal(await page.getByText('회의 제목과 일시는 비워둘 수 없습니다.').count(), 0);
    assert.equal(await page.locator('.meeting-detail-shell[aria-busy="true"]').count(), 0);
    await page.waitForFunction(() => document.querySelector('button[aria-current="page"]')?.getAttribute('title') === '기본 별칭 참석자 회의록');

    await page.getByText('기본 별칭 참석자 회의록').first().click();
    await page.getByRole('heading', { name: '기본 별칭 참석자 회의록' }).waitFor({ timeout: 10000 });
    await page.locator('.tab-list').getByRole('tab', { name: '기록 정리' }).click();
    await page.locator('.detail-mode-switch').getByRole('tab', { name: '참석자별 정리' }).click();
    const legacyCard = page.locator('article.detail-subtle-card').filter({ hasText: '참석자01' });
    assert.equal(await legacyCard.count(), 1);
    await legacyCard.getByText('발언 1회 · 텍스트 비중 100%').waitFor({ timeout: 10000 });

    const legacyDeleteMenuTrigger = page.getByRole('button', {
      name: '기본 별칭 참석자 회의록, 2026-05-08 00:02 회의록 메뉴',
      exact: true,
    });
    await legacyDeleteMenuTrigger.focus();
    await legacyDeleteMenuTrigger.press('Enter');
    const selectedDeleteDialog = new Promise((resolve, reject) => {
      page.once('dialog', async dialog => {
        try {
          assert.equal(dialog.type(), 'confirm');
          await dialog.accept();
          resolve();
        } catch (error) {
          reject(error);
        }
      });
    });
    await sidebarRecordMenu.getByRole('button', { name: '삭제', exact: true }).click();
    await selectedDeleteDialog;
    await legacyDeleteMenuTrigger.waitFor({ state: 'detached', timeout: 10000 });
    const fallbackSelectedRecord = page.locator('button[aria-current="page"]');
    await fallbackSelectedRecord.waitFor({ timeout: 10000 });
    const fallbackSelectedTitle = await fallbackSelectedRecord.getAttribute('title');
    assert.ok(fallbackSelectedTitle);
    assert.notEqual(fallbackSelectedTitle, '기본 별칭 참석자 회의록');
    await page.getByRole('heading', { name: fallbackSelectedTitle, exact: true }).waitFor({ timeout: 10000 });

    console.log('ok - meeting detail flow simulation');
  } catch (error) {
    console.error(error);
    console.error('api calls:', apiCalls);
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
