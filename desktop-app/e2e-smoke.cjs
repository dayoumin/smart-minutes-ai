const path = require('node:path');
const { chromium } = require('playwright');

const APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173';
const AUDIO_PATH = path.resolve(__dirname, '../backend/models/stt/cohere-transcribe-03-2026/demo/voxpopuli_test_en_demo.wav');

const assertVisible = async (locator, label, timeout = 10000) => {
  await locator.waitFor({ state: 'visible', timeout });
  console.log(`ok - ${label}`);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });

    await assertVisible(page.locator('input').first(), 'meeting writer form is visible');

    await page.locator('input').nth(0).fill('Real E2E Smoke Test');
    await page.locator('input[type="datetime-local"]').fill('2026-04-26T17:30');
    await page.locator('input').nth(2).fill('Speaker 1');
    await page.locator('input[type="file"]').setInputFiles(AUDIO_PATH);

    const completedResponsePromise = page.waitForResponse(
      response => response.url().includes('/api/analyze') && response.status() === 200,
      { timeout: 180000 },
    );
    await page.getByRole('button', { name: /AI/ }).click();
    const completedResponse = await completedResponsePromise;
    const body = await completedResponse.text();

    if (!body.includes('"mode":"real"') && !body.includes('"mode": "real"')) {
      throw new Error(`Expected real mode SSE result, got: ${body.slice(0, 1000)}`);
    }
    if (!body.includes('"status":"completed"') && !body.includes('"status": "completed"')) {
      throw new Error(`Expected completed SSE result, got: ${body.slice(0, 1000)}`);
    }

    console.log('ok - /api/analyze returned real completed SSE result');
    await assertVisible(page.getByText(/완료|저장|completed/), 'analysis produced a visible completion status', 30000);

    await page.getByRole('button', { name: /기록|History|회의/ }).last().click();
    await assertVisible(page.getByText('Real E2E Smoke Test'), 'history shows saved real meeting', 30000);
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
