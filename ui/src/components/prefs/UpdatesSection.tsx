import { useState } from 'react';
import type { UpdateInfo, UpdatePrefs } from '../../ipc/types.ts';
import { getPrefsStore, usePrefs } from './store.ts';

const OFF: UpdatePrefs = { checkApp: false, checkModels: false, askedModels: false };

/**
 * Settings > Updates: two opt-in checks (SPEC D3: opt-in). Both are off until turned on, and
 * nothing is fetched before that. Each is a plain GET; Patchroom never listens and sends nothing
 * about the person.
 */
export function UpdatesSection() {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const cur = prefs.updates ?? OFF;
  const [app, setApp] = useState<{ info?: UpdateInfo; err?: string; busy?: boolean }>({});
  const [cat, setCat] = useState<{ ok?: string; err?: string; busy?: boolean }>({});
  const put = (patch: Partial<UpdatePrefs>) =>
    void store.update({ updates: { ...cur, ...patch, askedModels: true } });

  const checkApp = async () => {
    setApp({ busy: true });
    try {
      const info = await store.api.updateCheck?.();
      setApp({ info });
    } catch (e) {
      setApp({ err: String(e).replace(/^Error: /, '') });
    }
  };
  const checkModels = async () => {
    setCat({ busy: true });
    try {
      const c = await store.api.catalogRefresh?.();
      setCat({ ok: c ? `Model list from ${c.generated}, ${c.models.length} models.` : 'Done.' });
    } catch (e) {
      setCat({ err: String(e).replace(/^Error: /, '') });
    }
  };

  return (
    <div className="pf-section" data-testid="prefs-updates">
      <h2>Updates</h2>
      <p className="pf-hint">
        Both checks are off until you turn them on. Each one only downloads a file from the
        project&#8217;s GitHub releases. Patchroom sends nothing about you and never listens.
      </p>

      <h3>App</h3>
      <label className="chk">
        <input
          type="checkbox"
          data-testid="updates-app"
          checked={cur.checkApp}
          onChange={(e) => put({ checkApp: e.target.checked })}
        />
        <span>Check for app updates</span>
      </label>
      <p className="pf-hint">
        Looks up the newest release when Patchroom starts. To install it, use Restart Patchroom in
        the app menu after you download it: every open session comes back with its drafts.
      </p>
      {cur.checkApp && (
        <div className="pf-row">
          <button
            type="button"
            className="btn sec"
            data-testid="updates-app-now"
            disabled={app.busy}
            onClick={() => void checkApp()}
          >
            Check now
          </button>
          {app.info && (
            <span className={app.info.newer ? 'pf-ok' : 'pf-hint'} role="status">
              {app.info.newer
                ? `Patchroom ${app.info.latest} is available.`
                : `Patchroom ${app.info.current} is the newest.`}
            </span>
          )}
          {app.err && (
            <span className="pf-err" role="alert">
              {app.err}
            </span>
          )}
        </div>
      )}

      <h3>Models</h3>
      <label className="chk">
        <input
          type="checkbox"
          data-testid="updates-models"
          checked={cur.checkModels}
          onChange={(e) => put({ checkModels: e.target.checked })}
        />
        <span>Check for newer models</span>
      </label>
      <p className="pf-hint">
        Every build already ships the latest model list. This gets new model names sooner, as a
        signed file that is checked before Patchroom uses it.
      </p>
      {cur.checkModels && (
        <div className="pf-row">
          <button
            type="button"
            className="btn sec"
            data-testid="updates-models-now"
            disabled={cat.busy}
            onClick={() => void checkModels()}
          >
            Check now
          </button>
          {cat.ok && (
            <span className="pf-ok" role="status">
              {cat.ok}
            </span>
          )}
          {cat.err && (
            <span className="pf-err" role="alert">
              {cat.err}
            </span>
          )}
        </div>
      )}
    </div>
  );
}
