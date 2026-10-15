import { Fragment } from 'react';
import { previewChoice } from '../../../sound/index.ts';
import { EVENT_INFO } from '../../../sound/pack.ts';
import { SOUND_EVENTS, type PackInfo, type Prefs, type SoundEvent } from '../ipc.ts';

const KIND_LABEL: Record<PackInfo['kind'], string> = {
  generated: 'Generated',
  files: 'CC0 files',
  imported: 'Imported',
};

const GROUP: Record<PackInfo['kind'], string> = {
  generated: 'Generated in Patchroom',
  files: 'Recorded, CC0 by Kenney',
  imported: 'Imported from your Claude sounds',
};

const SHORT: Record<SoundEvent, string> = {
  needs: 'Needs',
  done: 'Done',
  message: 'Message',
  error: 'Error',
  bell: 'Bell',
  decision: 'Decision',
  due: 'Due',
  session: 'Session',
};

/** True when every event this pack has is already set to it. */
export function packInUse(pack: PackInfo, mix: Prefs['sound']['mix']): boolean {
  const evs = SOUND_EVENTS.filter((e) => pack.events[e]);
  return (
    evs.length > 0 &&
    evs.every((e) => {
      const c = mix[e];
      return typeof c === 'object' && 'pack' in c && c.pack === pack.id;
    })
  );
}

export function PackCards(props: {
  packs: PackInfo[];
  mix: Prefs['sound']['mix'];
  onUseAll(pack: PackInfo): void;
}) {
  return (
    <ul className="packs" aria-label="Sound packs">
      {props.packs.map((p, i) => {
        const inUse = packInUse(p, props.mix);
        const first = i === 0 || props.packs[i - 1].kind !== p.kind;
        return (
          <Fragment key={p.id}>
            {first && (
              <li className="packs__group" aria-hidden="true">
                {GROUP[p.kind]}
              </li>
            )}
            <li className="pack" data-testid={`pack-${p.id}`} data-in-use={inUse}>
              <div className="pack__head">
                <h4 className="pack__name">{p.name}</h4>
                <span className="pack__kind">{KIND_LABEL[p.kind]}</span>
              </div>
              <p className="pack__desc">{p.description}</p>
              <div className="pack__play" role="group" aria-label={`Play ${p.name}`}>
                <span className="pack__playlbl" aria-hidden="true">
                  Play
                </span>
                {SOUND_EVENTS.map((e) => (
                  <button
                    key={e}
                    type="button"
                    className="chip"
                    disabled={!p.events[e]}
                    aria-label={`Play ${p.name} ${EVENT_INFO[e].name} sound`}
                    onClick={() => previewChoice({ pack: p.id }, e)}
                  >
                    <span aria-hidden="true">{'\u25B6'} </span>
                    {SHORT[e]}
                  </button>
                ))}
              </div>
              <div className="pack__foot">
                <button
                  type="button"
                  className="btn sec"
                  aria-pressed={inUse}
                  aria-label={`Use ${p.name} for every event`}
                  onClick={() => props.onUseAll(p)}
                >
                  {inUse ? 'Used for every event' : 'Use for every event'}
                </button>
              </div>
            </li>
          </Fragment>
        );
      })}
    </ul>
  );
}
