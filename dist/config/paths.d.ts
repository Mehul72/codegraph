export declare const INDEX_DIR_NAME = ".codegraph";
export declare const CONFIG_FILE_NAME = "codegraph.config.json";
export declare const DB_FILE_NAME = "graph.db";
/**
 * Walk up looking for a .git directory. Falls back to the starting directory
 * so codegraph still works in a folder that was never a git repo.
 */
export declare function findRepoRoot(startDir?: string): string;
export declare function indexDir(repoRoot: string): string;
export declare function dbPath(repoRoot: string): string;
export declare function configPath(repoRoot: string): string;
/** Everything global lives here: the cross-repo registry and nothing else. */
export declare function globalDir(): string;
export declare function registryPath(): string;
export declare function codexConfigPath(): string;
