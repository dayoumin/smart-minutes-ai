import assert from 'node:assert/strict';
import release from './release.json' with { type: 'json' };
import handler, { parseByteRange, serveDesktopDownload } from './src/index.ts';

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
for (const previous of new Set([release.previousDownloadPath, ...release.previousDownloadPaths])) {
    for (const method of ['GET', 'HEAD']) {
        const redirect = await call(previous, { method });
        assert.equal(redirect.status, 307);
        assert.equal(redirect.headers.get('location'), release.downloadPath);
        assert.equal(redirect.headers.get('cache-control'), 'no-store');
    }
    assert.equal((await call(previous, { method: 'PUT', body: 'denied' })).status, 405);
}
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

// Desktop release metadata is a separate contract. Unpublished/missing objects never become links.
assert.equal((await call('/downloads/desktop-beta.json')).status, 404);
assert.equal((await call('/downloads/desktop-beta.json')).headers.get('access-control-allow-origin'), '*');
assert.equal((await call('/downloads/lmo_audio_update_unknown.zip')).status, 404);
const desktopPayload = {
    schemaVersion: 1, type: 'portable-update', origin: 'https://barorok.ecomarin.workers.dev',
    commit: 'd'.repeat(40), generatedAt: '2026-10-26T09:12:34.1234567+09:00',
    downloadPath: `/downloads/lmo_audio_update_${'d'.repeat(40)}.zip`, bytes: 32, sha256: 'e'.repeat(64),
};
const desktopCall = (path, init, publication = { release: desktopPayload }) => serveDesktopDownload(
    new Request(`https://barorok.ecomarin.workers.dev${path}`, init), env, publication,
);
const feedPath = '/downloads/desktop-beta.json';
assert.equal((await desktopCall(feedPath)).status, 503, 'object hash must match before advertising a release');
assert.equal((await desktopCall(feedPath)).headers.get('access-control-allow-origin'), '*');
assert.equal((await desktopCall(feedPath, { method: 'POST' })).status, 405);
metadata.customMetadata.sha256 = desktopPayload.sha256;
const desktopFeed = await desktopCall(feedPath);
assert.equal(desktopFeed.status, 200);
assert.equal(desktopFeed.headers.get('cache-control'), 'no-store');
assert.equal(desktopFeed.headers.get('access-control-allow-origin'), '*');
assert.deepEqual(await desktopFeed.json(), desktopPayload);
assert.equal(await (await desktopCall(feedPath, { method: 'HEAD' })).text(), '');
assert.equal((await desktopCall('/downloads/wrong.zip')).status, 404);
assert.equal((await desktopCall(feedPath, undefined, { release: { ...desktopPayload, downloadPath: '/downloads/setup.exe' } })).status, 503);
const desktopFull = await desktopCall(desktopPayload.downloadPath);
assert.equal(desktopFull.status, 200);
assert.match(desktopFull.headers.get('content-disposition'), /\.zip/);
assert.deepEqual(Buffer.from(await desktopFull.arrayBuffer()), data);
const desktopPartial = await desktopCall(desktopPayload.downloadPath, { headers: { Range: 'bytes=8-15' } });
assert.equal(desktopPartial.status, 206);
assert.equal(desktopPartial.headers.get('content-range'), 'bytes 8-15/32');
assert.deepEqual(Buffer.from(await desktopPartial.arrayBuffer()), data.subarray(8, 16));
assert.equal((await desktopCall(desktopPayload.downloadPath, { method: 'HEAD' })).headers.get('content-length'), '32');
metadata.size = 31;
assert.equal((await desktopCall(feedPath)).status, 503);
assert.equal((await desktopCall(desktopPayload.downloadPath)).status, 503);
env.RELEASES.head = async () => null;
assert.equal((await desktopCall(feedPath)).status, 503);
env.RELEASES.head = async () => { throw new Error('R2 unavailable'); };
assert.equal((await desktopCall(feedPath)).status, 503);
console.log('Download HTTP/range/metadata checks passed');
