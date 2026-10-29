import { useEffect, useState } from 'react';
import type { DictationLocales, DictationPermission } from '../../ipc/types.ts';
import {
  DICTATION_SHORTCUTS,
  SILENCE_CHOICES,
  dictationPrefs,
  type DictationPrefs,
  type SettingsPane,
} from '../../lib/dictation.ts';
import { getPrefsStore, usePrefs } from './store.ts';

const PERMISSION_TEXT: Record<DictationPermission, string> = {
  authorized: 'Allowed',
  denied: 'Not allowed',
  restricted: 'Blocked by macOS on this Mac',
  not_determined: 'Not asked yet. macOS asks the first time you dictate.',
  unknown: 'Unknown',
};

/**
 * Settings > Dictation. On by default, but nothing records until the mic button or the shortcut
 * is pressed. Speech is recognized on this Mac only; a language without an on-device model is
 * listed as needing a download, never sent to a server.
 */
export function DictationSection() {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const cur = dictationPrefs(prefs.dictation);
  const put = (patch: Partial<DictationPrefs>) =>
    void store.update({ dictation: { ...cur, ...patch } });
  const [info, setInfo] = useState<DictationLocales | null>(null);

  useEffect(() => {
    let gone = false;
    const list = store.api.dictationLocales?.bind(store.api);
    if (!list) return;
    void list()
      .then((r) => !gone && setInfo(r))
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, [store]);

  const open = (pane: SettingsPane) => void store.api.dictationOpenSettings?.(pane);
  const locales = info?.locales ?? [];
  const system = locales.find((l) => l.id === info?.current);
  const chosen = locales.find((l) => l.id === (cur.locale || info?.current));
  const needsDownload = !!info?.available && !!chosen && !chosen.onDevice;

  return (
    <div className="pf-section" data-testid="prefs-dictation">
      <h2>Dictation</h2>
      <p className="pf-hint">
        Talk instead of typing in the message box. Speech is turned into text on this Mac and is
        never sent anywhere. Patchroom keeps no audio and no transcript. Nothing is sent until you
        press Enter.
      </p>

      <label className="chk" data-setting="dictation.enabled">
        <input
          type="checkbox"
          data-testid="dictation-enabled"
          checked={cur.enabled}
          onChange={(e) => put({ enabled: e.target.checked })}
        />
        <span>Show the mic button in the composer</span>
      </label>
      <p className="pf-hint">
        The microphone opens only while you dictate, and closes when you stop, pause or leave the
        window.
      </p>

      <h3>Language</h3>
      <label className="pf pf--inline" data-setting="dictation.language">
        <select
          aria-label="Dictation language"
          data-testid="dictation-language"
          value={cur.locale}
          disabled={!cur.enabled}
          onChange={(e) => put({ locale: e.target.value })}
        >
          <option value="">System language{system ? ` (${system.name})` : ''}</option>
          {locales.map((l) => (
            <option key={l.id} value={l.id}>
              {l.onDevice ? l.name : `${l.name}, needs download`}
            </option>
          ))}
        </select>
      </label>
      {needsDownload ? (
        <div className="pf-row" data-testid="dictation-download">
          <span className="pf-hint">
            On-device dictation isn&#8217;t available for {chosen.name} yet. Add the language in
            Keyboard &gt; Dictation, and macOS downloads it.
          </span>
          <button type="button" className="btn sec" onClick={() => open('dictation')}>
            Open Keyboard settings
          </button>
        </div>
      ) : (
        <p className="pf-hint">
          {info && !info.available
            ? 'Dictation needs the Patchroom app for macOS.'
            : 'Only languages with an on-device model work. Others are marked as needing a download.'}
        </p>
      )}

      <h3>Shortcut</h3>
      <div
        className="pf-seg"
        role="radiogroup"
        aria-label="Dictation shortcut"
        data-setting="dictation.shortcut"
      >
        {DICTATION_SHORTCUTS.map((s) => (
          <label key={s.id} className="pf-seg__opt">
            <input
              type="radio"
              name="dictation-shortcut"
              checked={cur.shortcut === s.id}
              disabled={!cur.enabled}
              onChange={() => put({ shortcut: s.id })}
            />
            <span>{s.label}</span>
          </label>
        ))}
      </div>
      <p className="pf-hint">
        Starts and stops dictation in the message box. Esc stops too. Pressing Fn twice still starts
        macOS dictation.
      </p>

      <h3>Stop after silence</h3>
      <div
        className="pf-seg"
        role="radiogroup"
        aria-label="Stop after silence"
        data-setting="dictation.silence"
      >
        {SILENCE_CHOICES.map((n) => (
          <label key={n} className="pf-seg__opt">
            <input
              type="radio"
              name="dictation-silence"
              checked={cur.silenceSecs === n}
              disabled={!cur.enabled}
              onChange={() => put({ silenceSecs: n })}
            />
            <span>{n} seconds</span>
          </label>
        ))}
      </div>
      <p className="pf-hint">Dictation ends by itself after this long with no new words.</p>

      <h3 data-setting="dictation.permissions">Access</h3>
      <dl className="pf-perms" data-testid="dictation-perms">
        <dt>Microphone</dt>
        <dd>
          <span>{PERMISSION_TEXT[info?.mic ?? 'unknown']}</span>
          {(info?.mic === 'denied' || info?.mic === 'restricted') && (
            <button type="button" className="btn sec" onClick={() => open('microphone')}>
              Open Microphone settings
            </button>
          )}
        </dd>
        <dt>Speech Recognition</dt>
        <dd>
          <span>{PERMISSION_TEXT[info?.speech ?? 'unknown']}</span>
          {(info?.speech === 'denied' || info?.speech === 'restricted') && (
            <button type="button" className="btn sec" onClick={() => open('speech')}>
              Open Privacy settings
            </button>
          )}
        </dd>
      </dl>
    </div>
  );
}
