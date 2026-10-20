// Screen × state captures for docs/ui-production-audit.md.
// Mocked API only: this proves web UI rendering, not the local engine or the desktop executable.
// Usage: node scripts/capture-ui-audit.mjs [ID,ID,...]   (APP_URL / OUT_DIR / PLAYWRIGHT_BROWSERS_PATH as in other simulations)
import { spawn } from 'node:child_process';
import net from 'node:net';
import { mkdir, mkdtemp, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5199/';
const shouldStartServer = !process.env.APP_URL;
const OUT_DIR = process.env.OUT_DIR ?? fileURLToPath(new URL('../../.tmp/ui-audit/', import.meta.url));
const ONLY = new Set((process.argv[2] ?? '').split(',').map(value => value.trim()).filter(Boolean));
const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NOW = Date.now();

const waitForApp = async (url, timeoutMs = 45000) => {
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

const startServer = async () => {
  if (!shouldStartServer) {
    await waitForApp(APP_URL);
    return null;
  }
  const url = new URL(APP_URL);
  url.port = String(await getAvailablePort(url.hostname));
  APP_URL = url.toString();
  const child = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', `corepack pnpm exec vite --host ${url.hostname} --port ${url.port} --strictPort --configLoader runner`],
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
    const killer = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `taskkill /pid ${child.pid} /t /f`], { stdio: 'ignore', windowsHide: true });
    killer.on('exit', resolve);
    killer.on('error', resolve);
  });
};

// ---------------------------------------------------------------------------
// Seed data
// ---------------------------------------------------------------------------

const iso = offsetMs => new Date(NOW - offsetMs).toISOString();
const clock = seconds => {
  const pad = value => String(value).padStart(2, '0');
  return `${pad(Math.floor(seconds / 3600))}:${pad(Math.floor((seconds % 3600) / 60))}:${pad(seconds % 60)}`;
};

const LINES = [
  '3분기 연근해 자원조사 결과를 먼저 공유하겠습니다.',
  '고등어 어획량이 전 분기 대비 약 18% 줄었습니다. 수온이 평년보다 높게 유지되면서 어군이 북쪽으로 이동한 것으로 보입니다.',
  '남해 서부 정점에서는 표층 수온이 2도 이상 높게 나왔습니다.',
  '그러면 4분기 조사 정점을 북쪽으로 두 곳 더 늘리는 게 맞겠네요.',
  '네, 다만 선박 일정이 11월 둘째 주까지 차 있어서 조정이 필요합니다.',
  '음향 장비 교정은 10월 말까지 끝내야 다음 조사에 쓸 수 있습니다.',
  '교정 업체와는 이번 주 안에 일정을 확정하겠습니다.',
  '멸치 자원은 작년과 비슷한 수준이라 크게 걱정하지 않아도 될 것 같습니다.',
  '표본 수가 적었던 정점은 결과 해석에 주의가 필요합니다.',
  '보고서에는 수온 자료와 어획량 변화를 같이 넣어 주세요.',
  '지난번 회의에서 말한 시료 보관 문제는 해결됐나요?',
  '냉동고 한 대를 더 확보해서 지금은 문제가 없습니다.',
  '조사 결과는 다음 주 금요일까지 과장님께 보고하겠습니다.',
  '외부 협력 기관 자료는 아직 받지 못했습니다. 다시 요청하겠습니다.',
  '좋습니다. 그럼 오늘 결정한 내용을 정리하고 마치겠습니다.',
  '혹시 정점 추가에 따른 예산 영향도 같이 검토할 수 있을까요?',
  '연료비가 늘어나는 만큼 다른 항목에서 줄일 수 있는지 보겠습니다.',
  '자료 정리는 공유 폴더에 날짜별로 올려 두겠습니다.',
];

const buildSegments = (count, speakerKeys, { startSeconds = 3 } = {}) => {
  const segments = [];
  let cursor = startSeconds;
  for (let index = 0; index < count; index += 1) {
    const text = LINES[index % LINES.length];
    const length = 6 + (text.length % 19);
    segments.push({
      start: clock(cursor),
      end: clock(cursor + length),
      speaker: speakerKeys.length ? speakerKeys[(index * 7 + Math.floor(index / 3)) % speakerKeys.length] : '',
      text,
    });
    cursor += length + 1 + (index % 3);
  }
  return segments;
};

const THREE_SPEAKERS = { SPEAKER_00: '김연구', SPEAKER_01: '박조사', SPEAKER_02: '이선장' };
const mainSegments = buildSegments(40, Object.keys(THREE_SPEAKERS));

const REPORT_CONTENT = [
  '## 회의 개요',
  '3분기 연근해 자원조사 결과를 공유하고 4분기 조사 계획을 확정했다.',
  '',
  '## 주요 결과',
  '- 고등어 어획량이 전 분기 대비 약 18% 감소했다.',
  '- 남해 서부 정점의 표층 수온이 평년보다 2도 이상 높았다.',
  '- 멸치 자원은 전년과 비슷한 수준이다.',
  '',
  '## 결정 사항',
  '- 4분기 조사 정점을 북쪽으로 두 곳 추가한다.',
  '- 음향 장비 교정을 10월 말까지 마친다.',
  '',
  '## 후속 조치',
  '- 교정 업체 일정 확정(이번 주)',
  '- 외부 협력 기관 자료 재요청',
].join('\n');

const completeMeeting = {
  id: 'audit-main',
  title: '3분기 연근해 자원조사 결과 보고',
  date: iso(2 * HOUR),
  createdAt: iso(2 * HOUR),
  updatedAt: iso(2 * HOUR),
  participants: '',
  meetingPurpose: '3분기 조사 결과 공유와 4분기 조사 계획 확정',
  sourceFile: '2026-10-18_자원조사_보고회의.m4a',
  jobId: 'audit-main-job',
  segments: mainSegments,
  displaySegments: mainSegments,
  speakerLabels: THREE_SPEAKERS,
  analysisStatus: 'completed',
  diarizationRequested: true,
  diarizationApplied: true,
  summary: '3분기 고등어 어획량이 수온 상승 영향으로 약 18% 줄었다. 4분기에는 북쪽 조사 정점을 두 곳 늘리고, 음향 장비 교정을 10월 말까지 마친 뒤 조사를 진행하기로 했다. 외부 협력 기관 자료는 다시 요청한다.',
  topics: ['어획량 감소와 수온', '4분기 조사 정점', '음향 장비 교정'],
  decisions: ['4분기 조사 정점을 북쪽으로 두 곳 추가한다.', '음향 장비 교정을 10월 말까지 마친다.', '조사 결과는 다음 주 금요일까지 보고한다.'],
  actions: ['교정 업체와 일정 확정 (이선장, 이번 주)', '외부 협력 기관 자료 재요청 (박조사)', '정점 추가에 따른 예산 영향 검토 (김연구)', '자료를 공유 폴더에 날짜별로 정리'],
  needsCheck: ['표본 수가 적은 정점의 해석 방법', '11월 둘째 주 선박 일정 조정 가능 여부'],
  topicSections: [
    { topic: '어획량 감소와 수온', summary: '고등어 어획량이 전 분기 대비 약 18% 줄었고, 표층 수온 상승으로 어군이 북상한 것으로 보인다.', evidence: ['남해 서부 정점 표층 수온 +2도'], actions: ['수온 자료를 보고서에 함께 수록'] },
    { topic: '4분기 조사 정점', summary: '북쪽 정점 두 곳을 추가하되 선박 일정과 연료비 영향을 함께 검토한다.', evidence: ['선박 일정 11월 둘째 주까지 확정'], actions: ['예산 영향 검토'] },
    { topic: '음향 장비 교정', summary: '다음 조사 전에 교정을 마쳐야 하며 이번 주 안에 업체 일정을 확정한다.', evidence: [], actions: ['교정 업체 일정 확정'] },
  ],
  speakerContextSummaries: [
    { speaker: 'SPEAKER_00', display_name: '김연구', role_in_meeting: '진행', summary: '조사 결과 공유와 결정 사항 정리를 맡았다.', key_points: ['정점 추가 제안'], actions: ['예산 영향 검토'] },
    { speaker: 'SPEAKER_01', display_name: '박조사', role_in_meeting: '조사 결과 보고', summary: '어획량과 수온 변화를 설명했다.', key_points: ['어획량 18% 감소'], actions: ['외부 자료 재요청'] },
    { speaker: 'SPEAKER_02', display_name: '이선장', role_in_meeting: '선박·장비 운영', summary: '선박 일정과 장비 교정 일정을 공유했다.', key_points: ['교정 10월 말 완료'], actions: ['교정 업체 일정 확정'] },
  ],
  generationStatus: { summary: 'completed', topicSections: 'completed', speakerContextSummaries: 'completed', meetingReport: 'completed' },
  selectedReportTemplateId: 'standard-minutes',
  meetingReport: { templateId: 'standard-minutes', templateName: '기본 보고서', generatedAt: iso(90 * MINUTE), content: REPORT_CONTENT },
};

const unorganizedMeeting = {
  ...completeMeeting,
  id: 'audit-unorganized',
  title: '주간 운영 회의',
  meetingPurpose: '이번 주 업무 점검',
  jobId: 'audit-unorganized-job',
  date: iso(5 * HOUR),
  createdAt: iso(5 * HOUR),
  updatedAt: iso(5 * HOUR),
  summary: '',
  topics: [],
  decisions: [],
  actions: [],
  needsCheck: [],
  topicSections: [],
  speakerContextSummaries: [],
  meetingReport: undefined,
  generationStatus: { summary: 'not_started', topicSections: 'not_started', speakerContextSummaries: 'not_started', meetingReport: 'not_started' },
};

const editedSegments = mainSegments.map((segment, index) => (index === 1 ? { ...segment, text: `${segment.text} (수정: 18%가 아니라 17.6%)` } : segment));
const outdatedMeeting = {
  ...completeMeeting,
  id: 'audit-outdated',
  title: '자원조사 보고 (대화록 수정됨)',
  jobId: 'audit-outdated-job',
  date: iso(1 * DAY + 3 * HOUR),
  createdAt: iso(1 * DAY + 3 * HOUR),
  updatedAt: iso(1 * HOUR),
  editedDisplaySegments: editedSegments,
  transcriptEditMeta: { edited: true, editedAt: iso(1 * HOUR), summaryOutdated: true, topicSectionsOutdated: true, speakerContextOutdated: true },
};

const singleSpeakerSegments = buildSegments(18, []);
const singleSpeakerMeeting = {
  id: 'audit-single',
  title: '현장 메모 녹음',
  date: iso(2 * DAY),
  createdAt: iso(2 * DAY),
  updatedAt: iso(2 * DAY),
  participants: '',
  meetingPurpose: '',
  sourceFile: '현장메모.m4a',
  jobId: 'audit-single-job',
  segments: singleSpeakerSegments,
  displaySegments: singleSpeakerSegments,
  speakerLabels: {},
  analysisStatus: 'completed',
  diarizationRequested: false,
  summary: '현장 조사 중 확인한 내용을 기록했다.',
  topics: ['현장 확인'],
  generationStatus: { summary: 'completed', topicSections: 'not_started', speakerContextSummaries: 'not_started' },
};

const FOUR_SPEAKERS = { SPEAKER_00: '김연구', SPEAKER_01: '박조사', SPEAKER_02: '이선장', SPEAKER_03: '최주무관' };
const longSegments = buildSegments(600, Object.keys(FOUR_SPEAKERS));
const longMeeting = {
  ...completeMeeting,
  id: 'audit-long',
  title: '상반기 사업 점검 워크숍 (2시간 40분)',
  meetingPurpose: '상반기 사업 현황 점검과 하반기 계획',
  jobId: 'audit-long-job',
  date: iso(4 * DAY),
  createdAt: iso(4 * DAY),
  updatedAt: iso(4 * DAY),
  segments: longSegments,
  displaySegments: longSegments,
  speakerLabels: FOUR_SPEAKERS,
};

const failedDiarizationMeeting = {
  ...singleSpeakerMeeting,
  id: 'audit-diar-failed',
  title: '외부 협력 기관 업무 협의 — 공동 조사 범위, 자료 공유 방식, 예산 분담과 일정 조율',
  meetingPurpose: '아주 긴 회의 목적 문장입니다. 상반기 사업 현황 점검과 결정사항, 후속 조치 담당자 지정, 외부 기관과의 자료 공유 범위와 보안 절차까지 모두 다룹니다',
  sourceFile: '2026-10-11_외부협력기관_공동조사_범위_협의_회의_원본_녹음파일_최종본.m4a',
  analysisStatus: 'diarization_failed',
  diarizationRequested: true,
  jobId: 'audit-diar-failed-job',
  date: iso(7 * DAY),
  createdAt: iso(7 * DAY),
  updatedAt: iso(7 * DAY),
};

const MANY_SPEAKERS = Object.fromEntries(['김연구', '박조사', '이선장', '최주무관', '정팀장', '한과장', '오연구', '윤조사', '임선원', '서주무관'].map((name, index) => [`SPEAKER_${String(index).padStart(2, '0')}`, name]));
const manySegments = buildSegments(30, Object.keys(MANY_SPEAKERS));
const manySpeakersMeeting = {
  ...completeMeeting,
  id: 'audit-many',
  title: '분기 합동 회의 (10명)',
  jobId: 'audit-many-job',
  date: iso(12 * DAY),
  createdAt: iso(12 * DAY),
  updatedAt: iso(12 * DAY),
  segments: manySegments,
  displaySegments: manySegments,
  speakerLabels: MANY_SPEAKERS,
};

const FOLDERS = [
  { id: 'folder-survey', name: '수산자원 조사', createdAt: iso(40 * DAY), updatedAt: iso(40 * DAY), pinned: true, sortOrder: 0 },
  { id: 'folder-weekly', name: '주간 운영', createdAt: iso(39 * DAY), updatedAt: iso(39 * DAY), sortOrder: 1 },
  { id: 'folder-partner', name: '외부 협력', createdAt: iso(38 * DAY), updatedAt: iso(38 * DAY), sortOrder: 2 },
];

const fillerMeeting = (id, title, offsetMs, extra = {}) => ({
  id,
  title,
  date: iso(offsetMs),
  createdAt: iso(offsetMs),
  updatedAt: iso(offsetMs),
  participants: '',
  meetingPurpose: extra.meetingPurpose ?? '',
  summary: '',
  segments: [],
  displaySegments: [],
  speakerLabels: {},
  ...extra,
});

const FILLERS = [
  fillerMeeting('audit-f1', '어선 안전 교육 계획', 20 * DAY, { folderId: 'folder-weekly' }),
  fillerMeeting('audit-f2', '시료 분석 의뢰 협의', 25 * DAY, { meetingPurpose: '분석 항목과 납기 협의', folderId: 'folder-partner' }),
  fillerMeeting('audit-f3', '9월 월간 보고', 33 * DAY),
  fillerMeeting('audit-f4', '연구선 정비 일정', 45 * DAY, { pinned: true }),
  fillerMeeting('audit-f5', '하계 조사 결과 정리', 62 * DAY, { folderId: 'folder-survey' }),
  fillerMeeting('audit-f6', '신규 과제 기획 1차', 70 * DAY),
  fillerMeeting('audit-f7', '데이터 관리 지침 검토', 85 * DAY),
];

const ALL_MEETINGS = [
  { ...completeMeeting, folderId: 'folder-survey' },
  unorganizedMeeting,
  outdatedMeeting,
  singleSpeakerMeeting,
  longMeeting,
  failedDiarizationMeeting,
  manySpeakersMeeting,
  ...FILLERS,
];

// ---------------------------------------------------------------------------
// Mocked API
// ---------------------------------------------------------------------------

const json = (body, status = 200) => ({ status, contentType: 'application/json', body: JSON.stringify(body) });

const SETTINGS = {
  processing: { long_audio_chunk_seconds: 30, enable_long_audio_chunking: true },
  diarization: { enabled: true, generate_during_analysis: true },
  stt: { selected_model: 'faster-whisper-large-v3', device: 'cpu' },
  preprocessing: { enabled: true },
  privacy: { preserve_extracted_audio: false, auto_save_hwpx_copy: false, auto_save_audio_copy: false },
  summary: {
    provider: 'ollama',
    model: 'gemma4:e2b',
    model_options: [
      { model: 'gemma4:e2b', label: '2B', description: '용량과 속도를 우선할 때 사용합니다.', url: 'https://ollama.com/library/gemma4%3Ae2b', command: 'ollama run gemma4:e2b' },
      { model: 'gemma4:e4b', label: '4B', description: 'PC 여유가 있으면 더 큰 모델을 사용할 수 있습니다.', url: 'https://ollama.com/library/gemma4%3Ae4b', command: 'ollama run gemma4:e4b' },
    ],
    user_models: [],
  },
};

const modelStatus = ({ sttInstalled = true, downloadable = true } = {}) => ({
  ready: sttInstalled,
  summary_ready: true,
  errors: [],
  ollama_runtime_status: {
    key: 'ollama_runtime', available: true, active: false, status: 'completed', message: '요약 프로그램이 준비되어 있습니다.',
    target_path: 'runtime\\ollama', executable_path: 'runtime\\ollama\\ollama.exe', downloaded_bytes: 0, expected_bytes: 1600000000, progress_percent: null, eta_seconds: null,
  },
  models: [
    { key: 'stt_faster_whisper', label: 'STT', repo_id: 'Systran/faster-whisper-large-v3', installed: sttInstalled, required: true, downloadable, manual_note: downloadable ? '설정에서 음성 인식 모델을 받을 수 있습니다.' : '', install_url: 'https://huggingface.co/Systran/faster-whisper-large-v3' },
    { key: 'diarization', label: 'Diarization', repo_id: 'pyannote/speaker-diarization-community-1', installed: true, required: true },
    { key: 'llm', label: 'Gemma via Ollama', installed: true, configured_model: 'gemma4:e2b', installed_model: 'gemma4:e2b', installed_models: ['gemma4:e2b'], ollama_available: true, required: false, install_options: SETTINGS.summary.model_options },
  ],
  stt_device_status: { gpu_detected: false, gpu_usable: false },
  system_profile: { memory_gb: 16 },
  summary_model_recommendation: { model: 'gemma4:e4b', basis: 'memory', message: '이 PC 메모리는 약 16GB입니다. 4B를 권장합니다.' },
});

const installRoutes = async (page, options = {}) => {
  const { engineDown = false, model = {}, drafts = [], analyze = null, generation = {}, holdSettings = false, holdModels = false } = options;
  await page.route('**/api/**', route => (engineDown ? route.abort('connectionrefused') : route.fulfill(json({ detail: 'not mocked' }, 404))));
  if (engineDown) return;
  await page.route('**/api/health', route => route.fulfill(json({ ok: true })));
  // hold* keep a response pending so the loading state stays on screen.
  await page.route('**/api/settings', route => (holdSettings && route.request().method() === 'GET' ? hangForever() : route.fulfill(json(SETTINGS))));
  await page.route('**/api/models/status', route => (holdModels ? hangForever() : route.fulfill(json(modelStatus(model)))));
  await page.route('**/api/models/ollama/runtime-status', route => route.fulfill(json(modelStatus(model).ollama_runtime_status)));
  await page.route('**/api/models/download-status**', route => route.fulfill(json({ active: false, status: 'idle' })));
  await page.route('**/api/models/ollama/pull-status**', route => route.fulfill(json({ active: false, status: 'idle' })));
  await page.route('**/api/analyze/draft-statuses', route => route.fulfill(json({ drafts })));
  await page.route('**/api/analyze/resume-candidates', route => route.fulfill(json({ recommended_job_id: null, candidates: [] })));
  await page.route('**/api/analyze/preflight', route => route.fulfill(json({ ok: true, level: 'ok', reason: 'enough_storage', required_bytes: 1024, available_bytes: 1024 ** 3, message: '저장 공간을 확인했습니다.' })));
  await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill(json({ detail: 'disabled' }, 404)));
  if (analyze) await page.route('**/api/analyze', analyze);
  for (const [suffix, handler] of Object.entries(generation)) {
    await page.route(`**/${suffix}`, handler);
  }
};

const sse = events => ({
  status: 200,
  contentType: 'text/event-stream',
  body: `${events.map(([event, data]) => `event: ${event}\ndata: ${typeof data === 'string' ? data : JSON.stringify(data)}\n`).join('\n')}\n\n`,
});

// Holds the analysis stream open after one progress event so the in-progress view stays on screen.
const holdAnalysisStreamOpen = () => {
  const originalFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const isRequest = input instanceof Request;
    const url = new URL(isRequest ? input.url : String(input), window.location.href);
    const method = (init?.method ?? (isRequest ? input.method : 'GET')).toUpperCase();
    if (method === 'POST' && /\/api\/analyze$/.test(url.pathname)) {
      const encoder = new TextEncoder();
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode('event: progress\ndata: {"type":"progress","progress":34,"status":"transcribing","message":"Transcribing chunk 2/6...","eta_seconds":420}\n\n'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'Content-Type': 'text/event-stream' } });
    }
    return originalFetch(input, init);
  };
};

// ---------------------------------------------------------------------------
// Page helpers
// ---------------------------------------------------------------------------

const seedDb = async (page, meetings, folders = []) => page.evaluate(([meetingValues, folderValues]) => new Promise((resolve, reject) => {
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
    meetingValues.forEach(value => transaction.objectStore('meetings').put(value));
    folderValues.forEach(value => transaction.objectStore('folders').put(value));
    transaction.oncomplete = () => {
      db.close();
      window.dispatchEvent(new Event('meetings:updated'));
      window.dispatchEvent(new Event('folders:updated'));
      resolve();
    };
    transaction.onerror = () => reject(transaction.error);
  };
}), [meetings, folders]);

const ready = page => page.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor({ timeout: 20000 });

const seedAndReload = async (page, meetings = ALL_MEETINGS, folders = FOLDERS) => {
  await ready(page);
  await seedDb(page, meetings, folders);
  // Reload so every list reads the seeded store through its normal first-load path.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page);
  await page.waitForTimeout(400);
};

const openMeeting = async (page, title) => {
  const navigation = page.locator('.barorok-navigation');
  const row = navigation.getByText(title, { exact: true }).first();
  // A meeting in a folder is listed only while its folder is open (sidebar folders expand in place).
  if (!(await row.waitFor({ state: 'visible', timeout: 1500 }).then(() => true, () => false))) {
    const collapsedFolders = navigation.locator('.sidebar-folder-button[aria-expanded="false"]');
    while (await collapsedFolders.count() && !(await row.isVisible())) {
      await collapsedFolders.first().click();
    }
  }
  await row.click();
  await page.locator('.meeting-detail-shell').getByRole('heading', { name: title }).waitFor({ timeout: 10000 });
  await page.waitForTimeout(300);
};

const openTab = async (page, name) => {
  await page.getByRole('tab', { name, exact: true }).first().click();
  await page.waitForTimeout(300);
};

let fixture;
const createFixture = async () => {
  const dir = await mkdtemp(join(tmpdir(), 'barorok-ui-audit-'));
  const path = join(dir, '2026-10-18_자원조사_보고회의.mp4');
  await writeFile(path, Buffer.alloc(256, 4));
  const info = await stat(path);
  return { path, size: info.size, lastModified: Math.trunc(info.mtimeMs) };
};

const fillWriter = async page => {
  await page.setInputFiles('#meeting-file-input', fixture.path);
  await page.getByLabel('회의 목적 *').fill('3분기 조사 결과 공유와 4분기 조사 계획 확정');
  await page.waitForTimeout(300);
};

const stoppedDraft = () => ({
  jobId: 'audit-draft-stopped',
  title: '10월 셋째 주 운영 회의',
  date: iso(26 * HOUR).slice(0, 16),
  meetingPurpose: '운영 현안 점검',
  sourceFilename: '10월_셋째주_운영회의.mp4',
  sourceSize: 52_428_800,
  sourceLastModified: NOW - 27 * HOUR,
  status: 'cancelled',
  createdAt: iso(26 * HOUR),
  updatedAt: iso(25 * HOUR),
  stage: 'cancelled',
  lastMessage: 'Transcribing chunk 2/4...',
  lastProgress: 45,
});
const failedDraft = () => ({
  ...stoppedDraft(),
  jobId: 'audit-draft-failed',
  title: '장비 점검 회의',
  sourceFilename: '장비점검.m4a',
  status: 'failed',
  stage: 'failed',
  lastProgress: 20,
  errorMessage: '음성 파일을 읽는 중 문제가 생겼습니다.',
  createdAt: iso(3 * DAY),
  updatedAt: iso(3 * DAY),
});
const remoteDraftStatuses = [
  { job_id: 'audit-draft-stopped', status: 'cancelled', stage: 'cancelled', updated_at: iso(25 * HOUR), resume_supported: true, completed_chunk_count: 2, last_progress: { message: 'Transcribing chunk 2/4...', progress: 45, status: 'cancelled' } },
  { job_id: 'audit-draft-failed', status: 'failed', stage: 'failed', updated_at: iso(3 * DAY), resume_supported: true, completed_chunk_count: 1, last_progress: { message: 'Transcribing chunk 1/4...', progress: 20, status: 'failed' }, last_error: '음성 파일을 읽는 중 문제가 생겼습니다.' },
];
const withDrafts = drafts => ({
  init: value => window.localStorage.setItem('analysisResumeDrafts', JSON.stringify(value)),
  initArg: drafts,
});

const hangForever = () => new Promise(() => {});

// ---------------------------------------------------------------------------
// Captures
// ---------------------------------------------------------------------------

const WIDE = { width: 1280, height: 720 };
const NARROW = { width: 800, height: 720 };
const LARGE = { width: 1920, height: 1080 };

const captures = [
  { id: 'W1', note: '새 회의록 빈 상태', steps: async page => { await ready(page); await page.waitForTimeout(600); } },
  { id: 'W1@800', viewport: NARROW, note: '새 회의록 빈 상태, 좁은 창', steps: async page => { await ready(page); await page.waitForTimeout(600); } },
  { id: 'W2', note: '최근 회의록 있음 (사이드바 B1 겸용)', steps: async page => { await seedAndReload(page); } },
  { id: 'W2@1920', viewport: LARGE, note: '최근 회의록, 넓은 창', steps: async page => { await seedAndReload(page); } },
  { id: 'W3', note: '파일 선택 후', steps: async page => { await seedAndReload(page); await fillWriter(page); } },
  { id: 'W3@800', viewport: NARROW, note: '파일 선택 후, 좁은 창', steps: async page => { await seedAndReload(page); await fillWriter(page); } },
  {
    id: 'W4', note: '빈 칸으로 분석 시작',
    steps: async page => { await ready(page); await page.getByRole('button', { name: '분석 시작' }).click(); await page.waitForTimeout(400); },
  },
  { id: 'W5', note: '모델 없음 (설정에서 받을 수 있음)', routes: { model: { sttInstalled: false, downloadable: true } }, steps: async page => { await ready(page); await page.locator('.status-banner').first().waitFor({ timeout: 20000 }); await page.waitForTimeout(400); } },
  { id: 'W6', note: '모델 없음 (받을 수 없음)', routes: { model: { sttInstalled: false, downloadable: false } }, steps: async page => { await ready(page); await page.locator('.status-banner').first().waitFor({ timeout: 20000 }); await page.waitForTimeout(400); } },
  { id: 'W7', note: '바로록 연결 45초 무응답', routes: { engineDown: true }, steps: async page => { await ready(page); const started = Date.now(); await page.locator('.writer-action-bar').getByRole('button', { name: /다시 확인|문제 해결/ }).first().waitFor({ timeout: 90000 }); await page.waitForTimeout(300); return { noticeAfterMs: Date.now() - started }; } },
  {
    id: 'W8', note: '이어서 할 분석 + 최근 회의록', routes: { drafts: remoteDraftStatuses }, ...withDrafts([stoppedDraft(), failedDraft()]),
    steps: async page => { await seedAndReload(page); await page.waitForTimeout(800); },
  },
  {
    id: 'A1', note: '분석 진행 중 (사이드바 B4 분석 중 카드 포함)', init: holdAnalysisStreamOpen,
    steps: async page => { await seedAndReload(page); await fillWriter(page); await page.getByRole('button', { name: '분석 시작' }).click(); const started = Date.now(); await page.getByText('음성 인식 2/6 구간').first().waitFor({ timeout: 30000 }); await page.waitForTimeout(400); return { progressShownAfterMs: Date.now() - started }; },
  },
  {
    id: 'A2', note: '분석 실패',
    routes: { analyze: route => route.fulfill(sse([['progress', { type: 'progress', progress: 34, status: 'transcribing', message: 'Transcribing chunk 1/3...' }], ['error', { type: 'error', progress: 34, status: 'error', message: 'CUDA out of memory. Tried to allocate 2.00 GiB' }], ['done', '[DONE]']])) },
    steps: async page => { await seedAndReload(page); await fillWriter(page); await page.getByRole('button', { name: '분석 시작' }).click(); await page.getByRole('heading', { name: '분석을 마치지 못했습니다' }).waitFor({ timeout: 10000 }); await page.waitForTimeout(400); },
  },
  {
    id: 'A3', note: '분석 완료',
    routes: {
      analyze: route => route.fulfill(sse([
        ['progress', { type: 'progress', progress: 90, status: 'diarizing', message: '참석자 구분 중', transcript_ready: true }],
        ['result', { type: 'result', progress: 100, status: 'completed', summary: '', segments: mainSegments, display_segments: mainSegments, meeting: { source_file: '2026-10-18_자원조사_보고회의.mp4', job_id: 'audit-complete-job' }, outputs: { job_id: 'audit-complete-job', json: '/api/outputs/audit-complete-job/json', txt: '/api/outputs/audit-complete-job/txt', md: null, docx: null, hwpx: null } }],
        ['done', '[DONE]'],
      ])),
    },
    steps: async page => { await seedAndReload(page); await fillWriter(page); await page.getByRole('button', { name: '분석 시작' }).click(); const started = Date.now(); await page.getByRole('button', { name: '결과 보기' }).first().waitFor({ timeout: 30000 }); await page.waitForTimeout(400); return { completedAfterMs: Date.now() - started }; },
  },
  // Stage 3 states (audit 4.4): engine check before the 45s notice, failure after the transcript was saved, preparation phase.
  {
    id: 'W9', note: '바로록 연결 확인 중 (45초 전)', routes: { engineDown: true },
    steps: async page => { await ready(page); const started = Date.now(); await page.locator('#writer-engine-checking').waitFor({ timeout: 10000 }); await page.waitForTimeout(300); return { checkingLineAfterMs: Date.now() - started }; },
  },
  {
    id: 'A4', note: '대화록 저장 뒤 실패 (메모리 부족)',
    routes: {
      analyze: route => route.fulfill(sse([
        ['progress', { type: 'progress', progress: 70, status: 'diarizing', message: '참석자 구분 중', transcript_ready: true }],
        ['error', { type: 'error', progress: 70, status: 'error', code: 'insufficient_memory', message: 'CUDA failed with error out of memory' }],
        ['done', '[DONE]'],
      ])),
      generation: { 'partial-result': route => route.fulfill(json({ job_id: 'audit-partial-job', source_file: '2026-10-18_자원조사_보고회의.mp4', partial: true, segments: mainSegments, display_segments: mainSegments, diarization_requested: true })) },
    },
    steps: async page => { await seedAndReload(page); await fillWriter(page); await page.getByRole('button', { name: '분석 시작' }).click(); await page.getByRole('heading', { name: '분석을 마치지 못했습니다' }).waitFor({ timeout: 10000 }); await page.waitForTimeout(400); },
  },
  {
    id: 'A5', note: '분석 준비 단계 (저장 공간 확인 응답 대기)', routes: { generation: { 'api/analyze/preflight': () => hangForever() } },
    steps: async page => { await seedAndReload(page); await fillWriter(page); await page.getByRole('button', { name: '분석 시작' }).click(); await page.locator('.writer-analysis-panel').getByRole('button', { name: '중지', exact: true }).waitFor({ timeout: 10000 }); await page.waitForTimeout(400); },
  },
  { id: 'D1', note: '상세 대화록 기본', steps: async page => { await seedAndReload(page); await openMeeting(page, completeMeeting.title); } },
  {
    id: 'D9', note: '대화록 저장 뒤 엔진 꺼짐 (동기화 경고)', routes: { generation: { 'sync-record': route => route.abort('connectionrefused') } },
    steps: async page => {
      await seedAndReload(page);
      await openMeeting(page, completeMeeting.title);
      await page.getByRole('button', { name: '대화록 편집', exact: true }).click();
      await page.locator('.script-edit-textarea').first().fill('3분기 연근해 자원조사 결과를 다시 공유하겠습니다.');
      await page.locator('#meeting-detail-panel-script').getByRole('button', { name: '저장', exact: true }).click();
      await page.locator('#meeting-detail-panel-script .detail-report-status').waitFor({ timeout: 10000 });
      await page.waitForTimeout(400);
    },
  },
  { id: 'D1@800', viewport: NARROW, note: '상세 대화록, 좁은 창', steps: async page => { await seedAndReload(page); await openMeeting(page, completeMeeting.title); } },
  { id: 'D2', note: '참석자 구분 없음·화자 하나', steps: async page => { await seedAndReload(page); await openMeeting(page, singleSpeakerMeeting.title); } },
  {
    id: 'D3', note: '긴 대화록 중간 스크롤',
    steps: async page => {
      await seedAndReload(page);
      const started = Date.now();
      await openMeeting(page, longMeeting.title);
      const openMs = Date.now() - started;
      await page.locator('.script-row').nth(300).scrollIntoViewIfNeeded();
      await page.waitForTimeout(400);
      return { openMs, rows: await page.locator('.script-row').count() };
    },
  },
  {
    id: 'D3@1920', viewport: LARGE, note: '긴 대화록, 넓은 창',
    steps: async page => { await seedAndReload(page); await openMeeting(page, longMeeting.title); },
  },
  {
    id: 'D4', note: '대화록 편집',
    steps: async page => { await seedAndReload(page); await openMeeting(page, completeMeeting.title); await page.getByRole('button', { name: '대화록 편집', exact: true }).click(); await page.waitForTimeout(400); },
  },
  {
    id: 'D5', note: '현재 회의에서 검색',
    steps: async page => { await seedAndReload(page); await openMeeting(page, completeMeeting.title); await page.getByLabel('현재 회의에서 검색').fill('교정'); await page.waitForTimeout(500); },
  },
  { id: 'D6', note: '참석자 구분 실패·긴 목적·긴 파일명', steps: async page => { await seedAndReload(page); await openMeeting(page, failedDiarizationMeeting.title); } },
  { id: 'D7', note: '참석자 10명', steps: async page => { await seedAndReload(page); await openMeeting(page, manySpeakersMeeting.title); } },
  { id: 'O1', note: '기록 정리: 전체 요약', steps: async page => { await seedAndReload(page); await openMeeting(page, completeMeeting.title); await openTab(page, '기록 정리'); } },
  { id: 'O2', note: '기록 정리: 아직 정리 안 함', steps: async page => { await seedAndReload(page); await openMeeting(page, unorganizedMeeting.title); await openTab(page, '기록 정리'); } },
  {
    id: 'O3', note: '기록 정리: 정리 중', routes: { generation: { '**/generate-summary': () => hangForever() } },
    steps: async page => {
      await seedAndReload(page);
      await openMeeting(page, unorganizedMeeting.title);
      await openTab(page, '기록 정리');
      await page.getByRole('button', { name: '전체 요약 정리', exact: true }).click();
      await page.waitForTimeout(1200);
    },
  },
  {
    id: 'O4', note: '기록 정리: 정리 실패', routes: { generation: { '**/generate-summary': route => route.fulfill(json({ detail: 'Ollama request failed: 500 Internal Server Error' }, 500)) } },
    steps: async page => {
      await seedAndReload(page);
      await openMeeting(page, unorganizedMeeting.title);
      await openTab(page, '기록 정리');
      await page.getByRole('button', { name: '전체 요약 정리', exact: true }).click();
      await page.waitForTimeout(1500);
    },
  },
  { id: 'O5', note: '기록 정리: 주제별 정리', steps: async page => { await seedAndReload(page); await openMeeting(page, completeMeeting.title); await openTab(page, '기록 정리'); await page.locator('#organize-mode-tab-topics').click(); await page.waitForTimeout(300); } },
  { id: 'O6', note: '기록 정리: 참석자별 정리', steps: async page => { await seedAndReload(page); await openMeeting(page, completeMeeting.title); await openTab(page, '기록 정리'); await page.locator('#organize-mode-tab-speakers').click(); await page.waitForTimeout(300); } },
  { id: 'O7', note: '기록 정리: 대화록 수정 후 이전 기준', steps: async page => { await seedAndReload(page); await openMeeting(page, outdatedMeeting.title); await openTab(page, '기록 정리'); } },
  { id: 'P1', note: '보고서 없음', steps: async page => { await seedAndReload(page); await openMeeting(page, unorganizedMeeting.title); await openTab(page, '보고서'); } },
  { id: 'P2', note: '보고서 있음', steps: async page => { await seedAndReload(page); await openMeeting(page, completeMeeting.title); await openTab(page, '보고서'); } },
  { id: 'P3', note: '이전 기준 보고서', steps: async page => { await seedAndReload(page); await openMeeting(page, outdatedMeeting.title); await openTab(page, '보고서'); } },
  {
    id: 'S1', note: '설정 일반',
    steps: async page => { await seedAndReload(page); await page.getByRole('button', { name: '설정', exact: true }).first().click(); await page.getByRole('dialog').waitFor(); await page.waitForTimeout(700); },
  },
  {
    id: 'S1@800', viewport: NARROW, note: '설정 일반, 좁은 창',
    steps: async page => { await seedAndReload(page); await page.getByRole('button', { name: '설정', exact: true }).first().click(); await page.getByRole('dialog').waitFor(); await page.waitForTimeout(700); },
  },
  {
    // 문제 해결 is desktop-only (isTauriRuntime), so the web capture shows the bottom of 일반 instead.
    id: 'S2', note: '설정 일반 맨 아래 (웹에는 문제 해결 없음)',
    steps: async page => {
      await seedAndReload(page);
      await page.getByRole('button', { name: '설정', exact: true }).first().click();
      await page.getByRole('dialog').waitFor();
      await page.waitForTimeout(500);
      await page.getByRole('dialog').getByRole('heading', { name: '보관' }).evaluate(element => {
        let node = element.parentElement;
        while (node && node.scrollHeight <= node.clientHeight + 1) node = node.parentElement;
        if (node) node.scrollTop = node.scrollHeight;
      });
      await page.waitForTimeout(300);
    },
  },
  {
    id: 'S3', note: '설정 모델 준비됨',
    steps: async page => { await seedAndReload(page); await page.getByRole('button', { name: '설정', exact: true }).first().click(); await page.getByRole('dialog').waitFor(); await openTab(page, '모델'); await page.waitForTimeout(700); },
  },
  {
    id: 'S4', note: '설정 모델 없음', routes: { model: { sttInstalled: false, downloadable: true } },
    steps: async page => { await seedAndReload(page); await page.getByRole('button', { name: '설정', exact: true }).first().click(); await page.getByRole('dialog').waitFor(); await openTab(page, '모델'); await page.waitForTimeout(700); },
  },
  // S1/S3/S4 capture the dialog 0.7 s after opening (still loading); S5–S7 wait for loaded values.
  {
    id: 'S5', note: '설정 일반, 불러온 뒤',
    steps: async page => {
      await seedAndReload(page);
      await page.getByRole('button', { name: '설정', exact: true }).first().click();
      const toggle = page.getByRole('dialog').getByRole('checkbox', { name: /참석자 구분까지 이어서 실행/ });
      const started = Date.now();
      await page.waitForFunction(element => element.checked, await toggle.elementHandle(), { timeout: 20000 });
      return { settingsLoadedAfterMs: Date.now() - started };
      await page.waitForTimeout(300);
    },
  },
  {
    id: 'S6', note: '설정 모델 준비됨, 불러온 뒤',
    steps: async page => {
      await seedAndReload(page);
      await page.getByRole('button', { name: '설정', exact: true }).first().click();
      await page.getByRole('dialog').waitFor();
      await openTab(page, '모델');
      await page.getByText('모델 상태를 불러오는 중입니다').first().waitFor({ state: 'detached', timeout: 20000 });
      await page.waitForTimeout(400);
    },
  },
  {
    id: 'S7', note: '설정 모델 없음, 불러온 뒤', routes: { model: { sttInstalled: false, downloadable: true } },
    steps: async page => {
      await seedAndReload(page);
      await page.getByRole('button', { name: '설정', exact: true }).first().click();
      await page.getByRole('dialog').waitFor();
      await openTab(page, '모델');
      await page.getByText('모델 상태를 불러오는 중입니다').first().waitFor({ state: 'detached', timeout: 20000 });
      await page.waitForTimeout(400);
    },
  },
  {
    id: 'S8', note: '설정 일반, 엔진 응답 전(설정 요청 보류)', routes: { holdSettings: true },
    steps: async page => { await ready(page); await page.getByRole('button', { name: '설정', exact: true }).first().click(); await page.getByRole('dialog').waitFor(); await page.waitForTimeout(600); },
  },
  {
    id: 'S9', note: '설정 모델, 모델 상태 응답 전(상태 요청 보류)', routes: { holdModels: true },
    steps: async page => { await ready(page); await page.getByRole('button', { name: '설정', exact: true }).first().click(); await page.getByRole('dialog').waitFor(); await openTab(page, '모델'); await page.waitForTimeout(600); },
  },
  {
    id: 'B2', note: '사이드바 회의록 행 메뉴',
    steps: async page => {
      await seedAndReload(page);
      const row = page.locator('.barorok-navigation').getByText(unorganizedMeeting.title, { exact: true }).first();
      await row.hover();
      await page.getByRole('button', { name: new RegExp(`^${unorganizedMeeting.title}, .* 회의록 메뉴$`) }).first().click();
      await page.waitForTimeout(300);
    },
  },
  {
    id: 'B3', note: '사이드바 폴더 이동 메뉴',
    steps: async page => {
      await seedAndReload(page);
      const row = page.locator('.barorok-navigation').getByText(unorganizedMeeting.title, { exact: true }).first();
      await row.hover();
      await page.getByRole('button', { name: new RegExp(`^${unorganizedMeeting.title}, .* 회의록 메뉴$`) }).first().click();
      await page.getByRole('button', { name: '폴더 이동', exact: true }).click();
      await page.waitForTimeout(400);
    },
  },
  {
    id: 'B5', note: '사이드바 이어서 할 분석 펼침', routes: { drafts: remoteDraftStatuses }, ...withDrafts([stoppedDraft(), failedDraft()]),
    steps: async page => { await seedAndReload(page); await page.getByRole('button', { name: /이어서 할 분석/ }).first().click(); await page.waitForTimeout(400); },
  },
  {
    id: 'B6', viewport: { width: 1280, height: 560 }, note: '낮은 창 + 이어서 할 분석', routes: { drafts: remoteDraftStatuses }, ...withDrafts([stoppedDraft(), failedDraft()]),
    steps: async page => { await seedAndReload(page); await page.getByRole('button', { name: /이어서 할 분석/ }).first().click(); await page.waitForTimeout(400); },
  },
  { id: 'C0', path: '?view=minutes&localEngineConnection=1', routes: { engineDown: true }, note: '웹 첫 방문 처리 방식 안내', steps: async page => { await page.getByRole('dialog').waitFor(); await page.waitForTimeout(400); } },
  { id: 'C0@800', viewport: NARROW, path: '?view=minutes&localEngineConnection=1', routes: { engineDown: true }, note: '웹 첫 방문 처리 방식 안내, 좁은 창', steps: async page => { await page.getByRole('dialog').waitFor(); await page.waitForTimeout(400); } },
  { id: 'C1', path: '?view=minutes&localEngineConnection=1', routes: { engineDown: true }, note: '웹 연결 화면 (연결 없음)', init: () => window.localStorage.setItem('localProcessingIntroSeen', '1'), steps: async page => { await page.waitForTimeout(4000); } },
  { id: 'C2', path: '?view=minutes&localEngineConnection=1', routes: { engineDown: true }, note: '웹 연결 실패 (연결 확인 뒤)', init: () => window.localStorage.setItem('localProcessingIntroSeen', '1'), steps: async page => { await page.getByRole('button', { name: '연결 확인' }).click(); await page.getByText('분석 기능에 연결하지 못했습니다').waitFor(); await page.waitForTimeout(400); } },
  { id: 'C2@800', viewport: NARROW, path: '?view=minutes&localEngineConnection=1', routes: { engineDown: true }, note: '웹 연결 실패, 좁은 창', init: () => window.localStorage.setItem('localProcessingIntroSeen', '1'), steps: async page => { await page.getByRole('button', { name: '연결 확인' }).click(); await page.getByText('분석 기능에 연결하지 못했습니다').waitFor(); await page.waitForTimeout(400); } },
  { id: 'F1', path: '?view=archive', note: '기록 찾기 (개발용 진입)', steps: async page => { await seedAndReload(page); } },
];

// ---------------------------------------------------------------------------
// Runner
// ---------------------------------------------------------------------------

const measure = page => page.evaluate(() => {
  const overflow = element => (element ? element.scrollWidth - element.clientWidth : 0);
  return {
    documentOverflowX: overflow(document.documentElement),
    workspaceOverflowX: overflow(document.querySelector('.barorok-workspace')),
    activeElement: document.activeElement ? `${document.activeElement.tagName.toLowerCase()}${document.activeElement.id ? `#${document.activeElement.id}` : ''} ${(document.activeElement.getAttribute('aria-label') ?? document.activeElement.textContent ?? '').trim().slice(0, 40)}` : null,
  };
});

await mkdir(OUT_DIR, { recursive: true });
fixture = await createFixture();
const server = await startServer();
const browser = await chromium.launch({ headless: true });
const manifest = [];
{
  // Warm Vite's first compile so a cold server does not eat the first capture's timeout.
  const warmContext = await browser.newContext({ viewport: WIDE });
  const warmPage = await warmContext.newPage();
  await installRoutes(warmPage);
  await warmPage.goto(APP_URL, { waitUntil: 'domcontentloaded' });
  await warmPage.getByRole('button', { name: '새 회의록', exact: true }).first().waitFor({ timeout: 90000 });
  await warmContext.close();
}
try {
  for (const capture of captures) {
    if (ONLY.size && !ONLY.has(capture.id)) continue;
    const context = await browser.newContext({ viewport: capture.viewport ?? WIDE, locale: 'ko-KR', timezoneId: 'Asia/Seoul' });
    if (capture.init) await context.addInitScript(capture.init, capture.initArg);
    const page = await context.newPage();
    const consoleErrors = [];
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text().slice(0, 200)); });
    page.on('pageerror', error => consoleErrors.push(`pageerror: ${error.message.slice(0, 200)}`));
    if (process.env.CAPTURE_DEBUG) {
      page.on('console', message => console.log(`  [console.${message.type()}] ${message.text().slice(0, 200)}`));
      page.on('response', response => { if (response.url().includes('/api/')) console.log(`  [api] ${response.request().method()} ${new URL(response.url()).pathname} ${response.status()}`); });
      page.on('requestfailed', request => { if (request.url().includes('/api/')) console.log(`  [api] ${request.method()} ${new URL(request.url()).pathname} FAILED`); });
    }
    const entry = { id: capture.id, note: capture.note, viewport: capture.viewport ?? WIDE };
    try {
      await installRoutes(page, capture.routes);
      await page.goto(new URL(capture.path ?? '', APP_URL).toString(), { waitUntil: 'domcontentloaded' });
      const extra = await capture.steps(page);
      if (extra) entry.extra = extra;
      entry.ok = true;
    } catch (error) {
      entry.ok = false;
      entry.error = String(error?.message ?? error).split('\n')[0].slice(0, 300);
    }
    try {
      Object.assign(entry, await measure(page));
      const fileId = capture.id.replace('@', '_');
      await page.screenshot({ path: join(OUT_DIR, `${fileId}.png`) });
      await writeFile(join(OUT_DIR, `${fileId}.aria.yml`), await page.locator('body').ariaSnapshot({ timeout: 5000 }).catch(() => ''), 'utf8');
    } catch (error) {
      entry.captureError = String(error?.message ?? error).split('\n')[0];
    }
    entry.consoleErrors = [...new Set(consoleErrors)].slice(0, 8);
    manifest.push(entry);
    console.log(`${entry.ok ? 'ok ' : 'ERR'} ${capture.id} ${entry.ok ? '' : entry.error}`);
    await context.close();
  }
} finally {
  await browser.close();
  await stopServer(server);
  const manifestPath = join(OUT_DIR, ONLY.size ? `manifest-${[...ONLY].join('_').replace(/@/g, '-')}.json` : 'manifest.json');
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2), 'utf8');
}
