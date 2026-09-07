import path from 'node:path';
import { configPath } from './paths.js';
import { readTextFileOrNull, writeTextFile } from '../util/fs.js';
import { log } from '../util/log.js';
export const DEFAULT_CONFIG = {
    version: 1,
    languages: [],
    ignore: [],
    maxFileBytes: 1_500_000,
    defaultBudget: 1200,
    maxHeuristicCandidates: 4,
    links: [],
};
export function defaultRepoName(repoRoot) {
    return path.basename(repoRoot) || 'repo';
}
export function makeDefaultConfig(repoRoot, languages = []) {
    return { ...DEFAULT_CONFIG, repo: defaultRepoName(repoRoot), languages };
}
/**
 * Load the config, filling in anything missing. A partly hand-edited or
 * outdated config should still work rather than blowing up a query.
 */
export async function loadConfig(repoRoot) {
    const file = configPath(repoRoot);
    const text = await readTextFileOrNull(file);
    if (text === null)
        return makeDefaultConfig(repoRoot);
    let parsed;
    try {
        parsed = JSON.parse(text);
    }
    catch (err) {
        log.warn(`${path.basename(file)} is not valid JSON (${err.message}), using defaults`);
        return makeDefaultConfig(repoRoot);
    }
    return normalizeConfig(parsed, repoRoot);
}
export function normalizeConfig(raw, repoRoot) {
    const src = (raw ?? {});
    const base = makeDefaultConfig(repoRoot);
    return {
        version: typeof src.version === 'number' ? src.version : base.version,
        repo: typeof src.repo === 'string' && src.repo.trim() ? src.repo.trim() : base.repo,
        languages: Array.isArray(src.languages) ? src.languages.filter((x) => typeof x === 'string') : base.languages,
        ignore: Array.isArray(src.ignore) ? src.ignore.filter((x) => typeof x === 'string') : base.ignore,
        maxFileBytes: positive(src.maxFileBytes, base.maxFileBytes),
        defaultBudget: positive(src.defaultBudget, base.defaultBudget),
        maxHeuristicCandidates: positive(src.maxHeuristicCandidates, base.maxHeuristicCandidates),
        links: Array.isArray(src.links) ? src.links.filter((x) => typeof x === 'string') : base.links,
    };
}
function positive(value, fallback) {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}
export async function saveConfig(repoRoot, config) {
    await writeTextFile(configPath(repoRoot), JSON.stringify(config, null, 2) + '\n');
}
//# sourceMappingURL=config.js.map