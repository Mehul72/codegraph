import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRepos, indexRepo, makeRepo, useTempHome } from './helpers.js';
import { loadConfig } from '../src/config/config.js';
import { walkRepo } from '../src/index/walker.js';

await useTempHome();
after(cleanupRepos);

/**
 * What gets walked decides what the graph contains, so a quiet failure here
 * shows up as answers about generated code the user does not care about, or
 * as a missing symbol with no explanation. Every rule gets a test.
 */

async function walked(root: string): Promise<string[]> {
  const config = await loadConfig(root);
  const files = await walkRepo({ repoRoot: root, extraIgnore: config.ignore });
  return files.map((f) => f.relPath).sort();
}

test('a multi-line gitignore applies every one of its patterns', async () => {
  const root = await makeRepo('multiline', {
    // The bug this catches: an ignore file handed over as one blob rather than
    // one pattern per line silently matches nothing.
    '.gitignore': 'build/\ngenerated/\n*.pb.py\nvendor/\n',
    'keep.py': 'def kept():\n    return 1\n',
    'build/out.py': 'def built():\n    return 1\n',
    'generated/schema.py': 'def generated():\n    return 1\n',
    'api.pb.py': 'def proto():\n    return 1\n',
    'vendor/lib.py': 'def vendored():\n    return 1\n',
  });

  const files = await walked(root);
  assert.ok(files.includes('keep.py'));
  for (const excluded of ['build/out.py', 'generated/schema.py', 'api.pb.py', 'vendor/lib.py']) {
    assert.equal(files.includes(excluded), false, `${excluded} should have been ignored`);
  }
});

test('comments and blank lines in an ignore file are not patterns', async () => {
  const root = await makeRepo('comments', {
    '.gitignore': '# build output\n\nbuild/\n\n# and nothing else\n',
    'keep.py': 'def kept():\n    return 1\n',
    'build/out.py': 'def built():\n    return 1\n',
  });

  const files = await walked(root);
  assert.equal(files.includes('build/out.py'), false);
  assert.ok(files.includes('keep.py'));
});

test('a negation re-includes one file from an excluded set', async () => {
  const root = await makeRepo('negation', {
    // generated/* rather than generated/, because git cannot re-include from
    // a directory it was told to skip, and neither can we.
    '.gitignore': 'generated/*\n!generated/keep.py\n',
    'generated/skip.py': 'def skipped():\n    return 1\n',
    'generated/keep.py': 'def kept():\n    return 1\n',
  });

  const files = await walked(root);
  assert.equal(files.includes('generated/skip.py'), false);
  assert.ok(files.includes('generated/keep.py'), 'a negated pattern should win');
});

test('a nested gitignore applies to its own subtree and no further', async () => {
  const root = await makeRepo('nested', {
    'app/keep.py': 'def kept():\n    return 1\n',
    'app/tmp/skip.py': 'def skipped():\n    return 1\n',
    'app/.gitignore': 'tmp/\n',
    // Same directory name outside that subtree stays visible.
    'other/tmp/keep.py': 'def kept():\n    return 1\n',
  });

  const files = await walked(root);
  assert.equal(files.includes('app/tmp/skip.py'), false);
  assert.ok(files.includes('other/tmp/keep.py'), 'a nested rule should not leak upward');
  assert.ok(files.includes('app/keep.py'));
});

test('codegraphignore works alongside gitignore rather than replacing it', async () => {
  const root = await makeRepo('both', {
    '.gitignore': 'build/\n',
    '.codegraphignore': 'fixtures/\n',
    'keep.py': 'def kept():\n    return 1\n',
    'build/out.py': 'def built():\n    return 1\n',
    'fixtures/sample.py': 'def sample():\n    return 1\n',
  });

  const files = await walked(root);
  assert.ok(files.includes('keep.py'));
  assert.equal(files.includes('build/out.py'), false);
  assert.equal(files.includes('fixtures/sample.py'), false);
});

test('config ignore patterns are honoured too', async () => {
  const root = await makeRepo(
    'configignore',
    {
      'keep.py': 'def kept():\n    return 1\n',
      'scripts/tool.py': 'def tool():\n    return 1\n',
    },
    { ignore: ['scripts/'] },
  );

  const files = await walked(root);
  assert.ok(files.includes('keep.py'));
  assert.equal(files.includes('scripts/tool.py'), false);
});

test('the usual heavy directories are skipped without being listed anywhere', async () => {
  const root = await makeRepo('heavy', {
    'keep.py': 'def kept():\n    return 1\n',
    'node_modules/dep/index.js': 'export const dep = 1;\n',
    '__pycache__/keep.cpython-311.pyc': 'not really bytecode\n',
    'dist/bundle.js': 'export const bundled = 1;\n',
    'target/classes/App.class': 'not really bytecode\n',
    'vendor/dep/dep.go': 'package dep\n\nfunc Dep() int {\n\treturn 1\n}\n',
    'coverage/report.js': 'export const covered = 1;\n',
  });

  const files = await walked(root);
  assert.deepEqual(
    files.filter((f) => f !== 'codegraph.config.json'),
    ['keep.py'],
    'these cost time and never hold source worth indexing',
  );
});

test('newly ignoring a file removes it from the graph', async () => {
  const root = await makeRepo('drop', {
    'keep.py': 'def kept():\n    return 1\n',
    'generated/schema.py': 'def generated():\n    return 1\n',
  });

  const first = await indexRepo(root);
  assert.ok(first.store.nodesInFile('generated/schema.py').length > 0);
  first.close();

  const { writeFile } = await import('./helpers.js');
  await writeFile(root, '.gitignore', 'generated/\n');

  const second = await indexRepo(root);
  assert.equal(second.store.nodesInFile('generated/schema.py').length, 0);
  assert.equal(second.stats.filesRemoved, 1);
  assert.ok(second.store.nodesInFile('keep.py').length > 0, 'the rest of the graph is untouched');
  second.close();
});

test('a file over the size limit is skipped but does not stop the walk', async () => {
  const root = await makeRepo(
    'toobig',
    {
      'small.py': 'def small():\n    return 1\n',
      'huge.py': `def huge():\n    return "${'x'.repeat(5000)}"\n`,
    },
    { maxFileBytes: 1000 },
  );

  const indexed = await indexRepo(root);
  assert.ok(indexed.store.nodesInFile('small.py').length > 0);
  assert.equal(indexed.store.nodesInFile('huge.py').length, 0);
  assert.ok(indexed.stats.filesSkipped > 0);
  indexed.close();
});

test('the language filter keeps other languages out of the index', async () => {
  const root = await makeRepo(
    'langfilter',
    {
      'app.py': 'def go():\n    return 1\n',
      'main.go': 'package main\n\nfunc Go() int {\n\treturn 1\n}\n',
    },
    { languages: ['python'] },
  );

  const indexed = await indexRepo(root);
  assert.ok(indexed.store.nodesInFile('app.py').length > 0);
  assert.equal(indexed.store.nodesInFile('main.go').length, 0);
  indexed.close();
});

test('the walk order is stable, so two indexes of one tree agree', async () => {
  const files: Record<string, string> = {};
  for (const name of ['zeta', 'alpha', 'mid', 'beta']) {
    files[`pkg/${name}.py`] = `def ${name}():\n    return 1\n`;
  }
  const root = await makeRepo('stable', files);

  const first = await walked(root);
  const second = await walked(root);
  assert.deepEqual(first, second);
  assert.deepEqual(
    first.filter((f) => f.endsWith('.py')),
    ['pkg/alpha.py', 'pkg/beta.py', 'pkg/mid.py', 'pkg/zeta.py'],
  );
});

test('the index directory never indexes itself', async () => {
  const root = await makeRepo('selfindex', { 'keep.py': 'def kept():\n    return 1\n' });
  const indexed = await indexRepo(root);
  indexed.close();

  const files = await walked(root);
  assert.equal(files.some((f) => f.startsWith('.codegraph/')), false);
});
