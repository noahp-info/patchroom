import { eventsForHook } from '../../sound/decide.ts';
import { PACK } from '../../sound/pack.ts';
import { getPrefsStore, usePrefsState } from './store.ts';

export function HooksSection() {
  const { prefs, detected } = usePrefsState();
  const store = getPrefsStore();
  const policy = prefs.sound.hookPolicy;

  const byEvent = new Map<string, { commands: string[]; sources: string[] }>();
  for (const h of detected) {
    const g = byEvent.get(h.event) ?? { commands: [], sources: [] };
    g.commands.push(h.command);
    const src = h.guarded ? `${h.source}, quiet in Patchroom` : h.source;
    if (!g.sources.includes(src)) g.sources.push(src);
    byEvent.set(h.event, g);
  }

  const set = (event: string, v: 'keep' | 'both') =>
    void store.update({ sound: { ...prefs.sound, hookPolicy: { ...policy, [event]: v } } });

  return (
    <div className="pf-section" data-testid="prefs-hooks">
      <h2>Existing sound hooks</h2>
      <p className="pf-hint">
        Patchroom reads your Claude settings and finds hooks that play audio. It never edits them.
        Keep yours silences Patchroom for that event, so you do not hear two sounds.
      </p>

      {byEvent.size === 0 ? (
        <p className="pf-empty" data-testid="hooks-empty" data-setting="hooks.policy">
          No sound hooks found. Patchroom plays its own sounds.
        </p>
      ) : (
        <table className="htable" data-testid="hooks-table" data-setting="hooks.policy">
          <thead>
            <tr>
              <th scope="col">Hook event</th>
              <th scope="col">Command</th>
              <th scope="col">Patchroom sound</th>
              <th scope="col">When both could play</th>
            </tr>
          </thead>
          <tbody>
            {[...byEvent].map(([event, g]) => {
              const twins = eventsForHook(event);
              const cur = policy[event] ?? 'keep';
              return (
                <tr key={event} data-hook-event={event}>
                  <th scope="row">
                    {event}
                    <small className="pf-hint">{g.sources.join(', ')}</small>
                  </th>
                  <td>
                    {g.commands.map((c) => (
                      <code key={c} title={c}>
                        {c}
                      </code>
                    ))}
                  </td>
                  <td>{twins.length ? twins.map((t) => PACK[t].name).join(', ') : 'No overlap'}</td>
                  <td>
                    <div className="pf-seg" role="radiogroup" aria-label={`${event} policy`}>
                      <label className="pf-seg__opt">
                        <input
                          type="radio"
                          name={`hook-${event}`}
                          checked={cur === 'keep'}
                          onChange={() => set(event, 'keep')}
                        />
                        <span>Keep yours</span>
                      </label>
                      <label className="pf-seg__opt">
                        <input
                          type="radio"
                          name={`hook-${event}`}
                          checked={cur === 'both'}
                          onChange={() => set(event, 'both')}
                        />
                        <span>Play both</span>
                      </label>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      <div className="pf-row">
        <button type="button" className="btn sec" onClick={() => void store.refreshDetected()}>
          Check again
        </button>
      </div>
    </div>
  );
}
