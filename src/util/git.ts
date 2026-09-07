import { execFile } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { pathExistsSync } from './fs.js';

const run = promisify(execFile);

export function isGitRepo(repoRoot: string): boolean {
  return pathExistsSync(path.join(repoRoot, '.git'));
}

export class GitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GitError';
  }
}

/**
 * Files that differ from a ref, including working tree changes that are not
 * committed yet. That matters here: an agent asking "what did I change" has
 * usually not committed anything.
 *
 * Untracked files count too. `git diff` cannot see them, and leaving them out
 * meant a file the agent had just written was missing from the one answer
 * whose whole job is to describe what it had just done.
 */
export async function changedFilesSince(repoRoot: string, ref: string): Promise<string[]> {
  if (!isGitRepo(repoRoot)) throw new GitError(`${repoRoot} is not a git repository`);

  const paths = new Set<string>();
  for (const args of [
    ['diff', '--name-only', '-z', `${ref}`, '--'],
    ['diff', '--name-only', '-z', '--cached', `${ref}`, '--'],
    ['ls-files', '--others', '--exclude-standard', '-z'],
  ]) {
    const output = await git(repoRoot, args);
    // NUL separated, so a name is never split on a space or a newline it
    // legitimately contains, and nothing has to be trimmed back off it.
    for (const entry of output.split('\0')) {
      if (entry !== '') paths.add(entry.split(path.sep).join('/'));
    }
  }
  return [...paths].sort();
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    // core.quotePath makes git wrap any path with a byte over 0x7f in quotes
    // and octal-escape it, so `café.ts` came back as `"caf\303\251.ts"` and
    // matched nothing in the index. The file then went missing from the one
    // answer whose job is to list what changed, and said so as if it were
    // simply not indexed.
    const { stdout } = await run('git', ['-c', 'core.quotePath=false', ...args], {
      cwd: repoRoot,
      maxBuffer: 32 * 1024 * 1024,
    });
    return stdout;
  } catch (err) {
    const stderr = (err as { stderr?: string }).stderr ?? '';
    const first = stderr.split('\n')[0]?.trim();
    throw new GitError(first || `git ${args.join(' ')} failed`);
  }
}

/** Short head description, used in status output. */
export async function describeHead(repoRoot: string): Promise<string | null> {
  if (!isGitRepo(repoRoot)) return null;
  try {
    const branch = (await git(repoRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
    const sha = (await git(repoRoot, ['rev-parse', '--short', 'HEAD'])).trim();
    return `${branch} ${sha}`;
  } catch {
    return null;
  }
}
