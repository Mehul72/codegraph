import { CONFIDENCE_RANK } from '../types.js';
/** Edge types that answer "who calls this" in either direction. */
export const CALL_TYPES = ['calls', 'references', 'queries'];
/** Everything that can propagate a change, used by impact_of. */
export const IMPACT_TYPES = [
    'calls',
    'references',
    'imports',
    'inherits',
    'implements',
    'queries',
];
const DEFAULT_MAX_NODES = 2000;
/**
 * A far looser ceiling for shortest_path, because here the cap is a safety
 * net rather than a budget: stopping early turns a real connection into "no
 * path", which is a wrong answer, not a short one. It exists only so that an
 * undirected walk through a hub cannot build and sort an unbounded step list.
 */
const PATH_MAX_NODES = 20_000;
/**
 * Breadth-first walk over the graph, one level at a time so each level is a
 * single batched query rather than one query per node.
 */
export function traverse(options) {
    const { store, roots, direction, depth } = options;
    const maxNodes = options.maxNodes ?? DEFAULT_MAX_NODES;
    const allowed = options.types ? new Set(options.types) : null;
    const seen = new Set(roots);
    const reached = [];
    let frontier = [...roots];
    for (let level = 1; level <= depth && frontier.length > 0 && reached.length < maxNodes; level++) {
        const edges = direction === 'in' ? store.incoming(frontier) : store.outgoing(frontier);
        const next = [];
        // Sort so the output is stable and the best evidence lands first.
        edges.sort(compareEdges);
        for (const edge of edges) {
            if (allowed && !allowed.has(edge.type))
                continue;
            const other = direction === 'in' ? edge.srcId : edge.dstId;
            if (seen.has(other))
                continue;
            seen.add(other);
            reached.push({ id: other, distance: level, via: edge });
            next.push(other);
            if (reached.length >= maxNodes)
                break;
        }
        frontier = next;
    }
    return reached;
}
export function compareEdges(a, b) {
    const byConfidence = CONFIDENCE_RANK[a.confidence] - CONFIDENCE_RANK[b.confidence];
    if (byConfidence !== 0)
        return byConfidence;
    if (a.path !== b.path)
        return a.path < b.path ? -1 : 1;
    if (a.line !== b.line)
        return a.line - b.line;
    return a.dstId < b.dstId ? -1 : a.dstId > b.dstId ? 1 : 0;
}
/**
 * Shortest path between two nodes, following edges in either direction.
 * Undirected on purpose: "how do A and B connect" is rarely a question about
 * call direction, and an answer of "they do not" when a path exists backwards
 * would be unhelpful.
 */
export function shortestPath(store, fromId, toId, maxDepth = 8, maxNodes = PATH_MAX_NODES) {
    if (fromId === toId)
        return [];
    const cameFrom = new Map();
    const seen = new Set([fromId]);
    let frontier = [fromId];
    // Undirected search through a hub fans out in both directions at once, so
    // this is the query most able to run away, and it was the one with no
    // ceiling at all.
    for (let level = 0; level < maxDepth && frontier.length > 0 && seen.size < maxNodes; level++) {
        const out = store.outgoing(frontier);
        const back = store.incoming(frontier);
        const steps = [];
        for (const edge of out)
            steps.push({ from: edge.srcId, to: edge.dstId, edge });
        for (const edge of back)
            steps.push({ from: edge.dstId, to: edge.srcId, edge });
        steps.sort((a, b) => compareEdges(a.edge, b.edge));
        const next = [];
        for (const step of steps) {
            if (seen.has(step.to))
                continue;
            seen.add(step.to);
            cameFrom.set(step.to, { prev: step.from, edge: step.edge });
            if (step.to === toId)
                return rebuild(cameFrom, fromId, toId);
            next.push(step.to);
            if (seen.size >= maxNodes)
                break;
        }
        frontier = next;
    }
    return null;
}
function rebuild(cameFrom, fromId, toId) {
    const path = [];
    let cursor = toId;
    while (cursor !== fromId) {
        const step = cameFrom.get(cursor);
        if (!step)
            break;
        path.unshift(step.edge);
        cursor = step.prev;
    }
    return path;
}
//# sourceMappingURL=traverse.js.map