// Answers the app's own confirm/prompt dialogs (components/common/AppDialog) the way Playwright's
// `page.on('dialog')` answered window.confirm/prompt: handlers get a dialog with type(), message(),
// defaultValue(), accept(value?) and dismiss(); with no handler the dialog is dismissed.
// Install before the first navigation: `const appDialogs = await installAppDialogs(page);`
//
// type(): 'prompt' for a name input, 'confirm' for a yes/no question, 'choice' for 이어서/처음부터.
// accept() presses the main button. dismiss() presses 취소, except on a choice, where it presses the
// second option (처음부터 분석) as window.confirm's 취소 used to.

export const installAppDialogs = async page => {
  const handlers = [];
  await page.exposeBinding('__appDialogOpened', async (_source, info) => new Promise(resolve => {
    let settled = false;
    const decide = decision => {
      if (settled) return;
      settled = true;
      resolve(decision);
    };
    const dialog = {
      type: () => info.type,
      message: () => info.message,
      defaultValue: () => info.defaultValue,
      accept: async value => decide({ action: 'accept', value }),
      dismiss: async () => decide({ action: 'dismiss' }),
    };
    const current = handlers.slice();
    if (current.length === 0) {
      decide({ action: 'dismiss' });
      return;
    }
    for (const entry of current) {
      if (entry.once) handlers.splice(handlers.indexOf(entry), 1);
      Promise.resolve(entry.handler(dialog)).catch(() => {});
    }
  }));
  await page.addInitScript(() => {
    const seen = new WeakSet();
    const answer = async element => {
      const actions = [...element.querySelectorAll('.app-dialog-actions button')];
      const input = element.querySelector('input');
      const type = input ? 'prompt' : actions.length >= 3 ? 'choice' : 'confirm';
      const title = element.querySelector('.app-dialog-title')?.textContent ?? '';
      const description = element.querySelector('.app-dialog-description')?.textContent ?? '';
      const decision = await window.__appDialogOpened({
        type,
        message: description ? `${title}\n\n${description}` : title,
        defaultValue: input?.value ?? '',
      });
      if (!element.isConnected) return;
      if (decision.action === 'accept') {
        if (input && typeof decision.value === 'string') {
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(input, decision.value);
          input.dispatchEvent(new Event('input', { bubbles: true }));
          await new Promise(resolve => setTimeout(resolve, 0));
        }
        actions[actions.length - 1].click();
      } else {
        (type === 'choice' ? actions[1] : actions[0]).click();
      }
    };
    new MutationObserver(() => {
      for (const element of document.querySelectorAll('.app-dialog')) {
        if (seen.has(element)) continue;
        seen.add(element);
        void answer(element);
      }
    }).observe(document, { childList: true, subtree: true });
  });
  return {
    on: handler => { handlers.push({ handler, once: false }); },
    once: handler => { handlers.push({ handler, once: true }); },
    off: handler => {
      const index = handlers.findIndex(entry => entry.handler === handler);
      if (index >= 0) handlers.splice(index, 1);
    },
  };
};
