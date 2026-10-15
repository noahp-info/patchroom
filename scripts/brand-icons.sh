#!/usr/bin/env bash
# Rebuild src-tauri/icons/ from the two brand SVGs. Needs pnpm, node, python3, sips, iconutil, Playwright chromium.
# Sources: patchroom-mark.svg (128px and up) and patchroom-mark-small.svg (16 to 64px: the same mark, heavier strokes, no plug
# highlights). Both sit on the macOS grid (body 824 of 1024, centered) so the small sizes match the Dock icon and other apps.
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
const small = uri('patchroom-mark-small.svg');
// macOS grid: body 824 of 1024, centered, soft drop shadow, transparent corners.
const master = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs><filter id="s" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="12" stdDeviation="14" flood-color="#000" flood-opacity="0.35"/></filter></defs>
  <image href="${full}" x="100" y="100" width="824" height="824" filter="url(#s)"/></svg>`;
// Small sizes: the heavier mark on the same grid, without the shadow (it only muddies a 16px tile).
const flat = (href, size) => `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><image href="${href}" x="${(size * 100) / 1024}" y="${(size * 100) / 1024}" width="${(size * 824) / 1024}" height="${(size * 824) / 1024}"/></svg>`;
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
for (const s of [16, 24, 32, 64]) await shot(flat(small, s), s, `small-${s}.png`);
await browser.close();
JS
)

# 2. Let Tauri generate its standard set from the master, then keep the files the bundle config lists.
(cd "$ROOT" && pnpm tauri icon "$WORK/master.png" -o "$WORK/tauri-out" >/dev/null)
for f in 128x128.png 128x128@2x.png icon.png; do cp "$WORK/tauri-out/$f" "$ICONS/$f"; done
cp "$WORK/small-32.png" "$ICONS/32x32.png"

# 3. icns via iconutil: small mark for 16, 16@2x, 32, 32@2x; full mark above that.
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

# 4. ico with embedded PNGs: small mark at 16, 24, 32, 64; full mark at 48, 128+.
python3 -I - "$WORK" "$ICONS/icon.ico" <<'PY'
import struct, sys
work, out = sys.argv[1:3]
entries = [(16, 'small-16'), (24, 'small-24'), (32, 'small-32'), (48, 'full-48'), (64, 'small-64'), (128, 'full-128'), (256, 'full-256')]
# 64px also uses the small mark, matching the 32@2x iconset entry.
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
