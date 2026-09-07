import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs';

export const INDEX_DIR_NAME = '.codegraph';
export const CONFIG_FILE_NAME = 'codegraph.config.json';
export const DB_FILE_NAME = 'graph.db';

/**
 * Walk up looking for a .git directory. Falls back to the starting directory
 * so codegraph still works in a folder that was never a git repo.
 */
export function findRepoRoot(startDir = process.cwd()): string {
  let dir = path.resolve(startDir);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    if (fs.existsSync(path.join(dir, CONFIG_FILE_NAME))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(startDir);
    dir = parent;
  }
}

export function indexDir(repoRoot: string): string {
  return path.join(repoRoot, INDEX_DIR_NAME);
}

export function dbPath(repoRoot: string): string {
  return path.join(indexDir(repoRoot), DB_FILE_NAME);
}

export function configPath(repoRoot: string): string {
  return path.join(repoRoot, CONFIG_FILE_NAME);
}

/** Everything global lives here: the cross-repo registry and nothing else. */
export function globalDir(): string {
  return process.env.CODEGRAPH_HOME
    ? path.resolve(process.env.CODEGRAPH_HOME)
    : path.join(os.homedir(), INDEX_DIR_NAME);
}

export function registryPath(): string {
  return path.join(globalDir(), 'registry.json');
}

export function codexConfigPath(): string {
  return path.join(process.env.CODEX_HOME ? path.resolve(process.env.CODEX_HOME) : path.join(os.homedir(), '.codex'), 'config.toml');
}
