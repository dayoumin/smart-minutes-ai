import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFile, mkdir, stat, writeFile } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

// Use this project's browser cache before importing Playwright.
process.env.PLAYWRIGHT_BROWSERS_PATH ??= fileURLToPath(new URL('../../.cache/ms-playwright', import.meta.url));
const { chromium } = await import('playwright');
const root = fileURLToPath(new URL('../storybook-static', import.meta.url));
const output = process.env.QA_OUTPUT_DIR ?? fileURLToPath(new URL('../../.tmp/storybook-check', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.woff2': 'font/woff2', '.svg': 'image/svg+xml', '.png': 'image/png' };
await stat(resolve(root, 'index.json')); // Run storybook:build first; never reuse another session's server.
await mkdir(output, { recursive: true });
const server = createServer(async (req, res) => {
    try {
        const pathname = decodeURIComponent(new URL(req.url, 'http://127.0.0.1').pathname);
        const path = resolve(root, `.${pathname === '/' ? '/index.html' : pathname}`);
        if (!path.startsWith(root + sep)) { res.writeHead(403).end(); return; }
        const body = await readFile(path);
        res.writeHead(200, { 'Content-Type': types[extname(path)] ?? 'application/octet-stream' }).end(body);
    } catch { res.writeHead(404).end(); }
});
let browser;
const results = [];
const layouts = [];
try {
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    const origin = `http://127.0.0.1:${server.address().port}`;
    const index = await (await fetch(`${origin}/index.json`)).json();
    const required = ['common-button--primary', 'common-feedback--recovery', 'common-progress--beginning', 'common-icon-action--download-action',
        ...['ready', 'missing', 'downloading', 'paused', 'failed', 'runtime-missing', 'loading', 'normalization-off', 'paginated'].map(name => `settings-screen--${name}`)];
    for (const id of required) assert.ok(index.entries[id], `registered story: ${id}`);
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
    const escaped = [];
    await context.route('**/*', route => {
        const url = new URL(route.request().url());
        if (url.origin !== origin || url.pathname.startsWith('/api/')) {
            escaped.push(url.href);
            return route.abort(); // A broken fixture still cannot contact the real engine.
        }
        return route.continue();
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const visit = async id => {
        await page.goto(`${origin}/iframe.html?id=${id}&viewMode=story`, { waitUntil: 'domcontentloaded', timeout: 60000 });
        await page.locator('#storybook-root').waitFor();
    };
    const measure = () => page.evaluate(async () => {
        await document.fonts.ready;
        await new Promise(resolve => requestAnimationFrame(resolve));
        const rect = selector => {
            const box = document.querySelector(selector).getBoundingClientRect();
            return { x: box.x, y: box.y, width: box.width, height: box.height, right: box.right, bottom: box.bottom };
        };
        return {
            dialog: rect('.settings-dialog'), header: rect('#settings-dialog-title'),
            close: rect('[aria-label="설정 닫기"]'), analysis: rect('#settings-analysis-title'),
            device: rect('#settings-analysis-device .settings-row-title'), speech: rect('.settings-analysis-model-status .settings-row-title'),
            summary: rect('#settings-summary-title'), search: rect('#settings-model-search'), storage: rect('#settings-storage-title'),
            speechActions: rect('.settings-analysis-model-status'), modelRow: rect('[data-model-name="gemma4:e4b"] .settings-model-controls'),
        };
    });
    const assertAnchors = (before, after, label) => {
        for (const key of ['header', 'close', 'analysis', 'device', 'speech', 'summary', 'search', 'storage', 'speechActions', 'modelRow']) {
            for (const axis of ['x', 'y', 'right']) assert.ok(Math.abs(before[key][axis] - after[key][axis]) <= 1, `${label}: ${key}.${axis} stays fixed (${before[key][axis]} → ${after[key][axis]})`);
        }
        assert.ok(Math.abs(before.dialog.height - after.dialog.height) <= 1, `${label}: progress uses reserved space`);
    };
    for (const name of ['ready', 'missing', 'downloading', 'paused', 'failed', 'runtime-missing', 'loading']) {
        await visit(`settings-screen--${name}`);
        await page.getByRole('dialog', { name: '설정', exact: true }).waitFor();
        if (name === 'loading') await page.getByText('불러오는 중', { exact: true }).first().waitFor();
        else await page.getByRole('checkbox', { name: '음량 자동 보정', exact: true }).waitFor();
        if (name === 'ready') {
            await page.getByText('준비됨', { exact: true }).waitFor();
            assert.equal(await page.getByText('음량을 보정하지 않고 분석합니다.', { exact: true }).count(), 0);
        }
        if (name === 'missing') await page.getByRole('button', { name: '음성 인식 모델 받기', exact: true }).waitFor();
        if (name === 'downloading') await page.getByRole('button', { name: '음성 인식 모델 중지', exact: true }).waitFor();
        if (name === 'paused') await page.getByRole('button', { name: '음성 인식 모델 이어받기', exact: true }).waitFor();
        if (name === 'failed') await page.getByText(/받지 못했습니다/).first().waitFor();
        if (name === 'runtime-missing') {
            await page.getByRole('button', { name: 'AI 모델 사용 준비', exact: true }).waitFor();
            const choices = page.getByRole('radio');
            assert.equal(await choices.count(), 2, 'saved choices remain visible for unknown inventory');
            assert.equal(await choices.first().isChecked(), true, 'saved selection is preserved');
            for (const choice of await choices.all()) assert.equal(await choice.isDisabled(), true, 'unknown inventory prevents changing selection');
            assert.equal(await page.getByRole('button', { name: /gemma4:.*AI 모델 받기/ }).count(), 0, 'prepare runtime before model download');
            const beforeUrl = page.url();
            await page.getByRole('button', { name: '요약 프로그램 설치 페이지 열기', exact: true }).click();
            assert.equal(page.url(), beforeUrl, 'install link keeps catalogue open');
            assert.equal(context.pages().length, 1, 'install link opens no external popup');
        }
        await page.screenshot({ path: resolve(output, `${name}-1360.png`) });
        results.push({ story: name, width: 1360, passed: true });
    }
    for (const width of [1360, 860]) {
        await page.setViewportSize({ width, height: 900 });
        await visit('settings-screen--ready');
        const download = page.getByRole('button', { name: 'gemma4:e4b AI 모델 받기', exact: true });
        const contact = page.getByRole('button', { name: '문의 연락처 보기', exact: true });
        await download.waitFor();
        const readyLayout = await measure();
        assert.ok(Math.abs(readyLayout.device.y + readyLayout.device.height / 2 - readyLayout.speech.y - readyLayout.speech.height / 2) <= 1, 'ready speech and device titles share a baseline');
        for (const button of [download, contact]) {
            assert.equal((await button.innerText()).trim(), '', 'icon action has no visible label');
            const bounds = await button.boundingBox();
            assert.ok(Math.abs(bounds.width - 32) <= 1 && Math.abs(bounds.height - 32) <= 1, 'icon actions share a square footprint');
        }
        assert.equal(await page.locator('.settings-model-footer').evaluate(el => el.getBoundingClientRect().height), 0, 'empty footer does not reserve space');
        await download.hover();
        const tooltip = page.getByRole('tooltip', { name: 'AI 모델 받기', exact: true });
        await tooltip.waitFor();
        await tooltip.hover();
        await page.waitForTimeout(200);
        assert.equal(await tooltip.isVisible(), true, 'hovering the explanation keeps it visible');
        await page.keyboard.press('Escape');
        await tooltip.waitFor({ state: 'hidden' });
        await download.focus();
        await tooltip.waitFor();
        await page.screenshot({ path: resolve(output, `download-tooltip-${width}.png`) });
        await page.keyboard.press('Escape');
        await tooltip.waitFor({ state: 'hidden' });
        assert.equal(await download.evaluate(el => el === document.activeElement), true, 'tooltip dismissal preserves keyboard focus');
        await contact.focus();
        await page.getByRole('tooltip', { name: '문의', exact: true }).waitFor();
        await contact.click();
        await page.getByRole('button', { name: '문의 연락처 닫기', exact: true }).click();
        await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label') === '문의 연락처 보기');
        await page.keyboard.press('Escape');
        await page.screenshot({ path: resolve(output, `ready-icons-${width}.png`) });
        await download.click();
        const stop = page.getByRole('button', { name: 'gemma4:e4b 중지', exact: true });
        await stop.click();
        const resume = page.getByRole('button', { name: 'gemma4:e4b 이어받기', exact: true });
        await resume.waitFor();
        assert.match(await resume.innerText(), /이어받기/, 'paused downloads keep a visible resume label');
        results.push({ story: 'icon-actions-hover-focus-contact-download', width, passed: true });
    }
    for (const width of [1360, 860]) {
        await page.setViewportSize({ width, height: 900 });
        await visit('settings-screen--paused');
        const resume = page.getByRole('button', { name: '음성 인식 모델 이어받기', exact: true });
        await resume.click();
        const stop = page.getByRole('button', { name: '음성 인식 모델 중지', exact: true });
        await stop.click();
        await resume.waitFor();
        const toggle = page.getByRole('checkbox', { name: '음량 자동 보정', exact: true });
        await toggle.uncheck();
        const notice = page.getByText('음량을 보정하지 않고 분석합니다.', { exact: true });
        await notice.waitFor();
        const noticeBox = await page.locator('.settings-normalization-notice').boundingBox();
        for (const selector of ['#settings-summary-title', '#settings-analysis-device select']) {
            const target = await page.locator(selector).boundingBox();
            assert.ok(noticeBox.x + noticeBox.width <= target.x || target.x + target.width <= noticeBox.x
                || noticeBox.y + noticeBox.height <= target.y || target.y + target.height <= noticeBox.y, 'volume notice does not cover headings or the device control');
        }
        const contentHeight = await page.locator('.settings-page').last().evaluate(el => el.getBoundingClientRect().height);
        await page.screenshot({ path: resolve(output, `notice-${width}.png`) });
        await page.getByRole('button', { name: '음량 보정 안내 닫기', exact: true }).click();
        assert.equal(await toggle.evaluate(el => el === document.activeElement), true, 'closing notice returns focus');
        assert.equal(await page.locator('.settings-page').last().evaluate(el => el.getBoundingClientRect().height), contentHeight, 'notice does not change content height');
        const bounds = await page.getByRole('dialog', { name: '설정', exact: true }).boundingBox();
        assert.ok(bounds.x >= 0 && bounds.x + bounds.width <= width, 'dialog fits supported width');
        results.push({ story: 'resume-stop-volume-focus', width, passed: true });
    }
    for (const [width, height] of [[1360, 900], [860, 720], [860, 540]]) {
        await page.setViewportSize({ width, height });
        await visit('settings-screen--missing');
        const start = page.getByRole('button', { name: '음성 인식 모델 받기', exact: true });
        await start.waitFor();
        const before = await measure();
        assert.ok(before.dialog.height <= Math.min(760, height - 32) + 1, 'dialog respects viewport height cap');
        assert.ok(Math.abs(before.dialog.y - Math.max(16, (height - 760) / 2)) <= 1, 'dialog top is independent of content height');
        if (height >= 720) {
            const remaining = await page.locator('.settings-storage').evaluate(el => document.querySelector('.settings-dialog').getBoundingClientRect().bottom - el.getBoundingClientRect().bottom);
            assert.ok(remaining >= 18 && remaining <= 24, 'dialog ends after the final group and its padding');
            assert.ok(before.dialog.height < 680, 'short content does not fill the old 760px window');
            assert.ok(Math.abs(before.header.x - before.analysis.x) <= 1, 'header and group titles share a start edge');
        }
        await start.click();
        const stop = page.getByRole('button', { name: '음성 인식 모델 중지', exact: true });
        await stop.waitFor();
        const running = await measure();
        assertAnchors(before, running, 'speech start');
        await stop.click();
        const resume = page.getByRole('button', { name: '음성 인식 모델 이어받기', exact: true });
        await resume.waitFor();
        assertAnchors(before, await measure(), 'speech stop');
        const summaryStart = page.getByRole('button', { name: 'gemma4:e4b AI 모델 받기', exact: true });
        await summaryStart.click();
        const summaryStop = page.getByRole('button', { name: 'gemma4:e4b 중지', exact: true });
        await summaryStop.waitFor();
        assertAnchors(before, await measure(), 'summary start');
        const action = await summaryStop.boundingBox();
        await summaryStop.click();
        const summaryResume = page.getByRole('button', { name: 'gemma4:e4b 이어받기', exact: true });
        await summaryResume.waitFor();
        assertAnchors(before, await measure(), 'summary stop');
        const resumedAction = await summaryResume.boundingBox();
        assert.ok(Math.abs(action.x + action.width - resumedAction.x - resumedAction.width) <= 1, 'longer resume label keeps the same action edge');
        await page.screenshot({ path: resolve(output, `layout-${width}x${height}.png`) });
        if (height < 600) {
            await page.getByRole('combobox', { name: '다운로드 형식', exact: true }).scrollIntoViewIfNeeded();
            const scroll = await page.locator('.settings-content').evaluate(el => ({ top: el.scrollTop, overflow: el.scrollHeight - el.clientHeight }));
            assert.ok(scroll.overflow > 0 && scroll.top > 0, 'short windows scroll inside the dialog');
            assert.ok(Math.abs((await measure()).header.y - before.header.y) <= 1, 'header remains fixed while body scrolls');
            await page.screenshot({ path: resolve(output, `layout-${width}x${height}-scrolled.png`) });
        }
        layouts.push({ width, height, dialog: before.dialog, runningDialog: running.dialog });
        results.push({ story: 'content-height-and-download-anchors', width, height, passed: true });
    }
    await page.setViewportSize({ width: 860, height: 720 });
    await visit('settings-screen--paginated');
    await page.getByRole('button', { name: '다음 모델', exact: true }).waitFor();
    const firstPage = await measure();
    await page.getByRole('button', { name: '다음 모델', exact: true }).click();
    await page.locator('[data-model-name="example:three"]').waitFor();
    const lastPage = await page.locator('#settings-storage-title').boundingBox();
    assert.ok(Math.abs(firstPage.storage.y - lastPage.y) <= 1, 'last page reserves the same model rows');
    const header = await page.locator('#settings-dialog-title').boundingBox();
    await page.getByRole('button', { name: 'example:three 삭제 옵션', exact: true }).click();
    await page.getByRole('menuitem', { name: 'example:three 목록에서 제거', exact: true }).click();
    await page.getByRole('heading', { name: '모델 목록에서 제거', exact: true }).waitFor();
    const confirmation = await page.getByRole('dialog').boundingBox();
    assert.ok(confirmation.height < firstPage.dialog.height, 'short confirmation fits its content');
    assert.ok(Math.abs((await page.locator('#settings-dialog-title').boundingBox()).y - header.y) <= 1, 'context change retains header anchor');
    await page.getByRole('button', { name: '취소', exact: true }).click();
    await page.getByRole('button', { name: '이전 모델', exact: true }).waitFor();
    results.push({ story: 'pagination-and-confirmation-height', passed: true });
    for (const id of ['common-button--primary', 'common-feedback--recovery', 'common-progress--beginning']) {
        await visit(id);
        await page.locator('#storybook-root > *').waitFor();
        results.push({ story: id, passed: true });
    }
    await page.goto(`${origin}/iframe.html?id=settings-screen--docs&viewMode=docs`, { waitUntil: 'domcontentloaded' });
    await page.locator('#story--settings-screen--ready--primary iframe').scrollIntoViewIfNeeded();
    const readyFrame = page.frameLocator('#story--settings-screen--ready--primary iframe');
    const pausedFrame = page.frameLocator('iframe[id="iframe--settings-screen--paused"]');
    await readyFrame.getByText('준비됨', { exact: true }).waitFor();
    await page.locator('iframe[id="iframe--settings-screen--paused"]').scrollIntoViewIfNeeded();
    await pausedFrame.getByRole('button', { name: '음성 인식 모델 이어받기', exact: true }).waitFor();
    results.push({ story: 'settings-docs-isolation', passed: true });
    assert.deepEqual(escaped, [], 'all engine requests stayed in fixtures');
    assert.deepEqual(errors, [], 'stories rendered without browser exceptions');
    await writeFile(resolve(output, 'report.json'), JSON.stringify({ registered: required.length, networkEscapes: escaped, layouts, results }, null, 2));
    console.log(JSON.stringify({ passed: results.length, registered: required.length, networkEscapes: escaped.length, output }));
} finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
}
