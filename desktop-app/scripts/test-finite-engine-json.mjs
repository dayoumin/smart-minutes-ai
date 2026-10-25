import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalEngineClient, requestFiniteEngineJson } from '../src/localEngineClientCore.ts';

const finiteClient = fetch => createLocalEngineClient({
  resolveBaseUrl: async () => 'http://127.0.0.1:17864',
  resolveRequestHeaders: async () => ({ 'X-LMO-Desktop-Action-Token': 'test-token' }),
  fetch,
});

test('preparation and settings deadlines include stalled success and error bodies without replay', async () => {
  for (const path of ['/api/health', '/api/models/status', '/api/settings', '/api/analyze/preflight']) {
    for (const status of [200, 500]) {
      let cancelled = false;
      let calls = 0;
      const client = finiteClient(async () => {
        calls++;
        return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status });
      });
      await assert.rejects(requestFiniteEngineJson(client, path, { method: path.endsWith('preflight') ? 'POST' : 'GET' }, 20), { name: 'TimeoutError' });
      assert.equal(cancelled, true, `${path} ${status} reader cancelled`);
      assert.equal(calls, 1, 'a finite request is never replayed on a body timeout');
    }
  }
});

test('finite metadata cancellation interrupts a body read and already cancelled callers send nothing', async () => {
  for (const status of [200, 500]) {
    const owner = new AbortController();
    let cancelled = false;
    let reading;
    const started = new Promise(resolve => { reading = resolve; });
    const client = finiteClient(async () => {
      const body = new ReadableStream({ cancel() { cancelled = true; } });
      const getReader = body.getReader.bind(body);
      body.getReader = (...args) => { const reader = getReader(...args); reading(); return reader; };
      return new Response(body, { status });
    });
    const pending = requestFiniteEngineJson(client, '/api/models/status', { signal: owner.signal }, 3000);
    await started;
    owner.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(cancelled, true);
  }
  const owner = new AbortController(); owner.abort();
  await assert.rejects(requestFiniteEngineJson({ request: async () => assert.fail('sent request') }, '/api/settings', { signal: owner.signal }), { name: 'AbortError' });
});

test('finite metadata authorization rejection returns status and headers without a stalled body', async () => {
  for (const status of [401, 403]) {
    let cancelled = false;
    const client = finiteClient(async () => new Response(new ReadableStream({ cancel() { cancelled = true; } }), {
      status, headers: { 'WWW-Authenticate': 'Bearer', 'X-Request-Id': 'finite-auth' },
    }));
    const response = await requestFiniteEngineJson(client, '/api/models/status', {}, 3000);
    assert.equal(response.status, status);
    assert.equal(response.headers.get('X-Request-Id'), 'finite-auth');
    assert.equal(response.headers.get('WWW-Authenticate'), 'Bearer');
    assert.equal(await response.text(), '');
    assert.equal(cancelled, true);
  }
});

test('finite metadata preserves successful JSON and non-auth error details', async () => {
  for (const status of [200, 400, 404, 500]) {
    const client = finiteClient(async () => new Response(JSON.stringify({ detail: 'model unavailable' }), {
      status, headers: { 'Content-Type': 'application/json' },
    }));
    const response = await requestFiniteEngineJson(client, '/api/models/status', {}, 3000);
    assert.equal(response.status, status);
    assert.deepEqual(await response.json(), { detail: 'model unavailable' });
  }
});

test('stream requests still return headers without buffering their bodies', async () => {
  const client = finiteClient(async () => new Response(new ReadableStream({}), { headers: { 'Content-Type': 'text/event-stream' } }));
  const response = await client.stream('/api/analyze', { method: 'POST', timeoutMs: 20 });
  assert.equal(response.headers.get('Content-Type'), 'text/event-stream');
  await response.body.cancel();
});
