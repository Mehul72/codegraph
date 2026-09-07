import path from 'node:path';
import type { CodegraphConfig } from '../config/config.js';
import type { Store } from '../store/store.js';
import type { FileRecord, IndexStats, NewRef, RefRow } from '../types.js';
import { extractorFor, familyOf } from '../extract/registry.js';
import { ParserPool } from '../extract/parser.js';
import type { Extractor } from '../extract/types.js';
import { readSource } from './content.js';
import { walkRepo, type WalkedFile } from './walker.js';
import { resolveRefs } from '../resolve/resolver.js';
import { closeLinks, openLinks, type LinkedRepo } from '../resolve/crossrepo.js';
import { loadGoModulePath, loadPackageName, loadPathAliases, NO_ALIASES } from '../resolve/tsconfig.js';
import type { RepoFacts } from '../resolve/modules.js';
import { pathExistsSync } from '../util/fs.js';
import { log, Progress } from '../util/log.js';
import { formatCount, plural } from '../util/text.js';

export interface IndexOptions {
  repoRoot: string;
  config: CodegraphConfig;
  store: Store;
  /** Reparse everything, ignoring the content hash cache. */
  force?: boolean;
  /** Limit the walk to these repo-relative paths. */
  only?: readonly string[];
  /** Show a progress line on stderr. */
  progress?: boolean;
  /** Reuse an already-built parser pool and set of linked repos. */
  pool?: ParserPool;
  links?: readonly LinkedRepo[];
}

/** How many files we read ahead before parsing, and per write transaction. */
const BATCH_SIZE = 128;

export async function runIndex(options: IndexOptions): Promise<IndexStats> {
  const started = Date.now();
  const { repoRoot, config, store } = options;
  const warnings: string[] = [];

  const pool = options.pool ?? new ParserPool();
  const ownPool = !options.pool;
  const links = options.links ?? openLinks(config);
  const ownLinks = !options.links;

  try {
    const walked = await walkRepo({ repoRoot, extraIgnore: config.ignore, only: options.only });
    const cached = new Map(store.allFiles().map((f) => [f.path, f]));

    const plan = planWork(walked, cached, config, options);
    const progress =
      options.progress && plan.changed.length > 0 ? new Progress('indexing') : null;

    // Names that existed before this pass, so we know which other files'
    // references might now point somewhere else.
    const dirtyNames = new Set<string>();
    for (const file of [...plan.changed.map((f) => f.relPath), ...plan.deleted]) {
      for (const node of store.nodesInFile(file)) dirtyNames.add(node.name);
    }

    store.transaction(() => {
      for (const gone of plan.deleted) store.forgetFile(gone);
    });

    let indexed = 0;
    let skipped = plan.skipped;

    for (let offset = 0; offset < plan.changed.length; offset += BATCH_SIZE) {
      const batch = plan.changed.slice(offset, offset + BATCH_SIZE);
      const loaded = await Promise.all(batch.map((file) => loadOne(file, config)));

      // Parsing is wasm and single threaded, so it happens outside the write
      // transaction; the transaction only wraps the inserts.
      const parsed: Array<{ file: WalkedFile; record: FileRecord; extractor: Extractor | null; result: ParsedResult }> = [];

      for (const entry of loaded) {
        if (!entry) continue;
        const { file, source, hash, extractor } = entry;
        const record: FileRecord = {
          path: file.relPath,
          hash,
          size: file.size,
          mtimeMs: file.mtimeMs,
          lang: extractor?.id ?? null,
          indexedAt: Date.now(),
        };

        if (!extractor) {
          parsed.push({ file, record, extractor: null, result: EMPTY_PARSE });
          skipped++;
          continue;
        }

        const result = await parseAndExtract(pool, extractor, file.relPath, source, config.repo);
        if (result.warning) warnings.push(result.warning);
        parsed.push({ file, record, extractor, result });
        indexed++;
        const total = plan.changed.length;
        progress?.update(`${formatCount(offset + parsed.length)}/${formatCount(total)} ${plural(total, 'file')}`);
      }

      store.transaction(() => {
        for (const item of parsed) {
          store.clearFileContents(item.file.relPath);
          store.upsertFile(item.record);
          writeExtraction(store, item.extractor, item.file.relPath, item.result, dirtyNames);
        }
      });
    }

    progress?.finish(`${formatCount(indexed)} ${plural(indexed, 'file')} parsed`);

    const facts = repoFacts(repoRoot);
    const outcome =
      plan.changed.length > 0 || plan.deleted.length > 0
        ? store.transaction(() =>
            resolveRefs({ store, config, facts, links, refs: collectRefsToResolve(store, plan, dirtyNames) }),
          )
        : { edges: 0, resolved: 0, unresolved: 0, externalNodes: 0 };

    if (plan.deleted.length > 0 || plan.changed.length > 0) {
      store.transaction(() => store.deleteOrphanExternalNodes());
    }

    store.setMeta('repo', config.repo);
    store.setMeta('indexed_at', String(Date.now()));
    store.setMeta('repo_root', repoRoot);

    return {
      filesScanned: walked.length,
      filesIndexed: indexed,
      filesRemoved: plan.deleted.length,
      filesSkipped: skipped,
      nodes: store.nodeCount(),
      edges: store.edgeCount(),
      unresolvedRefs: store.unresolvedRefCount(),
      durationMs: Date.now() - started,
      warnings: warnings.slice(0, 20),
    };
  } finally {
    if (ownPool) pool.dispose();
    if (ownLinks) closeLinks(links);
  }
}

export function repoFacts(repoRoot: string): RepoFacts {
  return {
    repoRoot,
    goModulePath: loadGoModulePath(repoRoot),
    packageName: loadPackageName(repoRoot),
    tsAliases: pathExistsSync(path.join(repoRoot, 'tsconfig.json')) ? loadPathAliases(repoRoot) : NO_ALIASES,
  };
}

interface WorkPlan {
  changed: WalkedFile[];
  deleted: string[];
  skipped: number;
}

/**
 * Decide what actually needs parsing. Matching size and mtime is treated as
 * unchanged without reading the file, which is what makes a warm pass cheap;
 * anything else gets read and hashed, and an unchanged hash still saves the
 * parse.
 */
function planWork(
  walked: readonly WalkedFile[],
  cached: Map<string, FileRecord>,
  config: CodegraphConfig,
  options: IndexOptions,
): WorkPlan {
  const changed: WalkedFile[] = [];
  const seen = new Set<string>();
  let skipped = 0;

  for (const file of walked) {
    seen.add(file.relPath);

    if (file.size > config.maxFileBytes) {
      skipped++;
      continue;
    }
    const extractor = extractorFor(file.relPath);
    if (!extractor) {
      skipped++;
      continue;
    }
    if (config.languages.length > 0 && !config.languages.includes(extractor.id)) {
      skipped++;
      continue;
    }

    const previous = cached.get(file.relPath);
    if (!options.force && previous && previous.size === file.size && Math.round(previous.mtimeMs) === Math.round(file.mtimeMs)) {
      continue;
    }
    changed.push(file);
  }

  // A scoped run must not delete rows for files it never looked at.
  const deleted = options.only && options.only.length > 0 ? [] : [...cached.keys()].filter((p) => !seen.has(p));

  return { changed, deleted, skipped };
}

interface LoadedFile {
  file: WalkedFile;
  source: string;
  hash: string;
  extractor: Extractor | null;
}

async function loadOne(file: WalkedFile, config: CodegraphConfig): Promise<LoadedFile | null> {
  try {
    const content = await readSource(file.absPath);
    if (!content) return null; // binary, nothing to extract
    const extractor = extractorFor(file.relPath);
    const wanted = extractor && (config.languages.length === 0 || config.languages.includes(extractor.id));
    return { file, source: content.text, hash: content.hash, extractor: wanted ? extractor : null };
  } catch (err) {
    log.debug(`could not read ${file.relPath}: ${(err as Error).message}`);
    return null;
  }
}

interface ParsedResult {
  nodes: import('../types.js').GraphNode[];
  edges: import('../types.js').RawEdge[];
  modules: Array<{ module: string; isAlias: boolean }>;
  family: string;
  warning: string | null;
}

const EMPTY_PARSE: ParsedResult = { nodes: [], edges: [], modules: [], family: '', warning: null };

/**
 * Parse and extract one file. An unparseable or unexpected file produces a
 * warning and no symbols; it never stops the index.
 */
async function parseAndExtract(
  pool: ParserPool,
  extractor: Extractor,
  relPath: string,
  source: string,
  repo: string,
): Promise<ParsedResult> {
  let tree = null;
  if (extractor.grammar) {
    tree = await pool.parse(extractor.grammar, source);
    if (!tree) {
      return { ...EMPTY_PARSE, family: familyOf(extractor.id), warning: `${relPath}: no usable parser, skipped` };
    }
  }

  try {
    const result = extractor.extract({ tree, path: relPath, source, repo });
    const modules: Array<{ module: string; isAlias: boolean }> = [];
    const canonical = extractor.modulePath?.(relPath, source);
    if (canonical) modules.push({ module: canonical, isAlias: false });
    for (const alias of extractor.moduleAliases?.(relPath, source) ?? []) {
      if (alias && alias !== canonical) modules.push({ module: alias, isAlias: true });
    }
    return { nodes: result.nodes, edges: result.edges, modules, family: familyOf(extractor.id), warning: null };
  } catch (err) {
    return {
      ...EMPTY_PARSE,
      family: familyOf(extractor.id),
      warning: `${relPath}: ${extractor.id} extractor failed (${(err as Error).message}), skipped`,
    };
  } finally {
    tree?.delete();
  }
}

function writeExtraction(
  store: Store,
  extractor: Extractor | null,
  relPath: string,
  result: ParsedResult,
  dirtyNames: Set<string>,
): void {
  if (!extractor) return;

  for (const node of result.nodes) {
    store.insertNode(node);
    dirtyNames.add(node.name);
  }
  for (const module of result.modules) {
    store.addModulePath(relPath, result.family, module.module, module.isAlias);
  }

  for (const edge of result.edges) {
    if (edge.to.kind === 'id') {
      if (edge.to.id === edge.from) continue;
      store.insertEdge(
        { srcId: edge.from, dstId: edge.to.id, type: edge.type, confidence: 'exact', path: relPath, line: edge.line },
        null,
      );
      continue;
    }

    const ref: NewRef = {
      srcId: edge.from,
      path: relPath,
      line: edge.line,
      type: edge.type,
      targetKind: edge.to.kind,
      name: edge.to.kind === 'name' ? edge.to.name : null,
      qualifier: edge.to.kind === 'name' ? (edge.to.qualifier ?? null) : null,
      module: edge.to.kind === 'module' ? edge.to.module : null,
      symbol: edge.to.kind === 'module' ? (edge.to.symbol ?? null) : null,
      alias: edge.to.kind === 'module' ? (edge.to.alias ?? null) : null,
      lang: extractor.id,
    };
    store.insertRef(ref);
  }
}

/**
 * The refs whose resolution could have changed. This set has to be a superset
 * of the truly affected refs, or the incremental graph drifts away from what a
 * cold index would produce, which is the worst failure this tool can have.
 *
 *   - refs in files we just reparsed, because they are brand new
 *   - refs anywhere that name a symbol added or removed by this pass
 *   - every import, because a file appearing or disappearing changes which
 *     file a module string points at
 *   - anything still unresolved, which a new definition may now satisfy
 */
function collectRefsToResolve(store: Store, plan: WorkPlan, dirtyNames: Set<string>): RefRow[] {
  const byRid = new Map<number, RefRow>();
  const add = (refs: readonly RefRow[]) => {
    for (const ref of refs) byRid.set(ref.rid, ref);
  };

  add(store.refsInFiles(plan.changed.map((f) => f.relPath)));
  add(store.refsByNames([...dirtyNames]));
  add(store.allImportRefs());
  add(store.unresolvedRefs());

  const rids = [...byRid.keys()];
  store.deleteEdgesForRefs(rids);
  return [...byRid.values()];
}
