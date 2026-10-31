import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openWithDm, seedChat } from './helpers';

/*
 * Screenshots for the local vision pass (CLAUDE.md, "UI work: overlap rule"). Skipped unless
 * PR_VISION_DIR names an output folder:
 *   PR_VISION_DIR=/tmp/pr-vision pnpm -C ui exec playwright test tests/vision-shots.spec.ts
 * The same surfaces and widths as overlap-qa.spec.ts, one PNG each, for context-free judges.
 */

const OUT = process.env.PR_VISION_DIR ?? '';
const SIZES = [
  { name: '880', width: 880, height: 600 },
  { name: '1100-split', width: 1100, height: 760 },
  { name: '1440', width: 1440, height: 900 },
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
  return id;
}

for (const scheme of SCHEMES) {
  for (const size of SIZES) {
    test(`vision shots ${size.name} ${scheme}`, async ({ page }) => {
      test.skip(!OUT, 'set PR_VISION_DIR to take the vision-pass screenshots');
      test.setTimeout(120_000);
      const dir = join(OUT, `${size.name}-${scheme}`);
      mkdirSync(dir, { recursive: true });
      const shot = (name: string) => page.screenshot({ path: join(dir, `${name}.png`) });
      await page.emulateMedia({ colorScheme: scheme });
      await setup(page, size.width, size.height);
      await page.evaluate(() => {
        const s = window.__PR_STORE__!.getSnapshot();
        window.__PR_MOCK__!.setStatus(s.activeId!, 'waiting', 'permission');
      });
      await shot('01-main');
      // Dictation: listening with live words, the first-use hint, the unavailable notice.
      const say = (ev: Record<string, unknown>) =>
        page.evaluate((e) => window.__PR_MOCK__!.dictate(e as never), ev);
      await page.getByTestId('dictate-btn').click();
      await say({ type: 'ready' });
      await say({ type: 'partial', text: 'refactor the ledger reconcile job so each account' });
      await shot('01a-dictation-listening');
      await page.keyboard.press('Escape');
      await say({
        type: 'final',
        text: 'Refactor the ledger reconcile job so each account runs alone.',
      });
      await say({ type: 'ended', reason: 'stopped' });
      await expect(page.locator('[data-hint="dictation.settings"]')).toBeVisible();
      await shot('01b-dictation-hint');
      await page.getByRole('button', { name: 'Dismiss hint' }).click();
      await page.getByTestId('composer-input').fill('');
      await page.getByTestId('dictate-btn').click();
      await say({ type: 'error', code: 'on_device_unavailable', language: 'French (France)' });
      await say({ type: 'ended', reason: 'error' });
      await shot('01c-dictation-unavailable');
      await page.getByTestId('dictation-dismiss').click();
      await page.getByTestId('dictate-btn').click();
      await say({ type: 'error', code: 'mic_denied' });
      await say({ type: 'ended', reason: 'error' });
      await shot('01d-dictation-mic-denied');
      await page.getByTestId('dictation-dismiss').click();
      const named = page.locator('.msg.head[data-key]').first();
      await named.hover();
      await shot('02-hover-named');
      const cont = page.locator('.msg.cont[data-key="qa2"]');
      await cont.scrollIntoViewIfNeeded();
      await cont.hover();
      await cont.getByRole('button', { name: 'Message actions' }).click();
      await shot('03-hover-tool-row-popover');
      await page.keyboard.press('Escape');
      if (size.name !== '880') {
        await page.evaluate(
          (u) => window.__PR_STORE__!.openLink(u, { target: 'patchroom' }),
          URL_A,
        );
        await expect(page.getByTestId('viewer-title')).toHaveText('Page at claude.ai');
        await shot('04-side-pane');
      }
      await page.keyboard.press('Meta+,');
      const dlg = page.getByRole('dialog', { name: 'Settings' });
      for (const t of ['Themes', 'Terminal', 'Sounds', 'Links', 'Dictation', 'Accounts']) {
        await dlg
          .getByRole('navigation', { name: 'Settings sections' })
          .getByRole('button', { name: t, exact: true })
          .click();
        if (t === 'Sounds')
          await page.getByRole('button', { name: 'Use Lab Glass for every event' }).click();
        await shot(`05-settings-${t.toLowerCase()}`);
      }
      await page.keyboard.press('Escape');
      await page.keyboard.press('Meta+k');
      await shot('06-quick-switcher');
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'Create new' }).click();
      await shot('07-new-menu');
      await page.keyboard.press('Escape');
      await named.hover();
      await named.getByRole('button', { name: 'React' }).click();
      await shot('08-emoji-picker');
      await page.keyboard.press('Escape');
      await page.getByTestId('shot-btn').click();
      const w = size.width;
      await page.mouse.move(w - 520, 140);
      await page.mouse.down();
      await page.mouse.move(w - 260, 300, { steps: 4 });
      await page.mouse.up();
      await page.getByLabel('Steer note').fill('This overlaps the title');
      await shot('09-screenshot-note');
      await page.getByRole('button', { name: 'Add screenshot to message' }).click();
      if (size.name !== '880') {
        await page.evaluate(
          (u) => window.__PR_MOCK__!.viewerAccount(false, u),
          await page.evaluate(() => window.__PR_STORE__!.getSnapshot().viewer!.url),
        );
        await page.evaluate(() => {
          window.__PR_MOCK__!.viewerPicked = 'The quarterly totals do not add up';
          window.__PR_MOCK__!.menuComment();
        });
        await page.getByTestId('viewer-browser').click();
        await page.evaluate(() => window.dispatchEvent(new Event('focus')));
        await expect(page.getByTestId('hint')).toBeVisible();
      }
      await shot('10-signin-hint-composer-lines');
    });
  }
}
