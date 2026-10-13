---
name: Patchroom
description: Slack-style chat over real AI coding CLI sessions. Two-layer design system, base x color theme.
colors:
  homeroom-ground: "#ffffff"
  homeroom-ink: "#1d2122"
  homeroom-sidebar-band: "#1c3a39"
  homeroom-active-row: "#f2c35b"
  homeroom-primary: "#0f7a6e"
  homeroom-needs-you: "#d63a2f"
  homeroom-busy: "#3fbf6a"
  patchbay-panel: "#d6d2c9"
  patchbay-silkscreen: "#24221f"
  patchbay-cable-red: "#c4432f"
  patchbay-cable-yellow: "#d99a1e"
typography:
  ui-homeroom:
    fontFamily: "Figtree, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.45
  mono-homeroom:
    fontFamily: "JetBrains Mono, ui-monospace, Menlo, monospace"
    fontSize: "12.5px"
  ui-patchbay:
    fontFamily: "Barlow, ui-sans-serif, system-ui, sans-serif"
    fontSize: "14px"
  label-patchbay:
    fontFamily: "Barlow Condensed, Arial Narrow, sans-serif"
    fontWeight: 700
    letterSpacing: "0.08em"
  mono-patchbay:
    fontFamily: "Red Hat Mono, ui-monospace, Menlo, monospace"
rounded:
  homeroom-sm: "5px"
  homeroom-md: "8px"
  patchbay-sm: "3px"
  patchbay-md: "4px"
spacing:
  gutter: "18px"
  row-height: "28px"
  log-gap: "14px"
components:
  sidebar-row:
    height: "28px"
    rounded: "{rounded.homeroom-sm}"
    padding: "4px 8px"
  button-primary:
    backgroundColor: "{colors.homeroom-primary}"
    textColor: "#ffffff"
    rounded: "{rounded.homeroom-sm}"
    height: "30px"
    padding: "0 12px"
---

# Design System: Patchroom

Patchroom has two independent design layers. A **base** decides structure. A **color theme** decides color. Any base takes any theme. Swapping a theme rewrites CSS custom properties and nothing else.

| Layer | Owns | Never owns | Lives in |
| --- | --- | --- | --- |
| Base | layout, density, type, chrome, base-only elements | any color | `ui/src/theme/base.css`, `ui/src/theme/bases/<id>.css` |
| Color theme | 83 color tokens, once for light and once for dark | any size, font or shape | `plugins/themes/<id>/themes/<id>.json` |

Both layers meet at one contract: the token list in `ui/src/theme/tokens.ts`. A test fails the build if CSS contains a color literal, or uses a variable that is neither a token nor a documented base variable.

## Overview

**Creative North Star: "The Workshop Chat"**

Patchroom looks like the chat app you already keep open, so the only new idea is that the people are agents. The default base, Homeroom, follows Slack's grammar: a sidebar band, a message log, a composer, a right-hand pane. Patch Bay is the same screen as a hardware panel.

Presence uses shape as well as color in every base: filled for busy, hollow for idle, ringed for needs you, a diamond for errored. Patch Bay moves presence onto jacks with an LED. The shape rule holds there too.

**Key Characteristics:**
- Dense, calm, scan-first. Rows are 28px. Body text is 14px.
- Color carries state, not decoration. One accent, one needs-you color.
- The ask widget and the Stop button are the loudest things on screen, because they are what needs the person.
- Assistant, tool and artifact chrome stays quiet until it matters.

## Colors

Colors come only from the theme. Each theme ships a full token set for light and for dark. The default theme, Homeroom, is a deep spruce band with a marigold active row.

### Token list (83 per mode)

| Group | Tokens | Role |
| --- | --- | --- |
| surface | `bg` `fg` `muted` `line` `hover` `surface` `frame` `sel` | Main pane ground, ink, hairlines, hover wash, raised surface, window frame, selection |
| titlebar | `tb-bg` `tb-fg` `tb-muted` `tb-field` `tb-line` | Title bar and search field |
| sidebar | `side-bg` `side-fg` `side-muted` `side-strong` `side-line` `side-hover` `side-active` `side-active-fg` `ws-mark` `ws-mark-fg` | Sidebar ground, text roles, active row, workspace mark |
| accent | `accent` `accent-hover` `accent-fg` `accent-text` `link` | Primary action, its text-safe twin, links |
| status | `needs` `needs-fg` `busy` `idle` `err` `err-text` `ok` `unread` `unread-fg` | Presence and attention. `err` is for dots, LEDs and borders. `err-text` is the text-safe error color on light and dark surfaces |
| provider | `g-claude` `g-cursor` `g-codex` | Provider glyph colors |
| chrome | `chip` `chip-fg` `mode-bg` `mode-fg` `ctx` `av-user` `av-user-fg` `av-bot` `code-bg` `mark` `mark-line` `ask-line` `ask-head` `ask-head-fg` `opt-sel` `opt-sel-line` `box-line` `box-bg` `q-bg` `stop-line` `stop` | Chips, status strip, avatars, inline code, highlights, ask widget, composer, Stop |
| artifact | `art-bg` `art-sheet` `hunk` `add-bg` `add-gut` `del-bg` `del-gut` `syn-kw` `syn-cm` `syn-ty` `syn-fn` | Artifact pane, diff gutters and fills, syntax |
| hardware | `panel` `panel-2` `panel-edge` `silk` `silk-muted` `nut` `hole` `c-red` `c-yellow` `c-blue` `c-green` | Patch Bay panel, silkscreen, jack parts, four cable colors |

Every token becomes `--<token>` on the `.pr-app` root. Values are `#rgb`, `#rgba`, `#rrggbb`, `#rrggbbaa` or `transparent`.

### Shipped themes

- **Homeroom** (default): spruce band, marigold active row, teal primary. From direction A of `looks.html`.
- **Patch Bay**: anodized panel greys, silkscreen ink, red primary, four cable colors. From direction D.
- **Ansi Slate**: cool slate with ANSI cyan, red and amber. From direction B.
- **Cool Paper**: cool grey paper with copy-editor blue and red pencil. From direction C.

### Rules for creating a theme

1. Ship a data-only plugin: `plugins/themes/<id>/.claude-plugin/plugin.json` with `patchroom.kind: "data"` and a `patchroom.themes` entry, plus `themes/<id>.json`. Register the plugin in `plugins/themes/.claude-plugin/marketplace.json`. No hooks, MCP servers, commands or scripts.
2. Define every token for both `light` and `dark`. A theme that skips one is rejected. This is what lets any theme drive any base.
3. Define the `hardware` group even if the theme is not meant for Patch Bay. Map it from the sidebar: `panel` from `side-bg`, `silk` from `side-fg`, cables from `needs`, `busy` and the accent.
4. Meet WCAG AA for text. `CONTRAST_PAIRS` in `tokens.ts` lists 69 text pairs, each with its minimum. Run `node --experimental-strip-types tools/contrast-report.ts` in `ui/theme-preview`. Fix by moving the foreground, never the ground.
5. Keep presence readable without color: shape comes from the base, but `needs`, `busy`, `idle` and `err` still need to stay distinct from one another and from the sidebar ground.
6. Do not use color to change layout. A theme has no sizes, fonts, radii or shadows.
7. Validate with `parseTheme(text, { requireAA: true })` from `ui/src/theme`. The JSON schema is `ui/src/theme/theme.schema.json`, generated from the token list by `tools/gen-schema.ts`.

### Slack theme-string import

`importSlackTheme(string, { base, id, name })` maps Slack's ten colors, in order, to tokens: `column_bg` to `side-bg` and `panel`, `menu_bg_hover` to `side-hover` (when `hover_item` is absent), `active_item` to `side-active`, `accent`, `link` and `ws-mark`, `active_item_text` to `side-active-fg`, `hover_item` to `side-hover`, `text_color` to `side-fg`, `active_presence` to `busy`, `mention_badge` to `needs`, `top_nav_bg` to `tb-bg`, `top_nav_text` to `tb-fg`. The first four are required. The base theme supplies every other token. Failing text pairs are repaired to AA, foreground only.

### Named Rules

**The No Color In CSS Rule.** A base never names a color. Neutral black or white alpha for shadows and glints, and the three macOS window-control dots, are the only literals.

**The One Needs-You Rule.** `needs` marks only things waiting on the person. It never decorates.

## Typography

**Homeroom:** Figtree for UI and messages, JetBrains Mono for code and the status strip.
**Patch Bay:** Barlow for body, Barlow Condensed in caps with 0.06 to 0.14em tracking for silkscreen labels, Red Hat Mono for code.
Fonts are self-hosted Latin subsets in `ui/src/theme/fonts` (OFL), declared in `fonts.css`.

### Hierarchy (Homeroom)
- **Channel title** (700, 16px): the open conversation.
- **Message** (400, 14px, 1.45, 72ch max): user and assistant text.
- **Ask question** (700, 15px): the AskUserQuestion prompt.
- **Meta** (400, 12.5px, `muted`): timestamps, branch, path.
- **Code** (JetBrains Mono, 12.5px): inline code and diffs at 12px.

Patch Bay swaps titles, names, buttons, chips and tabs to condensed caps labels at 11 to 20px.

## Layout

A three-column grid under a 40px title bar: sidebar, conversation, artifact pane. Dimensions are base variables, so a base changes them without touching rules.

| Variable | Homeroom | Patch Bay | Meaning |
| --- | --- | --- | --- |
| `--side-w` | 264px | 276px | Sidebar width |
| `--art-w` | 440px | 440px | Artifact pane width |
| `--r` / `--r-sm` | 8px / 5px | 4px / 3px | Panel and control radius |
| `--row-h` | 28px | 28px | Sidebar row height (density) |
| `--gutter` | 18px | 18px (40px log left) | Pane side padding |
| `--log-gap` | 14px | 14px | Space between messages |
| `--text` | 14px | 14px | Base text size |
| `--f-ui` `--f-mono` `--f-label` `--f-prose` | per base | per base | Type stacks |
| `--app-w` `--app-h` `--app-radius` | 100% / 100% / 12px | Patch Bay sets 6px radius | Host sizing |

### Bases

- **Homeroom** (default, ready): the shared chrome kit with Slack's grammar. Few overrides.
- **Patch Bay** (ready): panel chrome, silkscreen labels, jacks instead of presence dots, jack-style radios, and one patch cable from the active DM to the conversation. Base-only elements: `.jack`, `.screw`, `.cable`.
- **Scrollback** (stub): dimensions, radii and type only. To finish: dense rows, tmux status strip, tool calls in TUI grammar.
- **Blue Pencil** (stub): dimensions, radii and type only. To finish: margin timestamps, serif message body, pencil-mark highlights, borderless artifact sheet.

Base-only elements are always in the markup. The shared kit hides them with `display: none`, and the owning base shows them. The `PatchCable` React component measures the active row's jack and the header jack and writes the cable path. It does nothing on other bases.

### Adding a base

1. Add `ui/src/theme/bases/<id>.css`. Scope every rule with `[data-base='<id>']`. Set base variables first, then overrides.
2. Use only `var(--token)` for color. The CSS test enforces this.
3. Register it in `bases.ts` and `index.css`. Mark it `stub` until it renders the whole reference screen.

Shared rules use `:where(.pr-app)`, so they add no specificity and cannot collide with app CSS. Base rules use `[data-base='<id>'] .x`, which is exactly one attribute selector above them.

## Elevation & Depth

Flat by default. The window carries one soft shadow (`0 1px 2px rgb(0 0 0 / .08), 0 18px 40px -18px rgb(0 0 0 / .35)`). Panels separate by hairlines and tonal steps. Patch Bay adds inset bevels (`inset 0 -2px 0 rgb(0 0 0 / .12)`) on chips and primary buttons, and a drop shadow under the cable. All shadows have an offset and a blur.

## Shapes

Homeroom: 5px controls, 8px panels, 14px chips, 9px count badges, 8px avatars. Patch Bay: 3 to 4px everywhere, round jacks and round avatars. Presence is a circle, a ring, a haloed circle, or a rotated diamond.

## Components

- **Sidebar row**: icon or presence mark, name, optional badge. Unread names go bold. The active row takes `side-active`.
- **Message**: avatar, name and time, body. Tool calls render as a single bordered line. Subagent threads render as a stacked-avatar summary.
- **Ask widget**: header with Needs you pill, question, radio options with a Recommended tag, Other line, and footer with Answer in terminal and Send answer.
- **Composer**: chips that prefill (never send), a box with a queued comment, an input, attach, screenshot and slash buttons, Stop, Send.
- **Status strip**: model, folder, context meter, cost, mode, PR, and a verb line.
- **Artifact pane**: tabs, a sheet with a diff and gutters, and a note line.

## Preview and verification

The impeccable detector ran in degraded mode on this machine (its HTML parser modules and puppeteer are not installed), so it returned no findings by regex only. The slop catalog was checked by hand against the CSS: no gradient text, no colored side-stripes above 1px, no glass, no hard offset shadows, no kicker labels, no nested cards.


`ui/theme-preview` renders the reference screen for any base, theme and mode. Run it from that folder:

```bash
cd ui/theme-preview && pnpm exec vite          # then open http://localhost:1430
# ?base=patchbay&theme=cool-paper&mode=dark     pick a combination
# ?view=matrix&mode=light                       every ready base x theme at once
# ?bare=1&base=homeroom&theme=homeroom&mode=dark  the 1400x980 screen alone, for screenshots
node --test tests/theme.test.ts                 # token, schema, AA, Slack, CSS separation tests
node --experimental-strip-types tools/contrast-report.ts
```

### Deviations from the looks reference

Homeroom and Patch Bay match directions A and D of `/Users/NDP/temp/patchroom-design/looks.html` within a few percent of pixels. These changes make every shipped theme pass WCAG AA for text:

- `muted`, `tb-muted`, `side-muted`, `silk-muted`, `syn-*` and `ok` are nudged a few steps darker or lighter where they fell under 4.5:1.
- New token `err-text` carries error text. `err` stays the signal color. The tool deletion count and the artifact "removed lines" count use `err-text`.
- The sidebar error badge draws its `!` in `side-strong` with an `err` border, because no single orange reads on both a dark band and a light panel.
- Homeroom dark `needs-fg` is a near-black tint instead of white, for the needs-you badge (white on that red was 3.4:1).
- The title bar shortcut key background is a blend of `tb-line` and `tb-field` so its text passes.
- The queued-quote marker is a 1px rule, not 2px, to stay clear of the colored side-stripe ban.
- The Patch Bay title bar is a flat `panel-2` fill (the reference used a gradient of one color).
- Patch Bay's cable is the same shape. It is drawn by a React component instead of a script.

## Do's and Don'ts

**Do**
- Add color only as a token, in both modes, with a hardware mapping.
- Keep presence as shape plus color.
- Run the contrast report and the CSS separation test before shipping a theme or a base.

**Don't**
- Put a hex value, `rgb()` color or named color in base CSS.
- Let a theme carry sizes, fonts or shadows.
- Use `needs` for decoration, or gradient text, glass, or colored side-stripes on cards.
- Edit user config from the preview or the theme loader.
