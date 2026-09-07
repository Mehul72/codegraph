import path from 'node:path';
import { applyAliases, type PathAliases } from './tsconfig.js';

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
export function moduleCandidates(family: string, module: string, importerPath: string, facts: RepoFacts): string[] {
  switch (family) {
    case 'python':
      return pythonCandidates(module, importerPath);
    case 'go':
      return goCandidates(module, facts);
    case 'typescript':
      return typescriptCandidates(module, importerPath, facts);
    case 'java':
      return javaCandidates(module);
    default:
      return dedupe([module]);
  }
}

function pythonCandidates(module: string, importerPath: string): string[] {
  const leadingDots = /^\.+/.exec(module)?.[0].length ?? 0;
  if (leadingDots === 0) return dedupe([module, ...suffixes(module, '.')]);

  // `from . import x` starts at the importer's own package, and each extra dot
  // climbs one more level.
  const parts = importerPath.split('/');
  parts.pop();
  for (let i = 1; i < leadingDots; i++) parts.pop();

  const rest = module.slice(leadingDots);
  const base = parts.filter(Boolean).join('.');
  const joined = [base, rest].filter(Boolean).join('.');
  return dedupe([joined, ...suffixes(joined, '.'), rest].filter(Boolean));
}

function goCandidates(module: string, facts: RepoFacts): string[] {
  const out: string[] = [module];

  // An internal import is the go.mod module path plus the directory.
  if (facts.goModulePath) {
    if (module === facts.goModulePath) out.push('.');
    else if (module.startsWith(facts.goModulePath + '/')) out.push(module.slice(facts.goModulePath.length + 1));
  }

  // Without go.mod, or for a vendored path, the directory suffix still works.
  out.push(...suffixes(module, '/'));
  return dedupe(out);
}

function typescriptCandidates(module: string, importerPath: string, facts: RepoFacts): string[] {
  const bare = stripImportExtension(module);

  if (bare.startsWith('.')) {
    const dir = path.posix.dirname(importerPath);
    const joined = path.posix.normalize(path.posix.join(dir, bare));
    const clean = joined.replace(/^\.\//, '');
    return dedupe([clean, `${clean}/index`]);
  }

  const out: string[] = [];
  for (const mapped of applyAliases(facts.tsAliases, bare)) {
    out.push(mapped, `${mapped}/index`);
  }
  if (facts.tsAliases.baseUrl !== null) {
    const fromBase = path.posix.join(facts.tsAliases.baseUrl, bare).replace(/^\.\//, '');
    out.push(fromBase, `${fromBase}/index`);
  }

  // A workspace package importing a sibling by its package name lands here,
  // and so does anything in node_modules, which simply will not match.
  out.push(bare, `${bare}/index`);
  return dedupe(out);
}

/**
 * `from package import name` and `import { name } from './dir'` look like
 * symbol imports but often mean "the submodule called name": Python packages
 * expose modules that way, and a TypeScript index file re-exports from one
 * file per symbol. This builds the module key for that reading, for the two
 * families where the form exists.
 */
export function submoduleOf(family: string, module: string, symbol: string): string | null {
  switch (family) {
    case 'python':
      return `${module.replace(/\.$/, '')}.${symbol}`;
    case 'typescript':
      return `${module.replace(/\/$/, '')}/${symbol}`;
    default:
      return null;
  }
}

function javaCandidates(module: string): string[] {
  // Imports arrive already split into package plus type by the extractor, so
  // the package name is the key. The type name is matched separately.
  return dedupe([module]);
}

/** './x.js' and './x.ts' both mean the module './x'. */
function stripImportExtension(module: string): string {
  return module.replace(/\.(m|c)?(ts|js)x?$/, '');
}

/** 'a/b/c' yields 'b/c' then 'c'. Used to match paths without a known prefix. */
function suffixes(value: string, separator: string): string[] {
  const parts = value.split(separator).filter(Boolean);
  const out: string[] = [];
  for (let i = 1; i < parts.length; i++) {
    out.push(parts.slice(i).join(separator));
  }
  return out;
}

function dedupe(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (value === '' || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * Module strings that will never resolve locally. Checking these first saves a
 * few thousand pointless lookups per index on a typical repo.
 */
const STDLIB_PREFIXES = [
  'node:',
  'java.',
  'javax.',
  'jakarta.',
  'kotlin.',
  'golang.org/x/',
  'google.golang.org/',
];

const PYTHON_STDLIB = new Set([
  'abc', 'argparse', 'ast', 'asyncio', 'base64', 'collections', 'contextlib', 'copy', 'csv', 'dataclasses',
  'datetime', 'decimal', 'enum', 'functools', 'glob', 'hashlib', 'heapq', 'hmac', 'html', 'http', 'importlib',
  'inspect', 'io', 'itertools', 'json', 'logging', 'math', 'os', 'pathlib', 'pickle', 'random', 're', 'shutil',
  'signal', 'socket', 'sqlite3', 'string', 'struct', 'subprocess', 'sys', 'tempfile', 'textwrap', 'threading',
  'time', 'traceback', 'typing', 'unittest', 'urllib', 'uuid', 'warnings', 'weakref', 'zipfile',
]);

export function isDefinitelyExternal(family: string, module: string): boolean {
  if (STDLIB_PREFIXES.some((prefix) => module.startsWith(prefix))) return true;
  if (family === 'python') {
    const head = module.split('.')[0] ?? '';
    return PYTHON_STDLIB.has(head);
  }
  return false;
}
