import { themeVars } from '../../theme/apply.ts';
import type { Theme, ThemeMode } from '../../theme/types.ts';

/** A tiny rendering of the app in one theme and mode: title bar, sidebar, message, button. */
export function ThemePreview({
  theme,
  mode,
  large = false,
}: {
  theme: Theme;
  mode: ThemeMode;
  large?: boolean;
}) {
  return (
    <div
      className={`tp${large ? ' tp--lg' : ''}`}
      style={themeVars(theme, mode) as React.CSSProperties}
      data-testid="theme-preview"
      data-theme-id={theme.id}
      data-mode={mode}
      aria-hidden="true"
    >
      <div className="tp__tb">
        <i className="tp__dot" />
        <i className="tp__dot" />
        <i className="tp__dot" />
        <span className="tp__field" />
      </div>
      <div className="tp__body">
        <div className="tp__side">
          <b className="tp__mark" />
          <span className="tp__row" />
          <span className="tp__row tp__row--active" />
          <span className="tp__row">
            <i className="tp__badge" />
          </span>
        </div>
        <div className="tp__main">
          <span className="tp__line tp__line--fg" />
          <span className="tp__line tp__line--muted" />
          <span className="tp__code" />
          <span className="tp__actions">
            <i className="tp__btn" />
            <i className="tp__pill" />
          </span>
        </div>
      </div>
    </div>
  );
}
