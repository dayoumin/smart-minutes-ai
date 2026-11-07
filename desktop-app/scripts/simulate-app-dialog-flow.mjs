// The app's own confirm/prompt dialogs (components/common/AppDialog) that replaced window.confirm/prompt:
// focus enters and stays in the dialog, Escape cancels, focus returns, validation keeps the prompt open,
// and the destructive actions (원본 복원, 회의록 삭제, 이동) wait for the answer.
// Mocked API only: this proves web UI behavior, not the local engine.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright';

let APP_URL = process.env.APP_URL ?? 'http://127.0.0.1:5173/';
const shouldStartServer = !process.env.APP_URL;

const waitForApp = async (url, timeoutMs = 45000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until the dedicated Vite server is ready.
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for ${url}`);
};

const getAvailablePort = async host => new Promise((resolve, reject) => {
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

const startServer = async () => {
  if (!shouldStartServer) {
    await waitForApp(APP_URL);
    return null;
  }
  const url = new URL(APP_URL);
  url.port = String(await getAvailablePort(url.hostname));
  APP_URL = url.toString();
  const child = spawn(
    process.env.ComSpec ?? 'cmd.exe',
    ['/d', '/s', '/c', `corepack pnpm exec vite --host ${url.hostname} --port ${url.port} --strictPort --configLoader runner`],
    {
      cwd: fileURLToPath(new URL('..', import.meta.url)),
      env: { ...process.env, BROWSER: 'none' },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  await waitForApp(APP_URL);
  return child;
};

const stopServer = async child => {
  if (!child || child.exitCode !== null) return;
  await new Promise(resolve => {
    const killer = spawn(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `taskkill /pid ${child.pid} /t /f`], { stdio: 'ignore', windowsHide: true });
    killer.on('exit', resolve);
    killer.on('error', resolve);
  });
};

const installBaseRoutes = async page => {
  const fulfill = body => route => route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/health', fulfill({ ok: true }));
  await page.route('**/api/settings', fulfill({ diarization: { enabled: true, generate_during_analysis: true } }));
  await page.route('**/api/models/status', fulfill({ ready: true, models: [] }));
  await page.route('**/api/analyze/draft-statuses', fulfill({ drafts: [] }));
};

const seed = async (page, meetings, folderNames = []) => page.evaluate(async ({ values, names }) => {
  const repository = await import('/src/meetingRepository.ts');
  for (const meeting of values) await repository.addMeeting(meeting);
  for (const name of names) await repository.addMeetingFolder(name);
}, { values: meetings, names: folderNames });

const readMeeting = (page, id) => page.evaluate(async meetingId => (await import('/src/meetingRepository.ts')).getMeetingById(meetingId), id);

const activeInfo = page => page.evaluate(() => ({
  inDialog: Boolean(document.activeElement?.closest('.app-dialog')),
  tag: document.activeElement?.tagName ?? '',
  text: document.activeElement?.textContent?.trim() ?? '',
  label: document.activeElement?.getAttribute('aria-label') ?? '',
}));

// Two frames let any focus queued by the closing menu run, which is what used to steal the dialog's focus.
const settleFrames = page => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

const segments = [
  { start: '00:00:01', end: '00:00:05', speaker: '화자1', text: '원본 첫 발화입니다.' },
  { start: '00:00:06', end: '00:00:09', speaker: '화자2', text: '원본 두 번째 발화입니다.' },
];
const meeting = (id, title, extra = {}) => ({
  id, title, date: '2026-11-07 10:00', summary: '', participants: '', segments, ...extra,
});

const run = async browser => {
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  // No browser-native dialog may appear anywhere in the flow.
  const nativeDialogs = [];
  page.on('dialog', dialog => {
    nativeDialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await installBaseRoutes(page);
  try {
    await page.goto(APP_URL, { waitUntil: 'domcontentloaded' });
    await page.getByRole('heading', { name: '새 회의록', level: 2 }).waitFor({ timeout: 20000 });
    await seed(page, [
      meeting('dialog-rename', '이름 바꿀 회의'),
      meeting('dialog-edited', '고친 대화록 회의', {
        editedDisplaySegments: [{ ...segments[0], text: '사용자가 고친 첫 발화입니다.' }, segments[1]],
      }),
    ], ['첫 폴더', '둘째 폴더']);
    await page.reload({ waitUntil: 'domcontentloaded' });
    const navigation = page.locator('.barorok-navigation');
    const menuTrigger = title => navigation.locator(`[data-sidebar-record-menu-trigger][aria-label^="${title},"]`);
    const recordMenu = navigation.locator('[data-sidebar-record-menu]');
    await menuTrigger('이름 바꿀 회의').waitFor({ timeout: 10000 });

    // Rename: the prompt keeps focus after the menu closes, and saves onto the stored record.
    await menuTrigger('이름 바꿀 회의').focus();
    await menuTrigger('이름 바꿀 회의').press('Enter');
    await recordMenu.getByRole('button', { name: '이름 변경', exact: true }).click();
    const renameDialog = page.getByRole('dialog', { name: '회의록 이름 변경' });
    await renameDialog.waitFor();
    await settleFrames(page);
    assert.deepEqual(await activeInfo(page).then(info => [info.inDialog, info.tag]), [true, 'INPUT'], 'the name input keeps focus after the menu closes');
    // A result saved while the dialog is open must survive the rename.
    await page.evaluate(async () => {
      const repository = await import('/src/meetingRepository.ts');
      const current = await repository.getMeetingById('dialog-rename');
      await repository.updateMeeting({ ...current, summary: '열려 있는 동안 저장된 요약' });
    });
    await page.keyboard.press('Control+A');
    await page.keyboard.type('바뀐 이름 회의');
    await page.keyboard.press('Enter');
    await renameDialog.waitFor({ state: 'detached' });
    await menuTrigger('바뀐 이름 회의').waitFor({ timeout: 10000 });
    const renamed = await readMeeting(page, 'dialog-rename');
    assert.equal(renamed.title, '바뀐 이름 회의');
    assert.equal(renamed.summary, '열려 있는 동안 저장된 요약', 'rename keeps data saved while the dialog was open');
    await page.waitForFunction(() => document.activeElement?.hasAttribute('data-sidebar-record-menu-trigger'));

    // Delete: focus starts on 취소, Tab stays inside, Escape keeps the record and returns focus.
    await menuTrigger('바뀐 이름 회의').press('Enter');
    await recordMenu.getByRole('button', { name: '삭제', exact: true }).click();
    const deleteDialog = page.getByRole('alertdialog', { name: '"바뀐 이름 회의" 회의록을 삭제할까요?' });
    await deleteDialog.waitFor();
    await settleFrames(page);
    assert.deepEqual(await activeInfo(page).then(info => [info.inDialog, info.text]), [true, '취소'], 'a delete question starts on 취소');
    for (let index = 0; index < 4; index += 1) {
      await page.keyboard.press('Tab');
      assert.equal((await activeInfo(page)).inDialog, true, 'Tab stays inside the dialog');
    }
    await page.keyboard.press('Escape');
    await deleteDialog.waitFor({ state: 'detached' });
    assert.ok(await readMeeting(page, 'dialog-rename'), 'Escape keeps the record');
    await page.waitForFunction(() => document.activeElement?.getAttribute('aria-label')?.startsWith('바뀐 이름 회의,'));
    // A click on the backdrop does not dismiss a destructive question.
    await menuTrigger('바뀐 이름 회의').press('Enter');
    await recordMenu.getByRole('button', { name: '삭제', exact: true }).click();
    await deleteDialog.waitFor();
    await page.mouse.click(5, 5);
    await settleFrames(page);
    assert.equal(await deleteDialog.count(), 1, 'a backdrop click leaves the question open');
    await deleteDialog.getByRole('button', { name: '취소', exact: true }).click();
    await deleteDialog.waitFor({ state: 'detached' });

    // Folder rename: a duplicate name keeps the prompt open with the reason.
    const folderTrigger = navigation.getByRole('button', { name: '첫 폴더 폴더 메뉴', exact: true });
    await navigation.getByRole('button', { name: '첫 폴더', exact: true }).hover();
    await folderTrigger.click();
    await page.getByRole('menuitem', { name: '이름 변경', exact: true }).click();
    const folderDialog = page.getByRole('dialog', { name: '폴더 이름 변경' });
    await folderDialog.waitFor();
    await folderDialog.getByLabel('폴더 이름').fill('둘째 폴더');
    await folderDialog.getByRole('button', { name: '변경', exact: true }).click();
    await folderDialog.getByText('같은 이름의 폴더가 이미 있습니다.', { exact: true }).waitFor();
    assert.equal(await folderDialog.getByLabel('폴더 이름').getAttribute('aria-invalid'), 'true');
    await page.keyboard.press('Escape');
    await folderDialog.waitFor({ state: 'detached' });

    // 원본 복원 asks first; 취소 keeps the user's edits, confirming restores the original.
    await navigation.getByRole('button', { name: '고친 대화록 회의', exact: true }).click();
    const shell = page.locator('.meeting-detail-shell');
    await shell.getByText('사용자가 고친 첫 발화입니다.', { exact: true }).waitFor({ timeout: 10000 });
    await shell.getByRole('button', { name: '원본 복원', exact: true }).click();
    const revertDialog = page.getByRole('alertdialog', { name: '원본 대화록으로 되돌릴까요?' });
    await revertDialog.waitFor();
    await revertDialog.getByRole('button', { name: '취소', exact: true }).click();
    await revertDialog.waitFor({ state: 'detached' });
    assert.equal((await readMeeting(page, 'dialog-edited')).editedDisplaySegments.length, 2, '취소 keeps the edited transcript');
    await shell.getByText('사용자가 고친 첫 발화입니다.', { exact: true }).waitFor();
    await shell.getByRole('button', { name: '원본 복원', exact: true }).click();
    await revertDialog.getByRole('button', { name: '원본으로 되돌리기', exact: true }).click();
    await shell.getByText('원본 첫 발화입니다.', { exact: true }).waitFor({ timeout: 10000 });
    assert.equal((await readMeeting(page, 'dialog-edited')).editedDisplaySegments.length, 0);

    // Leaving a started new record asks; 계속 작성 stays, 이동 leaves.
    await page.getByRole('button', { name: '새 회의록', exact: true }).first().click();
    await page.getByLabel('회의 제목', { exact: true }).fill('작성 중인 제목');
    await navigation.getByRole('button', { name: '고친 대화록 회의', exact: true }).click();
    const leaveDialog = page.getByRole('alertdialog', { name: '작성 중인 회의록을 두고 다른 기록으로 이동할까요?' });
    await leaveDialog.waitFor();
    await leaveDialog.getByRole('button', { name: '계속 작성', exact: true }).click();
    await leaveDialog.waitFor({ state: 'detached' });
    assert.equal(await page.getByLabel('회의 제목', { exact: true }).inputValue(), '작성 중인 제목');
    await navigation.getByRole('button', { name: '고친 대화록 회의', exact: true }).click();
    await leaveDialog.getByRole('button', { name: '이동', exact: true }).click();
    await shell.getByRole('heading', { name: '고친 대화록 회의' }).waitFor({ timeout: 10000 });

    assert.deepEqual(nativeDialogs, []);
    assert.deepEqual(errors, []);
    console.log('ok - app dialogs keep focus, cancel safely and guard destructive actions');
  } finally {
    await context.close();
  }
};

const server = await startServer();
const browser = await chromium.launch({ headless: true });
try {
  await run(browser);
} finally {
  await browser.close();
  await stopServer(server);
}
