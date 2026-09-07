import { Parser, type Tree } from 'web-tree-sitter';
/** grammars/ sits next to src/ in the repo and next to dist/ in the package. */
export declare function grammarDir(): string;
export declare class MissingGrammarError extends Error {
    readonly grammar: string;
    constructor(grammar: string);
}
/**
 * Loads grammars on demand and keeps one parser per grammar. A Python-only
 * repo never pays to load the Java grammar, which is the whole point of
 * doing this lazily.
 */
export declare class ParserPool {
    private static runtimeReady;
    private readonly languages;
    /**
     * Keyed on the promise, not the finished parser. Two callers that miss a
     * half-built entry would both build one, and the loser was dropped on the
     * floor still holding its wasm instance, which dispose() then never freed.
     */
    private readonly parsers;
    private readonly broken;
    static initRuntime(): Promise<void>;
    /** Returns null when the grammar is missing or refuses to load. */
    parserFor(grammar: string): Promise<Parser | null>;
    private build;
    /**
     * Parse one file. Returns null when the grammar is unavailable, and a tree
     * even when it contains errors: tree-sitter recovers well enough that a file
     * with one syntax error still yields most of its symbols.
     */
    parse(grammar: string, source: string): Promise<Tree | null>;
    dispose(): void;
    availableGrammars(): string[];
}
