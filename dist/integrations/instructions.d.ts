/**
 * The text we inject into each agent's instruction file.
 *
 * This is a deliverable, not boilerplate. It is the only thing standing
 * between a working index and an agent that keeps grepping anyway, and it is
 * loaded into context on every single turn, so it has to earn its tokens. Two
 * rules shaped it: say when the graph wins, and say plainly when it does not,
 * because an agent that trusts it for the wrong question will stop trusting it
 * for the right one.
 */
/** Claude Code reads CLAUDE.md and supports hooks, so it gets one extra line. */
export declare function claudeInstructions(): string;
export declare function genericInstructions(): string;
/** Cursor rules are .mdc files with YAML front matter. */
export declare function cursorRule(): string;
