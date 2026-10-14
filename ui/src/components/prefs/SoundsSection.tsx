import './sounds/sounds.css';
import { useCatalog } from '../../sound/catalog.ts';
import { keepGain } from '../../sound/mix.ts';
import { ClaudeImport } from './sounds/ClaudeImport.tsx';
import { SoundCredits } from './sounds/Credits.tsx';
import { DmSounds } from './sounds/DmSounds.tsx';
import { MixBoard } from './sounds/MixBoard.tsx';
import { PackCards } from './sounds/PackCards.tsx';
import {
  SOUND_EVENTS,
  type DmSoundPref,
  type MixChoice,
  type PackInfo,
  type SoundEvent,
} from './ipc.ts';
import { getPrefsStore, usePrefs } from './store.ts';
import type { PrefsDm } from './types.ts';

export function SoundsSection({ dms, openDm }: { dms: PrefsDm[]; openDm?: string }) {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const { packs, names } = useCatalog();
  const s = prefs.sound;

  const patch = (next: Partial<typeof s>) => void store.update({ sound: { ...s, ...next } });
  const setEvent = (e: SoundEvent, on: boolean) =>
    patch({ perEvent: { ...s.perEvent, [e]: { sound: s.perEvent[e]?.sound ?? e, on } } });
  const setChoice = (e: SoundEvent, c: MixChoice) => patch({ mix: { ...s.mix, [e]: c } });
  const useAll = (pack: PackInfo) => {
    const mix = { ...s.mix };
    for (const e of SOUND_EVENTS)
      if (pack.events[e]) mix[e] = keepGain({ pack: pack.id }, s.mix[e]);
    patch({ mix });
  };
  const setDm = (id: string, pref: DmSoundPref) => {
    const perDm = { ...s.perDm };
    if (pref === 'default') delete perDm[id];
    else perDm[id] = pref;
    patch({ perDm });
  };

  return (
    <div className="pf-section sounds-pane" data-testid="prefs-sounds">
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

      <h3>Packs</h3>
      <p className="pf-hint">
        A pack is a set of sounds, one for each event. Play any of them, or use a pack for
        everything.
      </p>
      <PackCards packs={packs} mix={s.mix} onUseAll={useAll} />

      <h3>Mix by event</h3>
      <p className="pf-hint">
        Pick a sound for each event from any pack, use your own file, or turn the sound off. Your
        file can be wav, aiff, mp3 or m4a, up to 5 seconds and 2 MB.
      </p>
      <MixBoard sound={s} packs={packs} names={names} onEventOn={setEvent} onChoice={setChoice} />

      <h3>Your Claude sounds</h3>
      <ClaudeImport />

      <h3>Sounds for one DM</h3>
      <p className="pf-hint">
        Mute a DM, or open it to give it a pack or a sound of its own for any event.
      </p>
      <DmSounds dms={dms} sound={s} packs={packs} names={names} openId={openDm} onSet={setDm} />
      <p className="pf-hint">
        Sounds also stay silent during Do Not Disturb and for events your own sound hooks already
        cover.
      </p>

      <h3>Credits</h3>
      <SoundCredits />
    </div>
  );
}
