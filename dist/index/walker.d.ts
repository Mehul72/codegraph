export interface WalkedFile {
    /** Repo-relative, forward slashes. */
    relPath: string;
    absPath: string;
    size: number;
    mtimeMs: number;
}
export interface WalkOptions {
    repoRoot: string;
    /** Extra patterns from codegraph.config.json. */
    extraIgnore?: readonly string[];
    /** Limit the walk to these repo-relative subtrees. */
    only?: readonly string[];
}
/**
 * Walk the repo, honouring .gitignore (including nested ones), a
 * .codegraphignore, and config patterns. Returns files in a stable order so
 * two indexes of the same tree produce identical output.
 */
export declare function walkRepo(options: WalkOptions): Promise<WalkedFile[]>;
