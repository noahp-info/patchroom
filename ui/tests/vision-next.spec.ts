import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { openWithDm, seedChat } from './helpers';

/*
 * Vision pass screenshots for the History, Cmd+K, status bar module and model label batch.
 * Skipped unless PR_VISION_DIR names an output folder:
 *   PR_VISION_DIR=/tmp/pr-vision pnpm -C ui exec playwright test tests/vision-next.spec.ts
 */

const OUT = process.env.PR_VISION_DIR ?? '';
const SIZES = [
  { name: '880', width: 880, height: 600 },
  { name: '1100', width: 1100, height: 760 },
  { name: '1440', width: 1440, height: 900 },
] as const;
const SCHEMES = ['light', 'dark'] as const;

async function setup(page: Page, width: number, height: number): Promise<string> {
  await page.setViewportSize({ width, height });
  const id = await openWithDm(page, 'mock', 'chat');
  await seedChat(page, id);
  await page.evaluate((sid) => {
    const m = window.__PR_MOCK__!;
    m.setStatus(sid, 'idle');
    m.setStatusline(sid, '', {
      model: 'Opus 5.5',
      modelId: 'claude-opus-5-5',
      contextPct: 41,
      cost: 1.82,
      mode: 'acceptEdits',
      branch: 'feat/next-batch',
    });
    m.setHistoryFixture(1200);
    // Tie the open DM to a first message, so Cmd+K finds it by its words.
    m.historyRows[5] = {
      ...m.historyRows[5],
      dmId: sid,
      firstPrompt: 'The webhook handler retries forever when the signature fails.',
    };
  }, id);
  await expect(page.getByTestId('model-chip')).toBeVisible();
  return id;
}

for (const scheme of SCHEMES) {
  for (const size of SIZES) {
    test(`vision next batch: ${size.name} ${scheme}`, async ({ page }) => {
      test.skip(!OUT, 'set PR_VISION_DIR to write the vision-pass screenshots');
      test.setTimeout(120_000);
      mkdirSync(OUT, { recursive: true });
      await page.emulateMedia({ colorScheme: scheme });
      const shot = (name: string) =>
        page.screenshot({ path: join(OUT, `${name}-${size.name}-${scheme}.png`) });
      await setup(page, size.width, size.height);

      // History, first visit: the hint, grouped by folder.
      await page.getByTestId('nav-history').click();
      const hist = page.getByTestId('history');
      await expect(page.getByTestId('history-count')).toContainText('1200 sessions');
      await shot('history-folder');
      await hist.getByRole('button', { name: 'Date', exact: true }).click();
      await shot('history-date');
      await hist.getByRole('button', { name: 'Model', exact: true }).click();
      await page.getByTestId('history-filter').fill('login');
      await shot('history-search');
      await page.getByTestId('history-filter').fill('p95');
      const live = hist.locator('.hrow-wrap', { hasText: 'Live elsewhere' }).first();
      await live.locator('.hrow').click();
      await expect(live.getByRole('group', { name: 'Confirm open' })).toBeVisible();
      await shot('history-confirm');
      await live.getByRole('button', { name: 'Cancel' }).click();
      await page.getByTestId('history-filter').fill('');
      await hist.getByRole('button', { name: 'Folder', exact: true }).click();
      await hist
        .locator('.hgroup')
        .first()
        .getByRole('button', { name: /Show 40 more/ })
        .scrollIntoViewIfNeeded();
      await shot('history-more');
      await page.keyboard.press('Escape');
      await expect(hist).toHaveCount(0);

      // Cmd+K: a first-message hit and the closing search row.
      await page.keyboard.press('Meta+k');
      await page.keyboard.type('webhook');
      await expect(page.locator('[data-search-row]')).toBeVisible();
      await shot('switcher-prompt');
      await page.keyboard.press('Escape');

      // The status bar menu with module options open, then a full-path folder chip.
      await page.getByTestId('strip-customize').click();
      const sbm = page.getByRole('dialog', { name: 'Customize status bar' });
      await sbm.getByTestId('sbe-options-folder').click();
      await sbm.getByRole('button', { name: 'Full path' }).click();
      await sbm.getByTestId('sbe-suggest').scrollIntoViewIfNeeded();
      await shot('strip-menu-options');
      await page.keyboard.press('Escape');
      await shot('strip-full-path');

      for (const [tab, name, sel] of [
        ['models', 'settings-models-labels', '[data-setting="models.labels.local"]'],
        ['history', 'settings-history', null],
        ['statusbar', 'settings-statusbar-suggest', '[data-testid="sbe-suggest"]'],
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
