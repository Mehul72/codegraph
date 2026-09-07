import type { Confidence, EdgeRow, EdgeType, FileRecord, GraphNode, NewRef, NodeKind, RefRow } from '../types.js';
/**
 * The index is a cache, so a broken one is never worth troubleshooting. The
 * message says the one command that fixes it rather than leaving the user to
 * work out that deleting .codegraph is safe.
 */
export declare class CorruptIndexError extends Error {
    readonly file: string;
    constructor(file: string, cause: unknown);
}
/**
 * Every SQL statement in the project lives here. Callers deal in plain
 * objects and never see a column name.
 *
 * Statements are prepared once and cached, because a CLI invocation that runs
 * a hundred small queries should not pay to compile a hundred statements.
 */
export declare class Store {
    readonly file: string;
    private readonly db;
    private readonly prepared;
    private constructor();
    static open(file: string, options?: {
        readOnly?: boolean;
        create?: boolean;
    }): Store;
    private migrate;
    private stmt;
    /**
     * node:sqlite hands back Record<string, SQLOutputValue>. The schema is fixed
     * and lives in this file, so naming the row shape here is safe and keeps the
     * cast in exactly one place.
     */
    private queryAll;
    private queryOne;
    private exec;
    close(): void;
    /** Runs `fn` inside a transaction, rolling back if it throws. */
    transaction<T>(fn: () => T): T;
    getMeta(key: string): string | null;
    setMeta(key: string, value: string): void;
    allFiles(): FileRecord[];
    fileCount(): number;
    upsertFile(record: FileRecord): void;
    /** Drops a file and everything the file produced. */
    forgetFile(filePath: string): void;
    /** Same as forgetFile but keeps the files row, for a file being reparsed. */
    clearFileContents(filePath: string): void;
    addModulePath(filePath: string, family: string, module: string, isAlias: boolean): void;
    /** Files that answer to this exact module string, canonical matches first. */
    filesForModule(family: string, module: string): string[];
    allModulePaths(): Array<{
        path: string;
        family: string;
        module: string;
        isAlias: boolean;
    }>;
    /** Canonical module string for a file, used when labelling output. */
    moduleNameForPath(filePath: string): string | null;
    /**
     * True when this id already belongs to a node we parsed ourselves. A stub
     * from a linked repo must not land on top of one: ids are
     * repo:path:kind:qualified and the repo segment defaults to the directory
     * basename, so two checkouts that happen to share a directory name collide,
     * and the local node would be flipped to external = 1 and disappear from
     * nodeCount, nodesInFile and overview.
     */
    hasLocalNode(id: string): boolean;
    insertNode(node: GraphNode, external?: boolean): void;
    nodeCount(): number;
    getNode(id: string): GraphNode | null;
    getNodes(ids: readonly string[]): GraphNode[];
    nodesByName(name: string): GraphNode[];
    nodesByNameLower(name: string): GraphNode[];
    nodesByQualified(qualified: string): GraphNode[];
    nodesInFile(filePath: string): GraphNode[];
    nodesUnderPath(prefix: string): GraphNode[];
    allNodesLite(): Array<Pick<GraphNode, 'id' | 'name' | 'path' | 'kind' | 'lang' | 'qualified' | 'exported'>>;
    /**
     * Candidate set for fuzzy search. SQLite narrows by subsequence with LIKE so
     * the JS scorer only ever sees a few hundred rows instead of the whole table.
     */
    searchCandidates(query: string, limit: number): GraphNode[];
    kindCounts(): Array<{
        kind: NodeKind;
        count: number;
    }>;
    langCounts(): Array<{
        lang: string;
        count: number;
    }>;
    deleteOrphanExternalNodes(): number;
    insertEdge(edge: EdgeRow, rid?: number | null): void;
    edgeCount(): number;
    deleteEdgesForRefs(rids: readonly number[]): void;
    outgoing(ids: readonly string[]): EdgeRow[];
    incoming(ids: readonly string[]): EdgeRow[];
    private edgesBy;
    /**
     * How many other symbols depend on each symbol, for ranking in overview and
     * impact. `defines` is excluded: every symbol is defined by its own module,
     * so counting it would give everything a floor of one and bury the real
     * hubs. It would also make every entry point look like it has a caller.
     */
    degreeCounts(): Map<string, number>;
    edgeTypeCounts(): Array<{
        type: EdgeType;
        confidence: Confidence;
        count: number;
    }>;
    insertRef(ref: NewRef): number;
    refsInFiles(paths: readonly string[]): RefRow[];
    refsByNames(names: readonly string[]): RefRow[];
    unresolvedRefs(): RefRow[];
    unresolvedRefCount(): number;
    /** Imports declared in one file, which is what alias lookup reads. */
    importRefsInFile(filePath: string): RefRow[];
    allImportRefs(): RefRow[];
    markRefsResolved(rids: readonly number[], resolved: boolean): void;
}
