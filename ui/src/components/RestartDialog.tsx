import { useEffect, useRef } from 'react';
import type { AppState, AppStore } from '../state/store';
import { useOverlay } from '../state/overlays';

const STATE: Record<string, string> = {
  busy: 'Working',
  waiting: 'Needs you',
  idle: 'Idle',
};

/**
 * Restart Patchroom (app menu): some sessions are mid-turn. Wait for them to go idle, or pick the
 * ones to interrupt. Every open session comes back in its folder with `--resume`, drafts kept.
 */
export function RestartDialog({ store, state }: { store: AppStore; state: AppState }) {
  useOverlay('restart');
  const ref = useRef<HTMLDialogElement>(null);
  const r = state.restart!;
  useEffect(() => {
    const dlg = ref.current;
    if (dlg && !dlg.open) dlg.showModal();
  }, []);
  const busy = store.busyIds(r.ids);
  const rows = r.ids
    .map((id) => state.sessions.find((s) => s.id === id))
    .filter((s): s is NonNullable<typeof s> => !!s);
  return (
    <dialog
      ref={ref}
      className="restart"
      aria-labelledby="restart-title"
      data-testid="restart-dialog"
      onClose={() => store.cancelRestart()}
    >
      <h2 id="restart-title">Restart Patchroom</h2>
      <p className="restart__lede">
        {rows.length === 1 ? 'Your session reopens' : `All ${rows.length} sessions reopen`} where
        they are, with drafts kept.{' '}
        {busy.length === 1 ? 'One is still working.' : `${busy.length} are still working.`}
      </p>
      <ul className="restart__list">
        {rows.map((s) => {
          const working = busy.includes(s.id);
          return (
            <li key={s.id} className="restart__row" data-restart-row={s.id}>
              <span className="nm">{s.name}</span>
              {working ? (
                <label className="chk">
                  <input
                    type="checkbox"
                    checked={r.interrupt.includes(s.id)}
                    disabled={r.waiting}
                    data-testid={`restart-interrupt-${s.id}`}
                    onChange={(e) => store.setRestartInterrupt(s.id, e.target.checked)}
                  />
                  <span>Interrupt</span>
                </label>
              ) : (
                <span className="restart__state">{STATE[s.status] ?? s.status}</span>
              )}
            </li>
          );
        })}
      </ul>
      {r.waiting && (
        <p className="restart__wait" role="status" data-testid="restart-waiting">
          Waiting for {busy.length === 1 ? 'one session' : `${busy.length} sessions`} to finish.
          Patchroom restarts as soon as they are idle.
        </p>
      )}
      <div className="restart__foot">
        <button type="button" className="btn sec" onClick={() => ref.current?.close()}>
          Cancel
        </button>
        <button
          type="button"
          className="btn pri"
          data-testid="restart-confirm"
          disabled={r.waiting}
          onClick={() => store.confirmRestart()}
        >
          {r.interrupt.length > 0 ? 'Interrupt and restart' : 'Restart when idle'}
        </button>
      </div>
    </dialog>
  );
}
