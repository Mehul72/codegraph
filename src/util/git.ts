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
 */
export async function changedFilesSince(repoRoot: string, ref: string): Promise<string[]> {
  if (!isGitRepo(repoRoot)) throw new GitError(`${repoRoot} is not a git repository`);

  const paths = new Set<string>();
  for (const args of [
    ['diff', '--name-only', `${ref}`, '--'],
    ['diff', '--name-only', '--cached', `${ref}`, '--'],
  ]) {
    const output = await git(repoRoot, args);
    for (const line of output.split('\n')) {
      const cleaned = line.trim();
      if (cleaned !== '') paths.add(cleaned.split(path.sep).join('/'));
    }
  }
  return [...paths].sort();
}

async function git(repoRoot: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run('git', args, { cwd: repoRoot, maxBuffer: 32 * 1024 * 1024 });
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
