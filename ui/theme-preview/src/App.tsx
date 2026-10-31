import { useMemo, useState, useSyncExternalStore } from 'react';
import type { ReactNode } from 'react';
import {
  BASES,
  CABLE_PRESETS,
  THEME_CABLE,
  contrastReport,
  importSlackTheme,
  resolveMode,
  TOKEN_GROUPS,
} from '../../src/theme/index.ts';
import type { BaseId, ModePreference, Theme } from '../../src/theme/index.ts';
import { ReferenceScreen } from './ReferenceScreen.tsx';
import { Sprite } from './Sprite.tsx';
import { loadShippedThemes } from './themes.ts';

const WIDTH = 1400;
const HEIGHT = 980;
const SHIPPED = loadShippedThemes();
const SAMPLE_SLACK =
  '#3F0E40,#350D36,#1164A3,#FFFFFF,#350D36,#FFFFFF,#2BAC76,#CD2553,#19171D,#FFFFFF';

const query = new URLSearchParams(window.location.search);

function subscribeScheme(cb: () => void) {
  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  mq.addEventListener('change', cb);
  return () => mq.removeEventListener('change', cb);
}
const systemDark = () => window.matchMedia('(prefers-color-scheme: dark)').matches;

function useSystemDark(): boolean {
  return useSyncExternalStore(subscribeScheme, systemDark, () => false);
}

function remember(next: Record<string, string>) {
  const q = new URLSearchParams(window.location.search);
  for (const [k, v] of Object.entries(next)) q.set(k, v);
  window.history.replaceState(null, '', `?${q.toString()}`);
}

function Seg<T extends string>(props: {
  label: string;
  value: T;
  options: { value: T; label: string; hint?: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div className="ctl">
      <span className="ctl-l" id={`l-${props.label}`}>
        {props.label}
      </span>
      <div className="seg" role="group" aria-labelledby={`l-${props.label}`}>
        {props.options.map((o) => (
          <button
            key={o.value}
            type="button"
            aria-pressed={props.value === o.value}
            title={o.hint}
            onClick={() => props.onChange(o.value)}
          >
            {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function pick<T extends string>(raw: string | null, allowed: readonly T[], fallback: T): T {
  return allowed.includes(raw as T) ? (raw as T) : fallback;
}

export function App() {
  const sysDark = useSystemDark();
  const [custom, setCustom] = useState<Theme[]>([]);
  const themes = useMemo(() => [...SHIPPED.themes, ...custom], [custom]);

  const baseIds = BASES.map((b) => b.id);
  const [base, setBase] = useState<BaseId>(pick(query.get('base'), baseIds, 'homeroom'));
  const [themeId, setThemeId] = useState(query.get('theme') ?? 'homeroom');
  const [pref, setPref] = useState<ModePreference>(
    pick(query.get('mode'), ['light', 'dark', 'system'] as const, 'system'),
  );
  const [cable, setCable] = useState(
    pick(query.get('cable'), [THEME_CABLE, ...CABLE_PRESETS.map((p) => p.id)], THEME_CABLE),
  );
  const [slack, setSlack] = useState(SAMPLE_SLACK);
  const [slackName, setSlackName] = useState('Aubergine');
  const [slackError, setSlackError] = useState<string | null>(null);

  const theme = themes.find((t) => t.id === themeId) ?? themes[0];
  const mode = resolveMode(pref, sysDark);
  const size = { width: WIDTH, height: HEIGHT };
  const view = query.get('view');
  const bare = query.get('bare') === '1';

  if (!theme) return <p className="fatal">No themes found in plugins/themes.</p>;

  if (bare) {
    return (
      <div className="bare" style={{ width: WIDTH, height: HEIGHT }}>
        <Sprite />
        <ReferenceScreen base={base} theme={theme} mode={mode} size={size} cable={cable} />
      </div>
    );
  }

  const failures = contrastReport(theme);
  const importTheme = () => {
    const baseTheme = SHIPPED.themes.find((t) => t.id === 'homeroom') ?? SHIPPED.themes[0];
    const id = `${
      slackName
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-|-$/g, '') || 'imported'
    }-slack`;
    const r = importSlackTheme(slack, {
      base: baseTheme,
      id,
      name: `${slackName || 'Imported'} (Slack)`,
    });
    if (!r.ok) {
      setSlackError(r.error);
      return;
    }
    setSlackError(null);
    setCustom((c) => [...c.filter((t) => t.id !== id), r.theme]);
    setThemeId(id);
    remember({ theme: id });
  };

  let stage: ReactNode;
  if (view === 'matrix') {
    const s = 0.24;
    const ready = BASES.filter((b) => b.status === 'ready');
    stage = (
      <div className="matrix">
        {ready.flatMap((b) =>
          themes.map((t) => (
            <figure key={`${b.id}-${t.id}`} className="tile">
              <div style={{ width: WIDTH * s, height: HEIGHT * s }}>
                <div
                  style={{
                    transform: `scale(${s})`,
                    transformOrigin: 'top left',
                    width: WIDTH,
                    height: HEIGHT,
                  }}
                >
                  <ReferenceScreen base={b.id} theme={t} mode={mode} size={size} cable={cable} />
                </div>
              </div>
              <figcaption>
                {b.name} / {t.name}
              </figcaption>
            </figure>
          )),
        )}
      </div>
    );
  } else {
    stage = (
      <div
        className="stage"
        tabIndex={0}
        aria-label="Reference screen, scroll sideways on narrow windows"
      >
        <ReferenceScreen base={base} theme={theme} mode={mode} size={size} cable={cable} />
      </div>
    );
  }

  return (
    <div className="pv" data-ui-mode={mode}>
      <Sprite />
      <header className="pv-top">
        <div>
          <h1>Theme preview</h1>
          <p>
            One reference screen for any base, color theme and light or dark. Swapping the theme
            changes colors only.
          </p>
        </div>
        <div className="pv-ctls">
          <Seg
            label="Base"
            value={base}
            options={BASES.map((b) => ({
              value: b.id,
              label: b.status === 'stub' ? `${b.name} (stub)` : b.name,
              hint: b.tagline,
            }))}
            onChange={(v) => {
              setBase(v);
              remember({ base: v });
            }}
          />
          <Seg
            label="Color theme"
            value={theme.id}
            options={themes.map((t) => ({ value: t.id, label: t.name, hint: t.description }))}
            onChange={(v) => {
              setThemeId(v);
              remember({ theme: v });
            }}
          />
          <Seg
            label="Cable"
            value={cable}
            options={[
              { value: THEME_CABLE, label: 'Theme', hint: "The theme's own cable and plug" },
              ...CABLE_PRESETS.map((p) => ({ value: p.id, label: p.name, hint: p.blurb })),
            ]}
            onChange={(v) => {
              setCable(v);
              remember({ cable: v });
            }}
          />
          <Seg
            label="Mode"
            value={pref}
            options={[
              { value: 'system', label: 'System' },
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
            ]}
            onChange={(v) => {
              setPref(v);
              remember({ mode: v });
            }}
          />
        </div>
      </header>

      {SHIPPED.problems.length > 0 && (
        <p className="pv-bad" role="alert">
          Invalid theme files:{' '}
          {SHIPPED.problems.map((p) => `${p.file} (${p.errors[0]})`).join('; ')}
        </p>
      )}

      {stage}

      <section className="pv-notes">
        <div>
          <h2>Contrast</h2>
          {failures.length === 0 ? (
            <p>{theme.name}: every text pair reaches WCAG AA in light and dark.</p>
          ) : (
            <ul>
              {failures.slice(0, 8).map((f) => (
                <li key={`${f.mode}${f.pair.fg}${f.pair.bg}`}>
                  {f.mode}: {f.pair.fg} on {f.pair.bg} is {f.ratio.toFixed(2)}:1, needs {f.pair.min}
                  :1
                </li>
              ))}
            </ul>
          )}
          <p className="dim">
            {Object.values(TOKEN_GROUPS).flat().length} color tokens per mode, nothing else in a
            theme.
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            importTheme();
          }}
        >
          <h2>Import a Slack theme</h2>
          <label>
            Theme string
            <textarea
              value={slack}
              rows={2}
              spellCheck={false}
              onChange={(e) => setSlack(e.target.value)}
            />
          </label>
          <label>
            Name
            <input value={slackName} onChange={(e) => setSlackName(e.target.value)} />
          </label>
          <button type="submit" className="go">
            Import and apply
          </button>
          {slackError && (
            <p className="pv-bad" role="alert">
              {slackError}
            </p>
          )}
        </form>
      </section>
    </div>
  );
}
