import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathExists, readTextFileOrNull, writeTextFile } from '../util/fs.js';
import { isGitRepo } from '../util/git.js';
import { removeBlock, TOML_MARKERS, upsertBlock } from './markers.js';

const HOOKS = ['post-commit', 'post-checkout'] as const;

export interface HookReport {
  changed: string[];
  notes: string[];
}

/**
 * Opt in only, and never enabled by `init`.
 *
 * The staleness check on every query already keeps the index correct, so
 * these hooks exist purely to move the work off the query path after a commit
 * or a branch switch. They background themselves and swallow their own output:
 * a git hook that can slow down or fail a commit is not worth having.
 *
 * The block is spliced in through markers.ts rather than by hand. Doing it
 * here meant a second copy of the same logic, and the copy was missing the
 * guard for a start marker whose end marker had been deleted: indexOf
 * returned -1, the slice ran from a negative offset, and both install and
 * uninstall cut a arbitrary run of characters out of the user's hook script.
 */
export async function installGitHooks(repoRoot: string, command: string): Promise<HookReport> {
  const report: HookReport = { changed: [], notes: [] };

  if (!isGitRepo(repoRoot)) {
    report.notes.push('not a git repository, nothing to install');
    return report;
  }

  const hooksDir = path.join(repoRoot, '.git', 'hooks');
  await fsp.mkdir(hooksDir, { recursive: true });

  for (const hook of HOOKS) {
    const file = path.join(hooksDir, hook);
    const existing = (await readTextFileOrNull(file)) ?? '';
    const body = `${command} index >/dev/null 2>&1 &`;

    // A hook git will execute needs an interpreter line, and it has to stay
    // on the first line, so an empty file is seeded before the block goes in.
    const base = existing.trim() === '' ? '#!/bin/sh\n' : existing;
    const updated = upsertBlock(base, body, TOML_MARKERS);

    if (updated !== existing) {
      await writeTextFile(file, updated);
      await fsp.chmod(file, 0o755);
      report.changed.push(path.join('.git', 'hooks', hook));
    }
  }
  return report;
}

export async function uninstallGitHooks(repoRoot: string): Promise<HookReport> {
  const report: HookReport = { changed: [], notes: [] };

  for (const hook of HOOKS) {
    const file = path.join(repoRoot, '.git', 'hooks', hook);
    if (!(await pathExists(file))) continue;

    const existing = await readTextFileOrNull(file);
    if (existing === null) continue;
    const stripped = removeBlock(existing, TOML_MARKERS);
    if (stripped === null || stripped === existing) continue;

    // A file that only ever held our block goes away entirely.
    if (stripped.trim() === '' || stripped.trim() === '#!/bin/sh') {
      await fsp.rm(file, { force: true });
    } else {
      await writeTextFile(file, stripped);
    }
    report.changed.push(path.join('.git', 'hooks', hook));
  }
  return report;
}
