import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeDefaultConfig, saveConfig, type CodegraphConfig } from '../src/config/config.js';
import { dbPath } from '../src/config/paths.js';
import { Store } from '../src/store/store.js';
import { runIndex } from '../src/index/indexer.js';
import type { IndexStats } from '../src/types.js';

const created: string[] = [];

/**
 * Scratch repos live under the project rather than in the system temp
 * directory. Tests create dot-directories like .cursor and .claude, and on a
 * sandboxed or managed machine those names are often not writable outside a
 * project. Keeping them here also means a crashed run leaves the evidence
 * somewhere you will actually look.
 */
const SCRATCH = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.scratch');

async function scratchDir(prefix: string): Promise<string> {
  await fsp.mkdir(SCRATCH, { recursive: true });
  const dir = await fsp.mkdtemp(path.join(SCRATCH, `${prefix}-`));
  created.push(dir);
  return dir;
}

/**
 * Build a throwaway repo on disk. Tests work against real files rather than a
 * mocked filesystem, because half the behaviour worth testing lives in the
 * walker, the mtime cache and the ignore rules.
 */
export async function makeRepo(
  name: string,
  files: Record<string, string>,
  overrides: Partial<CodegraphConfig> = {},
): Promise<string> {
  const root = await scratchDir(name);

  for (const [relative, contents] of Object.entries(files)) {
    const target = path.join(root, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, contents, 'utf8');
  }

  const config = { ...makeDefaultConfig(root), repo: name, ...overrides };
  await saveConfig(root, config);
  return root;
}

/**
 * Point everything that would touch the developer's home directory at a
 * throwaway instead: the cross-repo registry, and Codex's global config.
 *
 * Call it again for a clean one. Tests that install a global config need to
 * start from nothing, otherwise the previous test's leftovers look like their
 * own work.
 */
export async function useTempHome(): Promise<string> {
  const home = await scratchDir('home');
  process.env.CODEGRAPH_HOME = path.join(home, 'codegraph');
  process.env.CODEX_HOME = path.join(home, 'codex');
  return home;
}

export async function cleanupRepos(): Promise<void> {
  for (const dir of created.splice(0)) {
    await fsp.rm(dir, { recursive: true, force: true });
  }
}

export async function writeFile(root: string, relative: string, contents: string): Promise<void> {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, contents, 'utf8');
  // Nudge mtime forward so the change is visible even on a coarse clock.
  const later = new Date(Date.now() + 2000);
  await fsp.utimes(target, later, later);
}

export async function deleteFile(root: string, relative: string): Promise<void> {
  await fsp.rm(path.join(root, relative), { force: true });
}

export interface IndexedRepo {
  root: string;
  store: Store;
  stats: IndexStats;
  close(): void;
}

export async function indexRepo(root: string, options: { force?: boolean } = {}): Promise<IndexedRepo> {
  const { loadConfig } = await import('../src/config/config.js');
  const config = await loadConfig(root);
  const store = Store.open(dbPath(root));
  const stats = await runIndex({ repoRoot: root, config, store, force: options.force, progress: false });
  return { root, store, stats, close: () => store.close() };
}

/** Reindex an already indexed repo through the same path a query would. */
export async function reindexRepo(root: string): Promise<IndexedRepo> {
  return indexRepo(root);
}

/**
 * A comparable snapshot of the whole graph. Used by the incremental test,
 * where the only thing that matters is that two ways of arriving at the same
 * source tree produce byte-identical graphs.
 */
export interface GraphSnapshot {
  nodes: string[];
  edges: string[];
  modules: string[];
}

export function snapshot(store: Store): GraphSnapshot {
  const nodes = store
    .allNodesLite()
    .map((n) => `${n.id}|${n.kind}|${n.name}|${n.qualified ?? ''}|${n.exported ? 1 : 0}`)
    .sort();

  const ids = store.allNodesLite().map((n) => n.id);
  const edges = store
    .outgoing(ids)
    .map((e) => `${e.srcId}|${e.type}|${e.dstId}|${e.confidence}|${e.path}:${e.line}`)
    .sort();

  const modules = store
    .allModulePaths()
    .map((m) => `${m.path}|${m.family}|${m.module}|${m.isAlias ? 1 : 0}`)
    .sort();
  return { nodes, edges, modules };
}
