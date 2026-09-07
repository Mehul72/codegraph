import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cleanupRepos, makeRepo, useTempHome } from './helpers.js';
import { INTEGRATIONS, integrationById } from '../src/integrations/index.js';
import type { InstallContext } from '../src/integrations/types.js';

// Codex keeps its MCP list in a global config file, so every test gets a fresh
// fake home. Otherwise the previous test's leftovers look like our own work.
beforeEach(useTempHome);
after(cleanupRepos);

/**
 * These writers edit files people own, some of which are committed and
 * reviewed. So the bar is higher than "it works": installing twice must not
 * duplicate anything, uninstalling must leave the file as it was found, and
 * hand-written content around our block must survive both.
 */

const SERVER = { command: 'codegraph', args: ['mcp'] };

/**
 * Config files an integration might edit. These are shared with the user and
 * with other tools, so our entry has to slot in beside what is already there.
 * Files named after codegraph are ours alone and are not in this list, since
 * rewriting those wholesale is the right behaviour.
 */
const JSON_TARGETS = ['.mcp.json', '.claude/settings.json', '.cursor/mcp.json', '.vscode/mcp.json'];
const MARKDOWN_TARGETS = ['CLAUDE.md', 'AGENTS.md', '.github/copilot-instructions.md'];

function contextFor(repoRoot: string): InstallContext {
  return { repoRoot, server: SERVER };
}

/** Reports name repo-relative paths, except Codex's global config file. */
async function read(root: string, reported: string): Promise<string | null> {
  const target = path.isAbsolute(reported) ? reported : path.join(root, reported);
  try {
    return await fsp.readFile(target, 'utf8');
  } catch {
    return null;
  }
}

async function contentsOf(root: string, files: readonly string[]): Promise<Array<readonly [string, string | null]>> {
  return Promise.all(files.map(async (f) => [f, await read(root, f)] as const));
}

async function seed(root: string, relative: string, contents: string): Promise<void> {
  const target = path.join(root, relative);
  await fsp.mkdir(path.dirname(target), { recursive: true });
  await fsp.writeFile(target, contents, 'utf8');
}

for (const integration of INTEGRATIONS) {
  test(`${integration.label}: installing twice changes nothing the second time`, async () => {
    const root = await makeRepo(`twice-${integration.id}`, { 'main.py': 'def go():\n    return 1\n' });

    const first = await integration.install(contextFor(root));
    const afterFirst = await contentsOf(root, first.changed);

    const second = await integration.install(contextFor(root));
    assert.deepEqual(await contentsOf(root, first.changed), afterFirst, 'a second install should be a no-op on disk');
    assert.deepEqual(second.changed, [], 'and it should report that it changed nothing');
  });

  test(`${integration.label}: uninstall removes every trace`, async () => {
    const root = await makeRepo(`clean-${integration.id}`, { 'main.py': 'def go():\n    return 1\n' });

    const report = await integration.install(contextFor(root));
    assert.ok(report.changed.length > 0, 'install should have written something');

    await integration.uninstall(root);
    for (const file of report.changed) {
      const contents = (await read(root, file)) ?? '';
      assert.doesNotMatch(contents, /codegraph/i, `${file} still mentions codegraph after uninstall`);
    }
  });

  test(`${integration.label}: existing config files keep their own settings`, async () => {
    const root = await makeRepo(`merge-${integration.id}`, { 'main.py': 'def go():\n    return 1\n' });

    const seeded = {
      mcpServers: { other: { command: 'other-server', args: ['--flag'] } },
      servers: { other: { command: 'other-server', args: ['--flag'] } },
      hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'echo mine' }] }] },
      somethingElse: { keepMe: true },
    };
    for (const relative of JSON_TARGETS) {
      await seed(root, relative, JSON.stringify(seeded, null, 2) + '\n');
    }
    for (const relative of MARKDOWN_TARGETS) {
      await seed(root, relative, '# House rules\n\nRun the tests before pushing.\n');
    }

    await integration.install(contextFor(root));
    await check('after install');
    await integration.uninstall(root);
    await check('after uninstall');

    async function check(when: string): Promise<void> {
      for (const relative of JSON_TARGETS) {
        const parsed = JSON.parse((await read(root, relative)) as string) as Record<string, unknown>;
        assert.deepEqual(parsed.somethingElse, { keepMe: true }, `${relative} lost an unrelated key ${when}`);
        for (const key of ['mcpServers', 'servers']) {
          const servers = parsed[key] as Record<string, unknown> | undefined;
          assert.ok(servers && 'other' in servers, `${relative} dropped another MCP server ${when}`);
        }
        const hooks = parsed.hooks as { PostToolUse?: unknown[] } | undefined;
        const mine = (hooks?.PostToolUse ?? []).filter((entry) =>
          JSON.stringify(entry).includes('echo mine'),
        );
        assert.equal(mine.length, 1, `${relative} lost the user's own hook ${when}`);
      }
      for (const relative of MARKDOWN_TARGETS) {
        const contents = (await read(root, relative)) ?? '';
        assert.match(contents, /House rules/, `${relative} lost the user's own text ${when}`);
        assert.match(contents, /Run the tests before pushing/, `${relative} lost the user's own text ${when}`);
      }
    }
  });

  test(`${integration.label}: uninstalling without installing is not an error`, async () => {
    const root = await makeRepo(`bare-${integration.id}`, { 'main.py': 'def go():\n    return 1\n' });
    const report = await integration.uninstall(root);
    assert.deepEqual(report.changed, [], 'nothing was installed, so nothing should change');
  });

  test(`${integration.label}: install reports every file it touched`, async () => {
    const root = await makeRepo(`report-${integration.id}`, { 'main.py': 'def go():\n    return 1\n' });
    const report = await integration.install(contextFor(root));
    assert.ok(report.changed.length > 0, 'install should report what it wrote');
    for (const relative of report.changed) {
      assert.notEqual(await read(root, relative), null, `reported ${relative} but it does not exist`);
    }
  });

  test(`${integration.label}: the MCP command is not pinned to one machine`, async () => {
    const root = await makeRepo(`portable-${integration.id}`, { 'main.py': 'def go():\n    return 1\n' });
    const report = await integration.install(contextFor(root));
    for (const relative of report.changed) {
      if (path.isAbsolute(relative)) continue; // the global Codex config is not committed
      const contents = (await read(root, relative)) ?? '';
      assert.doesNotMatch(contents, /\/Users\/|\/home\/|C:\\/, `${relative} hard-codes a path from this machine`);
      assert.ok(!contents.includes(root), `${relative} hard-codes the repo path`);
    }
  });
}

test('every integration writes JSON a human can read and diff', async () => {
  const root = await makeRepo('formatting', { 'main.py': 'def go():\n    return 1\n' });
  const written = new Set<string>();
  for (const integration of INTEGRATIONS) {
    for (const file of (await integration.install(contextFor(root))).changed) written.add(file);
  }

  let checked = 0;
  for (const file of written) {
    if (!file.endsWith('.json')) continue;
    const contents = (await read(root, file)) ?? '';
    checked++;
    assert.match(contents, /\n {2}"/, `${file} should be indented, not minified`);
    assert.ok(contents.endsWith('\n'), `${file} should end with a newline`);
    assert.doesNotMatch(contents, /\r\n/, `${file} should use plain newlines`);
    assert.doesNotThrow(() => JSON.parse(contents), `${file} should be valid JSON`);
  }
  assert.ok(checked > 0, 'some agents are configured through JSON');
});

test('the instructions say what the tool is for and when to read files instead', async () => {
  const root = await makeRepo('instructions', { 'main.py': 'def go():\n    return 1\n' });
  const written = new Set<string>();
  for (const integration of INTEGRATIONS) {
    for (const file of (await integration.install(contextFor(root))).changed) written.add(file);
  }

  let checked = 0;
  for (const file of written) {
    if (!/\.(md|mdc)$/.test(file)) continue;
    const contents = (await read(root, file)) ?? '';
    checked++;
    assert.match(contents, /impact_of/, `${file} should name the tools`);
    assert.match(contents, /read/i, `${file} should say when to read files instead`);
    assert.match(contents, /codegraph/i);
  }
  assert.ok(checked > 0, 'at least one agent gets markdown instructions');
});

test('integrationById is case insensitive and returns null for junk', () => {
  assert.equal(integrationById('CLAUDE')?.id, 'claude');
  assert.equal(integrationById('claude')?.id, 'claude');
  assert.equal(integrationById('not-an-agent'), null);
});

test('every integration has a distinct lowercase id and a readable label', () => {
  const ids = new Set<string>();
  for (const integration of INTEGRATIONS) {
    assert.ok(!ids.has(integration.id), `duplicate id ${integration.id}`);
    ids.add(integration.id);
    assert.equal(integration.id, integration.id.toLowerCase());
    assert.ok(integration.label.length > 0);
  }
});

/**
 * The hook runs the CLI, not the MCP server, so it needs the whole launcher
 * minus the `mcp` subcommand. Taking only `server.command` produced
 * `npx touch ...`, and `touch` is a real and unrelated package on the npm
 * registry: reindex-on-edit silently fetched and ran that instead, for
 * everyone who had not installed codegraph globally.
 */
test('the Claude edit hook runs codegraph even when it is only reachable through npx', async () => {
  const root = await makeRepo('hooked', { 'a.py': 'def a():\n    return 1\n' });
  const claude = integrationById('claude');
  assert.ok(claude);

  await claude.install({ repoRoot: root, server: { command: 'npx', args: ['-y', 'codegraph', 'mcp'] } });
  const settings = JSON.parse(
    await fsp.readFile(path.join(root, '.claude', 'settings.json'), 'utf8'),
  ) as { hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } };

  const command = settings.hooks.PostToolUse[0]?.hooks[0]?.command ?? '';
  assert.match(command, /^npx -y codegraph touch /, `the hook ran the wrong program: ${command}`);
  assert.doesNotMatch(command, /^npx touch/, 'npx touch installs an unrelated package');
  assert.ok(!command.includes(' mcp '), 'the hook must not carry the mcp subcommand');
});

test('the Claude edit hook stays a bare command when codegraph is on PATH', async () => {
  const root = await makeRepo('hooked-path', { 'a.py': 'def a():\n    return 1\n' });
  const claude = integrationById('claude');
  assert.ok(claude);

  await claude.install({ repoRoot: root, server: { command: 'codegraph', args: ['mcp'] } });
  const settings = JSON.parse(
    await fsp.readFile(path.join(root, '.claude', 'settings.json'), 'utf8'),
  ) as { hooks: { PostToolUse: Array<{ hooks: Array<{ command: string }> }> } };

  assert.match(settings.hooks.PostToolUse[0]?.hooks[0]?.command ?? '', /^codegraph touch /);
});

/**
 * Both halves of the git hook writer used to splice with the result of
 * indexOf without checking it for -1, so a start marker whose end marker had
 * been deleted made them cut sixteen arbitrary characters out of a script the
 * user wrote. Leaving an unparseable block alone is the only safe answer.
 */
test('git hooks never rewrite a hook script whose end marker is missing', async () => {
  const { installGitHooks, uninstallGitHooks } = await import('../src/integrations/githooks.js');
  const damaged = '#!/bin/sh\necho "important"\n# codegraph:start\ncodegraph index &\n';
  const hookAt = (root: string) => path.join(root, '.git', 'hooks', 'post-commit');

  for (const run of [installGitHooks, uninstallGitHooks]) {
    const root = await makeRepo('git-hooks', { 'a.py': 'def a():\n    return 1\n' });
    await fsp.mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
    await fsp.writeFile(hookAt(root), damaged, 'utf8');

    await run(root, 'codegraph');
    const after = await fsp.readFile(hookAt(root), 'utf8');
    assert.ok(after.includes('#!/bin/sh\necho "important"\n'), `${run.name} mangled the user's script`);
  }
});

test('git hooks install, re-install and uninstall without disturbing the rest of the script', async () => {
  const { installGitHooks, uninstallGitHooks } = await import('../src/integrations/githooks.js');
  const root = await makeRepo('git-hooks-clean', { 'a.py': 'def a():\n    return 1\n' });
  await fsp.mkdir(path.join(root, '.git', 'hooks'), { recursive: true });
  const hook = path.join(root, '.git', 'hooks', 'post-commit');
  const original = '#!/bin/sh\necho "mine"\n';
  await fsp.writeFile(hook, original, 'utf8');

  const first = await installGitHooks(root, 'npx -y codegraph');
  assert.ok(first.changed.length > 0);
  assert.match(await fsp.readFile(hook, 'utf8'), /npx -y codegraph index/);

  const again = await installGitHooks(root, 'npx -y codegraph');
  assert.equal(again.changed.length, 0, 'installing twice must be a no-op');

  await uninstallGitHooks(root);
  assert.equal(await fsp.readFile(hook, 'utf8'), original, 'uninstall must restore the file exactly');
});
