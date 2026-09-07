import type { EdgeRow, EdgeType } from '../types.js';
import type { Store } from '../store/store.js';
export interface TraverseOptions {
    store: Store;
    roots: readonly string[];
    direction: 'in' | 'out';
    depth: number;
    /** Only follow these edge types. Undefined follows everything. */
    types?: readonly EdgeType[];
    /** Stop after this many distinct nodes, so a hub cannot run away with us. */
    maxNodes?: number;
}
export interface Reached {
    id: string;
    distance: number;
    /** The edge that first got us here, which is what output explains. */
    via: EdgeRow;
}
/** Edge types that answer "who calls this" in either direction. */
export declare const CALL_TYPES: readonly EdgeType[];
/** Everything that can propagate a change, used by impact_of. */
export declare const IMPACT_TYPES: readonly EdgeType[];
/**
 * Breadth-first walk over the graph, one level at a time so each level is a
 * single batched query rather than one query per node.
 */
export declare function traverse(options: TraverseOptions): Reached[];
export declare function compareEdges(a: EdgeRow, b: EdgeRow): number;
/**
 * Shortest path between two nodes, following edges in either direction.
 * Undirected on purpose: "how do A and B connect" is rarely a question about
 * call direction, and an answer of "they do not" when a path exists backwards
 * would be unhelpful.
 */
export declare function shortestPath(store: Store, fromId: string, toId: string, maxDepth?: number, maxNodes?: number): EdgeRow[] | null;
