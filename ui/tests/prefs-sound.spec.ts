import { expect, test } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';

const play = (page: import('@playwright/test').Page, event: string, opts: object = {}) =>
  page.evaluate(([e, o]) => window.__PR_PREFS__.playSound(e as string, o as object), [event, opts]);
const set = (page: import('@playwright/test').Page, patch: string) =>
  page.evaluate(async (p) => {
    const h = window.__PR_PREFS__;
    const cur = h.store.getPrefs();
    const n = JSON.parse(p) as Record<string, unknown>;
    await h.store.update({ ...n, sound: { ...cur.sound, ...(n.sound as object) } } as never);
  }, patch);

test('plays by default and logs the decision', async ({ page }) => {
  await openPrefs(page);
  expect(await play(page, 'needs')).toEqual({ play: true });
  const log = await page.evaluate(() => window.__PR_PREFS__.soundLog.map((l) => l.event));
  expect(log).toEqual(['needs']);
});

test('silent under Do Not Disturb', async ({ page }) => {
  await openPrefs(page);
  await set(page, JSON.stringify({ dnd: { manual: true, schedule: null } }));
  expect(await play(page, 'needs')).toEqual({ play: false, reason: 'dnd' });
  expect(await play(page, 'error')).toEqual({ play: false, reason: 'dnd' });
  // A test button still sounds.
  expect(await play(page, 'needs', { force: true })).toEqual({ play: true });
});

test('silent inside a scheduled window, audible outside it', async ({ page }) => {
  await openPrefs(page);
  await set(
    page,
    JSON.stringify({
      dnd: {
        manual: false,
        schedule: { days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '08:00' },
      },
    }),
  );
  const night = await page.evaluate(() => {
    const d = new Date();
    d.setHours(23, 0, 0, 0);
    return window.__PR_PREFS__.playSound('done', { now: d });
  });
  expect(night).toEqual({ play: false, reason: 'dnd' });
  const noon = await page.evaluate(() => {
    const d = new Date();
    d.setHours(12, 0, 0, 0);
    return window.__PR_PREFS__.playSound('done', { now: d });
  });
  expect(noon).toEqual({ play: true });
});

test('silent for an event the user hooks already cover (Keep yours)', async ({ page }) => {
  await openPrefs(page, 'hooks=Stop,TaskCompleted');
  await page.waitForFunction(() => window.__PR_PREFS__.store.getDetected().length === 2);
  // Stop and TaskCompleted stand in for "turn complete".
  expect(await play(page, 'done')).toEqual({ play: false, reason: 'hook-keep' });
  // No hook for needs-you: Patchroom still plays it.
  expect(await play(page, 'needs')).toEqual({ play: true });
  // Both hooks must switch to Play both before Patchroom doubles up.
  await set(page, JSON.stringify({ sound: { hookPolicy: { Stop: 'both' } } }));
  expect(await play(page, 'done')).toEqual({ play: false, reason: 'hook-keep' });
  await set(
    page,
    JSON.stringify({ sound: { hookPolicy: { Stop: 'both', TaskCompleted: 'both' } } }),
  );
  expect(await play(page, 'done')).toEqual({ play: true });
});

test('silent for a muted DM only', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  await page.getByLabel('Mute sounds for hook-bridge').check();
  expect(await play(page, 'done', { dmId: 'dm-alpha' })).toEqual({
    play: false,
    reason: 'dm-muted',
  });
  expect(await play(page, 'done', { dmId: 'dm-beta' })).toEqual({ play: true });
  expect(await play(page, 'done')).toEqual({ play: true });
});

test('per-event off, master off and zero volume', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  expect(await play(page, 'message')).toEqual({ play: false, reason: 'event-off' });
  await page.getByRole('checkbox', { name: 'Message sound' }).check();
  expect(await play(page, 'message')).toEqual({ play: true });
  await page.getByRole('checkbox', { name: 'Error sound' }).uncheck();
  expect(await play(page, 'error')).toEqual({ play: false, reason: 'event-off' });
  await page.getByLabel('Volume').fill('0');
  expect(await play(page, 'bell')).toEqual({ play: false, reason: 'volume-zero' });
  await page.getByLabel('Play sounds').uncheck();
  expect(await play(page, 'bell')).toEqual({ play: false, reason: 'disabled' });
});

test('every event has a test button that plays', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
  for (const n of ['Needs you', 'Turn complete', 'Message', 'Error', 'Terminal bell']) {
    await page.getByRole('button', { name: `Test ${n} sound` }).click();
  }
  const log = await page.evaluate(() => window.__PR_PREFS__.soundLog);
  expect(log.map((l) => l.event)).toEqual(['needs', 'done', 'message', 'error', 'bell']);
  expect(log.every((l) => l.decision.play)).toBe(true);
});
