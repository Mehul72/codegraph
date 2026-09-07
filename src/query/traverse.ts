import type { EdgeRow, EdgeType } from '../types.js';
import { CONFIDENCE_RANK } from '../types.js';
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
export const CALL_TYPES: readonly EdgeType[] = ['calls', 'references', 'queries'];

/** Everything that can propagate a change, used by impact_of. */
export const IMPACT_TYPES: readonly EdgeType[] = [
  'calls',
  'references',
  'imports',
  'inherits',
  'implements',
  'queries',
];

const DEFAULT_MAX_NODES = 2000;

/**
 * Breadth-first walk over the graph, one level at a time so each level is a
 * single batched query rather than one query per node.
 */
export function traverse(options: TraverseOptions): Reached[] {
  const { store, roots, direction, depth } = options;
  const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
  const allowed = options.types ? new Set(options.types) : null;

  const seen = new Set<string>(roots);
  const reached: Reached[] = [];
  let frontier = [...roots];

  for (let level = 1; level <= depth && frontier.length > 0 && reached.length < maxNodes; level++) {
    const edges = direction === 'in' ? store.incoming(frontier) : store.outgoing(frontier);
    const next: string[] = [];

    // Sort so the output is stable and the best evidence lands first.
    edges.sort(compareEdges);

    for (const edge of edges) {
      if (allowed && !allowed.has(edge.type)) continue;
      const other = direction === 'in' ? edge.srcId : edge.dstId;
      if (seen.has(other)) continue;
      seen.add(other);
      reached.push({ id: other, distance: level, via: edge });
      next.push(other);
      if (reached.length >= maxNodes) break;
    }
    frontier = next;
  }

  return reached;
}

export function compareEdges(a: EdgeRow, b: EdgeRow): number {
  const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
  if (byConfidence !== 0) return byConfidence;
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  if (a.line !== b.line) return a.line - b.line;
  return a.dstId < b.dstId ? -1 : a.dstId > b.dstId ? 1 : 0;
}

/**
 * Shortest path between two nodes, following edges in either direction.
 * Undirected on purpose: "how do A and B connect" is rarely a question about
 * call direction, and an answer of "they do not" when a path exists backwards
 * would be unhelpful.
 */
export function shortestPath(store: Store, fromId: string, toId: string, maxDepth = 8): EdgeRow[] | null {
  if (fromId === toId) return [];

  const cameFrom = new Map<string, { prev: string; edge: EdgeRow }>();
  const seen = new Set<string>([fromId]);
  let frontier = [fromId];

  for (let level = 0; level < maxDepth && frontier.length > 0; level++) {
    const out = store.outgoing(frontier);
    const back = store.incoming(frontier);
    const steps: Array<{ from: string; to: string; edge: EdgeRow }> = [];

    for (const edge of out) steps.push({ from: edge.srcId, to: edge.dstId, edge });
    for (const edge of back) steps.push({ from: edge.dstId, to: edge.srcId, edge });
    steps.sort((a, b) => compareEdges(a.edge, b.edge));

    const next: string[] = [];
    for (const step of steps) {
      if (seen.has(step.to)) continue;
      seen.add(step.to);
      cameFrom.set(step.to, { prev: step.from, edge: step.edge });
      if (step.to === toId) return rebuild(cameFrom, fromId, toId);
      next.push(step.to);
    }
    frontier = next;
  }
  return null;
}

function rebuild(cameFrom: Map<string, { prev: string; edge: EdgeRow }>, fromId: string, toId: string): EdgeRow[] {
  const path: EdgeRow[] = [];
  let cursor = toId;
  while (cursor !== fromId) {
    const step = cameFrom.get(cursor);
    if (!step) break;
    path.unshift(step.edge);
    cursor = step.prev;
  }
  return path;
}
