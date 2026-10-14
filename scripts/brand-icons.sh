#!/usr/bin/env bash
# Rebuild src-tauri/icons/ from the two brand SVGs. Needs pnpm, node, python3, sips, iconutil, Playwright chromium.
# Sources: patchroom-mark.svg (48px and up) plus pixel-fit drawings authored on their own grids: patchroom-mark-small-16.svg (16px) and
# patchroom-mark-small-32.svg (32px, also shown 2x for 64px and scaled for 24px). patchroom-mark-small.svg is a copy of the 32px drawing.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BRAND="$ROOT/ui/public/brand"
ICONS="$ROOT/src-tauri/icons"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

# 1. Render the 1024 master and every raster size (small drawing for <= 64px).
(cd "$ROOT/ui" && node --input-type=module - "$BRAND" "$WORK" <<'JS'
import { chromium } from '@playwright/test';
import { readFileSync, writeFileSync } from 'node:fs';
const [brand, work] = process.argv.slice(2);
const uri = (f) => 'data:image/svg+xml;base64,' + readFileSync(`${brand}/${f}`).toString('base64');
const full = uri('patchroom-mark.svg');
const s16 = uri('patchroom-mark-small-16.svg');
const s32 = uri('patchroom-mark-small-32.svg');
// macOS grid: body 824 of 1024, centered, soft drop shadow, transparent corners.
const master = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/></filter></defs>
  <image href="${full}" x="100" y="100" width="824" height="824" filter="url(#s)"/></svg>`;
// Small sizes: the drawing's viewBox equals its pixel size and the body already carries its own margin, so it is shown 1:1 (or 2x) with no shadow.
const flat = (href, size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image href="${href}" width="${size}" height="${size}"/></svg>`;
const browser = await chromium.launch();
const page = await browser.newPage();
async function shot(svg, size, out) {
  await page.setViewportSize({ width: size, height: size });
  await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
  await page.waitForFunction(() => [...document.images].every((i) => i.complete), null, { timeout: 2000 }).catch(() => {});
  await page.waitForTimeout(150);
  await page.screenshot({ path: `${work}/${out}`, omitBackground: true });
}
await shot(master, 1024, 'master.png');
for (const s of [128, 256, 512, 1024, 48]) await shot(master, s, `full-${s}.png`);
await shot(flat(s16, 16), 16, 'small-16.png');
await shot(flat(s32, 32), 32, 'small-32.png');
await shot(flat(s32, 24), 24, 'small-24.png');
await shot(flat(s32, 64), 64, 'small-64.png');
await browser.close();
JS
)

# 2. Let Tauri generate its standard set from the master, then keep the files the bundle config lists.
(cd "$ROOT" && pnpm tauri icon "$WORK/master.png" -o "$WORK/tauri-out" >/dev/null)
for f in 128x128.png 128x128@2x.png icon.png; do cp "$WORK/tauri-out/$f" "$ICONS/$f"; done
cp "$WORK/small-32.png" "$ICONS/32x32.png"

# 3. icns via iconutil: small drawing for 16, 16@2x, 32, 32@2x; full mark above that.
SET="$WORK/patchroom.iconset"
mkdir "$SET"
cp "$WORK/small-16.png" "$SET/icon_16x16.png"
cp "$WORK/small-32.png" "$SET/icon_16x16@2x.png"
cp "$WORK/small-32.png" "$SET/icon_32x32.png"
cp "$WORK/small-64.png" "$SET/icon_32x32@2x.png"
cp "$WORK/tauri-out/128x128.png" "$SET/icon_128x128.png"
cp "$WORK/full-256.png" "$SET/icon_128x128@2x.png"
cp "$WORK/full-256.png" "$SET/icon_256x256.png"
cp "$WORK/full-512.png" "$SET/icon_256x256@2x.png"
cp "$WORK/full-512.png" "$SET/icon_512x512.png"
cp "$WORK/full-1024.png" "$SET/icon_512x512@2x.png"
iconutil -c icns "$SET" -o "$ICONS/icon.icns"

# 4. ico with embedded PNGs: small drawing at 16, 24, 32; full mark at 48, 64+.
python3 -I - "$WORK" "$ICONS/icon.ico" <<'PY'
import struct, sys
work, out = sys.argv[1:3]
entries = [(16, 'small-16'), (24, 'small-24'), (32, 'small-32'), (48, 'full-48'), (64, 'small-64'), (128, 'full-128'), (256, 'full-256')]
# 64px also uses the small drawing, matching the 32@2x iconset entry.
blobs = [(s, open(f'{work}/{n}.png', 'rb').read()) for s, n in entries]
head = struct.pack('<HHH', 0, 1, len(blobs))
off = 6 + 16 * len(blobs)
dirs, data = b'', b''
for s, b in blobs:
    dirs += struct.pack('<BBBBHHII', s % 256, s % 256, 0, 0, 1, 32, len(b), off + len(data))
    data += b
open(out, 'wb').write(head + dirs + data)
PY
echo "icons rebuilt in $ICONS"
