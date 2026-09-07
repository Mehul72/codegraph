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

const CORE = `## codegraph

This repo has a codegraph index: a local graph of its symbols and how they relate. Query it through the \`codegraph\` MCP tools before answering structural questions. A graph query costs a few hundred tokens; the file reads it replaces usually cost several thousand.

Reach for it when the question is about structure:

- where is X defined: \`where_defined\`
- what is X and what does it touch: \`get_symbol\`
- who calls X, what breaks if I change it: \`find_callers\`, then \`impact_of\` before you edit
- what does X depend on: \`find_callees\`
- how do X and Y connect: \`shortest_path\`
- what is in this module, where do I start reading: \`overview\`
- I only know part of the name: \`search_symbols\`
- what did my change set touch: \`changed_since\`

Read the file directly when you need the literal text: the body of the function you are about to modify, exact logic, comments and docstrings, string contents, formatting. codegraph tells you where to look and what connects to what. It does not replace reading the code you are changing.

Every result carries a confidence tag, and it matters:

- \`exact\` the parser saw both ends in one file
- \`resolved\` name resolution linked it across files using real import evidence
- \`heuristic\` a name matched and nothing contradicted it, so it may be wrong

Treat \`heuristic\` results as leads to confirm, not facts. Say so if you report one.

The index refreshes itself before every query, so results reflect edits made earlier in this session. It covers this repo's own source only: third-party packages, the standard library and anything generated at build time are outside it, so an empty result can mean "not in indexed code" rather than "does not exist".`;

/** Claude Code reads CLAUDE.md and supports hooks, so it gets one extra line. */
export function claudeInstructions(): string {
  return `${CORE}

Edits you make are reindexed by a PostToolUse hook, so no manual step is needed after writing a file.`;
}

export function genericInstructions(): string {
  return CORE;
}

/** Cursor rules are .mdc files with YAML front matter. */
export function cursorRule(): string {
  return `---
description: Query the codegraph index for structural questions about this repo
alwaysApply: true
---

${CORE}
`;
}
