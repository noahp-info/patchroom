import { CopyLine } from '../../CopyLine.tsx';
import { HOOK_GUARD } from '../../../lib/hints.ts';
import type { HookDetect } from '../ipc.ts';
import { unguardedSoundHooks } from '../store.ts';

/** Where a hook lives, in words. */
const SOURCE: Record<string, string> = {
  user: 'your settings',
  project: 'project settings',
  local: 'project local settings',
};

/**
 * The person's own Claude Code sound hooks also run in Patchroom sessions. Patchroom never
 * edits them, so this says how to keep each one quiet here: the guard line at the top of its
 * script, or, for an inline command, the same guard in front of it.
 */
export function HookNote({ detected }: { detected: readonly HookDetect[] }) {
  const loud = unguardedSoundHooks(detected);
  if (loud.length === 0) return null;
  const scripts = loud.some((h) => h.script);
  return (
    <section
      className="hooknote"
      aria-labelledby="hooknote-h"
      data-testid="sound-hooks-note"
      data-setting="sounds.hooks"
    >
      <h3 id="hooknote-h">Your own Claude Code hooks play here too</h3>
      <p className="pf-hint">
        Claude Code runs your hooks in every session, including Patchroom&apos;s, so you may hear
        both. Patchroom never edits your settings. This line makes a hook skip itself inside
        Patchroom only.
      </p>
      {scripts && <CopyLine text={HOOK_GUARD} label="Copy line" ariaLabel="Copy the guard line" />}
      <ul className="hooknote__list" aria-label="Sound hooks that also play here">
        {loud.map((h) => (
          <li key={`${h.source}:${h.event}:${h.command}`} data-hook-event={h.event}>
            <span className="hooknote__event">
              {h.event}
              <span className="hooknote__src">{SOURCE[h.source] ?? h.source}</span>
            </span>
            {h.script ? (
              <span className="hooknote__how">
                Add the line at the top of <code title={h.script}>{h.script}</code>, under its #!
                line.
              </span>
            ) : (
              <>
                <span className="hooknote__how">
                  This command is inline, not a script, so the line has to wrap it. Replace the
                  hook&apos;s command with:
                </span>
                <CopyLine
                  text={`${HOOK_GUARD}; ${h.command}`}
                  label="Copy command"
                  ariaLabel={`Copy the wrapped ${h.event} command`}
                />
              </>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}
