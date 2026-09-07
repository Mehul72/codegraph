import { fuzzyScore } from '../util/text.js';
/** Which kind wins when a name matches several definitions. */
const KIND_ORDER = {
    function: 0,
    method: 1,
    class: 2,
    struct: 3,
    interface: 4,
    endpoint: 5,
    table: 6,
    constant: 7,
    module: 8,
};
/**
 * Find the symbol a user or an agent meant.
 *
 * Accepts, in order of preference: a node id, a qualified name such as
 * `OrderService.create`, a fully qualified name with its module prefix, a
 * `file.py:name` pair, a bare name, and finally a fuzzy match. Anything an
 * agent is likely to type after reading a previous answer should work here,
 * because a failed lookup costs a whole extra round trip.
 */
export function lookupSymbol(store, query) {
    const trimmed = query.trim();
    if (trimmed === '')
        return { matches: [], how: 'none' };
    // Ids carry three colons and a repo prefix, so they are unmistakable.
    if (trimmed.split(':').length >= 4) {
        const node = store.getNode(trimmed);
        if (node)
            return { matches: [node], how: 'id' };
    }
    // file.py:name, which is how our own output points at things.
    const filePair = /^(.+\.[a-zA-Z]+):([A-Za-z_][\w.]*)$/.exec(trimmed);
    if (filePair) {
        const [, file, name] = filePair;
        const inFile = store.nodesInFile(file).filter((n) => n.name === name || n.qualified === name);
        if (inFile.length > 0)
            return { matches: sortMatches(inFile), how: 'in-file' };
    }
    const byQualified = store.nodesByQualified(trimmed);
    if (byQualified.length > 0)
        return { matches: sortMatches(byQualified), how: 'qualified' };
    const byName = store.nodesByName(trimmed);
    if (byName.length > 0)
        return { matches: sortMatches(byName), how: 'name' };
    // A dotted query may carry a module prefix we should peel off, so
    // `orders.service.OrderService.create` finds `OrderService.create`.
    if (trimmed.includes('.')) {
        const parts = trimmed.split('.');
        for (let i = 1; i < parts.length; i++) {
            const tail = parts.slice(i).join('.');
            const prefix = parts.slice(0, i).join('.');
            const candidates = [...store.nodesByQualified(tail), ...store.nodesByName(tail)].filter((node) => moduleMatches(store, node.path, prefix));
            if (candidates.length > 0)
                return { matches: sortMatches(dedupeById(candidates)), how: 'qualified' };
        }
        const last = parts[parts.length - 1];
        const byLast = store.nodesByName(last);
        if (byLast.length > 0)
            return { matches: sortMatches(byLast), how: 'name' };
    }
    const insensitive = store.nodesByNameLower(trimmed);
    if (insensitive.length > 0)
        return { matches: sortMatches(insensitive), how: 'name' };
    const fuzzy = fuzzySearch(store, trimmed, 12);
    return fuzzy.length > 0 ? { matches: fuzzy, how: 'fuzzy' } : { matches: [], how: 'none' };
}
function moduleMatches(store, filePath, prefix) {
    const module = store.moduleNameForPath(filePath);
    if (!module)
        return false;
    return module === prefix || module.endsWith(`.${prefix}`) || module.endsWith(`/${prefix}`) || module.includes(prefix);
}
/** Fuzzy symbol search, scored in JS after SQLite narrows the candidates. */
export function fuzzySearch(store, query, limit, filters = {}) {
    const pool = store.searchCandidates(query, Math.max(limit * 30, 400));
    const scored = [];
    for (const node of pool) {
        if (filters.kind && node.kind !== filters.kind)
            continue;
        if (filters.lang && node.lang !== filters.lang)
            continue;
        const score = fuzzyScore(query, node.name);
        if (score === null)
            continue;
        scored.push({ node, score: score + KIND_ORDER[node.kind] * 0.01 + (node.exported ? 0 : 0.5) });
    }
    scored.sort((a, b) => a.score - b.score || compareLocation(a.node, b.node));
    return scored.slice(0, limit).map((s) => s.node);
}
export function sortMatches(nodes) {
    return [...nodes].sort((a, b) => {
        if (a.exported !== b.exported)
            return a.exported ? -1 : 1;
        const byKind = KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
        if (byKind !== 0)
            return byKind;
        return compareLocation(a, b);
    });
}
function compareLocation(a, b) {
    if (a.path !== b.path)
        return a.path < b.path ? -1 : 1;
    return a.lineStart - b.lineStart;
}
function dedupeById(nodes) {
    const seen = new Set();
    const out = [];
    for (const node of nodes) {
        if (seen.has(node.id))
            continue;
        seen.add(node.id);
        out.push(node);
    }
    return out;
}
//# sourceMappingURL=lookup.js.map