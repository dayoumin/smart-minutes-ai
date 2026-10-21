import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fetchLocalEngineRelease, isNewerEngineVersion, parseLocalEngineRelease } from '../src/localEngineRelease.ts';
import { applyLocalEngineProbe, createInitialLocalEngineConnection } from '../src/localEngineConnection.ts';
import { getLocalEngineConnectionView } from '../src/localEngineConnectionView.ts';
import { selectWriterStatusRow } from '../src/writerStatusRow.ts';

const origin = 'https://barorok.ecomarin.workers.dev';
const manifest = {
  engineVersion: '0.1.10-beta-20261021', origin,
  downloadPath: '/downloads/Barorok-Local-Engine-Setup-0.1.10-beta-20261021.exe',
  bytes: 442841356, sha256: 'dca637330e3f010d346b9d60ea426e50fb59cab304266c3ef026b776a9979f6b',
};
const release = parseLocalEngineRelease(manifest, origin);

test('compares numeric versions, prereleases and build metadata without downgrading', () => {
  for (const [latest, installed, expected] of [
    ['0.1.10-beta-20261021', '0.1.9-beta-20261020', true],
    ['0.1.10-beta-20261021', '0.1.10-beta-20261021', false],
    ['0.1.10-beta-20261021', '0.1.11-beta-20261022', false],
    ['0.1.10', '0.1.10-beta-20261021', true],
    ['0.1.10-beta-20261021', '0.1.10', false],
    ['1.0.0-beta.10', '1.0.0-beta.9', true],
    ['1.0.0-beta.2', '1.0.0-beta.10', false],
    ['1.0.0-beta.1', '1.0.0-beta', true],
    ['1.0.0-beta', '1.0.0-2', true],
    ['1.0.0+new', '1.0.0+old', false],
    ['0.1.10', 'unknown', false],
    ['0.1.10', '0.01.9', false],
    ['1.0.0-01', '1.0.0-beta', false],
  ]) assert.equal(isNewerEngineVersion(latest, installed), expected, `${installed} → ${latest}`);
});

test('only a prepared installer on this website can become an update link', () => {
  assert.deepEqual(release, { version: manifest.engineVersion, downloadUrl: origin + manifest.downloadPath });
  for (const change of [
    { origin: 'https://other.example' }, { engineVersion: 'bad' }, { bytes: 0 }, { sha256: 'bad' },
    { downloadPath: 'https://other.example/setup.exe' }, { downloadPath: '//other.example/setup.exe' },
    { downloadPath: '/downloads/../setup.exe' }, { downloadPath: '/downloads/setup.exe?token=x' },
  ]) assert.equal(parseLocalEngineRelease({ ...manifest, ...change }, origin), null);
});

test('metadata requests omit credentials, bypass caches and tolerate errors, invalid JSON and cancellation', async t => {
  const fetchMock = t.mock.method(globalThis, 'fetch', async (url, init) => {
    assert.equal(String(url), `${origin}/downloads/engine-beta.json`);
    assert.equal(init.credentials, 'omit');
    assert.equal(init.cache, 'no-store');
    assert.equal(init.redirect, 'error');
    return Response.json(manifest);
  });
  assert.deepEqual(await fetchLocalEngineRelease(origin), release);
  fetchMock.mock.mockImplementation(async () => new Response('unavailable', { status: 503 }));
  assert.equal(await fetchLocalEngineRelease(origin), null);
  fetchMock.mock.mockImplementation(async () => new Response('<html>not metadata</html>'));
  assert.equal(await fetchLocalEngineRelease(origin), null);
  fetchMock.mock.mockImplementation(async () => { throw new TypeError('offline'); });
  assert.equal(await fetchLocalEngineRelease(origin), null);
  fetchMock.mock.mockImplementation(async (_url, { signal }) => {
    signal.throwIfAborted();
    return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
  });
  const controller = new AbortController();
  const pending = fetchLocalEngineRelease(origin, controller.signal);
  controller.abort();
  assert.equal(await pending, null);
  assert.equal(await fetchLocalEngineRelease(origin, controller.signal), null);
});

test('old compatible installs get an advisory while connection, model and input blockers keep priority', () => {
  const snapshot = applyLocalEngineProbe({ ...createInitialLocalEngineConnection('web-local-engine'),
    authorization: 'authenticated', capabilities: new Set(['analysis']) }, {
    product_id: 'barorok-local-engine', engine_version: '0.1.9-beta-20261020', api_contract_version: 1,
    capabilities: ['analysis'], auth_state: 'pairing-required', pairing_available: true, update_required: false,
  });
  assert.equal(snapshot.engineVersion, '0.1.9-beta-20261020');
  const viewInput = { snapshot, pairingPhase: 'idle', connectionStarted: true, latestRelease: release, updateAvailable: true };
  const connection = getLocalEngineConnectionView(viewInput);
  assert.equal(connection.scene, 'update-available');
  assert.equal(connection.analysisReady, true);
  const rowInput = { connection, readinessState: 'ready', readinessMessage: '', missingModels: [],
    diarizationDuringAnalysis: false, gpuUnavailable: false, installerAvailable: true,
    canOpenModelSettings: true, canOpenAnalysisSettings: true };
  const row = selectWriterStatusRow(rowInput);
  assert.equal(row.state, 'update-available');
  assert.equal(row.blocksStart, false);
  assert.deepEqual(row.actions.map(action => action.kind), ['probe', 'update']);
  assert.equal(selectWriterStatusRow({ ...rowInput, readinessState: 'missing-models',
    missingModels: [{ key: 'stt_faster_whisper', label: '음성 인식', downloadable: true }] }).state, 'models-missing');
  assert.equal(selectWriterStatusRow({ ...rowInput, input: { missingRequired: ['음성 파일'] } }).state, 'required-fields');
  assert.equal(selectWriterStatusRow({ ...rowInput, input: { otherAnalysisRunning: true } }).state, 'other-analysis');
  assert.equal(getLocalEngineConnectionView({ ...viewInput, latestRelease: null }).scene, 'connected');
  const oldUnpaired = getLocalEngineConnectionView({ ...viewInput, snapshot: { ...snapshot, authorization: 'unpaired' } });
  assert.equal(oldUnpaired.scene, 'update-available', 'old engines can update even before browser connection');
  assert.equal(oldUnpaired.analysisReady, false);
  assert.equal(getLocalEngineConnectionView({ ...viewInput, snapshot: { ...snapshot, engineVersion: release.version } }).scene, 'connected');
  assert.equal(getLocalEngineConnectionView({ ...viewInput, snapshot: { ...snapshot, updateRequired: true } }).scene, 'update-required');
  assert.equal(getLocalEngineConnectionView({ ...viewInput, snapshot: { ...snapshot, transport: 'unreachable', blockedBy: 'browser-permission' } }).scene, 'browser-blocked');
});
