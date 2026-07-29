import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const shouldStartServer = !process.env.APP_URL;
const PAGE_GOTO_TIMEOUT_MS = 60000;
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
  let privacySettings = {
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
    assert.deepEqual(writerSectionHeadings.slice(0, 2), ['영상·음성 파일 *', '회의 정보']);
    await page.getByText('분석용 음성을 회의록과 함께 보관합니다.', { exact: true }).waitFor({ timeout: 10000 });
    const desktopLayout = await page.evaluate(() => {
      const dropZone = document.querySelector('.file-drop-zone')?.getBoundingClientRect();
      const support = document.querySelector('.writer-file-support')?.getBoundingClientRect();
      return {
        dropZoneLeft: dropZone?.left ?? 0,
        supportLeft: support?.left ?? 0,
        horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    });
    assert.ok(Math.abs(desktopLayout.dropZoneLeft - desktopLayout.supportLeft) <= 2, 'file guidance should stay aligned with the upload control on desktop');
    assert.ok(desktopLayout.horizontalOverflow <= 2, 'desktop writer should not overflow horizontally');

    await page.setViewportSize({ width: 800, height: 720 });
    const compactHorizontalOverflow = await page.evaluate(() => (
      document.documentElement.scrollWidth - document.documentElement.clientWidth
    ));
    assert.ok(compactHorizontalOverflow <= 2, 'compact writer should not overflow horizontally');
    await page.setViewportSize({ width: 1280, height: 900 });
    privacySettings = {
      preserve_extracted_audio: true,
      auto_save_audio_copy: true,
    };
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    const autoSavePrivacyMessage = '분석용 음성을 회의록과 함께 보관하고 다운로드 폴더에도 사본을 저장합니다.';
    await page.getByText(autoSavePrivacyMessage, { exact: true }).waitFor({ timeout: 10000 });

    await page.unroute('**/api/settings');
    let releaseStaleSettings = () => {};
    const staleSettingsCanFinish = new Promise(resolve => {
      releaseStaleSettings = resolve;
    });
    let markStaleSettingsRequested = () => {};
    const staleSettingsRequested = new Promise(resolve => {
      markStaleSettingsRequested = resolve;
    });
    let markStaleSettingsFulfilled = () => {};
    const staleSettingsFulfilled = new Promise(resolve => {
      markStaleSettingsFulfilled = resolve;
    });
    let settingsRequestCount = 0;
    await page.route('**/api/settings', async route => {
      settingsRequestCount += 1;
      if (settingsRequestCount === 1) {
        markStaleSettingsRequested();
        await staleSettingsCanFinish;
        const staleResponse = await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            privacy: { preserve_extracted_audio: true, auto_save_audio_copy: true },
          }),
        });
        markStaleSettingsFulfilled();
        return staleResponse;
      }
      if (settingsRequestCount === 2) {
        return route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            privacy: { preserve_extracted_audio: false, auto_save_audio_copy: false },
          }),
        });
      }
      return route.fulfill({
        status: 503,
        contentType: 'application/json',
        body: JSON.stringify({ detail: 'settings unavailable' }),
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await staleSettingsRequested;
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await page.getByText('분석용 임시 음성은 완료 후 삭제됩니다.', { exact: true }).waitFor({ timeout: 10000 });
    const staleSettingsResponseFinished = page.waitForResponse(response => (
      response.url().endsWith('/api/settings') && response.status() === 200
    )).then(response => response.finished());
    releaseStaleSettings();
    await staleSettingsFulfilled;
    await staleSettingsResponseFinished;
    await page.evaluate(() => new Promise(resolve => {
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve));
    }));
    assert.equal(await page.getByText(autoSavePrivacyMessage, { exact: true }).count(), 0, 'a stale settings response must not replace the latest privacy message');
    await page.evaluate(() => window.dispatchEvent(new Event('analysis:settings-updated')));
    await page.locator('.writer-file-privacy-note').waitFor({ state: 'hidden', timeout: 10000 });
    await page.getByRole('button', { name: '음성 추출', exact: true }).waitFor({ timeout: 10000 });

    await page.locator('input[accept="video/*,.mp4,.mov,.mkv,.avi,.webm"]').setInputFiles({
      name: 'meeting-demo.mp4',
      mimeType: 'video/mp4',
      buffer: Buffer.from('fake video bytes'),
    });

    await page.getByText('영상 선택됨').waitFor({ timeout: 10000 });
    await page.getByText('저장을 누르면 선택한 영상의 WAV 사본을 다운로드 폴더에 저장합니다.').waitFor({ timeout: 10000 });

    const saveButton = page.getByRole('button', { name: '저장', exact: true });
    await saveButton.waitFor({ timeout: 10000 });
    await saveButton.click();

    await page.getByText('음성 추출 중').waitFor({ timeout: 10000 });
    await page.getByText('음성 추출 완료').waitFor({ timeout: 10000 });
    await page.getByText(/다운로드 폴더에 WAV 파일을 저장했습니다/).waitFor({ timeout: 10000 });
    await page.getByRole('button', { name: '폴더 열기' }).click();

    const openedPath = await page.evaluate(() => window.__openedSavedPath);
    assert.equal(openedPath, savedAudioPath);
    assert.equal(extractRequests, 1);

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
