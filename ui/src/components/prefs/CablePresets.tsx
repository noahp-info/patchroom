import { themeVars } from '../../theme/apply.ts';
import { CABLE_PRESETS, THEME_CABLE } from '../../theme/presets.ts';
import type { Theme, ThemeMode } from '../../theme/types.ts';

/** The cable in two sockets, drawn from the same tokens the Patch Bay base reads. */
function CableSwatch({ theme, mode, preset }: { theme: Theme; mode: ThemeMode; preset: string }) {
  const v = themeVars(theme, mode, preset);
  const vars = Object.fromEntries(
    ['--panel', '--panel-edge', '--nut', '--hole', '--cable', '--plug'].map((k) => [k, v[k]]),
  ) as React.CSSProperties;
  return (
    <svg
      className="cp"
      viewBox="0 0 120 52"
      style={vars}
      data-testid="cable-swatch"
      data-cable={v['--cable']}
      data-plug={v['--plug']}
      aria-hidden="true"
    >
      <rect x="0.5" y="0.5" width="119" height="51" rx="4" fill="var(--panel)" />
      <rect x="0.5" y="0.5" width="119" height="51" rx="4" fill="none" stroke="var(--panel-edge)" />
      <circle cx="26" cy="22" r="10" fill="var(--nut)" />
      <circle cx="94" cy="22" r="10" fill="var(--nut)" />
      <path
        d="M26 22 C 40 52, 80 52, 94 22"
        fill="none"
        stroke="var(--cable)"
        strokeWidth="5"
        strokeLinecap="round"
      />
      <circle cx="26" cy="22" r="6.5" fill="var(--hole)" stroke="var(--plug)" strokeWidth="2" />
      <circle cx="94" cy="22" r="6.5" fill="var(--hole)" stroke="var(--plug)" strokeWidth="2" />
      <circle cx="26" cy="22" r="3" fill="var(--cable)" />
      <circle cx="94" cy="22" r="3" fill="var(--cable)" />
    </svg>
  );
}

export function CablePresets({
  theme,
  mode,
  base,
  value,
  onChange,
}: {
  theme: Theme;
  mode: ThemeMode;
  base: string;
  value: string;
  onChange(id: string): void;
}) {
  const options = [
    { id: THEME_CABLE, name: 'Theme', blurb: `${theme.name}'s own cable and plug.` },
    ...CABLE_PRESETS,
  ];
  return (
    <fieldset className="pf-group" data-testid="cable-presets" data-setting="themes.cable">
      <legend>Patch Bay cable</legend>
      <p className="pf-hint">
        Cable and plug colors for the Patch Bay style. A preset changes those two colors and nothing
        else.
        {base === 'patchbay'
          ? ' The app behind this pane shows it now.'
          : ' Switch Style to Patch Bay to see it on the app.'}
      </p>
      <ul className="cgrid" aria-label="Cable presets">
        {options.map((o) => {
          const on = value === o.id;
          return (
            <li key={o.id} className="tcard" data-selected={on}>
              <button
                type="button"
                className="tcard__pick"
                aria-pressed={on}
                data-cable-preset={o.id}
                onClick={() => onChange(o.id)}
              >
                <CableSwatch theme={theme} mode={mode} preset={o.id} />
                <span className="tcard__name">{o.name}</span>
                <span className="tcard__desc">{o.blurb}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </fieldset>
  );
}
