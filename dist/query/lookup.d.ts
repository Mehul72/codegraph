import type { GraphNode } from '../types.js';
import type { Store } from '../store/store.js';
export type LookupKind = 'id' | 'qualified' | 'name' | 'in-file' | 'fuzzy' | 'none';
export interface SymbolLookup {
    matches: GraphNode[];
    how: LookupKind;
}
/**
 * Find the symbol a user or an agent meant.
 *
 * Accepts, in order of preference: a node id, a qualified name such as
 * `OrderService.create`, a fully qualified name with its module prefix, a
 * `file.py:name` pair, a bare name, and finally a fuzzy match. Anything an
 * agent is likely to type after reading a previous answer should work here,
 * because a failed lookup costs a whole extra round trip.
 */
export declare function lookupSymbol(store: Store, query: string): SymbolLookup;
export interface SearchFilters {
    kind?: string;
    lang?: string;
    limit?: number;
}
/** Fuzzy symbol search, scored in JS after SQLite narrows the candidates. */
export declare function fuzzySearch(store: Store, query: string, limit: number, filters?: SearchFilters): GraphNode[];
export declare function sortMatches(nodes: readonly GraphNode[]): GraphNode[];
