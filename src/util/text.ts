/**
 * Rough token accounting. We deliberately do not pull in a real tokenizer:
 * it would add a heavy dependency and a load-time cost to every CLI call, and
 * four characters per token is close enough for budgeting prose and code
 * identifiers. It errs slightly high on dense code, which is the safe side.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  return Math.ceil(text.length / 4);
}

/** Collapse all whitespace runs to single spaces and trim. */
export function squash(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  if (max <= 3) return text.slice(0, max);
  return text.slice(0, max - 3) + '...';
}

/** Pad to width for column output. Never truncates, so columns can drift. */
export function pad(text: string, width: number): string {
  return text.length >= width ? text : text + ' '.repeat(width - text.length);
}

/**
 * Enough English to keep the output from reading like a template. The -es
 * cases are here because "1 match" and "6 matchs" in the first line of an
 * answer looks like nobody read it.
 */
export function plural(count: number, one: string, many?: string): string {
  if (count === 1) return one;
  if (many) return many;
  if (/(s|x|z|ch|sh)$/.test(one)) return one + 'es';
  if (/[^aeiou]y$/.test(one)) return one.slice(0, -1) + 'ies';
  return one + 's';
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${Math.round(ms)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const mins = Math.floor(ms / 60_000);
  const secs = Math.round((ms % 60_000) / 1000);
  return `${mins}m ${secs}s`;
}

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

/**
 * Case-insensitive subsequence match with a score, which is all the fuzziness
 * symbol search needs. Lower scores are better. Returns null for no match.
 */
export function fuzzyScore(query: string, candidate: string): number | null {
  if (query.length === 0) return 0;
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();

  if (c === q) return 0;
  const at = c.indexOf(q);
  if (at === 0) return 1 + candidate.length / 1000;
  if (at > 0) return 10 + at + candidate.length / 1000;

  // Fall back to subsequence: every query char appears in order.
  let ci = 0;
  let gaps = 0;
  for (const ch of q) {
    const found = c.indexOf(ch, ci);
    if (found === -1) return null;
    gaps += found - ci;
    ci = found + 1;
  }
  return 100 + gaps + candidate.length / 1000;
}
