/**
 * Builds an answer that fits a token budget.
 *
 * Every tool writes through this. Lines go in in priority order, and when the
 * budget runs out the rest is dropped and replaced with a note saying what was
 * cut and how to ask a narrower question. Silently truncating would be worse
 * than useless: the agent would treat a partial list as the whole answer.
 */
export declare class Answer {
    readonly budget: number;
    private readonly lines;
    private readonly omissions;
    private used;
    private full;
    /** Room kept back for the omission note, so it always fits. */
    private static readonly RESERVE;
    constructor(budget: number);
    get spent(): number;
    get isFull(): boolean;
    /** Adds a line if it fits. Returns false once the budget is spent. */
    add(line: string): boolean;
    /** Adds lines until one does not fit. Returns how many made it in. */
    addAll(lines: Iterable<string>): number;
    blank(): void;
    /** Records something the budget forced out, with advice on narrowing. */
    omit(description: string): void;
    render(): string;
}
/** Clamp a caller-supplied budget to something sane. */
export declare function normalizeBudget(requested: number | undefined, fallback: number): number;
