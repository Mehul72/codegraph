import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cleanupRepos, indexRepo, makeRepo, useTempHome, type IndexedRepo } from './helpers.js';
import { estimateTokens } from '../src/util/text.js';
import {
  changedSince,
  findCallees,
  findCallers,
  getSymbol,
  impactOf,
  overview,
  searchSymbols,
  shortestPathTool,
  whereDefined,
  type ToolContext,
} from '../src/query/tools.js';

/**
 * These tests read the actual output of every tool, because the output is the
 * product. A correct graph rendered badly is still a bad answer. So the
 * assertions are about what an agent would see: the facts are present, the
 * confidence is visible, and the whole thing fits in a few hundred tokens.
 */

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'python');

let repo: IndexedRepo;
let ctx: ToolContext;

before(async () => {
  await useTempHome();
  const files: Record<string, string> = {};
  for (const relative of await walk(FIXTURES)) {
    files[relative] = await fsp.readFile(path.join(FIXTURES, relative), 'utf8');
  }
  const root = await makeRepo('shop', files);
  repo = await indexRepo(root);
  ctx = {
    store: repo.store,
    repo: 'shop',
    repoRoot: root,
    defaultBudget: 2000,
    hasLinks: false,
  };
});

after(() => {
  repo?.close();
  return cleanupRepos();
});

async function walk(dir: string, prefix = ''): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...(await walk(path.join(dir, entry.name), rel)));
    else out.push(rel);
  }
  return out;
}

test('search_symbols finds a class by a partial name and stays small', () => {
  const out = searchSymbols(ctx, { query: 'OrderServ' });
  assert.match(out, /OrderService/);
  assert.match(out, /app\/service\.py:\d+/);
  assert.ok(estimateTokens(out) < 200, `search output was ${estimateTokens(out)} tokens:\n${out}`);
});

test('search_symbols respects the kind filter', () => {
  const classes = searchSymbols(ctx, { query: 'order', kind: 'class' });
  for (const line of classes.split('\n').slice(1)) {
    if (line.trim() === '' || line.startsWith('omitted:') || line.startsWith('        ')) continue;
    assert.match(line, /\bclass\b/, `expected only classes, got: ${line}`);
  }
});

test('search_symbols on a miss says so and suggests a next step', () => {
  const out = searchSymbols(ctx, { query: 'zzzznotathing' });
  assert.match(out, /no symbol matches/);
  assert.match(out, /where_defined|shorter query/);
});

test('get_symbol shows the signature, the doc and both directions', () => {
  const out = getSymbol(ctx, { name: 'OrderService.create' });
  assert.match(out, /OrderService\.create/);
  assert.match(out, /app\/service\.py:\d+/);
  assert.match(out, /Validate an order/, 'the docstring should be carried through');
  assert.match(out, /uses \(/, 'callees should be grouped');
  assert.match(out, /calls/);
  // create() calls validate, audit, slugify and repository.find
  assert.match(out, /slugify/);
  assert.match(out, /validate/);
});

test('get_symbol accepts a bare name as well as a qualified one', () => {
  const bare = getSymbol(ctx, { name: 'slugify' });
  assert.match(bare, /slugify/);
  assert.match(bare, /app\/util\/text\.py:\d+/);
});

test('get_symbol on a class lists its methods', () => {
  const out = getSymbol(ctx, { name: 'OrderService' });
  assert.match(out, /defines/);
  assert.match(out, /create/);
  assert.match(out, /validate/);
});

test('find_callers walks inbound calls and labels confidence', async () => {
  const out = await findCallers(ctx, { symbol: 'slugify', depth: 2 });
  assert.match(out, /callers of/);
  assert.match(out, /create/, 'OrderService.create calls slugify');
  assert.match(out, /exact|resolved|heuristic/);
  assert.match(out, /exact = /, 'the legend explains the tags');
});

test('find_callers on something nothing calls says none, not nothing', async () => {
  const out = await findCallers(ctx, { symbol: 'MAX_ITEMS', depth: 1 });
  assert.ok(out.length > 0);
  assert.match(out, /callers of|none/);
});

test('find_callees is the mirror image of find_callers', async () => {
  const callees = await findCallees(ctx, { symbol: 'OrderService.create', depth: 1 });
  assert.match(callees, /callees of/);
  assert.match(callees, /slugify/);

  const callers = await findCallers(ctx, { symbol: 'slugify', depth: 1 });
  assert.match(callers, /create/);
});

test('impact_of leads with a verdict and groups by file', async () => {
  const out = await impactOf(ctx, { target: 'Order', depth: 3 });
  assert.match(out, /impact of changing/);
  assert.match(out, /would be affected/);
  assert.match(out, /app\/service\.py/);
  assert.ok(estimateTokens(out) < 700, `impact output was ${estimateTokens(out)} tokens`);
});

test('impact_of accepts a file path, not just a symbol', async () => {
  const out = await impactOf(ctx, { target: 'app/models.py', depth: 2 });
  assert.match(out, /impact of changing/);
  assert.match(out, /app\/service\.py|app\/repository\.py/);
});

test('impact_of warns when part of the answer is a guess', async () => {
  const out = await impactOf(ctx, { target: 'Order', depth: 4 });
  // The word appears in the legend either way, so read the tally line.
  const tally = out.split('\n').find((l) => l.includes('would be affected')) ?? '';
  if (/heuristic/.test(tally)) {
    assert.match(out, /name match alone|confirm them/, 'heuristic hits need the caveat');
  }
});

test('impact_of on an untouched symbol says nothing depends on it', async () => {
  const out = await impactOf(ctx, { target: 'main', depth: 3 });
  assert.match(out, /nothing in this repo depends on it/);
});

test('shortest_path explains each hop with a file and a line', () => {
  const out = shortestPathTool(ctx, { a: 'create_order', b: 'slugify' });
  if (/no path between/.test(out)) {
    assert.match(out, /8 hops/);
    return;
  }
  assert.match(out, /hop/);
  assert.match(out, /->|<-/);
  assert.match(out, /:\d+/, 'hops carry a call site');
});

test('shortest_path is honest when there is no path', () => {
  const out = shortestPathTool(ctx, { a: 'slugify', b: 'MAX_ITEMS' });
  assert.ok(/no path between/.test(out) || /hop/.test(out));
});

test('overview gives the shape of the repo in one screen', () => {
  const out = overview(ctx, {});
  assert.match(out, /shop: \d+ files, \d+ symbols/);
  assert.match(out, /modules:/);
  assert.match(out, /most depended on:/);
  assert.ok(estimateTokens(out) < 700, `overview was ${estimateTokens(out)} tokens:\n${out}`);
});

test('overview scoped to a subdirectory only covers that subtree', () => {
  const out = overview(ctx, { path: 'app/util' });
  assert.match(out, /app\/util/);
  assert.doesNotMatch(out, /OrderService/);
});

test('overview names entry points that nothing calls', () => {
  const out = overview(ctx, {});
  assert.match(out, /entry points or dead/);
  assert.match(out, /\bmain\b/, 'main() is called by nothing in the repo');
});

test('where_defined answers with one line per definition', () => {
  const out = whereDefined(ctx, { name: 'Order' });
  const lines = out.split('\n').filter((l) => l.trim() !== '');
  assert.ok(lines.length >= 1);
  assert.match(lines[0] as string, /app\/\S+\.py:\d+\s+\w+\s+/);
  assert.ok(estimateTokens(out) < 120, 'where_defined is the cheapest tool, keep it that way');
});

test('where_defined falls back to close names on a typo', () => {
  const out = whereDefined(ctx, { name: 'OrderServic' });
  assert.match(out, /no exact match|OrderService/);
});

test('every tool refuses a bad name the same way', async () => {
  const missing = 'definitely_not_here';
  const outputs = [
    getSymbol(ctx, { name: missing }),
    await findCallers(ctx, { symbol: missing }),
    await findCallees(ctx, { symbol: missing }),
    await impactOf(ctx, { target: missing }),
    whereDefined(ctx, { name: missing }),
  ];
  for (const out of outputs) {
    assert.match(out, /no symbol named "definitely_not_here"/);
    assert.ok(estimateTokens(out) < 200);
  }
});

test('changed_since reports plainly when git cannot answer', async () => {
  const out = await changedSince(ctx, { ref: 'no-such-ref-anywhere' });
  assert.match(out, /could not diff against no-such-ref-anywhere/);
});

test('a tight budget truncates and says what it dropped', async () => {
  const full = await impactOf(ctx, { target: 'Order', depth: 4, budget: 4000 });
  const tight = await impactOf(ctx, { target: 'Order', depth: 4, budget: 150 });

  assert.ok(tight.length < full.length, 'a smaller budget should produce less output');
  assert.ok(estimateTokens(tight) <= 200, `budget 150 produced ${estimateTokens(tight)} tokens`);
  assert.match(tight, /omitted:/);
});

test('the budget floor keeps output usable rather than empty', () => {
  const out = getSymbol(ctx, { name: 'OrderService', budget: 1 });
  assert.match(out, /OrderService/, 'even the smallest budget still names the symbol');
});

test('a huge budget is capped instead of trusted', () => {
  const out = overview(ctx, { budget: 10_000_000 });
  assert.ok(estimateTokens(out) < 20_000);
});

test('the whole point: a structural question costs a few hundred tokens', async () => {
  const questions = [
    searchSymbols(ctx, { query: 'Order' }),
    getSymbol(ctx, { name: 'OrderService.create' }),
    await findCallers(ctx, { symbol: 'slugify', depth: 2 }),
    await impactOf(ctx, { target: 'Order', depth: 3 }),
    overview(ctx, {}),
    whereDefined(ctx, { name: 'Order' }),
  ];
  for (const answer of questions) {
    const tokens = estimateTokens(answer);
    assert.ok(tokens > 0, 'no tool should answer with nothing');
    assert.ok(tokens < 800, `an answer cost ${tokens} tokens, which defeats the purpose:\n${answer}`);
  }
});

/**
 * Counts of exactly one are the easiest thing to get wrong, because the happy
 * path in a fixture always has several of everything. A single line reading
 * "1 files" is the kind of detail that makes a tool feel unfinished, so this
 * runs every tool against a repo where every count is 1 and reads the output
 * back looking for a plural that should not be there.
 */
test('a count of one is never printed with a plural noun', async () => {
  const root = await makeRepo('tiny', {
    'only.py': 'def only():\n    return helper()\n\n\ndef helper():\n    return 1\n',
  });
  const tiny = await indexRepo(root);
  const tinyCtx: ToolContext = {
    store: tiny.store,
    repo: 'tiny',
    repoRoot: root,
    defaultBudget: 2000,
    hasLinks: false,
  };

  const answers = [
    searchSymbols(tinyCtx, { query: 'only' }),
    getSymbol(tinyCtx, { name: 'only' }),
    whereDefined(tinyCtx, { name: 'helper' }),
    await findCallers(tinyCtx, { symbol: 'helper' }),
    await findCallees(tinyCtx, { symbol: 'only' }),
    await impactOf(tinyCtx, { target: 'helper' }),
    overview(tinyCtx, {}),
    shortestPathTool(tinyCtx, { a: 'only', b: 'helper' }),
  ];
  tiny.close();

  const nouns = [
    'files',
    'symbols',
    'edges',
    'functions',
    'callers',
    'callees',
    'modules',
    'directories',
    'definitions',
    'endpoints',
    'matches',
    'repos',
    'hops',
  ];
  const wrong = new RegExp(`\\b1 (?:more )?(?:${nouns.join('|')})\\b`);
  for (const answer of answers) {
    const bad = answer.split('\n').find((line) => wrong.test(line));
    assert.equal(bad, undefined, `a count of 1 was printed as a plural: ${bad}`);
  }
});
