import { expect, test } from '@playwright/test';
import { overlapFindings, ringFindings } from './qa';

// The QA helpers themselves: each rule fires on a page built to break it, and stays quiet on
// a clean one. Without this, a helper that never fires would pass every surface.

test('the overlap helper finds overlap, silent clipping and sideways overflow', async ({
  page,
}) => {
  await page.goto('/?mock');
  await page.locator('.pr-app').waitFor();
  const clean = await overlapFindings(page);
  await page.evaluate(() => {
    const app = document.querySelector('.pr-app')!;
    const box = document.createElement('div');
    box.id = 'qa-bad';
    box.style.cssText = 'position:fixed;left:300px;top:300px;width:400px;z-index:99';
    box.innerHTML =
      '<span style="position:absolute;left:0;top:0">First label</span>' +
      '<span style="position:absolute;left:10px;top:2px">Second label</span>' +
      '<div style="position:absolute;top:40px;width:60px;overflow:hidden;white-space:nowrap">A long clipped sentence with no ellipsis</div>' +
      '';
    app.append(box);
    const wide = document.createElement('div');
    wide.style.cssText = 'grid-column:1/-1;width:3000px;height:2px';
    app.append(wide);
  });
  const bad = await overlapFindings(page);
  expect(clean).toEqual([]);
  expect(bad.some((f) => f.startsWith('overlap: "First label" x "Second label"'))).toBe(true);
  expect(bad.some((f) => f.startsWith('clipped without ellipsis'))).toBe(true);
  expect(bad.some((f) => f.startsWith('horizontal overflow'))).toBe(true);
});

test('the ring helper finds tight frames and touching siblings', async ({ page }) => {
  await page.goto('/?mock');
  await page.locator('.pr-app').waitFor();
  await page.evaluate(() => {
    const app = document.querySelector('.pr-app')!;
    const root = document.createElement('div');
    root.id = 'qa-rings';
    root.innerHTML =
      '<div style="border:1px solid;padding:3px;margin:0">Tight</div>' +
      '<div style="border:1px solid;padding:8px;margin:0">Roomy but touching</div>' +
      '<div style="box-shadow:inset 0 0 0 2px;padding:10px;margin-top:12px">Ring ok</div>';
    app.append(root);
  });
  const found = await ringFindings(page, '#qa-rings');
  expect(found.some((f) => f.startsWith('padding') && f.includes('Tight'))).toBe(true);
  expect(found.some((f) => f.startsWith('siblings 0.0px apart'))).toBe(true);
  expect(found.some((f) => f.includes('Ring ok') && f.startsWith('padding'))).toBe(false);
});
