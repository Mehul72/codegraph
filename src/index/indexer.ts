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

/** How many parse failures we quote back. The count is reported in full. */
const WARNING_SAMPLE = 20;

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

    for (let offset = 0; offset < plan.changed.length; offset += BATCH_SIZE) {
      const batch = plan.changed.slice(offset, offset + BATCH_SIZE);
      const loaded = await Promise.all(batch.map((file) => loadOne(file, config)));

      // Parsing is wasm and single threaded, so it happens outside the write
      // transaction; the transaction only wraps the inserts.
      const parsed: ParsedFile[] = [];

      for (const entry of loaded) {
        if (!entry) continue;
        const { file, source, hash, extractor } = entry;
        const record: FileRecord = {
          path: file.relPath,
          hash,
          size: file.size,
          mtimeMs: file.mtimeMs,
          lang: extractor.id,
          indexedAt: Date.now(),
        };

        // The file changed size or mtime but not a byte of content, which is
        // what a branch switch, a rebase and most formatters leave behind.
        // Its symbols are already correct, so only the stat is worth writing:
        // recording the new mtime is what lets the next pass skip it outright.
        if (!options.force && cached.get(file.relPath)?.hash === hash) {
          parsed.push({ file, record, extractor, result: EMPTY_PARSE, reused: true });
          continue;
        }

        const result = await parseAndExtract(pool, extractor, file.relPath, source, config.repo);
        if (result.warning) warnings.push(result.warning);
        parsed.push({ file, record, extractor, result, reused: false });
        indexed++;
        // Files actually parsed, not the offset plus however many entries this
        // batch has collected so far: that counted reused and skipped files as
        // progress and reset at every batch boundary.
        const total = plan.changed.length;
        progress?.update(`${formatCount(indexed)}/${formatCount(total)} ${plural(total, 'file')}`);
      }

      store.transaction(() => {
        for (const item of parsed) {
          if (item.reused) {
            store.upsertFile(item.record);
            continue;
          }
          store.clearFileContents(item.file.relPath);
          store.upsertFile(item.record);
          writeExtraction(store, item.extractor, item.file.relPath, item.result, dirtyNames);
        }
      });
    }

    progress?.finish(`${formatCount(indexed)} ${plural(indexed, 'file')} parsed`);

    // Nothing reparsed and nothing removed means no reference moved, so the
    // resolution pass has nothing to reconsider.
    const touchedGraph = indexed > 0 || plan.deleted.length > 0;
    const facts = repoFacts(repoRoot);
    const outcome = touchedGraph
      ? store.transaction(() =>
          resolveRefs({ store, config, facts, links, refs: collectRefsToResolve(store, plan, dirtyNames) }),
        )
      : { edges: 0, resolved: 0, unresolved: 0, externalNodes: 0 };

    if (touchedGraph) {
      store.transaction(() => store.deleteOrphanExternalNodes());
    }

    store.setMeta('repo', config.repo);
    store.setMeta('indexed_at', String(Date.now()));
    store.setMeta('repo_root', repoRoot);

    return {
      filesScanned: walked.length,
      filesIndexed: indexed,
      filesRemoved: plan.deleted.length,
      filesSkipped: plan.skipped,
      nodes: store.nodeCount(),
      edges: store.edgeCount(),
      unresolvedRefs: store.unresolvedRefCount(),
      durationMs: Date.now() - started,
      // Capped for display, but the count travels separately: reporting the
      // length of the capped list told a repo with 500 unparseable files
      // that exactly 20 were skipped.
      warnings: warnings.slice(0, WARNING_SAMPLE),
      warningCount: warnings.length,
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
 * Decide what needs looking at. Matching size and mtime is treated as
 * unchanged without reading the file, which is what makes a warm pass cheap.
 * Anything else is read and hashed, and runIndex still skips the parse when
 * that hash turns out to match.
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
    // Deliberately not marked seen yet. A file we walk but will not parse has
    // to look the same to staleFiles as one that is gone: if a previous pass
    // did index it, the symbols it contributed are now wrong and have to be
    // dropped. A file that grows past maxFileBytes, or whose language is
    // taken out of config.languages, otherwise kept its old symbols in the
    // graph for ever, reported at lines that no longer hold them. Files that
    // were never indexed have no row in `files`, so they cannot be affected.
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
    seen.add(file.relPath);

    const previous = cached.get(file.relPath);
    if (!options.force && previous && previous.size === file.size && Math.round(previous.mtimeMs) === Math.round(file.mtimeMs)) {
      continue;
    }
    changed.push(file);
  }

  const deleted = staleFiles(cached, seen, options.only);
  return { changed, deleted, skipped };
}

/**
 * Indexed files that are no longer on disk.
 *
 * A scoped run must not drop rows for files it never looked at, but it does
 * own everything under the paths it was given. That second half matters: the
 * edit hooks call `touch` with the file the agent just deleted, and without
 * this the symbols of a deleted file stay in the graph until the next full
 * pass happens to notice.
 */
function staleFiles(
  cached: Map<string, FileRecord>,
  seen: ReadonlySet<string>,
  only: readonly string[] | undefined,
): string[] {
  const stale = [...cached.keys()].filter((p) => !seen.has(p));
  if (!only || only.length === 0) return stale;

  // An empty scope is the repo root, which means the whole tree.
  const scopes = only.filter((s) => s !== '');
  if (scopes.length < only.length) return stale;

  return stale.filter((p) => scopes.some((scope) => p === scope || p.startsWith(`${scope}/`)));
}

interface LoadedFile {
  file: WalkedFile;
  source: string;
  hash: string;
  extractor: Extractor;
}

/** One file plus what came of it, or what we chose not to redo. */
interface ParsedFile {
  file: WalkedFile;
  record: FileRecord;
  extractor: Extractor;
  result: ParsedResult;
  /** Content-identical to what is already indexed, so nothing was parsed. */
  reused: boolean;
}

/**
 * planWork only ever schedules files it has already matched to an enabled
 * extractor, so anything without one here is a file that changed language
 * under us, and skipping it is the same as never having seen it.
 */
async function loadOne(file: WalkedFile, config: CodegraphConfig): Promise<LoadedFile | null> {
  try {
    const content = await readSource(file.absPath);
    if (!content) return null; // binary, nothing to extract
    const extractor = extractorFor(file.relPath);
    if (!extractor) return null;
    if (config.languages.length > 0 && !config.languages.includes(extractor.id)) return null;
    return { file, source: content.text, hash: content.hash, extractor };
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
