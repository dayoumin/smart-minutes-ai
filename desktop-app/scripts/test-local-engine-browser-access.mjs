import assert from 'node:assert/strict';
import { getLocalEngineBrowserAccessState } from '../src/localEngineBrowserAccess.ts';
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
    assert.doesNotMatch(blockedView.message, /바로록 연결을 실행/, 'starting the engine again cannot fix a browser block');
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

// Coordinator: a failed probe asks the browser, then whether the engine answered at all.
const credentials = { current: () => null, replace: () => true, clear: () => {}, requestHeaders: () => ({}) };
const browserCredentials = { current: () => null, replace: () => {}, clear: () => {} };
const parsers = {
  probe: parseLocalEngineProbe,
  pairingStart: parseLocalEnginePairingStart,
  sessionCredential: parseLocalEngineSessionCredential,
};
const runFailedProbe = async ({ browserAccessState, reach }) => {
  const transports = [];
  const reachCalls = [];
  const client = {
    probe: async () => { throw new TypeError('Failed to fetch'); },
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
  await assert.rejects(coordinator.probe(), error => error.code === 'unreachable');
  return { transports, reachCalls };
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
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: undefined }]]);
assert.equal(result.reachCalls.length, 0, 'no extra request while Chrome may still ask, so its prompt is not raised again');
result = await runFailedProbe({ browserAccessState: async () => 'unsupported', reach: engineAnswers });
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: 'response-blocked' }]], 'browsers without the permission still get the check');
result = await runFailedProbe({ browserAccessState: async () => 'granted', reach: engineStopped });
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: undefined }]], 'a stopped engine keeps the plain unreachable message');
result = await runFailedProbe({ browserAccessState: async () => { throw new Error('permissions API broke'); }, reach: engineStopped });
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: undefined }]], 'a failing permission lookup falls back');
result = await runFailedProbe({});
assert.deepEqual(result.transports, [['checking', undefined], ['unreachable', { blockedBy: undefined }]], 'clients without a reach check fall back');

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

console.log('ok - local engine browser blocks are reported separately from a stopped engine');
