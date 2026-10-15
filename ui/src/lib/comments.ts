/** One highlight-to-comment line in the composer: a quote from the chat plus the user's note. */
export interface DraftComment {
  id: string;
  /** The chat row the quote came from, for the jump back. Null outside the chat log. */
  key: string | null;
  quote: string;
  text: string;
  /** Where the selection started in the row's text, and its raw length: marks the exact words. */
  at?: number;
  len?: number;
}

/** Longest quote kept on a comment line. The agent gets the head of it and an ellipsis. */
export const QUOTE_MAX = 600;

/** Collapse a selection into a quote: trimmed, runs of blank lines folded, length capped. */
export function cleanQuote(raw: string): string {
  const t = raw
    .replace(/\r\n?/g, '\n')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return t.length > QUOTE_MAX ? `${t.slice(0, QUOTE_MAX).trimEnd()}…` : t;
}

/**
 * The text that reaches the agent: each comment as `> quote` then the note, then the typed
 * message. Empty notes still send their quote, so a bare highlight reads as "look at this".
 */
export function composeMessage(comments: DraftComment[], text: string): string {
  const parts = comments.map((c) => {
    const quote = c.quote
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    const note = c.text.trim();
    return note ? `${quote}\n${note}` : quote;
  });
  const body = text.trim();
  if (body) parts.push(text);
  return parts.join('\n\n');
}
