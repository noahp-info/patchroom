import { useEffect, useState } from 'react';
import type { SessionInfo } from '../../ipc';

/** "1m 31s" from milliseconds. */
function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${s % 60}s`;
}

/**
 * The live "Claude is working" line under the log, like the terminal's spinner line. It shows
 * the CLI's own words when the screen has them ("Slithering… 1m 31s · ↓ 409 tokens"), else
 * "Working…" with the time since the turn began. Hidden when the session is not busy.
 */
export function WorkingRow({ session }: { session: SessionInfo }) {
  const busy = session.status === 'busy';
  const line = session.working ?? null;
  const [now, setNow] = useState(() => Date.now());

  // Without the CLI's own detail, count the seconds here.
  useEffect(() => {
    if (!busy || line?.detail) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [busy, line?.detail]);

  if (!busy) return null;
  const detail = line?.detail || elapsed(now - (session.busySince ?? now));
  return (
    <div className="working" role="status" aria-live="off" data-testid="working-row">
      <span className="working__spin" aria-hidden="true" />
      <span className="working__verb">{line?.verb ?? 'Working…'}</span>
      <span className="working__detail">{detail}</span>
    </div>
  );
}
