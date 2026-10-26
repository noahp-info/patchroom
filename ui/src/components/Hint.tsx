import { HINTS, hintText, type HintDef, type HintId } from '../lib/hints';
import type { AppStore } from '../state/store';
import { Icon } from './Icon';

/**
 * The one shared first-time hint (DESIGN.md, First-time hints). It sits in flow (under the
 * conversation header, above the status strip, or above the log's bottom edge), so it never
 * covers or blocks anything. One at a time, shown once, dismissible, and it always offers the
 * setting it names.
 */
export function Hint({
  store,
  id,
  vars,
}: {
  store: AppStore;
  id: HintId;
  vars?: Record<string, string> | null;
}) {
  const h: HintDef = HINTS[id];
  return (
    <div className="hint" role="status" aria-live="polite" data-testid="hint" data-hint={id}>
      <Icon name="bell" />
      <span className="hint__text">{hintText(id, vars)}</span>
      <div className="hint__btns">
        {h.choices?.map((c) => (
          <button
            key={c.choice}
            type="button"
            className="btn sec"
            data-choice={c.choice}
            onClick={() => store.hintChoice(c.choice)}
          >
            {c.label}
          </button>
        ))}
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
