/**
 * Rough token accounting. We deliberately do not pull in a real tokenizer:
 * it would add a heavy dependency and a load-time cost to every CLI call, and
 * four characters per token is close enough for budgeting prose and code
 * identifiers. It errs slightly high on dense code, which is the safe side.
 */
export declare function estimateTokens(text: string): number;
/** Collapse all whitespace runs to single spaces and trim. */
export declare function squash(text: string): string;
export declare function truncate(text: string, max: number): string;
/** Pad to width for column output. Never truncates, so columns can drift. */
export declare function pad(text: string, width: number): string;
/**
 * Enough English to keep the output from reading like a template. The -es
 * cases are here because "1 match" and "6 matchs" in the first line of an
 * answer looks like nobody read it.
 */
export declare function plural(count: number, one: string, many?: string): string;
export declare function formatDuration(ms: number): string;
export declare function formatCount(n: number): string;
/**
 * Case-insensitive subsequence match with a score, which is all the fuzziness
 * symbol search needs. Lower scores are better. Returns null for no match.
 */
export declare function fuzzyScore(query: string, candidate: string): number | null;
