# Gauntlet bar: one title bar

From Noah, 2026-10-14: "can we remove the double menu bar for the app so that it looks clean with the window options integrated into the jade with no extra top bar?"

## Bar statement

The window has one bar: the app's own top bar (search, Needs you). It carries the macOS window controls, the red, yellow and green buttons, at its left in the app's colors. The grey system title strip ("Patchroom") is gone. The window still drags, double-clicks to zoom, goes full screen and keeps its shadow and rounded corners.

## Checklist

1. **Window style:** `src-tauri/tauri.conf.json` sets the main window to `titleBarStyle: "Overlay"` with `hiddenTitle: true`. Every window created later in code gets the same.
2. **Room for the controls:** the app top bar reserves space on the left so nothing sits under the controls. The workspace header and search stay clear of them at every width from 880px up. The controls are vertically centered in the top bar; tune `trafficLightPosition` if needed.
3. **Dragging:**
   - The top bar's empty areas drag the window (`data-tauri-drag-region`, plus the capability `core:window:allow-start-dragging`, no wildcards).
   - Double-clicking an empty area zooms, as on any Mac app.
   - Buttons and the search field keep working and never start a drag.
4. **Full screen:** the left inset collapses when the controls are hidden, and the top bar keeps its height.
5. **Every theme and base:** the controls sit on the app's own top bar in all four themes, light and dark, in both styles (Homeroom and Patch Bay). Patch Bay's cable still never covers text (`ui/tests/cable-clear.spec.ts` green).
6. **No regressions:** cargo fmt, clippy and test; ui lint and build; the full Playwright suite with no assertions loosened; the debug build.

## Inspection

- Build the debug app and open it. Inspect the window.
  - If the screen is unlocked: a screenshot shows one bar with the controls in it.
  - Always: read the window's title-bar style from the built config, and use the in-app e2e runner or a Playwright check on the top bar's left padding and drag-region attributes.
- Run Playwright on the top bar at 880, 1200 and 1600px, in normal and full-screen states (mock a `fullscreen` class or state).
