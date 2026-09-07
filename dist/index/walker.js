import fsp from 'node:fs/promises';
import path from 'node:path';
import ignore from 'ignore';
import { readTextFileOrNull, toPosix } from '../util/fs.js';
import { log } from '../util/log.js';
import { INDEX_DIR_NAME } from '../config/paths.js';
/**
 * Directories we never descend into, regardless of ignore files. These show up
 * in nearly every repo and walking them is pure waste.
 */
const ALWAYS_SKIP_DIRS = new Set([
    '.git',
    '.hg',
    '.svn',
    INDEX_DIR_NAME,
    'node_modules',
    '.venv',
    'venv',
    '__pycache__',
    '.mypy_cache',
    '.pytest_cache',
    '.ruff_cache',
    '.tox',
    'dist',
    'build',
    'target',
    'vendor',
    '.next',
    '.nuxt',
    '.turbo',
    '.gradle',
    '.idea',
    '.vscode-test',
    'coverage',
    '.terraform',
]);
/**
 * Walk the repo, honouring .gitignore (including nested ones), a
 * .codegraphignore, and config patterns. Returns files in a stable order so
 * two indexes of the same tree produce identical output.
 */
export async function walkRepo(options) {
    const { repoRoot } = options;
    const rootLayers = [];
    const rootPatterns = [...(options.extraIgnore ?? [])];
    for (const name of ['.gitignore', '.codegraphignore']) {
        const text = await readTextFileOrNull(path.join(repoRoot, name));
        if (text !== null)
            rootPatterns.push(...toPatterns(text));
    }
    if (rootPatterns.length > 0) {
        rootLayers.push({ base: '', matcher: ignore().add(rootPatterns) });
    }
    const results = [];
    const roots = options.only && options.only.length > 0 ? [...options.only] : [''];
    for (const start of roots) {
        // A scope is just as often a single file as a directory: the CLI takes
        // `codegraph index src/app.ts`, and the agent edit hooks pass the exact
        // file that was written. Handing a file to descend() only produced an
        // ENOTDIR that was logged at debug and swallowed, so the whole run
        // indexed nothing and still reported success.
        if (start !== '' && !(await isDirectory(path.join(repoRoot, start)))) {
            await addFile(repoRoot, start, rootLayers, results);
            continue;
        }
        await descend(repoRoot, start, rootLayers, results);
    }
    results.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
    return results;
}
async function isDirectory(absPath) {
    try {
        return (await fsp.stat(absPath)).isDirectory();
    }
    catch {
        return false;
    }
}
/**
 * Record one file, if the ignore rules allow it and it is still there. A
 * missing file is not an error: a scoped run is often handed a path that was
 * just deleted, and planWork removes it from the index by not seeing it here.
 */
async function addFile(repoRoot, rel, layers, out) {
    if (isTempName(path.posix.basename(rel)) || isIgnored(layers, rel, false))
        return;
    const absPath = path.join(repoRoot, rel);
    let stat;
    try {
        stat = await fsp.stat(absPath);
    }
    catch {
        return;
    }
    if (!stat.isFile())
        return;
    out.push({ relPath: toPosix(rel), absPath, size: stat.size, mtimeMs: stat.mtimeMs });
}
async function descend(repoRoot, relDir, layers, out) {
    const absDir = relDir ? path.join(repoRoot, relDir) : repoRoot;
    let entries;
    try {
        entries = await fsp.readdir(absDir, { withFileTypes: true });
    }
    catch (err) {
        log.debug(`skipping ${relDir || '.'}: ${err.message}`);
        return;
    }
    // A nested ignore file applies to this directory and everything under it.
    let localLayers = layers;
    const nested = [];
    for (const name of ['.gitignore', '.codegraphignore']) {
        if (!entries.some((e) => e.isFile() && e.name === name))
            continue;
        const text = await readTextFileOrNull(path.join(absDir, name));
        if (text !== null)
            nested.push(...toPatterns(text));
    }
    if (nested.length > 0 && relDir !== '') {
        localLayers = [...layers, { base: relDir, matcher: ignore().add(nested) }];
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
        if (isTempName(entry.name))
            continue;
        const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
            if (ALWAYS_SKIP_DIRS.has(entry.name))
                continue;
            if (isIgnored(localLayers, rel, true))
                continue;
            await descend(repoRoot, rel, localLayers, out);
            continue;
        }
        // Symlinks are skipped: following them invites cycles and duplicate
        // symbols, and the real file is almost always in the tree anyway.
        if (!entry.isFile())
            continue;
        if (isIgnored(localLayers, rel, false))
            continue;
        let stat;
        try {
            stat = await fsp.stat(path.join(absDir, entry.name));
        }
        catch {
            continue;
        }
        out.push({
            relPath: toPosix(rel),
            absPath: path.join(absDir, entry.name),
            size: stat.size,
            mtimeMs: stat.mtimeMs,
        });
    }
}
/**
 * Split an ignore file into one pattern per line.
 *
 * This has to happen before the patterns reach the matcher. Handing it an
 * array whose elements each hold a whole file treats every file as a single
 * pattern, which matches nothing at all and does it quietly, so a repo's
 * ignore rules look applied while every excluded directory gets indexed.
 */
function toPatterns(text) {
    return text
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line !== '' && !line.startsWith('#'));
}
/**
 * Half-written files from util/fs writeTextFile, which names them
 * `<file>.codegraph-tmp-<pid>`. The suffix is what identifies them: matching
 * on a prefix instead never fired, so a config being rewritten during a walk
 * could be picked up mid-rename.
 */
function isTempName(name) {
    return name.includes('.codegraph-tmp-');
}
function isIgnored(layers, relPath, isDir) {
    for (const layer of layers) {
        let candidate = relPath;
        if (layer.base !== '') {
            if (!relPath.startsWith(layer.base + '/'))
                continue;
            candidate = relPath.slice(layer.base.length + 1);
        }
        if (candidate === '')
            continue;
        if (layer.matcher.ignores(isDir ? candidate + '/' : candidate))
            return true;
    }
    return false;
}
//# sourceMappingURL=walker.js.map