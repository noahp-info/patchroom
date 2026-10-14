/** Subsequence match of `query` in `text`. Higher is better; null means no match. */
export interface Fuzzy {
  score: number;
  /** Matched character offsets in `text`, for highlighting. */
  at: number[];
}

const isBoundary = (text: string, i: number): boolean =>
  i === 0 || /[\s/_\-.]/.test(text[i - 1]) || (/[a-z]/.test(text[i - 1]) && /[A-Z]/.test(text[i]));

export function fuzzy(query: string, text: string): Fuzzy | null {
  const q = query.toLowerCase().replace(/\s+/g, '');
  if (q === '') return { score: 0, at: [] };
  const low = text.toLowerCase();
  const exact = low.indexOf(q);
  if (exact >= 0) {
    // A contiguous hit beats any scattered one; a prefix or word start beats a middle hit.
    const bonus = exact === 0 ? 40 : isBoundary(text, exact) ? 25 : 10;
    return {
      score: 100 + bonus + q.length * 2,
      at: Array.from({ length: q.length }, (_, k) => exact + k),
    };
  }
  const at: number[] = [];
  let score = 0;
  let from = 0;
  let prev = -2;
  for (const ch of q) {
    const i = low.indexOf(ch, from);
    if (i < 0) return null;
    score += 3 + (i === prev + 1 ? 6 : 0) + (isBoundary(text, i) ? 5 : 0) - Math.min(4, i - from);
    at.push(i);
    prev = i;
    from = i + 1;
  }
  return { score: Math.max(1, score), at };
}
