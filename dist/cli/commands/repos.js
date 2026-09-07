import path from 'node:path';
import { loadConfig, saveConfig } from '../../config/config.js';
import { dbPath, findRepoRoot } from '../../config/paths.js';
import { loadRegistry, resolveRepoRef } from '../../config/registry.js';
import { Store } from '../../store/store.js';
import { pathExistsSync } from '../../util/fs.js';
import { formatCount, pad } from '../../util/text.js';
export async function linkCommand(target) {
    const repoRoot = findRepoRoot();
    const out = (line) => process.stdout.write(line + '\n');
    const entry = await resolveRepoRef(target);
    if (!entry) {
        out(`could not find an indexed repo called "${target}".`);
        out('Run codegraph index in that repo first, then link it by name or path.');
        out('Known repos: run codegraph repos');
        return;
    }
    if (path.resolve(entry.root) === path.resolve(repoRoot)) {
        out('that is this repo');
        return;
    }
    const config = await loadConfig(repoRoot);
    if (config.links.some((link) => path.resolve(link) === path.resolve(entry.root))) {
        out(`${entry.name} is already linked`);
        return;
    }
    config.links.push(entry.root);
    config.links.sort();
    await saveConfig(repoRoot, config);
    out(`linked ${entry.name} (${entry.root})`);
    out('run codegraph index to resolve imports against it');
}
export async function unlinkCommand(target) {
    const repoRoot = findRepoRoot();
    const out = (line) => process.stdout.write(line + '\n');
    const config = await loadConfig(repoRoot);
    const entry = await resolveRepoRef(target);
    const wanted = entry ? path.resolve(entry.root) : path.resolve(target);
    const before = config.links.length;
    config.links = config.links.filter((link) => path.resolve(link) !== wanted);
    if (config.links.length === before) {
        out(`"${target}" is not linked`);
        return;
    }
    await saveConfig(repoRoot, config);
    out(`unlinked ${entry?.name ?? target}, run codegraph index to drop the cross-repo edges`);
}
export async function reposCommand() {
    const out = (line) => process.stdout.write(line + '\n');
    const registry = await loadRegistry();
    if (registry.repos.length === 0) {
        out('no indexed repos registered yet. Run codegraph index in a repo to add it.');
        return;
    }
    const repoRoot = findRepoRoot();
    const config = pathExistsSync(path.join(repoRoot, 'codegraph.config.json')) ? await loadConfig(repoRoot) : null;
    const linked = new Set((config?.links ?? []).map((l) => path.resolve(l)));
    out(`${pad('repo', 22)} ${pad('symbols', 9)} ${pad('indexed', 20)} path`);
    for (const entry of registry.repos) {
        const stats = readStats(dbPath(entry.root));
        const marker = path.resolve(entry.root) === path.resolve(repoRoot) ? ' *' : linked.has(path.resolve(entry.root)) ? ' +' : '';
        out(`${pad(entry.name + marker, 22)} ${pad(stats.symbols === null ? 'missing' : formatCount(stats.symbols), 9)} ${pad(stats.indexedAt ?? 'never', 20)} ${entry.root}`);
    }
    out('');
    out('* this repo   + linked from this repo');
}
function readStats(file) {
    if (!pathExistsSync(file))
        return { symbols: null, indexedAt: null };
    let store = null;
    try {
        store = Store.open(file, { readOnly: true });
        const at = store.getMeta('indexed_at');
        return {
            symbols: store.nodeCount(),
            indexedAt: at ? new Date(Number(at)).toISOString().replace('T', ' ').slice(0, 16) : null,
        };
    }
    catch {
        return { symbols: null, indexedAt: null };
    }
    finally {
        store?.close();
    }
}
//# sourceMappingURL=repos.js.map