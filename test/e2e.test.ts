import { after, beforeEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { cleanupRepos, makeRepo, useTempHome, writeFile } from './helpers.js';
import { estimateTokens } from '../src/util/text.js';
import { TOOL_DEFINITIONS } from '../src/mcp/definitions.js';
import { runTool } from '../src/mcp/dispatch.js';
import { Session } from '../src/session.js';

const run = promisify(execFile);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'src', 'cli', 'main.ts');

beforeEach(useTempHome);
after(cleanupRepos);

/**
 * The three flows the brief treats as acceptance, driven the way a user
 * actually drives them: through the CLI and through the MCP dispatch layer.
 * Everything else in the suite tests a part. This tests the product.
 */

const APP = {
  'app/__init__.py': '',
  'app/models.py': [
    '"""Domain types."""',
    '',
    'MAX_ITEMS = 50',
    '',
    '',
    'class Order:',
    '    """A customer order."""',
    '',
    '    def __init__(self, id, total):',
    '        self.id = id',
    '        self.total = total',
    '',
    '    def is_large(self):',
    '        return self.total > MAX_ITEMS',
    '',
  ].join('\n'),
  'app/store.py': [
    'from app.models import Order',
    '',
    '',
    'class OrderStore:',
    '    """Reads and writes orders."""',
    '',
    '    def find(self, id):',
    '        return Order(id, 0)',
    '',
    '    def save(self, order: Order):',
    '        return order.id',
    '',
  ].join('\n'),
  'app/service.py': [
    'from app.models import Order',
    'from app.store import OrderStore',
    '',
    '',
    'class OrderService:',
    '    def __init__(self, store: OrderStore):',
    '        self.store = store',
    '',
    '    def place(self, order: Order):',
    '        """Store an order and return its id."""',
    '        return self.store.save(order)',
    '',
  ].join('\n'),
  'app/cli.py': [
    'from app.models import Order',
    'from app.service import OrderService',
    'from app.store import OrderStore',
    '',
    '',
    'def main():',
    '    """Entry point."""',
    '    service = OrderService(OrderStore())',
    '    return service.place(Order("a1", 10))',
    '',
  ].join('\n'),
};

/**
 * Run the real CLI in a child process, the way a user or an agent hook would.
 * tsx is loaded through --import so the TypeScript entry point works without
 * a build step, which keeps this test honest about argument parsing and exit
 * codes without depending on dist/ being current.
 */
async function cli(repoRoot: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await run(
      process.execPath,
      ['--no-warnings', '--import', 'tsx', CLI, ...args],
      { cwd: repoRoot, env: { ...process.env }, maxBuffer: 8 * 1024 * 1024 },
    );
    return { stdout, stderr, code: 0 };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; code?: number };
    return { stdout: e.stdout ?? '', stderr: e.stderr ?? '', code: e.code ?? 1 };
  }
}

test('flow one: index then query, with no configuration step', async () => {
  const repo = await makeRepo('flow-one', APP);

  const indexed = await cli(repo, ['index']);
  assert.equal(indexed.code, 0, indexed.stderr);
  assert.match(indexed.stdout + indexed.stderr, /\d+ files/);

  const where = await cli(repo, ['where', 'OrderService.place']);
  assert.equal(where.code, 0, where.stderr);
  assert.match(where.stdout, /app\/service\.py:\d+/);

  const impact = await cli(repo, ['impact', 'Order']);
  assert.equal(impact.code, 0, impact.stderr);
  assert.match(impact.stdout, /would be affected/);
  assert.match(impact.stdout, /app\/(service|store|cli)\.py/);
});

test('a query before indexing says what to run, and does not stack trace', async () => {
  const repo = await makeRepo('flow-none', APP);
  const result = await cli(repo, ['overview']);

  assert.notEqual(result.code, 0, 'an unindexed repo is a user error, so exit non-zero');
  const output = result.stdout + result.stderr;
  assert.match(output, /codegraph index/, 'tell the user the command to run');
  assert.doesNotMatch(output, /at Object\.|at async|node:internal/, 'no stack traces in normal use');
});

test('flow two: init detects the language, indexes, and reports what it wired up', async () => {
  const repo = await makeRepo('flow-two', APP);
  const result = await cli(repo, ['init', '--skip-agents']);

  assert.equal(result.code, 0, result.stderr);
  const output = result.stdout + result.stderr;
  assert.match(output, /python/i, 'it should name the language it found');
  assert.match(output, /\d+ files/);

  // And the index it built is queryable straight away.
  const overview = await cli(repo, ['overview']);
  assert.equal(overview.code, 0, overview.stderr);
  assert.match(overview.stdout, /symbols/);
});

test('flow three: touch reindexes one file, which is what the agent hooks call', async () => {
  const repo = await makeRepo('flow-three', APP);
  assert.equal((await cli(repo, ['index'])).code, 0);

  await writeFile(
    repo,
    'app/service.py',
    [
      'from app.models import Order',
      'from app.store import OrderStore',
      '',
      '',
      'class OrderService:',
      '    def __init__(self, store: OrderStore):',
      '        self.store = store',
      '',
      '    def place(self, order: Order):',
      '        return self.store.save(order)',
      '',
      '    def cancel(self, order: Order):',
      '        """Added after the first index."""',
      '        return self.store.find(order.id)',
      '',
    ].join('\n'),
  );

  const touched = await cli(repo, ['touch', 'app/service.py']);
  assert.equal(touched.code, 0, touched.stderr);

  const where = await cli(repo, ['where', 'cancel']);
  assert.match(where.stdout, /app\/service\.py:\d+/, 'the new method should be findable immediately');
});

test('touch ignores a path outside the repo instead of indexing it', async () => {
  const repo = await makeRepo('flow-outside', APP);
  assert.equal((await cli(repo, ['index'])).code, 0);

  const outsider = path.join(ROOT, 'src', 'session.ts');
  const result = await cli(repo, ['touch', outsider]);
  assert.equal(result.code, 0, 'a hook must never fail the agent, even on a bad path');

  const session = await Session.open({ cwd: repo });
  try {
    const strays = session.store.allNodesLite().filter((n) => !n.path.startsWith('app/'));
    assert.deepEqual(strays, [], 'nothing from outside the repo should reach the graph');
  } finally {
    session.close();
  }
});

test('status describes the index and the agent wiring', async () => {
  const repo = await makeRepo('flow-status', APP);
  assert.equal((await cli(repo, ['index'])).code, 0);

  const result = await cli(repo, ['status']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /files/);
  assert.match(result.stdout, /symbols/);
  assert.match(result.stdout, /edges/);
});

test('status on a repo with no index does not pretend there is one', async () => {
  const repo = await makeRepo('flow-nostatus', APP);
  const result = await cli(repo, ['status']);
  const output = result.stdout + result.stderr;
  assert.match(output, /no index|not indexed|codegraph index/i);
});

test('the CLI and the MCP layer answer identically', async () => {
  const repo = await makeRepo('flow-parity', APP);
  assert.equal((await cli(repo, ['index'])).code, 0);

  const session = await Session.open({ cwd: repo });
  try {
    const cases: Array<[string, string[], string, Record<string, unknown>]> = [
      ['where_defined', ['where', 'Order'], 'where_defined', { name: 'Order' }],
      ['overview', ['overview'], 'overview', {}],
      ['impact_of', ['impact', 'Order'], 'impact_of', { target: 'Order' }],
      ['get_symbol', ['symbol', 'OrderService.place'], 'get_symbol', { name: 'OrderService.place' }],
    ];
    for (const [label, argv, tool, args] of cases) {
      const viaCli = (await cli(repo, argv)).stdout.trimEnd();
      const viaMcp = (await runTool(session, tool, args)).trimEnd();
      assert.equal(viaCli, viaMcp, `${label} differs between the CLI and MCP`);
    }
  } finally {
    session.close();
  }
});

test('every advertised tool actually runs', async () => {
  const repo = await makeRepo('flow-tools', APP);
  assert.equal((await cli(repo, ['index'])).code, 0);

  const args: Record<string, Record<string, unknown>> = {
    search_symbols: { query: 'Order' },
    where_defined: { name: 'Order' },
    get_symbol: { name: 'OrderService' },
    find_callers: { symbol: 'OrderStore.save' },
    find_callees: { symbol: 'OrderService.place' },
    impact_of: { target: 'Order' },
    shortest_path: { a: 'main', b: 'OrderStore.save' },
    overview: {},
    changed_since: { ref: 'HEAD' },
  };

  const session = await Session.open({ cwd: repo });
  try {
    assert.equal(TOOL_DEFINITIONS.length, 9, 'the brief asks for nine tools');
    for (const definition of TOOL_DEFINITIONS) {
      const input = args[definition.name];
      assert.ok(input, `no test arguments for ${definition.name}`);
      const output = await runTool(session, definition.name, input);
      assert.ok(output.trim().length > 0, `${definition.name} returned nothing`);
      assert.ok(estimateTokens(output) < 2000, `${definition.name} is too expensive`);
    }
  } finally {
    session.close();
  }
});

test('a tool called with junk arguments explains itself', async () => {
  const repo = await makeRepo('flow-junk', APP);
  assert.equal((await cli(repo, ['index'])).code, 0);

  const session = await Session.open({ cwd: repo });
  try {
    await assert.rejects(() => runTool(session, 'search_symbols', {}), /query is required/);
    await assert.rejects(() => runTool(session, 'get_symbol', { name: '' }), /required/);
    await assert.rejects(() => runTool(session, 'not_a_tool', {}), /unknown tool/);
  } finally {
    session.close();
  }
});

test('every tool definition is complete enough for an agent to pick from', () => {
  for (const definition of TOOL_DEFINITIONS) {
    assert.match(definition.name, /^[a-z_]+$/, `${definition.name} should be snake case`);
    assert.ok(definition.description.length > 60, `${definition.name} needs a description an agent can act on`);
    assert.match(definition.description, /^[A-Z]/, `${definition.name} description should read as prose`);
    assert.equal(definition.inputSchema.type, 'object');
    for (const required of definition.inputSchema.required ?? []) {
      assert.ok(required in definition.inputSchema.properties, `${definition.name} requires an undeclared ${required}`);
    }
    for (const [prop, schema] of Object.entries(definition.inputSchema.properties)) {
      const described = (schema as { description?: string }).description;
      assert.ok(described && described.length > 0, `${definition.name}.${prop} has no description`);
    }
  }
});

test('an index survives the repo being moved', async () => {
  const repo = await makeRepo('flow-move', APP);
  assert.equal((await cli(repo, ['index'])).code, 0);

  const moved = repo + '-moved';
  await fsp.rename(repo, moved);

  const where = await cli(moved, ['where', 'Order']);
  assert.equal(where.code, 0, where.stderr);
  assert.match(where.stdout, /app\/models\.py:\d+/, 'paths are repo-relative, so a move is harmless');
  await fsp.rm(moved, { recursive: true, force: true });
});

test('a corrupt database is reported as something the user can fix', async () => {
  const repo = await makeRepo('flow-corrupt', APP);
  assert.equal((await cli(repo, ['index'])).code, 0);

  await fsp.writeFile(path.join(repo, '.codegraph', 'graph.db'), 'this is not a database', 'utf8');

  const result = await cli(repo, ['overview']);
  const output = result.stdout + result.stderr;
  assert.match(output, /reindex|codegraph index/i, 'point at the fix');
  assert.doesNotMatch(output, /node:internal/, 'not a raw sqlite error');
});

test('the version flag prints the package version', async () => {
  const repo = await makeRepo('flow-version', APP);
  const result = await cli(repo, ['--version']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
});

test('help lists the commands a new user needs first', async () => {
  const repo = await makeRepo('flow-help', APP);
  const result = await cli(repo, ['--help']);
  assert.equal(result.code, 0, result.stderr);
  for (const command of ['init', 'index', 'status', 'mcp', 'impact-of', 'overview']) {
    assert.match(result.stdout, new RegExp(command), `help should mention ${command}`);
  }
});
