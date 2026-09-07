/**
 * Collects nodes and edges for one file and hands out ids. Extractors talk to
 * this instead of building GraphNode objects by hand, which keeps id format
 * and duplicate handling in one place.
 */
export class SymbolBuilder {
    repo;
    path;
    lang;
    nodes = [];
    edges = [];
    usedIds = new Set();
    constructor(repo, path, lang) {
        this.repo = repo;
        this.path = path;
        this.lang = lang;
    }
    /**
     * The file itself, as a module node. Every file gets one so that
     * impact_of(file) and overview have something to hang off, and so imports
     * have a source even when they sit at the top level.
     */
    module(spec) {
        return this.add({
            name: spec.name,
            kind: 'module',
            qualified: spec.qualified ?? spec.name,
            lineStart: 1,
            lineEnd: spec.lineEnd,
            doc: spec.doc ?? null,
            signature: null,
            exported: true,
        });
    }
    add(spec) {
        const qualified = spec.qualified ?? spec.name;
        const node = {
            id: this.uniqueId(spec.kind, qualified),
            repo: this.repo,
            path: this.path,
            name: spec.name,
            qualified,
            kind: spec.kind,
            lang: this.lang,
            lineStart: spec.lineStart,
            lineEnd: Math.max(spec.lineEnd, spec.lineStart),
            signature: spec.signature ?? null,
            doc: spec.doc ?? null,
            exported: spec.exported ?? true,
        };
        this.nodes.push(node);
        return node;
    }
    edge(from, to, type, line) {
        this.edges.push({ from: typeof from === 'string' ? from : from.id, to, type, line });
    }
    /** Shorthand for the common "this symbol references that bare name" case. */
    ref(from, type, name, line, qualifier = null) {
        if (name === '')
            return;
        this.edge(from, { kind: 'name', name, qualifier }, type, line);
    }
    importEdge(from, module, line, opts = {}) {
        if (module === '')
            return;
        this.edge(from, { kind: 'module', module, symbol: opts.symbol ?? null, alias: opts.alias ?? null }, 'imports', line);
    }
    result() {
        return { nodes: this.nodes, edges: this.edges };
    }
    /**
     * Ids must be deterministic and unique. Overloads, conditional definitions
     * and re-declared names all collide, so the second one onward gets a
     * positional suffix rather than silently overwriting the first.
     */
    uniqueId(kind, qualified) {
        const base = `${this.repo}:${this.path}:${kind}:${qualified}`;
        if (!this.usedIds.has(base)) {
            this.usedIds.add(base);
            return base;
        }
        for (let n = 2;; n++) {
            const candidate = `${base}#${n}`;
            if (!this.usedIds.has(candidate)) {
                this.usedIds.add(candidate);
                return candidate;
            }
        }
    }
}
export function emptyResult() {
    return { nodes: [], edges: [] };
}
//# sourceMappingURL=builder.js.map