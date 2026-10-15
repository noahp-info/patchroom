import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { audio, openPrefs, resetAudio, spyAudio, tab } from './prefs-helpers';

const EVENTS = ['needs', 'done', 'message', 'error', 'bell', 'decision', 'due', 'session'];
const EVENT_NAMES = [
  'Needs you',
  'Turn complete',
  'Message',
  'Error',
  'Terminal bell',
  'Decision',
  'Due',
  'Session start',
];
const PACKS = {
  generated: ['Patch Tones', 'Telegraph', 'Night Shift', 'Modular'],
  files: [
    'Lab Glass',
    'Switchboard',
    'Pocket Console',
    'Pizzicato Hour',
    'Island Time',
    'Cartridge',
    'Bridge Crew',
  ],
};
const ALL = [...PACKS.generated, ...PACKS.files];

const generated = JSON.parse(
  readFileSync(new URL('../../plugins/sounds/generated-packs.json', import.meta.url), 'utf8'),
) as { packs: { id: string; name: string; notes: Record<string, { lp?: number }[]> }[] };

const prefs = (page: Page) => page.evaluate(() => window.__PR_PREFS__.store.getPrefs().sound);
const sounds = async (page: Page) => {
  await openPrefs(page);
  await tab(page, 'Sounds');
};
const pick = (page: Page, path: string | null) =>
  page.evaluate((p) => void (window.__PR_PREFS__.api.sound.control.nextPick = p), path);
const source = (page: Page, event: string) => page.getByLabel(`${event} source`, { exact: true });

test.beforeEach(async ({ page }) => {
  await spyAudio(page);
});

test('all 11 packs are listed as cards: 4 generated, 7 CC0 files', async ({ page }) => {
  await sounds(page);
  const cards = page.getByRole('list', { name: 'Sound packs' }).getByRole('listitem');
  await expect(cards).toHaveCount(11);
  for (const name of ALL) await expect(cards.filter({ hasText: name }).first()).toBeVisible();
  await expect(page.getByTestId('pack-lab-glass')).toContainText('CC0 files');
  await expect(page.getByTestId('pack-modular')).toContainText('Generated');
  await expect(page.getByTestId('pack-patchtones')).toHaveAttribute('data-in-use', 'true');
});

test('every pack plays every event: generated through oscillators, files through audio', async ({
  page,
}) => {
  await sounds(page);
  for (const pack of ALL) {
    const isGen = PACKS.generated.includes(pack);
    for (let i = 0; i < EVENTS.length; i++) {
      await resetAudio(page);
      await page.getByRole('button', { name: `Play ${pack} ${EVENT_NAMES[i]} sound` }).click();
      if (isGen) {
        await expect
          .poll(async () => (await audio(page)).osc, { message: pack })
          .toBeGreaterThan(0);
        expect((await audio(page)).files).toHaveLength(0);
      } else {
        await expect
          .poll(async () => (await audio(page)).files.length, { message: `${pack} ${EVENTS[i]}` })
          .toBe(1);
        const [f] = (await audio(page)).files;
        expect(f.src).toMatch(/^data:audio\/(mp4|x-m4a|m4a|aac)/);
        expect(f.src.length).toBeGreaterThan(2000);
        expect((await audio(page)).osc).toBe(0);
      }
    }
  }
});

test('the low-pass cutoff of a generated note reaches a BiquadFilter', async ({ page }) => {
  const withLp = generated.packs.find((p) =>
    Object.values(p.notes).some((ns) => ns.some((n) => n.lp)),
  )!;
  const event = Object.entries(withLp.notes).find(([, ns]) => ns.some((n) => n.lp))![0];
  await sounds(page);
  await resetAudio(page);
  await page
    .getByRole('button', {
      name: `Play ${withLp.name} ${EVENT_NAMES[EVENTS.indexOf(event)]} sound`,
    })
    .click();
  await expect.poll(async () => (await audio(page)).lowpass).toBeGreaterThan(0);
  // A pack without any lp makes no filter.
  const plain = generated.packs.find(
    (p) => !Object.values(p.notes).some((ns) => ns.some((n) => n.lp)),
  );
  if (plain) {
    await resetAudio(page);
    await page.getByRole('button', { name: `Play ${plain.name} Needs you sound` }).click();
    await expect.poll(async () => (await audio(page)).osc).toBeGreaterThan(0);
    expect((await audio(page)).lowpass).toBe(0);
  }
});

test('file sounds are cached: a second play does not fetch again', async ({ page }) => {
  await sounds(page);
  const btn = page.getByRole('button', { name: 'Play Lab Glass Needs you sound' });
  await btn.click();
  await btn.click();
  await expect.poll(async () => (await audio(page)).files.length).toBe(2);
  const calls = await page.evaluate(() =>
    window.__PR_PREFS__.api.sound.control.calls.filter((c) => c === 'sound_file:lab-glass:needs'),
  );
  expect(calls).toHaveLength(1);
});

test('Use for every event sets the whole mix and persists', async ({ page }) => {
  await sounds(page);
  await page.getByRole('button', { name: 'Use Telegraph for every event' }).click();
  const mix = (await prefs(page)).mix;
  for (const e of EVENTS) expect(mix[e]).toEqual({ pack: 'telegraph' });
  await expect(page.getByTestId('pack-telegraph')).toHaveAttribute('data-in-use', 'true');
  await expect(page.getByTestId('pack-patchtones')).toHaveAttribute('data-in-use', 'false');
  await expect(page.getByRole('button', { name: 'Use Telegraph for every event' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  // playSound now resolves to Telegraph.
  const r = await page.evaluate(() => {
    window.__PR_PREFS__.playSound('done');
    return window.__PR_PREFS__.soundLog.at(-1)?.choice;
  });
  expect(r).toEqual({ pack: 'telegraph' });
});

test('the mix board has eight events, each with a picker listing packs, Your file and Off', async ({
  page,
}) => {
  await sounds(page);
  const rows = page.getByRole('list', { name: 'Sound for each event' }).getByRole('listitem');
  await expect(rows).toHaveCount(8);
  for (const n of EVENT_NAMES) {
    const sel = source(page, n);
    const opts = await sel.locator('option').allTextContents();
    expect(opts).toEqual(expect.arrayContaining([...ALL, 'Your file...', 'Off']));
    await expect(page.getByRole('button', { name: `Test ${n} sound` })).toBeVisible();
  }
});

test('mixing: one event from a file pack, the rest stay, and it plays and persists', async ({
  page,
}) => {
  await page.goto('/src/components/prefs/harness.html');
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();
  await tab(page, 'Sounds');
  await source(page, 'Needs you').selectOption('pack:island-time');
  await source(page, 'Error').selectOption('pack:nightshift');
  const mix = (await prefs(page)).mix;
  expect(mix.needs).toEqual({ pack: 'island-time' });
  expect(mix.error).toEqual({ pack: 'nightshift' });
  expect(mix.done).toEqual({ pack: 'patchtones' });
  await resetAudio(page);
  await page.getByRole('button', { name: 'Test Needs you sound' }).click();
  await expect.poll(async () => (await audio(page)).files.length).toBe(1);
  await page.getByRole('button', { name: 'Test Turn complete sound' }).click();
  await expect.poll(async () => (await audio(page)).osc).toBeGreaterThan(0);
  // Persistence: a reload on the same storage keeps the mix.
  await page.reload();
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();
  await tab(page, 'Sounds');
  await expect(source(page, 'Needs you')).toHaveValue('pack:island-time');
  await expect(source(page, 'Error')).toHaveValue('pack:nightshift');
});

test('Off silences one event only, and its Test button is disabled', async ({ page }) => {
  await sounds(page);
  await source(page, 'Terminal bell').selectOption('off');
  await expect(page.getByRole('button', { name: 'Test Terminal bell sound' })).toBeDisabled();
  const bell = await page.evaluate(() => window.__PR_PREFS__.playSound('bell'));
  expect(bell).toEqual({ play: false, reason: 'mix-off' });
  const done = await page.evaluate(() => window.__PR_PREFS__.playSound('done'));
  expect(done).toEqual({ play: true });
});

test('the three planned events are selectable and testable now', async ({ page }) => {
  await sounds(page);
  for (const n of ['Decision', 'Due', 'Session start']) {
    await source(page, n).selectOption('pack:cartridge');
    await resetAudio(page);
    await page.getByRole('button', { name: `Test ${n} sound` }).click();
    await expect.poll(async () => (await audio(page)).files.length).toBe(1);
  }
});

test.describe('your own file', () => {
  test('a good file is imported, chosen and played from its data URL', async ({ page }) => {
    await sounds(page);
    await pick(page, '/Users/me/Sounds/chime.wav');
    await source(page, 'Needs you').selectOption('__file');
    const mix = (await prefs(page)).mix;
    expect(mix.needs).toEqual({ custom: expect.stringMatching(/^01J/) });
    await expect(source(page, 'Needs you').locator('option:checked')).toHaveText(
      'Your file: chime',
    );
    await resetAudio(page);
    await page.getByRole('button', { name: 'Test Needs you sound' }).click();
    await expect.poll(async () => (await audio(page)).files.length).toBe(1);
    expect((await audio(page)).files[0].src).toMatch(/^data:audio\/wav/);
    // Only this event changed.
    expect((await prefs(page)).mix.done).toEqual({ pack: 'patchtones' });
  });

  test('a file over 5 seconds is refused and the message names the limit', async ({ page }) => {
    await sounds(page);
    await pick(page, '/Users/me/Sounds/theme-song.mp3');
    await source(page, 'Turn complete').selectOption('__file');
    const row = page.getByTestId('mix-done');
    await expect(row.getByRole('alert')).toContainText('5 s');
    expect((await prefs(page)).mix.done).toEqual({ pack: 'patchtones' });
  });

  test('a file over 2 MB is refused and the message names the limit', async ({ page }) => {
    await sounds(page);
    await pick(page, '/Users/me/Sounds/ambience.aiff');
    await source(page, 'Turn complete').selectOption('__file');
    await expect(page.getByTestId('mix-done').getByRole('alert')).toContainText('2 MB');
    expect((await prefs(page)).mix.done).toEqual({ pack: 'patchtones' });
  });

  test('a wrong format is refused and the message lists the formats', async ({ page }) => {
    await sounds(page);
    await pick(page, '/Users/me/Sounds/notes.txt');
    await source(page, 'Turn complete').selectOption('__file');
    await expect(page.getByTestId('mix-done').getByRole('alert')).toContainText(
      'wav, aiff, mp3 or m4a',
    );
  });

  test('cancelling the picker changes nothing', async ({ page }) => {
    await sounds(page);
    await pick(page, null);
    await source(page, 'Turn complete').selectOption('__file');
    await expect(page.getByTestId('mix-done').getByRole('alert')).toHaveCount(0);
    expect((await prefs(page)).mix.done).toEqual({ pack: 'patchtones' });
    await expect(source(page, 'Turn complete')).toHaveValue('pack:patchtones');
  });

  test('removing the file falls back to the default pack and calls sound_custom_remove', async ({
    page,
  }) => {
    await sounds(page);
    await pick(page, '/Users/me/Sounds/knock.m4a');
    await source(page, 'Message').selectOption('__file');
    const id = ((await prefs(page)).mix.message as { custom: string }).custom;
    await page.getByRole('button', { name: /Remove Your file: knock for Message/ }).click();
    await expect.poll(async () => (await prefs(page)).mix.message).toEqual({ pack: 'patchtones' });
    const calls = await page.evaluate(() => window.__PR_PREFS__.api.sound.control.calls);
    expect(calls).toContain(`sound_custom_remove:${id}`);
  });

  test('a custom file that vanished falls back to the default pack sound', async ({ page }) => {
    await sounds(page);
    await page.evaluate(async () => {
      const h = window.__PR_PREFS__;
      const s = h.store.getPrefs().sound;
      await h.store.update({ sound: { ...s, mix: { ...s.mix, done: { custom: 'GONE' } } } });
      h.api.soundCustomFile = () => Promise.reject(new Error('missing'));
    });
    await resetAudio(page);
    await page.evaluate(() => window.__PR_PREFS__.playSound('done'));
    await expect.poll(async () => (await audio(page)).osc).toBeGreaterThan(0);
  });
});

test.describe('import your Claude sounds', () => {
  test('lists profiles on request and imports one as a pack', async ({ page }) => {
    await sounds(page);
    const calls = () => page.evaluate(() => window.__PR_PREFS__.api.sound.control.calls);
    // Nothing is read until the user asks.
    expect(await calls()).not.toContain('sound_claude_profiles');
    await page.getByRole('button', { name: 'Import your Claude sounds' }).click();
    const list = page.getByRole('list', { name: 'Claude sound profiles' });
    await expect(list.getByRole('listitem')).toHaveCount(2);
    await page.getByRole('button', { name: 'Import quiet-desk profile' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Imported quiet-desk' })).toBeVisible();
    const card = page.getByTestId('pack-claude-quiet-desk');
    await expect(card).toContainText('Imported');
    await expect(page.getByRole('list', { name: 'Sound packs' }).getByRole('listitem')).toHaveCount(
      12,
    );
    // It covers only the events the profile has.
    await expect(
      page.getByRole('button', { name: 'Play Claude: quiet-desk Needs you sound' }),
    ).toBeEnabled();
    await expect(
      page.getByRole('button', { name: 'Play Claude: quiet-desk Error sound' }),
    ).toBeDisabled();
    await resetAudio(page);
    await page.getByRole('button', { name: 'Play Claude: quiet-desk Needs you sound' }).click();
    await expect.poll(async () => (await audio(page)).files.length).toBe(1);
    // And it is a choice in the mix, for its events only.
    expect(await source(page, 'Needs you').locator('option').allTextContents()).toContain(
      'Claude: quiet-desk',
    );
    expect(await source(page, 'Error').locator('option').allTextContents()).not.toContain(
      'Claude: quiet-desk',
    );
    expect((await calls()).filter((c) => c.startsWith('sound_import_claude_profile'))).toEqual([
      'sound_import_claude_profile:quiet-desk',
    ]);
  });

  test('says so when there are no profiles', async ({ page }) => {
    await sounds(page);
    await page.evaluate(() => void (window.__PR_PREFS__.api.sound.control.profiles = []));
    await page.getByRole('button', { name: 'Import your Claude sounds' }).click();
    await expect(page.getByText('No Claude sound profiles found.')).toBeVisible();
  });
});

test.describe('per-DM overrides', () => {
  const dm = (page: Page, name: string) => page.getByTestId(name);

  test('a DM can use another pack; other DMs keep the global mix', async ({ page }) => {
    await sounds(page);
    await dm(page, 'sound-dm-dm-alpha').locator('summary').click();
    await page.getByLabel('Pack for hook-bridge').selectOption('switchboard');
    expect((await prefs(page)).perDm['dm-alpha']).toEqual({ pack: 'switchboard' });
    const r = await page.evaluate(() => {
      const h = window.__PR_PREFS__;
      h.playSound('done', { dmId: 'dm-alpha' });
      const a = h.soundLog.at(-1)!.choice;
      h.playSound('done', { dmId: 'dm-beta' });
      return [a, h.soundLog.at(-1)!.choice];
    });
    expect(r).toEqual([{ pack: 'switchboard' }, { pack: 'patchtones' }]);
  });

  test('a single event can differ, and beats the DM pack', async ({ page }) => {
    await sounds(page);
    await dm(page, 'sound-dm-dm-alpha').locator('summary').click();
    await page.getByLabel('Pack for hook-bridge').selectOption('switchboard');
    await page.getByLabel('hook-bridge Error source').selectOption('pack:cartridge');
    await page.getByLabel('hook-bridge Terminal bell source').selectOption('off');
    expect((await prefs(page)).perDm['dm-alpha']).toEqual({
      pack: 'switchboard',
      mix: { error: { pack: 'cartridge' }, bell: 'off' },
    });
    const out = await page.evaluate(() => {
      const h = window.__PR_PREFS__;
      return [
        h.playSound('error', { dmId: 'dm-alpha' }),
        h.soundLog.at(-1)!.choice,
        h.playSound('bell', { dmId: 'dm-alpha' }),
        h.playSound('bell', { dmId: 'dm-beta' }),
      ];
    });
    expect(out).toEqual([
      { play: true },
      { pack: 'cartridge' },
      { play: false, reason: 'mix-off' },
      { play: true },
    ]);
    // The in-page Cartridge play above is async; let it land before counting the Test click.
    await expect.poll(async () => (await audio(page)).files.length).toBe(1);
    await resetAudio(page);
    await page.getByRole('button', { name: 'Test Error sound for hook-bridge' }).click();
    await expect.poll(async () => (await audio(page)).files.length).toBe(1);
  });

  test('the DM can use its own file for one event', async ({ page }) => {
    await sounds(page);
    await dm(page, 'sound-dm-dm-beta').locator('summary').click();
    await pick(page, '/Users/me/Sounds/chime.wav');
    await page.getByLabel('docs-site Needs you source').selectOption('__file');
    const own = (await prefs(page)).perDm['dm-beta'] as { mix: { needs: { custom: string } } };
    expect(own.mix.needs.custom).toMatch(/^01J/);
  });

  test('resetting returns the DM to the global mix and drops its entry', async ({ page }) => {
    await sounds(page);
    await dm(page, 'sound-dm-dm-alpha').locator('summary').click();
    await page.getByLabel('Pack for hook-bridge').selectOption('switchboard');
    await page.getByRole('button', { name: 'Use the global mix for hook-bridge' }).click();
    expect((await prefs(page)).perDm).toEqual({});
  });

  test('picking "Use the global mix" for the pack drops an empty override', async ({ page }) => {
    await sounds(page);
    await dm(page, 'sound-dm-dm-alpha').locator('summary').click();
    await page.getByLabel('Pack for hook-bridge').selectOption('switchboard');
    await page.getByLabel('Pack for hook-bridge').selectOption('');
    expect((await prefs(page)).perDm).toEqual({});
  });

  test('the per-DM mute still works and wins over an override', async ({ page }) => {
    await sounds(page);
    await dm(page, 'sound-dm-dm-alpha').locator('summary').click();
    await page.getByLabel('Pack for hook-bridge').selectOption('switchboard');
    await page.getByLabel('Mute sounds for hook-bridge').check();
    expect((await prefs(page)).perDm['dm-alpha']).toBe('mute');
    const r = await page.evaluate(() =>
      window.__PR_PREFS__.playSound('done', { dmId: 'dm-alpha' }),
    );
    expect(r).toEqual({ play: false, reason: 'dm-muted' });
    await page.getByLabel('Mute sounds for hook-bridge').uncheck();
    expect((await prefs(page)).perDm).toEqual({});
  });
});

test('credits name Kenney and CC0, and each pack with its license', async ({ page }) => {
  await sounds(page);
  const c = page.getByTestId('sound-credits');
  await expect(c).toContainText('Kenney');
  await expect(c).toContainText('kenney.nl');
  await expect(c).toContainText('CC0');
  for (const name of ALL) await expect(c.getByText(name, { exact: true })).toBeVisible();
  await expect(c.getByText(/Kenney \(kenney.nl\), CC0-1.0/).first()).toBeVisible();
});

test('prefs saved before packs existed load as Patch Tones everywhere', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'pr.prefs.harness',
      JSON.stringify({
        sound: {
          enabled: true,
          volume: 0.6,
          perEvent: { needs: { on: true, sound: 'needs' } },
          perDm: { 'dm-alpha': 'mute' },
          hookPolicy: {},
        },
      }),
    );
  });
  await page.goto('/src/components/prefs/harness.html');
  await page.getByRole('dialog', { name: 'Preferences' }).waitFor();
  await tab(page, 'Sounds');
  for (const n of EVENT_NAMES) await expect(source(page, n)).toHaveValue('pack:patchtones');
  await expect(page.getByLabel('Mute sounds for hook-bridge')).toBeChecked();
});

test('P3 rules hold with a mixed pack: DND, hooks, volume and the DM on screen stay silent', async ({
  page,
}) => {
  await openPrefs(page, 'hooks=Stop,SessionStart');
  await page.waitForFunction(() => window.__PR_PREFS__.store.getDetected().length === 2);
  const play = (e: string, o: object = {}) =>
    page.evaluate(([ev, op]) => window.__PR_PREFS__.playSound(ev as string, op as object), [e, o]);
  await page.evaluate(async () => {
    const h = window.__PR_PREFS__;
    const s = h.store.getPrefs().sound;
    await h.store.update({ sound: { ...s, mix: { ...s.mix, needs: { pack: 'lab-glass' } } } });
  });
  expect(await play('needs')).toEqual({ play: true });
  // Keep yours covers Stop (done) and SessionStart (session).
  expect(await play('done')).toEqual({ play: false, reason: 'hook-keep' });
  expect(await play('session')).toEqual({ play: false, reason: 'hook-keep' });
  await page.evaluate(async () => {
    const h = window.__PR_PREFS__;
    await h.store.update({ dnd: { manual: true, schedule: null } });
  });
  expect(await play('needs')).toEqual({ play: false, reason: 'dnd' });
  // Exactly one sound per call.
  await resetAudio(page);
  await page.evaluate(async () => {
    const h = window.__PR_PREFS__;
    await h.store.update({ dnd: { manual: false, schedule: null } });
  });
  await play('needs');
  await expect.poll(async () => (await audio(page)).files.length).toBe(1);
  expect((await audio(page)).osc).toBe(0);
});
