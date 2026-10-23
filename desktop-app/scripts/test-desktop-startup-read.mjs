import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readWithDesktopStartupRecovery } from '../src/desktopStartupRead.ts';
import { createLocalEngineClient } from '../src/localEngineClientCore.ts';

const options = (extra = {}) => ({ desktop: true, signal: new AbortController().signal, retryDelayMs: 1, timeoutMs: 3000, ...extra });

test('native startup network and per-request timeout failures recover', async () => {
  let calls = 0;
  const result = await readWithDesktopStartupRecovery(async () => {
    calls++;
    if (calls === 1) throw new TypeError('connection refused');
    if (calls === 2) throw new DOMException('request timed out', 'AbortError');
    return 'ready';
  }, options());
  assert.equal(result, 'ready');
  assert.equal(calls, 3);
});

test('browser network failure remains one request', async () => {
  let calls = 0;
  await assert.rejects(readWithDesktopStartupRecovery(async () => {
    calls++; throw new TypeError('blocked');
  }, options({ desktop: false })), TypeError);
  assert.equal(calls, 1);
});

test('HTTP 401, 403 and 404 responses are never retried', async () => {
  for (const status of [401, 403, 404]) {
    let calls = 0;
    const result = await readWithDesktopStartupRecovery(async () => {
      calls++; return new Response(null, { status });
    }, options());
    assert.equal(result.status, status);
    assert.equal(calls, 1);
  }
});

test('invalid payload and model-not-ready answers do not poll', async () => {
  let calls = 0;
  await assert.rejects(readWithDesktopStartupRecovery(async () => {
    calls++; throw new SyntaxError('invalid JSON');
  }, options()), SyntaxError);
  assert.equal(calls, 1);
  assert.deepEqual(await readWithDesktopStartupRecovery(async () => ({ summary_ready: false }), options()), { summary_ready: false });
});

test('leaving cancels an in-flight read and prevents later publication', async () => {
  const owner = new AbortController();
  let finish;
  const result = readWithDesktopStartupRecovery(async () => new Promise(resolve => { finish = resolve; }), options({ signal: owner.signal }));
  await Promise.resolve();
  owner.abort();
  await assert.rejects(result, { name: 'AbortError' });
  finish('stale');
});

test('total deadline cancels retry waiting instead of retrying forever', async () => {
  let calls = 0;
  await assert.rejects(readWithDesktopStartupRecovery(async () => {
    calls++; throw new TypeError('offline');
  }, options({ timeoutMs: 20, retryDelayMs: 1000 })), { name: 'AbortError' });
  assert.equal(calls, 1);
});

test('already cancelled owner sends no request', async () => {
  const owner = new AbortController(); owner.abort();
  await assert.rejects(readWithDesktopStartupRecovery(async () => assert.fail('sent request'), options({ signal: owner.signal })), { name: 'AbortError' });
});

test('deadline settles even a read that ignores its cancellation signal', async () => {
  await assert.rejects(readWithDesktopStartupRecovery(() => new Promise(() => {}), options({ timeoutMs: 20 })), { name: 'AbortError' });
});

test('finite model JSON cancels a stalled body at the deadline', async () => {
  let cancelled = false;
  const client = createLocalEngineClient({
    resolveBaseUrl: async () => 'http://127.0.0.1:17864',
    resolveRequestHeaders: async () => ({ 'X-LMO-Desktop-Action-Token': 'test-token' }),
    fetch: async (_url, init) => {
      assert.equal('bufferJson' in init, false);
      return new Response(new ReadableStream({ cancel() { cancelled = true; } }), { headers: { 'Content-Type': 'application/json' } });
    },
  });
  await assert.rejects(client.request('/api/models/status', { timeoutMs: 20, bufferJson: true }), { name: 'AbortError' });
  assert.equal(cancelled, true);
});

test('metadata authentication rejection is returned before a stalled error body', async () => {
  const client = createLocalEngineClient({
    resolveBaseUrl: async () => 'http://127.0.0.1:17864',
    resolveRequestHeaders: async () => ({ 'X-LMO-Desktop-Action-Token': 'test-token' }),
    fetch: async () => new Response(new ReadableStream({}), { status: 401 }),
  });
  const response = await client.request('/api/models/status', { timeoutMs: 20, bufferJson: true });
  assert.equal(response.status, 401);
  await response.body.cancel();
});

test('explicit transient readiness answers recover within the same budget', async () => {
  let calls = 0;
  const result = await readWithDesktopStartupRecovery(async () => ({ ready: ++calls > 2 }), options({ retryResult: result => !result.ready }));
  assert.equal(result.ready, true);
  assert.equal(calls, 3);
});

test('pending readiness returns its last answer at deadline but not after caller cancellation', async () => {
  const pending = { ready: false, reason: 'runtime_preparing' };
  const result = await readWithDesktopStartupRecovery(async () => pending, options({ retryResult: () => true, timeoutMs: 20, retryDelayMs: 1000 }));
  assert.equal(result, pending);
  const owner = new AbortController();
  const aborted = readWithDesktopStartupRecovery(async () => pending, options({ signal: owner.signal, retryResult: () => true }));
  await new Promise(resolve => setTimeout(resolve, 1)); owner.abort();
  await assert.rejects(aborted, { name: 'AbortError' });
});
