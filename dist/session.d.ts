import { type CodegraphConfig } from './config/config.js';
import { Store } from './store/store.js';
import { ParserPool } from './extract/parser.js';
import { type LinkedRepo } from './resolve/crossrepo.js';
import type { RepoFacts } from './resolve/modules.js';
import type { IndexStats } from './types.js';
export declare class NoIndexError extends Error {
    readonly repoRoot: string;
    constructor(repoRoot: string);
}
/**
 * One open repo: config, database, parsers and linked repos. The CLI builds
 * one per invocation and the MCP server keeps a single one for its lifetime.
 */
export declare class Session {
    readonly repoRoot: string;
    readonly config: CodegraphConfig;
    readonly store: Store;
    readonly pool: ParserPool;
    readonly links: LinkedRepo[];
    readonly facts: RepoFacts;
    private lastFreshnessCheck;
    private freshnessInFlight;
    private constructor();
    static open(options?: {
        cwd?: string;
        requireIndex?: boolean;
    }): Promise<Session>;
    /**
     * Bring the index up to date before answering. This is the mechanism that
     * makes edits during an agent session visible to the next query, and it has
     * to be cheap enough to run on every single call: the common case is a walk
     * plus a stat per file and no parsing at all.
     *
     * Debounced, because agents fire several queries in a row and rescanning for
     * each one is wasted work.
     */
    ensureFresh(options?: {
        debounceMs?: number;
    }): Promise<IndexStats | null>;
    /**
     * Reindex specific files, for the agent hook path.
     *
     * Paths outside the repo are dropped rather than rejected. Hooks pass along
     * whatever the agent touched, which sometimes includes a scratch file in a
     * temp directory, and indexing that into this repo's graph would be worse
     * than doing nothing.
     */
    touch(files: readonly string[]): Promise<IndexStats>;
    indexedAt(): Date | null;
    close(): void;
}
