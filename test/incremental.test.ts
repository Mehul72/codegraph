import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRepos, deleteFile, indexRepo, makeRepo, snapshot, useTempHome, writeFile } from './helpers.js';

await useTempHome();
after(cleanupRepos);

/**
 * The worst bug this tool can have is a stale graph that answers confidently
 * with the wrong thing. So the incremental path is held to one standard: after
 * any change, the graph must equal what a from-scratch index of the same tree
 * would produce. Every test here is a variation on that comparison.
 */

const BASE: Record<string, string> = {
  'pkg/__init__.py': '',
  'pkg/models.py': [
    'LIMIT = 10',
    '',
    'class Order:',
    '    def total(self):',
    '        return 0',
    '',
    'def make_order():',
    '    return Order()',
    '',
  ].join('\n'),
  'pkg/service.py': [
    'from pkg.models import LIMIT, Order, make_order',
    '',
    '',
    'def process():',
    '    order = make_order()',
    '    return order.total() + LIMIT',
    '',
  ].join('\n'),
  'pkg/api.py': [
    'from pkg.service import process',
    '',
    '',
    'def handle():',
    '    return process()',
    '',
  ].join('\n'),
};

/**
 * Apply `change` two ways: to an already indexed repo, and to a fresh copy
 * that has never been indexed. Both repos are named the same, because the repo
 * name is part of every node id and the two graphs have to be comparable.
 */
async function graphAfterChange(change: (root: string) => Promise<void>) {
  const incremental = await makeRepo('sample', BASE);
  const first = await indexRepo(incremental);
  first.close();
  await change(incremental);
  const updated = await indexRepo(incremental);
  const incrementalGraph = snapshot(updated.store);
  updated.close();

  const fromScratch = await makeRepo('sample', BASE);
  await change(fromScratch);
  const cold = await indexRepo(fromScratch);
  const coldGraph = snapshot(cold.store);
  cold.close();

  return { incrementalGraph, coldGraph };
}

test('reindex after editing a file matches a cold index', async () => {
  const { incrementalGraph, coldGraph } = await graphAfterChange(async (root) => {
    await writeFile(
      root,
      'pkg/models.py',
      [
        'LIMIT = 20',
        '',
        'class Order:',
        '    def total(self):',
        '        return 1',
        '',
        '    def tax(self):',
        '        return self.total() * 2',
        '',
        'def make_order():',
        '    return Order()',
        '',
      ].join('\n'),
    );
  });

  assert.deepEqual(incrementalGraph.nodes, coldGraph.nodes);
  assert.deepEqual(incrementalGraph.edges, coldGraph.edges);
  assert.deepEqual(incrementalGraph.modules, coldGraph.modules);
});

test('reindex after renaming a called function matches a cold index', async () => {
  const { incrementalGraph, coldGraph } = await graphAfterChange(async (root) => {
    await writeFile(
      root,
      'pkg/models.py',
      ['LIMIT = 10', '', 'class Order:', '    def total(self):', '        return 0', '', 'def build_order():', '    return Order()', ''].join('\n'),
    );
    await writeFile(
      root,
      'pkg/service.py',
      [
        'from pkg.models import LIMIT, Order, build_order',
        '',
        '',
        'def process():',
        '    order = build_order()',
        '    return order.total() + LIMIT',
        '',
      ].join('\n'),
    );
  });

  assert.deepEqual(incrementalGraph.nodes, coldGraph.nodes);
  assert.deepEqual(incrementalGraph.edges, coldGraph.edges);
});

test('reindex after adding a new file matches a cold index', async () => {
  const { incrementalGraph, coldGraph } = await graphAfterChange(async (root) => {
    await writeFile(
      root,
      'pkg/tasks.py',
      ['from pkg.service import process', '', '', 'def nightly():', '    return process()', ''].join('\n'),
    );
  });

  assert.deepEqual(incrementalGraph.nodes, coldGraph.nodes);
  assert.deepEqual(incrementalGraph.edges, coldGraph.edges);
});

test('a deleted file leaves no nodes and no inbound edges behind', async () => {
  const root = await makeRepo('deletion', BASE);
  const before = await indexRepo(root);
  const serviceNodes = before.store.nodesInFile('pkg/service.py');
  assert.ok(serviceNodes.length > 0, 'expected the fixture to define symbols in service.py');
  const processNode = serviceNodes.find((n) => n.name === 'process');
  assert.ok(processNode, 'expected a process function');
  assert.ok(before.store.incoming([processNode.id]).length > 0, 'expected handle() to call process()');
  before.close();

  await deleteFile(root, 'pkg/service.py');
  const after = await indexRepo(root);

  assert.equal(after.store.nodesInFile('pkg/service.py').length, 0);
  assert.equal(after.store.getNode(processNode.id), null);

  const dangling = after.store
    .allNodesLite()
    .flatMap((n) => after.store.outgoing([n.id]))
    .filter((edge) => edge.dstId === processNode.id || edge.path === 'pkg/service.py');
  assert.deepEqual(dangling, [], 'edges from or to the deleted file should be gone');

  // The reference that used to resolve is still recorded, just unresolved now,
  // so it can be picked back up if the file returns.
  assert.ok(after.store.unresolvedRefCount() > 0);
  after.close();
});

test('a deleted file that comes back is resolved again', async () => {
  const root = await makeRepo('restore', BASE);
  const first = await indexRepo(root);
  const originalEdges = snapshot(first.store).edges;
  first.close();

  await deleteFile(root, 'pkg/service.py');
  const gone = await indexRepo(root);
  gone.close();

  await writeFile(root, 'pkg/service.py', BASE['pkg/service.py'] as string);
  const restored = await indexRepo(root);
  assert.deepEqual(snapshot(restored.store).edges, originalEdges);
  restored.close();
});

test('an unchanged tree does no parsing on the second pass', async () => {
  const root = await makeRepo('warm', BASE);
  const first = await indexRepo(root);
  assert.equal(first.stats.filesIndexed, 4);
  first.close();

  const second = await indexRepo(root);
  assert.equal(second.stats.filesIndexed, 0, 'a warm pass should parse nothing');
  assert.equal(second.stats.filesRemoved, 0);
  second.close();
});

test('a file rewritten with identical content is not reparsed twice', async () => {
  const root = await makeRepo('samecontent', BASE);
  const first = await indexRepo(root);
  const before = snapshot(first.store);
  first.close();

  // Touching mtime forces a read, but the content hash should stop there.
  await writeFile(root, 'pkg/api.py', BASE['pkg/api.py'] as string);
  const second = await indexRepo(root);
  assert.deepEqual(snapshot(second.store), before);
  second.close();
});

test('a syntax error in one file does not stop the index', async () => {
  const root = await makeRepo('broken', {
    ...BASE,
    'pkg/broken.py': 'def oops(:\n    return (((\n',
  });
  const indexed = await indexRepo(root);

  assert.ok(indexed.stats.nodes > 0, 'the healthy files should still be indexed');
  assert.ok(indexed.store.nodesInFile('pkg/models.py').length > 0);
  indexed.close();
});
