import assert from 'node:assert/strict';
import { test } from 'node:test';
import { beginSettingsUpdateActivity, checkBackendUpdateActivity } from '../src/updateActivity.ts';

test('an active backend download is detected after Settings closes', async () => {
  const result = await checkBackendUpdateActivity({ request: async (path, init) => {
    assert.equal(path, '/api/update-activity');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.bufferJson, true);
    assert.equal(init.timeoutMs, 5000);
    return Response.json({ busy: true });
  } });
  assert.equal(result.busy, true);
  assert.equal(result.verified, true);
});

test('idle backend is verified; older engines, failures and malformed replies stay unknown', async () => {
  assert.deepEqual(await checkBackendUpdateActivity({ request: async () => Response.json({ busy: false }) }), { busy: false, verified: true });
  for (const response of [new Response('', { status: 404 }), new Response('', { status: 401 }), Response.json({ busy: 'false' }), Response.json(null)]) {
    const result = await checkBackendUpdateActivity({ request: async () => response });
    assert.equal(result.verified, false);
  }
  assert.equal((await checkBackendUpdateActivity({ request: async () => { throw new Error('offline'); } })).verified, false);
});

test('overlapping settings requests remain active until both finish, even after dialog closure', () => {
  const originalWindow = globalThis.window;
  const target = new EventTarget();
  const states = [];
  globalThis.window = target;
  target.addEventListener('backend-task:state', event => states.push(event.detail));
  try {
    const finishSave = beginSettingsUpdateActivity();
    const finishRestart = beginSettingsUpdateActivity();
    finishSave();
    finishSave();
    assert.equal(states.at(-1).active, true);
    finishRestart();
    assert.deepEqual(states.at(-1), { source: 'settings-requests', active: false });
    assert.equal(states.length, 4);
  } finally {
    if (originalWindow === undefined) delete globalThis.window;
    else globalThis.window = originalWindow;
  }
});
