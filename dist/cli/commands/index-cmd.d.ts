import type { IndexStats } from '../../types.js';
export interface IndexCommandOptions {
    force?: boolean;
    quiet?: boolean;
}
export declare function indexCommand(paths: string[], options: IndexCommandOptions): Promise<void>;
export declare function toRepoRelative(repoRoot: string, target: string): string;
export declare function formatStats(stats: IndexStats): string;
/**
 * The index is disposable and rebuildable in one command, so it does not
 * belong in git. Own .codegraph/.gitignore rather than editing the user's.
 */
export declare function writeIndexGitignore(repoRoot: string): Promise<void>;
