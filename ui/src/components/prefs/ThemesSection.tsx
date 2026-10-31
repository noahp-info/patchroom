import { useEffect, useId, useMemo, useState } from 'react';
import { allThemes, shippedThemes } from '../../theme/active.ts';
import { BASES } from '../../theme/bases.ts';
import { currentMode } from '../../theme/active.ts';
import { importSlackTheme } from '../../theme/slack.ts';
import type { Theme } from '../../theme/types.ts';
import { contrastReport } from '../../theme/validate.ts';
import type { ModePref } from './ipc.ts';
import { CablePresets } from './CablePresets.tsx';
import { CustomEditor, uniqueThemeId } from './CustomEditor.tsx';
import { getPrefsStore, usePrefs, usePrefsState } from './store.ts';
import { FontsGroup } from './FontsGroup.tsx';
import { Hint, type HintHost } from '../Hint';
import { usePrefsNav } from './nav.ts';

const FONT_HINT = 'fonts.themes';

/**
 * The first time Themes opens after fonts per area shipped, a hint points at Fonts. Shown
 * counts as seen, so it never comes back, even if Settings closes at once.
 */
function useFontHint(): { show: boolean; host: HintHost } {
  const { prefs, ready } = usePrefsState();
  const store = getPrefsStore();
  const nav = usePrefsNav();
  // Decided once, when the prefs first arrive; later changes to hints.seen do not hide it.
  const [show, setShow] = useState<boolean | null>(null);
  if (ready && show === null) setShow(!(prefs.hints?.seen ?? []).includes(FONT_HINT));
  const seen = prefs.hints?.seen;
  useEffect(() => {
    if (show && seen && !seen.includes(FONT_HINT))
      void store.update({ hints: { seen: [...seen, FONT_HINT] } });
  }, [show, seen, store]);
  const host = useMemo<HintHost>(
    () => ({
      hintAction: () => {
        setShow(false);
        nav.jump('themes', 'themes.fonts');
      },
      hintChoice: () => setShow(false),
      dismissHint: () => setShow(false),
    }),
    [nav],
  );
  return { show: show === true, host };
}
import { ThemePreview } from './ThemePreview.tsx';
import { ImportFrom } from './ImportFrom.tsx';

/** The bases that ship a full look. Stubs stay out of the picker. */
const STYLES = BASES.filter((b) => b.status === 'ready');

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
  const fontHint = useFontHint();

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
      {fontHint.show && (
        <div className="pf-hintslot">
          <Hint store={fontHint.host} id={FONT_HINT} />
        </div>
      )}

      <fieldset className="pf-group" data-setting="themes.appearance">
        <legend>Appearance</legend>
        <div className="pf-seg" role="radiogroup" aria-label="Light or dark">
          {MODES.map((m) => (
            <label key={m.id} className="pf-seg__opt">
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
        <p className="pf-hint">
          {prefs.mode === 'system'
            ? `System follows macOS. Showing ${mode} now.`
            : `Showing ${mode}. Pick System to follow macOS.`}
        </p>
      </fieldset>

      <fieldset className="pf-group" data-testid="style-picker" data-setting="themes.style">
        <legend>Style</legend>
        <div className="pf-seg" role="radiogroup" aria-label="Style">
          {STYLES.map((b) => (
            <label key={b.id} className="pf-seg__opt">
              <input
                type="radio"
                name={`${uid}-style`}
                value={b.id}
                checked={prefs.base === b.id}
                onChange={() => void store.update({ base: b.id })}
              />
              <span>{b.name}</span>
            </label>
          ))}
        </div>
        <p className="pf-hint">
          {STYLES.find((b) => b.id === prefs.base)?.tagline ?? ''} Colors come from the theme below.
        </p>
      </fieldset>

      <fieldset className="pf-group" data-testid="emoji-chat" data-setting="themes.emoji">
        <legend>Emoji in chat</legend>
        <div className="pf-seg" role="radiogroup" aria-label="Emoji in chat">
          {(
            [
              ['apple', 'Apple'],
              ['noto', 'Noto Color'],
            ] as const
          ).map(([id, label]) => (
            <label key={id} className="pf-seg__opt">
              <input
                type="radio"
                name={`${uid}-emoji`}
                value={id}
                checked={(prefs.emoji?.chat ?? 'apple') === id}
                onChange={() => void store.update({ emoji: { chat: id } })}
              />
              <span>
                <span className="emo pf-emo" data-flavor={id} aria-hidden="true">
                  {'\u{1F600}'}
                </span>
                {label}
              </span>
            </label>
          ))}
        </div>
        <p className="pf-hint">
          How emoji look in messages and in the terminal. A section or session emoji keeps the style
          it was picked in.
        </p>
      </fieldset>

      <fieldset className="pf-group" data-testid="chat-autoscroll" data-setting="themes.autoscroll">
        <legend>Chat</legend>
        <label className="chk">
          <input
            type="checkbox"
            checked={prefs.chat?.autoScroll ?? true}
            onChange={(e) =>
              void store.update({
                chat: { carryDraft: false, ...prefs.chat, autoScroll: e.target.checked },
              })
            }
          />
          <span>Auto-scroll to new messages</span>
        </label>
        <p className="pf-hint">
          Scrolling up pauses it in that window. Jump to latest, or scrolling back to the bottom,
          turns it back on. Off: every log opens paused.
        </p>
      </fieldset>

      <fieldset
        className="pf-group"
        data-testid="chat-carry-draft"
        data-setting="themes.carrydraft"
      >
        <legend>Chat and terminal</legend>
        <label className="chk">
          <input
            type="checkbox"
            checked={prefs.chat?.carryDraft ?? false}
            onChange={(e) =>
              void store.update({
                chat: { autoScroll: true, ...prefs.chat, carryDraft: e.target.checked },
              })
            }
          />
          <span>Carry chat draft to the terminal</span>
        </label>
        <p className="pf-hint">
          Switching to the terminal types your unsent chat text into Claude&apos;s input, without
          sending it. Images and comments stay in chat. Nothing moves while a dialog is up in the
          terminal.
        </p>
      </fieldset>

      <FontsGroup />

      <fieldset className="pf-group" data-setting="themes.theme">
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

      <CablePresets
        theme={themes.find((t) => t.id === prefs.themeId) ?? themes[0]}
        mode={mode}
        base={prefs.base}
        value={prefs.cablePreset}
        onChange={(id) => void store.update({ cablePreset: id })}
      />

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
        <div className="pf-row" data-setting="themes.custom">
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

      <fieldset className="pf-group" data-setting="themes.slack">
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

      <ImportFrom target="theme" />
    </div>
  );
}
