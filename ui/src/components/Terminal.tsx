import { useEffect, useRef } from 'react';
import type { SessionTerminal } from '../lib/sessionTerminal';

export interface TerminalProps {
  terminal: SessionTerminal;
  /** The DM is selected: the renderer runs and the grid fits, whichever view shows. */
  active: boolean;
  /** The terminal view is the one on screen: it takes input and focus. */
  visible: boolean;
  label: string;
}

/**
 * Mounts one session's xterm.js into a div. Every session keeps its own mounted view (hidden
 * when not active) so scrollback and the alt screen survive switching DMs.
 */
export function Terminal({ terminal, active, visible, label }: TerminalProps) {
  const host = useRef<HTMLDivElement>(null);
  const activeRef = useRef({ active, visible });
  useEffect(() => {
    activeRef.current = { active, visible };
  }, [active, visible]);

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
      terminal.setActive(activeRef.current.active, activeRef.current.visible);
    });
    return () => {
      live = false;
    };
  }, [terminal]);

  useEffect(() => {
    terminal.setActive(active, visible);
  }, [terminal, active, visible]);

  // Coming back to the terminal view puts the cursor in it.
  useEffect(() => {
    if (visible) terminal.focus();
  }, [terminal, visible]);

  return (
    <div
      className={`term${visible ? ' term--active' : ''}`}
      role="group"
      aria-label={`Terminal for ${label}`}
      aria-hidden={!visible}
      inert={!visible}
    >
      <div ref={host} className="term__host" data-testid="terminal" />
    </div>
  );
}
