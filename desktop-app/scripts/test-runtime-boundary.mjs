import assert from 'node:assert/strict';
import {
  detectRuntimeEnvironment,
  runtimeHasCapability,
} from '../src/runtimeEnvironment.ts';
import {
  applyLocalEngineAuthorization,
  applyLocalEngineProbe,
  canUseLocalEngineCapability,
  createInitialLocalEngineConnection,
  isLocalEngineConnected,
  isLatestAuthorizationCheck,
  isLatestTransportCheck,
  parseLocalEngineProbe,
  transportFromHealthEvidence,
  updateLocalEngineTransport,
} from '../src/localEngineConnection.ts';
import { createLocalEngineClient } from '../src/localEngineClientCore.ts';
import {
  LocalEngineSessionCredentialStore,
  parseLocalEnginePairingStart,
  parseLocalEngineSessionCredential,
} from '../src/localEngineSession.ts';
import { LocalEngineConnectionCoordinator } from '../src/localEngineConnectionCoordinator.ts';
import { getLocalEngineConnectionView } from '../src/localEngineConnectionView.ts';
import { selectWriterStatusRow } from '../src/writerStatusRow.ts';
import { LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';

const web = detectRuntimeEnvironment({
  hostname: 'meetings.example.test',
  protocol: 'https:',
});
assert.equal(web.kind, 'web-local-engine');
assert.equal(runtimeHasCapability(web, 'browser-downloads'), true);
assert.equal(runtimeHasCapability(web, 'restart-local-engine'), false);

const tauriByInvoke = detectRuntimeEnvironment({
  hasTauriInvoke: true,
  hostname: 'localhost',
  protocol: 'http:',
});
assert.equal(tauriByInvoke.kind, 'tauri-desktop');
assert.equal(runtimeHasCapability(tauriByInvoke, 'desktop-action-token'), true);
assert.equal(runtimeHasCapability(tauriByInvoke, 'browser-downloads'), false);

const tauriByOrigin = detectRuntimeEnvironment({
  hostname: 'tauri.localhost',
  protocol: 'https:',
});
assert.equal(tauriByOrigin.kind, 'tauri-desktop');

let connection = createInitialLocalEngineConnection('web-local-engine');
connection = updateLocalEngineTransport(connection, 'reachable', 100);
assert.equal(connection.transport, 'reachable');
assert.equal(connection.authorization, 'unknown');
assert.equal(isLocalEngineConnected(connection), false, 'legacy health must not imply web authentication');
connection = updateLocalEngineTransport(connection, 'reachable', 200);
assert.equal(connection.checkedAt, 200, 'rechecking the same transport should refresh checkedAt');
assert.equal(transportFromHealthEvidence(true), 'reachable', 'HTTP errors still prove transport reachability');
assert.equal(transportFromHealthEvidence(false), 'unreachable');
assert.equal(isLatestTransportCheck(2, 1), false, 'a stale check cannot overwrite newer transport evidence');
assert.equal(isLatestTransportCheck(2, 2), true);
assert.equal(isLatestAuthorizationCheck(3, 2), false, 'stale pairing results cannot overwrite newer authorization evidence');
assert.equal(isLatestAuthorizationCheck(3, 3), true);

const parsedProbe = parseLocalEngineProbe({
  product_id: 'barorok-local-engine',
  engine_version: '0.0.0-dev',
  api_contract_version: 1,
  capabilities: ['analysis', 'export', 'unknown-capability'],
  auth_state: 'pairing-required',
  pairing_available: false,
  update_required: false,
});
assert.ok(parsedProbe);
connection = applyLocalEngineProbe(connection, parsedProbe, 300);
assert.equal(connection.transport, 'reachable');
assert.equal(connection.authorization, 'unpaired');
assert.equal(connection.updateRequired, false);
assert.deepEqual([...connection.capabilities], ['analysis', 'export']);
connection = applyLocalEngineProbe(connection, { ...parsedProbe, auth_state: 'authenticated' }, 350);
assert.equal(
  connection.authorization,
  'unpaired',
  'a public probe cannot authenticate a browser session',
);
connection = applyLocalEngineAuthorization(connection, 'authenticated', ['analysis'], 375);
assert.equal(connection.authorization, 'authenticated');
assert.deepEqual([...connection.capabilities], ['analysis']);
connection = applyLocalEngineProbe(connection, parsedProbe, 380);
assert.deepEqual(
  [...connection.capabilities],
  ['analysis'],
  'public engine capabilities cannot expand an authenticated session grant',
);
const incompatibleProbe = { ...parsedProbe, api_contract_version: 2 };
connection = applyLocalEngineProbe(connection, incompatibleProbe, 400);
assert.equal(connection.transport, 'incompatible');
assert.equal(connection.capabilities.size, 0);
assert.equal(parseLocalEngineProbe({ ...parsedProbe, product_id: 'other-engine' }), null);

const viewSnapshot = createInitialLocalEngineConnection('web-local-engine');
const introView = getLocalEngineConnectionView({
  snapshot: viewSnapshot,
  pairingPhase: 'idle',
  connectionStarted: false,
});
assert.equal(introView.scene, 'intro');
assert.equal(introView.title, `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 필요합니다`);
assert.equal(introView.message, '설치했다면 연결 확인을 눌러 주세요.');
assert.doesNotMatch(introView.message, /자동/, 'nothing has been checked yet, so the first visit never promises an automatic connection');
assert.equal(introView.tone, 'info');
assert.equal(introView.help, null);
const checkingView = getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'checking' },
  pairingPhase: 'idle',
  connectionStarted: true,
});
assert.equal(checkingView.scene, 'checking');
assert.equal(checkingView.title, '연결 확인 중');
assert.equal(checkingView.tone, 'neutral', 'a check in progress is a grey spinner, not a status color');
assert.equal(checkingView.primaryAction, null);
assert.equal(checkingView.secondaryAction, null);
const unreachableView = getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'unreachable' },
  pairingPhase: 'idle',
  connectionStarted: true,
});
assert.equal(unreachableView.scene, 'unreachable');
assert.equal(unreachableView.primaryAction, 'probe');
assert.equal(unreachableView.primaryDisabled, false);
assert.equal(unreachableView.secondaryAction, null, 'unverified installer downloads must not be shown as an action');
const introWithInstaller = getLocalEngineConnectionView({
  snapshot: viewSnapshot,
  pairingPhase: 'idle',
  connectionStarted: false,
  installerAvailable: true,
});
assert.equal(introWithInstaller.primaryLabel, '연결 확인');
assert.equal(introWithInstaller.secondaryAction, 'download', 'a configured installer is offered before the first connection attempt');
assert.equal(introWithInstaller.secondaryLabel, '설치 파일');
const unreachableWithInstaller = getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'unreachable' },
  pairingPhase: 'idle',
  connectionStarted: true,
  installerAvailable: true,
});
assert.equal(unreachableWithInstaller.primaryAction, 'probe', 'no response does not establish that installation is needed');
assert.equal(unreachableWithInstaller.primaryLabel, '다시 확인');
assert.equal(unreachableWithInstaller.secondaryAction, 'download', 'the installer stays a button, not only help text');
assert.equal(unreachableWithInstaller.secondaryLabel, '설치 파일');
assert.equal(unreachableWithInstaller.title, '연결하지 못했습니다');
assert.equal(unreachableWithInstaller.tone, 'warning');
assert.equal(unreachableWithInstaller.message, `${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행한 뒤 다시 확인해 주세요.`);
assert.ok(unreachableWithInstaller.help.startsWith(`Windows 시작 메뉴에서 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행하세요.`));
const pairingRequiredView = getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'reachable', authorization: 'unpaired' },
  pairingPhase: 'idle',
  connectionStarted: true,
});
assert.equal(pairingRequiredView.scene, 'pairing-required');
assert.equal(pairingRequiredView.message, `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중이면 자동으로 연결됩니다.`);
assert.deepEqual([pairingRequiredView.secondaryLabel, pairingRequiredView.primaryLabel], ['다시 확인', '연결 시작']);
assert.equal(getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'reachable', authorization: 'unpaired' },
  pairingPhase: 'awaiting-code',
  connectionStarted: true,
}).primaryAction, 'open-code');
const connectedView = getLocalEngineConnectionView({
  snapshot: {
    ...viewSnapshot,
    transport: 'reachable',
    authorization: 'authenticated',
    capabilities: new Set(['analysis']),
  },
  pairingPhase: 'connected',
  connectionStarted: true,
});
assert.equal(connectedView.scene, 'connected');
assert.equal(connectedView.analysisReady, true);
assert.equal(connectedView.title, '연결됨', 'connection alone must not claim that model checks have completed');
const sessionEndedView = getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'reachable', authorization: 'expired' },
  pairingPhase: 'expired',
  connectionStarted: true,
});
assert.equal(sessionEndedView.scene, 'session-ended');
assert.deepEqual([sessionEndedView.secondaryLabel, sessionEndedView.primaryLabel], ['다시 확인', '다시 연결']);
const updateView = getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'reachable', updateRequired: true },
  pairingPhase: 'idle',
  connectionStarted: true,
  updateAvailable: true,
});
assert.equal(updateView.scene, 'update-required');
assert.equal(updateView.title, `${LOCAL_ENGINE_NAME} 업데이트가 필요합니다`);
assert.deepEqual([updateView.secondaryLabel, updateView.primaryLabel], ['다시 확인', '업데이트 안내']);
const pairingErrorView = getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'reachable', authorization: 'unpaired' },
  pairingPhase: 'error',
  connectionStarted: true,
});
assert.equal(pairingErrorView.title, '연결을 완료하지 못했습니다');
assert.equal(pairingErrorView.tone, 'warning');
assert.equal(pairingErrorView.message, `${withJosa(LOCAL_ENGINE_NAME, '이/가')} 실행 중인지 확인해 주세요.`);
assert.equal(pairingErrorView.primaryLabel, '다시 연결');
assert.equal(getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'reachable', authorization: 'unpaired' },
  pairingPhase: 'error', connectionStarted: true, pairingErrorReason: '연결 요청이 만료됐습니다. 다시 연결해 주세요.',
}).message, '연결 요청이 만료됐습니다. 다시 연결해 주세요.', 'a known cause replaces the generic sentence');
const capabilityView = getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'reachable', authorization: 'authenticated', capabilities: new Set(['export']) },
  pairingPhase: 'connected',
  connectionStarted: true,
});
assert.equal(capabilityView.scene, 'capability-missing');
assert.equal(capabilityView.title, '이 브라우저에 분석 권한이 없습니다');
const invalidView = getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'error' },
  pairingPhase: 'idle',
  connectionStarted: true,
});
assert.equal(invalidView.scene, 'invalid-response');
assert.equal(invalidView.tone, 'warning', 'a retry can fix it, so it is a warning, not an error');
assert.equal(invalidView.message, '잠시 뒤 다시 확인해 주세요.');
assert.ok(invalidView.help);
for (const quiet of [introView, checkingView, pairingRequiredView, sessionEndedView, updateView, pairingErrorView, capabilityView]) {
  assert.equal(quiet.help, null, `${quiet.scene}: no ? where the first button is the whole fix`);
}
for (const view of [introView, unreachableWithInstaller, pairingRequiredView, sessionEndedView, updateView, pairingErrorView, capabilityView, invalidView]) {
  assert.doesNotMatch(view.title, /바로록|분석 준비 완료/, 'names come from the brand constants');
}

// Writer status row: the first blocked step only, connection before readiness.
const rowInput = overrides => ({
  connection: connectedView,
  readinessState: 'ready',
  readinessMessage: '',
  missingModels: [],
  diarizationDuringAnalysis: false,
  gpuUnavailable: false,
  installerAvailable: true,
  canOpenModelSettings: true,
  canOpenAnalysisSettings: true,
  ...overrides,
});
const sttMissing = { key: 'stt_faster_whisper', label: 'faster-whisper', downloadable: true };
const diarizationMissing = { key: 'diarization', label: 'pyannote', downloadable: false };
const readyRow = selectWriterStatusRow(rowInput({}));
assert.deepEqual(
  { stage: readyRow.stage, state: readyRow.state, title: readyRow.title, message: readyRow.message, actions: readyRow.actions, blocksStart: readyRow.blocksStart },
  { stage: 'ready', state: 'ready', title: '연결됨', message: null, actions: [], blocksStart: false },
);
const blockedConnectionRow = selectWriterStatusRow(rowInput({
  connection: unreachableWithInstaller, readinessState: 'missing-models', missingModels: [sttMissing], gpuUnavailable: true,
}));
assert.equal(blockedConnectionRow.stage, 'connection', 'connection comes before models');
assert.equal(blockedConnectionRow.state, 'unreachable');
assert.equal(blockedConnectionRow.blocksStart, true);
assert.deepEqual(blockedConnectionRow.actions.map(action => action.label), ['설치 파일', '다시 확인'], 'the main fix sits right beside 분석 시작');
assert.equal(blockedConnectionRow.help, unreachableWithInstaller.help);
const sessionRow = selectWriterStatusRow(rowInput({ connection: { ...sessionEndedView } }));
assert.deepEqual(sessionRow.actions, [{ kind: 'probe', label: '다시 확인' }, { kind: 'pair', label: '다시 연결', disabled: false }]);
for (const [readinessState, state] of [['checking', 'readiness-checking'], ['server-waiting', 'readiness-checking']]) {
  const row = selectWriterStatusRow(rowInput({ readinessState }));
  assert.deepEqual([row.state, row.title, row.busy, row.tone, row.actions.length, row.blocksStart], [state, '분석 준비 확인 중', true, 'neutral', 0, true]);
}
const readinessErrorRow = selectWriterStatusRow(rowInput({ readinessState: 'error', readinessMessage: '모델 상태를 확인하지 못했습니다.' }));
assert.deepEqual(
  [readinessErrorRow.title, readinessErrorRow.message, readinessErrorRow.help, readinessErrorRow.tone],
  ['분석 준비 상태를 확인하지 못했습니다', '잠시 뒤 다시 확인해 주세요.', '모델 상태를 확인하지 못했습니다.', 'warning'],
  'the detailed cause moves behind ?',
);
assert.deepEqual(readinessErrorRow.actions, [{ kind: 'recheck-readiness', label: '다시 확인' }]);
const modelsRow = selectWriterStatusRow(rowInput({
  readinessState: 'missing-models', missingModels: [sttMissing, diarizationMissing], gpuUnavailable: true, diarizationDuringAnalysis: true,
}));
assert.deepEqual(
  [modelsRow.state, modelsRow.tone, modelsRow.title, modelsRow.message, modelsRow.help],
  ['models-missing', 'info', '모델을 받아야 분석할 수 있습니다', '음성 인식, 참석자 구분', null],
  'a downloadable model is named first, as a list without a period, even with a GPU problem',
);
assert.deepEqual(modelsRow.actions, [{ kind: 'models', label: '모델 받기' }]);
assert.deepEqual(selectWriterStatusRow(rowInput({
  readinessState: 'missing-models', missingModels: [sttMissing], canOpenModelSettings: false,
})).actions, [], 'no button that cannot open Settings');
const diarizationRow = selectWriterStatusRow(rowInput({
  readinessState: 'missing-models', missingModels: [diarizationMissing], diarizationDuringAnalysis: true,
}));
assert.deepEqual(
  [diarizationRow.state, diarizationRow.tone, diarizationRow.title, diarizationRow.message, diarizationRow.actions],
  ['diarization-model-missing', 'warning', '참석자 구분 모델이 없습니다', '이어서 실행을 끄면 대화록부터 만들 수 있습니다.', [{ kind: 'diarization', label: '참석자 구분 설정' }]],
);
const reinstallRow = selectWriterStatusRow(rowInput({
  readinessState: 'missing-models', missingModels: [diarizationMissing], diarizationDuringAnalysis: false,
}));
assert.deepEqual(
  [reinstallRow.state, reinstallRow.tone, reinstallRow.title, reinstallRow.message, reinstallRow.actions],
  ['models-reinstall', 'error', '필요한 모델이 없어 분석을 시작할 수 없습니다', `${withJosa(LOCAL_ENGINE_NAME, '을/를')} 다시 설치해 주세요.`, [{ kind: 'download', label: '설치 파일' }]],
);
assert.deepEqual(selectWriterStatusRow(rowInput({
  readinessState: 'missing-models', missingModels: [diarizationMissing], installerAvailable: false,
})).actions, [], 'no installer link without a configured installer');
const gpuRow = selectWriterStatusRow(rowInput({ readinessState: 'missing-models', gpuUnavailable: true }));
assert.deepEqual(
  [gpuRow.state, gpuRow.tone, gpuRow.title, gpuRow.message, gpuRow.actions],
  ['gpu-unavailable', 'warning', 'GPU를 쓸 수 없습니다', '분석 장치를 CPU로 바꿔 주세요.', [{ kind: 'device', label: '분석 장치 설정' }]],
);
const otherReadinessRow = selectWriterStatusRow(rowInput({ readinessState: 'missing-models', readinessMessage: 'ffmpeg를 찾지 못했습니다.' }));
assert.deepEqual([otherReadinessRow.state, otherReadinessRow.help, otherReadinessRow.actions.map(action => action.kind)], ['readiness-blocked', 'ffmpeg를 찾지 못했습니다.', ['recheck-readiness']]);
for (const row of [modelsRow, diarizationRow, reinstallRow, gpuRow, readinessErrorRow]) {
  assert.ok(row.actions.length <= 1, `${row.state}: one fixing button outside the connection step`);
  assert.equal(row.blocksStart, true);
}
const notice = '테스트 설치 파일이라 Windows 보안 경고가 나올 수 있습니다.';
assert.equal(selectWriterStatusRow(rowInput({ connection: introWithInstaller, installerNotice: notice })).message,
  `${introWithInstaller.message} ${notice}`, 'without ?, the installer warning follows the message');
const unreachableWithNotice = selectWriterStatusRow(rowInput({ connection: unreachableWithInstaller, installerNotice: notice }));
assert.equal(unreachableWithNotice.message, unreachableWithInstaller.message, 'with ?, the line stays short');
assert.ok(unreachableWithNotice.help.endsWith(notice));
assert.equal(selectWriterStatusRow(rowInput({ connection: checkingView, installerNotice: notice })).message, null, 'no installer warning where no installer is offered');
assert.equal(getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'checking', updateRequired: true },
  pairingPhase: 'idle',
  connectionStarted: true,
}).scene, 'checking', 'an explicit retry must replace a stale update scene');
assert.equal(getLocalEngineConnectionView({
  snapshot: { ...viewSnapshot, transport: 'checking', authorization: 'expired' },
  pairingPhase: 'expired',
  connectionStarted: true,
}).scene, 'checking', 'an explicit retry must replace a stale expired scene');

const authenticatedConnection = {
  ...connection,
  transport: 'reachable',
  authorization: 'authenticated',
  capabilities: new Set(['analysis']),
};
assert.equal(isLocalEngineConnected(authenticatedConnection), true);
assert.equal(canUseLocalEngineCapability(authenticatedConnection, 'analysis'), true);
assert.equal(canUseLocalEngineCapability(authenticatedConnection, 'export'), false);

const calls = [];
const webClient = createLocalEngineClient({
  resolveBaseUrl: async () => 'http://127.0.0.1:17863',
  resolveRequestHeaders: async () => ({}),
  fetch: async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response('{}', { status: 200 });
  },
});
await webClient.request('/api/health', { headers: { Accept: 'application/json' } });
assert.equal(calls[0].input, 'http://127.0.0.1:17863/api/health');
assert.equal(new Headers(calls[0].init.headers).get('Accept'), 'application/json');
assert.equal(new Headers(calls[0].init.headers).has('X-LMO-Desktop-Action-Token'), false);

const tauriClient = createLocalEngineClient({
  resolveBaseUrl: async () => 'http://127.0.0.1:18001',
  resolveRequestHeaders: async () => ({ 'X-LMO-Desktop-Action-Token': 'desktop-token' }),
  fetch: async (input, init) => {
    calls.push({ input: String(input), init });
    return new Response('{}', { status: 200 });
  },
});
await tauriClient.stream('/api/analyze', {
  method: 'POST',
  headers: {
    'Content-Type': 'application/json',
    'X-LMO-Desktop-Action-Token': 'caller-must-not-override-runtime',
  },
  body: '{}',
});
const tauriCall = calls[1];
const tauriHeaders = new Headers(tauriCall.init.headers);
assert.equal(tauriCall.input, 'http://127.0.0.1:18001/api/analyze');
assert.equal(tauriHeaders.get('X-LMO-Desktop-Action-Token'), 'desktop-token');
assert.equal(tauriHeaders.get('Content-Type'), 'application/json');

await tauriClient.probe({
  headers: {
    Accept: 'application/json',
    Authorization: 'Bearer caller-secret',
    'X-LMO-Desktop-Action-Token': 'caller-desktop-secret',
  },
});
const publicProbeCall = calls[2];
const publicProbeHeaders = new Headers(publicProbeCall.init.headers);
assert.equal(publicProbeCall.input, 'http://127.0.0.1:18001/api/probe');
assert.equal(publicProbeHeaders.get('Accept'), 'application/json');
assert.equal(
  publicProbeHeaders.has('X-LMO-Desktop-Action-Token'),
  false,
  'public probe requests must not receive runtime credentials',
);
assert.equal(publicProbeHeaders.has('Authorization'), false);

await tauriClient.pair('/api/pair/start', {
  method: 'POST',
  headers: {
    Authorization: 'Bearer caller-secret',
    'X-LMO-Desktop-Action-Token': 'caller-desktop-secret',
  },
});
const publicPairHeaders = new Headers(calls[3].init.headers);
assert.equal(calls[3].input, 'http://127.0.0.1:18001/api/pair/start');
assert.equal(
  publicPairHeaders.has('X-LMO-Desktop-Action-Token'),
  false,
  'public pairing requests must not receive runtime credentials',
);
assert.equal(publicPairHeaders.has('Authorization'), false);

let rejectedFetchCount = 0;
const guardedClient = createLocalEngineClient({
  resolveBaseUrl: async () => 'http://127.0.0.1:17863',
  resolveRequestHeaders: async () => ({ Authorization: 'secret' }),
  fetch: async () => {
    rejectedFetchCount += 1;
    return new Response('{}', { status: 200 });
  },
});
await assert.rejects(
  guardedClient.request('https://example.test/api/health'),
  /relative \/api path/,
);
await assert.rejects(
  guardedClient.request('//example.test/api/health'),
  /relative \/api path/,
);
await assert.rejects(
  guardedClient.request('/api/../outside'),
  /configured API boundary/,
);
await assert.rejects(
  guardedClient.request('/api/%2e%2e/outside'),
  /configured API boundary/,
);
assert.equal(rejectedFetchCount, 0, 'rejected URLs must never receive runtime credentials');

const pairingStart = parseLocalEnginePairingStart({
  pairing_id: 'pairing-id-long-enough',
  expires_in_seconds: 120,
});
assert.ok(pairingStart);
assert.equal(parseLocalEnginePairingStart({ pairing_id: 'short', expires_in_seconds: 120 }), null);
const sessionCredential = parseLocalEngineSessionCredential({
  session_token: 'session-token-long-enough-to-use',
  expires_at: 200,
  capabilities: ['analysis', 'unknown-capability'],
});
assert.ok(sessionCredential);
assert.deepEqual(sessionCredential.capabilities, ['analysis']);
let sessionNow = 100;
const sessionStore = new LocalEngineSessionCredentialStore(() => sessionNow);
sessionStore.replace(sessionCredential);
assert.equal(
  sessionStore.requestHeaders().Authorization,
  'Bearer session-token-long-enough-to-use',
);
sessionStore.replace({
  session_token: 'rotated-session-token-long-enough',
  expires_at: 300,
  capabilities: ['analysis'],
});
assert.equal(
  sessionStore.requestHeaders().Authorization,
  'Bearer rotated-session-token-long-enough',
  'session renewal must replace the previous token',
);
sessionNow = 300;
assert.deepEqual(sessionStore.requestHeaders(), {}, 'expired sessions must clear in-memory credentials');

const coordinatorCredentials = new LocalEngineSessionCredentialStore(() => 100);
const coordinatorEvents = {
  transport: [],
  probe: [],
  authorization: [],
  pairing: [],
};
let sessionRequestStep = 0;
const coordinatorClient = {
  probe: async () => new Response(JSON.stringify(parsedProbe), { status: 200 }),
  pair: async (path) => {
    if (path === '/api/pair/start') {
      return new Response(JSON.stringify({
        pairing_id: 'pairing-id-long-enough',
        expires_in_seconds: 120,
      }), { status: 200 });
    }
    return new Response(JSON.stringify({
      session_token: 'first-session-token-long-enough',
      expires_at: 200,
      capabilities: ['analysis'],
    }), { status: 200 });
  },
  request: async (path) => {
    sessionRequestStep += 1;
    if (path === '/api/session/renew') {
      return new Response(JSON.stringify({
        session_token: 'renewed-session-token-long-enough',
        expires_at: 300,
        capabilities: ['analysis', 'export'],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ revoked: true }), { status: 200 });
  },
  session: async (path) => {
    sessionRequestStep += 1;
    if (path === '/api/session/renew') {
      return new Response(JSON.stringify({
        session_token: 'first-session-token-long-enough',
        expires_at: 300,
        capabilities: ['analysis', 'export'],
      }), { status: 200 });
    }
    return new Response(JSON.stringify({ revoked: true }), { status: 200 });
  },
  stream: async () => new Response('{}', { status: 200 }),
  download: async () => new Response('{}', { status: 200 }),
};
const coordinator = new LocalEngineConnectionCoordinator(
  coordinatorClient,
  coordinatorCredentials,
  {
    onTransport: transport => coordinatorEvents.transport.push(transport),
    onProbe: probe => coordinatorEvents.probe.push(probe),
    onAuthorization: (authorization, capabilities = []) => coordinatorEvents.authorization.push({
      authorization,
      capabilities: [...capabilities],
    }),
    onPairingState: state => coordinatorEvents.pairing.push(state),
  },
  {
    probe: parseLocalEngineProbe,
    pairingStart: parseLocalEnginePairingStart,
    sessionCredential: parseLocalEngineSessionCredential,
  },
);
await coordinator.probe();
assert.equal(coordinatorEvents.probe.length, 1);
const coordinatorChallenge = await coordinator.startPairing();
assert.equal(coordinatorChallenge.pairing_id, 'pairing-id-long-enough');
assert.equal(coordinatorEvents.pairing.at(-1).phase, 'awaiting-code');
assert.equal(await coordinator.completePairing(coordinatorChallenge.pairing_id, '123456'), true);
assert.equal(coordinatorEvents.authorization.at(-1).authorization, 'authenticated');
assert.equal(
  coordinatorCredentials.requestHeaders().Authorization,
  'Bearer first-session-token-long-enough',
);
assert.equal(await coordinator.renewSession(), true);
assert.deepEqual(coordinatorEvents.authorization.at(-1).capabilities, ['analysis', 'export']);
assert.equal(coordinatorCredentials.requestHeaders().Authorization, 'Bearer first-session-token-long-enough');
const requestsBeforeDuplicateRenew = sessionRequestStep;
assert.deepEqual(
  await Promise.all([coordinator.renewSession(), coordinator.renewSession()]),
  [true, true],
);
assert.equal(
  sessionRequestStep,
  requestsBeforeDuplicateRenew + 1,
  'duplicate renew calls must share one server request',
);
assert.equal(await coordinator.revokeSession(), true);
assert.deepEqual(coordinatorCredentials.requestHeaders(), {});
assert.equal(coordinatorEvents.authorization.at(-1).authorization, 'revoked');
assert.equal(sessionRequestStep, 3);

const resetPairingStates = [];
const resetPairingCoordinator = new LocalEngineConnectionCoordinator(
  coordinatorClient,
  new LocalEngineSessionCredentialStore(() => 100),
  {
    onTransport: () => {},
    onProbe: () => {},
    onAuthorization: () => {},
    onPairingState: state => resetPairingStates.push(state),
  },
  {
    probe: parseLocalEngineProbe,
    pairingStart: parseLocalEnginePairingStart,
    sessionCredential: parseLocalEngineSessionCredential,
  },
);
await resetPairingCoordinator.startPairing();
resetPairingCoordinator.resetPairing('연결 코드가 만료되었습니다.');
assert.deepEqual(resetPairingStates.at(-1), {
  phase: 'error',
  challenge: null,
  reason: '연결 코드가 만료되었습니다.',
});

let resolveOldCompletion;
const staleCredentials = new LocalEngineSessionCredentialStore(() => 100);
staleCredentials.replace({
  session_token: 'existing-session-token-long-enough',
  expires_at: 300,
  capabilities: ['analysis'],
});
const staleAuthorizations = [];
const staleCoordinator = new LocalEngineConnectionCoordinator(
  {
    ...coordinatorClient,
    pair: async path => {
      if (path === '/api/pair/start') {
        return new Response(JSON.stringify({
          pairing_id: 'pairing-id-long-enough',
          expires_in_seconds: 120,
        }), { status: 200 });
      }
      return await new Promise(resolve => { resolveOldCompletion = resolve; });
    },
    request: async () => new Response(JSON.stringify({ revoked: true }), { status: 200 }),
    session: async () => new Response(JSON.stringify({ revoked: true }), { status: 200 }),
  },
  staleCredentials,
  {
    onTransport: () => {},
    onProbe: () => {},
    onAuthorization: authorization => staleAuthorizations.push(authorization),
    onPairingState: () => {},
  },
  {
    probe: parseLocalEngineProbe,
    pairingStart: parseLocalEnginePairingStart,
    sessionCredential: parseLocalEngineSessionCredential,
  },
);
const oldCompletion = staleCoordinator.completePairing('pairing-id-long-enough', '123456');
await Promise.resolve();
await staleCoordinator.revokeSession();
resolveOldCompletion(new Response(JSON.stringify({
  session_token: 'stale-session-token-must-not-win',
  expires_at: 300,
  capabilities: ['analysis'],
}), { status: 200 }));
assert.equal(await oldCompletion, false);
assert.deepEqual(staleCredentials.requestHeaders(), {}, 'stale pairing completion must not restore a revoked session');
assert.equal(staleAuthorizations.at(-1), 'revoked');

let duplicateCompleteCalls = 0;
let releaseDuplicateComplete;
const duplicateCompleteCredentials = new LocalEngineSessionCredentialStore(() => 100);
const duplicateCompleteCoordinator = new LocalEngineConnectionCoordinator(
  {
    ...coordinatorClient,
    pair: async path => {
      if (path === '/api/pair/start') return coordinatorClient.pair(path);
      duplicateCompleteCalls += 1;
      return await new Promise(resolve => { releaseDuplicateComplete = resolve; });
    },
  },
  duplicateCompleteCredentials,
  {
    onTransport: () => {},
    onProbe: () => {},
    onAuthorization: () => {},
    onPairingState: () => {},
  },
  {
    probe: parseLocalEngineProbe,
    pairingStart: parseLocalEnginePairingStart,
    sessionCredential: parseLocalEngineSessionCredential,
  },
);
const firstDuplicateComplete = duplicateCompleteCoordinator.completePairing('pairing-id-long-enough', '123456');
const secondDuplicateComplete = duplicateCompleteCoordinator.completePairing('pairing-id-long-enough', '123456');
assert.equal(duplicateCompleteCalls, 1);
releaseDuplicateComplete(new Response(JSON.stringify({
  session_token: 'deduplicated-session-token-long-enough',
  expires_at: 300,
  capabilities: ['analysis'],
}), { status: 200 }));
assert.deepEqual(await Promise.all([firstDuplicateComplete, secondDuplicateComplete]), [true, true]);

const expiredCredentialEvents = [];
const expiredCredentialRevocations = [];
const expiredCredentialCoordinator = new LocalEngineConnectionCoordinator(
  {
    ...coordinatorClient,
    pair: async () => new Response(JSON.stringify({
      session_token: 'already-expired-session-token',
      expires_at: 99,
      capabilities: ['analysis'],
    }), { status: 200 }),
    session: async (_path, token) => {
      expiredCredentialRevocations.push(token);
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    },
  },
  new LocalEngineSessionCredentialStore(() => 100),
  {
    onTransport: () => {},
    onProbe: () => {},
    onAuthorization: authorization => expiredCredentialEvents.push(authorization),
    onPairingState: state => expiredCredentialEvents.push(state.phase),
  },
  {
    probe: parseLocalEngineProbe,
    pairingStart: parseLocalEnginePairingStart,
    sessionCredential: parseLocalEngineSessionCredential,
  },
);
assert.equal(await expiredCredentialCoordinator.completePairing('pairing-id-long-enough', '123456'), false);
assert.deepEqual(expiredCredentialEvents.slice(-2), ['expired', 'expired']);
assert.deepEqual(expiredCredentialRevocations, ['already-expired-session-token']);

const failedRenewCredentials = new LocalEngineSessionCredentialStore(() => 100);
failedRenewCredentials.replace({
  session_token: 'renew-failure-session-token-long-enough',
  expires_at: 300,
  capabilities: ['analysis'],
});
const failedRenewRequests = [];
const failedRenewAuthorizations = [];
const failedRenewCoordinator = new LocalEngineConnectionCoordinator(
  {
    ...coordinatorClient,
    session: async (path, token) => {
      failedRenewRequests.push({ path, token });
      if (path === '/api/session/renew') {
        return new Response(JSON.stringify({ invalid: true }), { status: 200 });
      }
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    },
  },
  failedRenewCredentials,
  {
    onTransport: () => {},
    onProbe: () => {},
    onAuthorization: authorization => failedRenewAuthorizations.push(authorization),
    onPairingState: () => {},
  },
  {
    probe: parseLocalEngineProbe,
    pairingStart: parseLocalEnginePairingStart,
    sessionCredential: parseLocalEngineSessionCredential,
  },
);
await assert.rejects(failedRenewCoordinator.renewSession(), error => error?.code === 'invalid-response');
assert.deepEqual(failedRenewCredentials.requestHeaders(), {});
assert.equal(failedRenewAuthorizations.at(-1), 'expired');
assert.deepEqual(failedRenewRequests.map(request => request.path), [
  '/api/session/renew',
  '/api/session/revoke',
]);

const expiredRenewCredentials = new LocalEngineSessionCredentialStore(() => 100);
expiredRenewCredentials.replace({
  session_token: 'expired-renew-session-token-long-enough',
  expires_at: 300,
  capabilities: ['analysis'],
});
const expiredRenewRequests = [];
const expiredRenewCoordinator = new LocalEngineConnectionCoordinator(
  {
    ...coordinatorClient,
    session: async (path, token) => {
      expiredRenewRequests.push({ path, token });
      if (path === '/api/session/renew') {
        return new Response(JSON.stringify({
          session_token: token,
          expires_at: 99,
          capabilities: ['analysis'],
        }), { status: 200 });
      }
      return new Response(JSON.stringify({ revoked: true }), { status: 200 });
    },
  },
  expiredRenewCredentials,
  {
    onTransport: () => {}, onProbe: () => {}, onAuthorization: () => {}, onPairingState: () => {},
  },
  {
    probe: parseLocalEngineProbe,
    pairingStart: parseLocalEnginePairingStart,
    sessionCredential: parseLocalEngineSessionCredential,
  },
);
assert.equal(await expiredRenewCoordinator.renewSession(), false);
assert.deepEqual(expiredRenewRequests.map(request => request.path), [
  '/api/session/renew',
  '/api/session/revoke',
]);

let rejectStaleRenew;
const staleRenewCredentials = new LocalEngineSessionCredentialStore(() => 100);
staleRenewCredentials.replace({
  session_token: 'stale-renew-session-token-long-enough',
  expires_at: 300,
  capabilities: ['analysis'],
});
const staleRenewRequests = [];
const staleRenewCoordinator = new LocalEngineConnectionCoordinator(
  {
    ...coordinatorClient,
    session: async (path) => {
      staleRenewRequests.push(path);
      return await new Promise((_resolve, reject) => { rejectStaleRenew = reject; });
    },
  },
  staleRenewCredentials,
  {
    onTransport: () => {}, onProbe: () => {}, onAuthorization: () => {}, onPairingState: () => {},
  },
  {
    probe: parseLocalEngineProbe,
    pairingStart: parseLocalEnginePairingStart,
    sessionCredential: parseLocalEngineSessionCredential,
  },
);
const staleRenew = staleRenewCoordinator.renewSession();
await Promise.resolve();
await staleRenewCoordinator.startPairing();
rejectStaleRenew(new Error('late network failure'));
await assert.rejects(staleRenew, /late network failure/);
assert.deepEqual(staleRenewRequests, ['/api/session/renew']);
assert.equal(
  staleRenewCredentials.requestHeaders().Authorization,
  'Bearer stale-renew-session-token-long-enough',
  'a stale renew failure must not revoke or clear the current session',
);

const rejectedProbeCoordinator = new LocalEngineConnectionCoordinator(
  {
    ...coordinatorClient,
    probe: async () => new Response(JSON.stringify(parsedProbe), { status: 503 }),
  },
  new LocalEngineSessionCredentialStore(() => 100),
  {
    onTransport: () => {},
    onProbe: () => assert.fail('non-2xx probe payload must not be trusted'),
    onAuthorization: () => {},
    onPairingState: () => {},
  },
  {
    probe: parseLocalEngineProbe,
    pairingStart: parseLocalEnginePairingStart,
    sessionCredential: parseLocalEngineSessionCredential,
  },
);
await assert.rejects(rejectedProbeCoordinator.probe(), error => error?.code === 'invalid-response');

let slowHeaderResolverStarted = false;
const timedClient = createLocalEngineClient({
  resolveBaseUrl: async () => await new Promise(resolve => setTimeout(() => resolve('http://127.0.0.1:17863'), 50)),
  resolveRequestHeaders: async () => {
    slowHeaderResolverStarted = true;
    return {};
  },
  fetch: async () => new Response('{}', { status: 200 }),
});
await assert.rejects(
  timedClient.request('/api/health', { timeoutMs: 5 }),
  error => error?.name === 'AbortError',
);
assert.equal(slowHeaderResolverStarted, false, 'timeout must include base URL resolution');

console.log('ok - web/Tauri runtime boundary and local engine client');
