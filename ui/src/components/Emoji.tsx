import type { EmojiFlavor } from '../ipc';

/**
 * One emoji in the flavor it was chosen in: the system Apple Color Emoji, or the bundled Noto
 * Color Emoji (OFL, ui/src/theme/fonts/noto-emoji). The character never changes, only the font.
 */
export function Emoji({
  char,
  flavor,
  className,
  testId,
}: {
  char: string;
  flavor?: EmojiFlavor | null;
  className?: string;
  testId?: string;
}) {
  return (
    <span
      className={`emo${className ? ` ${className}` : ''}`}
      data-flavor={flavor ?? 'apple'}
      data-testid={testId}
      aria-hidden="true"
    >
      {char}
    </span>
  );
}

const FLAVOR_KEY = 'patchroom.emojiFlavor';

/** The flavor the picker last used, so the next pick starts there. */
export function lastFlavor(): EmojiFlavor {
  try {
    return window.localStorage.getItem(FLAVOR_KEY) === 'noto' ? 'noto' : 'apple';
  } catch {
    return 'apple';
  }
}

export function rememberFlavor(f: EmojiFlavor): void {
  try {
    window.localStorage.setItem(FLAVOR_KEY, f);
  } catch {
    // A convenience only.
  }
}
