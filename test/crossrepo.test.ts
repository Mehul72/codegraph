import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRepos, indexRepo, makeRepo, useTempHome } from './helpers.js';
import { loadConfig, saveConfig } from '../src/config/config.js';
import { loadRegistry, registerRepo, resolveRepoRef, unregisterRepo } from '../src/config/registry.js';
import { foreignCallers } from '../src/query/crossrepo.js';
import { findCallers, impactOf, type ToolContext } from '../src/query/tools.js';

beforeEach(useTempHome);
after(cleanupRepos);

/**
 * Cross-repo works because node ids are deterministic: the same symbol gets
 * the same id no matter which repo's index computed it. So a service repo that
 * links a library repo ends up holding edges that point straight into the
 * library's id space, and asking "who calls this" is a matter of asking the
 * other databases the same question. These tests hold that property down.
 */

const LIBRARY = {
  'go.mod': 'module github.com/acme/toolkit\n\ngo 1.22\n',
  'text/text.go': [
    'package text',
    '',
    '// Slugify lowercases and hyphenates a string.',
    'func Slugify(s string) string {',
    '\treturn s',
    '}',
    '',
    'func Trim(s string) string {',
    '\treturn s',
    '}',
    '',
  ].join('\n'),
};

const SERVICE = {
  'go.mod': 'module github.com/acme/api\n\ngo 1.22\n\nrequire github.com/acme/toolkit v1.0.0\n',
  'handler/handler.go': [
    'package handler',
    '',
    'import "github.com/acme/toolkit/text"',
    '',
    'func Handle(name string) string {',
    '\treturn text.Slugify(name)',
    '}',
    '',
  ].join('\n'),
};

/** Index the library, then link it from the service and index that. */
async function linkedPair() {
  const libRoot = await makeRepo('toolkit', LIBRARY);
  const libIndexed = await indexRepo(libRoot);
  libIndexed.close();
  await registerRepo('toolkit', libRoot);

  const svcRoot = await makeRepo('api', SERVICE);
  const svcConfig = await loadConfig(svcRoot);
  await saveConfig(svcRoot, { ...svcConfig, links: [libRoot] });
  const svcIndexed = await indexRepo(svcRoot);
  await registerRepo('api', svcRoot);

  return { libRoot, svcRoot, service: svcIndexed };
}

test('a repo is registered under its name and found by name or path', async () => {
  const root = await makeRepo('widgets', { 'main.py': 'def go():\n    return 1\n' });
  const indexed = await indexRepo(root);
  indexed.close();
  await registerRepo('widgets', root);

  const byName = await resolveRepoRef('widgets');
  assert.equal(byName?.root, root);
  const byPath = await resolveRepoRef(root);
  assert.equal(byPath?.name, 'widgets');
  assert.equal(await resolveRepoRef('nothing-like-this'), null);
});

test('registering the same repo twice updates it instead of duplicating it', async () => {
  const root = await makeRepo('once', { 'main.py': 'def go():\n    return 1\n' });
  await registerRepo('once', root);
  await registerRepo('renamed', root);

  const registry = await loadRegistry();
  const mine = registry.repos.filter((r) => r.root === root);
  assert.equal(mine.length, 1);
  assert.equal(mine[0]?.name, 'renamed');
});

test('unlinking a repo removes it and says whether it did anything', async () => {
  const root = await makeRepo('temporary', { 'main.py': 'def go():\n    return 1\n' });
  await registerRepo('temporary', root);

  assert.equal(await unregisterRepo(root), true);
  assert.equal(await unregisterRepo(root), false, 'a second unlink has nothing to do');
  assert.equal((await loadRegistry()).repos.some((r) => r.root === root), false);
});

test('an unreadable registry is treated as empty rather than crashing', async () => {
  const { writeFile } = await import('node:fs/promises');
  const { registryPath } = await import('../src/config/paths.js');
  const { ensureDir } = await import('../src/util/fs.js');
  const { globalDir } = await import('../src/config/paths.js');

  await ensureDir(globalDir());
  await writeFile(registryPath(), '{ this is not json', 'utf8');

  const registry = await loadRegistry();
  assert.deepEqual(registry.repos, []);
});

test('an import satisfied by a linked repo becomes a resolved edge', async () => {
  const { service } = await linkedPair();

  const edges = service.store.outgoing(service.store.allNodesLite().map((n) => n.id));
  const foreign = edges.filter((e) => e.dstId.startsWith('toolkit:'));
  assert.ok(foreign.length > 0, 'the service should link into the toolkit id space');
  for (const edge of foreign) {
    assert.equal(edge.confidence, 'resolved', 'package identity is evidence, so these are resolved');
  }
  service.close();
});

test('a linked repo symbol is copied in as a stub tagged with its owning repo', async () => {
  const { service } = await linkedPair();

  const stub = service.store.getNode('toolkit:text/text.go:function:Slugify');
  assert.ok(stub, 'Slugify should be present as a stub');
  assert.equal(stub.repo, 'toolkit', 'the stub remembers which repo owns it');
  assert.equal(stub.path, 'text/text.go', 'and where it lives over there');
  service.close();
});

test('stubs from a linked repo stay out of local search and counts', async () => {
  const { service } = await linkedPair();

  const local = service.store.allNodesLite();
  assert.equal(
    local.some((n) => n.name === 'Slugify'),
    false,
    'another repo\'s symbols should not show up when browsing this one',
  );
  assert.equal(service.store.nodeCount(), local.length, 'stubs are not counted as this repo\'s symbols');
  service.close();
});

test('the library can see its callers in the service without opening its database', async () => {
  const { libRoot, service } = await linkedPair();
  service.close();

  const library = await indexRepo(libRoot);
  const slugify = library.store.allNodesLite().find((n) => n.name === 'Slugify');
  assert.ok(slugify);

  const callers = await foreignCallers(libRoot, [slugify.id]);
  assert.equal(callers.length, 1, 'exactly one repo calls it');
  assert.equal(callers[0]?.repo, 'api');
  assert.equal(callers[0]?.node.name, 'Handle');
  library.close();
});

test('find_callers labels which repo each caller lives in', async () => {
  const { libRoot, service } = await linkedPair();
  service.close();

  const library = await indexRepo(libRoot);
  const ctx: ToolContext = {
    store: library.store,
    repo: 'toolkit',
    repoRoot: libRoot,
    defaultBudget: 2000,
    hasLinks: true,
  };

  const out = await findCallers(ctx, { symbol: 'Slugify' });
  assert.match(out, /other repos/);
  assert.match(out, /\bapi\b/);
  assert.match(out, /Handle/);
  library.close();
});

test('a symbol called only from another repo reads cleanly', async () => {
  const { libRoot, service } = await linkedPair();
  service.close();

  const library = await indexRepo(libRoot);
  const ctx: ToolContext = {
    store: library.store,
    repo: 'toolkit',
    repoRoot: libRoot,
    defaultBudget: 2000,
    hasLinks: true,
  };

  const out = await findCallers(ctx, { symbol: 'Slugify' });
  assert.match(out, /none in this repo/);
  assert.match(out, /other repos/);
  // The count line only makes sense when there is something to count.
  assert.doesNotMatch(out, /0 symbols/);

  // A line ending in a colon is a heading, so something has to follow it.
  const lines = out.split('\n');
  lines.forEach((line, i) => {
    if (!line.trimEnd().endsWith(':')) return;
    const next = lines[i + 1] ?? '';
    assert.ok(next.startsWith('  '), `"${line.trim()}" introduces nothing`);
  });
  library.close();
});

test('cross_repo=false keeps the answer to this repo', async () => {
  const { libRoot, service } = await linkedPair();
  service.close();

  const library = await indexRepo(libRoot);
  const ctx: ToolContext = {
    store: library.store,
    repo: 'toolkit',
    repoRoot: libRoot,
    defaultBudget: 2000,
    hasLinks: true,
  };

  const out = await findCallers(ctx, { symbol: 'Slugify', cross_repo: false });
  assert.doesNotMatch(out, /other repos/);
  library.close();
});

test('impact_of counts the other repo when links exist', async () => {
  const { libRoot, service } = await linkedPair();
  service.close();

  const library = await indexRepo(libRoot);
  const ctx: ToolContext = {
    store: library.store,
    repo: 'toolkit',
    repoRoot: libRoot,
    defaultBudget: 2000,
    hasLinks: true,
  };

  const out = await impactOf(ctx, { target: 'Slugify' });
  assert.match(out, /other repos/);
  assert.match(out, /Handle/);
  library.close();
});

test('a link to a repo with no index yet is a warning, not a failure', async () => {
  const libRoot = await makeRepo('unindexed', LIBRARY);
  const svcRoot = await makeRepo('needs-it', SERVICE);
  const config = await loadConfig(svcRoot);
  await saveConfig(svcRoot, { ...config, links: [libRoot] });

  // Never indexed the library, so there is nothing to resolve against.
  const service = await indexRepo(svcRoot);
  assert.ok(service.stats.nodes > 0, 'the service still indexes fine on its own');
  service.close();
});

test('an unused symbol from the other repo is not copied over at all', async () => {
  const { service } = await linkedPair();
  // Trim exists in the toolkit but nothing here calls it, so there is no
  // reason to hold a copy.
  assert.equal(service.store.getNode('toolkit:text/text.go:function:Trim'), null);
  service.close();
});

test('a call through a linked module is resolved, not a name match', async () => {
  const { service } = await linkedPair();

  const call = service.store
    .outgoing(service.store.allNodesLite().map((n) => n.id))
    .find((e) => e.type === 'calls' && e.dstId.endsWith(':function:Slugify'));

  assert.ok(call, 'Handle should call Slugify');
  assert.equal(
    call.confidence,
    'resolved',
    'the import names the package, so the member lookup is evidence rather than a guess',
  );
  service.close();
});
