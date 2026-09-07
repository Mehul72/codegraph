import type { EdgeTarget, EdgeType, ExtractResult, GraphNode, NodeKind } from '../types.js';
export interface SymbolSpec {
    name: string;
    kind: NodeKind;
    lineStart: number;
    lineEnd: number;
    qualified?: string | null;
    signature?: string | null;
    doc?: string | null;
    exported?: boolean;
}
/**
 * Collects nodes and edges for one file and hands out ids. Extractors talk to
 * this instead of building GraphNode objects by hand, which keeps id format
 * and duplicate handling in one place.
 */
export declare class SymbolBuilder {
    private readonly repo;
    private readonly path;
    private readonly lang;
    private readonly nodes;
    private readonly edges;
    private readonly usedIds;
    constructor(repo: string, path: string, lang: string);
    /**
     * The file itself, as a module node. Every file gets one so that
     * impact_of(file) and overview have something to hang off, and so imports
     * have a source even when they sit at the top level.
     */
    module(spec: {
        name: string;
        qualified?: string | null;
        lineEnd: number;
        doc?: string | null;
    }): GraphNode;
    add(spec: SymbolSpec): GraphNode;
    edge(from: GraphNode | string, to: EdgeTarget, type: EdgeType, line: number): void;
    /** Shorthand for the common "this symbol references that bare name" case. */
    ref(from: GraphNode | string, type: EdgeType, name: string, line: number, qualifier?: string | null): void;
    importEdge(from: GraphNode | string, module: string, line: number, opts?: {
        symbol?: string | null;
        alias?: string | null;
    }): void;
    result(): ExtractResult;
    /**
     * Ids must be deterministic and unique. Overloads, conditional definitions
     * and re-declared names all collide, so the second one onward gets a
     * positional suffix rather than silently overwriting the first.
     */
    private uniqueId;
}
export declare function emptyResult(): ExtractResult;
