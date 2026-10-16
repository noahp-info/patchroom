import { useEffect, useRef, useState } from 'react';
import './sounds/sounds.css';
import { useCatalog } from '../../sound/catalog.ts';
import { keepGain } from '../../sound/mix.ts';
import { previewChoice } from '../../sound/index.ts';
import { EVENT_INFO } from '../../sound/pack.ts';
import { ClaudeImport } from './sounds/ClaudeImport.tsx';
import { SoundCredits } from './sounds/Credits.tsx';
import { DmSounds } from './sounds/DmSounds.tsx';
import { MixBoard } from './sounds/MixBoard.tsx';
import { PackCards } from './sounds/PackCards.tsx';
import {
  DEFAULT_PACK,
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
  const mixRef = useRef<HTMLElement>(null);
  const [changed, setChanged] = useState<SoundEvent[]>([]);
  const [note, setNote] = useState('');
  /** The event whose sound "Play the whole mix" just started; its row hops for a moment. */
  const [playing, setPlaying] = useState<SoundEvent | null>(null);
  const timers = useRef<number[]>([]);
  useEffect(() => () => timers.current.forEach((t) => window.clearTimeout(t)), []);
  const later = (fn: () => void, ms: number) => timers.current.push(window.setTimeout(fn, ms));

  /** Set a pack for every event it has, then scroll back up to the mix and mark what changed. */
  const useAll = (pack: PackInfo) => {
    const mix = { ...s.mix };
    const diff: SoundEvent[] = [];
    for (const e of SOUND_EVENTS) {
      if (!pack.events[e]) continue;
      const prev = s.mix[e];
      const same = typeof prev === 'object' && 'pack' in prev && prev.pack === pack.id;
      mix[e] = keepGain({ pack: pack.id }, prev);
      if (!same) diff.push(e);
    }
    patch({ mix });
    setChanged(diff);
    setNote(
      diff.length
        ? `${pack.name} now plays ${diff.map((e) => EVENT_INFO[e].name).join(', ')}.`
        : `Every event already plays ${pack.name}.`,
    );
    mixRef.current?.scrollIntoView({ block: 'start', behavior: 'auto' });
    later(() => setChanged([]), 3000);
  };

  /**
   * Plays each event's current sound in turn, a short beat apart, and marks the row that is
   * playing so the user can see which sound is which. Mutes do not stop a preview.
   */
  const playAll = () => {
    const step = 700;
    SOUND_EVENTS.forEach((e, i) =>
      later(() => {
        const c = s.mix[e] ?? { pack: DEFAULT_PACK };
        if (c === 'off') return;
        previewChoice(c, e);
        setPlaying(e);
      }, i * step),
    );
    later(() => setPlaying(null), SOUND_EVENTS.length * step);
  };

  const resetMix = () => {
    patch({ mix: Object.fromEntries(SOUND_EVENTS.map((e) => [e, { pack: DEFAULT_PACK }])) });
    setChanged([]);
    setNote('Mix reset to Patch Tones at full level.');
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
      <div className="sounds-master">
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
      </div>

      <section ref={mixRef} className="mixsec" aria-labelledby="mix-h" data-testid="mix-board">
        <div className="mixsec__head">
          <h3 id="mix-h">Mix by event</h3>
          <div className="mixsec__btns">
            <button type="button" className="btn sec" onClick={playAll}>
              Play the whole mix
            </button>
            <button type="button" className="btn sec" onClick={resetMix}>
              Reset to Patch Tones
            </button>
          </div>
        </div>
        <p className="pf-hint">
          Pick a sound for each event from any pack, your own file (wav, aiff, mp3 or m4a, up to 5 s
          and 2 MB), or Off.
        </p>
        <MixBoard
          sound={s}
          packs={packs}
          names={names}
          changed={changed}
          playing={playing}
          onEventOn={setEvent}
          onChoice={setChoice}
        />
        <p className="pf-hint mixsec__note" role="status" aria-live="polite">
          {note}
        </p>
      </section>

      <h3>Packs</h3>
      <p className="pf-hint">
        A pack is a set of sounds, one for each event. Play any of them, or use a pack for
        everything.
      </p>
      <PackCards packs={packs} mix={s.mix} onUseAll={useAll} />

      <h3>Your Claude sounds</h3>
      <ClaudeImport />

      <h3>Sounds for one session</h3>
      <p className="pf-hint">
        Mute a session, or open it to give it a pack or a sound of its own for any event.
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
