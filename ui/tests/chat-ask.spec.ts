import { expect, test, type Page } from '@playwright/test';
import { openChat, openWithDm, seedChat, watchErrors } from './helpers';

// Ask widgets: permission, AskUserQuestion and plan approval, answered from chat or the terminal.

type Answer = { id: string; promptId: string; answer: unknown };

const answers = (page: Page): Promise<Answer[]> =>
  page.evaluate(() => window.__PR_MOCK__!.answers as Answer[]);

async function prompt(page: Page, id: string, which: 'permission' | 'question' | 'plan') {
  await page.evaluate(
    ({ sid, w }) => {
      const p = {
        permission: {
          promptId: 'p-perm',
          kind: 'permission' as const,
          toolName: 'Bash',
          toolInput: { command: 'rm -rf build && cargo build' },
          toolUseId: 'tu-new',
        },
        question: {
          promptId: 'p-q',
          kind: 'question' as const,
          toolName: 'AskUserQuestion',
          toolInput: {},
          toolUseId: 'tu-q-new',
          questions: [
            {
              question: 'When the bridge times out, what should the hook do?',
              header: 'Timeout',
              multiSelect: false,
              options: [
                {
                  label: 'Fall through to the TUI (Recommended)',
                  description: 'Return no decision.',
                },
                { label: 'Deny the tool call', description: 'Safer when unattended.' },
              ],
            },
            {
              question: 'Which checks should run?',
              header: 'Checks',
              multiSelect: true,
              options: [{ label: 'Unit' }, { label: 'Lint' }, { label: 'E2E' }],
            },
          ],
        },
        plan: {
          promptId: 'p-plan',
          kind: 'plan' as const,
          toolName: 'ExitPlanMode',
          toolInput: { plan: '## Plan\n\n1. Add the timeout\n2. Add a test\n' },
          toolUseId: 'tu-plan-new',
        },
      }[w];
      window.__PR_MOCK__!.emitPrompt(sid, p);
    },
    { sid: id, w: which },
  );
}

test.describe('ask widgets', () => {
  test('permission: Allow answers from chat and the widget shows how it resolved', async ({
    page,
  }) => {
    const errs = watchErrors(page);
    const id = await openChat(page, []);
    await prompt(page, id, 'permission');
    const ask = page.locator('.ask[data-kind="permission"]');
    await expect(ask).toBeVisible();
    await expect(ask).toContainText('Claude wants to use Bash');
    await expect(ask).toContainText('rm -rf build && cargo build');
    await expect(ask.locator('.needs-pill')).toHaveText('Needs you');
    await ask.getByRole('button', { name: 'Allow', exact: true }).click();
    expect(await answers(page)).toEqual([{ id, promptId: 'p-perm', answer: { kind: 'allow' } }]);
    await expect(ask).toHaveAttribute('data-state', 'resolved');
    await expect(ask.locator('.ask-done')).toHaveText('Allowed in chat');
    await expect(ask.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0);
    expect(errs).toEqual([]);
  });

  test('permission: Deny and Always allow send their own answers', async ({ page }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'permission');
    const ask = page.locator('.ask[data-kind="permission"]');
    await ask.getByRole('button', { name: 'Always allow' }).click();
    await expect(ask.locator('.ask-done')).toHaveText('Always allowed in chat');
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.emitPrompt(sid, {
        promptId: 'p-perm-2',
        kind: 'permission',
        toolName: 'Edit',
        toolInput: { file_path: '/work/a.ts' },
      });
    }, id);
    const second = page.locator('.ask[data-kind="permission"][data-state="pending"]');
    await second.getByRole('button', { name: 'Deny' }).click();
    expect((await answers(page)).map((a) => a.answer)).toEqual([
      { kind: 'allow_always' },
      { kind: 'deny' },
    ]);
    await expect(page.locator('.ask-done').last()).toHaveText('Denied in chat');
  });

  test('permission: Answer in terminal hands the prompt to the TUI, and the terminal answer resolves it', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'permission');
    const ask = page.locator('.ask[data-kind="permission"]');
    await ask.getByRole('button', { name: 'Answer in terminal' }).click();
    // The hook is released so the TUI dialog answers; the terminal comes to the front.
    expect(await answers(page)).toEqual([{ id, promptId: 'p-perm', answer: { kind: 'terminal' } }]);
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
    await expect(page.locator('.term--active .xterm')).toBeVisible();
    await page.keyboard.press('Meta+j');
    // Still pending, now waiting on the terminal: no second way to answer from chat.
    await expect(ask).toHaveAttribute('data-state', 'pending');
    await expect(ask).toContainText('Waiting for your answer in the terminal');
    await expect(ask.getByRole('button', { name: 'Allow', exact: true })).toHaveCount(0);
    // The terminal answers: the arbiter reports it and the widget settles.
    await page.evaluate((sid) => window.__PR_MOCK__!.resolvePrompt(sid, 'p-perm', 'terminal'), id);
    await expect(ask.locator('.ask-done')).toHaveText('Answered in terminal');
    await expect(ask.getByRole('button')).toHaveCount(0);
    expect(await answers(page)).toHaveLength(1);
  });

  test('permission: Always allow is offered only when the CLI suggested a rule', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.emitPrompt(sid, {
        promptId: 'p-noalways',
        kind: 'permission',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
        canAlways: false,
      });
    }, id);
    const ask = page.locator('.ask[data-kind="permission"]');
    await expect(ask.getByRole('button', { name: 'Allow', exact: true })).toBeVisible();
    await expect(ask.getByRole('button', { name: 'Always allow' })).toHaveCount(0);
  });

  test('question: Answer in terminal releases the picker to the TUI', async ({ page }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'question');
    await page
      .locator('.ask[data-kind="question"]')
      .getByRole('button', { name: 'Answer in terminal' })
      .click();
    expect(await answers(page)).toEqual([{ id, promptId: 'p-q', answer: { kind: 'terminal' } }]);
    await expect(page.getByTestId('view-label')).toHaveText('Terminal');
  });

  test('permission: a timeout and an interrupt are shown as such', async ({ page }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'permission');
    await page.evaluate((sid) => window.__PR_MOCK__!.resolvePrompt(sid, 'p-perm', 'timeout'), id);
    await expect(page.locator('.ask-done')).toHaveText('Timed out');
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.emitPrompt(sid, {
        promptId: 'p2',
        kind: 'permission',
        toolName: 'Bash',
        toolInput: { command: 'ls' },
      });
      window.__PR_MOCK__!.resolvePrompt(sid, 'p2', 'interrupt');
    }, id);
    await expect(page.locator('.ask-done').last()).toHaveText('Interrupted');
  });

  test('question: single select, with a Recommended tag, sends the label', async ({ page }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'question');
    const ask = page.locator('.ask[data-kind="question"]');
    await expect(ask).toContainText('Claude is asking');
    await expect(ask.locator('.rec')).toHaveText('Recommended');
    const send = ask.getByRole('button', { name: 'Send answer' });
    await expect(send).toBeDisabled();
    await ask.getByRole('radio', { name: /Fall through to the TUI/ }).check();
    await expect(send).toBeDisabled(); // the second question is still open
    await ask.getByRole('checkbox', { name: /Unit/ }).check();
    await ask.getByRole('checkbox', { name: /E2E/ }).check();
    await expect(send).toBeEnabled();
    await send.click();
    expect(await answers(page)).toEqual([
      {
        id,
        promptId: 'p-q',
        answer: {
          kind: 'questions',
          answers: {
            'When the bridge times out, what should the hook do?': 'Fall through to the TUI',
            'Which checks should run?': 'Unit, E2E',
          },
        },
      },
    ]);
    await expect(ask.locator('.ask-done')).toHaveText('Answered in chat');
    await expect(ask.locator('.qdone-a').first()).toHaveText('Fall through to the TUI');
  });

  test('question: Other takes free text, single and multi', async ({ page }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'question');
    const ask = page.locator('.ask[data-kind="question"]');
    const send = ask.getByRole('button', { name: 'Send answer' });
    // Typing in Other selects it and drops the radio choice.
    await ask.getByRole('radio', { name: /Deny the tool call/ }).check();
    await ask
      .getByLabel('Other answer for: When the bridge times out, what should the hook do?')
      .fill('Retry once, then fall through');
    await expect(ask.getByRole('radio', { name: /Deny the tool call/ })).not.toBeChecked();
    await ask.getByRole('checkbox', { name: /Lint/ }).check();
    await ask.getByLabel('Other answer for: Which checks should run?').fill('smoke test');
    await expect(send).toBeEnabled();
    await send.click();
    const [a] = await answers(page);
    expect(a.answer).toEqual({
      kind: 'questions',
      answers: {
        'When the bridge times out, what should the hook do?': 'Retry once, then fall through',
        'Which checks should run?': 'Lint, smoke test',
      },
    });
  });

  test('question: the Other control lines up with the option controls', async ({ page }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'question');
    const ask = page.locator('.ask[data-kind="question"]');
    for (const block of await ask.locator('.qblock').all()) {
      const opt = await block.locator('.opt .radio').first().boundingBox();
      const other = await block.locator('.other .radio').boundingBox();
      expect(opt && other).toBeTruthy();
      expect(Math.abs(other!.x - opt!.x)).toBeLessThanOrEqual(1);
    }
  });

  test('question: an empty Other blocks Send', async ({ page }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'question');
    const ask = page.locator('.ask[data-kind="question"]');
    await ask.getByRole('radio', { name: 'Other' }).first().check();
    await ask.getByRole('checkbox', { name: /Unit/ }).check();
    await expect(ask.getByRole('button', { name: 'Send answer' })).toBeDisabled();
  });

  test('question: answered in the terminal, the widget says so and keeps no answers', async ({
    page,
  }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'question');
    await page.evaluate((sid) => window.__PR_MOCK__!.resolvePrompt(sid, 'p-q', 'terminal'), id);
    const ask = page.locator('.ask[data-kind="question"]');
    await expect(ask.locator('.ask-done')).toHaveText('Answered in terminal');
    await expect(ask.getByRole('button', { name: 'Send answer' })).toHaveCount(0);
  });

  test('a question prompt fills the matching question item instead of adding a second widget', async ({
    page,
  }) => {
    const id = await openWithDm(page, 'mock', 'chat');
    await seedChat(page, id, [
      {
        key: 'q-item',
        ts: Date.now(),
        kind: 'question',
        toolUseId: 'tu-q-new',
        state: 'pending',
        questions: [
          {
            question: 'Pick one',
            header: 'Pick',
            multiSelect: false,
            options: [{ label: 'A' }, { label: 'B' }],
          },
        ],
      },
    ]);
    await prompt(page, id, 'question');
    // The prompt carries its own questions; one widget exists, at the item's place.
    await expect(page.locator('.ask[data-kind="question"]')).toHaveCount(1);
    await expect(page.locator('.msg[data-key="q-item"] .ask[data-kind="question"]')).toHaveCount(1);
  });

  test('plan: Approve sends allow, Revise sends feedback as deny', async ({ page }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'plan');
    const ask = page.locator('.ask[data-kind="plan"]');
    await expect(ask).toContainText('Claude has a plan');
    await expect(ask).toContainText('Add the timeout');
    await ask.getByRole('button', { name: 'Approve plan' }).click();
    expect((await answers(page))[0].answer).toEqual({ kind: 'allow' });
    await expect(ask.locator('.ask-done')).toHaveText('Plan approved in chat');

    await prompt(page, id, 'plan'); // same id: ignored, no duplicate widget
    await page.evaluate((sid) => {
      window.__PR_MOCK__!.emitPrompt(sid, {
        promptId: 'p-plan-2',
        kind: 'plan',
        toolName: 'ExitPlanMode',
        toolInput: { plan: 'Second plan' },
      });
    }, id);
    const second = page.locator('.ask[data-kind="plan"][data-state="pending"]');
    await second.getByRole('button', { name: 'Revise' }).click();
    await second.getByLabel('Revision feedback').fill('Add a rollback step');
    await second.getByRole('button', { name: 'Send feedback' }).click();
    expect((await answers(page))[1].answer).toEqual({
      kind: 'deny',
      message: 'Add a rollback step',
    });
  });

  test('a pending prompt is announced and offers a jump when scrolled away', async ({ page }) => {
    const id = await openChat(page);
    await page.getByTestId('chat-log').evaluate((el) => (el.scrollTop = 0));
    await prompt(page, id, 'permission');
    await expect(
      page.getByRole('status').filter({ hasText: 'request needs your answer' }),
    ).toHaveCount(1);
    const jump = page.getByTestId('jump-latest');
    await expect(jump).toContainText('Needs you below');
    await jump.click();
    await expect(page.locator('.ask[data-kind="permission"]')).toBeVisible();
  });

  test('widgets are keyboard reachable: radios by arrow keys, buttons by Tab', async ({ page }) => {
    const id = await openChat(page, []);
    await prompt(page, id, 'question');
    const ask = page.locator('.ask[data-kind="question"]');
    const first = ask.getByRole('radio', { name: /Fall through/ });
    await first.focus();
    await page.keyboard.press('Space');
    await expect(first).toBeChecked();
    await page.keyboard.press('ArrowDown');
    await expect(ask.getByRole('radio', { name: /Deny the tool/ })).toBeChecked();
    await expect(ask.locator('.opt.sel')).toHaveCount(1);
  });
});
