import { readTextFileOrNull, writeTextFile } from '../util/fs.js';
import { parseJsonc } from '../resolve/tsconfig.js';
import { log } from '../util/log.js';
/**
 * Merge into a JSON config without disturbing anything else in it.
 *
 * These files belong to the user and often to their whole team. Rewriting one
 * wholesale would silently drop other MCP servers or editor settings, so we
 * read, mutate the one key we own, and write back. Some of them are JSON with
 * comments, so parsing is lenient; comments are lost on write, which is the
 * one compromise here and it is called out in the README.
 */
export async function updateJsonFile(file, mutate) {
    const existing = await readTextFileOrNull(file);
    let root = {};
    if (existing !== null && existing.trim() !== '') {
        try {
            const parsed = parseJsonc(existing);
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
                root = parsed;
            }
            else {
                log.warn(`${file} does not contain a JSON object, leaving it alone`);
                return false;
            }
        }
        catch (err) {
            log.warn(`${file} is not valid JSON (${err.message}), leaving it alone`);
            return false;
        }
    }
    const before = JSON.stringify(root);
    if (!mutate(root))
        return false;
    if (JSON.stringify(root) === before)
        return false;
    await writeTextFile(file, JSON.stringify(root, null, 2) + '\n');
    return true;
}
/** Get or create a nested object at `keys`, without replacing what is there. */
export function objectAt(root, ...keys) {
    let cursor = root;
    for (const key of keys) {
        const existing = cursor[key];
        if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
            cursor = existing;
        }
        else {
            const created = {};
            cursor[key] = created;
            cursor = created;
        }
    }
    return cursor;
}
/** Read a nested object if it is already there, without creating anything. */
export function peekObject(root, ...keys) {
    let cursor = root;
    for (const key of keys) {
        if (!cursor || typeof cursor !== 'object' || Array.isArray(cursor))
            return null;
        cursor = cursor[key];
    }
    return cursor && typeof cursor === 'object' && !Array.isArray(cursor) ? cursor : null;
}
/** Drop empty objects we created, so uninstall leaves no residue. */
export function pruneEmpty(root, ...keys) {
    for (let depth = keys.length; depth > 0; depth--) {
        const parentKeys = keys.slice(0, depth - 1);
        const leaf = keys[depth - 1];
        const parent = parentKeys.length === 0 ? root : peekObject(root, ...parentKeys);
        if (!parent)
            continue;
        const value = parent[leaf];
        if (value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === 0) {
            delete parent[leaf];
        }
    }
}
//# sourceMappingURL=jsonfile.js.map