import type { CodegraphConfig } from '../config/config.js';
import type { Store } from '../store/store.js';
import type { IndexStats } from '../types.js';
import { ParserPool } from '../extract/parser.js';
import { type LinkedRepo } from '../resolve/crossrepo.js';
import type { RepoFacts } from '../resolve/modules.js';
export interface IndexOptions {
    repoRoot: string;
    config: CodegraphConfig;
    store: Store;
    /** Reparse everything, ignoring the content hash cache. */
    force?: boolean;
    /** Limit the walk to these repo-relative paths. */
    only?: readonly string[];
    /** Show a progress line on stderr. */
    progress?: boolean;
    /** Reuse an already-built parser pool and set of linked repos. */
    pool?: ParserPool;
    links?: readonly LinkedRepo[];
}
export declare function runIndex(options: IndexOptions): Promise<IndexStats>;
export declare function repoFacts(repoRoot: string): RepoFacts;
