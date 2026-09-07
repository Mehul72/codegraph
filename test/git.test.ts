import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { cleanupRepos, makeRepo, useTempHome } from './helpers.js';
import { changedFilesSince, describeHead } from '../src/util/git.js';

const run = promisify(execFile);

await useTempHome();
after(cleanupRepos);

/**
 * git decides how to print a path, and its defaults are not the ones a
 * lookup wants. Anything with a byte over 0x7f comes back quoted and
 * octal-escaped unless core.quotePath is turned off, and a name holding a
 * space survives only if the output is NUL separated. Both failures are
 * silent: the path simply matches nothing in the index, and changed_since
 * reports the file as containing no indexed symbols rather than as missing.
 */
async function gitRepo(files: Record<string, string>): Promise<string> {
  const root = await makeRepo('gitrepo', files);
  const git = (...args: string[]) =>
    run('git', ['-c', 'user.email=t@example.com', '-c', 'user.name=t', ...args], { cwd: root });

  await git('init', '-q', '.');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'base');
  return root;
}

test('changed files keep their real names, whatever bytes are in them', async () => {
  const root = await gitRepo({
    'plain.py': 'def a():\n    return 1\n',
    'café.py': 'def b():\n    return 2\n',
    'two words.py': 'def c():\n    return 3\n',
  });

  await fsp.appendFile(path.join(root, 'plain.py'), '# edit\n');
  await fsp.appendFile(path.join(root, 'café.py'), '# edit\n');
  await fsp.appendFile(path.join(root, 'two words.py'), '# edit\n');
  await fsp.writeFile(path.join(root, 'ünicode new.py'), 'def d():\n    return 4\n');

  const changed = await changedFilesSince(root, 'HEAD');

  for (const expected of ['plain.py', 'café.py', 'two words.py', 'ünicode new.py']) {
    assert.ok(changed.includes(expected), `${expected} was missing from ${JSON.stringify(changed)}`);
  }
  assert.ok(
    changed.every((p) => !p.startsWith('"')),
    `a path came back still quoted: ${JSON.stringify(changed)}`,
  );
});

test('an unknown ref fails as a GitError rather than an empty answer', async () => {
  const root = await gitRepo({ 'a.py': 'def a():\n    return 1\n' });
  await assert.rejects(() => changedFilesSince(root, 'no-such-ref'), { name: 'GitError' });
});

test('changed files outside a git repo is a GitError, and describeHead is null', async () => {
  const root = await makeRepo('notgit', { 'a.py': 'def a():\n    return 1\n' });
  await assert.rejects(() => changedFilesSince(root, 'HEAD'), { name: 'GitError' });
  assert.equal(await describeHead(root), null);
});

test('describeHead names the branch and the short sha', async () => {
  const root = await gitRepo({ 'a.py': 'def a():\n    return 1\n' });
  const head = await describeHead(root);
  assert.ok(head, 'expected a head description');
  assert.match(head, /^\S+ [0-9a-f]{7,}$/);
});
