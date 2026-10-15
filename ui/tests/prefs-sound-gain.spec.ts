import { expect, test, type Page } from '@playwright/test';
import { audio, HARNESS, openPrefs, resetAudio, spyAudio, tab } from './prefs-helpers';

/** Per-event volume (docs/gauntlet/SOUND-PACKS-BAR.md item 11): 0 to 150 percent per sound. */

const EVENTS = ['needs', 'done', 'message', 'error', 'bell', 'decision', 'due', 'session'];
const NAMES = [
  'Needs you',
  'Turn complete',
  'Message',
  'Error',
  'Terminal bell',
  'Decision',
  'Due',
  'Session start',
];
const MASTER = 0.6; // the default master volume
const SYNTH_BASE = 0.6;
const FILE_BASE = 0.8;

const sound = (page: Page) => page.evaluate(() => window.__PR_PREFS__.store.getPrefs().sound);
const slider = (page: Page, name: string) =>
  page.getByRole('slider', { name: `${name} volume`, exact: true });
const test1 = (page: Page, name: string) =>
  page.getByRole('button', { name: `Test ${name} sound`, exact: true }).click();
const sounds = async (page: Page, query = '') => {
  await openPrefs(page, query);
  await tab(page, 'Sounds');
};
const setMaster = (page: Page, volume: number) =>
  page.evaluate(
    (v) =>
      window.__PR_PREFS__.store.update({
        sound: { ...window.__PR_PREFS__.store.getPrefs().sound, volume: v },
      }),
    volume,
  );
const lastLevel = async (page: Page) => (await audio(page)).levels.at(-1)!;
const peakOf = (page: Page, pack: string, event: string) =>
  page.evaluate(
    ([p, e]) => window.__PR_PREFS__.notesPeak(window.__PR_PREFS__.generated[p].notes[e]),
    [pack, event],
  );

test.beforeEach(async ({ page }) => {
  await spyAudio(page);
});

test('each of the 8 events has a labeled 0 to 150 percent slider at 100 percent', async ({
  page,
}) => {
  await sounds(page);
  for (const n of NAMES) {
    const s = slider(page, n);
    await expect(s).toHaveAttribute('min', '0');
    await expect(s).toHaveAttribute('max', '1.5');
    await expect(s).toHaveValue('1');
    await expect(s).toHaveAttribute('aria-valuetext', '100 percent');
    await expect(page.getByRole('button', { name: `Test ${n} sound`, exact: true })).toBeVisible();
  }
  await expect(page.getByTestId('mix-needs').locator('.gain__out')).toHaveText('100%');
  // The master slider is still its own control.
  await expect(page.getByLabel('Volume', { exact: true })).toHaveValue('0.6');
});

test('a gain changes only its own event, in the readout, the prefs and the sound', async ({
  page,
}) => {
  await sounds(page);
  await slider(page, 'Needs you').fill('1.5');
  await expect(page.getByTestId('mix-needs').locator('.gain__out')).toHaveText('150%');
  await expect(slider(page, 'Needs you')).toHaveAttribute('aria-valuetext', '150 percent');
  const s = await sound(page);
  expect(s.mix.needs).toEqual({ pack: 'patchtones', gain: 1.5 });
  for (const e of EVENTS.filter((x) => x !== 'needs'))
    expect(s.mix[e]).toEqual({ pack: 'patchtones' });
  // Needs you plays 1.5x louder than the same sound at 100 percent; Turn complete is unchanged.
  const peak = await peakOf(page, 'patchtones', 'needs');
  expect(peak).toBeGreaterThan(0);
  await resetAudio(page);
  await test1(page, 'Needs you');
  await expect.poll(async () => (await audio(page)).levels.length).toBe(1);
  expect(await lastLevel(page)).toBeCloseTo(
    Math.min(MASTER * SYNTH_BASE * 1.5, Math.max(1 / peak, MASTER * SYNTH_BASE)),
    4,
  );
  expect(await lastLevel(page)).toBeCloseTo(MASTER * SYNTH_BASE * 1.5, 4);
  await resetAudio(page);
  await test1(page, 'Turn complete');
  await expect.poll(async () => (await audio(page)).levels.length).toBe(1);
  expect(await lastLevel(page)).toBeCloseTo(MASTER * SYNTH_BASE, 4);
  // Zero is silent but valid.
  await slider(page, 'Needs you').fill('0');
  await resetAudio(page);
  await test1(page, 'Needs you');
  await expect.poll(async () => (await audio(page)).levels.length).toBe(1);
  expect(await lastLevel(page)).toBe(0);
});

test('file sounds route through a GainNode, so 150 percent is not capped at element volume 1', async ({
  page,
}) => {
  await sounds(page);
  await page.getByLabel('Turn complete source', { exact: true }).selectOption('pack:lab-glass');
  await slider(page, 'Turn complete').fill('1.5');
  await setMaster(page, 1);
  await resetAudio(page);
  await test1(page, 'Turn complete');
  await expect.poll(async () => (await audio(page)).files.length).toBe(1);
  const [f] = (await audio(page)).files;
  expect(f.routed).toBe(true);
  expect(f.volume).toBe(1);
  expect(f.gain).toBeCloseTo(1 * FILE_BASE * 1.5, 4); // 1.2, above what element.volume can carry
  expect(f.gain).toBeGreaterThan(1);
  // The same file again at 50 percent: the node is reused and its gain follows.
  await slider(page, 'Turn complete').fill('0.5');
  await resetAudio(page);
  await test1(page, 'Turn complete');
  await expect.poll(async () => (await audio(page)).files.length).toBe(1);
  expect((await audio(page)).files[0].gain).toBeCloseTo(FILE_BASE * 0.5, 4);
  // Changing the source keeps the event's volume.
  await slider(page, 'Turn complete').fill('1.25');
  await page.getByLabel('Turn complete source', { exact: true }).selectOption('pack:telegraph');
  expect((await sound(page)).mix.done).toEqual({ pack: 'telegraph', gain: 1.25 });
});

test('the effective gain multiplies master, event gain and the file normalizing gain', async ({
  page,
}) => {
  await sounds(page);
  // The mock disk holds a hot file: norm 0.9, peak 1 after normalizing.
  await page.evaluate(
    () => void (window.__PR_PREFS__.api.sound.control.nextPick = '/Users/me/Sounds/airhorn.wav'),
  );
  await page.getByLabel('Terminal bell source', { exact: true }).selectOption('__file');
  await expect(page.getByLabel('Terminal bell source', { exact: true })).toHaveValue(/^custom:/);
  await slider(page, 'Terminal bell').fill('0.8');
  await setMaster(page, 0.5);
  await resetAudio(page);
  await test1(page, 'Terminal bell');
  await expect.poll(async () => (await audio(page)).files.length).toBe(1);
  expect((await audio(page)).files[0].gain).toBeCloseTo(0.5 * 0.8 * 0.9 * FILE_BASE, 4);
});

test('clamping: 150 percent on a loud file never exceeds full scale', async ({ page }) => {
  await sounds(page);
  await page.evaluate(
    () => void (window.__PR_PREFS__.api.sound.control.nextPick = '/Users/me/Sounds/airhorn.wav'),
  );
  await page.getByLabel('Error source', { exact: true }).selectOption('__file');
  await expect(page.getByLabel('Error source', { exact: true })).toHaveValue(/^custom:/);
  await setMaster(page, 1);
  await slider(page, 'Error').fill('1.5');
  await resetAudio(page);
  await test1(page, 'Error');
  await expect.poll(async () => (await audio(page)).files.length).toBe(1);
  const [f] = (await audio(page)).files;
  // Unclamped: 1 x 1.5 x 0.9 x 0.8 = 1.08. The file peaks at 1 after its 0.9 norm, so the
  // ceiling is norm / peak = 0.9 and the output stays at or under full scale.
  expect(f.gain).toBeCloseTo(0.9, 4);
  expect(f.gain * 1).toBeLessThanOrEqual(0.9 + 1e-9);
  // At 100 percent the same file is below the ceiling and untouched.
  await slider(page, 'Error').fill('1');
  await resetAudio(page);
  await test1(page, 'Error');
  await expect.poll(async () => (await audio(page)).files.length).toBe(1);
  expect((await audio(page)).files[0].gain).toBeCloseTo(0.9 * FILE_BASE, 4);
});

test('clamping: master 100 percent x event 150 percent never clips any generated sound', async ({
  page,
}) => {
  await sounds(page);
  await setMaster(page, 1);
  const rows = await page.evaluate(() => {
    const h = window.__PR_PREFS__;
    const out: { id: string; event: string; level: number; peak: number }[] = [];
    for (const id of Object.keys(h.generated)) {
      for (const event of Object.keys(h.generated[id].notes)) {
        const cur = h.store.getPrefs().sound;
        const spy = window.__AUDIO__;
        spy.levels.length = 0;
        void h.store.update({
          sound: { ...cur, mix: { ...cur.mix, [event]: { pack: id, gain: 1.5 } } },
        });
        h.playSound(event, { force: true });
        out.push({
          id,
          event,
          level: spy.levels[0],
          peak: h.notesPeak(h.generated[id].notes[event]),
        });
      }
    }
    return out;
  });
  expect(rows.length).toBeGreaterThanOrEqual(32);
  for (const r of rows) {
    expect(r.level, `${r.id} ${r.event}`).toBeGreaterThan(0);
    // The loudest sample of the sound, at the master gain it plays at, stays within full scale
    // unless the sound already sat above it at 100 percent (the clamp never lowers that).
    const unity = SYNTH_BASE;
    expect(r.level * r.peak, `${r.id} ${r.event}`).toBeLessThanOrEqual(
      Math.max(1, unity * r.peak) + 1e-9,
    );
    expect(r.level, `${r.id} ${r.event}`).toBeLessThanOrEqual(unity * 1.5 + 1e-9);
  }
  // Every generated sound has headroom at 150 percent, so none is held back: the full 1.5x plays.
  for (const r of rows) expect(r.level).toBeCloseTo(SYNTH_BASE * 1.5, 6);
});

test('the pure rule: master x event x norm, held at norm / peak, never below unity', async ({
  page,
}) => {
  await sounds(page);
  const g = (i: object) => page.evaluate((x) => window.__PR_PREFS__.effectiveGain(x as never), i);
  expect(await g({ master: 1, event: 1, base: 1 })).toBeCloseTo(1, 6);
  expect(await g({ master: 0.5, event: 1.5, norm: 0.8, base: 0.8 })).toBeCloseTo(0.48, 6);
  expect(await g({ master: 1, event: 1.5, norm: 1, base: 0.8, peak: 1 })).toBeCloseTo(1, 6);
  // An event gain past 1.5 is itself capped at 1.5.
  expect(await g({ master: 1, event: 9, norm: 1, base: 0.8, peak: 0.5 })).toBeCloseTo(1.2, 6);
  // A hot sound (peak 0.9, norm 0.5) is held at norm / peak.
  expect(await g({ master: 1, event: 1.5, norm: 0.5, base: 1, peak: 0.9 })).toBeCloseTo(
    0.5 / 0.9,
    6,
  );
  expect(await g({ master: 1, event: -3, base: 0.8 })).toBe(0);
  // A sound already hotter than the ceiling at 100 percent is not turned down by the clamp.
  expect(await g({ master: 1, event: 1.5, norm: 1, base: 1, peak: 2 })).toBeCloseTo(1, 6);
});

test('a gain persists across a reload, per event and per DM', async ({ page }) => {
  await page.goto(HARNESS); // no ?fresh: the harness keeps prefs in localStorage
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();
  await tab(page, 'Sounds');
  await slider(page, 'Terminal bell').fill('0.35');
  await page.getByTestId('sound-dm-dm-alpha').locator('summary').click();
  await slider(page, 'hook-bridge Needs you').fill('1.4');
  await page.reload();
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();
  await tab(page, 'Sounds');
  await expect(slider(page, 'Terminal bell')).toHaveValue('0.35');
  await expect(page.getByTestId('mix-bell').locator('.gain__out')).toHaveText('35%');
  await expect(slider(page, 'Needs you')).toHaveValue('1');
  await page.getByTestId('sound-dm-dm-alpha').locator('summary').click();
  await expect(slider(page, 'hook-bridge Needs you')).toHaveValue('1.4');
  const s = await sound(page);
  expect(s.mix.bell).toEqual({ pack: 'patchtones', gain: 0.35 });
  expect(s.perDm['dm-alpha']).toEqual({ mix: { needs: { pack: 'patchtones', gain: 1.4 } } });
  await page.evaluate(() => localStorage.clear());
});

test('a stored gain outside 0 to 1.5, or not a number, is clamped on load', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'pr.prefs.harness',
      JSON.stringify({
        sound: {
          enabled: true,
          volume: 0.6,
          mix: {
            needs: { pack: 'patchtones', gain: 9 },
            done: { pack: 'patchtones', gain: -2 },
            error: { pack: 'patchtones', gain: 'loud' },
          },
          perDm: { 'dm-alpha': { mix: { needs: { pack: 'telegraph', gain: 7 } } } },
        },
      }),
    );
  });
  await page.goto(HARNESS);
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();
  const s = await sound(page);
  expect(s.mix.needs).toEqual({ pack: 'patchtones', gain: 1.5 });
  expect(s.mix.done).toEqual({ pack: 'patchtones', gain: 0 });
  expect(s.mix.error).toEqual({ pack: 'patchtones' });
  expect(s.perDm['dm-alpha']).toEqual({ mix: { needs: { pack: 'telegraph', gain: 1.5 } } });
});

test('a DM gain wins for that DM only, in both the oscillator and the file path', async ({
  page,
}) => {
  await sounds(page);
  await slider(page, 'Needs you').fill('1.5');
  await page.getByTestId('sound-dm-dm-alpha').locator('summary').click();
  // With nothing of its own, the DM follows the global gain.
  await expect(slider(page, 'hook-bridge Needs you')).toHaveValue('1.5');
  await slider(page, 'hook-bridge Needs you').fill('0.5');
  const s = await sound(page);
  expect(s.mix.needs).toEqual({ pack: 'patchtones', gain: 1.5 });
  expect(s.perDm['dm-alpha']).toEqual({ mix: { needs: { pack: 'patchtones', gain: 0.5 } } });
  // The other DM keeps the global gain.
  await page.getByTestId('sound-dm-dm-beta').locator('summary').click();
  await expect(slider(page, 'docs-site Needs you')).toHaveValue('1.5');

  // Oscillator path.
  await resetAudio(page);
  await page.getByRole('button', { name: 'Test Needs you sound for hook-bridge' }).click();
  await expect.poll(async () => (await audio(page)).levels.length).toBe(1);
  expect(await lastLevel(page)).toBeCloseTo(MASTER * SYNTH_BASE * 0.5, 4);
  await resetAudio(page);
  await page.getByRole('button', { name: 'Test Needs you sound for docs-site' }).click();
  await expect.poll(async () => (await audio(page)).levels.length).toBe(1);
  expect(await lastLevel(page)).toBeCloseTo(MASTER * SYNTH_BASE * 1.5, 4);
  await resetAudio(page);
  await test1(page, 'Needs you');
  await expect.poll(async () => (await audio(page)).levels.length).toBe(1);
  expect(await lastLevel(page)).toBeCloseTo(MASTER * SYNTH_BASE * 1.5, 4);

  // File path: the DM picks a file pack and a gain of its own.
  await page
    .getByLabel('hook-bridge Needs you source', { exact: true })
    .selectOption('pack:lab-glass');
  await expect(slider(page, 'hook-bridge Needs you')).toHaveValue('0.5'); // the source change keeps it
  await slider(page, 'hook-bridge Needs you').fill('1.3');
  await resetAudio(page);
  await page.getByRole('button', { name: 'Test Needs you sound for hook-bridge' }).click();
  await expect.poll(async () => (await audio(page)).files.length).toBe(1);
  const f = (await audio(page)).files[0];
  expect(f.routed).toBe(true);
  expect(f.gain).toBeCloseTo(MASTER * FILE_BASE * 1.3, 4);
  // The log carries the gain that won.
  const log = await page.evaluate(() => window.__PR_PREFS__.soundLog.at(-1)!);
  expect(log.dmId).toBe('dm-alpha');
  expect(log.gain).toBeCloseTo(1.3, 6);
});

test('a DM pack with no event of its own keeps the global gain of that event', async ({ page }) => {
  await sounds(page);
  await slider(page, 'Error').fill('1.2');
  await page.getByTestId('sound-dm-dm-alpha').locator('summary').click();
  await page.getByLabel('Pack for hook-bridge').selectOption('telegraph');
  await expect(slider(page, 'hook-bridge Error')).toHaveValue('1.2');
  const entry = await page.evaluate(() => {
    const h = window.__PR_PREFS__;
    h.playSound('error', { force: true, dmId: 'dm-alpha' });
    return h.soundLog.at(-1)!.choice;
  });
  expect(entry).toEqual({ pack: 'telegraph', gain: 1.2 });
});

test('Off disables the slider and its test; turning it on again plays at 100 percent', async ({
  page,
}) => {
  await sounds(page);
  await slider(page, 'Message').fill('1.2');
  await page.getByLabel('Message source', { exact: true }).selectOption('off');
  await expect(slider(page, 'Message')).toBeDisabled();
  await expect(
    page.getByRole('button', { name: 'Test Message sound', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Message source', { exact: true }).selectOption('pack:modular');
  await expect(slider(page, 'Message')).toBeEnabled();
  await expect(slider(page, 'Message')).toHaveValue('1');
});

test('sliders are keyboard operable: arrows, Home and End, in tab order', async ({ page }) => {
  await sounds(page);
  const s = slider(page, 'Error');
  await s.focus();
  await expect(s).toBeFocused();
  await page.keyboard.press('End');
  await expect(s).toHaveAttribute('aria-valuetext', '150 percent');
  await page.keyboard.press('ArrowLeft');
  await expect(s).toHaveAttribute('aria-valuetext', '145 percent');
  await page.keyboard.press('Home');
  await expect(s).toHaveAttribute('aria-valuetext', '0 percent');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await expect(s).toHaveAttribute('aria-valuetext', '10 percent');
  expect((await sound(page)).mix.error).toEqual({ pack: 'patchtones', gain: 0.1 });
  // Tab goes slider, then the Test button of the same row.
  await page.keyboard.press('Tab');
  await expect(page.getByRole('button', { name: 'Test Error sound', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(async () => (await audio(page)).levels.length).toBe(1);
  expect(await lastLevel(page)).toBeCloseTo(MASTER * SYNTH_BASE * 0.1, 4);
});

test('every slider has a unique accessible name, and no control is unlabeled', async ({ page }) => {
  await sounds(page);
  await page.getByTestId('sound-dm-dm-alpha').locator('summary').click();
  const names = await page
    .getByRole('slider')
    .evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  // master + 8 global + 8 for the open DM
  expect(names).toHaveLength(17);
  expect(names.every((n) => n.length > 0)).toBe(true);
  expect(new Set(names).size).toBe(names.length);
  for (const n of NAMES) {
    expect(names).toContain(`${n} volume`);
    expect(names).toContain(`hook-bridge ${n} volume`);
  }
});
