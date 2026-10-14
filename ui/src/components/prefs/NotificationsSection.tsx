import { useState } from 'react';
import type { NotifyLevel } from './ipc.ts';
import { getPrefsStore, usePrefs } from './store.ts';
import type { PrefsDm } from './types.ts';

const LEVELS: { id: NotifyLevel; label: string }[] = [
  { id: 'all', label: 'All activity' },
  { id: 'needs', label: 'Needs you only' },
  { id: 'mute', label: 'Mute' },
];

export function NotificationsSection({ dms }: { dms: PrefsDm[] }) {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const [test, setTest] = useState<{ ok: boolean; text: string } | null>(null);

  function setDm(id: string, level: NotifyLevel | '') {
    const perDm = { ...prefs.notify.perDm };
    if (level) perDm[id] = level;
    else delete perDm[id];
    void store.update({ notify: { ...prefs.notify, perDm } });
  }

  async function sendTest() {
    try {
      await store.api.notifyTest();
      setTest({ ok: true, text: 'Test notification sent.' });
    } catch (e) {
      setTest({ ok: false, text: `Could not send: ${String(e)}` });
    }
  }

  return (
    <div className="pf-section" data-testid="prefs-notifications">
      <h2>Notifications</h2>
      <label className="pf pf--inline">
        <span>Notify me about</span>
        <select
          aria-label="Default notification level"
          value={prefs.notify.default}
          onChange={(e) =>
            void store.update({
              notify: { ...prefs.notify, default: e.target.value as NotifyLevel },
            })
          }
        >
          {LEVELS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.label}
            </option>
          ))}
        </select>
      </label>
      <p className="pf-hint">
        Patchroom never notifies for the DM you are looking at while the window is focused.
      </p>

      <h3>Per DM</h3>
      {dms.length === 0 ? (
        <p className="pf-hint">No DMs yet.</p>
      ) : (
        <ul className="plist">
          {dms.map((d) => (
            <li key={d.id}>
              <span className="plist__name">{d.name}</span>
              <select
                aria-label={`${d.name} notification level`}
                value={prefs.notify.perDm[d.id] ?? ''}
                onChange={(e) => setDm(d.id, e.target.value as NotifyLevel | '')}
              >
                <option value="">Default</option>
                {LEVELS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </li>
          ))}
        </ul>
      )}

      <div className="pf-row">
        <button type="button" className="btn sec" onClick={() => void sendTest()}>
          Send test notification
        </button>
        {test && (
          <span className={test.ok ? 'pf-ok' : 'pf-err'} role="status">
            {test.text}
          </span>
        )}
      </div>
    </div>
  );
}
