import path from 'node:path';
import fs from 'node:fs';
import { toPosix } from '../util/fs.js';
import { log } from '../util/log.js';
export const NO_ALIASES = { baseUrl: null, entries: [] };
/**
 * tsconfig.json is JSON with comments and trailing commas, and TypeScript
 * itself is lenient about both. Strip them rather than pulling in a parser.
 */
export function parseJsonc(text) {
    let out = '';
    let inString = false;
    let quote = '';
    let inLine = false;
    let inBlock = false;
    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        const next = text[i + 1];
        if (inLine) {
            if (ch === '\n') {
                inLine = false;
                out += ch;
            }
            continue;
        }
        if (inBlock) {
            if (ch === '*' && next === '/') {
                inBlock = false;
                i++;
            }
            else if (ch === '\n') {
                out += ch;
            }
            continue;
        }
        if (inString) {
            out += ch;
            if (ch === '\\') {
                const escaped = text[i + 1];
                if (escaped !== undefined) {
                    out += escaped;
                    i++;
                }
            }
            else if (ch === quote) {
                inString = false;
            }
            continue;
        }
        if (ch === '"' || ch === "'") {
            inString = true;
            quote = ch;
            out += ch;
            continue;
        }
        if (ch === '/' && next === '/') {
            inLine = true;
            i++;
            continue;
        }
        if (ch === '/' && next === '*') {
            inBlock = true;
            i++;
            continue;
        }
        out += ch;
    }
    // Trailing commas are the other thing tsc tolerates.
    return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}
/**
 * Read tsconfig path aliases so that `import { x } from '@app/thing'` can be
 * resolved to a real file. Follows `extends` a couple of levels, which covers
 * the usual base-config setup without risking a cycle.
 */
export function loadPathAliases(repoRoot, configFile = 'tsconfig.json') {
    const visited = new Set();
    let current = path.join(repoRoot, configFile);
    let baseUrl = null;
    const entries = [];
    for (let depth = 0; current && depth < 4; depth++) {
        const abs = current;
        if (visited.has(abs) || !fs.existsSync(abs))
            break;
        visited.add(abs);
        let parsed;
        try {
            parsed = parseJsonc(fs.readFileSync(abs, 'utf8'));
        }
        catch (err) {
            log.debug(`could not read ${abs}: ${err.message}`);
            break;
        }
        const options = (parsed.compilerOptions ?? {});
        const configDir = path.dirname(abs);
        if (baseUrl === null && typeof options.baseUrl === 'string') {
            baseUrl = toPosix(path.relative(repoRoot, path.resolve(configDir, options.baseUrl)));
        }
        if (options.paths && typeof options.paths === 'object') {
            // The base for `paths` is baseUrl when set, otherwise the config's own
            // directory, which is what tsc does for a config without baseUrl.
            const aliasBase = typeof options.baseUrl === 'string' ? path.resolve(configDir, options.baseUrl) : configDir;
            for (const [pattern, value] of Object.entries(options.paths)) {
                if (!Array.isArray(value))
                    continue;
                const targets = value
                    .filter((v) => typeof v === 'string')
                    .map((v) => toPosix(path.relative(repoRoot, path.resolve(aliasBase, v))));
                if (targets.length > 0)
                    entries.push({ pattern, targets });
            }
        }
        const extendsValue = parsed.extends;
        current = typeof extendsValue === 'string' ? resolveExtends(configDir, extendsValue) : null;
    }
    return { baseUrl, entries };
}
function resolveExtends(configDir, target) {
    if (target.startsWith('.')) {
        const resolved = path.resolve(configDir, target);
        return resolved.endsWith('.json') ? resolved : `${resolved}.json`;
    }
    // Package-based configs live in node_modules, which we do not index.
    return null;
}
/** Apply tsconfig `paths` to an import string, returning candidate prefixes. */
export function applyAliases(aliases, module) {
    const out = [];
    for (const entry of aliases.entries) {
        const star = entry.pattern.indexOf('*');
        if (star === -1) {
            if (entry.pattern === module)
                out.push(...entry.targets);
            continue;
        }
        const prefix = entry.pattern.slice(0, star);
        const suffix = entry.pattern.slice(star + 1);
        if (!module.startsWith(prefix) || !module.endsWith(suffix))
            continue;
        const middle = module.slice(prefix.length, module.length - suffix.length);
        for (const target of entry.targets) {
            out.push(target.includes('*') ? target.replace('*', middle) : target);
        }
    }
    return out;
}
/** The `module` line from go.mod, which prefixes every internal import path. */
export function loadGoModulePath(repoRoot) {
    const file = path.join(repoRoot, 'go.mod');
    if (!fs.existsSync(file))
        return null;
    try {
        const text = fs.readFileSync(file, 'utf8');
        const match = /^\s*module\s+(\S+)/m.exec(text);
        return match?.[1] ?? null;
    }
    catch {
        return null;
    }
}
/** The `name` field from package.json, used to match cross-repo imports. */
export function loadPackageName(repoRoot) {
    const file = path.join(repoRoot, 'package.json');
    if (!fs.existsSync(file))
        return null;
    try {
        const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
        return typeof parsed.name === 'string' ? parsed.name : null;
    }
    catch {
        return null;
    }
}
//# sourceMappingURL=tsconfig.js.map