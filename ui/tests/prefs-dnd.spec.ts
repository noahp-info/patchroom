import { expect, test } from '@playwright/test';
import { openPrefs, tab } from './prefs-helpers';

test('schedule shows a plain-language summary', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Do Not Disturb');
  await page.getByLabel('Turn on a schedule').check();
  const sum = page.getByTestId('dnd-summary');
  await expect(sum).toHaveText('Weeknights 22:00 to 08:00');

  await page.getByLabel('Start time').fill('09:00');
  await page.getByLabel('End time').fill('17:00');
  await expect(sum).toHaveText('Weekdays 09:00 to 17:00');

  await page.getByRole('button', { name: 'Monday' }).click();
  await page.getByRole('button', { name: 'Friday' }).click();
  await expect(sum).toHaveText('Tue, Wed, Thu 09:00 to 17:00');

  await page.getByLabel('Start time').fill('21:30');
  await page.getByLabel('End time').fill('06:00');
  await expect(sum).toHaveText('Tue, Wed, Thu nights 21:30 to 06:00');

  await page.getByLabel('Start time').fill('06:00');
  await expect(sum).toContainText('nothing is silenced');
});

test('summary wording for weekends and every day', async ({ page }) => {
  await openPrefs(page);
  const out = await page.evaluate(() => {
    const s = window.__PR_PREFS__.dndSummary;
    return [
      s({ days: [0, 6], start: '23:00', end: '09:00' }),
      s({ days: [0, 6], start: '10:00', end: '12:00' }),
      s({ days: [0, 1, 2, 3, 4, 5, 6], start: '22:00', end: '07:00' }),
      s({ days: [0, 1, 2, 3, 4, 5, 6], start: '12:00', end: '13:00' }),
      s({ days: [], start: '22:00', end: '07:00' }),
      s(null),
    ];
  });
  expect(out).toEqual([
    'Weekend nights 23:00 to 09:00',
    'Weekends 10:00 to 12:00',
    'Every night 22:00 to 07:00',
    'Every day 12:00 to 13:00',
    'No days selected, so nothing is silenced.',
    'No days selected, so nothing is silenced.',
  ]);
});

test('a window that crosses midnight belongs to the day it starts on', async ({ page }) => {
  await openPrefs(page);
  const res = await page.evaluate(() => {
    const dnd = {
      manual: false,
      schedule: { days: [1, 2, 3, 4, 5], start: '22:00', end: '08:00' },
    };
    // Find a Sunday in local time, then build local times from it.
    const sunday = new Date(2026, 9, 11);
    while (sunday.getDay() !== 0) sunday.setDate(sunday.getDate() + 1);
    const at = (day: number, h: number, m = 0) =>
      new Date(sunday.getFullYear(), sunday.getMonth(), sunday.getDate() + day, h, m);
    const on = (d: Date) => window.__PR_PREFS__.dndActive(dnd, d);
    return {
      monMorning: on(at(1, 7, 59)), // Sunday window is not scheduled: off
      monNoon: on(at(1, 12)), // off
      monLate: on(at(1, 22)), // on
      monNight: on(at(1, 23, 30)), // on
      tueEarly: on(at(2, 3)), // Monday window carries over: on
      tueEdge: on(at(2, 7, 59)), // on
      tueEnd: on(at(2, 8)), // off
      friLate: on(at(5, 22, 1)), // on
      satEarly: on(at(6, 3)), // Friday window carries over: on
      satLate: on(at(6, 23)), // Saturday not scheduled: off
      sunEarly: on(at(7, 3)), // Saturday window not scheduled: off
    };
  });
  expect(res).toEqual({
    monMorning: false,
    monNoon: false,
    monLate: true,
    monNight: true,
    tueEarly: true,
    tueEdge: true,
    tueEnd: false,
    friLate: true,
    satEarly: true,
    satLate: false,
    sunEarly: false,
  });
});

test('the manual toggle turns Do Not Disturb on now', async ({ page }) => {
  await openPrefs(page);
  await tab(page, 'Do Not Disturb');
  await expect(page.getByTestId('dnd-now')).toContainText('off right now');
  await page.getByRole('switch', { name: /Pause notifications/ }).check();
  await expect(page.getByTestId('dnd-now')).toContainText('on right now');
  expect(await page.evaluate(() => window.__PR_PREFS__.store.getPrefs().dnd.manual)).toBe(true);
});
