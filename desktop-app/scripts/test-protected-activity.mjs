import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalEngineClient } from '../src/localEngineClientCore.ts';
import { LocalEngineConnectionCoordinator } from '../src/localEngineConnectionCoordinator.ts';
import { LocalEngineSessionCredentialStore, parseLocalEngineSessionCredential } from '../src/localEngineSession.ts';

const flush = async () => { for (let i = 0; i < 30; i += 1) await Promise.resolve(); };
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
const fakeClock = () => {
  let seconds = 0;
  let next = 0;
  const timers = new Map();
  return {
    now: () => seconds,
    setTimeout: (callback, ms) => { const id = ++next; timers.set(id, { at: seconds + ms / 1000, callback }); return id; },
    clearTimeout: id => timers.delete(id),
    count: () => timers.size,
    jump: value => { seconds += value; },
    advance: async value => {
      const target = seconds + value;
      for (let i = 0; i < 100; i += 1) {
        const due = [...timers].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) { seconds = target; await flush(); return; }
        timers.delete(due[0]); seconds = Math.max(seconds, due[1].at); due[1].callback(); await flush();
      }
      throw Error('Activity timer did not settle');
    },
  };
};
const fixture = ({ respond, renew } = {}) => {
  const clock = fakeClock();
  const store = new LocalEngineSessionCredentialStore(clock.now);
  const credential = (name = 'initial-test-credential-long-enough') => ({ session_token: name, expires_at: clock.now() + 900, capabilities: ['analysis', 'export'] });
  store.replace(credential());
  let coordinator;
  const renewals = [];
  const sources = [];
  const events = [];
  const client = createLocalEngineClient({
    resolveBaseUrl: async () => 'http://127.0.0.1:17863',
    resolveRequestHeaders: async () => store.requestHeaders(),
    captureAuthorizationRecovery: authorization => coordinator.captureAuthorizationRecovery(authorization),
    beginProtectedActivity: (authorization, signal) => coordinator.beginProtectedActivity(authorization, signal),
    fetch: (input, init) => {
      const path = new URL(input).pathname;
      if (path === '/api/session/renew') {
        renewals.push(clock.now());
        return renew ? renew(credential()) : Promise.resolve(Response.json(credential()));
      }
      if (path === '/api/session/revoke') return Promise.resolve(Response.json({ revoked: true }));
      if (path === '/api/pair/start') return Promise.resolve(Response.json({ pairing_id: 'test-challenge-id-long-enough', expires_in_seconds: 120 }));
      if (path === '/api/pair/complete') return Promise.resolve(Response.json(credential('new-pair-test-credential-long-enough')));
      if (respond) return respond(input, init);
      return Promise.resolve(new Response(new ReadableStream({ start(controller) { sources.push(controller); } }), { headers: { 'Content-Type': 'text/event-stream', 'X-Test': 'retained' } }));
    },
  });
  coordinator = new LocalEngineConnectionCoordinator(client, store, {
    onTransport() {}, onProbe() {}, onAuthorization: state => events.push(state), onPairingState() {},
  }, { probe: () => null, pairingStart: value => value, sessionCredential: parseLocalEngineSessionCredential }, clock);
  return { client, coordinator, clock, store, credential, renewals, sources, events };
};

await test('a live analyze SSE renews before 15 minutes; EOF releases it and idle expires normally', async () => {
  const f = fixture();
  const response = await f.client.stream('/api/analyze', { method: 'POST' });
  assert.equal(response.headers.get('X-Test'), 'retained');
  const body = response.text();
  await f.clock.advance(840);
  assert.equal(f.renewals.length, 1);
  assert.ok(f.store.current());
  await f.clock.advance(840);
  assert.equal(f.renewals.length, 2);
  f.sources[0].close();
  await body;
  assert.equal(f.clock.count(), 0);
  await f.clock.advance(900);
  assert.equal(f.store.current(), null);
  assert.equal(f.renewals.length, 2);
});

await test('pending generation keeps its scope through JSON consumption', async () => {
  const gate = deferred();
  const f = fixture({ respond: () => gate.promise });
  const request = f.client.request('/api/outputs/job/generate-summary', { method: 'POST' });
  await flush();
  await f.clock.advance(840);
  assert.equal(f.renewals.length, 1);
  const original = Response.json({ summary: 'done' }, { status: 201, headers: { 'X-Test': 'metadata' } });
  Object.defineProperty(original, 'url', { value: 'http://127.0.0.1:17863/api/outputs/job/generate-summary' });
  gate.resolve(original);
  const response = await request;
  assert.equal(response.status, 201);
  assert.equal(response.headers.get('X-Test'), 'metadata');
  assert.equal(response.url, original.url);
  assert.equal(response.type, original.type);
  assert.equal(response.redirected, original.redirected);
  assert.deepEqual(await response.json(), { summary: 'done' });
  assert.equal(f.clock.count(), 0);
});

await test('work started ten seconds before expiry renews immediately while credentials are still valid', async () => {
  const f = fixture();
  f.clock.jump(890);
  const response = await f.client.stream('/api/analyze', { method: 'POST' });
  await f.clock.advance(0);
  assert.deepEqual(f.renewals, [890]);
  assert.equal(f.store.current().expires_at, 1790);
  await response.body.cancel();
  assert.equal(f.clock.count(), 0);
});

await test('a non-extending or still-near-expiry renewal cannot cause an immediate renewal loop', async () => {
  for (const expiresAt of [900, 850]) {
    const f = fixture({ renew: async value => Response.json({ ...value, expires_at: expiresAt }) });
    const response = await f.client.stream('/api/analyze', { method: 'POST' });
    await f.clock.advance(840);
    assert.equal(f.renewals.length, 1);
    assert.equal(f.clock.count(), 0);
    await f.clock.advance(900);
    assert.equal(f.renewals.length, 1);
    assert.equal(f.store.current(), null);
    await response.body.cancel();
  }
});

await test('all six explicit generation endpoints participate, and concurrent scopes share one renewal', async () => {
  const f = fixture();
  const responses = [];
  for (const kind of ['summary', 'diarization', 'topic-sections', 'topic-section', 'speaker-context', 'report']) {
    responses.push(await f.client.request(`/api/outputs/job/generate-${kind}`, { method: 'POST' }));
  }
  assert.equal(f.clock.count(), 1);
  await responses[0].body.cancel();
  assert.equal(f.clock.count(), 1, 'one completed scope must not stop another running request');
  await f.clock.advance(840);
  assert.equal(f.renewals.length, 1);
  for (const response of responses.slice(1)) await response.body.cancel();
  assert.equal(f.clock.count(), 0);
});

await test('renewal failure expires only the current connection and does not loop', async () => {
  const f = fixture({ renew: async () => new Response(null, { status: 503 }) });
  const response = await f.client.stream('/api/analyze', { method: 'POST' });
  await f.clock.advance(840);
  assert.equal(f.renewals.length, 1);
  assert.equal(f.store.current(), null);
  assert.ok(f.events.includes('expired'));
  assert.equal(f.clock.count(), 0);
  await f.clock.advance(900);
  assert.equal(f.renewals.length, 1);
  await response.body.cancel();
});

await test('already expired credentials and a pending pairing intent cannot start work renewal', async () => {
  for (const state of ['expired', 'pairing']) {
    const f = fixture();
    if (state === 'expired') f.clock.jump(901);
    else await f.coordinator.startPairing();
    const response = await f.client.stream('/api/analyze', { method: 'POST' });
    await f.clock.advance(840);
    assert.equal(f.renewals.length, 0, state);
    assert.equal(f.clock.count(), 0, state);
    await response.body.cancel();
  }
});

await test('polling, downloads, unknown mutations and GET analyze never keep idle authorization alive', async () => {
  for (const [path, method] of [['/api/health', 'GET'], ['/api/models/status', 'GET'], ['/api/analyze/preflight', 'POST'], ['/api/analyze', 'GET'], ['/api/outputs/job/audio', 'GET'], ['/api/outputs/job/generate-unknown', 'POST']]) {
    const f = fixture();
    const response = await f.client.request(path, { method });
    await f.clock.advance(901);
    assert.equal(f.renewals.length, 0, path);
    assert.equal(f.store.current(), null, path);
    await response.body.cancel();
  }
});

await test('body cancel, body error and caller abort release only the activity lifetime', async () => {
  for (const end of ['cancel', 'error', 'abort']) {
    const f = fixture();
    const controller = new AbortController();
    const response = await f.client.stream('/api/analyze', { method: 'POST', signal: controller.signal });
    if (end === 'cancel') await response.body.cancel();
    if (end === 'error') { const body = response.text(); f.sources[0].error(Error('fixture stream failure')); await assert.rejects(body); }
    if (end === 'abort') {
      controller.abort();
      assert.equal(f.clock.count(), 0, 'caller abort alone must release activity without cancelling the response body');
    }
    await f.clock.advance(901);
    assert.equal(f.clock.count(), 0, end);
    assert.equal(f.renewals.length, 0, end);
    if (end === 'abort') await response.body.cancel();
  }
});

await test('non-OK, 204, absent body, synchronous fetch failure and pre-header abort leave no activity', async () => {
  for (const status of [401, 503, 204, 200]) {
    const f = fixture({ respond: () => Promise.resolve(new Response(null, { status })) });
    const response = await f.client.request('/api/outputs/job/generate-report', { method: 'POST' });
    assert.equal(response.status, status);
    assert.equal(f.clock.count(), 0);
  }
  const failed = fixture({ respond: () => { throw Error('fixture fetch failure'); } });
  await assert.rejects(failed.client.stream('/api/analyze', { method: 'POST' }));
  assert.equal(failed.clock.count(), 0);
  const gate = deferred();
  const f = fixture({ respond: () => gate.promise });
  const controller = new AbortController();
  const request = f.client.stream('/api/analyze', { method: 'POST', signal: controller.signal });
  await flush(); controller.abort();
  await assert.rejects(request, error => error.name === 'AbortError');
  assert.equal(f.clock.count(), 0);
  gate.resolve(new Response(null));
});

await test('delayed timers never resurrect expired credentials', async () => {
  const f = fixture();
  const response = await f.client.stream('/api/analyze', { method: 'POST' });
  f.clock.jump(901);
  await f.clock.advance(0);
  assert.equal(f.store.current(), null);
  assert.equal(f.renewals.length, 0);
  assert.equal(f.clock.count(), 0);
  await response.body.cancel();
});

await test('revoke, pairing intent, completion and dispose invalidate old activities', async () => {
  for (const action of ['revoke', 'start', 'complete', 'dispose']) {
    const f = fixture();
    const response = await f.client.stream('/api/analyze', { method: 'POST' });
    if (action === 'revoke') await f.coordinator.revokeSession();
    if (action === 'start') await f.coordinator.startPairing();
    if (action === 'complete') await f.coordinator.completePairing('test-challenge', 'test-input');
    if (action === 'dispose') f.coordinator.dispose();
    await f.clock.advance(840);
    assert.equal(f.renewals.length, 0, action);
    assert.equal(f.clock.count(), 0, action);
    await response.body.cancel();
  }
});

await test('a delayed work renewal cannot overwrite a newer pairing or revive a revoked connection', async () => {
  for (const action of ['pair', 'revoke']) {
    const gate = deferred();
    const f = fixture({ renew: () => gate.promise });
    const response = await f.client.stream('/api/analyze', { method: 'POST' });
    await f.clock.advance(840);
    assert.equal(f.renewals.length, 1);
    if (action === 'pair') { await f.coordinator.startPairing(); await f.coordinator.completePairing('test-challenge', 'test-input'); }
    else await f.coordinator.revokeSession();
    gate.resolve(Response.json(f.credential()));
    await flush();
    if (action === 'pair') assert.equal(f.store.current().session_token, 'new-pair-test-credential-long-enough');
    else assert.equal(f.store.current(), null);
    assert.equal(f.clock.count(), 0);
    await response.body.cancel();
  }
});
