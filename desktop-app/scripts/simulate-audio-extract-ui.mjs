import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/?view=minutes';
const shouldStartServer = !process.env.APP_URL;
const PAGE_GOTO_TIMEOUT_MS = 60000;

// Since 2026-10-24 (docs/design.md) the writer shows only this promise; storage wording lives in the web first-visit notice.
const LOCAL_PROMISE = '보안 걱정 NO, 외부 AI 전송 없음';
const savedAudioPath = 'C:\\Users\\User\\Downloads\\meeting-demo.wav';

const waitForApp = async (url, timeoutMs = 30000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until Vite is ready.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const getAvailablePort = async (host) => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.once('error', reject);
  server.listen(0, host, () => {
    const address = server.address();
    if (!address || typeof address === 'string') {
      server.close(() => reject(new Error('Could not allocate a local test port.')));
      return;
    }
    const { port } = address;
    server.close(() => resolve(port));
  });
});

const stopServer = async (child) => {
  if (!child || child.exitCode !== null) return;

  if (process.platform === 'win32') {
    await new Promise(resolve => {
      const killer = spawn(
        process.env.ComSpec ?? 'cmd.exe',
        ['/d', '/s', '/c', `taskkill /pid ${child.pid} /t /f`],
        { stdio: 'ignore', windowsHide: true },
      );
      killer.on('exit', resolve);
      killer.on('error', resolve);
    });
    return;
  }

  child.kill('SIGTERM');
  await Promise.race([
    new Promise(resolve => child.once('exit', resolve)),
    sleep(2000),
  ]);
};

const startServer = async () => {
  if (!shouldStartServer) {
    await waitForApp(APP_URL);
    return null;
  }

  const url = new URL(APP_URL);
  const port = await getAvailablePort(url.hostname);
  url.port = String(port);
  APP_URL = url.toString();
  const child = process.platform === 'win32'
    ? spawn(
      process.env.ComSpec ?? 'cmd.exe',
      ['/d', '/s', '/c', `corepack pnpm exec vite --host ${url.hostname} --port ${url.port} --strictPort --configLoader runner`],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, BROWSER: 'none' },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      },
    )
    : spawn(
      'corepack',
      ['pnpm', 'exec', 'vite', '--host', url.hostname, '--port', url.port, '--strictPort', '--configLoader', 'runner'],
      {
        cwd: fileURLToPath(new URL('..', import.meta.url)),
        env: { ...process.env, BROWSER: 'none' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );

  child.stdout.on('data', data => {
    if (process.env.DEBUG_FLOW_TEST) process.stdout.write(data);
  });
  child.stderr.on('data', data => {
    if (process.env.DEBUG_FLOW_TEST) process.stderr.write(data);
  });

  await waitForApp(APP_URL);
  return child;
};

const installRoutes = async (page, getPrivacySettings) => {
  await page.route('**/api/health', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ok: true }),
  }));

  await page.route('**/api/models/status', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({ ready: true, models: [] }),
  }));

  await page.route('**/api/settings', route => route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      privacy: getPrivacySettings(),
    }),
  }));

  await page.route('**/api/dev/asr-benchmarks**', route => route.fulfill({
    status: 404,
    contentType: 'application/json',
    body: JSON.stringify({ detail: 'benchmark fixtures disabled for this simulation' }),
  }));
};

const run = async () => {
  let server = null;
  let browser = null;
  let page = null;
  let extractRequests = 0;
  const privacySettings = {
    preserve_extracted_audio: true,
    auto_save_audio_copy: false,
  };

  try {
    server = await startServer();
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    await installRoutes(page, () => privacySettings);
    await page.addInitScript(() => {
      window.__openedSavedPath = null;
      window.__TAURI__ = {
        core: {
          invoke: async (command, args) => {
            if (command === 'get_backend_base_url') return window.location.origin;
            if (command === 'open_saved_file_location') {
              window.__openedSavedPath = args?.savedPath ?? null;
              return null;
            }
            return null;
          },
        },
      };
    });

    await page.route('**/api/tools/extract-audio/save-copy', async route => {
      extractRequests += 1;
      assert.equal(route.request().method(), 'POST');
      await sleep(150);
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          kind: 'audio',
          source_filename: 'meeting-demo.mp4',
          saved_path: savedAudioPath,
          size_bytes: 1024,
        }),
      });
    });

    await page.goto(APP_URL, { waitUntil: 'domcontentloaded', timeout: PAGE_GOTO_TIMEOUT_MS });
    await page.getByRole('heading', { name: '새 회의록' }).waitFor({ timeout: 10000 });
    const writerSectionHeadings = await page.locator('.writer-section-heading h3').allTextContents();
    // Meeting information is a labelled region without a visible heading since a1307b8.
    assert.equal(writerSectionHeadings[0], '영상·음성 파일');
    await page.getByRole('region', { name: '회의 정보' }).waitFor({ timeout: 10000 });
    await page.locator('.writer-local-promise').getByText(LOCAL_PROMISE, { exact: true }).waitFor({ timeout: 10000 });
    assert.equal(await page.getByRole('button', { name: '처리 방식', exact: true }).count(), 0, 'the writer has no persistent processing-help button');
    const desktopLayout = await page.evaluate(() => {
      const dropZone = document.querySelector('.file-drop-zone')?.getBoundingClientRect();
      const supportElement = document.querySelector('.writer-file-support');
      const support = supportElement?.getBoundingClientRect();
      return {
        dropZoneLeft: dropZone?.left ?? 0,
        supportLeft: support?.left ?? 0,
        supportShown: supportElement ? getComputedStyle(supportElement).display !== 'none' : false,
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    // Before a file is chosen nothing sits under the upload area (the local promise is under the title), so the slot collapses.
    assert.equal(desktopLayout.supportShown, false, 'the file guidance slot stays collapsed until there is guidance to show');
    assert.ok(desktopLayout.dropZoneLeft > 0, 'the upload control must be laid out on desktop');
    assert.ok(desktopLayout.horizontalOverflow <= 2, 'desktop writer should not overflow horizontally');

    await page.setViewportSize({ width: 800, height: 720 });
    const compactHorizontalOverflow = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ));
    assert.ok(compactHorizontalOverflow <= 2, 'compact writer should not overflow horizontally');
    await page.setViewportSize({ width: 1280, height: 900 });
    assert.equal(await page.getByRole('button', { name: '음성 추출', exact: true }).count(), 0, 'The extraction tool is not part of the current writer surface.');
    assert.equal(await page.locator('input[accept="video/*,.mp4,.mov,.mkv,.avi,.webm"]').count(), 0, 'The hidden extraction tool must not expose a separate file picker.');
    assert.equal(extractRequests, 0, 'Privacy and file-input interactions must not invoke the hidden extraction tool.');


    console.log('ok - audio extract UI simulation');
  } catch (error) {
    console.error(error);
    if (page) {
      console.error('body:', (await page.locator('body').innerText()).slice(0, 3000));
    }
    throw error;
  } finally {
    await browser?.close().catch(() => undefined);
    await stopServer(server);
  }
};

run().catch(error => {
  console.error(error);
  process.exit(1);
});
