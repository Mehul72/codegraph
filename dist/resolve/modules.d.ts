import { type PathAliases } from './tsconfig.js';
/**
 * Repo-level facts that import resolution needs. Gathered once per index pass
 * because reading go.mod and tsconfig.json for every import would dominate the
 * warm-reindex budget.
 */
export interface RepoFacts {
    repoRoot: string;
    goModulePath: string | null;
    packageName: string | null;
    tsAliases: PathAliases;
}
/**
 * Turn an import string into the module keys we should look up, in priority
 * order. The modules table holds what each file answers to; this side decides
 * what the importer is actually asking for.
 *
 * Everything here is a heuristic by necessity. Python resolves against
 * sys.path, Go against the module cache, TypeScript against node resolution
 * plus tsconfig, and none of that is knowable from the source tree alone. So
 * we generate candidates from most specific to least and let the first hit
 * win, which keeps false positives down without needing a build system.
 */
export declare function moduleCandidates(family: string, module: string, importerPath: string, facts: RepoFacts): string[];
/**
 * `from package import name` and `import { name } from './dir'` look like
 * symbol imports but often mean "the submodule called name": Python packages
 * expose modules that way, and a TypeScript index file re-exports from one
 * file per symbol. This builds the module key for that reading, for the two
 * families where the form exists.
 */
export declare function submoduleOf(family: string, module: string, symbol: string): string | null;
export declare function isDefinitelyExternal(family: string, module: string): boolean;
