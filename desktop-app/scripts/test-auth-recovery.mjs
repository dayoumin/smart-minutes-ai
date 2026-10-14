import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalEngineClient } from '../src/localEngineClientCore.ts';
import { LocalEngineConnectionCoordinator } from '../src/localEngineConnectionCoordinator.ts';
import { LocalEngineSessionCredentialStore, parseLocalEngineSessionCredential } from '../src/localEngineSession.ts';

const OLD = 'initial-test-session-long-enough';
const NEW = 'renewed-test-session-long-enough';
const credential = (token = NEW) => ({ session_token: token, expires_at: 300, capabilities: ['analysis', 'export'] });
const rejected = () => new Response('{}', { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } });
const reply = value => new Response(JSON.stringify(value), { status: 200 });
const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};

const fixture = ({ respond, renew, headers, onHeaders, pair, revoke } = {}) => {
  const store = new LocalEngineSessionCredentialStore(() => 100);
  store.replace(credential(OLD));
  const requests = [];
  const sessionCalls = [];
  const events = [];
  let coordinator;
  let base = 'http://127.0.0.1:17863';
  let headerCount = 0;
  const client = createLocalEngineClient({
    resolveBaseUrl: async () => base,
    resolveRequestHeaders: async () => {
      headerCount += 1;
      await onHeaders?.(headerCount);
      return headers ?? store.requestHeaders();
    },
    captureAuthorizationRecovery: authorization => coordinator.captureAuthorizationRecovery(authorization),
    fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      if (path.startsWith('/api/session/')) {
        sessionCalls.push({ path, init });
        if (path.endsWith('/renew')) return renew ? await renew(init) : reply(credential());
        if (revoke) return await revoke();
        return reply({ revoked: true });
      }
      if (path === '/api/pair/start') return pair ? await pair() : reply({ pairing_id: 'pairing-id-long-enough', expires_in_seconds: 120 });
      if (path === '/api/pair/complete') return reply(credential('paired-test-session-long-enough'));
      requests.push({ input: String(input), init });
      if (respond) return await respond(requests.length, init);
      return new Headers(init.headers).get('Authorization') === 'Bearer ' + OLD ? rejected() : reply({ ok: true });
    },
  });
  coordinator = new LocalEngineConnectionCoordinator(client, store, {
    onTransport: () => {}, onProbe: () => {},
    onAuthorization: state => events.push(state), onPairingState: () => {},
  }, { probe: () => null, pairingStart: value => value, sessionCredential: parseLocalEngineSessionCredential });
  return { client, coordinator, store, requests, sessionCalls, events, setBase: value => { base = value; } };
};

await test('GET, download and POST stream each retry once after renewal', async () => {
  for (const method of ['request', 'download', 'stream']) {
    const f = fixture();
    const path = method === 'stream' ? '/api/analyze' : method === 'download' ? '/api/outputs/job/audio' : '/api/health';
    const init = method === 'stream' ? { method: 'POST', body: '{"job_id":"same-job"}' } : {};
    const response = await f.client[method](path, init);
    assert.equal(response.status, 200);
    assert.equal(f.requests.length, 2);
    assert.equal(f.sessionCalls.length, 1);
    assert.equal(f.requests[1].init.body, f.requests[0].init.body);
    assert.equal(new Headers(f.requests[1].init.headers).get('Authorization'), 'Bearer ' + NEW);
  }
});

await test('FormData upload is unchanged and its handler executes only once', async () => {
  const body = new FormData();
  body.append('job_id', 'same-job');
  body.append('file', new Blob(['audio']), 'meeting.wav');
  let executions = 0;
  const f = fixture({ respond: async (count, init) => {
    assert.equal(init.body.get('job_id'), 'same-job');
    assert.equal(init.body.get('file').name, 'meeting.wav');
    assert.equal(await init.body.get('file').text(), 'audio');
    if (count === 1) {
      body.set('job_id', 'mutated-after-send');
      return rejected();
    }
    executions += 1;
    return reply({ ok: true });
  } });
  assert.equal((await f.client.stream('/api/analyze', { method: 'POST', body })).status, 200);
  assert.equal(f.requests.length, 2);
  assert.equal(executions, 1);
});

await test('mutable binary and URLSearchParams bodies are snapshotted', async () => {
  for (const body of [new Uint8Array([1, 2, 3]), new URLSearchParams({ job: 'original' })]) {
    const f = fixture({ respond: async (count, init) => {
      if (body instanceof URLSearchParams) assert.equal(init.body.get('job'), 'original');
      else assert.deepEqual([...init.body], [1, 2, 3]);
      if (count === 1) {
        if (body instanceof URLSearchParams) body.set('job', 'changed');
        else body.fill(9);
        return rejected();
      }
      return reply({});
    } });
    assert.equal((await f.client.request('/api/analyze', { method: 'POST', body })).status, 200);
    assert.equal(f.requests.length, 2);
  }
});

await test('overlapping unauthorized requests share one renewal', async () => {
  const gate = deferred();
  const entered = deferred();
  const f = fixture({ renew: async () => { entered.resolve(); return await gate.promise; } });
  const first = f.client.request('/api/health');
  const second = f.client.download('/api/outputs/job/audio');
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sessionCalls.length, 1);
  gate.resolve(reply(credential()));
  assert.deepEqual((await Promise.all([first, second])).map(response => response.status), [200, 200]);
  assert.equal(f.requests.length, 4);
  assert.equal(f.sessionCalls.length, 1);
});

await test('renewal 401 clears credentials and returns the original rejection', async () => {
  const f = fixture({ renew: async () => rejected() });
  const response = await f.client.request('/api/health');
  assert.equal(response.status, 401);
  assert.equal(await response.text(), '{}');
  assert.equal(f.requests.length, 1);
  assert.equal(f.sessionCalls.length, 1);
  assert.deepEqual(f.store.requestHeaders(), {});
  assert.equal(f.events.at(-1), 'expired');
});

await test('malformed or unreachable renewal cannot replay an upload', async () => {
  for (const renew of [async () => reply({}), async () => { throw new TypeError('network unavailable'); }]) {
    const f = fixture({ renew });
    assert.equal((await f.client.stream('/api/analyze', { method: 'POST', body: '{}' })).status, 401);
    assert.equal(f.requests.length, 1);
    assert.equal(f.sessionCalls.filter(call => call.path.endsWith('/renew')).length, 1);
    assert.deepEqual(f.store.requestHeaders(), {});
    assert.equal(f.events.at(-1), 'expired');
  }
});

await test('second auth rejection expires the recovered session without a loop', async () => {
  const f = fixture({ respond: async () => rejected() });
  assert.equal((await f.client.request('/api/health')).status, 401);
  assert.equal(f.requests.length, 2);
  assert.equal(f.sessionCalls.length, 1);
  assert.deepEqual(f.store.requestHeaders(), {});
  assert.equal(f.events.at(-1), 'expired');
});

await test('bare 401, forbidden and server errors never replay mutations', async () => {
  for (const status of [401, 403, 500]) {
    const f = fixture({ respond: async () => new Response('{}', { status }) });
    assert.equal((await f.client.request('/api/analyze', { method: 'POST', body: '{}' })).status, status);
    assert.equal(f.requests.length, 1);
    assert.equal(f.sessionCalls.length, 0);
  }
});

await test('network failure after dispatch never replays the request', async () => {
  const f = fixture({ respond: async () => { throw new TypeError('connection lost'); } });
  await assert.rejects(f.client.stream('/api/analyze', { method: 'POST', body: '{}' }), /connection lost/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.sessionCalls.length, 0);
});

await test('a started SSE body failure does not start another analysis', async () => {
  const body = new ReadableStream({ start(controller) { controller.error(new Error('stream interrupted')); } });
  const f = fixture({ respond: async () => new Response(body, { status: 200 }) });
  const response = await f.client.stream('/api/analyze', { method: 'POST', body: '{}' });
  await assert.rejects(response.text(), /stream interrupted/);
  assert.equal(f.requests.length, 1);
  assert.equal(f.sessionCalls.length, 0);
});

await test('non-replayable streaming upload is not sent again', async () => {
  const f = fixture();
  const body = new ReadableStream({ start(controller) { controller.close(); } });
  assert.equal((await f.client.stream('/api/analyze', { method: 'POST', body })).status, 401);
  assert.equal(f.requests.length, 1);
  assert.equal(f.sessionCalls.length, 1);
});

await test('public requests and explicit session calls bypass automatic recovery', async () => {
  let recoveries = 0;
  const client = createLocalEngineClient({
    resolveBaseUrl: async () => 'http://127.0.0.1:17863',
    resolveRequestHeaders: async () => ({ Authorization: 'Bearer ' + OLD }),
    captureAuthorizationRecovery: () => async () => { recoveries += 1; return null; },
    fetch: async () => rejected(),
  });
  await client.probe();
  await client.pair('/api/pair/start', { method: 'POST' });
  await client.session('/api/session/renew', OLD, { method: 'POST' });
  assert.equal(recoveries, 0);
});

await test('desktop or caller-only credentials do not enter web recovery', async () => {
  for (const headers of [{ 'X-LMO-Desktop-Action-Token': 'desktop-test-token' }, {}]) {
    const f = fixture({ headers, respond: async () => rejected() });
    assert.equal((await f.client.request('/api/health', { headers: { Authorization: 'Bearer caller-only' } })).status, 401);
    assert.equal(f.requests.length, 1);
    assert.equal(f.sessionCalls.length, 0);
  }
});

await test('caller cancellation stops replay but not another waiting request', async () => {
  const gate = deferred();
  const entered = deferred();
  const f = fixture({ renew: async () => { entered.resolve(); return await gate.promise; } });
  const controller = new AbortController();
  const canceled = f.client.request('/api/health', { signal: controller.signal });
  const cancellation = assert.rejects(canceled, error => error?.name === 'AbortError');
  const active = f.client.download('/api/outputs/job/audio');
  await entered.promise;
  await new Promise(resolve => setImmediate(resolve));
  controller.abort();
  await cancellation;
  gate.resolve(reply(credential()));
  assert.equal((await active).status, 200);
  assert.equal(f.sessionCalls.length, 1);
  assert.equal(f.requests.length, 3);
});

await test('request timeout includes authorization recovery', async () => {
  const gate = deferred();
  const f = fixture({ renew: async () => await gate.promise });
  await assert.rejects(f.client.request('/api/health', { timeoutMs: 10 }), error => error?.name === 'AbortError');
  gate.resolve(reply(credential()));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.requests.length, 1);
});

await test('a stalled renewal is bounded and publishes expired state', { timeout: 10000 }, async () => {
  const f = fixture({ renew: async () => await new Promise(() => {}) });
  assert.equal((await f.client.request('/api/health')).status, 401);
  assert.equal(f.requests.length, 1);
  assert.deepEqual(f.store.requestHeaders(), {});
  assert.equal(f.events.at(-1), 'expired');
});

await test('revoke, new pairing or disposal invalidates an in-flight recovery', async () => {
  for (const action of ['revoke', 'pair', 'dispose']) {
    const gate = deferred();
    const entered = deferred();
    const f = fixture({ renew: async () => { entered.resolve(); return await gate.promise; } });
    const pending = f.client.request('/api/health');
    await entered.promise;
    if (action === 'revoke') await f.coordinator.revokeSession();
    if (action === 'pair') await f.coordinator.startPairing();
    if (action === 'dispose') f.coordinator.dispose();
    gate.resolve(reply(credential()));
    assert.equal((await pending).status, 401);
    assert.equal(f.requests.length, 1);
    assert.notEqual(f.store.requestHeaders().Authorization, 'Bearer ' + NEW);
    if (action === 'revoke') assert.equal(f.events.at(-1), 'revoked');
    else assert.equal(f.events.length, 0);
  }
});

await test('a new engine address prevents replay of the original request', async () => {
  let f;
  f = fixture({ renew: async () => {
    f.setBase('http://127.0.0.1:17864');
    return reply(credential());
  } });
  assert.equal((await f.client.request('/api/health')).status, 401);
  assert.equal(f.requests.length, 1);
});

await test('changing authorization after recovery but before replay cancels replay', async () => {
  let f;
  f = fixture({ onHeaders: async count => {
    if (count === 2) f.coordinator.resetPairing();
  } });
  assert.equal((await f.client.request('/api/health')).status, 401);
  assert.equal(f.requests.length, 1);
});

await test('late retry rejection cannot expire a newly paired session', async () => {
  let f;
  f = fixture({ respond: async count => {
    if (count === 2) {
      const challenge = await f.coordinator.startPairing();
      await f.coordinator.completePairing(challenge.pairing_id, '123456');
    }
    return rejected();
  } });
  assert.equal((await f.client.request('/api/health')).status, 401);
  assert.equal(f.store.requestHeaders().Authorization, 'Bearer paired-test-session-long-enough');
  assert.equal(f.events.at(-1), 'authenticated');
});

await test('late initial 401 reuses a completed renewal without renewing again', async () => {
  const late = deferred();
  const entered = deferred();
  const f = fixture({ respond: async (count, init) => {
    if (count === 2) { entered.resolve(); return await late.promise; }
    return new Headers(init.headers).get('Authorization') === 'Bearer ' + OLD ? rejected() : reply({});
  } });
  const first = f.client.request('/api/health');
  const second = f.client.download('/api/outputs/job/audio');
  await entered.promise;
  assert.equal((await first).status, 200);
  late.resolve(rejected());
  assert.equal((await second).status, 200);
  assert.equal(f.sessionCalls.length, 1);
  assert.equal(f.requests.length, 4);
});

await test('user pairing or revoke started before a late 401 is not displaced', async () => {
  for (const action of ['pair', 'revoke']) {
    const apiGate = deferred();
    const apiEntered = deferred();
    const userGate = deferred();
    const userEntered = deferred();
    const f = fixture({
      respond: async () => { apiEntered.resolve(); return await apiGate.promise; },
      pair: async () => { userEntered.resolve(); return await userGate.promise; },
      revoke: async () => { userEntered.resolve(); return await userGate.promise; },
    });
    const api = f.client.request('/api/health');
    await apiEntered.promise;
    const user = action === 'pair' ? f.coordinator.startPairing() : f.coordinator.revokeSession();
    await userEntered.promise;
    apiGate.resolve(rejected());
    assert.equal((await api).status, 401);
    assert.equal(f.sessionCalls.filter(call => call.path.endsWith('/renew')).length, 0);
    userGate.resolve(action === 'pair' ? reply({ pairing_id: 'pairing-id-long-enough', expires_in_seconds: 120 }) : reply({ revoked: true }));
    const result = await user;
    if (action === 'pair') assert.equal(result.pairing_id, 'pairing-id-long-enough');
    else {
      assert.equal(result, true);
      assert.equal(f.events.at(-1), 'revoked');
      assert.deepEqual(f.store.requestHeaders(), {});
    }
    assert.equal(f.requests.length, 1);
  }
});
