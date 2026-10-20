import assert from 'node:assert/strict';
import {
  createLocalEnginePermissionGate,
  getLocalEngineBrowserAccessState,
  LocalEnginePermissionPromptDeferredError,
  pageNeedsLoopbackPermission,
} from '../src/localEngineBrowserAccess.ts';
import { createLocalEngineClient } from '../src/localEngineClientCore.ts';
import {
  applyLocalEngineProbe,
  createInitialLocalEngineConnection,
  parseLocalEngineProbe,
  updateLocalEngineTransport,
} from '../src/localEngineConnection.ts';
import { LocalEngineConnectionCoordinator } from '../src/localEngineConnectionCoordinator.ts';
import { getLocalEngineConnectionView } from '../src/localEngineConnectionView.ts';
import { parseLocalEnginePairingStart, parseLocalEngineSessionCredential } from '../src/localEngineSession.ts';
import { LOCAL_ENGINE_NAME, withJosa } from '../src/brand.ts';

// Permission lookup: the loopback permission decides, older names are only a fallback.
const permissionsWith = states => {
  const asked = [];
  return {
    asked,
    query: async ({ name }) => {
      asked.push(name);
      if (!(name in states)) throw new TypeError(`unknown permission ${name}`);
      return { state: states[name] };
    },
  };
};
let permissions = permissionsWith({ 'loopback-network': 'denied' });
assert.equal(await getLocalEngineBrowserAccessState(permissions), 'denied');
assert.deepEqual(permissions.asked, ['loopback-network']);
permissions = permissionsWith({ 'loopback-network': 'granted', 'local-network-access': 'denied' });
assert.equal(await getLocalEngineBrowserAccessState(permissions), 'granted', 'a granted loopback permission is not overridden by the older name');
assert.deepEqual(permissions.asked, ['loopback-network']);
permissions = permissionsWith({ 'loopback-network': 'prompt' });
assert.equal(await getLocalEngineBrowserAccessState(permissions), 'prompt');
permissions = permissionsWith({ 'local-network-access': 'denied' });
assert.equal(await getLocalEngineBrowserAccessState(permissions), 'denied', 'Chrome 142-144 name is used when loopback-network is unknown');
assert.deepEqual(permissions.asked, ['loopback-network', 'local-network-access']);
permissions = permissionsWith({});
assert.equal(await getLocalEngineBrowserAccessState(permissions), 'unsupported', 'browsers without either permission');
assert.equal(await getLocalEngineBrowserAccessState(undefined), 'unsupported');

// Which pages get Chrome's prompt: only sites not served from this PC.
for (const hostname of ['barorok.ecomarin.workers.dev', 'staging.example.com']) {
  assert.equal(pageNeedsLoopbackPermission(hostname), true, hostname);
}
for (const hostname of ['127.0.0.1', 'localhost', '[::1]', 'app.localhost', '']) {
  assert.equal(pageNeedsLoopbackPermission(hostname), false, hostname || '(no hostname)');
}

// Permission gate: background requests wait while the browser would ask; user checks go out.
const gateWith = (state, applies = true) => {
  let asked = 0;
  const permissionGate = createLocalEnginePermissionGate({
    applies: () => applies,
    accessState: async () => { asked += 1; if (state instanceof Error) throw state; return state; },
  });
  return { gate: permissionGate.beforeRequest, noteResponse: permissionGate.noteResponse, asked: () => asked };
};
let gated = gateWith('prompt');
await assert.rejects(gated.gate({ userInitiated: false }), LocalEnginePermissionPromptDeferredError);
await assert.rejects(gated.gate({ userInitiated: false }), TypeError, 'callers keep treating it as a network failure');
gated = gateWith('prompt');
await gated.gate({ userInitiated: true });
assert.equal(gated.asked(), 0, 'a user check never waits on the permission lookup');
for (const state of ['granted', 'denied', 'unsupported']) {
  gated = gateWith(state);
  await gated.gate({ userInitiated: false });
  assert.equal(gated.asked(), 1, `${state} lets background requests go: they cannot raise a prompt`);
}
gated = gateWith(new Error('permissions API broke'));
await gated.gate({ userInitiated: false });
gated = gateWith('prompt', false);
await gated.gate({ userInitiated: false });
assert.equal(gated.asked(), 0, 'pages served from this PC and the desktop app are never held back');
gated = gateWith('prompt');
await assert.rejects(gated.gate({ userInitiated: false }), LocalEnginePermissionPromptDeferredError);
gated.noteResponse();
await gated.gate({ userInitiated: false });
assert.equal(gated.asked(), 1, 'once the engine answered, a browser reporting prompt without enforcing it is not waited on');

// Snapshot: the cause only survives while the engine is unreachable.
const initial = createInitialLocalEngineConnection('web-local-engine');
assert.equal(initial.blockedBy, undefined);
const blocked = updateLocalEngineTransport(initial, 'unreachable', 10, 'browser-permission');
assert.equal(blocked.transport, 'unreachable');
assert.equal(blocked.blockedBy, 'browser-permission');
const responseBlocked = updateLocalEngineTransport(initial, 'unreachable', 10, 'response-blocked');
assert.equal(responseBlocked.blockedBy, 'response-blocked');
assert.equal(updateLocalEngineTransport(blocked, 'checking', 11).blockedBy, 'browser-permission', 'a background re-check keeps the known block');
assert.equal(updateLocalEngineTransport(initial, 'checking', 11).blockedBy, undefined);
assert.equal(updateLocalEngineTransport(blocked, 'reachable', 11).blockedBy, undefined);
assert.equal(updateLocalEngineTransport(blocked, 'unreachable', 11).blockedBy, undefined, 'a later plain failure clears the block');
assert.equal(updateLocalEngineTransport(initial, 'error', 11, 'browser-permission').blockedBy, undefined, 'only unreachable can be a browser block');
const probePayload = parseLocalEngineProbe({
  product_id: 'barorok-local-engine', engine_version: '0.1.8', api_contract_version: 1,
  capabilities: ['analysis'], auth_state: 'unpaired', pairing_available: true, update_required: false,
});
const reached = applyLocalEngineProbe(responseBlocked, probePayload, 12);
assert.equal(reached.transport, 'reachable');
assert.equal(reached.blockedBy, undefined);

// View: each browser block gets its own guidance, even before the first click.
const plainUnreachable = getLocalEngineConnectionView({
  snapshot: { ...initial, transport: 'unreachable' }, pairingPhase: 'idle', connectionStarted: true, installerAvailable: true,
});
assert.equal(plainUnreachable.scene, 'unreachable');
assert.doesNotMatch(plainUnreachable.title, /브라우저/);
for (const connectionStarted of [false, true]) {
  const permissionView = getLocalEngineConnectionView({
    snapshot: blocked, pairingPhase: 'idle', connectionStarted, installerAvailable: true,
  });
  assert.equal(permissionView.scene, 'browser-blocked');
  assert.equal(permissionView.title, '브라우저가 연결을 막고 있습니다');
  assert.match(permissionView.message, /‘기기에 있는 앱’을 허용/);
  assert.doesNotMatch(permissionView.message, /확장 프로그램/);
  const responseView = getLocalEngineConnectionView({
    snapshot: responseBlocked, pairingPhase: 'idle', connectionStarted, installerAvailable: true,
  });
  assert.equal(responseView.scene, 'browser-blocked');
  assert.match(responseView.message, /응답은 왔지만/, 'the user is told something on this PC answered');
  assert.match(responseView.message, /확장 프로그램/);
  assert.match(responseView.message, /다시 설치/, 'an older install that does not list this site is also possible');
  assert.doesNotMatch(responseView.message, /기기에 있는 앱/, 'the permission is already allowed in this case');
  assert.equal(permissionView.secondaryAction, null, 'reinstalling cannot fix a denied permission');
  assert.equal(responseView.secondaryAction, 'download');
  assert.equal(getLocalEngineConnectionView({
    snapshot: responseBlocked, pairingPhase: 'idle', connectionStarted, installerAvailable: false,
  }).secondaryAction, null, 'no download link without a configured installer');
  for (const blockedView of [permissionView, responseView]) {
    assert.ok(!blockedView.message.includes(`${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행`), 'starting the engine again cannot fix a browser block');
    assert.equal(blockedView.primaryAction, 'probe');
    assert.equal(blockedView.busy, false);
  }
}
for (const connectionStarted of [false, true]) {
  assert.equal(getLocalEngineConnectionView({
    snapshot: updateLocalEngineTransport(blocked, 'checking', 13), pairingPhase: 'idle', connectionStarted,
  }).scene, 'browser-blocked', 'the 10s background re-check does not flicker to intro or checking');
}
assert.equal(getLocalEngineConnectionView({
  snapshot: { ...blocked, transport: 'checking', blockedBy: undefined }, pairingPhase: 'idle', connectionStarted: true,
}).scene, 'checking', 'a manual retry (which clears the cause on screen) still shows the check in progress');
// Stale session, pairing or update states must not send the user to the wrong fix.
const staleStates = [
  ['expired session', { ...blocked, authorization: 'expired' }, 'idle'],
  ['revoked pairing', blocked, 'revoked'],
  ['pairing error', responseBlocked, 'error'],
  ['update required', { ...blocked, updateRequired: true }, 'idle'],
];
for (const [label, snapshot, pairingPhase] of staleStates) {
  assert.equal(getLocalEngineConnectionView({ snapshot, pairingPhase, connectionStarted: true }).scene, 'browser-blocked', label);
  assert.notEqual(getLocalEngineConnectionView({
    snapshot: { ...snapshot, blockedBy: undefined }, pairingPhase, connectionStarted: true,
  }).scene, 'browser-blocked', `${label} keeps its own guidance once the browser allows access`);
}
assert.equal(getLocalEngineConnectionView({
  snapshot: { ...reached, authorization: 'authenticated', capabilities: new Set(['analysis']) }, pairingPhase: 'connected', connectionStarted: true,
}).scene, 'connected');

// View: an undecided permission is explained before the click, during the check and after a closed prompt.
const awaitingPermission = updateLocalEngineTransport(initial, 'unreachable', 14, 'permission-prompt');
const introWithHint = getLocalEngineConnectionView({
  snapshot: awaitingPermission, pairingPhase: 'idle', connectionStarted: false, installerAvailable: true,
});
assert.equal(introWithHint.scene, 'intro', 'not a failure before the user has done anything');
assert.equal(introWithHint.tone, 'neutral');
assert.match(introWithHint.message, /‘연결 확인’을 누른 뒤 Chrome이 ‘기기에 있는 앱’을 물으면 ‘허용’을 눌러 주세요/);
assert.ok(introWithHint.message.includes(`처음이면 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 받아 설치하세요`));
assert.equal(introWithHint.primaryAction, 'probe');
assert.equal(introWithHint.secondaryAction, 'download');
assert.doesNotMatch(getLocalEngineConnectionView({
  snapshot: awaitingPermission, pairingPhase: 'idle', connectionStarted: false, installerAvailable: false,
}).message, /설치하세요/);
const plainIntro = getLocalEngineConnectionView({ snapshot: initial, pairingPhase: 'idle', connectionStarted: false, installerAvailable: true });
assert.doesNotMatch(plainIntro.message, /기기에 있는 앱/, 'no permission talk once the browser has decided');
const checkingWithPrompt = getLocalEngineConnectionView({
  snapshot: { ...awaitingPermission, transport: 'checking', blockedBy: undefined },
  pairingPhase: 'idle', connectionStarted: true, permissionPromptPending: true,
});
assert.equal(checkingWithPrompt.scene, 'checking');
assert.equal(checkingWithPrompt.message, 'Chrome이 ‘기기에 있는 앱’을 물으면 ‘허용’을 눌러 주세요.');
assert.equal(getLocalEngineConnectionView({
  snapshot: { ...awaitingPermission, transport: 'checking', blockedBy: undefined },
  pairingPhase: 'idle', connectionStarted: true,
}).message, null, 'ordinary checks stay quiet');
// After a check with the permission still undecided, the prompt was closed or nothing answered
// (Chrome 155 fails a closed port in ms without asking), so both fixes and the installer stay.
const undecidedAfterCheck = getLocalEngineConnectionView({
  snapshot: awaitingPermission, pairingPhase: 'idle', connectionStarted: true, installerAvailable: true,
});
assert.equal(undecidedAfterCheck.scene, 'unreachable');
assert.ok(undecidedAfterCheck.message.startsWith(`설치했다면 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행한 뒤 다시 확인하세요. `));
assert.match(undecidedAfterCheck.message, /‘기기에 있는 앱’을 물으면 ‘허용’을 눌러 주세요\.$/);
assert.equal(undecidedAfterCheck.secondaryAction, 'download', 'a first-time user without the engine keeps the install path');
assert.equal(undecidedAfterCheck.primaryAction, 'probe');
const heldBackground = getLocalEngineConnectionView({
  snapshot: updateLocalEngineTransport(awaitingPermission, 'checking', 15), pairingPhase: 'idle', connectionStarted: true, installerAvailable: true,
});
assert.equal(heldBackground.scene, 'unreachable', 'a held background re-check does not flash a spinner');
assert.equal(heldBackground.busy, false);
assert.equal(getLocalEngineConnectionView({
  snapshot: { ...initial, transport: 'unreachable' }, pairingPhase: 'idle', connectionStarted: true,
}).message, `설치했다면 ${withJosa(LOCAL_ENGINE_NAME, '을/를')} 실행한 뒤 다시 확인하세요.`, 'a decided permission keeps the plain message');

// Coordinator: a failed probe asks the browser, then whether the engine answered at all.
const credentials = { current: () => null, replace: () => true, clear: () => {}, requestHeaders: () => ({}) };
const browserCredentials = { current: () => null, replace: () => {}, clear: () => {} };
const parsers = {
  probe: parseLocalEngineProbe,
  pairingStart: parseLocalEnginePairingStart,
  sessionCredential: parseLocalEngineSessionCredential,
};
const runFailedProbe = async ({ browserAccessState, reach, probeError = new TypeError('Failed to fetch'), userInitiated }) => {
  const transports = [];
  const reachCalls = [];
  const probeCalls = [];
  const client = {
    probe: async init => { probeCalls.push(init); throw probeError; },
    ...(reach ? { reach: async init => { reachCalls.push(init); return reach(init); } } : {}),
    pair: async () => { throw new Error('pair must not be called'); },
    session: async () => { throw new Error('session must not be called'); },
    request: async () => { throw new Error('request must not be called'); },
    stream: async () => { throw new Error('stream must not be called'); },
    download: async () => { throw new Error('download must not be called'); },
  };
  const coordinator = new LocalEngineConnectionCoordinator(
    client,
    credentials,
    {
      onTransport: (transport, detail) => transports.push([transport, detail]),
      ...(browserAccessState ? { browserAccessState } : {}),
      onProbe: () => { throw new Error('no probe payload expected'); },
      onAuthorization: () => {},
      onPairingState: () => {},
    },
    parsers,
    undefined,
    browserCredentials,
  );
  await assert.rejects(
    coordinator.probe(userInitiated === undefined ? undefined : { userInitiated }),
    error => error.code === 'unreachable',
  );
  return { transports, reachCalls, probeCalls };
};
const engineStopped = async () => { throw new TypeError('Failed to fetch'); };
const engineAnswers = async () => new Response(null, { status: 200 });
let result = await runFailedProbe({ browserAccessState: async () => 'denied', reach: engineAnswers });
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: 'browser-permission' }]]);
assert.equal(result.reachCalls.length, 0, 'a known permission block needs no extra request');
result = await runFailedProbe({ browserAccessState: async () => 'granted', reach: engineAnswers });
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: 'response-blocked' }]]);
assert.equal(result.reachCalls.length, 1);
assert.equal(result.reachCalls[0].timeoutMs, 3000, 'the reach check cannot hold the failure screen');
result = await runFailedProbe({ browserAccessState: async () => 'prompt', reach: engineAnswers });
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: 'permission-prompt' }]], 'a closed prompt is a permission problem, not a stopped engine');
assert.equal(result.reachCalls.length, 0, 'no extra request while Chrome may still ask, so its prompt is not raised again');
let accessAsked = 0;
result = await runFailedProbe({
  probeError: new LocalEnginePermissionPromptDeferredError(),
  browserAccessState: async () => { accessAsked += 1; return 'granted'; },
  reach: engineAnswers,
});
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: 'permission-prompt' }]], 'a held-back background check waits for the user');
assert.equal(accessAsked, 0);
assert.equal(result.reachCalls.length, 0, 'a held-back check sends nothing else either');
result = await runFailedProbe({ userInitiated: true, browserAccessState: async () => 'granted', reach: engineStopped });
assert.deepEqual(result.probeCalls, [{ cache: 'no-store', userInitiated: true }], 'a user check is marked so the browser may ask');
result = await runFailedProbe({ browserAccessState: async () => 'granted', reach: engineStopped });
assert.deepEqual(result.probeCalls, [{ cache: 'no-store', userInitiated: false }], 'background checks never ask');
result = await runFailedProbe({ browserAccessState: async () => 'unsupported', reach: engineAnswers });
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: 'response-blocked' }]], 'browsers without the permission still get the check');
result = await runFailedProbe({ browserAccessState: async () => 'granted', reach: engineStopped });
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: undefined }]], 'a stopped engine keeps the plain unreachable message');
result = await runFailedProbe({ browserAccessState: async () => { throw new Error('permissions API broke'); }, reach: engineStopped });
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: undefined }]], 'a failing permission lookup falls back');
result = await runFailedProbe({});
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: undefined }]], 'clients without a reach check fall back');

// Coordinator: background re-checks do not supersede the user's check while Chrome may be asking.
{
  let releaseUserCheck;
  const probeInits = [];
  const transports = [];
  const client = {
    probe: init => {
      probeInits.push(init);
      return init.userInitiated
        ? new Promise((_, reject) => { releaseUserCheck = () => reject(new TypeError('Failed to fetch')); })
        : Promise.reject(new LocalEnginePermissionPromptDeferredError());
    },
    reach: async () => { throw new TypeError('Failed to fetch'); },
  };
  const coordinator = new LocalEngineConnectionCoordinator(
    client, credentials,
    { onTransport: (transport, detail) => transports.push([transport, detail]), browserAccessState: async () => 'granted',
      onProbe: () => {}, onAuthorization: () => {}, onPairingState: () => {} },
    parsers, undefined, browserCredentials,
  );
  const userCheck = coordinator.probe({ userInitiated: true });
  assert.equal(await coordinator.probe(), null, 'the 10s/focus re-check waits for the user check');
  assert.equal(probeInits.length, 1);
  releaseUserCheck();
  await assert.rejects(userCheck, error => error.code === 'unreachable');
  assert.deepEqual(transports, [['checking', undefined], ['unreachable', { blockedBy: undefined }]], 'the user check is not overwritten');
  await assert.rejects(coordinator.probe(), error => error.code === 'unreachable');
  assert.equal(probeInits.length, 2, 'background re-checks resume after the user check ends');
}

// Client: the reach check is a credential-free no-cors request to the probe path.
const sent = [];
const client = createLocalEngineClient({
  resolveBaseUrl: async () => 'http://127.0.0.1:17863',
  resolveRequestHeaders: async () => ({ Authorization: 'Bearer must-not-leak-into-reach-check' }),
  fetch: async (url, init) => { sent.push({ url: String(url), init }); return new Response(null, { status: 200 }); },
});
await client.reach({ timeoutMs: 3000 });
assert.equal(sent.length, 1);
assert.equal(sent[0].url, 'http://127.0.0.1:17863/api/probe');
assert.equal(sent[0].init.mode, 'no-cors');
assert.equal(sent[0].init.credentials, 'omit');
assert.equal(new Headers(sent[0].init.headers).has('Authorization'), false);

// Client: every request passes the gate first, and a held request never reaches fetch.
const gateCalls = [];
let holdBackground = true;
const gatedSent = [];
const gatedClient = createLocalEngineClient({
  resolveBaseUrl: async () => 'http://127.0.0.1:17863',
  resolveRequestHeaders: async () => ({}),
  fetch: async (url, init) => { gatedSent.push(init); return new Response('{}', { status: 200 }); },
  beforeRequest: async options => {
    gateCalls.push(options);
    if (holdBackground && !options.userInitiated) throw new LocalEnginePermissionPromptDeferredError();
  },
});
await assert.rejects(gatedClient.request('/api/settings'), LocalEnginePermissionPromptDeferredError);
await assert.rejects(gatedClient.probe({ cache: 'no-store' }), LocalEnginePermissionPromptDeferredError);
assert.equal(gatedSent.length, 0, 'held requests never leave the browser');
await gatedClient.probe({ cache: 'no-store', userInitiated: true });
assert.equal(gatedSent.length, 1);
assert.equal('userInitiated' in gatedSent[0], false, 'the marker is not passed to fetch');
holdBackground = false;
await gatedClient.request('/api/settings');
assert.equal(gatedSent.length, 2);
assert.deepEqual(gateCalls, [
  { userInitiated: false }, { userInitiated: false }, { userInitiated: true }, { userInitiated: false },
]);

console.log('ok - local engine browser blocks are reported separately from a stopped engine');
