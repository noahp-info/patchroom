import { useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { Prefs, StatusChips } from '../../ipc';
import { ansiCss, parseAnsi } from '../../lib/ansi';
import { cwdParts } from '../../lib/cwd';
import {
  contextPct,
  costText,
  modeText,
  prLabel,
  availableModules,
  resolveLayout,
  visibleModules,
  type StatusFacts,
} from '../../lib/statusBar';
import type { Statusline } from '../../state/chat';
import type { AppStore } from '../../state/store';
import { Floating } from '../Floating';
import { Icon } from '../Icon';
import { StatusBarEditor } from './StatusBarEditor';

export interface StatusStripProps {
  store: AppStore;
  sessionId: string;
  statusline: Statusline | null;
  cwd: string;
  prefs: Prefs | null;
  onCycleMode(): void;
}

const NO_CHIPS: StatusChips = {};

type MenuAt = { x: number; y: number } | DOMRect;

/**
 * The strip: modules in the user's order. The chips come from the CLI's facts; the user's own
 * statusLine is one more module, printed verbatim. A chip that repeats the statusLine is hidden
 * until the user saves a layout of their own.
 */
export function StatusStrip({
  store,
  sessionId,
  statusline,
  cwd,
  prefs,
  onCycleMode,
}: StatusStripProps) {
  const chips = statusline?.chips ?? NO_CHIPS;
  const [menu, setMenu] = useState<MenuAt | null>(null);
  const facts = useMemo<StatusFacts>(
    () => ({ chips, cwd, statusText: statusline?.text }),
    [chips, cwd, statusline?.text],
  );
  const layout = useMemo(() => resolveLayout(prefs, sessionId, facts), [prefs, sessionId, facts]);
  const shown = visibleModules(layout, facts);
  const lines = useMemo(() => (facts.statusText ? parseAnsi(facts.statusText) : []), [facts]);
  const pct = contextPct(chips);
  // The theme ground the statusLine sits on, read from the live tokens, so ANSI colors stay
  // readable in light themes.
  const wrapRef = useRef<HTMLDivElement>(null);
  const [ground, setGround] = useState<string | undefined>(undefined);
  useLayoutEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    const read = () => {
      const v = getComputedStyle(el).getPropertyValue('--bg').trim();
      setGround(/^#[0-9a-f]{3,8}$/i.test(v) ? v : undefined);
    };
    read();
    const obs = new MutationObserver(read);
    const root = el.closest('.pr-app');
    if (root)
      obs.observe(root, {
        attributes: true,
        attributeFilter: ['style', 'data-theme', 'data-mode'],
      });
    return () => obs.disconnect();
  }, []);

  const render = (id: (typeof shown)[number]) => {
    switch (id) {
      case 'model':
        return (
          <span key={id} className="sc" data-chip="model">
            {chips.model}
          </span>
        );
      case 'folder':
        return (
          <span key={id} className="sc" data-chip="folder" title={cwd}>
            <Icon name="folder" />
            {cwdParts(cwd).base || cwd}
          </span>
        );
      case 'context':
        return (
          <span key={id} className="sc" data-chip="context">
            <span
              className="meter"
              style={{ '--pct': `${pct}%` } as React.CSSProperties}
              aria-hidden="true"
            />
            ctx {pct}%
          </span>
        );
      case 'cost':
        return (
          <span key={id} className="sc" data-chip="cost">
            {costText(chips.cost!)}
          </span>
        );
      case 'mode':
        return (
          <button
            key={id}
            type="button"
            className="sc mode"
            data-chip="mode"
            onClick={onCycleMode}
            title="Cycle permission mode (Shift+Tab)"
          >
            {modeText(chips.mode!)}
          </button>
        );
      case 'worktree':
        return (
          <span key={id} className="sc" data-chip="worktree">
            <Icon name="branch" />
            {chips.worktree}
          </span>
        );
      case 'branch':
        return (
          <span key={id} className="sc" data-chip="branch">
            <Icon name="branch" />
            {chips.branch}
          </span>
        );
      case 'pr':
        return (
          <a
            key={id}
            className="sc"
            data-chip="pr"
            href={chips.prUrl}
            target="_blank"
            rel="noopener noreferrer"
          >
            {prLabel(chips.prUrl!)}
          </a>
        );
      case 'statusline':
        return (
          <div
            key={id}
            className="sl"
            data-testid="statusline"
            role="status"
            aria-label="Status line"
          >
            {lines.map((spans, i) => (
              <div className="sl-line" key={i}>
                {spans.length === 0
                  ? ' '
                  : spans.map((sp, j) => (
                      <span key={j} style={ansiCss(sp.style, ground)}>
                        {sp.text}
                      </span>
                    ))}
              </div>
            ))}
          </div>
        );
    }
  };

  return (
    <div
      ref={wrapRef}
      className="strip-wrap"
      data-testid="status-strip"
      data-layout={layout.source}
      onContextMenu={(e) => {
        e.preventDefault();
        setMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="strip" role="group" aria-label="Session status">
        {shown.map(render)}
        <button
          type="button"
          className="strip__edit"
          aria-label="Customize status bar"
          aria-haspopup="dialog"
          title="Customize status bar"
          data-testid="strip-customize"
          onClick={(e) => setMenu(e.currentTarget.getBoundingClientRect())}
        >
          <Icon name="gear" />
        </button>
      </div>
      {menu && (
        <Floating
          anchor={menu}
          label="Customize status bar"
          className="pop sbmenu"
          onClose={() => setMenu(null)}
        >
          <h3 className="pop__h">Customize status bar</h3>
          <label className="sbmenu__scope">
            <input
              type="checkbox"
              checked={layout.source === 'dm'}
              data-testid="sb-only-dm"
              onChange={(e) =>
                void store.setStatusBar(sessionId, e.target.checked ? layout.active : null)
              }
            />
            Only for this DM
          </label>
          <StatusBarEditor
            idle={new Set(layout.active.filter((m) => !availableModules(facts).has(m)))}
            active={layout.active}
            tray={layout.tray}
            onChange={(next) =>
              void store.setStatusBar(layout.source === 'dm' ? sessionId : null, next)
            }
          />
          <div className="sbmenu__foot">
            <button
              type="button"
              className="sbmenu__reset"
              disabled={layout.source === 'builtin'}
              data-testid="sb-reset"
              onClick={() =>
                void store.setStatusBar(layout.source === 'dm' ? sessionId : null, null)
              }
            >
              Reset
            </button>
            <span className="sbmenu__note">
              {layout.source === 'builtin'
                ? 'Chips your statusLine already prints stay hidden.'
                : 'A saved layout shows what you chose, repeats included.'}
            </span>
          </div>
        </Floating>
      )}
    </div>
  );
}
