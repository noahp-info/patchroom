import { FitAddon } from '@xterm/addon-fit';
import { Terminal as XTerm } from '@xterm/xterm';
import '@xterm/xterm/css/xterm.css';
import { useEffect, useRef } from 'react';

/**
 * xterm.js terminal stub. Renders a banner only; PTY wiring lands in phase P1
 * (session host, see docs/SPEC.md).
 */
export function Terminal() {
  const host = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = host.current;
    if (!el) return;

    const term = new XTerm({
      fontFamily: 'Menlo, Monaco, monospace',
      fontSize: 13,
      cursorBlink: true,
      allowProposedApi: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    fit.fit();
    term.writeln('Patchroom terminal stub. No PTY attached yet.');

    const observer = new ResizeObserver(() => fit.fit());
    observer.observe(el);

    return () => {
      observer.disconnect();
      term.dispose();
    };
  }, []);

  return <div ref={host} className="terminal" />;
}
