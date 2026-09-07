export interface HookReport {
    changed: string[];
    notes: string[];
}
/**
 * Opt in only, and never enabled by `init`.
 *
 * The staleness check on every query already keeps the index correct, so
 * these hooks exist purely to move the work off the query path after a commit
 * or a branch switch. They background themselves and swallow their own output:
 * a git hook that can slow down or fail a commit is not worth having.
 *
 * The block is spliced in through markers.ts rather than by hand. Doing it
 * here meant a second copy of the same logic, and the copy was missing the
 * guard for a start marker whose end marker had been deleted: indexOf
 * returned -1, the slice ran from a negative offset, and both install and
 * uninstall cut a arbitrary run of characters out of the user's hook script.
 */
export declare function installGitHooks(repoRoot: string, command: string): Promise<HookReport>;
export declare function uninstallGitHooks(repoRoot: string): Promise<HookReport>;
