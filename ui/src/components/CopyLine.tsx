import { useEffect, useState } from 'react';
import { copyText } from '../lib/clipboard';

/** One line of code to copy (a shell guard), with a Copy button that says when it worked. */
export function CopyLine({
  text,
  label = 'Copy',
  ariaLabel,
}: {
  text: string;
  label?: string;
  /** The button's name for assistive tech. Defaults to the label. */
  ariaLabel?: string;
}) {
  const [state, setState] = useState<'idle' | 'ok' | 'fail'>('idle');
  useEffect(() => {
    if (state === 'idle') return;
    const t = window.setTimeout(() => setState('idle'), 1800);
    return () => window.clearTimeout(t);
  }, [state]);
  return (
    <div className="copyline" data-testid="copy-line">
      <code className="copyline__code">{text}</code>
      <button
        type="button"
        className="btn sec copyline__btn"
        data-testid="copy-line-btn"
        aria-label={ariaLabel ?? label}
        onClick={() => void copyText(text).then((ok) => setState(ok ? 'ok' : 'fail'))}
      >
        {state === 'ok' ? 'Copied' : state === 'fail' ? 'Copy failed' : label}
      </button>
    </div>
  );
}
