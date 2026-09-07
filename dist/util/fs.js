import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
export async function pathExists(target) {
    try {
        await fsp.access(target);
        return true;
    }
    catch {
        return false;
    }
}
export function pathExistsSync(target) {
    return fs.existsSync(target);
}
export async function ensureDir(dir) {
    await fsp.mkdir(dir, { recursive: true });
}
export async function readTextFileOrNull(file) {
    try {
        return await fsp.readFile(file, 'utf8');
    }
    catch {
        return null;
    }
}
/**
 * Write UTF-8 with LF endings through a temp file and a rename, so a crash
 * halfway through never leaves a half-written config behind.
 */
export async function writeTextFile(file, contents) {
    await ensureDir(path.dirname(file));
    const tmp = `${file}.codegraph-tmp-${process.pid}`;
    await fsp.writeFile(tmp, contents, { encoding: 'utf8' });
    await fsp.rename(tmp, file);
}
export function hashContent(text) {
    return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}
/** Repo-relative path with forward slashes, so ids match across platforms. */
export function toPosix(relPath) {
    return relPath.split(path.sep).join('/');
}
/** True when `child` is inside `parent` (or is `parent` itself). */
export function isInside(parent, child) {
    const rel = path.relative(parent, child);
    return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}
//# sourceMappingURL=fs.js.map