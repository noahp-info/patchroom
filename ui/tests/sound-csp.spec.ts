import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/*
 * The CC0 packs play from the data URLs `sound_file` returns. The app page runs under the CSP in
 * src-tauri/tauri.conf.json, and the mock harness runs under none, so a policy that refuses
 * `data:` media passes every other test while every file sound falls back to the default pack.
 * This probe loads a real bundled sound under the shipped policy, in a page served from the
 * test server's own origin.
 */
const conf = JSON.parse(
  readFileSync(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
) as { app: { security: { csp: string } } };
const SHIPPED = conf.app.security.csp;
const sound = readFileSync(
  new URL('../../plugins/sounds/lab-glass/sounds/done.m4a', import.meta.url),
).toString('base64');
const DATA_URL = `data:audio/mp4;base64,${sound}`;

/** Loads one `<audio>` from the data URL under `csp`; resolves to the CSP violations seen. */
async function probe(page: Page, csp: string): Promise<string[]> {
  const html = `<!doctype html><html><head>
<meta http-equiv="Content-Security-Policy" content="${csp.replace(/"/g, '&quot;')}">
<script src="/__csp_probe.js"></script></head><body></body></html>`;
  const js = `
window.__violations = [];
document.addEventListener('securitypolicyviolation', (e) =>
  window.__violations.push(e.effectiveDirective + ' ' + e.blockedURI));
window.__probe = (src) => new Promise((done) => {
  const a = new Audio(src);
  a.preload = 'auto';
  const end = () => setTimeout(() => done(window.__violations), 200);
  a.addEventListener('error', end);
  a.addEventListener('loadedmetadata', end);
  setTimeout(end, 3000);
  a.load();
});`;
  await page.route('**/__csp_probe.html', (r) =>
    r.fulfill({ contentType: 'text/html', body: html }),
  );
  await page.route('**/__csp_probe.js', (r) =>
    r.fulfill({ contentType: 'text/javascript', body: js }),
  );
  await page.goto('/__csp_probe.html');
  return page.evaluate(
    (src) => (window as unknown as { __probe(s: string): Promise<string[]> }).__probe(src),
    DATA_URL,
  );
}

test('the shipped CSP lets a bundled CC0 sound load from its data URL', async ({ page }) => {
  expect(await probe(page, SHIPPED)).toEqual([]);
});

test('the probe catches a CSP that refuses data: media (the CC0 fallback bug)', async ({
  page,
}) => {
  const old = SHIPPED.replace(/media-src [^;]*;\s*/, '');
  expect(old).not.toContain('media-src');
  const seen = await probe(page, old);
  expect(seen.some((v) => v.startsWith('media-src data'))).toBe(true);
});
