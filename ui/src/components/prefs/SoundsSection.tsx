import { PACK, playSound } from '../../sound/index.ts';
import { SOUND_EVENTS, type SoundEvent } from './ipc.ts';
import { getPrefsStore, usePrefs } from './store.ts';
import type { PrefsDm } from './types.ts';

export function SoundsSection({ dms }: { dms: PrefsDm[] }) {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const s = prefs.sound;

  const patch = (next: Partial<typeof s>) => void store.update({ sound: { ...s, ...next } });
  const setEvent = (e: SoundEvent, on: boolean) =>
    patch({ perEvent: { ...s.perEvent, [e]: { sound: s.perEvent[e]?.sound ?? e, on } } });
  const setDm = (id: string, mute: boolean) => {
    const perDm = { ...s.perDm };
    if (mute) perDm[id] = 'mute';
    else delete perDm[id];
    patch({ perDm });
  };

  return (
    <div className="pf-section" data-testid="prefs-sounds">
      <h2>Sounds</h2>
      <label className="chk">
        <input
          type="checkbox"
          checked={s.enabled}
          onChange={(e) => patch({ enabled: e.target.checked })}
        />
        <span>Play sounds</span>
      </label>

      <label className="pf pf--inline">
        <span>Volume</span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          aria-label="Volume"
          value={s.volume}
          disabled={!s.enabled}
          onChange={(e) => patch({ volume: Number(e.target.value) })}
        />
        <output className="pf-hint">{Math.round(s.volume * 100)}%</output>
      </label>

      <h3>Events</h3>
      <ul className="plist">
        {SOUND_EVENTS.map((e) => (
          <li key={e}>
            <label className="chk plist__name">
              <input
                type="checkbox"
                aria-label={`${PACK[e].name} sound`}
                checked={s.perEvent[e]?.on ?? true}
                disabled={!s.enabled}
                onChange={(ev) => setEvent(e, ev.target.checked)}
              />
              <span>
                {PACK[e].name}
                <small className="pf-hint"> {PACK[e].blurb}</small>
              </span>
            </label>
            <button
              type="button"
              className="btn sec"
              aria-label={`Test ${PACK[e].name} sound`}
              onClick={() => playSound(e, { force: true })}
            >
              Test
            </button>
          </li>
        ))}
      </ul>

      <h3>Mute a DM</h3>
      {dms.length === 0 ? (
        <p className="pf-hint">No DMs yet.</p>
      ) : (
        <ul className="plist">
          {dms.map((d) => (
            <li key={d.id}>
              <label className="chk plist__name">
                <input
                  type="checkbox"
                  aria-label={`Mute sounds for ${d.name}`}
                  checked={s.perDm[d.id] === 'mute'}
                  onChange={(ev) => setDm(d.id, ev.target.checked)}
                />
                <span>{d.name}</span>
              </label>
            </li>
          ))}
        </ul>
      )}
      <p className="pf-hint">
        Sounds also stay silent during Do Not Disturb and for events your own sound hooks already
        cover.
      </p>
    </div>
  );
}
