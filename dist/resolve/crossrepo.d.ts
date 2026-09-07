import { Store } from '../store/store.js';
import { type RepoFacts } from './modules.js';
import type { CodegraphConfig } from '../config/config.js';
import type { GraphNode } from '../types.js';
export interface LinkedRepo {
    name: string;
    root: string;
    store: Store;
    facts: RepoFacts;
    /** Package identifiers this repo publishes, longest first. */
    packagePrefixes: string[];
}
/**
 * Open every linked repo's index read-only. A link with no index yet is a
 * warning, not an error: the user may not have run `codegraph index` there.
 */
export declare function openLinks(config: CodegraphConfig): LinkedRepo[];
export declare function closeLinks(links: readonly LinkedRepo[]): void;
export interface CrossRepoHit {
    /** The repo that owns the symbol, kept so its index can be queried again. */
    link: LinkedRepo;
    node: GraphNode;
}
/**
 * Try to satisfy an import from a linked repo. Matching is by package
 * identity: the go.mod module path or the package.json name, stripped off the
 * front of the import string before we consult that repo's module table.
 */
export declare function resolveImportAcrossRepos(links: readonly LinkedRepo[], family: string, module: string, symbol: string | null): CrossRepoHit | null;
/**
 * A member of something that lives in a linked repo, such as `text.Slugify()`
 * after `import "github.com/acme/toolkit/text"`. The import already told us
 * which repo and file to look in, so this is a lookup rather than a guess.
 */
export declare function resolveMemberAcrossRepos(link: LinkedRepo, filePath: string, name: string): CrossRepoHit | null;
/**
 * A member on a type from a linked repo, found by its qualified name so that
 * `Client.Do` does not collide with a free function called `Do`.
 */
export declare function resolveQualifiedAcrossRepos(link: LinkedRepo, filePath: string, qualified: string): CrossRepoHit | null;
/**
 * Once an import has landed in a linked repo, later bare-name references to
 * the same symbol should land there too. Only exported symbols qualify, and
 * only when exactly one repo offers the name, so this stays quiet.
 */
export declare function resolveNameAcrossRepos(links: readonly LinkedRepo[], name: string): CrossRepoHit | null;
