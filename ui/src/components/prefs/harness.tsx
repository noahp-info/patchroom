import { StrictMode, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../theme/index.css';
import '../../styles.css';
import { PrefsPane } from './index.ts';
import { createMockPrefsApi, type HookDetect } from './ipc.ts';
import { setPrefsApi } from './store.ts';
import type { TabId } from './PrefsPane.tsx';
import { decideSound, eventsForHook, hookKeepsEvent } from '../../sound/decide.ts';
import { resolveChoice } from '../../sound/mix.ts';
import { effectiveGain, playSound, soundLog } from '../../sound/index.ts';
import { GENERATED, notesPeak } from '../../sound/pack.ts';
import { dndActive, dndSummary } from '../../sound/dnd.ts';
import { useThemeRuntime } from '../../theme/runtime.ts';
import { bindTerminalTheme, termStyleFor } from '../../theme/terminal.ts';
import type { StylableTerm } from '../../theme/terminal.ts';

/**
 * Test and design harness: the prefs pane over a themed app shell on the mock prefs backend.
 * Served by Vite at /src/components/prefs/harness.html. Not part of the production bundle.
 * Query: `hooks=Stop,TaskCompleted` seeds detected hooks, `dms=2` seeds two DMs.
 */
const q = new URLSearchParams(window.location.search);
const list = (k: string) => (q.get(k) ?? '').split(',').filter(Boolean);
const detected: HookDetect[] = [
  ...list('hooks').map((event) => ({
    event,
    command: `afplay /System/Library/Sounds/${event}.aiff`,
    source: '/Users/me/.claude/settings.json',
  })),
  // `scripthooks=Stop`: a wrapper script plays it. `guarded=Stop`: it already tests the guard.
  ...list('scripthooks').map((event) => ({
    event,
    command: `$HOME/.claude/sounds/play.sh ${event.toLowerCase()}`,
    source: 'user',
    script: '$HOME/.claude/sounds/play.sh',
  })),
  ...list('guarded').map((event) => ({
    event,
    command: `$HOME/.claude/sounds/quiet.sh ${event.toLowerCase()}`,
    source: 'user',
    script: '$HOME/.claude/sounds/quiet.sh',
    guarded: true,
  })),
];
const mockApi = createMockPrefsApi({
  detected,
  storageKey: q.has('fresh') ? undefined : 'pr.prefs.harness',
});
const store = setPrefsApi(mockApi);
const DMS = [
  { id: 'dm-alpha', name: 'hook-bridge' },
  { id: 'dm-beta', name: 'docs-site' },
].slice(0, Number(q.get('dms') ?? 2));

const fakeTerm: StylableTerm & { options: Record<string, unknown> } = { options: {} };
let applied = 0;
bindTerminalTheme(fakeTerm, 'dm-alpha', () => (applied += 1));

Object.assign(window, {
  __PR_PREFS__: {
    store,
    api: mockApi,
    playSound,
    decideSound,
    eventsForHook,
    hookKeepsEvent,
    resolveChoice,
    soundLog,
    effectiveGain,
    generated: GENERATED,
    notesPeak,
    dndActive,
    dndSummary,
    termStyleFor,
    fakeTerm,
    applied: () => applied,
  },
});

// ?theme=<id>&mode=light|dark picks the look before first paint (inspection runs).
if (q.has('theme') || q.has('mode')) {
  void store.update({
    ...(q.has('theme') ? { themeId: q.get('theme')! } : {}),
    ...(q.has('mode') ? { mode: q.get('mode') as 'light' | 'dark' } : {}),
  });
}

function Shell() {
  const { base, theme, mode, style } = useThemeRuntime();
  const [open, setOpen] = useState(true);
  return (
    <div
      className="pr-app shell"
      data-base={base}
      data-mode={mode}
      data-theme={theme.id}
      style={style}
    >
      <div className="tb">
        <span className="tb-title">Patchroom</span>
        <span className="tb-spacer" />
        <button type="button" className="tb-act" onClick={() => setOpen(true)}>
          Settings
        </button>
      </div>
      <main className="conv" data-testid="app-main">
        <p style={{ padding: 18 }}>Harness app surface</p>
      </main>
      {open && (
        <PrefsPane
          dms={DMS}
          onClose={() => setOpen(false)}
          initialTab={(q.get('tab') as TabId | null) ?? undefined}
        />
      )}
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Shell />
  </StrictMode>,
);
