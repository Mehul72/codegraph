import type { Confidence, EdgeRow, GraphNode, RefRow } from '../types.js';
import type { Store } from '../store/store.js';
import type { CodegraphConfig } from '../config/config.js';
import { familyOf } from '../extract/registry.js';
import { buildDefinitionIndex, preferBest, type DefinitionIndex, type DefNode } from './definitions.js';
import { isDefinitelyExternal, moduleCandidates, submoduleOf, type RepoFacts } from './modules.js';
import {
  resolveImportAcrossRepos,
  resolveMemberAcrossRepos,
  resolveNameAcrossRepos,
  resolveQualifiedAcrossRepos,
  type LinkedRepo,
} from './crossrepo.js';

/** Receivers that mean "the type I am currently inside of". */
const SELF_RECEIVERS = new Set(['self', 'this', 'cls']);

export interface ResolveInput {
  store: Store;
  config: CodegraphConfig;
  facts: RepoFacts;
  links: readonly LinkedRepo[];
  /** The refs to place. Everything else already in the table is left alone. */
  refs: readonly RefRow[];
}

export interface ResolveOutcome {
  edges: number;
  resolved: number;
  unresolved: number;
  externalNodes: number;
}

/**
 * Turn parked references into edges.
 *
 * This pass is where the tool earns its keep. Extraction is mechanical; the
 * judgement lives here, in deciding when a name match counts as evidence and
 * when it is a coin flip. The strategies below run strongest evidence first
 * and the first hit wins.
 *
 * One invariant matters more than any single strategy: resolving a ref must
 * depend only on the ref, its file's imports, and the current set of
 * definitions. Nothing may depend on the order refs are processed in, because
 * an incremental pass reprocesses a different subset than a cold index and the
 * two have to agree.
 */
export function resolveRefs(input: ResolveInput): ResolveOutcome {
  const { store, config, facts, links, refs } = input;
  if (refs.length === 0) return { edges: 0, resolved: 0, unresolved: 0, externalNodes: 0 };

  const index = buildDefinitionIndex(store, refs.length);
  const imports = new ImportTable(store, refs.length);
  const resolver = new Resolver(store, config, facts, links, index, imports);

  // Inheritance before ordinary references, so that member lookups can walk up
  // to a base class that was resolved in this same pass.
  const ordered = [...refs].sort((a, b) => phase(a) - phase(b) || a.rid - b.rid);
  for (const ref of ordered) {
    resolver.place(ref);
  }
  return resolver.finish();
}

function phase(ref: RefRow): number {
  if (ref.type === 'inherits' || ref.type === 'implements') return 0;
  return 1;
}

class Resolver {
  private edgeCount = 0;
  private readonly resolvedRids: number[] = [];
  private readonly unresolvedRids: number[] = [];
  private readonly externalIds = new Set<string>();
  private readonly aliasCache = new Map<string, Map<string, DefNode | null>>();
  private readonly importTargetCache = new Map<number, DefNode | null>();
  private readonly importedFilesCache = new Map<string, Set<string>>();
  /**
   * Which linked repo each adopted stub came from. Members of a foreign
   * module have to be looked up in that repo's index, since ours holds only
   * the one symbol the import named.
   */
  private readonly foreignOwners = new Map<string, LinkedRepo>();

  constructor(
    private readonly store: Store,
    private readonly config: CodegraphConfig,
    private readonly facts: RepoFacts,
    private readonly links: readonly LinkedRepo[],
    private readonly index: DefinitionIndex,
    private readonly imports: ImportTable,
  ) {}

  place(ref: RefRow): void {
    const targets = ref.targetKind === 'module' ? this.placeImport(ref) : this.placeName(ref);

    let wrote = 0;
    for (const { node, confidence } of targets) {
      if (node.id === ref.srcId) continue; // recursion is not a useful edge
      this.write(
        { srcId: ref.srcId, dstId: node.id, type: ref.type, confidence, path: ref.path, line: ref.line },
        ref.rid,
      );
      wrote++;
    }
    if (wrote > 0) this.resolvedRids.push(ref.rid);
    else this.unresolvedRids.push(ref.rid);
  }

  finish(): ResolveOutcome {
    if (this.resolvedRids.length > 0) this.store.markRefsResolved(this.resolvedRids, true);
    if (this.unresolvedRids.length > 0) this.store.markRefsResolved(this.unresolvedRids, false);
    return {
      edges: this.edgeCount,
      resolved: this.resolvedRids.length,
      unresolved: this.unresolvedRids.length,
      externalNodes: this.externalIds.size,
    };
  }

  private write(edge: EdgeRow, rid: number): void {
    this.store.insertEdge(edge, rid);
    this.edgeCount++;
  }

  // ------------------------------------------------------------- imports

  private placeImport(ref: RefRow): Placement[] {
    const target = this.importTarget(ref);
    // Third-party and standard library imports do not resolve, and that is
    // the right answer rather than a failure, so nothing is logged.
    return target ? [{ node: target, confidence: 'resolved' }] : [];
  }

  /** Where one import statement actually points, cached per ref. */
  private importTarget(ref: RefRow): DefNode | null {
    const cached = this.importTargetCache.get(ref.rid);
    if (cached !== undefined) return cached;

    let result: DefNode | null = null;
    const module = ref.module;
    if (module) {
      const family = familyOf(ref.lang);
      const localFile = this.findImportTargetFile(family, module, ref.path);
      if (localFile) result = this.pickImportedSymbol(localFile, ref.symbol);

      // `from pkg import models` reads as a symbol import but names a module.
      // The tell is landing on the package itself: the symbol was not defined
      // there, so check whether it is a module sitting underneath instead.
      if (ref.symbol && (result === null || result.kind === 'module')) {
        const nested = submoduleOf(family, module, ref.symbol);
        const nestedFile = nested ? this.findImportTargetFile(family, nested, ref.path) : null;
        if (nestedFile) result = this.index.moduleNodeOf(nestedFile) ?? result;
      }

      if (!result && this.links.length > 0) {
        const hit = resolveImportAcrossRepos(this.links, family, module, ref.symbol);
        if (hit) result = this.adoptExternal(hit.link, hit.node);
      }
    }
    this.importTargetCache.set(ref.rid, result);
    return result;
  }

  private findImportTargetFile(family: string, module: string, importerPath: string): string | null {
    if (isDefinitelyExternal(family, module)) return null;
    for (const candidate of moduleCandidates(family, module, importerPath, this.facts)) {
      const files = this.store.filesForModule(family, candidate);
      const first = files.find((f) => f !== importerPath);
      if (first) return first;
    }
    return null;
  }

  /**
   * A named import points at one symbol, a whole-module import at the file.
   * When a named symbol is missing it was probably re-exported from
   * elsewhere, so we keep the dependency on the file rather than dropping it.
   */
  private pickImportedSymbol(filePath: string, symbol: string | null): DefNode | null {
    const inFile = this.index.inFile(filePath);
    if (symbol && symbol !== 'default') {
      const best = preferBest(inFile.filter((n) => n.name === symbol && n.kind !== 'module'));
      if (best) return best;
    }
    if (symbol === 'default') {
      const best = preferBest(inFile.filter((n) => n.exported && n.kind !== 'module'));
      if (best) return best;
    }
    return this.index.moduleNodeOf(filePath);
  }

  /** What a local binding introduced by an import refers to. */
  private aliasTarget(filePath: string, alias: string): DefNode | null {
    let perFile = this.aliasCache.get(filePath);
    if (!perFile) {
      perFile = new Map();
      this.aliasCache.set(filePath, perFile);
    }
    const cached = perFile.get(alias);
    if (cached !== undefined) return cached;

    let found: DefNode | null = null;
    for (const imp of this.imports.forFile(filePath)) {
      if (imp.alias !== alias) continue;
      found = this.importTarget(imp);
      if (found) break;
    }
    perFile.set(alias, found);
    return found;
  }

  /**
   * Is `candidate` something the referring file could actually reach? Being
   * in the same file counts, being imported counts, and in Go so does being
   * in the same directory, because that is one package with one scope.
   */
  private isVisibleFrom(ref: RefRow, candidate: DefNode): boolean {
    if (candidate.path === ref.path) return true;
    if (this.importedFiles(ref.path).has(candidate.path)) return true;
    return familyOf(ref.lang) === 'go' && dirOf(candidate.path) === dirOf(ref.path);
  }

  /** Every file this file pulls something in from. */
  private importedFiles(filePath: string): Set<string> {
    let cached = this.importedFilesCache.get(filePath);
    if (!cached) {
      cached = new Set<string>();
      for (const imp of this.imports.forFile(filePath)) {
        const target = this.importTarget(imp);
        if (target) cached.add(target.path);
      }
      this.importedFilesCache.set(filePath, cached);
    }
    return cached;
  }

  /**
   * Star imports bring names in without a binding we can see, so we check the
   * files they pull from directly. Python's `from .models import *` is the
   * common case and it is worth handling.
   */
  private wildcardTarget(filePath: string, name: string): DefNode | null {
    for (const imp of this.imports.forFile(filePath)) {
      if (imp.symbol !== null || imp.alias !== null) continue;
      const target = this.importTarget(imp);
      if (!target || target.kind !== 'module') continue;
      const best = preferBest(this.index.inFile(target.path).filter((n) => n.name === name && n.kind !== 'module'));
      if (best) return best;
    }
    return null;
  }

  // --------------------------------------------------------------- names

  private placeName(ref: RefRow): Placement[] {
    const name = ref.name;
    if (!name) return [];
    if (ref.type === 'queries') return this.placeTable(name);

    const qualifier = ref.qualifier?.trim() || null;
    const selfish = qualifier !== null && SELF_RECEIVERS.has(qualifier);
    const sameFile = this.index.inFile(ref.path);

    // 1. self.foo() and this.foo(), which we can pin down properly.
    if (selfish) {
      const own = this.resolveOnEnclosingType(ref, name);
      if (own) return [{ node: own, confidence: 'resolved' }];
    }

    // 2. A definition in the same file, which the parser saw whole.
    if (qualifier === null || selfish) {
      const local = sameFile.filter((n) => n.name === name && n.kind !== 'module');
      if (local.length === 1) return [{ node: local[0] as DefNode, confidence: 'exact' }];
      const best = preferBest(local);
      if (best) return [{ node: best, confidence: 'resolved' }];
    }

    // 3. The bare name was imported: `from x import helper; helper()`.
    if (qualifier === null) {
      const imported = this.aliasTarget(ref.path, name);
      if (imported) return [{ node: imported, confidence: 'resolved' }];
      const starred = this.wildcardTarget(ref.path, name);
      if (starred) return [{ node: starred, confidence: 'resolved' }];
    }

    // 4. The receiver was imported: `import store; store.save()` or
    //    `from x import Order; Order.create()`.
    if (qualifier !== null && !selfish) {
      const head = qualifier.includes('.') ? (qualifier.split('.')[0] as string) : qualifier;
      const holder = this.aliasTarget(ref.path, head) ?? this.aliasTarget(ref.path, qualifier);
      if (holder) {
        const member = this.resolveMemberOf(holder, name);
        if (member) return [{ node: member, confidence: 'resolved' }];
      }

      // 5. Or it names a type declared right here: `Order.create()`.
      const localType = sameFile.find((n) => n.name === head && isTypeKind(n));
      if (localType) {
        const member = this.resolveMemberOf(localType, name);
        if (member) return [{ node: member, confidence: 'resolved' }];
      }
    }

    const global = this.index
      .byName(name)
      .filter((n) => n.kind !== 'module' && n.id !== ref.srcId && callShapeFits(n, qualifier, ref.type));

    // 6. The receiver is an object we cannot type, but the name is defined in
    //    exactly one file this file can see. An import is real evidence, and
    //    in Go so is sharing a package, since a package has one flat scope
    //    across its files and never imports itself. This is where
    //    `self.repository.find()` and `service.create()` get linked properly
    //    instead of being written off as name matches.
    const visible = global.filter((n) => this.isVisibleFrom(ref, n));
    if (visible.length === 1) return [{ node: visible[0] as DefNode, confidence: 'resolved' }];

    // 7. A qualified call with nothing visible behind it is where we stop.
    //    `rows.push(x)` matches every method called push in the repo and
    //    means none of them, so guessing here would fill the highest-value
    //    output with edges that are simply wrong.
    if (qualifier !== null && !selfish) {
      return visible.length > 1 && visible.length <= this.config.maxHeuristicCandidates
        ? visible.map((node) => ({ node, confidence: 'heuristic' as Confidence }))
        : [];
    }

    // 8. A bare name that exists somewhere. Weak, but a bare call really is
    //    usually the thing of that name, so it is worth offering with the tag
    //    that says so. Past a handful of candidates it stops being worth it.
    if (global.length > 0 && global.length <= this.config.maxHeuristicCandidates) {
      return global.map((node) => ({ node, confidence: 'heuristic' as Confidence }));
    }
    if (global.length > this.config.maxHeuristicCandidates) {
      // A dozen guesses for a name like `get` is noise, not information, and
      // confidently wrong answers are worse than no answer.
      return [];
    }

    if (this.links.length > 0) {
      const hit = resolveNameAcrossRepos(this.links, name);
      if (hit) return [{ node: this.adoptExternal(hit.link, hit.node), confidence: 'heuristic' }];
    }
    return [];
  }

  /** Look up `name` as a member of the type the reference sits inside. */
  private resolveOnEnclosingType(ref: RefRow, name: string): DefNode | null {
    const owner = this.index.byId(ref.srcId);
    if (!owner?.qualified) return null;
    const parts = owner.qualified.split('.');
    if (parts.length < 2) return null;
    const typeQualified = parts.slice(0, -1).join('.');

    const sameFile = this.index.inFile(ref.path);
    const direct = sameFile.find((n) => n.qualified === `${typeQualified}.${name}`);
    if (direct) return direct;

    const typeNode = sameFile.find((n) => n.qualified === typeQualified && isTypeKind(n));
    return typeNode ? this.resolveInherited(typeNode, name, 0) : null;
  }

  /** A member on a named type or module, following base types one level up. */
  private resolveMemberOf(holder: DefNode, name: string): DefNode | null {
    // A holder from a linked repo lives in a file our index knows nothing
    // about, so ask the repo that owns it.
    const owner = this.foreignOwners.get(holder.id);
    if (owner) return this.resolveForeignMemberOf(owner, holder, name);

    if (holder.kind === 'module') {
      return preferBest(this.index.inFile(holder.path).filter((n) => n.name === name && n.kind !== 'module'));
    }
    if (!isTypeKind(holder) || !holder.qualified) return null;

    const direct = this.index.inFile(holder.path).find((n) => n.qualified === `${holder.qualified}.${name}`);
    if (direct) return direct;
    return this.resolveInherited(holder, name, 0);
  }

  private resolveForeignMemberOf(owner: LinkedRepo, holder: DefNode, name: string): DefNode | null {
    const hit =
      holder.kind === 'module'
        ? resolveMemberAcrossRepos(owner, holder.path, name)
        : holder.qualified
          ? resolveQualifiedAcrossRepos(owner, holder.path, `${holder.qualified}.${name}`)
          : null;
    return hit ? this.adoptExternal(hit.link, hit.node) : null;
  }

  /**
   * Walk up inherits and implements edges looking for a member. Capped at two
   * levels: past that the answer is a guess dressed up as a fact.
   */
  private resolveInherited(typeNode: DefNode, name: string, depth: number): DefNode | null {
    if (depth >= 2) return null;
    const bases = this.store.outgoing([typeNode.id]).filter((e) => e.type === 'inherits' || e.type === 'implements');

    for (const base of bases) {
      const baseNode = this.index.byId(base.dstId);
      if (!baseNode?.qualified) continue;
      const member = this.index.inFile(baseNode.path).find((n) => n.qualified === `${baseNode.qualified}.${name}`);
      if (member) return member;
      const deeper = this.resolveInherited(baseNode, name, depth + 1);
      if (deeper) return deeper;
    }
    return null;
  }

  /** Table names come out of embedded SQL, so only table nodes can match. */
  private placeTable(name: string): Placement[] {
    const tables = this.index.byName(name).filter((n) => n.kind === 'table');
    if (tables.length === 1) return [{ node: tables[0] as DefNode, confidence: 'resolved' }];
    if (tables.length > 1 && tables.length <= this.config.maxHeuristicCandidates) {
      return tables.map((node) => ({ node, confidence: 'heuristic' as Confidence }));
    }
    return [];
  }

  /**
   * Copy a linked repo's node in as a stub, so traversal, ranking and output
   * all work without reopening the other database. The stub keeps the owning
   * repo name, which is what the output labels.
   */
  private adoptExternal(link: LinkedRepo, node: GraphNode): DefNode {
    if (!this.externalIds.has(node.id)) {
      this.store.insertNode({ ...node, repo: link.name }, true);
      this.externalIds.add(node.id);
    }
    this.foreignOwners.set(node.id, link);
    return {
      id: node.id,
      name: node.name,
      path: node.path,
      kind: node.kind,
      qualified: node.qualified,
      exported: node.exported,
    };
  }
}

interface Placement {
  node: DefNode;
  confidence: Confidence;
}

function isTypeKind(node: DefNode): boolean {
  return node.kind === 'class' || node.kind === 'struct' || node.kind === 'interface';
}

function dirOf(filePath: string): string {
  const cut = filePath.lastIndexOf('/');
  return cut === -1 ? '' : filePath.slice(0, cut);
}

/**
 * Could a reference written this way plausibly mean this symbol?
 *
 * By the time we reach the name-match strategies there is no import or type
 * to lean on, so the only thing left is the shape of the call. Two rules do
 * most of the work, and both are about refusing to answer:
 *
 *   `rows.push(x)` is never a free function called push. Without this, one
 *   small private helper collects an edge from every array append in the
 *   repo, which makes it the most depended on symbol in the graph and buries
 *   the real ones.
 *
 *   `add(x)` is never a method on some unrelated class, because no language
 *   here lets you call a method without a receiver from outside its body,
 *   and inside its body the earlier strategies already matched it.
 *
 * Plain references are left alone: a bare type name in a signature or an
 * annotation is a normal way to mention a method or a function.
 */
function callShapeFits(node: DefNode, qualifier: string | null, type: string): boolean {
  if (type !== 'calls') return true;
  if (qualifier === null) return node.kind !== 'method';
  if (SELF_RECEIVERS.has(qualifier)) return true;
  return node.kind !== 'function';
}

/**
 * The import statements of each file, which the name strategies consult. Bulk
 * loaded for a cold index, queried per file for a warm one.
 */
class ImportTable {
  private readonly cache = new Map<string, RefRow[]>();
  private readonly bulk: Map<string, RefRow[]> | null = null;

  constructor(
    private readonly store: Store,
    refCount: number,
  ) {
    if (refCount <= 4000) return;
    this.bulk = new Map();
    for (const ref of store.allImportRefs()) {
      const list = this.bulk.get(ref.path);
      if (list) list.push(ref);
      else this.bulk.set(ref.path, [ref]);
    }
  }

  forFile(filePath: string): RefRow[] {
    if (this.bulk) return this.bulk.get(filePath) ?? [];
    let cached = this.cache.get(filePath);
    if (!cached) {
      cached = this.store.importRefsInFile(filePath);
      this.cache.set(filePath, cached);
    }
    return cached;
  }
}
