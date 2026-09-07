export declare function isGitRepo(repoRoot: string): boolean;
export declare class GitError extends Error {
    constructor(message: string);
}
/**
 * Files that differ from a ref, including working tree changes that are not
 * committed yet. That matters here: an agent asking "what did I change" has
 * usually not committed anything.
 *
 * Untracked files count too. `git diff` cannot see them, and leaving them out
 * meant a file the agent had just written was missing from the one answer
 * whose whole job is to describe what it had just done.
 */
export declare function changedFilesSince(repoRoot: string, ref: string): Promise<string[]>;
/** Short head description, used in status output. */
export declare function describeHead(repoRoot: string): Promise<string | null>;
