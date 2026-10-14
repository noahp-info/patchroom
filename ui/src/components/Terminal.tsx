import { useEffect, useRef } from 'react';
import type { SessionTerminal } from '../lib/sessionTerminal';

export interface TerminalProps {
  terminal: SessionTerminal;
  active: boolean;
  label: string;
}

/**
 * Mounts one session's xterm.js into a div. Every session keeps its own mounted view (hidden
 * when not active) so scrollback and the alt screen survive switching DMs.
 */
export function Terminal({ terminal, active, label }: TerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  const activeRef = useRef(active);
  useEffect(() => {
    activeRef.current = active;
  }, [active]);

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    let live = true;
    // Measure the real font, not the fallback: wait for it before xterm opens.
    const fonts = document.fonts?.load('13px "JetBrains Mono"').catch(() => undefined);
    const timeout = new Promise((r) => setTimeout(r, 1500));
    void Promise.race([fonts, timeout]).then(() => {
      if (!live || !el.isConnected) return;
      terminal.mount(el); // idempotent
      terminal.setActive(activeRef.current);
    });
    return () => {
      live = false;
    };
  }, [terminal]);

  useEffect(() => {
    terminal.setActive(active);
  }, [terminal, active]);

  return (
    <div
      className={`term${active ? ' term--active' : ''}`}
      role="group"
      aria-label={`Terminal for ${label}`}
      aria-hidden={!active}
      inert={!active}
    >
      <div ref={host} className="term__host" data-testid="terminal" />
    </div>
  );
}
