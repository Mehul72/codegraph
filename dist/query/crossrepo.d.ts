import type { EdgeRow, GraphNode } from '../types.js';
export interface ForeignEdge {
    repo: string;
    node: GraphNode;
    edge: EdgeRow;
}
/**
 * Callers that live in other repos.
 *
 * When repo B links to repo A, B's index holds edges whose destination is A's
 * node id, plus a stub copy of the A node. So finding A's outside callers is a
 * matter of asking every other registered repo for inbound edges on the same
 * id. Ids are deterministic, which is what makes this work without a shared
 * database.
 */
export declare function foreignCallers(selfRoot: string, ids: readonly string[]): Promise<ForeignEdge[]>;
