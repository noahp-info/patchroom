import type { ResolvedTermStyle } from '../../theme/terminal.ts';

/** A sample of a terminal in one palette and font, with the eight base ANSI colors. */
export function TermPreview({ style }: { style: ResolvedTermStyle }) {
  const t = style.theme;
  const swatches = [t.red, t.green, t.yellow, t.blue, t.magenta, t.cyan, t.white, t.brightBlack];
  return (
    <div
      className="tmp"
      data-testid="term-preview"
      data-palette={style.paletteId}
      style={{
        background: t.background,
        color: t.foreground,
        fontFamily: style.fontFamily,
        fontSize: style.fontSize,
      }}
    >
      <span className="tmp__line">
        <span style={{ color: t.green }}>$</span> claude --resume
      </span>
      <span className="tmp__swatches" aria-hidden="true">
        {swatches.map((c, i) => (
          <i key={i} style={{ background: c }} />
        ))}
      </span>
    </div>
  );
}
