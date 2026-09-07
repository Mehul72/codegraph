export interface CodegraphConfig {
    /** Bumped only when the on-disk shape changes in a breaking way. */
    version: number;
    /** Short repo identifier used as the first segment of every node id. */
    repo: string;
    /** Extractor ids to run. Empty array means "everything we detect". */
    languages: string[];
    /** Extra ignore globs on top of .gitignore and .codegraphignore. */
    ignore: string[];
    /** Files larger than this are recorded but not parsed. */
    maxFileBytes: number;
    /** Default output budget in tokens for CLI and MCP answers. */
    defaultBudget: number;
    /**
     * How many same-name candidates we are willing to guess between when there
     * is no import evidence. Above this we emit nothing, because a dozen
     * heuristic edges for a name like `get` is noise, not information.
     */
    maxHeuristicCandidates: number;
    /** Absolute paths of other indexed repos to resolve against. */
    links: string[];
}
export declare const DEFAULT_CONFIG: Omit<CodegraphConfig, 'repo'>;
export declare function defaultRepoName(repoRoot: string): string;
export declare function makeDefaultConfig(repoRoot: string, languages?: string[]): CodegraphConfig;
/**
 * Load the config, filling in anything missing. A partly hand-edited or
 * outdated config should still work rather than blowing up a query.
 */
export declare function loadConfig(repoRoot: string): Promise<CodegraphConfig>;
export declare function normalizeConfig(raw: unknown, repoRoot: string): CodegraphConfig;
export declare function saveConfig(repoRoot: string, config: CodegraphConfig): Promise<void>;
