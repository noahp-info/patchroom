import { expect, test } from '@playwright/test';
import { bytes, drain, openWithDm, peekWrites, takeWrites } from './helpers';

// Keyboard parity: what reaches the pty must be exactly what iTerm2 sends claude.
// The IPC is mocked; assertions read the bytes `session_write` received.

const CASES: { name: string; press: string[]; want: string }[] = [
  { name: 'Esc', press: ['Escape'], want: '\x1b' },
  { name: 'Esc Esc', press: ['Escape', 'Escape'], want: '\x1b\x1b' },
  { name: 'Shift+Tab', press: ['Shift+Tab'], want: '\x1b[Z' },
  { name: 'Tab', press: ['Tab'], want: '\t' },
  { name: 'Ctrl+C', press: ['Control+c'], want: '\x03' },
  { name: 'Ctrl+R', press: ['Control+r'], want: '\x12' },
  { name: 'Ctrl+O', press: ['Control+o'], want: '\x0f' },
  { name: 'Ctrl+V', press: ['Control+v'], want: '\x16' },
  { name: 'Up', press: ['ArrowUp'], want: '\x1b[A' },
  { name: 'Down', press: ['ArrowDown'], want: '\x1b[B' },
  { name: 'Right', press: ['ArrowRight'], want: '\x1b[C' },
  { name: 'Left', press: ['ArrowLeft'], want: '\x1b[D' },
  { name: 'Enter', press: ['Enter'], want: '\r' },
  { name: 'Backspace', press: ['Backspace'], want: '\x7f' },
  { name: 'digits 1 2 3 4', press: ['1', '2', '3', '4'], want: '1234' },
  {
    name: 'Shift+Enter (newline, kitty form iTerm2 sends)',
    press: ['Shift+Enter'],
    want: '\x1b[13;2u',
  },
  { name: 'Option+Enter (Esc+ Return)', press: ['Alt+Enter'], want: '\x1b\r' },
  { name: 'Option+b (Meta)', press: ['Alt+b'], want: '\x1bb' },
  { name: 'Option+f (Meta)', press: ['Alt+f'], want: '\x1bf' },
];

test.describe('keyboard parity', () => {
  for (const c of CASES) {
    test(c.name, async ({ page }) => {
      const id = await openWithDm(page);
      await takeWrites(page, id);
      for (const k of c.press) await page.keyboard.press(k);
      await expect.poll(() => peekWrites(page, id)).toBe(bytes(c.want).join(','));
    });
  }

  test('typed text and unicode arrive as UTF-8', async ({ page }) => {
    const id = await openWithDm(page);
    await takeWrites(page, id);
    await page.keyboard.insertText('héllo ✅');
    await expect.poll(() => peekWrites(page, id)).toBe(bytes('héllo ✅').join(','));
  });

  test('bytes keep their order under a burst', async ({ page }) => {
    const id = await openWithDm(page);
    await takeWrites(page, id);
    const text = Array.from({ length: 200 }, (_, i) => String.fromCharCode(97 + (i % 26))).join('');
    await page.keyboard.insertText(text);
    await expect.poll(() => peekWrites(page, id)).toBe(bytes(text).join(','));
  });

  test('paste is bracketed once the app enables bracketed paste', async ({ page }) => {
    const id = await openWithDm(page);
    await page.evaluate((sid) => window.__PR_MOCK__!.emitText(sid, '\x1b[?2004h'), id);
    await drain(page, id);
    await takeWrites(page, id);
    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea')!;
      const dt = new DataTransfer();
      dt.setData('text/plain', 'line one\nline two');
      ta.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });
    await expect
      .poll(() => peekWrites(page, id))
      .toBe(bytes('\x1b[200~line one\rline two\x1b[201~').join(','));
  });

  test('paste is plain when bracketed paste is off', async ({ page }) => {
    const id = await openWithDm(page);
    await takeWrites(page, id);
    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea')!;
      const dt = new DataTransfer();
      dt.setData('text/plain', 'abc');
      ta.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });
    await expect.poll(() => peekWrites(page, id)).toBe(bytes('abc').join(','));
  });

  test('image-only clipboard forwards Ctrl+V so claude reads the image itself', async ({
    page,
  }) => {
    const id = await openWithDm(page);
    await page.evaluate((sid) => window.__PR_MOCK__!.emitText(sid, '\x1b[?2004h'), id);
    await drain(page, id);
    await takeWrites(page, id);
    await page.evaluate(() => {
      const ta = document.querySelector('.xterm-helper-textarea')!;
      const dt = new DataTransfer();
      dt.items.add(
        new File([new Uint8Array([137, 80, 78, 71])], 'shot.png', { type: 'image/png' }),
      );
      ta.dispatchEvent(
        new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
      );
    });
    await expect.poll(() => peekWrites(page, id)).toBe('22');
  });

  test('mouse reports follow the app mode (SGR)', async ({ page }) => {
    const id = await openWithDm(page);
    await page.evaluate((sid) => window.__PR_MOCK__!.emitText(sid, '\x1b[?1000h\x1b[?1006h'), id);
    await drain(page, id);
    await takeWrites(page, id);
    const box = (await page.locator('.xterm-screen').first().boundingBox())!;
    await page.mouse.click(box.x + 5, box.y + 5);
    await expect
      .poll(async () =>
        String.fromCharCode(...(await page.evaluate((sid) => window.__PR_MOCK__!.writes[sid], id))),
      )
      // eslint-disable-next-line no-control-regex -- the SGR mouse report starts with ESC
      .toMatch(/^\x1b\[<0;\d+;\d+M\x1b\[<0;\d+;\d+m$/);
  });
});
