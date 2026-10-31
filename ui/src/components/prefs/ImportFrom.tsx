import { useId, useState } from 'react';
import { allThemes } from '../../theme/active.ts';
import {
  deriveAppTheme,
  IMPORT_PREFIX,
  paletteMode,
  paletteToXterm,
  type ImportEntry,
  type ImportSource,
  type StoredTermPalette,
} from '../../theme/themeImport.ts';
import { TERM_DEFAULT_KEY, type Prefs } from './ipc.ts';
import { uniqueThemeId } from './CustomEditor.tsx';
import { getPrefsStore, usePrefs } from './store.ts';
import { TermPreview } from './TermPreview.tsx';
import { setArea, validFamily } from '../../theme/typeface.ts';
import { ThemePreview } from './ThemePreview.tsx';

type Target = 'theme' | 'terminal';

const TOOL_NAMES: Record<string, string> = {
  iterm2: 'iTerm2',
  ghostty: 'Ghostty',
  warp: 'Warp',
  vscode: 'VS Code',
  cursor: 'Cursor',
  terminal: 'Terminal',
  file: 'a file',
};

/** A stored palette id from an entry, unique among `taken`. */
function paletteId(e: ImportEntry, taken: string[]): string {
  const base = e.id.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  let id = base;
  for (let n = 2; taken.includes(id); n += 1) id = `${base}-${n}`;
  return id;
}

/**
 * "Import from...": a look from another tool the user has installed, read only. Themes gets an
 * app theme derived from the look's background and accent. Terminal gets the exact palette,
 * font and size as the default for every session. Preview first, then Apply, then one Undo.
 */
export function ImportFrom({ target }: { target: Target }) {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const uid = useId();
  const [sources, setSources] = useState<ImportSource[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [picked, setPicked] = useState<ImportEntry | null>(null);
  const [undo, setUndo] = useState<{ name: string; prev: Partial<Prefs> } | null>(null);
  /** The person's own code font, kept over the imported one. */
  const [keptFont, setKeptFont] = useState<string | null>(null);

  async function open() {
    setLoading(true);
    setError(null);
    try {
      const list = await store.api.themeImportDetect();
      setSources(list);
      setPicked(list.flatMap((s) => s.entries)[0] ?? null);
    } catch (err) {
      setError(`Could not read your tools: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }

  async function pickFile() {
    setError(null);
    try {
      const e = await store.api.themeImportFile();
      if (e) setPicked(e);
    } catch (err) {
      setError(`Could not read that file: ${String(err)}`);
    }
  }

  const entries = (sources ?? []).flatMap((s) => s.entries.map((e) => ({ s, e })));
  const themes = allThemes(prefs);
  const derived =
    picked && target === 'theme'
      ? deriveAppTheme(picked, {
          base: themes.find((t) => t.id === 'homeroom') ?? themes[0],
          id: uniqueThemeId(
            picked.name,
            themes.map((t) => t.id),
            'imported',
          ),
          name: picked.name.slice(0, 60),
        })
      : null;

  async function apply() {
    if (!picked) return;
    if (target === 'theme' && derived) {
      const prev = { themeId: prefs.themeId, customThemes: prefs.customThemes };
      await store.update({ customThemes: [...prefs.customThemes, derived], themeId: derived.id });
      setUndo({ name: picked.name, prev });
    } else {
      const prev = {
        termPerDm: prefs.termPerDm,
        termPalettes: prefs.termPalettes ?? [],
        fonts: prefs.fonts ?? {},
      };
      const stored: StoredTermPalette = {
        id: paletteId(
          picked,
          (prefs.termPalettes ?? []).map((p) => p.id),
        ),
        name: picked.name,
        source: picked.source,
        palette: picked.palette,
      };
      // The font and size fill the Code and terminal area only where the person has not set
      // one: an import never clobbers their own font choice.
      const code = prefs.fonts?.code ?? {};
      const family = !code.family && validFamily(picked.font) ? picked.font : undefined;
      const size =
        !code.size && picked.fontSize
          ? Math.min(32, Math.max(8, Math.round(picked.fontSize)))
          : undefined;
      const kept = (code.family && picked.font) || (code.size && picked.fontSize);
      await store.update({
        termPalettes: [...(prefs.termPalettes ?? []), stored],
        termPerDm: {
          ...prefs.termPerDm,
          [TERM_DEFAULT_KEY]: { themeId: IMPORT_PREFIX + stored.id },
        },
        ...(family || size
          ? {
              fonts: setArea(prefs.fonts ?? {}, 'code', {
                family: family ?? code.family,
                size: size ?? code.size,
              }),
            }
          : {}),
      });
      setKeptFont(kept ? (code.family ?? `${code.size} px`) : null);
      setUndo({ name: picked.name, prev });
    }
  }

  async function revert() {
    if (!undo) return;
    await store.update(undo.prev);
    setUndo(null);
  }

  const skipped = (sources ?? []).flatMap((s) =>
    s.skipped.map((k) => `${s.name}: ${k.name} (${k.reason})`),
  );
  const style = picked && {
    paletteId: 'preview',
    theme: paletteToXterm(picked.palette),
    font: picked.font ?? 'JetBrains Mono',
    fontFamily: `"${picked.font ?? 'JetBrains Mono'}", Menlo, Monaco, "Courier New", monospace`,
    fontSize: Math.round(picked.fontSize ?? 13),
  };

  return (
    <fieldset
      className="pf-group imp"
      data-testid={`import-from-${target}`}
      data-setting={`${target === 'theme' ? 'themes' : 'terminal'}.import`}
    >
      <legend>Import from another app</legend>
      {sources === null ? (
        <div className="pf-row">
          <button type="button" className="btn sec" disabled={loading} onClick={() => void open()}>
            {loading ? 'Looking…' : 'Import from…'}
          </button>
          <span className="pf-hint">
            {target === 'theme'
              ? 'Builds an app theme from a terminal look you already use. Patchroom only reads their files.'
              : 'Brings a palette, font and size from iTerm2, Ghostty, Warp, VS Code, Cursor or Terminal. Patchroom only reads their files.'}
          </span>
        </div>
      ) : (
        <>
          <div className="pf-row">
            <label className="pf" htmlFor={`${uid}-look`}>
              <span>Look</span>
              <select
                id={`${uid}-look`}
                value={picked && entries.some((x) => x.e.id === picked.id) ? picked.id : ''}
                onChange={(ev) =>
                  setPicked(entries.find((x) => x.e.id === ev.target.value)?.e ?? null)
                }
              >
                {(!picked || !entries.some((x) => x.e.id === picked.id)) && (
                  <option value="">{picked ? picked.name : 'Choose a look'}</option>
                )}
                {(sources ?? []).map(
                  (s) =>
                    s.entries.length > 0 && (
                      <optgroup key={s.id} label={s.name}>
                        {s.entries.map((e) => (
                          <option key={e.id} value={e.id}>
                            {e.name}
                          </option>
                        ))}
                      </optgroup>
                    ),
                )}
              </select>
            </label>
            <button type="button" className="btn sec" onClick={() => void pickFile()}>
              Choose an .itermcolors file…
            </button>
          </div>
          {sources.length === 0 && (
            <p className="pf-hint">No supported apps found. You can still choose a file.</p>
          )}
          {picked && style && (
            <div className="imp__preview" data-testid="import-preview">
              <p className="imp__meta">
                {picked.name} from {TOOL_NAMES[picked.source] ?? picked.source}
                {picked.font ? `, ${picked.font}` : ''}
                {picked.fontSize ? ` ${Math.round(picked.fontSize)} px` : ''}
              </p>
              <span className="imp__swatches" aria-label="Palette" data-testid="import-swatches">
                {[picked.palette.background, picked.palette.foreground, ...picked.palette.ansi].map(
                  (c, i) => (
                    <i key={i} style={{ background: c }} title={c} />
                  ),
                )}
              </span>
              <TermPreview style={style} />
              {derived && <ThemePreview theme={derived} mode={paletteMode(picked.palette)} large />}
            </div>
          )}
          <div className="pf-row">
            <button
              type="button"
              className="btn pri"
              disabled={!picked}
              data-testid="import-apply"
              onClick={() => void apply()}
            >
              {target === 'theme' ? 'Apply as app theme' : 'Apply to all sessions'}
            </button>
            <button type="button" className="btn sec" onClick={() => setSources(null)}>
              Close
            </button>
          </div>
          {skipped.length > 0 && (
            <details className="imp__skipped">
              <summary>
                {skipped.length} {skipped.length === 1 ? 'look' : 'looks'} could not be read
              </summary>
              <ul>
                {skipped.map((t) => (
                  <li key={t}>{t}</li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
      {error && (
        <p className="pf-err" role="alert">
          {error}
        </p>
      )}
      {undo && (
        <div className="pf-row" role="status" data-testid="import-done">
          <span className="pf-ok">
            Applied {undo.name}.{keptFont && ` Kept your code font (${keptFont}).`}
          </span>
          <button
            type="button"
            className="btn sec"
            data-testid="import-undo"
            onClick={() => void revert()}
          >
            Undo
          </button>
        </div>
      )}
    </fieldset>
  );
}
