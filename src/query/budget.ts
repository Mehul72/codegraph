import { estimateTokens } from '../util/text.js';

/**
 * Builds an answer that fits a token budget.
 *
 * Every tool writes through this. Lines go in in priority order, and when the
 * budget runs out the rest is dropped and replaced with a note saying what was
 * cut and how to ask a narrower question. Silently truncating would be worse
 * than useless: the agent would treat a partial list as the whole answer.
 */
export class Answer {
  private readonly lines: string[] = [];
  private readonly omissions: string[] = [];
  private used = 0;
  private full = false;

  /** Room kept back for the omission note, so it always fits. */
  private static readonly RESERVE = 40;

  constructor(readonly budget: number) {}

  get spent(): number {
    return this.used;
  }

  get isFull(): boolean {
    return this.full;
  }

  /** Adds a line if it fits. Returns false once the budget is spent. */
  add(line: string): boolean {
    if (this.full) return false;
    const cost = estimateTokens(line) + 1;
    if (this.used + cost > this.budget - Answer.RESERVE) {
      this.full = true;
      return false;
    }
    this.lines.push(line);
    this.used += cost;
    return true;
  }

  /** Adds lines until one does not fit. Returns how many made it in. */
  addAll(lines: Iterable<string>): number {
    let added = 0;
    for (const line of lines) {
      if (!this.add(line)) break;
      added++;
    }
    return added;
  }

  blank(): void {
    if (this.lines.length > 0 && this.lines[this.lines.length - 1] !== '') this.add('');
  }

  /** Records something the budget forced out, with advice on narrowing. */
  omit(description: string): void {
    this.omissions.push(description);
  }

  render(): string {
    const out = [...this.lines];
    while (out.length > 0 && out[out.length - 1] === '') out.pop();

    if (this.omissions.length > 0) {
      out.push('');
      out.push(`omitted: ${this.omissions.join('; ')}`);
    }
    return out.join('\n');
  }
}

/** Clamp a caller-supplied budget to something sane. */
export function normalizeBudget(requested: number | undefined, fallback: number): number {
  if (typeof requested !== 'number' || !Number.isFinite(requested)) return fallback;
  return Math.max(120, Math.min(20_000, Math.floor(requested)));
}
