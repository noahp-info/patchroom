import { expect, test } from '@playwright/test';
import { openSeeded, watchErrors } from './helpers';
import { audio, openPrefs, spyAudio, tab } from './prefs-helpers';

/*
 * Patchroom's own sounds, event by event, and the person's own Claude Code sound hooks. The
 * backend decides (`notify:fire`), the UI maps the event to the mix and plays it. Hook
 * detection is read only; these tests use fixture hooks, never the real settings file.
 */

const EVENTS = ['needs', 'done', 'message', 'error', 'bell', 'session'] as const;

test.describe('event to sound mapping (unit)', () => {
  test('each Claude hook event stands in for the right Patchroom event', async ({ page }) => {
    await openPrefs(page);
    const map = await page.evaluate(() => {
      const p = window.__PR_PREFS__;
      return Object.fromEntries(
        [
          'Stop',
          'SubagentStop',
          'TaskCompleted',
          'Notification',
          'PermissionRequest',
          'StopFailure',
          'PostToolUseFailure',
          'SessionStart',
          'PreToolUse',
        ].map((e) => [e, p.eventsForHook(e)]),
      );
    });
    expect(map).toEqual({
      Stop: ['done'],
      SubagentStop: ['done'],
      TaskCompleted: ['done'],
      Notification: ['needs'],
      PermissionRequest: ['needs'],
      StopFailure: ['error'],
      PostToolUseFailure: ['error'],
      SessionStart: ['session'],
      PreToolUse: [],
    });
  });

  test('defaults play every event but message, through Patch Tones', async ({ page }) => {
    await openPrefs(page);
    const got = await page.evaluate(
      (events) => {
        const p = window.__PR_PREFS__;
        const prefs = p.store.getPrefs();
        return events.map((e) => ({
          e,
          d: p.decideSound(e, prefs, []),
          c: p.resolveChoice(e, prefs.sound),
        }));
      },
      EVENTS as unknown as string[],
    );
    for (const { e, d, c } of got) {
      expect(c, e).toEqual({ pack: 'patchtones' });
      if (e === 'message') expect(d, e).toEqual({ play: false, reason: 'event-off' });
      else expect(d, e).toEqual({ play: true });
    }
  });

  test('a detected hook keeps its event quiet; a guarded one covers nothing', async ({ page }) => {
    await openPrefs(page);
    const r = await page.evaluate(() => {
      const p = window.__PR_PREFS__;
      const stop = { event: 'Stop', command: 'x', source: 'user' };
      return {
        loud: p.hookKeepsEvent('done', [stop], {}),
        guarded: p.hookKeepsEvent('done', [{ ...stop, guarded: true }], {}),
        both: p.hookKeepsEvent('done', [stop], { Stop: 'both' }),
        other: p.hookKeepsEvent('needs', [stop], {}),
      };
    });
    expect(r).toEqual({ loud: true, guarded: false, both: false, other: false });
  });
});

test.describe('the play path, in the app', () => {
  test.beforeEach(async ({ page }) => {
    await spyAudio(page);
  });

  test('every event reaches the play path with the selected pack and level', async ({ page }) => {
    const errs = watchErrors(page);
    await openSeeded(page, [{ id: 'a1', name: 'alpha' }]);
    // Message is off by default; turn it on so every event is expected to sound.
    await page.evaluate(async () => {
      const p = window.__PR_MOCK__!.prefs();
      await window.__PR_STORE__!.setPrefs({
        sound: {
          ...p.sound,
          perEvent: { ...p.sound.perEvent, message: { sound: 'message', on: true } },
        },
      });
    });
    for (const event of EVENTS) {
      const before = (await audio(page)).osc;
      await page.evaluate(
        (ev) => window.__PR_MOCK__!.fireNotify({ id: 'a1', event: ev, title: 'alpha', body: '' }),
        event,
      );
      await expect
        .poll(async () => (await audio(page)).osc, { message: event })
        .toBeGreaterThan(before);
    }
    const log = await page.evaluate(() => window.__PR_SOUND_LOG__!.map((l) => l.event));
    expect(log).toEqual([...EVENTS]);
    // A file pack plays through the element path, routed to the context at the chosen level.
    await page.evaluate(async () => {
      const p = window.__PR_MOCK__!.prefs();
      await window.__PR_STORE__!.setPrefs({
        sound: {
          ...p.sound,
          volume: 0.5,
          mix: { ...p.sound.mix, session: { pack: 'switchboard' } },
        },
      });
    });
    await page.evaluate(() =>
      window.__PR_MOCK__!.fireNotify({ id: 'a1', event: 'session', title: 'alpha', body: '' }),
    );
    await expect.poll(async () => (await audio(page)).files.length).toBe(1);
    const file = (await audio(page)).files[0];
    expect(file.src).toMatch(/^data:audio\//);
    expect(file.gain).toBeGreaterThan(0);
    expect(errs).toEqual([]);
  });

  test('your own hooks: a hint once with the guard, and Settings > Sounds', async ({ page }) => {
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    await openSeeded(page, [{ id: 'a1', name: 'alpha' }], {
      query: 'mock&grid=100x30&soundhooks=Stop,SessionStart',
    });
    const hint = page.locator('[data-hint="sounds.hooks"]');
    await expect(hint).toBeVisible();
    await expect(hint).toContainText('you may hear both');
    await expect(hint.getByTestId('copy-line')).toHaveText(
      /\[ -n "\$PATCHROOM_SESSION" \] && exit 0/,
    );
    await hint.getByTestId('copy-line-btn').click();
    await expect(hint.getByTestId('copy-line-btn')).toHaveText('Copied');
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      '[ -n "$PATCHROOM_SESSION" ] && exit 0',
    );
    await hint.getByRole('button', { name: 'Sounds settings' }).click();
    const dlg = page.getByRole('dialog', { name: 'Settings' });
    const note = dlg.getByTestId('sound-hooks-note');
    await expect(note).toBeVisible();
    await expect(note.locator('[data-hook-event="Stop"]')).toContainText('play.sh');
    // Shown counts as seen.
    const seen = await page.evaluate(() => window.__PR_MOCK__!.prefs().hints?.seen ?? []);
    expect(seen).toContain('sounds.hooks');
  });
});

test.describe('Settings > Sounds note', () => {
  test('lists loud hooks, explains inline ones, and skips guarded ones', async ({ page }) => {
    await openPrefs(page, 'scripthooks=Stop&hooks=Notification&guarded=SessionStart');
    await tab(page, 'Sounds');
    const note = page.getByTestId('sound-hooks-note');
    await expect(note).toContainText('you may hear both');
    await expect(note).toContainText('never edits your settings');
    await expect(note.locator('li')).toHaveCount(2);
    await expect(note.locator('[data-hook-event="Stop"]')).toContainText(
      'Add the line at the top of $HOME/.claude/sounds/play.sh',
    );
    const inline = note.locator('[data-hook-event="Notification"]');
    await expect(inline).toContainText('inline, not a script');
    await expect(inline.getByTestId('copy-line')).toContainText(
      '[ -n "$PATCHROOM_SESSION" ] && exit 0; afplay /System/Library/Sounds/Notification.aiff',
    );
    await expect(note.locator('[data-hook-event="SessionStart"]')).toHaveCount(0);
  });

  test('no note when every sound hook is guarded', async ({ page }) => {
    await openPrefs(page, 'guarded=Stop');
    await tab(page, 'Sounds');
    await expect(page.getByTestId('prefs-sounds')).toBeVisible();
    await expect(page.getByTestId('sound-hooks-note')).toHaveCount(0);
  });
});
