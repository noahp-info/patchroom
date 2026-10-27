import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openWithDm, seedChat } from './helpers';

/*
 * Vision pass screenshots for the model bundles batch: the model chip and picker, the strip
 * hint, the auto-scroll indicator, Settings > Models, Updates, emoji and labels, the restart
 * dialog and the emoji style picker. Skipped unless PR_VISION_DIR names an output folder:
 *   PR_VISION_DIR=/tmp/pr-vision pnpm -C ui exec playwright test tests/vision-batch.spec.ts
 */

const OUT = process.env.PR_VISION_DIR ?? '';
const SIZES = [
  { name: '880', width: 880, height: 600 },
  { name: '1100', width: 1100, height: 760 },
  { name: '1440', width: 1440, height: 900 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

async function setup(page: Page, width: number, height: number, offered = true) {
  await page.setViewportSize({ width, height });
  const id = await openWithDm(page, 'mock', 'chat');
  await seedChat(page, id);
  await page.evaluate(
    async ({ sid, offered }) => {
      const m = window.__PR_MOCK__!;
      await window.__PR_STORE__!.setPrefs({
        models: {
          bundles: [
            {
              id: 'daily',
              name: 'Daily',
              emoji: '☀️',
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
          labels: { 'claude-fable-5-1': { text: 'Deep', emoji: '\u{1F9E0}' } },
          groupLabels: { cloud: '☁️ {name}', local: '\u{1F3E0} {name}' },
          seen: ['claude-opus-5-5'],
          offered: offered ? ['claude-sonnet-5-5', 'claude-opus-5-5'] : [],
        },
        statusBar: {
          default: null,
          perDm: {},
          labels: { cost: { text: 'Spend', emoji: '\u{1F4B8}' } },
        },
      } as never);
      m.setStatus(sid, 'idle');
      m.setStatusline(sid, '', {
        model: 'Opus 5.5',
        modelId: 'claude-opus-5-5',
        contextPct: 41,
        cost: 1.82,
        mode: 'acceptEdits',
        branch: 'feat/batch-bundles',
      });
    },
    { sid: id, offered },
  );
  await expect(page.getByTestId('model-chip')).toBeVisible();
  return id;
}

for (const scheme of SCHEMES) {
  for (const size of SIZES) {
    test(`vision batch: ${size.name} ${scheme}`, async ({ page }) => {
      test.skip(!OUT, 'set PR_VISION_DIR to write the vision-pass screenshots');
      test.setTimeout(120_000);
      mkdirSync(OUT, { recursive: true });
      await page.emulateMedia({ colorScheme: scheme });
      const shot = (name: string) =>
        page.screenshot({ path: join(OUT, `${name}-${size.name}-${scheme}.png`) });

      // The newer-model hint by the chip (Swap and Keep).
      await setup(page, size.width, size.height, false);
      await expect(page.locator('[data-hint="models.newer"]')).toBeVisible();
      await shot('strip-hint');

      const id = await setup(page, size.width, size.height);
      await shot('chat-main');

      await page.getByTestId('model-chip').click();
      await expect(page.locator('.floating.mpick')).toBeVisible();
      await shot('model-picker');
      await page.keyboard.press('Escape');

      await page.getByTestId('chat-log').evaluate((el) => (el.scrollTop = 0));
      await expect(page.getByTestId('autoscroll')).toHaveAttribute('data-state', 'paused');
      await expect(page.locator('[data-hint="scroll.paused"]')).toBeVisible();
      await shot('chat-paused');
      await page.getByTestId('jump-latest').click();

      await page.locator('.side [data-dm]').first().click({ button: 'right' });
      await page.getByRole('menuitem', { name: 'Rename...' }).click();
      await page.getByTestId('sec-emoji-btn').click();
      await expect(page.locator('.floating.picker')).toBeVisible();
      await shot('emoji-styles');
      await page.keyboard.press('Escape');
      await page.keyboard.press('Escape');

      await page.evaluate((sid) => {
        window.__PR_MOCK__!.setStatus(sid, 'busy');
        window.__PR_MOCK__!.menuRestart();
      }, id);
      await expect(page.getByTestId('restart-dialog')).toBeVisible();
      await shot('restart-dialog');
      await page.getByTestId('restart-dialog').getByRole('button', { name: 'Cancel' }).click();

      for (const [tab, name, sel] of [
        ['models', 'settings-models', null],
        ['updates', 'settings-updates', null],
        ['themes', 'settings-themes-emoji', '[data-testid="emoji-chat"]'],
        ['statusbar', 'settings-statusbar-labels', '[data-testid="sb-labels"]'],
      ] as const) {
        await page.evaluate((t) => window.__PR_STORE__!.openPrefs({ tab: t }), tab);
        await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
        if (sel) await page.locator(sel).scrollIntoViewIfNeeded();
        await shot(name);
        await page.keyboard.press('Escape');
        await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);
      }
    });
  }
}
