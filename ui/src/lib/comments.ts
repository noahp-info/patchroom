import { shellQuotePath } from './keys';

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
  /** A comment on the side-pane page: the page URL with a `#:~:text=` fragment, for the jump back. */
  link?: string;
  /** A screenshot line: the saved file (sent as its path) and a picture for the line. */
  image?: { path: string; src: string };
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
    if (c.image) {
      const note = c.text.trim();
      return note ? `${shellQuotePath(c.image.path)}\n${note}` : shellQuotePath(c.image.path);
    }
    const quote = c.quote
      .split('\n')
      .map((l) => (l ? `> ${l}` : '>'))
      .join('\n');
    const note = c.text.trim();
    const from = c.link ? `\n(from ${pageOf(c.link)})` : '';
    return note ? `${quote}${from}\n${note}` : `${quote}${from}`;
  });
  const body = text.trim();
  if (body) parts.push(text);
  return parts.join('\n\n');
}

/** The page a link points at, without its fragment. */
export function pageOf(link: string): string {
  return link.split('#')[0];
}

/** A text fragment (`#:~:text=...`) that finds `quote` again on its page. Long quotes use
 *  the first and last few words as a range, which browsers match more reliably. */
export function textFragmentLink(url: string, quote: string): string {
  const words = quote.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  const enc = (s: string) => encodeURIComponent(s).replace(/-/g, '%2D');
  const frag =
    words.length <= 10
      ? enc(words.join(' '))
      : `${enc(words.slice(0, 5).join(' '))},${enc(words.slice(-5).join(' '))}`;
  return `${pageOf(url)}#:~:text=${frag}`;
}
