# Gauntlet bar: sidebar organization and contrast

From Noah's first hands-on test of P3, 2026-10-14: "the contrast between sections and DMs is difficult to see, it looks noisy"; branch lines saying "dev" add too many lines; wants Slack-style emoji in sections and dividers placed anywhere, with collapsing.

## Bar statement

At a glance, the sidebar reads as headers and items. Section headers are clearly stronger than DM rows: strongest sidebar ink, bold, with a hairline rule above each one. Every row is one line. Users can add labeled or unlabeled dividers anywhere and collapse a labeled divider to fold the whole group below it. Collapsing never hides something waiting on the user. Sections take an emoji the way Slack's do.

## Checklist

1. **Hierarchy:**
   - Section headers use `side-strong` at 700 weight. DM rows use `side-fg` at 400. A `side-line` hairline sits above each section, but not above the first one.
   - Measured contrast:
     - header against the band: 7:1 or better, in every shipped theme in light and dark
     - header against a row: at least 1.5:1 more than the row itself has against the band
2. **One-line rows:**
   - Folder-session rows and DM rows are one line.
   - The branch chip shows only when the session's branch differs from the folder's current branch (`git rev-parse --abbrev-ref HEAD` in the section folder, read only).
   - A worktree session shows a small worktree glyph, not a path line.
   - Branch, path and last prompt live in the hover card.
3. **Emoji:**
   - Create and rename section offer an emoji picker. They reuse the P3 reaction picker and its recents.
   - The emoji renders as the header's leading icon, and typed emoji also work. Stored in the section name or a new `emoji` field.
   - It survives restart.
4. **Dividers:**
   - "New divider" in the + menu and in the section context menu. Dividers take an optional label and can be dragged anywhere among sections, like sections.
   - A labeled divider collapses every section below it, up to the next divider. An unlabeled divider is a rule only.
   - Rename, delete and reorder work. Deleting a divider never deletes its sections.
   - Everything survives restart.
5. **Collapse never hides what needs you:**
   - A collapsed section or divider group still shows any needs-you DM inside it, as a row under its header.
   - The header shows the needs-you count, red, and the unread count.
6. **Option+click on any header** collapses or expands all sections and groups.
7. **Keyboard:** dividers and headers are reachable, Enter or Space toggles collapse, and Cmd+K still finds DMs in collapsed groups.
8. **Rendered readability, the same standard as Noah's proQueue mobile QA:**
   - The Impeccable detector (`npx impeccable detect`, as used in gamerNetworking's design-mockup) reports zero low-contrast-text and zero undersized-functional-text findings on the sidebar markup and CSS.
   - An axe-core `color-contrast` scan of the rendered sidebar (headers, rows, chips, badges, dividers, hover card) passes in all four themes, light and dark: text at least 4.5:1, large text and UI glyphs at least 3:1.
   - Add the axe scan as a permanent Playwright spec, so CI enforces it from now on.
9. **No regressions:** cargo fmt, clippy, test; ui lint, build, the full Playwright suite with no assertions loosened; the debug build; P3 stored sections and prefs load unchanged.

## Contract

- Store migration `0005`: `section.kind` (`'section' | 'divider'`, default `'section'`), `section.emoji` (nullable).
- `SectionInfo` gains `kind` and `emoji`.
- Commands: `section_create {name, kind?, emoji?}` (kind defaults to section), `section_set_emoji {id, emoji|null}`. `section_reorder` already orders both kinds. `folder_sessions` rows gain `folderBranch` (the folder's current branch).

## Inspection

- Playwright against the mock IPC, every theme in light and dark: measure the contrast pairs and screenshot the sidebar with real-looking data (a gamerNetworking-like folder with 30 sessions, mostly on dev).
- Test emoji, dividers, collapse with a needs-you DM inside, Option+click, keyboard, and restart persistence.
- Run the Rust tests for the migration and the old-data load.
- Run the /impeccable critique on the sidebar.
