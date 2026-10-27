import { playSound } from '../../../sound/index.ts';
import { EVENT_INFO } from '../../../sound/pack.ts';
import { choiceGain, keepGain, resolveChoice, withGain } from '../../../sound/mix.ts';
import { ChoiceSelect } from './ChoiceSelect.tsx';
import { GainSlider } from './GainSlider.tsx';
import { removeCustom, useFileImport } from './useFileImport.ts';
import {
  SOUND_EVENTS,
  type DmSoundPref,
  type MixChoice,
  type PackInfo,
  type Prefs,
  type SoundEvent,
} from '../ipc.ts';
import type { PrefsDm } from '../types.ts';

type Own = Exclude<DmSoundPref, 'default' | 'mute'>;

const ownOf = (p: DmSoundPref | undefined): Own => (p && typeof p === 'object' ? p : {});

/** Compact form: nothing set means the DM follows the global mix. */
function compact(o: Own): DmSoundPref {
  const mix = Object.fromEntries(Object.entries(o.mix ?? {}).filter(([, v]) => v !== undefined));
  const out: Own = {};
  if (o.pack) out.pack = o.pack;
  if (Object.keys(mix).length) out.mix = mix;
  return out.pack || out.mix ? out : 'default';
}

export function DmSounds(props: {
  dms: PrefsDm[];
  sound: Prefs['sound'];
  packs: PackInfo[];
  names: Record<string, string>;
  openId?: string;
  onSet(id: string, pref: DmSoundPref): void;
}) {
  if (props.dms.length === 0) return <p className="pf-hint">No sessions yet.</p>;
  return (
    <ul className="plist dmsounds" data-setting="sounds.session">
      {props.dms.map((d) => (
        <DmRow key={d.id} dm={d} {...props} />
      ))}
    </ul>
  );
}

function DmRow(p: Parameters<typeof DmSounds>[0] & { dm: PrefsDm }) {
  const { dm, sound: s } = p;
  const pref = s.perDm[dm.id];
  const muted = pref === 'mute';
  const own = ownOf(pref);
  const file = useFileImport();
  const customized = !muted && compact(own) !== 'default';

  const setMix = (e: SoundEvent, c: MixChoice | undefined) => {
    const mix = { ...own.mix };
    if (c === undefined) delete mix[e];
    else mix[e] = c;
    p.onSet(dm.id, compact({ ...own, mix }));
  };

  async function pickFile(e: SoundEvent) {
    const f = await file.pick();
    if (f) setMix(e, keepGain({ custom: f.id }, own.mix?.[e] ?? resolveChoice(e, s, dm.id)));
  }

  return (
    <li className="dmrow">
      <div className="dmrow__head">
        <label className="chk plist__name">
          <input
            type="checkbox"
            aria-label={`Mute sounds for ${dm.name}`}
            checked={muted}
            onChange={(ev) => p.onSet(dm.id, ev.target.checked ? 'mute' : 'default')}
          />
          <span>{dm.name}</span>
        </label>
        {customized && <span className="pack__kind">Custom sounds</span>}
      </div>
      <details
        className="dmrow__more"
        data-testid={`sound-dm-${dm.id}`}
        open={p.openId === dm.id || undefined}
      >
        <summary>Sounds for {dm.name}</summary>
        {muted ? (
          <p className="pf-hint">Muted. Unmute to give this session its own sounds.</p>
        ) : (
          <div className="dmrow__body">
            <label className="pf pf--inline">
              <span>Pack</span>
              <select
                aria-label={`Pack for ${dm.name}`}
                value={own.pack ?? ''}
                onChange={(ev) =>
                  p.onSet(dm.id, compact({ ...own, pack: ev.target.value || undefined }))
                }
              >
                <option value="">Use the global mix</option>
                {p.packs.map((k) => (
                  <option key={k.id} value={k.id}>
                    {k.name}
                  </option>
                ))}
              </select>
            </label>
            <ul className="plist">
              {SOUND_EVENTS.map((e) => {
                const own1 = own.mix?.[e];
                const shown = resolveChoice(e, s, dm.id);
                const custom =
                  own1 && typeof own1 === 'object' && 'custom' in own1 ? own1.custom : null;
                return (
                  <li key={e}>
                    <span className="plist__name">{EVENT_INFO[e].name}</span>
                    <div className="mixrow__ctl">
                      <ChoiceSelect
                        event={e}
                        packs={p.packs}
                        names={p.names}
                        value={own1}
                        inheritLabel={own.pack ? 'This session’s pack' : 'Global mix'}
                        label={`${dm.name} ${EVENT_INFO[e].name} source`}
                        disabled={file.busy}
                        onChange={(c) => setMix(e, c && keepGain(c, own1 ?? shown))}
                        onPickFile={() => void pickFile(e)}
                      />
                      <GainSlider
                        label={`${dm.name} ${EVENT_INFO[e].name} volume`}
                        value={choiceGain(shown)}
                        disabled={shown === 'off'}
                        onChange={(g) => setMix(e, withGain(shown, g))}
                      />
                      <button
                        type="button"
                        className="btn sec"
                        aria-label={`Test ${EVENT_INFO[e].name} sound for ${dm.name}`}
                        onClick={() => playSound(e, { force: true, dmId: dm.id })}
                      >
                        Test
                      </button>
                      {custom && (
                        <button
                          type="button"
                          className="btn sec"
                          aria-label={`Remove file for ${dm.name} ${EVENT_INFO[e].name}`}
                          onClick={() => {
                            setMix(e, undefined);
                            void removeCustom(custom);
                          }}
                        >
                          Remove file
                        </button>
                      )}
                    </div>
                  </li>
                );
              })}
            </ul>
            {file.error && (
              <p className="pf-err" role="alert">
                {file.error}
              </p>
            )}
            {customized && (
              <button type="button" className="btn sec" onClick={() => p.onSet(dm.id, 'default')}>
                Use the global mix for {dm.name}
              </button>
            )}
          </div>
        )}
      </details>
    </li>
  );
}
