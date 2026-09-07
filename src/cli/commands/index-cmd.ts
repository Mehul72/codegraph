import path from 'node:path';
import fsp from 'node:fs/promises';
import { loadConfig } from '../../config/config.js';
import { dbPath, findRepoRoot, indexDir } from '../../config/paths.js';
import { Store } from '../../store/store.js';
import { runIndex } from '../../index/indexer.js';
import { registerRepo } from '../../config/registry.js';
import type { IndexStats } from '../../types.js';
import { formatCount, formatDuration, plural } from '../../util/text.js';
import { log } from '../../util/log.js';
import { pathExistsSync } from '../../util/fs.js';

export interface IndexCommandOptions {
  force?: boolean;
  quiet?: boolean;
}

export async function indexCommand(paths: string[], options: IndexCommandOptions): Promise<void> {
  const repoRoot = findRepoRoot();
  const config = await loadConfig(repoRoot);

  if (options.force) {
    // A forced run starts from an empty database, which is also the recovery
    // path for an index that got into a bad state.
    const file = dbPath(repoRoot);
    if (pathExistsSync(file)) {
      for (const suffix of ['', '-wal', '-shm']) {
        await fsp.rm(file + suffix, { force: true });
      }
    }
  }

  const store = Store.open(dbPath(repoRoot));
  try {
    const only = paths.map((p) => toRepoRelative(repoRoot, p));
    const stats = await runIndex({
      repoRoot,
      config,
      store,
      force: options.force,
      only: only.length > 0 ? only : undefined,
      progress: !options.quiet,
    });
    await registerRepo(config.repo, repoRoot);
    await writeIndexGitignore(repoRoot);
    if (!options.quiet) process.stdout.write(formatStats(stats) + '\n');
  } finally {
    store.close();
  }
}

export function toRepoRelative(repoRoot: string, target: string): string {
  const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
  return path.relative(repoRoot, abs).split(path.sep).join('/');
}

export function formatStats(stats: IndexStats): string {
  const lines = [
    `indexed ${formatCount(stats.filesIndexed)} ${plural(stats.filesIndexed, 'file')} in ${formatDuration(stats.durationMs)}`,
    `${formatCount(stats.nodes)} ${plural(stats.nodes, 'symbol')}, ${formatCount(stats.edges)} ${plural(stats.edges, 'edge')}`,
  ];
  if (stats.filesRemoved > 0) {
    lines.push(`${formatCount(stats.filesRemoved)} deleted ${plural(stats.filesRemoved, 'file')} removed from the index`);
  }
  if (stats.warningCount > 0) {
    lines.push(`skipped ${formatCount(stats.warningCount)} ${plural(stats.warningCount, 'file')}:`);
    const quoted = stats.warnings.slice(0, 5);
    for (const warning of quoted) lines.push(`  ${warning}`);
    if (stats.warningCount > quoted.length) {
      lines.push(`  and ${formatCount(stats.warningCount - quoted.length)} more`);
    }
  }
  return lines.join('\n');
}

/**
 * The index is disposable and rebuildable in one command, so it does not
 * belong in git. Own .codegraph/.gitignore rather than editing the user's.
 */
export async function writeIndexGitignore(repoRoot: string): Promise<void> {
  const file = path.join(indexDir(repoRoot), '.gitignore');
  const body = ['# codegraph index, rebuild with: codegraph index', '*', ''].join('\n');
  try {
    await fsp.mkdir(path.dirname(file), { recursive: true });
    await fsp.writeFile(file, body, 'utf8');
  } catch (err) {
    log.debug(`could not write ${file}: ${(err as Error).message}`);
  }
}
