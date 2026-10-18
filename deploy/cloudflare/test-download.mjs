import assert from 'node:assert/strict';
import release from './release.json' with { type: 'json' };
import handler, { parseByteRange } from './src/index.ts';

assert.deepEqual(parseByteRange('bytes=0-7', 32), { offset: 0, length: 8 });
assert.deepEqual(parseByteRange('bytes=8-', 32), { offset: 8, length: 24 });
assert.deepEqual(parseByteRange('bytes=-8', 32), { offset: 24, length: 8 });
assert.deepEqual(parseByteRange('bytes=0-999', 32), { offset: 0, length: 32 });
for (const value of ['bytes=32-', 'bytes=-0', 'bytes=9-2', 'bytes=0-1,4-5', 'bytes=-', 'bytes=9007199254740992-', 'other=0-1']) {
    assert.equal(parseByteRange(value, 32), null);
}
assert.equal(parseByteRange('bytes=-8', 0), null);

// Exercise HTTP behavior with a real stream and a small R2 response fixture.
release.bytes = 32;
release.sha256 = 'a'.repeat(64);
const data = Buffer.alloc(32, 7);
let calls = 0;
const metadata = { size: data.length, customMetadata: { sha256: release.sha256 } };
const env = {
    ASSETS: { fetch: async () => new Response('app') },
    RELEASES: {
        head: async () => { calls++; return metadata; },
        get: async (_key, options) => {
            calls++;
            const range = options?.range;
            return { ...metadata, body: new Response(range ? data.subarray(range.offset, range.offset + range.length) : data).body };
        },
    },
};
const call = (path, init) => handler.fetch(new Request(`https://barorok.ecomarin.workers.dev${path}`, init), env);
assert.equal(await (await call('/')).text(), 'app');
assert.equal((await call('/downloads/unknown.exe')).status, 404);
assert.equal((await call(release.downloadPath, { method: 'POST' })).status, 405);
assert.equal(calls, 0);
const full = await call(release.downloadPath);
assert.equal(full.status, 200);
assert.equal(full.headers.get('content-length'), '32');
assert.match(full.headers.get('content-disposition'), /attachment/);
assert.deepEqual(Buffer.from(await full.arrayBuffer()), data);
const partial = await call(release.downloadPath, { headers: { Range: 'bytes=8-15' } });
assert.equal(partial.status, 206);
assert.equal(partial.headers.get('content-range'), 'bytes 8-15/32');
assert.deepEqual(Buffer.from(await partial.arrayBuffer()), data.subarray(8, 16));
const unsatisfiable = await call(release.downloadPath, { headers: { Range: 'bytes=32-' } });
assert.equal(unsatisfiable.status, 416);
assert.equal(unsatisfiable.headers.get('content-range'), 'bytes */32');
assert.equal((await call(release.downloadPath, { headers: { Range: 'bytes=8-', 'If-Range': 'old' } })).status, 200);
const head = await call(release.downloadPath, { method: 'HEAD', headers: { Range: 'bytes=8-' } });
assert.equal(head.status, 200);
assert.equal(await head.text(), '');
assert.equal(head.headers.get('content-length'), '32');
assert.equal((await call(release.downloadPath, { headers: { 'If-None-Match': full.headers.get('etag') } })).status, 304);
assert.equal((await (await call('/downloads/engine-beta.json')).json()).signed, false);
metadata.customMetadata.sha256 = 'b'.repeat(64);
assert.equal((await call(release.downloadPath)).status, 503);
console.log('Download HTTP/range/metadata checks passed');
