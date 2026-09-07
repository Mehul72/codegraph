import path from 'node:path';
import { loadConfig, type CodegraphConfig } from './config/config.js';
import { dbPath, findRepoRoot } from './config/paths.js';
import { Store } from './store/store.js';
import { ParserPool } from './extract/parser.js';
import { closeLinks, openLinks, type LinkedRepo } from './resolve/crossrepo.js';
import { repoFacts, runIndex } from './index/indexer.js';
import type { RepoFacts } from './resolve/modules.js';
import type { IndexStats } from './types.js';
import { isInside, pathExistsSync } from './util/fs.js';
import { log } from './util/log.js';
import { plural } from './util/text.js';

export class NoIndexError extends Error {
  constructor(readonly repoRoot: string) {
    super(`no index found for ${repoRoot}. Run 'codegraph init' or 'codegraph index' first.`);
    this.name = 'NoIndexError';
  }
}

/**
 * One open repo: config, database, parsers and linked repos. The CLI builds
 * one per invocation and the MCP server keeps a single one for its lifetime.
 */
export class Session {
  private lastFreshnessCheck = 0;
  private freshnessInFlight: Promise<IndexStats | null> | null = null;

  private constructor(
    readonly repoRoot: string,
    readonly config: CodegraphConfig,
    readonly store: Store,
    readonly pool: ParserPool,
    readonly links: LinkedRepo[],
    readonly facts: RepoFacts,
  ) {}

  static async open(options: { cwd?: string; requireIndex?: boolean } = {}): Promise<Session> {
    const repoRoot = findRepoRoot(options.cwd ?? process.cwd());
    const file = dbPath(repoRoot);
    if ((options.requireIndex ?? true) && !pathExistsSync(file)) throw new NoIndexError(repoRoot);

    const config = await loadConfig(repoRoot);
    const store = Store.open(file);
    return new Session(repoRoot, config, store, new ParserPool(), openLinks(config), repoFacts(repoRoot));
  }

  /**
   * Bring the index up to date before answering. This is the mechanism that
   * makes edits during an agent session visible to the next query, and it has
   * to be cheap enough to run on every single call: the common case is a walk
   * plus a stat per file and no parsing at all.
   *
   * Debounced, because agents fire several queries in a row and rescanning for
   * each one is wasted work.
   */
  async ensureFresh(options: { debounceMs?: number } = {}): Promise<IndexStats | null> {
    const debounce = options.debounceMs ?? 250;
    if (Date.now() - this.lastFreshnessCheck < debounce) return null;
    if (this.freshnessInFlight) return this.freshnessInFlight;

    this.freshnessInFlight = (async () => {
      try {
        const stats = await runIndex({
          repoRoot: this.repoRoot,
          config: this.config,
          store: this.store,
          pool: this.pool,
          links: this.links,
          progress: false,
        });
        if (stats.filesIndexed > 0 || stats.filesRemoved > 0) {
          const updated = `${stats.filesIndexed} ${plural(stats.filesIndexed, 'file')}`;
          log.debug(`freshness pass updated ${updated}, removed ${stats.filesRemoved}`);
        }
        return stats;
      } catch (err) {
        // A stale answer beats no answer, so a failed refresh is a warning.
        log.warn(`freshness check failed (${(err as Error).message}), answering from the existing index`);
        return null;
      } finally {
        this.lastFreshnessCheck = Date.now();
        this.freshnessInFlight = null;
      }
    })();

    return this.freshnessInFlight;
  }

  /**
   * Reindex specific files, for the agent hook path.
   *
   * Paths outside the repo are dropped rather than rejected. Hooks pass along
   * whatever the agent touched, which sometimes includes a scratch file in a
   * temp directory, and indexing that into this repo's graph would be worse
   * than doing nothing.
   */
  async touch(files: readonly string[]): Promise<IndexStats> {
    const relative: string[] = [];
    for (const file of files) {
      const abs = path.isAbsolute(file) ? file : path.resolve(this.repoRoot, file);
      if (!isInside(this.repoRoot, abs)) {
        log.debug(`ignoring ${file}, which is outside ${this.repoRoot}`);
        continue;
      }
      relative.push(path.relative(this.repoRoot, abs).split(path.sep).join('/'));
    }
    if (relative.length === 0) return emptyStats();

    return runIndex({
      repoRoot: this.repoRoot,
      config: this.config,
      store: this.store,
      pool: this.pool,
      links: this.links,
      only: relative,
      progress: false,
    });
  }

  indexedAt(): Date | null {
    const value = this.store.getMeta('indexed_at');
    return value ? new Date(Number(value)) : null;
  }

  close(): void {
    this.pool.dispose();
    closeLinks(this.links);
    this.store.close();
  }
}

function emptyStats(): IndexStats {
  return {
    filesScanned: 0,
    filesIndexed: 0,
    filesRemoved: 0,
    filesSkipped: 0,
    nodes: 0,
    edges: 0,
    unresolvedRefs: 0,
    durationMs: 0,
    warnings: [],
    warningCount: 0,
  };
}
