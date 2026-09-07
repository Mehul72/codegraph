/**
 * Two strategies, same interface. A cold index resolves millions of refs and
 * wants everything in memory once; a warm reindex touches a handful and wants
 * indexed lookups. Picking the wrong one is the difference between a 2 second
 * warm pass and a 200ms one.
 */
export function buildDefinitionIndex(store, refCount) {
    return refCount > BULK_THRESHOLD ? new BulkIndex(store) : new LazyIndex(store);
}
/** Roughly where per-name SQL lookups stop being cheaper than one big scan. */
const BULK_THRESHOLD = 4000;
class BulkIndex {
    ids = new Map();
    names = new Map();
    files = new Map();
    modules = new Map();
    constructor(store) {
        for (const node of store.allNodesLite()) {
            this.ids.set(node.id, node);
            push(this.names, node.name, node);
            push(this.files, node.path, node);
            if (node.kind === 'module' && !this.modules.has(node.path))
                this.modules.set(node.path, node);
        }
        for (const list of this.files.values()) {
            list.sort(byPathThenId);
        }
        for (const list of this.names.values()) {
            list.sort(byPathThenId);
        }
    }
    byId(id) {
        return this.ids.get(id) ?? null;
    }
    byName(name) {
        return this.names.get(name) ?? [];
    }
    inFile(filePath) {
        return this.files.get(filePath) ?? [];
    }
    moduleNodeOf(filePath) {
        return this.modules.get(filePath) ?? null;
    }
}
class LazyIndex {
    store;
    idCache = new Map();
    nameCache = new Map();
    fileCache = new Map();
    constructor(store) {
        this.store = store;
    }
    byId(id) {
        if (this.idCache.has(id))
            return this.idCache.get(id) ?? null;
        const node = this.store.getNode(id);
        const def = node ? toDef(node) : null;
        this.idCache.set(id, def);
        return def;
    }
    byName(name) {
        let cached = this.nameCache.get(name);
        if (!cached) {
            cached = this.store.nodesByName(name).map(toDef).sort(byPathThenId);
            this.nameCache.set(name, cached);
        }
        return cached;
    }
    inFile(filePath) {
        let cached = this.fileCache.get(filePath);
        if (!cached) {
            cached = this.store.nodesInFile(filePath).map(toDef).sort(byPathThenId);
            this.fileCache.set(filePath, cached);
        }
        return cached;
    }
    moduleNodeOf(filePath) {
        return this.inFile(filePath).find((n) => n.kind === 'module') ?? null;
    }
}
function toDef(node) {
    return {
        id: node.id,
        name: node.name,
        path: node.path,
        kind: node.kind,
        qualified: node.qualified,
        exported: node.exported,
    };
}
function push(map, key, value) {
    const existing = map.get(key);
    if (existing)
        existing.push(value);
    else
        map.set(key, [value]);
}
/** Stable ordering so two runs over the same tree produce the same edges. */
function byPathThenId(a, b) {
    if (a.path !== b.path)
        return a.path < b.path ? -1 : 1;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}
/**
 * When several definitions share a name, this is the order we trust them in.
 * A module node is almost never what a call meant, so it goes last.
 */
const KIND_PRIORITY = {
    function: 0,
    method: 1,
    class: 2,
    struct: 3,
    interface: 4,
    constant: 5,
    table: 6,
    endpoint: 7,
    module: 8,
};
export function preferBest(candidates) {
    if (candidates.length === 0)
        return null;
    let best = candidates[0];
    for (const candidate of candidates.slice(1)) {
        const better = KIND_PRIORITY[candidate.kind] < KIND_PRIORITY[best.kind] ||
            (KIND_PRIORITY[candidate.kind] === KIND_PRIORITY[best.kind] && candidate.exported && !best.exported);
        if (better)
            best = candidate;
    }
    return best;
}
//# sourceMappingURL=definitions.js.map