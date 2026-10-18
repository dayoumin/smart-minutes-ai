import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { createLocalEngineClient } from '../src/localEngineClientCore.ts';

const src = new URL('../src/', import.meta.url);
const sourceFiles = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const url = new URL(entry.name + (entry.isDirectory() ? '/' : ''), directory);
  return entry.isDirectory() ? sourceFiles(url) : /\.[cm]?[jt]sx?$/.test(entry.name) ? [url] : [];
});
const memberName = expression => ts.isIdentifier(expression) ? expression.text
  : ts.isPropertyAccessExpression(expression) ? expression.name.text
    : ts.isElementAccessExpression(expression) && ts.isStringLiteral(expression.argumentExpression)
      ? expression.argumentExpression.text : '';

await test('all frontend HTTP transports stay within the three explicit boundaries', () => {
  const allowed = new Map([
    ['apiBase.ts', 1], // Native startup only; cannot resolve through its own common client.
    ['localEngineClient.ts', 1], // The native fetch adapter.
    ['localEngineClientCore.ts', 1], // The injected common transport.
  ]);
  const found = new Map();
  const files = [...sourceFiles(src), new URL('../public/local-audio-worker.js', import.meta.url)];
  for (const file of files) {
    const name = file.href.startsWith(src.href) ? file.href.slice(src.href.length) : 'local-audio-worker.js';
    const tree = ts.createSourceFile(name, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const visit = node => {
      if (ts.isCallExpression(node) && memberName(node.expression) === 'fetch') {
        assert.ok(allowed.has(name), `${name}: direct fetch bypasses common authorization`);
        found.set(name, (found.get(name) ?? 0) + 1);
      }
      if (ts.isNewExpression(node) && ['EventSource', 'WebSocket', 'XMLHttpRequest'].includes(memberName(node.expression))) {
        assert.fail(`${name}: new transport needs an explicit authentication boundary`);
      }
      ts.forEachChild(node, visit);
    };
    visit(tree);
  }
  assert.deepEqual([...found].sort(), [...allowed].sort());
});

const compile = source => ts.transpileModule(source, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
}).outputText;
const apiBaseSource = readFileSync(new URL('../src/apiBase.ts', import.meta.url), 'utf8');
// isTauri/getInvoke let a test attach the native bridge late; onTimeout counts every sleep.
const createApiBase = ({ tauri = true, invoke, fetch, env = {}, isTauri = () => tauri, getInvoke = () => invoke, onTimeout = () => {} }) => {
  const exports = {};
  runInNewContext(compile(apiBaseSource.replaceAll('import.meta.env', `(${JSON.stringify(env)})`)), {
    exports, URL, AbortController,
    window: { setTimeout: callback => { onTimeout(); return setTimeout(callback, 1); }, clearTimeout },
    require: path => {
      assert.equal(path, './runtimeEnvironment');
      return {
        getRuntimeEnvironment: () => ({ kind: isTauri() ? 'tauri-desktop' : 'web-local-engine' }),
        getTauriInvoke: getInvoke,
      };
    },
    fetch,
  });
  return exports;
};

await test('native restart polls only its returned base with the desktop token, caching token reads', async () => {
  const calls = [];
  let tokenReads = 0;
  const api = createApiBase({
    invoke: async command => {
      if (command === 'restart_backend') return 'http://127.0.0.1:18011';
      if (command === 'get_desktop_action_token') { tokenReads++; return 'fake-desktop-token'; }
      if (command === 'write_frontend_log') return;
      assert.fail(`Unexpected native command: ${command}`);
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      const authorized = new Headers(init.headers).get('X-LMO-Desktop-Action-Token') === 'fake-desktop-token';
      return new Response(null, { status: authorized ? (calls.length === 1 ? 503 : 200) : 401 });
    },
  });
  assert.equal(await api.restartDesktopBackend(), 'http://127.0.0.1:18011');
  assert.equal(tokenReads, 1);
  assert.equal(calls.length, 2);
  for (const { url, init } of calls) {
    assert.equal(url, 'http://127.0.0.1:18011/api/health');
    assert.equal(init.cache, 'no-store');
    assert.equal(new Headers(init.headers).get('Authorization'), null);
  }
  assert.equal(await api.getApiBase(), 'http://127.0.0.1:18011');
  assert.equal(calls.length, 2);
});

await test('legacy port discovery never requests or forwards desktop credentials', async () => {
  const calls = [];
  const api = createApiBase({
    invoke: async command => {
      if (command === 'get_backend_base_url') return '';
      if (command === 'write_frontend_log') return;
      assert.fail(`Discovery must not read a credential: ${command}`);
    },
    fetch: async (url, init) => {
      calls.push({ url: String(url), headers: new Headers(init.headers) });
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(await api.getApiBase(), 'http://127.0.0.1:17863');
  assert.ok(calls.length > 0);
  for (const { url, headers } of calls) {
    assert.equal(url, 'http://127.0.0.1:17863/api/health');
    assert.equal([...headers].length, 0);
  }
  const discoveryRequests = calls.length;
  assert.equal(await api.getApiBase(), 'http://127.0.0.1:17863');
  assert.equal(calls.length, discoveryRequests, 'a discovered base is final, so discovery must not repeat');
});

await test('missing native credentials cannot turn an authenticated restart failure into ready', async () => {
  let requests = 0;
  const api = createApiBase({
    invoke: async command => {
      if (command === 'restart_backend') return 'http://127.0.0.1:18011';
      if (command === 'get_desktop_action_token') throw new Error('Native credential unavailable');
      assert.fail(`Unexpected native command: ${command}`);
    },
    fetch: async (_url, init) => {
      requests++;
      assert.equal([...new Headers(init.headers)].length, 0);
      return new Response(null, { status: 401 });
    },
  });
  await assert.rejects(api.restartDesktopBackend(), /아직 응답하지 않습니다/);
  assert.equal(requests, 30);
});

await test('ordinary web base resolution neither scans ports nor invokes native restart', async () => {
  const api = createApiBase({ tauri: false, fetch: async () => assert.fail('Web bootstrap must not scan ports') });
  assert.equal(await api.getApiBase(), 'http://127.0.0.1:17863');
  await assert.rejects(api.restartDesktopBackend(), /데스크탑 앱에서만/);
});

await test('web base resolution never waits for a native bridge, even when configured to the default address', async () => {
  for (const env of [{}, { VITE_API_BASE_URL: 'http://127.0.0.1:17863' }, { VITE_API_BASE_URL: 'http://127.0.0.1:18100' }]) {
    let sleeps = 0;
    let bridgeLookups = 0;
    const api = createApiBase({
      tauri: false,
      env,
      getInvoke: () => { bridgeLookups++; return undefined; },
      onTimeout: () => { sleeps++; },
      fetch: async () => assert.fail('Web bootstrap must not scan ports'),
    });
    const expected = env.VITE_API_BASE_URL ?? 'http://127.0.0.1:17863';
    assert.equal(await api.getApiBase(), expected);
    assert.deepEqual(await Promise.all([api.getApiBase(), api.getApiBase(), api.getApiBase()]), [expected, expected, expected]);
    assert.equal(await api.getApiBase(), expected);
    assert.equal(sleeps, 0, `no request may wait (${JSON.stringify(env)})`);
    assert.equal(bridgeLookups, 0, `the web build must not poll the native bridge (${JSON.stringify(env)})`);
  }
});

await test('a desktop base answered by native code is asked and logged once, even on the default port', async () => {
  const commands = [];
  const api = createApiBase({
    invoke: async command => {
      commands.push(command);
      if (command === 'get_backend_base_url') return 'http://127.0.0.1:17863';
      if (command === 'write_frontend_log') return;
      assert.fail(`Unexpected native command: ${command}`);
    },
    fetch: async () => assert.fail('A native answer must not trigger port discovery'),
  });
  const base = 'http://127.0.0.1:17863';
  assert.deepEqual(await Promise.all([api.getApiBase(), api.getApiBase(), api.getApiBase()]), [base, base, base]);
  for (let call = 0; call < 5; call++) assert.equal(await api.getApiBase(), base);
  assert.deepEqual(commands, ['get_backend_base_url', 'write_frontend_log']);
});

await test('an unanswered desktop guess keeps asking until native code answers, then stops', async () => {
  let bridge;
  const asked = [];
  const api = createApiBase({
    getInvoke: () => bridge,
    fetch: async () => { throw new TypeError('connection refused'); },
  });
  assert.equal(await api.getApiBase(), 'http://127.0.0.1:17863');
  bridge = async command => {
    asked.push(command);
    if (command === 'get_backend_base_url') return 'http://127.0.0.1:18200';
    if (command === 'write_frontend_log') return;
    assert.fail(`Unexpected native command: ${command}`);
  };
  assert.equal(await api.getApiBase(), 'http://127.0.0.1:18200');
  assert.equal(await api.getApiBase(), 'http://127.0.0.1:18200');
  assert.deepEqual(asked, ['get_backend_base_url', 'write_frontend_log']);
});

await test('a base resolved as web is replaced once the native bridge appears', async () => {
  let tauri = false;
  const api = createApiBase({
    isTauri: () => tauri,
    getInvoke: () => (tauri ? async command => (command === 'get_backend_base_url' ? 'http://127.0.0.1:18300' : undefined) : undefined),
    fetch: async () => assert.fail('Neither runtime should scan ports here'),
  });
  assert.equal(await api.getApiBase(), 'http://127.0.0.1:17863');
  tauri = true;
  assert.equal(await api.getApiBase(), 'http://127.0.0.1:18300');
});

await test('the real development seed helper uses authenticated requests and preserves encoded IDs', async () => {
  const appSource = readFileSync(new URL('../src/App.tsx', import.meta.url), 'utf8');
  const tree = ts.createSourceFile('App.tsx', appSource, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const statement = tree.statements.find(node => ts.isVariableStatement(node)
    && node.declarationList.declarations.some(item => ts.isIdentifier(item.name) && item.name.text === 'fetchBenchmarkPayload'));
  assert.ok(statement, 'The actual seed helper must be tested, not a duplicate implementation');
  const calls = [];
  const client = createLocalEngineClient({
    resolveBaseUrl: async () => 'http://127.0.0.1:17863',
    resolveRequestHeaders: async () => ({ Authorization: 'Bearer fake-benchmark-session' }),
    fetch: async (url, init) => {
      calls.push({ url: String(url), init });
      return calls.length === 1 ? Response.json({ payload: { preview: 'test transcript' } }) : new Response(null, { status: 403 });
    },
  });
  const exports = {};
  runInNewContext(compile(statement.getText(tree) + '\nexport { fetchBenchmarkPayload };'), { exports, localEngineClient: client });
  const id = 'asr_benchmark/a report.json';
  assert.equal((await exports.fetchBenchmarkPayload(id)).preview, 'test transcript');
  assert.equal(calls[0].url, 'http://127.0.0.1:17863/api/dev/asr-benchmarks/' + encodeURIComponent(id));
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), 'Bearer fake-benchmark-session');
  assert.equal(calls[0].init.cache, 'no-store');
  await assert.rejects(exports.fetchBenchmarkPayload(id), /Failed to load benchmark/);
});
