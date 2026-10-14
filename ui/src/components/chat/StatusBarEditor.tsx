import { useState } from 'react';
import type { StatusModuleId } from '../../ipc';
import { beginDrag } from '../../lib/dnd';
import { MODULES, moduleLabel, moveModule } from '../../lib/statusBar';
import { Icon } from '../Icon';

export interface StatusBarEditorProps {
  /** Modules in the strip, in order. */
  active: StatusModuleId[];
  /** Modules out of the strip. `duplicate` marks ones that repeat the user's statusLine. */
  tray: { id: StatusModuleId; duplicate: boolean }[];
  /** Enabled modules with nothing to show right now (no data yet). Dimmed, never removed. */
  idle?: ReadonlySet<StatusModuleId>;
  onChange(next: StatusModuleId[]): void;
}

type DropAt =
  { kind: 'row'; id: StatusModuleId; after: boolean } | { kind: 'end' } | { kind: 'tray' };

const hintOf = (id: string) => MODULES.find((m) => m.id === id)?.hint;

/** Where a pointer landed: on an active row (before or after it), the list end, or the tray. */
function dropTarget(under: Element | null, y: number): DropAt | null {
  const row = under?.closest<HTMLElement>('[data-sbe-active] [data-mod]');
  if (row) {
    const r = row.getBoundingClientRect();
    return { kind: 'row', id: row.dataset.mod as StatusModuleId, after: y > r.top + r.height / 2 };
  }
  if (under?.closest('[data-sbe-active]')) return { kind: 'end' };
  if (under?.closest('[data-sbe-tray]')) return { kind: 'tray' };
  return null;
}

/**
 * Reorder, remove and add status strip modules. Drag a row by its grip (pointer events: HTML5
 * drag and drop is unreliable in the webview), or focus the grip and press the arrow keys.
 */
export function StatusBarEditor({ active, tray, idle, onChange }: StatusBarEditorProps) {
  const [drag, setDrag] = useState<{ id: StatusModuleId; at: DropAt | null } | null>(null);

  const begin = (e: React.PointerEvent, id: StatusModuleId) => {
    let at: DropAt | null = null;
    const list = active;
    beginDrag(e, {
      onStart: () => setDrag({ id, at: null }),
      onMove: (_x, y, under) => {
        at = dropTarget(under, y);
        setDrag({ id, at });
      },
      onEnd: (_x, _y, _under, committed) => {
        setDrag(null);
        if (!committed || !at) return;
        if (at.kind === 'tray') {
          onChange(list.filter((m) => m !== id));
        } else if (at.kind === 'end') {
          onChange(moveModule(list, id, null));
        } else if (at.id !== id) {
          const rest = list.filter((m) => m !== id);
          const i = rest.indexOf(at.id) + (at.after ? 1 : 0);
          onChange(moveModule(list, id, rest[i] ?? null));
        }
      },
    });
  };

  const step = (e: React.KeyboardEvent, id: StatusModuleId) => {
    const i = active.indexOf(id);
    if (e.key === 'ArrowUp' && i > 0) {
      e.preventDefault();
      onChange(moveModule(active, id, active[i - 1]));
    } else if (e.key === 'ArrowDown' && i < active.length - 1) {
      e.preventDefault();
      onChange(moveModule(active, id, active[i + 2] ?? null));
    }
  };

  return (
    <div className="sbe" data-testid="statusbar-editor" data-dragging={drag ? 'true' : undefined}>
      <ul className="sbe__list" aria-label="Shown in the status bar" data-sbe-active="">
        {active.length === 0 && <li className="sbe__none">Nothing shown. Add a module below.</li>}
        {active.map((id) => {
          const mark =
            drag?.at?.kind === 'row' && drag.at.id === id
              ? drag.at.after
                ? 'after'
                : 'before'
              : undefined;
          return (
            <li
              key={id}
              className="sbe__row"
              data-mod={id}
              data-drop={mark}
              data-lifted={drag?.id === id ? 'true' : undefined}
              data-idle={idle?.has(id) ? 'true' : undefined}
            >
              <button
                type="button"
                className="sbe__grip"
                aria-label={`Reorder ${moduleLabel(id)}. Drag, or use the arrow keys.`}
                onPointerDown={(e) => begin(e, id)}
                onKeyDown={(e) => step(e, id)}
              >
                <Icon name="grip" />
              </button>
              <span className="sbe__name" title={hintOf(id)}>
                {moduleLabel(id)}
              </span>
              {idle?.has(id) && <span className="sbe__tag">Nothing to show yet</span>}
              <button
                type="button"
                className="sbe__x"
                aria-label={`Remove ${moduleLabel(id)}`}
                onClick={() => onChange(active.filter((m) => m !== id))}
              >
                <Icon name="x" />
              </button>
            </li>
          );
        })}
      </ul>
      <h4 className="sbe__h" id="sbe-tray-h">
        Tray
      </h4>
      <ul
        className="sbe__tray"
        aria-labelledby="sbe-tray-h"
        data-sbe-tray=""
        data-drop={drag?.at?.kind === 'tray' ? 'tray' : undefined}
      >
        {tray.length === 0 && <li className="sbe__none">Everything is in the status bar.</li>}
        {tray.map((t) => (
          <li key={t.id} className="sbe__row sbe__row--tray" data-mod={t.id}>
            <span className="sbe__name" title={hintOf(t.id)}>
              {moduleLabel(t.id)}
            </span>
            {t.duplicate && (
              <span className="sbe__tag" data-testid={`dup-${t.id}`}>
                Repeats your statusLine
              </span>
            )}
            <button
              type="button"
              className="sbe__add"
              aria-label={`Add ${moduleLabel(t.id)}`}
              onClick={() => onChange([...active, t.id])}
            >
              <Icon name="plus" />
              Add
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
