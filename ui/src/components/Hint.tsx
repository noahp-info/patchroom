import { HINTS, type HintId } from '../lib/hints';
import type { AppStore } from '../state/store';
import { Icon } from './Icon';

/**
 * The one shared first-time hint (DESIGN.md, First-time hints). It sits in flow under the
 * conversation header, so it never covers or blocks anything. One at a time, shown once,
 * dismissible, and it always offers the setting it names.
 */
export function Hint({ store, id }: { store: AppStore; id: HintId }) {
  const h = HINTS[id];
  return (
    <div className="hint" role="status" aria-live="polite" data-testid="hint" data-hint={id}>
      <Icon name="bell" />
      <span className="hint__text">{h.text}</span>
      <div className="hint__btns">
        <button type="button" className="btn sec" onClick={() => store.hintAction()}>
          {h.action.label}
        </button>
        <button
          type="button"
          className="ib"
          aria-label="Dismiss hint"
          title="Dismiss"
          onClick={() => store.dismissHint()}
        >
          <Icon name="x" />
        </button>
      </div>
    </div>
  );
}
