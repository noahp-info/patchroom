import { expect, test, type Page } from '@playwright/test';
import { chooseNew, watchErrors } from './helpers';
import type { ModelPrefs } from '../src/ipc/types';

/**
 * Model bundles: launch on the default, switch from the chip only while idle, confirm through the
 * statusline, labels, the newer-model offer and the opt-in catalog. Test scenario only: the bundle
 * "Daily" below is never configured for anyone, it lives in this file.
 */

const DAILY: ModelPrefs = {
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
  labels: {},
  groupLabels: { cloud: '☁️ {name}', local: '\u{1F3E0} {name}' },
  // The label offer is for models after the first, so seed one seen model.
  seen: ['claude-opus-5-5'],
  // Sonnet 5.5 and Opus 5.5 are newer than two entries; offered already, so tests start quiet.
  offered: ['claude-sonnet-5-5', 'claude-opus-5-5'],
};

async function seedModels(page: Page, models: ModelPrefs, extra: Record<string, unknown> = {}) {
  await page.waitForFunction(
    () => !!window.__PR_STORE__ && !!window.__PR_STORE__.getSnapshot().prefs,
  );
  await page.evaluate(
    async ({ m, x }) => {
      await window.__PR_STORE__!.setPrefs({ models: m, ...x } as never);
    },
    { m: models, x: extra },
  );
}

/** Start a session through the dialog; the mock's statusline then reports its launch model. */
async function newSession(page: Page): Promise<string> {
  await chooseNew(page, 'New session');
  const dlg = page.getByRole('dialog', { name: 'New session' });
  await dlg.getByLabel('Folder').fill('/tmp/patchroom-models');
  await dlg.getByRole('button', { name: 'Start session' }).click();
  await page.getByTestId('chat').waitFor();
  const id = await page.evaluate(() => window.__PR_MOCK__!.sessions().at(-1)!.id);
  await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'idle'), id);
  return id;
}

const chip = (page: Page) => page.getByTestId('model-chip');

test.describe('model bundles', () => {
  test('a new session launches on the bundle default through --model', async ({ page }) => {
    const errs = watchErrors(page);
    await page.goto('/?mock');
    await seedModels(page, DAILY);
    await newSession(page);
    const args = await page.evaluate(() => window.__PR_MOCK__!.creates.at(-1)!.args);
    expect(args).toEqual(['--model', 'claude-opus-5-5']);
    // The cloud template names the model the CLI reports.
    await expect(chip(page)).toHaveText('☁️ Opus 5.5');
    expect(errs).toEqual([]);
  });

  test('no bundle: sessions launch with no model flag', async ({ page }) => {
    await page.goto('/?mock');
    await page.waitForFunction(() => !!window.__PR_STORE__?.getSnapshot().prefs);
    await newSession(page);
    const args = await page.evaluate(() => window.__PR_MOCK__!.creates.at(-1)!.args);
    expect(args).toBeUndefined();
  });

  test('the picker lists the bundle and switches while idle, then confirms', async ({ page }) => {
    await page.goto('/?mock');
    await seedModels(page, DAILY);
    const id = await newSession(page);
    await expect(chip(page)).toContainText('Opus 5.5');
    await chip(page).click();
    const pop = page.getByRole('dialog', { name: 'Models' });
    await expect(pop.getByTestId('mpick-bundle')).toContainText('Daily');
    await expect(pop.getByRole('listbox').getByRole('option')).toHaveCount(4);
    await expect(pop.getByRole('listbox').getByRole('option', { selected: true })).toContainText(
      'Opus 5.5',
    );
    await pop.getByRole('option', { name: /Fable 5\.1/ }).click();
    await expect(chip(page)).toContainText('Fable 5.1');
    const sent = await page.evaluate(() => window.__PR_MOCK__!.texts.map((t) => t.text));
    expect(sent).toContain('/model claude-fable-5-1');
    // A confirmed switch is remembered, so a resume comes back on it.
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.modelSets))
      .toEqual([{ id, model: 'claude-fable-5-1' }]);
  });

  test('a free-text model string switches too', async ({ page }) => {
    await page.goto('/?mock');
    await seedModels(page, DAILY);
    await newSession(page);
    await chip(page).click();
    await page
      .getByRole('dialog', { name: 'Models' })
      .getByRole('option', { name: /Opus 4\.8 \[1m\]/ })
      .click();
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.texts.map((t) => t.text)))
      .toContain('/model claude-opus-4-8[1m]');
    // The CLI reports the base id; the switch still counts as taken.
    await expect(page.getByTestId('mpick-switch')).toHaveCount(0);
  });

  test('never switches while Claude is busy', async ({ page }) => {
    await page.goto('/?mock');
    await seedModels(page, DAILY);
    const id = await newSession(page);
    await page.evaluate((sid) => window.__PR_MOCK__!.setStatus(sid, 'busy'), id);
    await chip(page).click();
    const pop = page.getByRole('dialog', { name: 'Models' });
    await expect(pop.getByTestId('mpick-busy')).toBeVisible();
    await expect(pop.getByRole('option', { name: /Fable/ })).toBeDisabled();
    const sent = await page.evaluate(() => window.__PR_MOCK__!.texts.map((t) => t.text));
    expect(sent.filter((t) => t.startsWith('/model'))).toEqual([]);
  });

  test('a switch the CLI did not take shows why', async ({ page }) => {
    test.setTimeout(30_000);
    await page.goto('/?mock');
    await seedModels(page, DAILY);
    await newSession(page);
    await page.evaluate(() => (window.__PR_MOCK__!.modelSwitchWorks = false));
    await chip(page).click();
    await page
      .getByRole('dialog', { name: 'Models' })
      .getByRole('option', { name: /Sonnet 4\.6/ })
      .click();
    await expect(chip(page)).toContainText('Switching to Sonnet 4.6');
    await expect(chip(page)).toHaveAttribute('data-state', 'error', { timeout: 12_000 });
    // The picker stays open and says why.
    await expect(page.getByTestId('mpick-switch')).toContainText(
      'Claude did not switch to Sonnet 4.6. It still reports claude-opus-5-5.',
    );
    expect(await page.evaluate(() => window.__PR_MOCK__!.modelSets)).toEqual([]);
  });

  test('labels: own label, then the Local template, and they follow the model', async ({
    page,
  }) => {
    await page.goto('/?mock');
    await seedModels(page, {
      ...DAILY,
      labels: { 'claude-fable-5-1': { text: 'Deep', emoji: '\u{1F9E0}' } },
    });
    const id = await newSession(page);
    await page.evaluate(
      (sid) =>
        window.__PR_MOCK__!.setStatusline(sid, '', {
          model: 'Opus 5.5',
          modelId: 'claude-opus-5-5',
          apiLocal: true,
        }),
      id,
    );
    await expect(chip(page)).toHaveText('\u{1F3E0} Opus 5.5');
    await page.evaluate(
      (sid) =>
        window.__PR_MOCK__!.setStatusline(sid, '', {
          model: 'Fable 5.1',
          modelId: 'claude-fable-5-1',
        }),
      id,
    );
    await expect(chip(page)).toHaveText('\u{1F9E0} Deep');
  });

  test('a new model offers its own label once', async ({ page }) => {
    await page.goto('/?mock');
    await seedModels(page, DAILY);
    const id = await newSession(page);
    await page.evaluate(
      (sid) =>
        window.__PR_MOCK__!.setStatusline(sid, '', {
          model: 'Haiku 5.5',
          modelId: 'claude-haiku-5-5',
        }),
      id,
    );
    const hint = page.locator('[data-hint="models.label"]');
    await expect(hint).toContainText('New model: Haiku 5.5');
    await hint.getByRole('button', { name: 'Dismiss hint' }).click();
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.prefs().models?.seen))
      .toContain('claude-haiku-5-5');
  });

  test('newer model available: Swap replaces the pinned entry, once', async ({ page }) => {
    await page.goto('/?mock');
    const old: ModelPrefs = {
      ...DAILY,
      offered: [],
      bundles: [
        {
          ...DAILY.bundles[0],
          entries: [
            { id: 'opus', tool: 'claude-code', model: 'claude-opus-5' },
            { id: 'sonnet', tool: 'claude-code', model: 'claude-sonnet-5-5' },
          ],
        },
      ],
    };
    await seedModels(page, old);
    await newSession(page);
    const hint = page.locator('[data-hint="models.newer"]');
    await expect(hint).toContainText('Opus 5.5 is out, newer than Opus 5');
    await hint.getByRole('button', { name: 'Swap' }).click();
    await expect
      .poll(() =>
        page.evaluate(() => window.__PR_MOCK__!.prefs().models?.bundles[0].entries[0].model),
      )
      .toBe('claude-opus-5-5');
    expect(await page.evaluate(() => window.__PR_MOCK__!.prefs().models?.offered)).toEqual([
      'claude-opus-5-5',
    ]);
  });

  test('Keep leaves the entry and the offer never comes back', async ({ page }) => {
    await page.goto('/?mock');
    await seedModels(page, {
      ...DAILY,
      offered: [],
      bundles: [
        {
          ...DAILY.bundles[0],
          entries: [{ id: 'opus', tool: 'claude-code', model: 'claude-opus-5' }],
          defaultEntry: 'opus',
        },
      ],
    });
    await newSession(page);
    const hint = page.locator('[data-hint="models.newer"]');
    await hint.getByRole('button', { name: 'Keep' }).click();
    await expect(hint).toHaveCount(0);
    expect(
      await page.evaluate(() => window.__PR_MOCK__!.prefs().models?.bundles[0].entries[0].model),
    ).toBe('claude-opus-5');
    await newSession(page);
    await expect(page.locator('[data-hint="models.newer"]')).toHaveCount(0);
  });

  test('"latest <family>" launches the newest model of that family', async ({ page }) => {
    await page.goto('/?mock');
    await seedModels(page, {
      ...DAILY,
      bundles: [
        {
          ...DAILY.bundles[0],
          entries: [{ id: 'l', tool: 'claude-code', model: 'latest:sonnet' }],
          defaultEntry: 'l',
        },
      ],
    });
    await newSession(page);
    const args = await page.evaluate(() => window.__PR_MOCK__!.creates.at(-1)!.args);
    expect(args).toEqual(['--model', 'claude-sonnet-5-5']);
  });

  test('a session bundle override wins over the default', async ({ page }) => {
    await page.goto('/?mock');
    const two: ModelPrefs = {
      ...DAILY,
      bundles: [
        ...DAILY.bundles,
        {
          id: 'cheap',
          name: 'Cheap',
          entries: [{ id: 'h', tool: 'claude-code', model: 'claude-haiku-5-5' }],
          defaultEntry: 'h',
        },
      ],
    };
    await seedModels(page, two);
    const id = await newSession(page);
    await chip(page).click();
    await page.getByTestId('mpick-bundle-select').selectOption('cheap');
    await expect(page.getByTestId('mpick-bundle')).toContainText('Cheap');
    await expect(
      page.getByRole('dialog', { name: 'Models' }).getByRole('listbox').getByRole('option'),
    ).toHaveCount(1);
    expect(await page.evaluate(() => window.__PR_MOCK__!.prefs().models?.perSession)).toEqual({
      [id]: 'cheap',
    });
  });
});

test.describe('opt-in model and update checks (D3)', () => {
  test('nothing fetches by default', async ({ page }) => {
    await page.goto('/?mock');
    await seedModels(page, DAILY);
    await newSession(page);
    await page.waitForTimeout(300);
    expect(await page.evaluate(() => window.__PR_MOCK__!.fetches)).toEqual({
      catalog: 0,
      update: 0,
    });
    const updates = await page.evaluate(() => window.__PR_MOCK__!.prefs().updates);
    expect(updates?.checkApp ?? false).toBe(false);
    expect(updates?.checkModels ?? false).toBe(false);
  });

  test('the picker asks once: Not now fetches nothing and the question goes', async ({ page }) => {
    await page.goto('/?mock');
    await seedModels(page, DAILY);
    await newSession(page);
    await chip(page).click();
    await page.getByTestId('model-ask-later').click();
    await expect(page.getByTestId('model-ask')).toHaveCount(0);
    expect(await page.evaluate(() => window.__PR_MOCK__!.fetches.catalog)).toBe(0);
    expect(await page.evaluate(() => window.__PR_MOCK__!.prefs().updates?.askedModels)).toBe(true);
  });

  test('Turn on fetches the signed catalog and new models appear', async ({ page }) => {
    await page.goto('/?mock');
    await page.evaluate(() => {
      window.__PR_MOCK__!.remoteCatalog = {
        schema: 1,
        generated: '2099-01-01',
        tools: [],
        models: [
          {
            id: 'claude-opus-9',
            tool: 'claude-code',
            name: 'Opus 9',
            family: 'opus',
            version: '9',
          },
        ],
      };
    });
    await seedModels(page, DAILY);
    await newSession(page);
    await chip(page).click();
    await page.getByTestId('model-ask-on').click();
    await expect.poll(() => page.evaluate(() => window.__PR_MOCK__!.fetches.catalog)).toBe(1);
    await expect
      .poll(() =>
        page.evaluate(() =>
          window.__PR_STORE__!.getSnapshot().catalog.models.some((m) => m.id === 'claude-opus-9'),
        ),
      )
      .toBe(true);
  });

  test('Settings > Updates: both toggles start off and Check now runs only when on', async ({
    page,
  }) => {
    await page.goto('/?mock');
    await page.waitForFunction(() => !!window.__PR_STORE__?.getSnapshot().prefs);
    await page.evaluate(() => window.__PR_STORE__!.openPrefs({ tab: 'updates' }));
    const sec = page.getByTestId('prefs-updates');
    await expect(sec.getByTestId('updates-app')).not.toBeChecked();
    await expect(sec.getByTestId('updates-models')).not.toBeChecked();
    await expect(sec.getByTestId('updates-app-now')).toHaveCount(0);
    await sec.getByTestId('updates-app').check();
    await sec.getByTestId('updates-app-now').click();
    await expect(sec.getByRole('status')).toContainText('is the newest');
    expect(await page.evaluate(() => window.__PR_MOCK__!.fetches.update)).toBe(1);
  });
});

test.describe('Settings > Models', () => {
  test('make a bundle, add a custom model string, refuse an unsafe one', async ({ page }) => {
    await page.goto('/?mock');
    await page.waitForFunction(() => !!window.__PR_STORE__?.getSnapshot().prefs);
    await page.evaluate(() => window.__PR_STORE__!.openPrefs({ tab: 'models' }));
    const sec = page.getByTestId('prefs-models');
    await expect(sec.getByTestId('bundles-empty')).toBeVisible();
    await sec.getByTestId('bundle-add').click();
    await expect(sec.locator('.mb-card')).toHaveCount(1);
    await sec.getByTestId('entry-add').click();
    const row = sec.locator('.mb-entry').nth(1);
    await row.getByLabel('Model', { exact: true }).selectOption('__custom__');
    await row.getByLabel('Model string').fill('claude-opus-4-8[1m]');
    await expect
      .poll(() =>
        page.evaluate(() => window.__PR_MOCK__!.prefs().models?.bundles[0].entries[1].model),
      )
      .toBe('claude-opus-4-8[1m]');
    await row.getByLabel('Model string').fill('x; rm -rf ~');
    await expect(row.locator('.pf-err')).toBeVisible();
    expect(
      await page.evaluate(() => window.__PR_MOCK__!.prefs().models?.bundles[0].entries[1].model),
    ).toBe('claude-opus-4-8[1m]');
    expect(await page.evaluate(() => window.__PR_MOCK__!.prefs().models?.defaultBundle)).toBe(
      await page.evaluate(() => window.__PR_MOCK__!.prefs().models?.bundles[0].id),
    );
  });

  test('labels: a Cloud/Local switch and the templates', async ({ page }) => {
    await page.goto('/?mock');
    await seedModels(page, DAILY);
    await page.evaluate(() => window.__PR_STORE__!.openPrefs({ tab: 'models' }));
    const row = page.locator('[data-label-model="claude-fable-5-1"]');
    await row.getByRole('radio', { name: 'Local' }).check({ force: true });
    await expect
      .poll(() =>
        page.evaluate(() => window.__PR_MOCK__!.prefs().models?.labels['claude-fable-5-1']?.place),
      )
      .toBe('local');
    await page.getByTestId('label-tpl-cloud').fill('Cloud: {name}');
    await expect
      .poll(() => page.evaluate(() => window.__PR_MOCK__!.prefs().models?.groupLabels.cloud))
      .toBe('Cloud: {name}');
  });
});
