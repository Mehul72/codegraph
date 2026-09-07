import path from 'node:path';
import { configPath } from './paths.js';
import { readTextFileOrNull, writeTextFile } from '../util/fs.js';
import { log } from '../util/log.js';

export interface CodegraphConfig {
  /** Bumped only when the on-disk shape changes in a breaking way. */
  version: number;
  /** Short repo identifier used as the first segment of every node id. */
  repo: string;
  /** Extractor ids to run. Empty array means "everything we detect". */
  languages: string[];
  /** Extra ignore globs on top of .gitignore and .codegraphignore. */
  ignore: string[];
  /** Files larger than this are recorded but not parsed. */
  maxFileBytes: number;
  /** Default output budget in tokens for CLI and MCP answers. */
  defaultBudget: number;
  /**
   * How many same-name candidates we are willing to guess between when there
   * is no import evidence. Above this we emit nothing, because a dozen
   * heuristic edges for a name like `get` is noise, not information.
   */
  maxHeuristicCandidates: number;
  /** Absolute paths of other indexed repos to resolve against. */
  links: string[];
}

export const DEFAULT_CONFIG: Omit<CodegraphConfig, 'repo'> = {
  version: 1,
  languages: [],
  ignore: [],
  maxFileBytes: 1_500_000,
  defaultBudget: 1200,
  maxHeuristicCandidates: 4,
  links: [],
};

export function defaultRepoName(repoRoot: string): string {
  return path.basename(repoRoot) || 'repo';
}

export function makeDefaultConfig(repoRoot: string, languages: string[] = []): CodegraphConfig {
  return { ...DEFAULT_CONFIG, repo: defaultRepoName(repoRoot), languages };
}

/**
 * Load the config, filling in anything missing. A partly hand-edited or
 * outdated config should still work rather than blowing up a query.
 */
export async function loadConfig(repoRoot: string): Promise<CodegraphConfig> {
  const file = configPath(repoRoot);
  const text = await readTextFileOrNull(file);
  if (text === null) return makeDefaultConfig(repoRoot);

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    log.warn(`${path.basename(file)} is not valid JSON (${(err as Error).message}), using defaults`);
    return makeDefaultConfig(repoRoot);
  }
  return normalizeConfig(parsed, repoRoot);
}

export function normalizeConfig(raw: unknown, repoRoot: string): CodegraphConfig {
  const src = (raw ?? {}) as Partial<CodegraphConfig>;
  const base = makeDefaultConfig(repoRoot);
  return {
    version: typeof src.version === 'number' ? src.version : base.version,
    repo: typeof src.repo === 'string' && src.repo.trim() ? src.repo.trim() : base.repo,
    languages: Array.isArray(src.languages) ? src.languages.filter((x): x is string => typeof x === 'string') : base.languages,
    ignore: Array.isArray(src.ignore) ? src.ignore.filter((x): x is string => typeof x === 'string') : base.ignore,
    maxFileBytes: positive(src.maxFileBytes, base.maxFileBytes),
    defaultBudget: positive(src.defaultBudget, base.defaultBudget),
    maxHeuristicCandidates: positive(src.maxHeuristicCandidates, base.maxHeuristicCandidates),
    links: Array.isArray(src.links) ? src.links.filter((x): x is string => typeof x === 'string') : base.links,
  };
}

function positive(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

export async function saveConfig(repoRoot: string, config: CodegraphConfig): Promise<void> {
  await writeTextFile(configPath(repoRoot), JSON.stringify(config, null, 2) + '\n');
}
