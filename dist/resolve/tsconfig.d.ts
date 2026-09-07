export interface PathAliases {
    /** posix, relative to the repo root, no trailing slash. */
    baseUrl: string | null;
    /** Pattern from tsconfig `paths` mapped to repo-relative targets. */
    entries: Array<{
        pattern: string;
        targets: string[];
    }>;
}
export declare const NO_ALIASES: PathAliases;
/**
 * tsconfig.json is JSON with comments and trailing commas, and TypeScript
 * itself is lenient about both. Strip them rather than pulling in a parser.
 */
export declare function parseJsonc(text: string): unknown;
/**
 * Read tsconfig path aliases so that `import { x } from '@app/thing'` can be
 * resolved to a real file. Follows `extends` a couple of levels, which covers
 * the usual base-config setup without risking a cycle.
 */
export declare function loadPathAliases(repoRoot: string, configFile?: string): PathAliases;
/** Apply tsconfig `paths` to an import string, returning candidate prefixes. */
export declare function applyAliases(aliases: PathAliases, module: string): string[];
/** The `module` line from go.mod, which prefixes every internal import path. */
export declare function loadGoModulePath(repoRoot: string): string | null;
/** The `name` field from package.json, used to match cross-repo imports. */
export declare function loadPackageName(repoRoot: string): string | null;
