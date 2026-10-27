import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

// One prepared frontend and one browser; no real engine, model or saved user profile.
const appUrl = process.env.APP_URL;
assert.ok(appUrl, 'Set APP_URL to a prepared project frontend. This test does not start servers.');
const output = fileURLToPath(new URL('../../.tmp/finite-request-ui-20261025/', import.meta.url));
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const results = [];
try {
  for (const scenario of ['health', 'models-error', 'settings']) {
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    try {
      await page.clock.install();
      await page.addInitScript(({ scenario, origin }) => {
        window.__TAURI__ = { core: { invoke: async command => {
          if (command === 'get_backend_base_url') return origin;
          if (command === 'get_desktop_action_token') return 'finite-ui-test-token';
          return undefined;
        } } };
        const state = { recover: false, cancellations: [], requests: [], analysisPosts: 0 };
        window.__finiteRequestTest = state;
        const originalFetch = window.fetch.bind(window);
        window.fetch = async (input, init = {}) => {
          const url = new URL(typeof input === 'string' ? input : input.url ?? input.toString(), location.href);
          if (!url.pathname.startsWith('/api/')) return originalFetch(input, init);
          const path = url.pathname;
          const method = init.method ?? 'GET';
          state.requests.push({ path, method, started: Date.now() });
          if (path === '/api/analyze' && method === 'POST') state.analysisPosts++;
          const stalls = !state.recover && (
            (scenario === 'health' && path === '/api/health')
            || (scenario === 'models-error' && path === '/api/models/status')
            || (scenario === 'settings' && path === '/api/settings')
          );
          if (stalls) {
            const started = Date.now();
            return new Response(new ReadableStream({
              cancel() { state.cancellations.push({ path, elapsed: Date.now() - started }); },
            }), { status: scenario === 'models-error' ? 500 : 200, headers: { 'Content-Type': 'application/json' } });
          }
          const payload = path === '/api/models/status'
            ? { ready: true, summary_ready: true, models: [], errors: [] }
            : path === '/api/settings'
              ? { summary: { enabled: true }, diarization: { enabled: true } }
              : { ok: true, active: false, drafts: [], statuses: [] };
          return new Response(JSON.stringify(payload), { headers: { 'Content-Type': 'application/json' } });
        };
      }, { scenario, origin: new URL(appUrl).origin });
      await page.goto(appUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
      assert.equal(await page.title(), 'LMO 회의록');
      const row = page.locator('.writer-action-row');
      await row.waitFor();
      if (scenario === 'settings') {
        await page.waitForFunction(() => document.querySelector('.writer-action-row')?.getAttribute('data-state') === 'ready');
        await page.getByRole('complementary').getByRole('button', { name: '설정' }).click();
        const dialog = page.getByRole('dialog', { name: '설정' });
        await dialog.waitFor();
        await page.clock.runFor(21_000);
        await dialog.getByText('설정을 불러오지 못했습니다.', { exact: false }).waitFor();
        const cancellations = await page.evaluate(() => window.__finiteRequestTest.cancellations);
        assert.ok(cancellations.some(item => item.path === '/api/settings' && Math.abs(item.elapsed - 20_000) <= 100));
        await page.screenshot({ path: `${output}/${scenario}-failure.png`, animations: 'disabled' });
        // The dialog remains operable while its load failed, and reopening can recover.
        await page.keyboard.press('Escape');
        await dialog.waitFor({ state: 'hidden' });
        await page.evaluate(() => { window.__finiteRequestTest.recover = true; });
        await page.getByRole('complementary').getByRole('button', { name: '설정' }).click();
        await dialog.locator('#settings-analysis-device').waitFor();
        assert.equal(await dialog.getByText('설정을 불러오지 못했습니다.', { exact: false }).count(), 0);
        await page.screenshot({ path: `${output}/${scenario}-recovered.png`, animations: 'disabled' });
      } else {
        // 45s startup grace plus bounded in-flight requests/poll intervals. This is virtual time.
        // Headers without a completed body count as no response, including a 500 response.
        const expectedState = 'no-response';
        for (let step = 0; step < 5 && await row.getAttribute('data-state') !== expectedState; step++) {
          await page.clock.runFor(20_000);
        }
        assert.equal(await row.getAttribute('data-state'), expectedState);
        await row.getByRole('button', { name: '문제해결', exact: true }).waitFor();
        const cancellations = await page.evaluate(() => window.__finiteRequestTest.cancellations);
        assert.ok(cancellations.length > 0);
        assert.ok(cancellations.every(item => Math.abs(item.elapsed - 15_000) <= 100));
        await page.screenshot({ path: `${output}/${scenario}-failure.png`, animations: 'disabled' });
        await page.evaluate(() => {
          window.__finiteRequestTest.recover = true;
          window.dispatchEvent(new Event('focus'));
        });
        await page.waitForFunction(() => document.querySelector('.writer-action-row')?.getAttribute('data-state') === 'ready');
        await page.screenshot({ path: `${output}/${scenario}-recovered.png`, animations: 'disabled' });
      }
      const state = await page.evaluate(() => window.__finiteRequestTest);
      assert.equal(state.analysisPosts, 0, 'a readiness check must not start analysis');
      assert.deepEqual(errors, [], 'no uncaught UI errors');
      results.push({ scenario, cancellations: state.cancellations, analysisPosts: state.analysisPosts, errors });
      console.log(`ok - ${scenario}: finite body timeout, usable UI and recovery`);
    } catch (error) {
      await page.screenshot({ path: `${output}/${scenario}-unexpected.png`, animations: 'disabled' }).catch(() => {});
      console.error(JSON.stringify({ scenario, rowState: await page.locator('.writer-action-row').getAttribute('data-state').catch(() => null),
        evidence: await page.evaluate(() => window.__finiteRequestTest).catch(() => null) }));
      throw error;
    } finally {
      await context.close();
    }
  }
  await writeFile(`${output}/result.json`, JSON.stringify({ appUrl, mockedEngine: true, virtualTime: true, results }, null, 2));
} finally {
  await browser.close();
}
