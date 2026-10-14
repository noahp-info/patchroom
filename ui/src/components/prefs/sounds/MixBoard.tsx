import { customLabel } from '../../../sound/catalog.ts';
import { playSound } from '../../../sound/index.ts';
import { EVENT_INFO } from '../../../sound/pack.ts';
import { choiceGain, keepGain, withGain } from '../../../sound/mix.ts';
import { ChoiceSelect } from './ChoiceSelect.tsx';
import { GainSlider } from './GainSlider.tsx';
import { removeCustom, useFileImport } from './useFileImport.ts';
import {
  DEFAULT_PACK,
  SOUND_EVENTS,
  type MixChoice,
  type PackInfo,
  type Prefs,
  type SoundEvent,
} from '../ipc.ts';

export function MixBoard(props: {
  sound: Prefs['sound'];
  packs: PackInfo[];
  names: Record<string, string>;
  /** Events a pack button just changed; their rows are highlighted for a moment. */
  changed?: SoundEvent[];
  onEventOn(e: SoundEvent, on: boolean): void;
  onChoice(e: SoundEvent, c: MixChoice): void;
}) {
  const { sound: s } = props;
  return (
    <ul className="plist mix" aria-label="Sound for each event">
      {SOUND_EVENTS.map((e) => (
        <MixRow
          key={e}
          event={e}
          {...props}
          choice={s.mix[e] ?? { pack: DEFAULT_PACK }}
          flash={props.changed?.includes(e) ?? false}
        />
      ))}
    </ul>
  );
}

function MixRow(
  p: Parameters<typeof MixBoard>[0] & { event: SoundEvent; choice: MixChoice; flash: boolean },
) {
  const { event: e, sound: s, choice } = p;
  const file = useFileImport();
  const info = EVENT_INFO[e];
  const custom = typeof choice === 'object' && 'custom' in choice ? choice.custom : null;

  async function pickFile() {
    const f = await file.pick();
    if (f) p.onChoice(e, keepGain({ custom: f.id }, choice));
  }

  async function remove() {
    if (!custom) return;
    await removeCustom(custom);
    // A removed file falls back to the default pack's sound for the event.
    p.onChoice(e, keepGain({ pack: DEFAULT_PACK }, choice));
  }

  return (
    <li className="mixrow" data-testid={`mix-${e}`} data-changed={p.flash || undefined}>
      <label className="chk mixrow__name">
        <input
          type="checkbox"
          aria-label={`${info.name} sound`}
          checked={s.perEvent[e]?.on ?? true}
          disabled={!s.enabled}
          onChange={(ev) => p.onEventOn(e, ev.target.checked)}
        />
        <span title={info.blurb}>{info.name}</span>
      </label>
      <div className="mixrow__ctl">
        <ChoiceSelect
          event={e}
          packs={p.packs}
          names={p.names}
          value={choice}
          label={`${info.name} source`}
          disabled={file.busy}
          onChange={(c) => c !== undefined && p.onChoice(e, keepGain(c, choice))}
          onPickFile={() => void pickFile()}
        />
        <GainSlider
          label={`${info.name} volume`}
          value={choiceGain(choice)}
          disabled={choice === 'off'}
          onChange={(g) => p.onChoice(e, withGain(choice, g))}
        />
        <button
          type="button"
          className="btn sec"
          aria-label={`Test ${info.name} sound`}
          disabled={choice === 'off'}
          onClick={() => playSound(e, { force: true })}
        >
          Test
        </button>
        {custom && (
          <button
            type="button"
            className="btn sec"
            aria-label={`Remove ${customLabel(p.names, custom)} for ${info.name}`}
            onClick={() => void remove()}
          >
            Remove file
          </button>
        )}
      </div>
      {file.error && (
        <p className="pf-err mixrow__err" role="alert">
          {file.error}
        </p>
      )}
    </li>
  );
}
