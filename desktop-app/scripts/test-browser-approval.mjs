import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createLocalEngineClient } from '../src/localEngineClientCore.ts';
import { LocalEngineConnectionCoordinator } from '../src/localEngineConnectionCoordinator.ts';
import { LocalEngineBrowserCredentialStore } from '../src/localEngineBrowserCredential.ts';
import { LocalEngineSessionCredentialStore, parseLocalEnginePairingStart, parseLocalEngineSessionCredential } from '../src/localEngineSession.ts';

const reply = (data, status = 200) => new Response(JSON.stringify(data), { status });
const grant = () => ({ session_token: 'test-short-session-token-long-enough', expires_at: 300, capabilities: ['analysis'] });
const challenge = () => ({ pairing_id: 'test-browser-connection-challenge', expires_in_seconds: 120, mode: 'browser-connection' });
const storage = () => {
    const data = new Map();
    return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
};
const fixture = (respond, saved = storage(), probe = { pairing_available: true }) => {
    const calls = [];
    const states = [];
    const credentials = new LocalEngineSessionCredentialStore(() => 100);
    const browser = new LocalEngineBrowserCredentialStore(() => saved);
    const client = createLocalEngineClient({
        resolveBaseUrl: async () => 'http://127.0.0.1:17863',
        resolveRequestHeaders: async () => credentials.requestHeaders(),
        fetch: async (input, init) => {
            const path = new URL(input).pathname;
            const body = init.body ? JSON.parse(init.body) : null;
            calls.push({ path, body, authorization: new Headers(init.headers).get('Authorization'), signal: init.signal });
            if (path === '/api/probe') return reply(probe);
            if (path === '/api/pair/forget') return reply({ revoked: true });
            return respond(path, body);
        },
    });
    const coordinator = new LocalEngineConnectionCoordinator(client, credentials, {
        onProbe: () => {}, onTransport: () => {}, onAuthorization: value => states.push(value),
        onPairingState: value => states.push(value.phase),
    }, { probe: value => value, pairingStart: parseLocalEnginePairingStart, sessionCredential: parseLocalEngineSessionCredential }, undefined, browser);
    return { coordinator, credentials, browser, calls, states, saved };
};

const requestTimeouts = context => {
    let now = Date.now();
    let nextId = 0;
    const timers = new Map();
    context.mock.method(Date, 'now', () => now);
    context.mock.method(globalThis, 'setTimeout', (callback, milliseconds, ...args) => {
        const id = ++nextId;
        timers.set(id, { callback: () => callback(...args), milliseconds });
        return id;
    });
    context.mock.method(globalThis, 'clearTimeout', id => { timers.delete(id); });
    return {
        expireOnly(milliseconds) {
            assert.equal(timers.size, 1, 'only the outstanding request owns a timeout');
            const [id, timer] = timers.entries().next().value;
            assert.equal(timer.milliseconds, milliseconds);
            timers.delete(id);
            now += milliseconds;
            timer.callback();
        },
        pending: () => timers.size,
    };
};

test('native approval has no numeric step and a returning browser restores without another approval', async () => {
    const first = fixture(path => path === '/api/pair/start' ? reply(challenge()) : reply(grant()));
    await first.coordinator.startBrowserApproval();
    assert.ok(first.states.includes('awaiting-approval'));
    assert.ok(!first.states.includes('awaiting-code'));
    assert.match(first.browser.current(), /^[A-Za-z0-9_-]{43}$/);
    assert.equal(first.calls[0].body.browser_token, first.browser.current());
    assert.equal(first.credentials.current().capabilities[0], 'analysis');
    const second = fixture(path => {
        assert.equal(path, '/api/pair/restore');
        return reply(grant());
    }, first.saved);
    await second.coordinator.probe();
    assert.ok(second.states.includes('authenticated'));
    assert.ok(!second.calls.some(call => call.path === '/api/pair/start'));
    for (const call of first.calls.concat(second.calls)) assert.equal(call.authorization, null);
});

test('the installed engine connects on discovery without a code or native confirmation', async () => {
    const f = fixture(path => path === '/api/pair/start' ? reply(challenge()) : reply(grant()), storage(), {
        pairing_available: true, pairing_mode: 'browser-connection',
    });
    await f.coordinator.probe();
    assert.ok(f.credentials.current());
    assert.ok(!f.states.includes('awaiting-code'));
    await f.coordinator.revokeSession();
    const starts = f.calls.filter(call => call.path === '/api/pair/start').length;
    await f.coordinator.probe();
    assert.equal(f.calls.filter(call => call.path === '/api/pair/start').length, starts);
    assert.equal(f.credentials.current(), null, 'explicit disconnect is respected');
});

test('waiting polls stay pending until Windows consent arrives', async () => {
    let polls = 0;
    const f = fixture(path => path === '/api/pair/start' ? reply(challenge()) : ++polls === 1 ? reply({ pending: true }, 202) : reply(grant()));
    await f.coordinator.startBrowserApproval();
    assert.equal(polls, 2);
    assert.ok(f.browser.current());
});

test('denial leaves no remembered browser and clears the pending request', async () => {
    const f = fixture(path => path === '/api/pair/start' ? reply(challenge()) : reply({}, 403));
    await assert.rejects(f.coordinator.startBrowserApproval(), /연결/);
    assert.equal(f.browser.current(), null);
    assert.equal(f.credentials.current(), null);
    assert.equal(f.calls.at(-1).path, '/api/pair/forget');
});

test('old engines produce an update instruction instead of a code input flow', async () => {
    const f = fixture(() => reply({ pairing_id: 'old-engine-challenge-id', expires_in_seconds: 120 }));
    await assert.rejects(f.coordinator.startBrowserApproval(), /업데이트/);
    assert.ok(!f.states.includes('awaiting-code'));
});

test('a temporary outage preserves approval and does not open another native prompt', async () => {
    const f = fixture(() => reply({}, 503));
    f.browser.replace('b'.repeat(43));
    await assert.rejects(f.coordinator.startBrowserApproval());
    assert.equal(f.browser.current(), 'b'.repeat(43));
    assert.ok(!f.calls.some(call => call.path === '/api/pair/start'));
});

test('disconnect forgets durable approval even with no unexpired API session', async () => {
    const f = fixture(() => assert.fail('Unexpected route'));
    f.browser.replace('b'.repeat(43));
    assert.equal(await f.coordinator.revokeSession(), true);
    assert.equal(f.browser.current(), null);
    assert.equal(f.coordinator.shouldRestoreBrowser(), false);
    assert.ok(f.states.includes('revoked'));
});

test('blocked storage keeps the current connection revocable after renewal', async () => {
    const f = fixture(path => path === '/api/pair/start' ? reply(challenge()) : reply(grant()), {
        getItem: () => null, setItem: () => { throw new Error('Storage blocked'); }, removeItem: () => { throw new Error('Storage blocked'); },
    });
    await f.coordinator.startBrowserApproval();
    const token = f.browser.current();
    assert.ok(token);
    await f.coordinator.renewSession();
    await f.coordinator.revokeSession();
    assert.equal(f.calls.at(-1).path, '/api/pair/forget');
    assert.equal(f.calls.at(-1).body.browser_token, token);
    assert.equal(f.browser.current(), null);
    assert.equal(f.coordinator.shouldReconnectBrowser(), false);
});

test('engine restart recovers an invalid short session using remembered approval', async () => {
    const f = fixture(path => path === '/api/session/renew' ? reply({}, 401) : reply(grant()));
    f.browser.replace('b'.repeat(43));
    f.credentials.replace(grant());
    assert.equal(await f.coordinator.renewSession(), true);
    assert.ok(f.states.includes('authenticated'));
    assert.ok(!f.calls.some(call => call.path === '/api/pair/start'));
});

test('disconnect during approval prevents a late response from reconnecting and cancels its server grant', async () => {
    let completeResponse;
    let started;
    const pending = new Promise(resolve => { started = resolve; });
    const f = fixture(path => {
        if (path === '/api/pair/start') return reply(challenge());
        started();
        return new Promise(resolve => { completeResponse = resolve; });
    });
    const operation = f.coordinator.startBrowserApproval();
    await pending;
    await f.coordinator.revokeSession();
    completeResponse(reply(grant()));
    await operation;
    assert.equal(f.browser.current(), null);
    assert.equal(f.credentials.current(), null);
    const cancelled = f.calls.find(call => call.path === '/api/pair/forget');
    assert.equal(cancelled.body.browser_token, f.calls[0].body.browser_token);
});

for (const { stage, expiresIn, timeoutMs } of [
    { stage: 'restore', expiresIn: 120, timeoutMs: 15000 },
    { stage: 'start', expiresIn: 120, timeoutMs: 15000 },
    { stage: 'complete', expiresIn: 120, timeoutMs: 15000 },
    { stage: 'complete', expiresIn: 2, timeoutMs: 2000 },
]) {
    test(`an unanswered ${stage} request expires after ${timeoutMs}ms and can reconnect`, async context => {
        const timeouts = requestTimeouts(context);
        let stall = true;
        let requestStarted;
        const outstanding = new Promise(resolve => { requestStarted = resolve; });
        const pathToStall = `/api/pair/${stage}`;
        const f = fixture(path => {
            if (stall && path === pathToStall) {
                requestStarted();
                // The real client must cancel even when fetch never settles itself.
                return new Promise(() => {});
            }
            return path === '/api/pair/start'
                ? reply({ ...challenge(), expires_in_seconds: expiresIn })
                : reply(grant());
        }, storage(), { pairing_available: true, pairing_mode: 'browser-connection' });
        if (stage === 'restore') f.browser.replace('b'.repeat(43));
        const operation = f.coordinator.startBrowserApproval();
        const rejected = assert.rejects(operation, error => error instanceof DOMException && error.name === 'AbortError');
        await outstanding;
        assert.equal(f.coordinator.shouldReconnectBrowser(), false, 'the approval owns the pending intent');
        const stalledRequest = f.calls.find(call => call.path === pathToStall);
        assert.equal(stalledRequest.signal.aborted, false);
        timeouts.expireOnly(timeoutMs);
        await rejected;

        assert.equal(stalledRequest.signal.aborted, true, 'the timeout cancels the actual fetch signal');
        assert.equal(f.credentials.current(), null);
        assert.equal(f.coordinator.shouldReconnectBrowser(), true, 'finally releases the pending intent');
        assert.equal(timeouts.pending(), 0, 'request and cleanup timers are released');
        if (stage === 'restore') {
            assert.equal(f.browser.current(), 'b'.repeat(43), 'temporary failure preserves existing approval');
            assert.ok(!f.calls.some(call => call.path === '/api/pair/start' || call.path === '/api/pair/forget'));
        } else {
            const started = f.calls.find(call => call.path === '/api/pair/start');
            const forgotten = f.calls.find(call => call.path === '/api/pair/forget');
            assert.equal(forgotten.body.browser_token, started.body.browser_token, 'the abandoned browser grant is revoked');
            assert.equal(f.browser.current(), null);
        }

        stall = false;
        await f.coordinator.probe();
        assert.ok(f.credentials.current(), 'a later discovery completes the connection');
        assert.ok(f.browser.current());
        assert.equal(f.coordinator.shouldReconnectBrowser(), false);
        assert.equal(timeouts.pending(), 0);
    });
}
