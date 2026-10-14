import { useId, useState } from 'react';
import { allThemes, shippedThemes } from '../../theme/active.ts';
import { currentMode } from '../../theme/active.ts';
import { importSlackTheme } from '../../theme/slack.ts';
import type { Theme } from '../../theme/types.ts';
import { contrastReport } from '../../theme/validate.ts';
import type { ModePref } from './ipc.ts';
import { CustomEditor, uniqueThemeId } from './CustomEditor.tsx';
import { getPrefsStore, usePrefs } from './store.ts';
import { ThemePreview } from './ThemePreview.tsx';

const MODES: { id: ModePref; label: string }[] = [
  { id: 'light', label: 'Light' },
  { id: 'dark', label: 'Dark' },
  { id: 'system', label: 'System' },
];

export function ThemesSection() {
  const prefs = usePrefs();
  const uid = useId();
  const store = getPrefsStore();
  const mode = currentMode(prefs);
  const themes = allThemes(prefs);
  const shippedIds = shippedThemes().map((t) => t.id);
  const [editor, setEditor] = useState<{ theme: Theme; editing: boolean } | null>(null);
  const [slack, setSlack] = useState('');
  const [slackName, setSlackName] = useState('');
  const [slackBase, setSlackBase] = useState('homeroom');
  const [slackMsg, setSlackMsg] = useState<{ ok: boolean; text: string } | null>(null);

  const choose = (id: string) => void store.update({ themeId: id });

  function saveCustom(theme: Theme) {
    const rest = prefs.customThemes.filter((t) => t.id !== theme.id);
    void store.update({ customThemes: [...rest, theme], themeId: theme.id });
    setEditor(null);
  }

  function remove(theme: Theme) {
    const patch: Parameters<typeof store.update>[0] = {
      customThemes: prefs.customThemes.filter((t) => t.id !== theme.id),
    };
    if (prefs.themeId === theme.id) patch.themeId = 'homeroom';
    void store.update(patch);
  }

  function importSlack() {
    const name = slackName.trim() || 'Slack theme';
    const base = themes.find((t) => t.id === slackBase) ?? themes[0];
    const id = uniqueThemeId(
      name,
      themes.map((t) => t.id),
      'slack',
    );
    const r = importSlackTheme(slack, { base, id, name });
    if (!r.ok) {
      setSlackMsg({ ok: false, text: r.error });
      return;
    }
    const left = contrastReport(r.theme).length;
    void store.update({ customThemes: [...prefs.customThemes, r.theme], themeId: r.theme.id });
    setSlack('');
    setSlackName('');
    setSlackMsg({
      ok: true,
      text:
        `Imported "${name}" and applied it.` +
        (left ? ` ${left} text pairs sit below AA. Open it in the editor to fix them.` : ''),
    });
  }

  return (
    <div className="pf-section" data-testid="prefs-themes">
      <h2>Themes</h2>

      <fieldset className="pf-group">
        <legend>Appearance</legend>
        <div className="seg" role="radiogroup" aria-label="Light or dark">
          {MODES.map((m) => (
            <label key={m.id} className="seg__opt">
              <input
                type="radio"
                name={`${uid}-mode`}
                value={m.id}
                checked={prefs.mode === m.id}
                onChange={() => void store.update({ mode: m.id })}
              />
              <span>{m.label}</span>
            </label>
          ))}
        </div>
        <p className="pf-hint">System follows macOS. Showing {mode} now.</p>
      </fieldset>

      <fieldset className="pf-group">
        <legend>Theme</legend>
        <ul className="tgrid" aria-label="Themes">
          {themes.map((t) => {
            const custom = !shippedIds.includes(t.id);
            const on = prefs.themeId === t.id;
            return (
              <li key={t.id} className="tcard" data-selected={on}>
                <button
                  type="button"
                  className="tcard__pick"
                  aria-pressed={on}
                  data-theme-card={t.id}
                  onClick={() => choose(t.id)}
                >
                  <ThemePreview theme={t} mode={mode} />
                  <span className="tcard__name">{t.name}</span>
                  <span className="tcard__desc">{t.description ?? ''}</span>
                </button>
                {custom && (
                  <span className="tcard__acts">
                    <button
                      type="button"
                      className="lnk"
                      onClick={() => setEditor({ theme: t, editing: true })}
                    >
                      Edit
                    </button>
                    <button type="button" className="lnk" onClick={() => remove(t)}>
                      Delete
                    </button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      </fieldset>

      {editor ? (
        <CustomEditor
          key={editor.theme.id + String(editor.editing)}
          initial={editor.theme}
          editing={editor.editing}
          takenIds={themes.map((t) => t.id)}
          bases={themes}
          mode={mode}
          onSave={saveCustom}
          onCancel={() => setEditor(null)}
        />
      ) : (
        <div className="pf-row">
          <button
            type="button"
            className="btn sec"
            onClick={() =>
              setEditor({
                theme: themes.find((t) => t.id === prefs.themeId) ?? themes[0],
                editing: false,
              })
            }
          >
            New custom theme
          </button>
          <span className="pf-hint">Edit every color token. Text pairs must meet WCAG AA.</span>
        </div>
      )}

      <fieldset className="pf-group">
        <legend>Import a Slack theme</legend>
        <p className="pf-hint">
          In Slack, open Preferences, Themes, copy the custom theme string, and paste it here.
        </p>
        <label className="pf" htmlFor={`${uid}-slack`}>
          <span>Slack theme string</span>
          <textarea
            id={`${uid}-slack`}
            rows={2}
            spellCheck={false}
            placeholder="#350d36,#3e313c,#1264a3,#FFFFFF,#3E313C,#FFFFFF,#2BAC76,#CD2553,#350d36,#FFFFFF"
            value={slack}
            onChange={(e) => {
              setSlack(e.target.value);
              setSlackMsg(null);
            }}
          />
        </label>
        <div className="pf-row">
          <label className="pf pf--inline" htmlFor={`${uid}-sname`}>
            <span>Name</span>
            <input
              id={`${uid}-sname`}
              value={slackName}
              placeholder="Slack theme"
              maxLength={60}
              onChange={(e) => setSlackName(e.target.value)}
            />
          </label>
          <label className="pf pf--inline" htmlFor={`${uid}-sbase`}>
            <span>Fill the rest from</span>
            <select
              id={`${uid}-sbase`}
              value={slackBase}
              onChange={(e) => setSlackBase(e.target.value)}
            >
              {themes.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            className="btn pri"
            disabled={slack.trim() === ''}
            onClick={importSlack}
          >
            Import theme
          </button>
        </div>
        {slackMsg && (
          <p
            className={slackMsg.ok ? 'pf-ok' : 'pf-err'}
            role={slackMsg.ok ? 'status' : 'alert'}
            data-testid="slack-msg"
          >
            {slackMsg.text}
          </p>
        )}
      </fieldset>
    </div>
  );
}
