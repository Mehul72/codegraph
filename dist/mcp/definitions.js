/**
 * Tool definitions handed to the agent.
 *
 * The descriptions are part of the product, not documentation. An agent picks
 * a tool from this text alone, so each one says what question it answers and,
 * where it matters, when reading the file directly is the better move.
 */
const BUDGET_PROP = {
    budget: {
        type: 'number',
        description: 'Maximum output tokens. Output is truncated to fit and says what it dropped. Default 1200.',
    },
};
const SYMBOL_PROP = {
    type: 'string',
    description: 'Symbol name. Accepts a bare name (createOrder), a qualified name (OrderService.create), a fully qualified name with its module, or a file.py:name pair.',
};
export const TOOL_DEFINITIONS = [
    {
        name: 'search_symbols',
        description: 'Fuzzy search for symbols by name. Use this when you know roughly what something is called but not where it lives. Returns name, kind, file:line and a one-line signature. Replaces grepping for a definition.',
        inputSchema: {
            type: 'object',
            properties: {
                query: { type: 'string', description: 'Partial or full symbol name.' },
                kind: {
                    type: 'string',
                    description: 'Restrict to one kind.',
                    enum: ['function', 'method', 'class', 'interface', 'struct', 'module', 'constant', 'table', 'endpoint'],
                },
                lang: { type: 'string', description: 'Restrict to one language id, for example python or go.' },
                limit: { type: 'number', description: 'Maximum results. Default 25.' },
                ...BUDGET_PROP,
            },
            required: ['query'],
        },
    },
    {
        name: 'where_defined',
        description: 'Find where a name is defined. Fastest way to turn a name into a file and line. Use this instead of grep or a file search when you have an exact or near-exact name.',
        inputSchema: {
            type: 'object',
            properties: { name: SYMBOL_PROP, ...BUDGET_PROP },
            required: ['name'],
        },
    },
    {
        name: 'get_symbol',
        description: 'One symbol in context: signature, location, doc line, and its immediate neighbours grouped by relationship with a confidence tag on each. Use this to orient before reading a symbol, then read the file for the body.',
        inputSchema: {
            type: 'object',
            properties: { name: SYMBOL_PROP, ...BUDGET_PROP },
            required: ['name'],
        },
    },
    {
        name: 'find_callers',
        description: 'Who calls or references this symbol, transitively up to depth. Use this before changing a signature, and to find every place that needs updating.',
        inputSchema: {
            type: 'object',
            properties: {
                symbol: SYMBOL_PROP,
                depth: { type: 'number', description: 'Hops to follow. Default 1, maximum 6.' },
                cross_repo: { type: 'boolean', description: 'Include callers in linked repos. Default true when links exist.' },
                ...BUDGET_PROP,
            },
            required: ['symbol'],
        },
    },
    {
        name: 'find_callees',
        description: 'What this symbol calls or references, transitively up to depth. Use this to understand what a function depends on without reading it and everything under it.',
        inputSchema: {
            type: 'object',
            properties: {
                symbol: SYMBOL_PROP,
                depth: { type: 'number', description: 'Hops to follow. Default 1, maximum 6.' },
                ...BUDGET_PROP,
            },
            required: ['symbol'],
        },
    },
    {
        name: 'impact_of',
        description: 'Blast radius. Everything that transitively depends on a symbol or a file, ranked by distance and grouped by file, with a count of how many results rest on a weak name match. Call this before any edit whose reach you are unsure about.',
        inputSchema: {
            type: 'object',
            properties: {
                target: { type: 'string', description: 'A symbol name, or a repo-relative file or directory path.' },
                depth: { type: 'number', description: 'Hops to follow. Default 3, maximum 6.' },
                cross_repo: { type: 'boolean', description: 'Include dependents in linked repos. Default true when links exist.' },
                ...BUDGET_PROP,
            },
            required: ['target'],
        },
    },
    {
        name: 'shortest_path',
        description: 'How two symbols are connected, hop by hop, with the relationship and confidence of each hop. Use this to answer "does A ever reach B" without tracing calls by hand.',
        inputSchema: {
            type: 'object',
            properties: { a: SYMBOL_PROP, b: SYMBOL_PROP, ...BUDGET_PROP },
            required: ['a', 'b'],
        },
    },
    {
        name: 'overview',
        description: 'Structural summary of the repo or one directory: size, symbol kinds, HTTP endpoints, the most depended on symbols, likely entry points, and a per-directory breakdown. Use this instead of reading a directory to orient yourself in unfamiliar code.',
        inputSchema: {
            type: 'object',
            properties: {
                path: { type: 'string', description: 'Repo-relative directory. Omit for the whole repo.' },
                ...BUDGET_PROP,
            },
        },
    },
    {
        name: 'changed_since',
        description: 'Symbols touched since a git ref, including uncommitted work, each with what depends on it. Use this to review the reach of a change set before finishing up.',
        inputSchema: {
            type: 'object',
            properties: {
                ref: { type: 'string', description: 'Any git ref: a branch, a tag, HEAD~3, or a commit sha.' },
                depth: { type: 'number', description: 'Hops to follow for each changed symbol. Default 2.' },
                ...BUDGET_PROP,
            },
            required: ['ref'],
        },
    },
];
//# sourceMappingURL=definitions.js.map