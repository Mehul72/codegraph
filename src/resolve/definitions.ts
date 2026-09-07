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
export function buildDefinitionIndex(store: Store, refCount: number): DefinitionIndex {
  return refCount > BULK_THRESHOLD ? new BulkIndex(store) : new LazyIndex(store);
}

/** Roughly where per-name SQL lookups stop being cheaper than one big scan. */
const BULK_THRESHOLD = 4000;

class BulkIndex implements DefinitionIndex {
  private readonly ids = new Map<string, DefNode>();
  private readonly names = new Map<string, DefNode[]>();
  private readonly files = new Map<string, DefNode[]>();
  private readonly modules = new Map<string, DefNode>();

  constructor(store: Store) {
    for (const node of store.allNodesLite()) {
      this.ids.set(node.id, node);
      push(this.names, node.name, node);
      push(this.files, node.path, node);
      if (node.kind === 'module' && !this.modules.has(node.path)) this.modules.set(node.path, node);
    }
    for (const list of this.files.values()) {
      list.sort(byPathThenId);
    }
    for (const list of this.names.values()) {
      list.sort(byPathThenId);
    }
  }

  byId(id: string): DefNode | null {
    return this.ids.get(id) ?? null;
  }

  byName(name: string): DefNode[] {
    return this.names.get(name) ?? [];
  }

  inFile(filePath: string): DefNode[] {
    return this.files.get(filePath) ?? [];
  }

  moduleNodeOf(filePath: string): DefNode | null {
    return this.modules.get(filePath) ?? null;
  }
}

class LazyIndex implements DefinitionIndex {
  private readonly idCache = new Map<string, DefNode | null>();
  private readonly nameCache = new Map<string, DefNode[]>();
  private readonly fileCache = new Map<string, DefNode[]>();

  constructor(private readonly store: Store) {}

  byId(id: string): DefNode | null {
    if (this.idCache.has(id)) return this.idCache.get(id) ?? null;
    const node = this.store.getNode(id);
    const def = node ? toDef(node) : null;
    this.idCache.set(id, def);
    return def;
  }

  byName(name: string): DefNode[] {
    let cached = this.nameCache.get(name);
    if (!cached) {
      cached = this.store.nodesByName(name).map(toDef).sort(byPathThenId);
      this.nameCache.set(name, cached);
    }
    return cached;
  }

  inFile(filePath: string): DefNode[] {
    let cached = this.fileCache.get(filePath);
    if (!cached) {
      cached = this.store.nodesInFile(filePath).map(toDef).sort(byPathThenId);
      this.fileCache.set(filePath, cached);
    }
    return cached;
  }

  moduleNodeOf(filePath: string): DefNode | null {
    return this.inFile(filePath).find((n) => n.kind === 'module') ?? null;
  }
}

function toDef(node: {
  id: string;
  name: string;
  path: string;
  kind: NodeKind;
  qualified: string | null;
  exported: boolean;
}): DefNode {
  return {
    id: node.id,
    name: node.name,
    path: node.path,
    kind: node.kind,
    qualified: node.qualified,
    exported: node.exported,
  };
}

function push<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/** Stable ordering so two runs over the same tree produce the same edges. */
function byPathThenId(a: DefNode, b: DefNode): number {
  if (a.path !== b.path) return a.path < b.path ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * When several definitions share a name, this is the order we trust them in.
 * A module node is almost never what a call meant, so it goes last.
 */
const KIND_PRIORITY: Record<NodeKind, number> = {
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

export function preferBest(candidates: readonly DefNode[]): DefNode | null {
  if (candidates.length === 0) return null;
  let best = candidates[0] as DefNode;
  for (const candidate of candidates.slice(1)) {
    const better =
      KIND_PRIORITY[candidate.kind] < KIND_PRIORITY[best.kind] ||
      (KIND_PRIORITY[candidate.kind] === KIND_PRIORITY[best.kind] && candidate.exported && !best.exported);
    if (better) best = candidate;
  }
  return best;
}
