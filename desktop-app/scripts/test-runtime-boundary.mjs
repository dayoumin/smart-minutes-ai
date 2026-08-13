import assert from 'node:assert/strict';
import {
  detectRuntimeEnvironment,
  runtimeHasCapability,
} from '../src/runtimeEnvironment.ts';
import {
  canUseLocalEngineCapability,
  createInitialLocalEngineConnection,
  isLocalEngineConnected,
  isLatestTransportCheck,
  transportFromHealthEvidence,
  updateLocalEngineTransport,
} from '../src/localEngineConnection.ts';
import { createLocalEngineClient } from '../src/localEngineClientCore.ts';

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

const authenticatedConnection = {
  ...connection,
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
