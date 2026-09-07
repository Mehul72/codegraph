import type { NodeKind } from '../types.js';
import type { Store } from '../store/store.js';
/** The slice of a node that resolution actually reads. */
export interface DefNode {
    id: string;
    name: string;
    path: string;
    kind: NodeKind;
    qualified: string | null;
    exported: boolean;
}
export interface DefinitionIndex {
    byId(id: string): DefNode | null;
    byName(name: string): DefNode[];
    inFile(filePath: string): DefNode[];
    moduleNodeOf(filePath: string): DefNode | null;
}
/**
 * Two strategies, same interface. A cold index resolves millions of refs and
 * wants everything in memory once; a warm reindex touches a handful and wants
 * indexed lookups. Picking the wrong one is the difference between a 2 second
 * warm pass and a 200ms one.
 */
export declare function buildDefinitionIndex(store: Store, refCount: number): DefinitionIndex;
export declare function preferBest(candidates: readonly DefNode[]): DefNode | null;
