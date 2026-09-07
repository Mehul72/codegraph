import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cleanupRepos, deleteFile, indexRepo, makeRepo, useTempHome, writeFile } from './helpers.js';
import { loadConfig } from '../src/config/config.js';
import { walkRepo } from '../src/index/walker.js';
import { Session } from '../src/session.js';

await useTempHome();
after(cleanupRepos);

/**
 * Runs limited to a few paths, which is what `codegraph index some/file.ts`
 * and the agent edit hooks both do.
 *
 * These went untested for a long time and the whole path was dead: a scope
 * naming a file was handed to the directory walk, which failed with ENOTDIR,
 * logged at debug and returned nothing, so the run indexed zero files and
 * still reported success. Every assertion here is deliberately made without
 * running a query afterwards, because a query refreshes the whole index and
 * would do the work the scoped run was supposed to do.
 */

const APP: Record<string, string> = {
  'app/__init__.py': '',
  'app/models.py': 'class Order:\n    def total(self):\n        return 0\n',
  'app/service.py': 'from app.models import Order\n\n\ndef place():\n    return Order().total()\n',
};

test('a scope naming a single file indexes that file', async () => {
  const root = await makeRepo('scope-file', APP);
  const config = await loadConfig(root);

  const files = await walkRepo({ repoRoot: root, extraIgnore: config.ignore, only: ['app/service.py'] });
  assert.deepEqual(
    files.map((f) => f.relPath),
    ['app/service.py'],
    'a file scope should yield that file, not nothing',
  );
});

test('touch indexes the file it was given, with no query to cover for it', async () => {
  const root = await makeRepo('scope-touch', APP);
  (await indexRepo(root)).close();

  await writeFile(
    root,
    'app/service.py',
    'from app.models import Order\n\n\ndef place():\n    return Order().total()\n\n\ndef cancel():\n    return 1\n',
  );

  const session = await Session.open({ cwd: root });
  try {
    const stats = await session.touch(['app/service.py']);
    assert.equal(stats.filesIndexed, 1, 'touch should have parsed the one file it was handed');
    assert.ok(
      session.store.nodesInFile('app/service.py').some((n) => n.name === 'cancel'),
      'the new function should be in the graph already, before anything queries it',
    );
  } finally {
    session.close();
  }
});

test('touch on a deleted file takes it out of the graph', async () => {
  const root = await makeRepo('scope-delete', APP);
  (await indexRepo(root)).close();

  await deleteFile(root, 'app/models.py');

  const session = await Session.open({ cwd: root });
  try {
    const stats = await session.touch(['app/models.py']);
    assert.equal(stats.filesRemoved, 1);
    assert.deepEqual(session.store.nodesInFile('app/models.py'), [], 'a deleted file leaves nothing behind');
    // And the rest of the repo is untouched: a scoped run owns its scope only.
    assert.ok(session.store.nodesInFile('app/service.py').length > 0);
  } finally {
    session.close();
  }
});

test('a scoped run does not remove files outside its scope', async () => {
  const root = await makeRepo('scope-narrow', { ...APP, 'other/util.py': 'def helper():\n    return 1\n' });
  (await indexRepo(root)).close();

  const session = await Session.open({ cwd: root });
  try {
    await session.touch(['app']);
    assert.ok(
      session.store.nodesInFile('other/util.py').length > 0,
      'a run scoped to app/ must not drop what it never looked at',
    );
  } finally {
    session.close();
  }
});

test('a half-written temp file is never walked', async () => {
  const root = await makeRepo('scope-temp', APP);
  // The exact shape util/fs writeTextFile leaves behind mid-rename.
  await fsp.writeFile(path.join(root, 'app', 'models.py.codegraph-tmp-4242'), 'class Half:\n', 'utf8');

  const config = await loadConfig(root);
  const files = await walkRepo({ repoRoot: root, extraIgnore: config.ignore });
  assert.ok(
    !files.some((f) => f.relPath.includes('codegraph-tmp')),
    'a partly written file must not reach the parser',
  );
});
