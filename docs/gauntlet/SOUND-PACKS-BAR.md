# Gauntlet bar: sound packs, per-event mixing, your own sounds

From Noah, 2026-10-14:
- "Build the feature to allow a user to swap any sounds out that they like."
- Default bundles are themes of sounds (packs), and the user can pick and choose individually within each.
- Use CC0 sounds alongside generated ones, with creative names.

Preview the approved set: https://claude.ai/artifact/2PA7Lwfmyyg1rsUxGN6fpK (the same 11 packs and 8 events, playable).

## Shipped content (already in the tree)

- `plugins/sounds/generated-packs.json` holds four generated packs as note tables: Patch Tones (the default, matching today's `ui/src/sound/pack.ts`), Telegraph, Night Shift and Modular.
  - Notes add an optional `lp` (low-pass cutoff in Hz) to today's engine.
- `plugins/sounds/<slug>/` holds seven CC0 file packs: Lab Glass, Switchboard, Pocket Console, Pizzicato Hour, Island Time, Cartridge, Bridge Crew.
  - Each has `pack.json`, `sounds/<event>.m4a` (mono AAC, loudness-matched) and a CC0 `LICENSE` crediting Kenney.
- Events: `needs`, `done`, `message`, `error`, `bell` (live today), plus `decision`, `due`, `session` (planned; ship them now as selectable and testable, fired by later phases).

## Checklist

1. **Packs load:** the app bundles every pack in `plugins/sounds` (Tauri resources) and lists all 11. A generated pack plays through the oscillator engine, low-pass included. A file pack plays its m4a in the webview.
2. **Pick a pack:** Preferences > Sounds shows the packs as cards. Each card has a play button per event and "Use for every event".
3. **Mix per event:** each of the 8 events has its own picker. The choices are any pack's sound for that event, "Your file...", or Off. A per-event play button sits beside each picker. The mix persists through prefs_get/prefs_set, with serde defaults so P3-era prefs load as Patch Tones.
4. **Your own files:**
   - "Your file..." opens the native file picker. Accepted formats: wav, aiff, mp3, m4a. Limits: 5 s, 2 MB. A file over either limit is refused, and the message names the limit.
   - The backend copies the file into `<data_dir>/sounds/<ULID>.<ext>` (0600) and returns an id. Nothing is uploaded.
   - A removed custom sound falls back to the pack's sound for that event.
   - Custom files are pruned when no prefs reference them.
5. **Import your Claude sounds:**
   - It reads the user's existing Claude Code sound setup **read only**: `~/.claude/sounds/` profiles and the files that `play.sh` points at.
   - It offers each profile as a pack. Importing copies the audio files into the app data dir.
   - It never writes under `~/.claude`.
6. **Per DM:** any DM can override the global mix: the whole pack, or single events. The P3 per-DM mute still works.
7. **All P3 rules still apply:** volume, per-event on/off, per-DM mute, Do Not Disturb, "Keep yours" hook detection, and no sound for the DM on screen. `notify:fire` plays exactly one sound per event.
8. **Defaults:**
   - Patch Tones for every event.
   - `session` is off by default when a SessionStart audio hook is detected.
   - `message` is off by default.
9. **Credits:** Preferences > Sounds and an About panel list Kenney and the CC0 license, plus each pack's source.
10. **Readability and design:**
    - The Sounds pane passes the axe color-contrast spec in all four themes, light and dark.
    - The Impeccable detector finds zero low-contrast or undersized-text issues.
    - Tokens only.
11. **Loudness is consistent, and every sound has its own volume (from Noah: "volume on terminal bell for cartridge is oddly loud", "a user should be able to modify the volume of any sound they set individually"):**
    - **Bundled files:** each one is leveled to an average of -22 dBFS with peaks no higher than -3 dBFS. Very short clicks can sit lower because their peaks hit the cap first.
      - A permanent test decodes every shipped file and asserts the peak is at most -2.5 dBFS and the average is between -32 and -20 dBFS.
      - The generated packs are matched to the same perceived level: measure their rendered output in an OfflineAudioContext and keep each event's average within 3 dB of -22.
    - **Imported files** (your own and Claude profiles) are measured on import and get a gain that brings them to the same level. The original file is never changed.
    - **Per-sound volume:** every event in the mix has its own volume slider, from 0 to 150 percent, with a test-play button, on top of the master volume.
      - It is stored per event, and per DM when a DM overrides.
      - It persists through prefs.
      - The effective gain is clamped so the output never clips.
12. **No regressions:** cargo fmt, clippy and test; ui lint and build; the full Playwright suite with no assertions loosened; the debug build.

## Contract

- **Commands:**
  - `sound_packs {} -> [{id, name, description, kind: "generated"|"files"|"imported", license, author, source, events: {[event]: true}, norm?: {[event]: number}, notes?}]`
    - `norm` is the normalizing gain per event for file and imported packs (absent for generated packs). Bundled packs are leveled, so it is 1 unless the pack manifest corrects an event. Imported packs carry the gain measured at import.
  - `sound_file {packId, event} -> {dataUrl}` (fetched on demand for file packs)
  - `sound_import_file {path} -> {id, name, durationMs, norm}` (copies after checking the limits and measures loudness)
  - `sound_custom_list {} -> [{id, name, durationMs, norm}]` (newest first)
  - `sound_custom_file {id} -> {dataUrl}`
  - `sound_custom_remove {id}`
  - `sound_claude_profiles {} -> [{id, name, events}]` (read only)
  - `sound_import_claude_profile {id} -> {packId}`
- **Prefs:** `sound.mix: {[event]: {pack: string, gain?: number} | {custom: string, gain?: number} | "off"}` (gain is a 0 to 1.5 multiplier, default 1), plus `sound.perDm: {[id]: {pack?, mix?}}` (extends today's per-DM mute).
  - `mix` entries in `perDm` use the same pick shape, so a DM override carries its own per-event `gain`.
  - A gain outside 0 to 1.5, or not a number, makes `prefs_set` fail. A gain of 1 is not written back.
- **Loudness:**
  - `norm` is measured on import (RMS over all samples, sample peak; pure-Rust decode) and brings the mean to -22 dBFS with the peak at most -3 dBFS, clamped to 0.05 to 8. It is 1 when the file cannot be decoded or is silent.
  - It is stored in the custom sound's sidecar (`<ULID>.json`) or the imported pack's `pack.json` (`norm: {[event]: number}`). The audio file is never changed.
  - The UI plays a sound at `master volume * norm * pick gain`, clamped so the output never clips.
  - A bundled pack manifest may carry the same `norm` map; Switchboard uses it for two events.

## Inspection

- Rust tests: import limits and types, the copy into the data dir with 0600, pruning, read-only profile discovery against a synthetic `~/.claude/sounds` fixture, and prefs back-compat.
- Playwright against the mock IPC: every pack plays (spy on Web Audio and HTMLAudioElement). Also the per-event mix, your file, profile import, per-DM override, persistence, the P3 rules, and the axe spec.
- In the debug app, confirm a file pack actually decodes and plays: duration > 0 from an HTMLAudioElement in WKWebView.
- Run the /impeccable critique on the Sounds pane.
