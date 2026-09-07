import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathExists, readTextFileOrNull, writeTextFile } from '../util/fs.js';
import { isGitRepo } from '../util/git.js';

const HOOKS = ['post-commit', 'post-checkout'] as const;
const START = '# codegraph:start';
const END = '# codegraph:end';

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
 */
export async function installGitHooks(repoRoot: string, command: string): Promise<HookReport> {
  const report: HookReport = { changed: [], notes: [] };
  const hooksDir = path.join(repoRoot, '.git', 'hooks');

  if (!isGitRepo(repoRoot)) {
    report.notes.push('not a git repository, nothing to install');
    return report;
  }
  await fsp.mkdir(hooksDir, { recursive: true });

  for (const hook of HOOKS) {
    const file = path.join(hooksDir, hook);
    const existing = (await readTextFileOrNull(file)) ?? '';
    const body = [START, `${command} index >/dev/null 2>&1 &`, END].join('\n');

    let updated: string;
    if (existing.includes(START)) {
      const startAt = existing.indexOf(START);
      const endAt = existing.indexOf(END);
      updated = existing.slice(0, startAt) + body + existing.slice(endAt + END.length);
    } else if (existing.trim() === '') {
      updated = `#!/bin/sh\n${body}\n`;
    } else {
      updated = `${existing.replace(/\n*$/, '\n')}\n${body}\n`;
    }

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
    if (existing === null || !existing.includes(START)) continue;

    const startAt = existing.indexOf(START);
    const endAt = existing.indexOf(END);
    const stripped = (existing.slice(0, startAt) + existing.slice(endAt + END.length)).replace(/\n{3,}/g, '\n\n');

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
