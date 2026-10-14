import { allThemes } from '../../theme/active.ts';
import {
  DEFAULT_FONT,
  DEFAULT_FONT_SIZE,
  DEFAULT_PALETTE,
  FIXED_PALETTES,
  FONT_SIZES,
  TERM_FONTS,
  termStyleFor,
} from '../../theme/terminal.ts';
import { TERM_DEFAULT_KEY, type Prefs, type TermStyle } from './ipc.ts';
import { getPrefsStore, usePrefs } from './store.ts';
import { TermPreview } from './TermPreview.tsx';
import type { PrefsDm } from './types.ts';

const INHERIT = '';

function TermRow({
  rowId,
  label,
  prefs,
  dmId,
  inherit,
}: {
  rowId: string;
  label: string;
  prefs: Prefs;
  dmId: string | null;
  inherit: boolean;
}) {
  const store = getPrefsStore();
  const own: TermStyle = prefs.termPerDm[rowId] ?? {};
  const def = prefs.termPerDm[TERM_DEFAULT_KEY] ?? {};
  const style = termStyleFor(prefs, dmId);

  function set(next: TermStyle) {
    const rest = { ...prefs.termPerDm };
    const clean: TermStyle = {};
    if (next.themeId) clean.themeId = next.themeId;
    if (next.font) clean.font = next.font;
    if (next.fontSize) clean.fontSize = next.fontSize;
    if (Object.keys(clean).length) rest[rowId] = clean;
    else delete rest[rowId];
    void store.update({ termPerDm: rest });
  }

  const themes = allThemes(prefs);
  const defaultPalette = def.themeId ?? DEFAULT_PALETTE;
  return (
    <li className="trow" data-testid={`term-row-${rowId === TERM_DEFAULT_KEY ? 'default' : rowId}`}>
      <div className="trow__head">
        <span className="trow__name">{label}</span>
      </div>
      <div className="trow__ctl">
        <label className="pf pf--inline">
          <span>Palette</span>
          <select
            aria-label={`${label} palette`}
            value={own.themeId ?? (inherit ? INHERIT : defaultPalette)}
            onChange={(e) => set({ ...own, themeId: e.target.value || undefined })}
          >
            {inherit && <option value={INHERIT}>Use default</option>}
            {FIXED_PALETTES.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
            <optgroup label="Match a theme">
              {themes.map((t) => (
                <option key={t.id} value={`theme:${t.id}`}>
                  {t.name}
                </option>
              ))}
            </optgroup>
          </select>
        </label>
        <label className="pf pf--inline">
          <span>Font</span>
          <select
            aria-label={`${label} font`}
            value={own.font ?? (inherit ? INHERIT : (def.font ?? DEFAULT_FONT))}
            onChange={(e) => set({ ...own, font: e.target.value || undefined })}
          >
            {inherit && <option value={INHERIT}>Use default</option>}
            {TERM_FONTS.map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          </select>
        </label>
        <label className="pf pf--inline">
          <span>Size</span>
          <select
            aria-label={`${label} font size`}
            value={String(
              own.fontSize ?? (inherit ? INHERIT : (def.fontSize ?? DEFAULT_FONT_SIZE)),
            )}
            onChange={(e) => set({ ...own, fontSize: Number(e.target.value) || undefined })}
          >
            {inherit && <option value={INHERIT}>Use default</option>}
            {FONT_SIZES.map((s) => (
              <option key={s} value={s}>
                {s} px
              </option>
            ))}
          </select>
        </label>
      </div>
      <TermPreview style={style} />
    </li>
  );
}

export function TerminalSection({ dms }: { dms: PrefsDm[] }) {
  const prefs = usePrefs();
  return (
    <div className="pf-section" data-testid="prefs-terminal">
      <h2>Terminal</h2>
      <p className="pf-hint">
        Open terminals restyle as you choose. Nothing restarts. Match app theme follows the theme
        and light or dark choice.
      </p>
      <ul className="tlist">
        <TermRow
          rowId={TERM_DEFAULT_KEY}
          label="All DMs"
          prefs={prefs}
          dmId={null}
          inherit={false}
        />
        {dms.map((d) => (
          <TermRow key={d.id} rowId={d.id} label={d.name} prefs={prefs} dmId={d.id} inherit />
        ))}
      </ul>
      {dms.length === 0 && <p className="pf-hint">Start a DM to give it its own terminal style.</p>}
    </div>
  );
}
