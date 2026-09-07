import path from 'node:path';
import { Store } from '../store/store.js';
import { dbPath } from '../config/paths.js';
import { loadGoModulePath, loadPackageName, loadPathAliases, NO_ALIASES } from './tsconfig.js';
import { moduleCandidates, type RepoFacts } from './modules.js';
import { pathExistsSync } from '../util/fs.js';
import { log } from '../util/log.js';
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
export function openLinks(config: CodegraphConfig): LinkedRepo[] {
  const out: LinkedRepo[] = [];
  for (const link of config.links) {
    const root = path.resolve(link);
    const db = dbPath(root);
    if (!pathExistsSync(db)) {
      log.warn(`linked repo ${link} has no index yet, run 'codegraph index' there`);
      continue;
    }
    try {
      const store = Store.open(db, { readOnly: true });
      const facts: RepoFacts = {
        repoRoot: root,
        goModulePath: loadGoModulePath(root),
        packageName: loadPackageName(root),
        tsAliases: pathExistsSync(path.join(root, 'tsconfig.json')) ? loadPathAliases(root) : NO_ALIASES,
      };
      const name = store.getMeta('repo') ?? path.basename(root);
      out.push({ name, root, store, facts, packagePrefixes: prefixesFor(facts) });
    } catch (err) {
      log.warn(`could not read the index for ${link}: ${(err as Error).message}`);
    }
  }
  return out;
}

export function closeLinks(links: readonly LinkedRepo[]): void {
  for (const link of links) link.store.close();
}

function prefixesFor(facts: RepoFacts): string[] {
  const prefixes = [facts.goModulePath, facts.packageName].filter((p): p is string => Boolean(p));
  return prefixes.sort((a, b) => b.length - a.length);
}

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
export function resolveImportAcrossRepos(
  links: readonly LinkedRepo[],
  family: string,
  module: string,
  symbol: string | null,
): CrossRepoHit | null {
  for (const link of links) {
    const candidates = new Set<string>();

    for (const prefix of link.packagePrefixes) {
      if (module === prefix) candidates.add('.');
      else if (module.startsWith(prefix + '/')) candidates.add(module.slice(prefix.length + 1));
      else if (module.startsWith(prefix + '.')) candidates.add(module.slice(prefix.length + 1));
    }
    for (const candidate of moduleCandidates(family, module, '', link.facts)) {
      candidates.add(candidate);
    }

    for (const candidate of candidates) {
      const files = link.store.filesForModule(family, candidate);
      const target = files[0];
      if (!target) continue;

      if (symbol) {
        const match = link.store.nodesInFile(target).find((n) => n.name === symbol && n.kind !== 'module');
        if (match) return { link, node: match };
      }
      const moduleNode = link.store.nodesInFile(target).find((n) => n.kind === 'module');
      if (moduleNode) return { link, node: moduleNode };
    }
  }
  return null;
}

/**
 * A member of something that lives in a linked repo, such as `text.Slugify()`
 * after `import "github.com/acme/toolkit/text"`. The import already told us
 * which repo and file to look in, so this is a lookup rather than a guess.
 */
export function resolveMemberAcrossRepos(link: LinkedRepo, filePath: string, name: string): CrossRepoHit | null {
  const match = link.store.nodesInFile(filePath).find((n) => n.name === name && n.kind !== 'module');
  return match ? { link, node: match } : null;
}

/**
 * A member on a type from a linked repo, found by its qualified name so that
 * `Client.Do` does not collide with a free function called `Do`.
 */
export function resolveQualifiedAcrossRepos(link: LinkedRepo, filePath: string, qualified: string): CrossRepoHit | null {
  const match = link.store.nodesInFile(filePath).find((n) => n.qualified === qualified);
  return match ? { link, node: match } : null;
}

/**
 * Once an import has landed in a linked repo, later bare-name references to
 * the same symbol should land there too. Only exported symbols qualify, and
 * only when exactly one repo offers the name, so this stays quiet.
 */
export function resolveNameAcrossRepos(links: readonly LinkedRepo[], name: string): CrossRepoHit | null {
  const hits: CrossRepoHit[] = [];
  for (const link of links) {
    for (const node of link.store.nodesByName(name)) {
      if (!node.exported || node.kind === 'module') continue;
      hits.push({ link, node });
    }
  }
  return hits.length === 1 ? (hits[0] as CrossRepoHit) : null;
}
