import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import http from 'node:http';

const app = process.env.APP_URL;
assert.ok(app, 'Set APP_URL to the caller-owned Vite server.');
const upstream = new URL(app).origin;
const artifact = { failure: false, requests: 0 };
// Chromium handles a[download] outside Playwright's page routing. Serve real HTTP responses.
const server = http.createServer((request, response) => {
    if (request.url === '/downloads/engine-test.exe') {
        artifact.requests++;
        response.writeHead(artifact.failure ? 503 : 200, artifact.failure
            ? { 'Content-Type': 'text/html' }
            : { 'Content-Type': 'application/octet-stream', 'Content-Disposition': 'attachment; filename="test.exe"' });
        response.end(artifact.failure ? 'Artifact unavailable' : 'test installer fixture');
        return;
    }
    const proxy = http.request(new URL(request.url, upstream), { method: request.method, headers: request.headers }, incoming => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
    });
    proxy.on('error', () => { response.writeHead(502); response.end(); });
    request.pipe(proxy);
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const fixture = `${origin}/scripts/fixtures/update-guide.html`;
const releaseOrigin = 'https://barorok.ecomarin.workers.dev';
const installed = { commit: 'a'.repeat(40), generatedAt: '2026-10-25T01:00:00Z' };
const latest = { schemaVersion: 1, type: 'portable-update', origin: releaseOrigin,
    commit: 'b'.repeat(40), generatedAt: '2026-10-26T01:00:00Z',
    downloadPath: `/downloads/lmo_audio_update_${'b'.repeat(40)}.zip`, bytes: 123, sha256: 'c'.repeat(64) };
const browser = await chromium.launch({ headless: true });
const output = process.env.QA_OUTPUT_DIR;
if (output) await mkdir(output, { recursive: true });
try {
    for (const desktop of [false, true]) {
        const page = await browser.newPage({ viewport: { width: 1100, height: 850 } });
        const errors = [];
        let backendBusy = false;
        let unknown = false;
        let unavailable = false;
        let requests = 0;
        artifact.requests = 0;
        artifact.failure = false;
        const downloadEvents = [];
        page.on('download', item => downloadEvents.push(item.url()));
        let hold = false;
        let releaseCheck;
        let gate;
        page.on('pageerror', error => errors.push(error.message));
        if (desktop) await page.addInitScript(({ origin, installed }) => {
            window.__downloads = [];
            window.__TAURI__ = { core: { invoke: async (command, args) => {
                if (command === 'get_backend_base_url') return origin;
                if (command === 'get_desktop_release_identity') return installed;
                if (command === 'get_desktop_action_token') return 'test-update-token';
                if (command === 'open_external_url') {
                    if (window.__failDownload) throw new Error('Browser action failed');
                    window.__downloads.push(args.url);
                }
                return null;
            } } };
        }, { origin, installed });
        await page.route('**/downloads/desktop-beta.json', route => route.fulfill({ status: unavailable ? 503 : 200,
            headers: { 'Access-Control-Allow-Origin': '*' }, contentType: 'application/json', body: JSON.stringify(latest) }));
        await page.route('**/api/**', async route => {
            if (new URL(route.request().url()).pathname === '/api/update-activity') {
                requests++;
                if (hold) await gate;
                return route.fulfill({ status: unknown ? 404 : 200, contentType: 'application/json', body: JSON.stringify({ busy: backendBusy }) });
            }
            return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ ok: true }) });
        });
        await page.goto(fixture, { waitUntil: 'networkidle' });
        assert.equal(await page.title(), 'LMO 업데이트 안내 검증');
        const entry = page.getByRole('button', { name: '새 업데이트 안내', exact: true });
        await entry.waitFor();
        const entryBox = await entry.boundingBox();
        const countDownloads = () => desktop ? page.evaluate(() => window.__downloads.length) : artifact.requests;
        assert.equal(await countDownloads(), 0, 'metadata checks never download');
        await entry.click();
        const dialog = page.getByRole('dialog');
        const receive = dialog.getByRole('button', { name: desktop ? '업데이트 패키지 받기' : '설치 파일 받기', exact: true });
        await receive.waitFor();
        await until(() => receive.isEnabled());
        assert.equal(await countDownloads(), 0, 'opening guidance never downloads');
        assert.equal(await page.locator('[inert]').count(), 1);
        if (!desktop) {
            // Home regression: expire during an in-flight preflight without closing the guide.
            hold = true; gate = new Promise(resolve => { releaseCheck = resolve; });
            const beforeExpiry = requests;
            await receive.click();
            await until(async () => requests > beforeExpiry);
            await page.evaluate(() => window.setUpdateAuthorization('expired'));
            await dialog.getByRole('checkbox').waitFor();
            assert.equal(await dialog.getByRole('checkbox').isChecked(), false);
            assert.equal(await receive.isDisabled(), true, 'expired sessions recover to explicit unknown-state confirmation');
            const afterExpiry = requests;
            await dialog.getByRole('checkbox').check();
            assert.equal(await receive.isEnabled(), true, 'the aborted checking flag must no longer lock recovery');
            hold = false; releaseCheck();
            await page.waitForTimeout(100);
            assert.equal(requests, afterExpiry, 'expiration must not start another loopback status request');
            assert.equal(await countDownloads(), 0, 'an expired preflight cannot reuse its old click');
            await page.evaluate(() => window.setUpdateAuthorization('authenticated'));
            await until(async () => requests > afterExpiry && await receive.isEnabled());
            // Also clear a previous busy result, then verify reconnection observes real work again.
            backendBusy = true;
            await receive.click();
            await dialog.getByText('진행 중인 작업이 있습니다. 작업이 끝난 뒤 다시 눌러 주세요.', { exact: true }).waitFor();
            await page.evaluate(() => window.setUpdateAuthorization('expired'));
            await dialog.getByRole('checkbox').waitFor();
            assert.equal(await dialog.getByText('작업이 끝난 뒤 다운로드할 수 있습니다', { exact: true }).count(), 0);
            assert.equal(await dialog.getByRole('checkbox').isChecked(), false, 'a connection change revokes the earlier confirmation');
            await page.evaluate(() => window.setUpdateAuthorization('authenticated'));
            await dialog.getByText('작업이 끝난 뒤 다운로드할 수 있습니다', { exact: true }).waitFor();
            assert.equal(await receive.isDisabled(), true, 'reconnection still blocks a known active backend');
            await page.keyboard.press('Escape');
            backendBusy = false;
            await entry.click();
            await until(() => receive.isEnabled());
        }
        // Existing work begins while the guide remains open; finishing it never downloads.
        await page.evaluate(() => window.setUpdateBusy(true));
        await until(() => receive.isDisabled());
        await dialog.getByText('작업이 끝난 뒤 다운로드할 수 있습니다', { exact: true }).waitFor();
        await page.evaluate(() => window.setUpdateBusy(false));
        await until(() => receive.isEnabled());
        assert.equal(await countDownloads(), 0);
        // A background task invisible to this window is checked again at the explicit click.
        backendBusy = true;
        await receive.click();
        await dialog.getByText('진행 중인 작업이 있습니다. 작업이 끝난 뒤 다시 눌러 주세요.', { exact: true }).waitFor();
        assert.equal(await countDownloads(), 0);
        await page.keyboard.press('Escape');
        backendBusy = false;
        await entry.click();
        await until(() => receive.isEnabled());
        // A task starting during the preflight also prevents navigation.
        hold = true; gate = new Promise(resolve => { releaseCheck = resolve; });
        const previousRequests = requests;
        await receive.click();
        await until(async () => requests > previousRequests);
        await page.evaluate(() => window.setUpdateBusy(true));
        hold = false; releaseCheck();
        await dialog.getByText('진행 중인 작업이 있습니다. 작업이 끝난 뒤 다시 눌러 주세요.', { exact: true }).waitFor();
        assert.equal(await countDownloads(), 0);
        await page.keyboard.press('Escape');
        await page.evaluate(() => window.setUpdateBusy(false));
        // Older/offline engines require an explicit all-windows check, and still recheck on click.
        unknown = true;
        await entry.click();
        await dialog.getByRole('checkbox').waitFor();
        assert.equal(await receive.isDisabled(), true);
        await dialog.getByRole('checkbox').check();
        await until(() => receive.isEnabled());
        // Closing and reopening a guide cancels the old click and its old confirmation.
        hold = true; gate = new Promise(resolve => { releaseCheck = resolve; });
        const beforeCancelled = requests;
        await receive.click();
        await until(async () => requests > beforeCancelled);
        assert.equal(await dialog.getByRole('checkbox').isDisabled(), true);
        await page.keyboard.press('Escape');
        await entry.click();
        hold = false; releaseCheck();
        await dialog.getByRole('checkbox').waitFor();
        assert.equal(await dialog.getByRole('checkbox').isChecked(), false);
        assert.equal(await countDownloads(), 0, 'a cancelled earlier click cannot download into the reopened guide');
        assert.equal(await receive.isDisabled(), true);
        await dialog.getByRole('checkbox').check();
        await until(() => receive.isEnabled());
        if (output) await page.screenshot({ path: `${output}/${desktop ? 'desktop' : 'web'}-update-guide.png` });
        await receive.click();
        try { await until(async () => await countDownloads() === 1); }
        catch (error) {
            console.error({ desktop, downloads: artifact.requests, downloadEvents, requests, guide: await dialog.innerText(),
                pages: page.context().pages().map(item => item.url()) });
            throw error;
        }
        await dialog.getByRole('button', { name: '다운로드 요청됨', exact: true }).waitFor();
        assert.equal(await countDownloads(), 1);
        await page.keyboard.press('Escape');
        await until(async () => await entry.evaluate(el => el === document.activeElement));
        assert.deepEqual(await entry.boundingBox(), entryBox, 'guidance does not shift the work surface');
        // A failed artifact/native browser action must preserve the meeting tab and allow recovery.
        await entry.click();
        await dialog.getByRole('checkbox').check();
        if (desktop) {
            await page.evaluate(() => { window.__failDownload = true; });
            await receive.click();
            await dialog.getByText('다운로드를 열지 못했습니다. 잠시 후 다시 눌러 주세요.', { exact: true }).waitFor();
            assert.equal(await countDownloads(), 1);
            await page.evaluate(() => { window.__failDownload = false; });
        } else {
            artifact.failure = true;
            await receive.click();
            await until(async () => artifact.requests === 2);
            assert.equal(page.url(), fixture, 'HTTP503 must never replace the meeting tab');
            assert.equal(await page.getByRole('textbox', { name: '작성 중인 내용', exact: true }).inputValue(), '저장 전 내용 유지');
        }
        await page.keyboard.press('Escape');
        if (!desktop) {
            await page.evaluate(() => window.setUpdateRequired(true));
            await entry.click();
            await dialog.getByText('새 분석을 시작하려면 업데이트가 필요합니다.', { exact: true }).waitFor();
            await page.keyboard.press('Escape');
            await page.getByRole('button', { name: '설치 안내', exact: true }).click();
            await dialog.getByRole('heading', { name: /설치$/ }).waitFor();
            assert.equal(await countDownloads(), 2, 'first-install guidance also waits for a receive click');
            await page.keyboard.press('Escape');
        } else {
            unavailable = true;
            await entry.click();
            await dialog.getByRole('button', { name: '다시 확인', exact: true }).click();
            await dialog.getByText('지금은 공개된 업데이트 정보를 확인할 수 없습니다. 현재 앱은 계속 사용할 수 있습니다.', { exact: true }).waitFor();
            assert.equal(await dialog.getByRole('button', { name: '업데이트 패키지 받기', exact: true }).isDisabled(), true);
        }
        assert.deepEqual(errors, []);
        await page.close();
        console.log(`ok - ${desktop ? 'desktop' : 'web'} explicit guidance, busy/race/unknown/download/focus/layout scenarios`);
    }
} finally {
    await browser.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}

async function until(check) {
    const end = Date.now() + 15_000;
    while (Date.now() < end) { if (await check()) return; await new Promise(resolve => setTimeout(resolve, 50)); }
    assert.fail('Expected update-guide condition did not become true');
}
