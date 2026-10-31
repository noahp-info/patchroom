import { expect, test, type Page } from '@playwright/test';
import { openChat } from './helpers';
import { expectNoOverlap } from './qa';
import { anchorAt, matchesShortcut, placeWords } from '../src/lib/dictation';

/*
 * Dictation in the composer, against a mocked dictation IPC. The mock helper says nothing by
 * itself: each test plays the helper's lines (`ready`, `partial`, `final`, `error`, `ended`)
 * through `__PR_MOCK__.dictate`. The real helper needs a microphone and a person, so it is
 * covered by the Rust protocol and lifecycle tests with a fake helper script instead.
 */

const box = (page: Page) => page.getByTestId('composer-input');
const mic = (page: Page) => page.getByTestId('dictate-btn');
const calls = (page: Page) => page.evaluate(() => window.__PR_MOCK__!.dictationCalls.slice());
const say = (page: Page, ev: Record<string, unknown>) =>
  page.evaluate((e) => window.__PR_MOCK__!.dictate(e as never), ev);

test('start, partials at the cursor, final replaces them, Esc stops, nothing sends', async ({
  page,
}) => {
  await openChat(page);
  await box(page).fill('Please fix  in the parser');
  // Cursor between the two spaces: words go there, spaced from both sides.
  await box(page).evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(11, 11));
  await mic(page).click();
  await expect.poll(() => calls(page)).toEqual(['start  8']);
  await expect(mic(page)).toHaveAttribute('data-phase', 'starting');
  await say(page, { type: 'ready', locale: 'en-US' });
  await expect(mic(page)).toHaveAttribute('data-phase', 'listening');
  await expect(mic(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(mic(page)).toContainText('Listening');
  await expect(page.locator('.box[data-dictating]')).toBeVisible();
  await expect(page.getByTestId('composer-hint')).toContainText('Nothing sends');

  await say(page, { type: 'partial', text: 'the' });
  await expect(box(page)).toHaveValue('Please fix the in the parser');
  await say(page, { type: 'partial', text: 'the off by one' });
  await expect(box(page)).toHaveValue('Please fix the off by one in the parser');
  await expectNoOverlap(page);

  await page.keyboard.press('Escape');
  await expect.poll(() => calls(page)).toEqual(['start  8', 'stop 1']);
  await expect(mic(page)).toHaveAttribute('data-phase', 'stopping');
  await say(page, { type: 'final', text: 'the off-by-one' });
  await expect(box(page)).toHaveValue('Please fix the off-by-one in the parser');
  await say(page, { type: 'end' });
  await say(page, { type: 'ended', reason: 'stopped' });
  await expect(mic(page)).toHaveAttribute('data-phase', 'idle');
  await expect(mic(page)).toHaveAttribute('aria-pressed', 'false');
  // The caret sits right after the dictated words.
  expect(await box(page).evaluate((el: HTMLTextAreaElement) => el.selectionStart)).toBe(25);
  // Never sent by itself.
  expect(await page.evaluate(() => window.__PR_MOCK__!.texts.length)).toBe(0);
  // The first use offers the settings once.
  await expect(page.locator('[data-hint="dictation.settings"]')).toBeVisible();
});

test('the shortcut toggles it, Enter stops instead of sending, blur stops', async ({ page }) => {
  await openChat(page);
  await box(page).focus();
  await page.keyboard.press('Meta+Shift+D');
  await expect.poll(() => calls(page)).toEqual(['start  8']);
  await say(page, { type: 'ready' });
  await say(page, { type: 'partial', text: 'run the tests' });
  await expect(box(page)).toHaveValue('run the tests');
  await page.keyboard.press('Enter');
  await expect.poll(() => calls(page)).toEqual(['start  8', 'stop 1']);
  expect(await page.evaluate(() => window.__PR_MOCK__!.texts.length)).toBe(0);
  await say(page, { type: 'final', text: 'Run the tests.' });
  await say(page, { type: 'ended', reason: 'stopped' });
  await expect(box(page)).toHaveValue('Run the tests.');

  // Again with the shortcut; leaving the window stops it.
  await page.keyboard.press('Meta+Shift+D');
  await expect.poll(async () => (await calls(page)).length).toBe(3);
  await say(page, { type: 'ready' });
  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect.poll(() => calls(page)).toEqual(['start  8', 'stop 1', 'start  8', 'stop 2']);
  await say(page, { type: 'ended', reason: 'stopped' });
  await expect(mic(page)).toHaveAttribute('data-phase', 'idle');
});

test('silence ends it with a note; typing mid-dictation keeps both', async ({ page }) => {
  await openChat(page);
  await mic(page).click();
  await say(page, { type: 'ready' });
  await say(page, { type: 'partial', text: 'hello' });
  await expect(box(page)).toHaveValue('hello');
  // The person types; the next words land after what they typed.
  await box(page).press('End');
  await page.keyboard.type(' there,');
  await say(page, { type: 'partial', text: 'hello how are you' });
  await expect(box(page)).toHaveValue('hello there, how are you');
  await say(page, { type: 'final', text: 'hello how are you' });
  await say(page, { type: 'ended', reason: 'silence' });
  const note = page.getByTestId('dictation-notice');
  await expect(note).toHaveAttribute('data-kind', 'dict-note');
  await expect(note).toContainText('stopped after 8 seconds of silence');
  await expectNoOverlap(page);
});

test('denied: a clear message and a button to the right System Settings pane', async ({ page }) => {
  await openChat(page);
  await mic(page).click();
  await say(page, {
    type: 'error',
    code: 'mic_denied',
    message: 'Microphone access is turned off for Patchroom.',
  });
  await say(page, { type: 'ended', reason: 'error' });
  const note = page.getByTestId('dictation-notice');
  await expect(note).toHaveAttribute('data-code', 'mic_denied');
  await expect(note).toContainText('Microphone access is off for Patchroom');
  await page.getByTestId('dictation-settings').click();
  await expect.poll(() => calls(page)).toContain('settings microphone');
  await expect(mic(page)).toHaveAttribute('data-phase', 'idle');
  await expectNoOverlap(page);

  // Speech Recognition denied opens the Speech Recognition pane.
  await mic(page).click();
  await expect(note).toHaveCount(0);
  await say(page, { type: 'error', code: 'speech_denied' });
  await say(page, { type: 'ended', reason: 'error' });
  await expect(note).toContainText('Speech Recognition is off');
  await page.getByTestId('dictation-settings').click();
  await expect.poll(() => calls(page)).toContain('settings speech');
  await page.getByTestId('dictation-dismiss').click();
  await expect(note).toHaveCount(0);
  // No hint after a run that heard nothing.
  await expect(page.locator('[data-hint="dictation.settings"]')).toHaveCount(0);
});

test('unavailable locale: no server fallback, a link to download the language', async ({
  page,
}) => {
  await openChat(page);
  await mic(page).click();
  await say(page, {
    type: 'error',
    code: 'on_device_unavailable',
    locale: 'fr-FR',
    language: 'French (France)',
  });
  await say(page, { type: 'ended', reason: 'error' });
  const note = page.getByTestId('dictation-notice');
  await expect(note).toContainText('On-device dictation isn’t available for French (France)');
  await page.getByTestId('dictation-settings').click();
  await expect.poll(() => calls(page)).toContain('settings dictation');
  // One start only: nothing retried another way.
  expect((await calls(page)).filter((c) => c.startsWith('start'))).toHaveLength(1);
});

test('Settings > Dictation: language, shortcut, timeout and off', async ({ page }) => {
  await openChat(page);
  await page.keyboard.press('Meta+,');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByText('Dictation').click();
  const sec = page.getByTestId('prefs-dictation');
  await expect(sec).toBeVisible();
  await expect(sec.getByTestId('dictation-perms')).toContainText('Not asked yet');
  const lang = sec.getByTestId('dictation-language');
  await expect(lang.locator('option').first()).toHaveText(
    'System language (English (United States))',
  );
  await lang.selectOption('fr-FR');
  await expect(sec.getByTestId('dictation-download')).toContainText('French (France)');
  await sec.getByRole('radio', { name: '⌃⌘D' }).check();
  await sec.getByRole('radio', { name: '15 seconds' }).check();
  await expect
    .poll(() => page.evaluate(() => window.__PR_MOCK__!.prefs().dictation))
    .toEqual({ enabled: true, locale: 'fr-FR', shortcut: 'ctrl-cmd-d', silenceSecs: 15 });
  await sec.getByTestId('dictation-enabled').uncheck();
  await page.keyboard.press('Escape');
  await expect(mic(page)).toHaveCount(0);
  // Off means the shortcut does nothing either.
  await box(page).focus();
  await page.keyboard.press('Control+Meta+D');
  expect((await calls(page)).filter((c) => c.startsWith('start'))).toHaveLength(0);
});

test('the new shortcut and locale reach the helper', async ({ page }) => {
  await openChat(page);
  await page.keyboard.press('Meta+,');
  await page.getByRole('navigation', { name: 'Settings sections' }).getByText('Dictation').click();
  const sec = page.getByTestId('prefs-dictation');
  await sec.getByTestId('dictation-language').selectOption('en-GB');
  await sec.getByRole('radio', { name: '⌘⇧.' }).check();
  await sec.getByRole('radio', { name: '4 seconds' }).check();
  await page.keyboard.press('Escape');
  await box(page).focus();
  await page.keyboard.press('Meta+Shift+Period');
  await expect.poll(() => calls(page)).toContain('start en-GB 4');
});

test('placing words: spacing, selection replace, cumulative partials', () => {
  const a = anchorAt('ab', 2, 2);
  expect(placeWords(a, 'cd')).toEqual({ text: 'ab cd', caret: 5 });
  const b = anchorAt('one two three', 4, 7);
  expect(placeWords(b, 'TWO')).toEqual({ text: 'one TWO three', caret: 7 });
  expect(placeWords(anchorAt('', 0, 0), '  hi ')).toEqual({ text: 'hi', caret: 2 });
  expect(placeWords({ before: 'hi there, ', after: '', skip: 'hi' }, 'hi how')).toEqual({
    text: 'hi there, how',
    caret: 13,
  });
  const key = (o: Partial<KeyboardEvent>) =>
    ({ altKey: false, repeat: false, ...o }) as KeyboardEvent;
  expect(
    matchesShortcut(key({ key: 'D', code: 'KeyD', metaKey: true, shiftKey: true }), 'cmd-shift-d'),
  ).toBe(true);
  expect(matchesShortcut(key({ key: 'd', code: 'KeyD', metaKey: true }), 'cmd-shift-d')).toBe(
    false,
  );
  expect(
    matchesShortcut(key({ key: 'd', code: 'KeyD', metaKey: true, shiftKey: true }), 'off'),
  ).toBe(false);
});
