import { dndActive, dndSummary, scheduleIsUsable } from '../../sound/dnd.ts';
import type { DndSchedule } from './ipc.ts';
import { getPrefsStore, usePrefs } from './store.ts';

const DAYS = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
const DAY_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const WEEKNIGHTS: DndSchedule = { days: [1, 2, 3, 4, 5], start: '22:00', end: '08:00' };

export function DndSection() {
  const prefs = usePrefs();
  const store = getPrefsStore();
  const { manual, schedule } = prefs.dnd;
  const patch = (next: Partial<typeof prefs.dnd>) =>
    void store.update({ dnd: { ...prefs.dnd, ...next } });
  const setSchedule = (s: DndSchedule | null) => patch({ schedule: s });
  const on = dndActive(prefs.dnd);

  function toggleDay(d: number) {
    if (!schedule) return;
    const days = schedule.days.includes(d)
      ? schedule.days.filter((x) => x !== d)
      : [...schedule.days, d].sort();
    setSchedule({ ...schedule, days });
  }

  return (
    <div className="pf-section" data-testid="prefs-dnd">
      <h2>Do Not Disturb</h2>
      <p className="pf-hint">
        Silences Patchroom notifications and sounds. Needs-you badges still update.
      </p>

      <label className="chk">
        <input
          type="checkbox"
          role="switch"
          checked={manual}
          onChange={(e) => patch({ manual: e.target.checked })}
        />
        <span>Pause notifications and sounds now</span>
      </label>

      <label className="chk">
        <input
          type="checkbox"
          checked={schedule !== null}
          onChange={(e) => setSchedule(e.target.checked ? WEEKNIGHTS : null)}
        />
        <span>Turn on a schedule</span>
      </label>

      {schedule && (
        <div className="dnd" data-testid="dnd-schedule">
          <div className="dnd__days" role="group" aria-label="Days">
            {DAYS.map((d, i) => (
              <button
                key={i}
                type="button"
                className="daybtn"
                aria-pressed={schedule.days.includes(i)}
                aria-label={DAY_LONG[i]}
                onClick={() => toggleDay(i)}
              >
                {d}
              </button>
            ))}
          </div>
          <div className="pf-row">
            <label className="pf pf--inline">
              <span>From</span>
              <input
                type="time"
                aria-label="Start time"
                value={schedule.start}
                onChange={(e) => setSchedule({ ...schedule, start: e.target.value })}
              />
            </label>
            <label className="pf pf--inline">
              <span>Until</span>
              <input
                type="time"
                aria-label="End time"
                value={schedule.end}
                onChange={(e) => setSchedule({ ...schedule, end: e.target.value })}
              />
            </label>
          </div>
          <p
            className={scheduleIsUsable(schedule) ? 'dnd__sum' : 'pf-err'}
            data-testid="dnd-summary"
            aria-live="polite"
          >
            {dndSummary(schedule)}
          </p>
          <p className="pf-hint">
            A window that ends before it starts runs overnight into the next morning.
          </p>
        </div>
      )}

      <p className="dnd__now" role="status" data-testid="dnd-now">
        {on ? 'Do Not Disturb is on right now.' : 'Do Not Disturb is off right now.'}
      </p>
    </div>
  );
}
