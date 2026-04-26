const { chromium } = require('playwright');

const assertVisible = async (locator, label, timeout = 5000) => {
  await locator.waitFor({ state: 'visible', timeout });
  console.log(`ok - ${label}`);
};

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage();

  try {
    await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded' });

    await assertVisible(page.getByRole('button', { name: '회의록 작성' }), 'sidebar has meeting writer button');
    await assertVisible(page.getByText('새 회의록 작성'), 'meeting writer screen is visible');

    await page.getByPlaceholder('예: 2026년 상반기 기획 회의').fill('E2E 테스트 회의');
    await page.locator('input[type="datetime-local"]').fill('2026-04-26T17:30');
    await page.getByPlaceholder('예: 홍길동, 김철수').fill('홍길동, 김철수');
    await page.locator('input[type="file"]').setInputFiles('../backend/test_audio.wav');
    await page.getByRole('button', { name: 'AI 분석 시작' }).click();

    await assertVisible(page.getByText('회의록 저장이 완료되었습니다.'), 'analysis completes and saves', 10000);

    await page.getByRole('button', { name: '이전 회의 기록' }).click();
    await assertVisible(page.getByRole('cell', { name: 'E2E 테스트 회의', exact: true }), 'history shows saved meeting');

    await page.getByRole('button', { name: '시스템 설정' }).click();
    await assertVisible(page.getByRole('heading', { name: '모델 준비 상태' }), 'settings shows model status');
    await assertVisible(page.getByRole('button', { name: '누락 모델 다운로드' }), 'settings has model download action');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exit(1);
});
