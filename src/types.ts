/**
 * The shared vocabulary of the graph. Everything else in the codebase speaks
 * in terms of these types, so keep them small and stable.
 */

export type NodeKind =
  | 'function'
  | 'method'
  | 'class'
  | 'interface'
  | 'struct'
  | 'module'
  | 'constant'
  | 'table'
  | 'endpoint';

export type EdgeType =
  | 'calls'
  | 'imports'
  | 'inherits'
  | 'implements'
  | 'references'
  | 'defines'
  | 'queries';

/**
 * How much to trust an edge.
 *
 *  exact      the parser saw both ends in one AST, no guessing involved
 *  resolved   name resolution linked it across files using real import evidence
 *  heuristic  a name matched and nothing contradicted it, but it could be wrong
 *
 * This distinction has to reach the agent. An agent that cannot tell these
 * apart will report a guess as a fact.
 */
export type Confidence = 'exact' | 'resolved' | 'heuristic';

export const CONFIDENCE_RANK: Record<Confidence, number> = {
  exact: 0,
  resolved: 1,
  heuristic: 2,
};

export interface GraphNode {
  /** Stable and deterministic: repo:relpath:kind:qualified */
  id: string;
  repo: string;
  path: string;
  name: string;
  qualified: string | null;
  kind: NodeKind;
  lang: string;
  lineStart: number;
  lineEnd: number;
  signature: string | null;
  doc: string | null;
  exported: boolean;
}

/** Where an edge points. Extractors only know some of these up front. */
export type EdgeTarget =
  /** Both ends were visible in the same file, so we already have the id. */
  | { kind: 'id'; id: string }
  /** A bare name, possibly with a receiver or module qualifier. */
  | { kind: 'name'; name: string; qualifier?: string | null }
  /** An import statement. `symbol` is set for named imports. */
  | { kind: 'module'; module: string; symbol?: string | null; alias?: string | null };

export interface RawEdge {
  /** Node id of whatever contains the reference. */
  from: string;
  to: EdgeTarget;
  type: EdgeType;
  line: number;
}

export interface ExtractResult {
  nodes: GraphNode[];
  edges: RawEdge[];
}

export interface FileRecord {
  path: string;
  hash: string;
  size: number;
  mtimeMs: number;
  lang: string | null;
  indexedAt: number;
}

export interface EdgeRow {
  srcId: string;
  dstId: string;
  type: EdgeType;
  confidence: Confidence;
  path: string;
  line: number;
}

/** A reference parked in the store until the resolution pass can place it. */
export interface RefRow {
  rid: number;
  srcId: string;
  path: string;
  line: number;
  type: EdgeType;
  targetKind: 'name' | 'module';
  name: string | null;
  qualifier: string | null;
  module: string | null;
  symbol: string | null;
  alias: string | null;
  lang: string;
}

export type NewRef = Omit<RefRow, 'rid'>;

export interface IndexStats {
  filesScanned: number;
  filesIndexed: number;
  filesRemoved: number;
  filesSkipped: number;
  nodes: number;
  edges: number;
  unresolvedRefs: number;
  durationMs: number;
  /** A sample of the files that failed to parse, capped for display. */
  warnings: string[];
  /** How many there really were, which is what the CLI must report. */
  warningCount: number;
}
