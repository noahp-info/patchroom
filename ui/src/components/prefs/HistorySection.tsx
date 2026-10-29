import type { HistoryGroup } from '../../ipc/types.ts';
import { HISTORY_GROUPS } from '../../lib/history.ts';
import { getPrefsStore, usePrefs } from './store.ts';

/** History: how the panel groups sessions. The panel header changes the same setting. */
export function HistorySection() {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const by: HistoryGroup = prefs.history?.groupBy ?? 'folder';
  return (
    <div className="pf-section" data-testid="prefs-history">
      <h2>History</h2>
      <p className="pf-hint">
        History lists every Claude Code session on this Mac, in every folder. It reads
        Claude&#8217;s transcripts and never changes them. It shows only each session&#8217;s title
        and first message.
      </p>
      <h3>Group sessions by</h3>
      <div
        className="pf-seg"
        role="radiogroup"
        aria-label="Group History by"
        data-setting="history.group"
      >
        {HISTORY_GROUPS.map((g) => (
          <label key={g.id} className="pf-seg__opt">
            <input
              type="radio"
              name="history-group"
              checked={by === g.id}
              onChange={() => void store.update({ history: { groupBy: g.id } })}
            />
            <span>{g.label}</span>
          </label>
        ))}
      </div>
      <p className="pf-hint">
        The toggle in the History header changes this too, and search filters within the chosen
        grouping. Date groups read Today, This week, then week numbers, then months.
      </p>
    </div>
  );
}
