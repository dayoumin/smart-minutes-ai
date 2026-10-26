import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DESKTOP_RELEASE_ORIGIN, fetchDesktopRelease, isNewerDesktopRelease, parseDesktopRelease, parseDesktopReleaseIdentity } from '../src/desktopRelease.ts';

const current = { commit: 'a'.repeat(40), generatedAt: '2026-10-25T09:12:34.1234567+09:00' };
const metadata = {
    schemaVersion: 1, type: 'portable-update', origin: DESKTOP_RELEASE_ORIGIN,
    commit: 'b'.repeat(40), generatedAt: '2026-10-26T09:12:34.1234567+09:00',
    downloadPath: `/downloads/lmo_audio_update_${'b'.repeat(40)}.zip`, bytes: 12345, sha256: 'c'.repeat(64),
};

test('desktop identities use portable build timestamps and commits, never the Tauri placeholder version', () => {
    assert.deepEqual(parseDesktopReleaseIdentity(current), current);
    assert.equal(isNewerDesktopRelease(metadata, current), true);
    for (const installed of [null, {}, { commit: '0.1.0', generatedAt: current.generatedAt }, { ...current, generatedAt: 'unknown' }]) {
        assert.equal(isNewerDesktopRelease(metadata, installed), false);
    }
    assert.equal(isNewerDesktopRelease(metadata, metadata), false);
    assert.equal(isNewerDesktopRelease({ ...metadata, commit: current.commit }, current), false);
    assert.equal(isNewerDesktopRelease({ ...metadata, generatedAt: current.generatedAt }, current), false);
    assert.equal(isNewerDesktopRelease(current, metadata), false);
    assert.equal(isNewerDesktopRelease({ ...metadata, generatedAt: '2026-10-25T00:12:34.123Z' }, current), false);
    for (const generatedAt of ['2026-02-30T00:00:00Z', '2026-10-26', '2026-10-26T24:00:00Z', '2026-10-26T00:00:00', 'junk']) {
        assert.equal(parseDesktopReleaseIdentity({ ...current, generatedAt }), null);
    }
});

test('desktop update links require the fixed public origin and full-commit ZIP contract', () => {
    assert.deepEqual(parseDesktopRelease(metadata), {
        commit: metadata.commit, generatedAt: metadata.generatedAt, bytes: metadata.bytes, sha256: metadata.sha256,
        downloadUrl: DESKTOP_RELEASE_ORIGIN + metadata.downloadPath,
    });
    for (const change of [
        { type: 'engine' }, { schemaVersion: 2 }, { origin: 'https://other.example' },
        { downloadPath: '/downloads/setup.exe' }, { downloadPath: `/downloads/lmo_audio_update_${'a'.repeat(40)}.zip` },
        { downloadPath: metadata.downloadPath + '?token=x' }, { downloadPath: '//other.example/update.zip' },
        { bytes: 0 }, { bytes: Number.MAX_SAFE_INTEGER + 1 }, { sha256: 'invalid' }, { commit: 'b'.repeat(7) },
    ]) assert.equal(parseDesktopRelease({ ...metadata, ...change }), null);
});

test('desktop metadata requests are anonymous, cancellable and fail quietly when unpublished or offline', async t => {
    const mock = t.mock.method(globalThis, 'fetch', async (url, init) => {
        assert.equal(String(url), `${DESKTOP_RELEASE_ORIGIN}/downloads/desktop-beta.json`);
        assert.equal(init.credentials, 'omit');
        assert.equal(init.cache, 'no-store');
        assert.equal(init.redirect, 'error');
        assert.equal(init.referrerPolicy, 'no-referrer');
        return Response.json(metadata);
    });
    assert.deepEqual(await fetchDesktopRelease(), parseDesktopRelease(metadata));
    for (const status of [404, 503]) {
        mock.mock.mockImplementation(async () => new Response('unpublished', { status }));
        assert.equal(await fetchDesktopRelease(), null);
    }
    mock.mock.mockImplementation(async () => new Response('<html>not metadata</html>'));
    assert.equal(await fetchDesktopRelease(), null);
    mock.mock.mockImplementation(async () => { throw new TypeError('offline'); });
    assert.equal(await fetchDesktopRelease(), null);
    mock.mock.mockImplementation(async (_url, { signal }) => {
        signal.throwIfAborted();
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const controller = new AbortController();
    const pending = fetchDesktopRelease(controller.signal);
    controller.abort();
    assert.equal(await pending, null);
    assert.equal(await fetchDesktopRelease(controller.signal), null);
});
