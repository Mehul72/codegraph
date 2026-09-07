import path from 'node:path';
import { globalDir, registryPath, dbPath } from './paths.js';
import { ensureDir, pathExists, readTextFileOrNull, writeTextFile } from '../util/fs.js';
import { log } from '../util/log.js';
const EMPTY = { version: 1, repos: [] };
export async function loadRegistry() {
    const text = await readTextFileOrNull(registryPath());
    if (text === null)
        return { ...EMPTY, repos: [] };
    try {
        const parsed = JSON.parse(text);
        const repos = Array.isArray(parsed.repos) ? parsed.repos : [];
        return {
            version: typeof parsed.version === 'number' ? parsed.version : 1,
            repos: repos.filter((r) => Boolean(r && typeof r.root === 'string' && typeof r.name === 'string')),
        };
    }
    catch (err) {
        log.warn(`global registry is unreadable (${err.message}), treating it as empty`);
        return { ...EMPTY, repos: [] };
    }
}
export async function saveRegistry(registry) {
    await ensureDir(globalDir());
    await writeTextFile(registryPath(), JSON.stringify(registry, null, 2) + '\n');
}
/**
 * Add or refresh this repo's entry. Called after every successful index.
 *
 * The registry only exists to make cross-repo queries and `codegraph repos`
 * convenient, so a home directory we cannot write to is a warning and not a
 * failure. Build containers and locked-down machines are common enough that
 * throwing here would break indexing for people who never wanted the feature.
 */
export async function registerRepo(name, root) {
    const abs = path.resolve(root);
    try {
        const registry = await loadRegistry();
        const existing = registry.repos.find((r) => r.root === abs);
        if (existing) {
            existing.name = name;
            existing.index = dbPath(abs);
        }
        else {
            registry.repos.push({ name, root: abs, index: dbPath(abs), registeredAt: Date.now() });
        }
        registry.repos.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
        await saveRegistry(registry);
    }
    catch (err) {
        log.warn(`could not record this repo in ${registryPath()} (${err.message}), cross-repo queries will not see it`);
    }
}
export async function unregisterRepo(root) {
    const registry = await loadRegistry();
    const abs = path.resolve(root);
    const before = registry.repos.length;
    registry.repos = registry.repos.filter((r) => r.root !== abs);
    if (registry.repos.length === before)
        return false;
    await saveRegistry(registry);
    return true;
}
/**
 * Accept either a name from the registry or a path on disk. Names win, since
 * that is what `codegraph repos` prints and what people will type.
 */
export async function resolveRepoRef(ref) {
    const registry = await loadRegistry();
    const byName = registry.repos.find((r) => r.name === ref);
    if (byName)
        return byName;
    const abs = path.resolve(ref);
    const byPath = registry.repos.find((r) => r.root === abs);
    if (byPath)
        return byPath;
    if (await pathExists(dbPath(abs))) {
        return { name: path.basename(abs), root: abs, index: dbPath(abs), registeredAt: 0 };
    }
    return null;
}
//# sourceMappingURL=registry.js.map