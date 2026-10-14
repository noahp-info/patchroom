import { useId, useMemo, useState } from 'react';
import { isColor } from '../../theme/color.ts';
import { repairContrast } from '../../theme/repair.ts';
import { TOKEN_GROUPS, type TokenKey } from '../../theme/tokens.ts';
import type { Theme, ThemeMode } from '../../theme/types.ts';
import { contrastReport, validateTheme } from '../../theme/validate.ts';
import { ThemePreview } from './ThemePreview.tsx';

/** `#rrggbb` when the color is opaque 6-digit hex, so the native picker can show it. */
function pickerValue(v: string): string | null {
  return /^#[0-9a-f]{6}$/i.test(v) ? v.toLowerCase() : null;
}

export function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'theme'
  );
}

/** An id not used by `taken`, built from the name. */
export function uniqueThemeId(name: string, taken: readonly string[], prefix = 'custom'): string {
  const base = `${prefix}-${slugify(name)}`;
  let id = base;
  for (let i = 2; taken.includes(id); i++) id = `${base}-${i}`;
  return id;
}

export interface CustomEditorProps {
  /** The theme to start from. Editing an existing custom theme keeps its id. */
  initial: Theme;
  editing: boolean;
  takenIds: readonly string[];
  bases: readonly Theme[];
  mode: ThemeMode;
  onSave(theme: Theme): void;
  onCancel(): void;
}

export function CustomEditor({
  initial,
  editing,
  takenIds,
  bases,
  mode: initialMode,
  onSave,
  onCancel,
}: CustomEditorProps) {
  const uid = useId();
  const [draft, setDraft] = useState<Theme>(initial);
  const [name, setName] = useState(editing ? initial.name : `${initial.name} copy`);
  const [mode, setMode] = useState<ThemeMode>(initialMode);

  const badColors = useMemo(() => {
    const out: string[] = [];
    for (const m of ['light', 'dark'] as const) {
      for (const [k, v] of Object.entries(draft.modes[m])) {
        if (!isColor(v)) out.push(`${m} ${k}`);
      }
    }
    return out;
  }, [draft]);
  const failures = useMemo(
    () => (badColors.length ? [] : contrastReport(draft)),
    [draft, badColors],
  );
  const failingKeys = useMemo(() => {
    const s = new Set<string>();
    for (const f of failures) {
      s.add(`${f.mode} ${f.pair.fg}`);
      s.add(`${f.mode} ${f.pair.bg}`);
    }
    return s;
  }, [failures]);
  const nameOk = name.trim().length > 0 && name.trim().length <= 60;
  const canSave = nameOk && badColors.length === 0 && failures.length === 0;

  function setToken(key: TokenKey, value: string) {
    setDraft((d) => ({ ...d, modes: { ...d.modes, [mode]: { ...d.modes[mode], [key]: value } } }));
  }

  function startFrom(id: string) {
    const b = bases.find((t) => t.id === id);
    if (b) setDraft(b);
  }

  function save() {
    if (!canSave) return;
    const theme: Theme = {
      ...draft,
      id: editing ? initial.id : uniqueThemeId(name, takenIds),
      name: name.trim(),
      description: draft.description ?? 'Custom theme.',
    };
    const ok = validateTheme(theme, { requireAA: true });
    if (ok.ok) onSave(ok.theme);
  }

  return (
    <section className="ced" aria-label="Custom theme editor" data-testid="custom-editor">
      <div className="ced__head">
        <label className="pf" htmlFor={`${uid}-name`}>
          <span>Theme name</span>
          <input
            id={`${uid}-name`}
            value={name}
            maxLength={60}
            onChange={(e) => setName(e.target.value)}
          />
        </label>
        {!editing && (
          <label className="pf" htmlFor={`${uid}-base`}>
            <span>Start from</span>
            <select
              id={`${uid}-base`}
              defaultValue={initial.id}
              onChange={(e) => startFrom(e.target.value)}
            >
              {bases.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
        )}
        <fieldset className="seg" aria-label="Mode being edited">
          {(['light', 'dark'] as const).map((m) => (
            <label key={m} className="seg__opt">
              <input
                type="radio"
                name={`${uid}-mode`}
                checked={mode === m}
                onChange={() => setMode(m)}
              />
              <span>{m === 'light' ? 'Light' : 'Dark'}</span>
            </label>
          ))}
        </fieldset>
      </div>

      <div className="ced__cols">
        <div className="ced__tokens">
          {(Object.keys(TOKEN_GROUPS) as (keyof typeof TOKEN_GROUPS)[]).map((g, gi) => (
            <details key={g} open={gi === 0}>
              <summary>{g}</summary>
              <ul className="ced__list">
                {TOKEN_GROUPS[g].map((key) => {
                  const v = draft.modes[mode][key];
                  const label = `${mode} ${key}`;
                  const bad = !isColor(v);
                  const fail = failingKeys.has(label);
                  const pv = pickerValue(v);
                  return (
                    <li key={key} className={fail || bad ? 'is-bad' : undefined}>
                      <span className="ced__key">{key}</span>
                      <input
                        type="color"
                        className="ced__swatch"
                        aria-label={`${label} picker`}
                        value={pv ?? '#000000'}
                        disabled={!pv}
                        onChange={(e) => setToken(key, e.target.value)}
                      />
                      <input
                        className="ced__hex"
                        aria-label={label}
                        aria-invalid={fail || bad}
                        spellCheck={false}
                        value={v}
                        onChange={(e) => setToken(key, e.target.value.trim())}
                      />
                    </li>
                  );
                })}
              </ul>
            </details>
          ))}
        </div>

        <div className="ced__side">
          <ThemePreview theme={draft} mode={mode} large />
          <div role="status" aria-live="polite" data-testid="aa-status" className="ced__status">
            {badColors.length > 0 ? (
              <p className="ced__err">
                Not a color: {badColors.slice(0, 4).join(', ')}
                {badColors.length > 4 ? ` and ${badColors.length - 4} more` : ''}. Use #rgb, #rrggbb
                or #rrggbbaa.
              </p>
            ) : failures.length > 0 ? (
              <>
                <p className="ced__err">
                  {failures.length} text {failures.length === 1 ? 'pair fails' : 'pairs fail'} WCAG
                  AA. Fix them to save.
                </p>
                <ul className="ced__fails" data-testid="aa-failures">
                  {failures.map((f) => (
                    <li key={`${f.mode}-${f.pair.fg}-${f.pair.bg}`}>
                      {f.mode}: <b>{f.pair.fg}</b> on <b>{f.pair.bg}</b> is {f.ratio.toFixed(2)}:1,
                      needs {f.pair.min}:1 ({f.pair.what})
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="ced__ok">All text pairs meet WCAG AA in light and dark.</p>
            )}
          </div>
        </div>
      </div>

      <div className="ced__foot">
        <button
          type="button"
          className="btn sec"
          disabled={badColors.length > 0 || failures.length === 0}
          onClick={() => setDraft((d) => repairContrast(d))}
        >
          Repair text colors
        </button>
        <span className="ced__spacer" />
        <button type="button" className="btn sec" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn pri" disabled={!canSave} onClick={save}>
          {editing ? 'Save changes' : 'Save theme'}
        </button>
      </div>
    </section>
  );
}
