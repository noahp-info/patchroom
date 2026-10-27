import { useId } from 'react';
import { FontPicker } from '../FontPicker';
import { getBase } from '../../theme/bases.ts';
import {
  areaInfo,
  effectiveFont,
  FONT_AREAS,
  setArea,
  type Effective,
  type FontArea,
  type FontPrefs,
} from '../../theme/typeface.ts';
import { getPrefsStore, usePrefs } from './store.ts';

/** Where an unset value comes from, as the muted suffix after it. */
export function fromLabel(from: Effective['familyFrom'], baseName: string): string {
  if (from === 'default' || from === 'own') return `${baseName} default`;
  return `from ${from === 'code' ? 'Code' : areaInfo(from).label}`;
}

/** Settings > Themes > Fonts: a family and a size per area, each with a Reset. */
export function FontsGroup() {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const uid = useId();
  const fonts: FontPrefs = prefs.fonts ?? {};
  const baseName = getBase(prefs.base)?.name ?? 'Homeroom';
  const save = (next: FontPrefs) => void store.update({ fonts: next });
  const anySet = FONT_AREAS.some((a) => fonts[a.id]);

  return (
    <fieldset className="pf-group" data-testid="fonts" data-setting="themes.fonts" id="pf-fonts">
      <legend>Fonts</legend>
      <p className="pf-hint">
        UI is the default for everything. An area left on its default follows the one it names. A
        section or a session can change its chat font from its menu in the sidebar.
      </p>
      <ul className="frows">
        {FONT_AREAS.map((a) => {
          const own = fonts[a.id] ?? {};
          const eff = effectiveFont(fonts, a.id, prefs.base);
          const parentOnly = effectiveFont({ ...fonts, [a.id]: undefined }, a.id, prefs.base);
          const set = !!(own.family || own.size);
          const sizes = [...new Set([...a.sizes, ...(own.size ? [own.size] : [])])].sort(
            (x, y) => x - y,
          );
          return (
            <li key={a.id} className="frow" data-area={a.id} data-setting={`themes.fonts.${a.id}`}>
              <div className="frow__head">
                <span className="frow__name" id={`${uid}-${a.id}`}>
                  {a.label}
                </span>
                <span className="frow__desc">{a.description}</span>
              </div>
              <div className="frow__ctl">
                <FontPicker
                  value={own.family}
                  inherited={parentOnly.family}
                  inheritedFrom={fromLabel(parentOnly.familyFrom, baseName)}
                  mono={a.mono}
                  label={`${a.label} font`}
                  testId={`font-family-${a.id}`}
                  onChange={(family) => save(setArea(fonts, a.id, { family }))}
                />
                <select
                  aria-label={`${a.label} size`}
                  data-testid={`font-size-${a.id}`}
                  value={own.size ? String(own.size) : ''}
                  onChange={(e) =>
                    save(setArea(fonts, a.id, { size: Number(e.target.value) || undefined }))
                  }
                >
                  <option value="">
                    {parentOnly.size} px, {fromLabel(parentOnly.sizeFrom, baseName)}
                  </option>
                  {sizes.map((s) => (
                    <option key={s} value={s}>
                      {s} px
                    </option>
                  ))}
                </select>
                <button
                  type="button"
                  className="btn sec"
                  disabled={!set}
                  aria-label={`Reset ${a.label} font`}
                  onClick={() => save(setArea(fonts, a.id, { family: undefined, size: undefined }))}
                >
                  Reset
                </button>
              </div>
              <p
                className="frow__sample"
                aria-hidden="true"
                style={{
                  fontFamily: `"${eff.family}", ${a.mono ? 'ui-monospace, monospace' : 'ui-sans-serif, sans-serif'}`,
                  fontSize: `${eff.size}px`,
                }}
              >
                {SAMPLES[a.id]}
              </p>
            </li>
          );
        })}
      </ul>
      <div className="pf-row">
        <button
          type="button"
          className="btn sec"
          data-testid="fonts-reset-all"
          disabled={!anySet}
          onClick={() => {
            const { perSection, perSession } = fonts;
            save({
              ...(perSection ? { perSection } : {}),
              ...(perSession ? { perSession } : {}),
            });
          }}
        >
          Reset all fonts
        </button>
      </div>
    </fieldset>
  );
}

const SAMPLES: Record<FontArea, string> = {
  ui: 'Settings, menus and buttons read like this.',
  chat: 'Refactor the billing pipeline, then run the tests.',
  code: 'const total = items.reduce((a, b) => a + b, 0);',
  sidebar: 'billing-refactor',
  statusBar: 'Opus 5.5  41%  $1.82  feat/fonts',
};
