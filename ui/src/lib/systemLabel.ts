const ACRONYMS = new Set(['api', 'mcp', 'cli', 'url', 'id', 'ui', 'pty']);

/** "api_error" reads "API error": known acronyms upper-cased, the rest sentence case. */
export function systemLabel(subtype: string): string {
  return subtype
    .split('_')
    .filter(Boolean)
    .map((w, i) =>
      ACRONYMS.has(w) ? w.toUpperCase() : i === 0 ? w[0].toUpperCase() + w.slice(1) : w,
    )
    .join(' ');
}
