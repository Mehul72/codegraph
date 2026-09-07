import type { RefRow } from '../types.js';
import type { Store } from '../store/store.js';
import type { CodegraphConfig } from '../config/config.js';
import { type RepoFacts } from './modules.js';
import { type LinkedRepo } from './crossrepo.js';
export interface ResolveInput {
    store: Store;
    config: CodegraphConfig;
    facts: RepoFacts;
    links: readonly LinkedRepo[];
    /** The refs to place. Everything else already in the table is left alone. */
    refs: readonly RefRow[];
}
export interface ResolveOutcome {
    edges: number;
    resolved: number;
    unresolved: number;
    externalNodes: number;
}
/**
 * Turn parked references into edges.
 *
 * This pass is where the tool earns its keep. Extraction is mechanical; the
 * judgement lives here, in deciding when a name match counts as evidence and
 * when it is a coin flip. The strategies below run strongest evidence first
 * and the first hit wins.
 *
 * One invariant matters more than any single strategy: resolving a ref must
 * depend only on the ref, its file's imports, and the current set of
 * definitions. Nothing may depend on the order refs are processed in, because
 * an incremental pass reprocesses a different subset than a cold index and the
 * two have to agree.
 */
export declare function resolveRefs(input: ResolveInput): ResolveOutcome;
