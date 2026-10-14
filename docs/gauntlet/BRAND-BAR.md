# Gauntlet bar: Patchroom brand (palette 6, Branch bay)

Decided by Noah, 2026-10-14:
- The mark is Branch bay: two sockets on rails, with one cable patching them.
- Palette 6: jade tile `#135a4b`, chalk line work `#f7f3e8`, marigold rubber cable `#f2c35b`, silver metal plugs `#c7cdd0` with highlight `#f4f6f7`.
- The default app theme moves to jade, and every customization stays.
- The Patch Bay ("fun") look inherits the jade colors and still offers presets with different cable and plug colors.

## Bar statement

The app, its icon and its docs show one brand. The macOS icon is the Branch bay mark in palette 6 at every size Tauri ships. It holds its shape at 16 and 32px through a dedicated small drawing, not a downscale. Homeroom, the default theme, is retuned from spruce to jade in light and dark, and every text pair still meets WCAG AA. The Patch Bay base renders cables in a cable color and plugs in a plug metal, both theme tokens. The jade default drives Patch Bay with a marigold cable and silver plugs. At least four presets ship with other cable and plug pairs. Nothing a user already customized changes: custom themes, imported Slack themes, the per-DM terminal look, and stored prefs all keep working.

## Pass criteria

1. **Icons:** `src-tauri/icons/` is regenerated from a 1024px master (`pnpm tauri icon`), and the purple placeholder is gone.
   - A hand-tuned 16px and 32px drawing is used for those sizes in the icns and ico: thicker strokes, larger plugs.
   - The master SVG is committed at `ui/public/brand/patchroom-mark.svg`, along with the small drawing.
2. **Homeroom jade, both modes:**
   - Brand roles: `side-bg` and `panel` from jade, `ws-mark` from the mark, the active row keeps marigold, and `accent` stays a text-safe teal-green that is distinct from the jade band.
   - `parseTheme(text, { requireAA: true })` passes, and the contrast report shows no failing pair.
   - The four themes stay distinct from one another.
3. **Cable and plug tokens:**
   - Add `cable` and `plug` to the `hardware` group in `tokens.ts`, the schema and every shipped theme.
   - The Patch Bay base draws `.cable` in `cable` and every plug or nut highlight in `plug`.
   - Imported Slack themes derive both tokens, so old custom themes still validate. Missing tokens are filled on load, never rejected.
4. **Presets:** at least four Patch Bay cable and plug presets appear in Preferences > Themes, with names and live previews. For example:
   - Jade (marigold and silver, the default)
   - Signal (red and silver)
   - Studio (black and brass)
   - Ocean (blue and silver)
   - Copper (burnt orange and brass)

   Each passes AA. A preset changes only `cable` and `plug`, never the base palette.
5. **DESIGN.md:**
   - A Brand section covers the mark, palette 6 with roles, clear space, minimum sizes, do and don't, and the Claude-orange caution.
   - The shipped-themes list and the Homeroom hexes are updated, and the frontmatter colors match.
6. **Nothing regresses:** lint, build, the full Playwright suite (theme specs updated, no assertions loosened), theme-preview tests, cargo tests and the debug build all pass.
   - Screenshot every theme in light and dark: no off-system colors.
   - A user's stored custom theme and stored prefs from P3 load unchanged.

## Inspection

- Render the icns at 16, 32, 128 and 512 and look at each.
- Run the contrast report.
- Use Playwright against the mock IPC to switch every theme, base and preset in light and dark, and screenshot each.
- Load a fixture of P3-era prefs plus a custom theme missing the new tokens, and confirm it loads and validates.
- Read DESIGN.md.
