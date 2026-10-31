import { expect, test, type Page } from '@playwright/test';
import { openChat, watchErrors } from './helpers';

// "Carry chat draft to the terminal": switching chat to terminal types the draft into claude's
// input as one bracketed paste (no Enter), clears it in chat and says so. Off by default, with a
// one-time hint. Nothing moves while a dialog only the terminal answers is up.

const PASTE_START = '\x1b[200~';
const PASTE_END = '\x1b[201~';

const written = (page: Page, id: string): Promise<string> =>
  page.evaluate((sid) => String.fromCharCode(...(window.__PR_MOCK__!.writes[sid] ?? [])), id);

async function setCarry(page: Page, on: boolean): Promise<void> {
  await page.evaluate(
    (v) => window.__PR_STORE__!.setPrefs({ chat: { autoScroll: true, carryDraft: v } }),
    on,
  );
}

async function draft(page: Page, text: string): Promise<void> {
  const box = page.getByTestId('composer-input');
  await box.fill(text);
  await expect(box).toHaveValue(text);
}

test.describe('carry the chat draft to the terminal', () => {
  test('off by default: the draft stays, and a one-time hint offers to turn it on', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    const id = await openChat(page, []);
    const before = (await written(page, id)).length;
    await draft(page, 'refactor the parser');
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
    expect((await written(page, id)).length).toBe(before);
    const hint = page.getByTestId('hint');
    await expect(hint).toContainText('Your draft stayed in chat');
    await hint.getByRole('button', { name: 'Turn on' }).click();
    await expect(hint).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => window.__PR_STORE__!.getSnapshot().prefs?.chat?.carryDraft))
      .toBe(true);
    // Back in chat, the draft is still there.
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('composer-input')).toHaveValue('refactor the parser');
    expect(errs).toEqual([]);
  });

  test('on: a multi-line draft arrives as one bracketed paste, unsent, and chat is cleared', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    const id = await openChat(page, []);
    await setCarry(page, true);
    const before = (await written(page, id)).length;
    await draft(page, 'refactor the parser\nkeep the public API');
    await page.getByRole('button', { name: 'Terminal', exact: true }).click();
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
    await expect(page.getByTestId('term-toast')).toHaveText('Draft moved to the terminal.');
    const sent = (await written(page, id)).slice(before);
    expect(sent).toBe(`${PASTE_START}refactor the parser\nkeep the public API${PASTE_END}`);
    expect(sent).not.toContain('\r');
    // Chat lost the draft; nothing carries back from the terminal.
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('composer-input')).toHaveValue('');
    const again = (await written(page, id)).length;
    await page.keyboard.press('Meta+j');
    expect((await written(page, id)).length).toBe(again);
    expect(errs).toEqual([]);
  });

  test('on: pasted images and comments stay in chat, and the notice says so', async ({ page }) => {
    const id = await openChat(page, []);
    await setCarry(page, true);
    const before = (await written(page, id)).length;
    // A pasted image lands in the draft as its quoted path.
    await page.evaluate(async (sid) => {
      const png = Uint8Array.from(
        atob(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
        ),
        (c) => c.charCodeAt(0),
      );
      await window.__PR_STORE__!.pasteImage(sid, new Blob([png], { type: 'image/png' }));
    }, id);
    const box = page.getByTestId('composer-input');
    await expect(box).not.toHaveValue('');
    const imageToken = (await box.inputValue()).trim();
    await box.press('End');
    await box.pressSequentially('what is wrong here?');
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('term-toast')).toHaveText(
      'Draft moved to the terminal. Images and comments stayed in chat.',
    );
    const sent = (await written(page, id)).slice(before);
    expect(sent).toBe(`${PASTE_START}what is wrong here?${PASTE_END}`);
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('composer-input')).toHaveValue(`${imageToken} `);
  });

  test('on: nothing moves while a terminal dialog or a chat prompt is up', async ({ page }) => {
    const id = await openChat(page, []);
    await setCarry(page, true);
    const before = (await written(page, id)).length;
    await draft(page, 'later, please');
    await page.evaluate((sid) => window.__PR_MOCK__!.setTerminalDialog(sid, true), id);
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('term-toast')).toContainText('Your draft stayed in chat');
    expect((await written(page, id)).length).toBe(before);
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('composer-input')).toHaveValue('later, please');
    // A chat prompt: the switch hands its picker to the terminal, so the draft must not land in it.
    await page.evaluate((sid) => {
      const m = window.__PR_MOCK__!;
      m.setTerminalDialog(sid, false);
      m.emitPrompt(sid, {
        promptId: 'p-q',
        kind: 'question',
        toolName: 'AskUserQuestion',
        toolInput: {},
        questions: [
          { question: 'Which?', header: 'Q', multiSelect: false, options: [{ label: 'A' }] },
        ],
      });
    }, id);
    await page.keyboard.press('Meta+j');
    await expect(page.getByTestId('term-toast')).toContainText('Your draft stayed in chat');
    expect((await written(page, id)).length).toBe(before);
  });
});
