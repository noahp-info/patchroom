import { expect, test, type Page } from '@playwright/test';
import { openWithDm, seedChat } from './helpers';
import { expectNoOverlap, overlapFindings, ringFindings } from './qa';

/*
 * Overlap QA (CLAUDE.md, "UI work: overlap rule"). Every main surface at the minimum window,
 * a narrow split with the side pane open, and 1440, in light and dark:
 * nothing draws over anything else, text never clips silently, nothing scrolls sideways, and
 * outlined boxes keep ring room. Every overlay is opened with the side pane up, and the native
 * viewer must step aside for it (snapshot, hide) and come back (reveal) when it closes.
 */

const SIZES = [
  { name: 'minimum window', width: 880, height: 600, pane: false },
  { name: 'narrow split', width: 1100, height: 760, pane: true },
  { name: 'minimum with pane', width: 880, height: 600, pane: true },
  { name: 'wide', width: 1440, height: 900, pane: true },
] as const;
const SCHEMES = ['light', 'dark'] as const;
const URL_A = 'https://claude.ai/artifact/CxWsf7LuBBuLJ791ZWKR1T';

async function setup(page: Page, width: number, height: number): Promise<string> {
  await page.setViewportSize({ width, height });
  const id = await openWithDm(page, 'mock', 'chat');
  const base = await page.evaluate(() => window.__PR_MOCK__!.synthetic());
  const now = Date.now();
  await seedChat(page, id, [
    ...base,
    {
      key: 'qa1',
      ts: now,
      kind: 'tool',
      toolUseId: 'tu-qa1',
      name: 'Write',
      input: { file_path: '/private/tmp/patchroom-qa/a-long-file-name-for-the-tool-row.md' },
      state: 'done',
      result: { text: 'ok', isError: false, truncated: false },
    },
    {
      key: 'qa2',
      ts: now,
      kind: 'tool',
      toolUseId: 'tu-qa2',
      name: 'Bash',
      input: { command: 'pnpm -C ui build && pnpm -C ui lint' },
      state: 'done',
      result: { text: 'ok', isError: false, truncated: false },
    },
    { key: 'qa3', ts: now, kind: 'assistant', text: `Published it: ${URL_A}` },
  ]);
  await page.evaluate(async (sid) => {
    const m = window.__PR_MOCK__!;
    m.setTitle(sid, 'Refactor billing pipeline and reconcile ledgers');
    // A model bundle, so the model chip and its picker are on screen (test data only).
    await window.__PR_STORE__!.setPrefs({
      models: {
        bundles: [
          {
            id: 'daily',
            name: 'Daily',
            emoji: '\u2600\uFE0F',
            entries: [
              { id: 'opus', tool: 'claude-code', model: 'claude-opus-5-5' },
              { id: 'fable', tool: 'claude-code', model: 'claude-fable-5-1' },
              { id: 'sonnet', tool: 'claude-code', model: 'claude-sonnet-4-6' },
              { id: 'custom', tool: 'claude-code', model: 'claude-opus-4-8[1m]' },
            ],
            defaultEntry: 'opus',
          },
        ],
        defaultBundle: 'daily',
        perFolder: {},
        perSection: {},
        perSession: {},
        labels: {},
        groupLabels: { cloud: '\u2601\uFE0F {name}', local: '\u{1F3E0} {name}' },
        seen: ['claude-opus-5-5'],
        offered: ['claude-sonnet-5-5', 'claude-opus-5-5'],
      },
    });
    m.setStatus(sid, 'idle');
    m.setStatusline(sid, '', {
      model: 'Opus 5.5',
      modelId: 'claude-opus-5-5',
      contextPct: 41,
      cost: 1.82,
      mode: 'acceptEdits',
      branch: 'feat/a-rather-long-branch-name',
    });
  }, id);
  await expect(page.getByTestId('model-chip')).toBeVisible();
  return id;
}

async function openPane(page: Page): Promise<void> {
  await page.evaluate((u) => window.__PR_STORE__!.openLink(u, { target: 'patchroom' }), URL_A);
  await expect(page.getByTestId('viewer-title')).toHaveText('Page at claude.ai');
}

const viewerLog = (page: Page) => page.evaluate(() => [...window.__PR_MOCK__!.viewer]);

/** With the pane open, an overlay freezes the viewer, then it comes back once it closes. */
async function expectViewerStepsAside(page: Page, from: number): Promise<number> {
  await expect
    .poll(async () => (await viewerLog(page)).slice(from).join(' '))
    .toMatch(/snapshot.*hide/);
  await expect(page.getByTestId('viewer-still')).toBeVisible();
  return (await viewerLog(page)).length;
}
async function expectViewerBack(page: Page, from: number): Promise<void> {
  await expect.poll(async () => (await viewerLog(page)).slice(from).join(' ')).toMatch(/reveal/);
  await expect(page.getByTestId('viewer-still')).toHaveCount(0);
}

for (const scheme of SCHEMES) {
  for (const size of SIZES) {
    test(`overlap QA: ${size.name} ${size.width}px, ${scheme}`, async ({ page }) => {
      test.setTimeout(120_000);
      await page.emulateMedia({ colorScheme: scheme });
      await setup(page, size.width, size.height);
      const where = (s: string) => `${s} @ ${size.name} ${scheme}`;
      const check = async (s: string, scope?: string) =>
        expect(await overlapFindings(page, { scope }), where(s)).toEqual([]);

      if (size.pane) await openPane(page);

      // A message sent while Claude is busy: the queued bubble below the live turn.
      const sid = await page.evaluate(() => window.__PR_MOCK__!.sessions()[0].id);
      await page.evaluate((x) => window.__PR_MOCK__!.setStatus(x, 'busy'), sid);
      await page.getByTestId('composer-input').fill('then run the full test suite please');
      await page.keyboard.press('Enter');
      await expect(page.getByTestId('queued-msg')).toBeVisible();
      await check('queued bubble');
      await page.evaluate((x) => {
        const m = window.__PR_MOCK__!;
        m.dequeue(x);
        m.setStatus(x, 'idle');
      }, sid);
      await expect(page.getByTestId('queued-msg')).toHaveCount(0);

      // Sidebar, header, chat, composer, status strip and pane, together.
      await check('main screen');
      expect(await ringFindings(page, '.side'), where('sidebar rings')).toEqual([]);

      // Dictation: the Listening pill and live words in the box, then a denied notice.
      const say = (ev: Record<string, unknown>) =>
        page.evaluate((e) => window.__PR_MOCK__!.dictate(e as never), ev);
      await page.getByTestId('dictate-btn').click();
      await say({ type: 'ready' });
      await say({
        type: 'partial',
        text: 'refactor the ledger reconcile job so each account runs on its own and the public API stays stable',
      });
      await expect(page.getByTestId('dictate-btn')).toHaveAttribute('data-phase', 'listening');
      await check('dictation listening');
      await page.keyboard.press('Escape');
      await say({ type: 'ended', reason: 'stopped' });
      // The first run with words offers its settings once, above the status strip.
      await expect(page.locator('[data-hint="dictation.settings"]')).toBeVisible();
      await check('dictation first-use hint');
      await page.getByRole('button', { name: 'Dismiss hint' }).click();
      await page.getByTestId('composer-input').fill('');
      await page.getByTestId('dictate-btn').click();
      await say({
        type: 'error',
        code: 'on_device_unavailable',
        language: 'Chinese, Traditional (Hong Kong)',
      });
      await say({ type: 'ended', reason: 'error' });
      await expect(page.getByTestId('dictation-notice')).toBeVisible();
      await check('dictation unavailable notice');
      await page.getByTestId('dictation-dismiss').click();

      // The hover bar of a named row and of a continuation row (the tool rows).
      const named = page.locator('.msg.head[data-key]').first();
      await named.hover();
      await check('hover bar on a named row');
      const cont = page.locator('.msg.cont[data-key="qa2"]');
      await cont.scrollIntoViewIfNeeded();
      await cont.hover();
      await check('hover bar on a tool row');
      // Its actions open as a popover from the gutter.
      await cont.getByRole('button', { name: 'Message actions' }).click();
      const pop = page.getByRole('toolbar', { name: 'Message actions' }).last();
      await expect(pop).toBeVisible();
      await check('hover popover', '.hbar-pop');
      await page.keyboard.press('Escape');

      // Ask cards in their newer states: a permission that moved to the terminal after its
      // wait (explanation plus button), and a question and a plan that reached the permission
      // path as plain permission prompts (shown as their own cards, answered in the terminal).
      await page.evaluate((x) => {
        const m = window.__PR_MOCK__!;
        m.emitPrompt(x, {
          promptId: 'qa-moved',
          kind: 'permission',
          toolName: 'Bash',
          toolInput: { command: 'pnpm -C ui build && pnpm -C ui lint && cargo test --workspace' },
        });
        m.resolvePrompt(x, 'qa-moved', 'timeout');
        m.emitPrompt(x, {
          promptId: 'qa-rawq',
          kind: 'permission',
          toolName: 'AskUserQuestion',
          toolInput: {
            questions: [
              {
                question: 'Which of the two migration strategies should the ledger reconcile use?',
                header: 'Strategy',
                multiSelect: false,
                options: [{ label: 'Online' }, { label: 'Offline' }],
              },
            ],
          },
        });
        m.emitPrompt(x, {
          promptId: 'qa-rawp',
          kind: 'permission',
          toolName: 'ExitPlanMode',
          toolInput: { plan: '## Plan\n\n1. Split the ledger job\n2. Reconcile per account\n' },
        });
      }, sid);
      const moved = page.locator('[data-moved="terminal"]');
      await expect(moved).toBeVisible();
      await moved.scrollIntoViewIfNeeded();
      await check('ask card moved to the terminal');
      const rawPlan = page.locator('.ask[data-kind="plan"][data-state="pending"]');
      await rawPlan.scrollIntoViewIfNeeded();
      await expect(page.locator('.ask[data-kind="question"][data-state="pending"]')).toBeVisible();
      await check('question and plan cards answered in the terminal');
      expect(await ringFindings(page, '.chat .ask'), where('ask card rings')).toEqual([]);
      await page.evaluate((x) => {
        const m = window.__PR_MOCK__!;
        m.resolvePrompt(x, 'qa-rawq', 'interrupt');
        m.resolvePrompt(x, 'qa-rawp', 'interrupt');
      }, sid);

      // A chat draft and the switch to the terminal: first the one-time hint (carry off), then
      // the "Draft moved" note (carry on), each over the terminal view.
      const box = page.getByTestId('composer-input');
      await box.fill('refactor the ledger reconcile job and keep the public API stable');
      await page.keyboard.press('Meta+j');
      await expect(page.getByTestId('hint')).toContainText('Your draft stayed in chat');
      await check('draft hint over the terminal');
      await page.getByTestId('hint').getByRole('button', { name: 'Turn on' }).click();
      await page.keyboard.press('Meta+j');
      await page.keyboard.press('Meta+j');
      await expect(page.getByTestId('term-toast')).toBeVisible();
      await check('draft moved note over the terminal');
      await page.keyboard.press('Meta+j');
      await expect(page.getByTestId('view-label')).toHaveText('Chat');

      if (!size.pane) return;

      // Every overlay draws over the pane: the native viewer steps aside for each.
      let mark = (await viewerLog(page)).length;

      // Settings, every section.
      await page.keyboard.press('Meta+,');
      const dlg = page.getByRole('dialog', { name: 'Settings' });
      await expect(dlg).toBeVisible();
      mark = await expectViewerStepsAside(page, mark);
      for (const t of await dlg
        .getByRole('navigation', { name: 'Settings sections' })
        .getByRole('button')
        .allTextContents()) {
        await dlg
          .getByRole('navigation', { name: 'Settings sections' })
          .getByRole('button', { name: t, exact: true })
          .click();
        await check(`Settings > ${t}`, '.prefs');
        expect(await ringFindings(page, '.prefs__main'), where(`Settings > ${t} rings`)).toEqual(
          [],
        );
      }
      // Settings search: results, then a chosen row with its flash ring.
      await page.keyboard.press('Meta+f');
      await page.keyboard.type('font');
      await expect(dlg.getByTestId('prefs-results')).toBeVisible();
      await check('Settings search results', '.prefs');
      expect(await ringFindings(page, '.prefs__side'), where('search rings')).toEqual([]);
      await dlg.locator('.pres').first().click();
      await expect(dlg.getByTestId('pf-flash')).toBeVisible();
      await check('Settings search flash', '.prefs');
      // A font picker over Settings.
      await dlg.getByTestId('font-family-chat').click();
      await expect(page.locator('.floating.flist')).toBeVisible();
      await check('font picker', '.floating.flist');
      expect(await ringFindings(page, '.floating.flist'), where('font picker rings')).toEqual([]);
      await page.keyboard.press('Escape');
      await expect(page.locator('.floating.flist')).toHaveCount(0);
      // Esc clears the search, the next closes Settings.
      await page.keyboard.press('Escape');
      await expect(dlg.getByTestId('prefs-search')).toHaveValue('');
      await page.keyboard.press('Escape');
      await expect(dlg).toHaveCount(0);
      await expectViewerBack(page, mark);
      mark = (await viewerLog(page)).length;

      // Cmd+K.
      await page.keyboard.press('Meta+k');
      await expect(page.locator('.qs, [role="dialog"]').first()).toBeVisible();
      mark = await expectViewerStepsAside(page, mark);
      await check('quick switcher');
      await page.keyboard.press('Escape');
      await expectViewerBack(page, mark);
      mark = (await viewerLog(page)).length;

      // Search.
      await page.keyboard.press('Meta+Shift+f');
      mark = await expectViewerStepsAside(page, mark);
      await check('search');
      await page.keyboard.press('Escape');
      await expectViewerBack(page, mark);
      mark = (await viewerLog(page)).length;

      // A menu (the sidebar's + menu) and a picker (the reaction picker).
      await page.getByRole('button', { name: 'Create new' }).click();
      await expect(page.getByRole('menu')).toBeVisible();
      mark = await expectViewerStepsAside(page, mark);
      await check('new menu', '.floating');
      expect(await ringFindings(page, '.floating'), where('menu rings')).toEqual([]);
      await page.keyboard.press('Escape');
      await expectViewerBack(page, mark);
      mark = (await viewerLog(page)).length;

      await named.hover();
      await named.getByRole('button', { name: 'React' }).click();
      const picker = page.locator('.floating.picker');
      await expect(picker).toBeVisible();
      mark = await expectViewerStepsAside(page, mark);
      await check('emoji picker', '.floating.picker');
      expect(await ringFindings(page, '.floating.picker'), where('picker rings')).toEqual([]);
      await page.keyboard.press('Escape');
      await expectViewerBack(page, mark);
      mark = (await viewerLog(page)).length;

      // The model picker on the status strip.
      await page.getByTestId('model-chip').click();
      await expect(page.locator('.floating.mpick')).toBeVisible();
      mark = await expectViewerStepsAside(page, mark);
      await check('model picker', '.floating.mpick');
      expect(await ringFindings(page, '.floating.mpick'), where('model picker rings')).toEqual([]);
      await page.keyboard.press('Escape');
      await expectViewerBack(page, mark);
      mark = (await viewerLog(page)).length;

      // Rename a session: the emoji picker with its Apple or Noto style choice.
      await page.locator('.side [data-dm]').first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Rename...' }).click();
      await check('session rename row', '.side');
      await page.getByTestId('sec-emoji-btn').click();
      const flavors = page.locator('.floating.picker');
      await expect(flavors.getByTestId('emoji-flavor-noto')).toBeVisible();
      mark = await expectViewerStepsAside(page, mark);
      await check('emoji picker with styles', '.floating.picker');
      expect(await ringFindings(page, '.floating.picker'), where('style picker rings')).toEqual([]);
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');
      await expectViewerBack(page, mark);
      mark = (await viewerLog(page)).length;

      // A session's own chat font, from its sidebar menu.
      await page.locator('.side [data-dm]').first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Chat font...' }).click();
      await expect(page.locator('.floating.cfont')).toBeVisible();
      mark = await expectViewerStepsAside(page, mark);
      await check('chat font popover', '.floating.cfont');
      expect(await ringFindings(page, '.floating.cfont'), where('chat font rings')).toEqual([]);
      await page.keyboard.press('Escape');
      await expectViewerBack(page, mark);
      mark = (await viewerLog(page)).length;

      // Restart Patchroom while a session works: the dialog over the pane.
      await page.evaluate(() => {
        const m = window.__PR_MOCK__!;
        m.setStatus(m.sessions()[0].id, 'busy');
        m.menuRestart();
      });
      await expect(page.getByTestId('restart-dialog')).toBeVisible();
      mark = await expectViewerStepsAside(page, mark);
      await check('restart dialog', '.restart');
      expect(await ringFindings(page, '.restart'), where('restart rings')).toEqual([]);
      await page.getByTestId('restart-dialog').getByRole('button', { name: 'Cancel' }).click();
      await expectViewerBack(page, mark);
      await page.evaluate(() => {
        const m = window.__PR_MOCK__!;
        m.setStatus(m.sessions()[0].id, 'idle');
      });
      mark = (await viewerLog(page)).length;

      // The screenshot overlay: drag a box that covers part of the pane, then the note box.
      await page.getByTestId('shot-btn').click();
      const shot = page.getByTestId('shot');
      await expect(shot).toBeVisible();
      mark = await expectViewerStepsAside(page, mark);
      const vp = (await page.getByTestId('viewer').boundingBox())!;
      await page.mouse.move(vp.x - 120, vp.y + 80);
      await page.mouse.down();
      await page.mouse.move(vp.x + 80, vp.y + 220, { steps: 4 });
      await page.mouse.up();
      await expect(page.getByTestId('shot-note')).toBeVisible();
      await check('screenshot note', '.shot');
      await page.keyboard.press('Escape');
      await expect(shot).toHaveCount(0);
      await expectViewerBack(page, mark);

      // The pane's sign-in line, the hint line: in flow, no overlap.
      await page.evaluate(
        (u) => window.__PR_MOCK__!.viewerAccount(false, u),
        await page.evaluate(() => window.__PR_STORE__!.getSnapshot().viewer!.url),
      );
      await expect(page.getByTestId('viewer-signin')).toBeVisible();
      await page.getByTestId('viewer-browser').click();
      await page.evaluate(() => window.dispatchEvent(new Event('focus')));
      await expect(page.getByTestId('hint')).toBeVisible();
      await expectNoOverlap(page);
    });
  }
}
