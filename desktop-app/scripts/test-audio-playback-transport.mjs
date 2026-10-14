import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { MessageChannel } from 'node:worker_threads';
import { AUDIO_PLAYBACK_PROTOCOL as protocol, parseAudioPlaybackRequest, audioPlaybackHeaders, abortableAudioBody } from '../src/audioPlaybackTransport.ts';

const leaseId = 'aabbccdd-1122-3344-5566-778899aabbcc';
await test('only scoped leases, GET/HEAD and single byte ranges are accepted', () => {
  const valid = { protocol, leaseId, method: 'GET', range: 'bytes=2-5' };
  assert.deepEqual(parseAudioPlaybackRequest({ ...valid, url: 'https://evil.example' }), valid);
  for (const patch of [{ method: 'POST' }, { leaseId: '../secret' }, { protocol: 'wrong' }, { range: 'bytes=0-1,4-5' }, { range: 'bytes=0-1\r\nX: bad' }]) {
    assert.equal(parseAudioPlaybackRequest({ ...valid, ...patch }), null);
  }
});
await test('only audio response metadata is exposed, never credentials or cookies', () => {
  const headers = audioPlaybackHeaders(new Headers({
    'Content-Range': 'bytes 2-5/10', 'Content-Length': '4', 'Content-Type': 'audio/wav',
    Authorization: 'Bearer test-secret', 'Set-Cookie': 'secret=value', 'Cache-Control': 'public',
  }));
  assert.deepEqual(headers, { 'Cache-Control': 'no-store', 'Content-Type': 'audio/wav', 'Content-Length': '4', 'Content-Range': 'bytes 2-5/10' });
});
await test('first bytes are delivered without waiting for the complete audio', async () => {
  let producer;
  let canceled = 0;
  let settled = 0;
  const source = new ReadableStream({
    start(controller) { producer = controller; controller.enqueue(new Uint8Array([1])); },
    cancel() { canceled += 1; },
  });
  const reader = abortableAudioBody(source, new AbortController().signal, () => { settled += 1; }).getReader();
  assert.deepEqual([...(await reader.read()).value], [1]);
  assert.equal(settled, 0);
  producer.enqueue(new Uint8Array([2]));
  assert.deepEqual([...(await reader.read()).value], [2]);
  await reader.cancel();
  assert.equal(canceled, 1);
  assert.equal(settled, 1);
});
await test('lease abort after response headers cancels the underlying body', async () => {
  let canceled = 0;
  let settled = 0;
  const source = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); }, cancel() { canceled += 1; } });
  const controller = new AbortController();
  const reader = abortableAudioBody(source, controller.signal, () => { settled += 1; }).getReader();
  await reader.read();
  const pending = assert.rejects(reader.read(), error => error?.name === 'AbortError');
  controller.abort();
  await pending;
  await Promise.resolve();
  assert.equal(canceled, 1);
  assert.equal(settled, 1);
});
await test('normal end and source errors settle once', async () => {
  for (const failure of [false, true]) {
    let settled = 0;
    const source = new ReadableStream({ start(controller) { if (failure) controller.error(new Error('source failed')); else controller.close(); } });
    const body = abortableAudioBody(source, new AbortController().signal, () => { settled += 1; });
    if (failure) await assert.rejects(new Response(body).text(), /source failed/);
    else assert.equal(await new Response(body).text(), '');
    assert.equal(settled, 1);
  }
});
const workerSource = readFileSync(new URL('../public/local-audio-worker.js', import.meta.url), 'utf8');
const worker = ({ foreign = false, responseStatus = 206, responseBody = true } = {}) => {
  const handlers = new Map();
  const requests = [];
  const self = {
    registration: { scope: 'https://web.example/' }, location: { origin: 'https://web.example' },
    skipWaiting: async () => {},
    clients: { claim: async () => {}, get: async () => ({
      type: 'window', url: foreign ? 'https://other.example/' : 'https://web.example/',
      postMessage(data, ports) {
        requests.push(data);
        const body = responseBody ? new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([2, 3, 4, 5])); controller.close(); } }) : null;
        ports[0].postMessage({ protocol, status: responseStatus, headers: { 'Content-Range': responseStatus === 416 ? 'bytes */10' : 'bytes 2-5/10', 'Content-Type': 'audio/wav', Authorization: 'must-not-forward' }, body }, body ? [body] : []);
        ports[0].close();
      },
    }) },
    addEventListener: (name, handler) => handlers.set(name, handler),
  };
  runInNewContext(workerSource, { self, URL, Request, Response, Headers, ReadableStream, MessageChannel, setTimeout, clearTimeout });
  const dispatch = (path = '/__lmo_audio__/' + leaseId, method = 'GET', range = 'bytes=2-5', clientId = 'owner') => {
    let result;
    handlers.get('fetch')({ request: new Request('https://web.example' + path, { method, headers: range ? { Range: range } : {} }), clientId, respondWith: promise => { result = promise; } });
    return result;
  };
  return { requests, dispatch };
};
await test('worker preserves Range status and stream, and strips unrelated headers', async () => {
  const f = worker();
  const response = await f.dispatch();
  assert.equal(response.status, 206);
  assert.equal(response.headers.get('Content-Range'), 'bytes 2-5/10');
  assert.equal(response.headers.get('Authorization'), null);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
  assert.deepEqual([...new Uint8Array(await response.arrayBuffer())], [2, 3, 4, 5]);
  assert.equal(f.requests[0].range, 'bytes=2-5');
  assert.deepEqual(Object.keys(f.requests[0]).sort(), ['leaseId', 'method', 'protocol', 'range']);
});
await test('worker HEAD has no body and ordinary app requests are not intercepted', async () => {
  const f = worker({ responseStatus: 200, responseBody: false });
  assert.equal(await (await f.dispatch(undefined, 'HEAD')).text(), '');
  assert.equal(f.dispatch('/api/health'), undefined);
  assert.equal(f.dispatch('/'), undefined);
});
await test('worker denies unowned clients, invalid leases, methods and ranges', async () => {
  assert.equal((await worker({ foreign: true }).dispatch()).status, 403);
  assert.equal((await worker().dispatch(undefined, 'GET', null, '')).status, 403);
  assert.equal((await worker().dispatch('/__lmo_audio__/invalid')).status, 404);
  assert.equal((await worker().dispatch(undefined, 'POST')).status, 405);
  assert.equal((await worker().dispatch(undefined, 'GET', 'bytes=0-1,4-5')).status, 416);
});
await test('worker preserves unsatisfiable range metadata', async () => {
  const f = worker({ responseStatus: 416, responseBody: false });
  const response = await f.dispatch();
  assert.equal(response.status, 416);
  assert.equal(response.headers.get('Content-Range'), 'bytes */10');
});
