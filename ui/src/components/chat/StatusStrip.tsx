import { ansiCss, parseAnsi } from '../../lib/ansi';
import { cwdParts } from '../../lib/cwd';
import type { Statusline } from '../../state/chat';
import { Icon } from '../Icon';

export interface StatusStripProps {
  statusline: Statusline | null;
  cwd: string;
  onCycleMode(): void;
}

function prLabel(url: string): string {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? `PR #${m[1]}` : 'PR';
}

/** The CLI's mode ids are camelCase (`acceptEdits`); show words. */
function modeText(m: string): string {
  return m.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
}

function costText(c: number | string): string {
  return typeof c === 'number' ? `$${c.toFixed(2)}` : c.startsWith('$') ? c : `$${c}`;
}

/** Chips plus the user's own statusLine output, rendered as the TUI prints it. */
export function StatusStrip({ statusline, cwd, onCycleMode }: StatusStripProps) {
  const chips = statusline?.chips ?? {};
  const lines = statusline?.text ? parseAnsi(statusline.text) : [];
  const pct =
    chips.contextPct === undefined
      ? undefined
      : Math.max(0, Math.min(100, Math.round(chips.contextPct)));
  return (
    <div className="strip-wrap" data-testid="status-strip">
      <div className="strip" role="group" aria-label="Session status">
        {chips.model && (
          <span className="sc" data-chip="model">
            {chips.model}
          </span>
        )}
        <span className="sc" data-chip="folder" title={cwd}>
          <Icon name="folder" />
          {cwdParts(cwd).base || cwd}
        </span>
        {pct !== undefined && (
          <span className="sc" data-chip="context">
            <span
              className="meter"
              style={{ '--pct': `${pct}%` } as React.CSSProperties}
              aria-hidden="true"
            />
            ctx {pct}%
          </span>
        )}
        {chips.cost !== undefined && (
          <span className="sc" data-chip="cost">
            {costText(chips.cost)}
          </span>
        )}
        {chips.mode && (
          <button
            type="button"
            className="sc mode"
            data-chip="mode"
            onClick={onCycleMode}
            title="Cycle permission mode (Shift+Tab)"
          >
            {modeText(chips.mode)}
          </button>
        )}
        {chips.worktree && (
          <span className="sc" data-chip="worktree">
            <Icon name="branch" />
            {chips.worktree}
          </span>
        )}
        {chips.prUrl && (
          <a
            className="sc"
            data-chip="pr"
            href={chips.prUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {prLabel(chips.prUrl)}
          </a>
        )}
      </div>
      {lines.length > 0 && (
        <div className="sl" data-testid="statusline" role="status" aria-label="Status line">
          {lines.map((spans, i) => (
            <div className="sl-line" key={i}>
              {spans.length === 0
                ? ' '
                : spans.map((sp, j) => (
                    <span key={j} style={ansiCss(sp.style)}>
                      {sp.text}
                    </span>
                  ))}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
