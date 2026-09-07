import path from 'node:path';
import { Store } from '../store/store.js';
import { dbPath } from '../config/paths.js';
import { loadRegistry } from '../config/registry.js';
import { pathExistsSync } from '../util/fs.js';
import { log } from '../util/log.js';
/**
 * Callers that live in other repos.
 *
 * When repo B links to repo A, B's index holds edges whose destination is A's
 * node id, plus a stub copy of the A node. So finding A's outside callers is a
 * matter of asking every other registered repo for inbound edges on the same
 * id. Ids are deterministic, which is what makes this work without a shared
 * database.
 */
export async function foreignCallers(selfRoot, ids) {
    if (ids.length === 0)
        return [];
    const registry = await loadRegistry();
    const selfAbs = path.resolve(selfRoot);
    const out = [];
    for (const entry of registry.repos) {
        if (path.resolve(entry.root) === selfAbs)
            continue;
        const file = dbPath(entry.root);
        if (!pathExistsSync(file))
            continue;
        let store = null;
        try {
            store = Store.open(file, { readOnly: true });
            const edges = store.incoming(ids);
            if (edges.length === 0)
                continue;
            const callers = new Map(store.getNodes(edges.map((e) => e.srcId)).map((n) => [n.id, n]));
            for (const edge of edges) {
                const node = callers.get(edge.srcId);
                if (node)
                    out.push({ repo: entry.name, node, edge });
            }
        }
        catch (err) {
            log.debug(`skipping linked repo ${entry.name}: ${err.message}`);
        }
        finally {
            store?.close();
        }
    }
    out.sort((a, b) => a.repo.localeCompare(b.repo) || a.node.path.localeCompare(b.node.path) || a.node.lineStart - b.node.lineStart);
    return out;
}
//# sourceMappingURL=crossrepo.js.map