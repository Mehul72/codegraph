// Benchmark behind the two claims codegraph makes: that answering a structural
// question through the index costs a fraction of the tokens that reading the
// code would, and that indexing and querying are fast enough to sit in the
// middle of an agent loop.
//
//   npm run bench
//   npm run --silent bench -- --json   machine readable output on stdout
//   npm run bench -- --keep            leave the generated corpus on disk
//   npm run bench -- --domains=6       smaller synthetic corpus
//   npm run bench -- --repo=/tmp/x     add a real repo of your own
//
// --json needs npm's --silent, or npm's own two line banner lands on stdout
// ahead of the JSON. Running the script directly does not need it.
//
// Nothing is downloaded. The first corpus is generated here, the second is a
// copy of this project's own src/ so there is a real repo in the numbers.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath } from 'node:url';

import { makeDefaultConfig, saveConfig } from '../src/config/config.js';
import { dbPath } from '../src/config/paths.js';
import { runIndex } from '../src/index/indexer.js';
import { lookupSymbol } from '../src/query/lookup.js';
import {
  findCallees,
  findCallers,
  getSymbol,
  impactOf,
  overview,
  searchSymbols,
  shortestPathTool,
  whereDefined,
} from '../src/query/tools.js';
import { CALL_TYPES, IMPACT_TYPES, shortestPath, traverse } from '../src/query/traverse.js';
import { Store } from '../src/store/store.js';
import { estimateTokens, formatCount, formatDuration, pad, truncate } from '../src/util/text.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratchDir = path.join(projectRoot, '.scratch', 'bench');

// The registry is the one thing codegraph keeps outside a repo, and a
// benchmark has no business writing to the developer's home directory. The
// library reads this lazily, so setting it here is early enough.
process.env.CODEGRAPH_HOME = path.join(scratchDir, 'home');

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const keepCorpus = args.includes('--keep');
const domainCount = intFlag('--domains', 10);
const externalRepo = stringFlag('--repo');

const ENTITIES_PER_DOMAIN = 4;
const LATENCY_RUNS = 15;

/** Where the questions are sampled from the symbol ranking, as fractions. */
const SAMPLE_POINTS = {
  find_callers: [0.05, 0.4, 0.75],
  impact_of: [0.15, 0.5, 0.85],
  get_symbol: [0.6],
  overview: [0.15, 0.6],
};

async function main() {
  await fsp.rm(scratchDir, { recursive: true, force: true });
  await fsp.mkdir(scratchDir, { recursive: true });

  const corpora = [await buildSynthetic(), await buildOwnSource()];
  if (externalRepo) corpora.push(await buildExternal(externalRepo));
  const results = [];
  for (const corpus of corpora) results.push(await measure(corpus));

  if (asJson) console.log(JSON.stringify(toJson(results), null, 2));
  else console.log(renderReport(results));

  if (keepCorpus) step(`corpus kept at ${path.relative(projectRoot, scratchDir)}`);
  else await fsp.rm(scratchDir, { recursive: true, force: true });
}

// ------------------------------------------------------------------ corpora

async function buildSynthetic() {
  const root = path.join(scratchDir, 'synthetic');
  step(`generating a ${domainCount} domain synthetic repo`);
  await writeTree(root, synthesizeRepo(domainCount, ENTITIES_PER_DOMAIN));

  const config = makeDefaultConfig(root);
  await saveConfig(root, config);
  return {
    name: 'synthetic',
    root,
    config,
    editTarget: `services/${DOMAINS[0]}/service/${ENTITIES[0]}_service.py`,
    editSuffix: PYTHON_PROBE,
  };
}

/**
 * The real-world case. src/ is copied rather than indexed in place so the
 * benchmark cannot write a .codegraph directory into the working tree or
 * disturb an index the developer is using.
 */
async function buildOwnSource() {
  const root = path.join(scratchDir, 'codegraph-src');
  await fsp.mkdir(root, { recursive: true });
  await fsp.cp(path.join(projectRoot, 'src'), path.join(root, 'src'), { recursive: true });

  // tsconfig.json and package.json travel with the copy, because path aliases
  // and the package name change how imports resolve.
  for (const file of ['tsconfig.json', 'package.json']) {
    await fsp.cp(path.join(projectRoot, file), path.join(root, file));
  }

  const config = { ...makeDefaultConfig(root), repo: 'codegraph' };
  await saveConfig(root, config);
  return { name: 'codegraph src', root, config, editTarget: 'src/query/tools.ts', editSuffix: TYPESCRIPT_PROBE };
}

/**
 * Whatever repo the caller pointed --repo at. Clone something substantial and
 * run it through here when you want to know whether a change slowed indexing
 * down on real code:
 *
 *   git clone --depth 1 https://github.com/django/django /tmp/django
 *   npm run bench -- --repo=/tmp/django
 *
 * The tree is copied into the scratch directory first. The benchmark appends
 * to a source file to time an incremental pass, and doing that to someone's
 * actual working copy would be unforgivable.
 */
async function buildExternal(repoPath) {
  const source = path.resolve(repoPath);
  const name = path.basename(source);
  const root = path.join(scratchDir, `external-${name}`);

  step(`copying ${source}`);
  await fsp.cp(source, root, {
    recursive: true,
    // .git dwarfs the sources it is tracking, and neither it nor an installed
    // dependency tree would be indexed anyway.
    filter: (entry) => !SKIP_ON_COPY.has(path.basename(entry)),
  });
  await fsp.rm(path.join(root, '.codegraph'), { recursive: true, force: true });

  const config = { ...makeDefaultConfig(root), repo: name };
  await saveConfig(root, config);
  // Which file to edit is not knowable until the index says which one carries
  // the most symbols, so measure() fills it in.
  return { name, root, config, editTarget: null, editSuffix: '\n' };
}

const SKIP_ON_COPY = new Set(['.git', 'node_modules', '.codegraph', 'dist', 'build', 'target', '.venv']);

// -------------------------------------------------------------- measurement

async function measure(corpus) {
  step(`indexing ${corpus.name}`);
  // The first pass is cold because the database does not exist yet, and the
  // second is warm because nothing has changed since.
  const cold = await timeIndex(corpus);
  const warm = await timeIndex(corpus);

  const store = Store.open(dbPath(corpus.root));
  const ctx = {
    store,
    repo: corpus.config.repo,
    repoRoot: corpus.root,
    defaultBudget: corpus.config.defaultBudget,
    hasLinks: false,
  };

  step(`answering ${corpus.name} questions`);
  const questions = pickQuestions(store);
  const scored = [];
  for (const question of questions) scored.push(await scoreQuestion(ctx, question));

  step(`timing ${corpus.name} queries`);
  const latency = await measureLatency(ctx, questions);
  const editTarget = corpus.editTarget ?? busiestFile(store);
  store.close();

  step(`reindexing one file of ${corpus.name}`);
  const incremental = await timeIncremental({ ...corpus, editTarget });

  return { corpus, cold, warm, incremental, questions: scored, latency };
}

async function timeIndex(corpus) {
  const store = Store.open(dbPath(corpus.root));
  const started = performance.now();
  const stats = await runIndex({
    repoRoot: corpus.root,
    config: corpus.config,
    store,
    progress: false,
  });
  const ms = performance.now() - started;
  const result = {
    ms,
    stats,
    nodes: store.nodeCount(),
    edges: store.edgeCount(),
    languages: store.langCounts().map((row) => row.lang),
  };
  store.close();
  return result;
}

async function timeIncremental(corpus) {
  const target = path.join(corpus.root, corpus.editTarget);
  const before = await fsp.readFile(target, 'utf8');
  await fsp.writeFile(target, before + corpus.editSuffix, 'utf8');

  // A coarse mtime clock would otherwise let the edit look unchanged.
  const later = new Date(Date.now() + 2000);
  await fsp.utimes(target, later, later);
  return timeIndex(corpus);
}

// ---------------------------------------------------------------- questions

/**
 * How the reading baseline is defined.
 *
 * For each question we count the files that hold the answer, and only those:
 * the callers plus the definition for find_callers, everything reachable at
 * the depth the tool itself used for impact_of, every indexed file under the
 * directory for overview, the files along the chain for shortest_path, and the
 * defining file for get_symbol. Whole files are counted, with the same
 * estimator that measures the answer, because an agent reads whole files.
 *
 * This is the smallest defensible baseline. It gives the reading route perfect
 * foresight: nothing is counted for the greps, the wrong guesses and the
 * follow-up reads an agent needs before it knows which files those are. Two
 * question types are excluded for the same reason. search_symbols and
 * where_defined are out because grep answers them cheaply, and a repo-wide
 * overview is out because counting every file in the repo would flatter the
 * ratio far more than it deserves.
 *
 * Symbols are sampled across the whole ranking rather than taken from the top,
 * since the most depended on symbols are exactly the ones with the largest
 * reading baseline.
 */
function pickQuestions(store) {
  const ranked = rankedSymbols(store);
  const directories = rankedDirectories(store);
  const questions = [];

  for (const fraction of SAMPLE_POINTS.find_callers) {
    const target = sampleSymbol(store, ranked, fraction);
    if (!target) continue;
    const symbol = target.query;
    const reached = traverse({ store, roots: [target.node.id], direction: 'in', depth: 1, types: CALL_TYPES });
    questions.push({
      tool: 'find_callers',
      symbol,
      label: `find_callers ${symbol}`,
      run: (ctx) => findCallers(ctx, { symbol }),
      files: filesOf(store, reached, target.node),
    });
  }

  for (const fraction of SAMPLE_POINTS.impact_of) {
    const target = sampleSymbol(store, ranked, fraction);
    if (!target) continue;
    const symbol = target.query;
    const reached = traverse({
      store,
      roots: [target.node.id],
      direction: 'in',
      depth: 3,
      types: IMPACT_TYPES,
      maxNodes: 4000,
    });
    questions.push({
      tool: 'impact_of',
      symbol,
      label: `impact_of ${symbol}`,
      run: (ctx) => impactOf(ctx, { target: symbol }),
      files: filesOf(store, reached, target.node),
    });
  }

  for (const fraction of SAMPLE_POINTS.get_symbol) {
    const target = sampleSymbol(store, ranked, fraction);
    if (!target) continue;
    const symbol = target.query;
    questions.push({
      tool: 'get_symbol',
      symbol,
      label: `get_symbol ${symbol}`,
      run: (ctx) => getSymbol(ctx, { name: symbol }),
      files: [target.node.path],
    });
  }

  for (const fraction of SAMPLE_POINTS.overview) {
    const directory = sampleAt(directories, fraction);
    if (!directory) continue;
    questions.push({
      tool: 'overview',
      directory: directory.path,
      label: `overview ${directory.path}`,
      run: (ctx) => overview(ctx, { path: directory.path }),
      files: directory.files,
    });
  }

  const pair = pickConnectedPair(store, ranked);
  if (pair) {
    questions.push({
      tool: 'shortest_path',
      pair: { a: pair.a, b: pair.b },
      label: `shortest_path ${pair.a} to ${pair.b}`,
      run: (ctx) => shortestPathTool(ctx, { a: pair.a, b: pair.b }),
      files: pair.files,
    });
  }

  const seen = new Set();
  return questions.filter((question) => {
    if (seen.has(question.label)) return false;
    seen.add(question.label);
    return true;
  });
}

/** Symbols with at least one dependent, most depended on first. */
function rankedSymbols(store) {
  const degrees = store.degreeCounts();
  return store
    .allNodesLite()
    .filter((node) => node.kind !== 'module' && (degrees.get(node.id) ?? 0) > 0)
    .map((node) => ({ node, degree: degrees.get(node.id) ?? 0 }))
    .sort(
      (a, b) =>
        b.degree - a.degree ||
        a.node.path.localeCompare(b.node.path) ||
        a.node.name.localeCompare(b.node.name),
    );
}

/**
 * Directories worth asking overview about. Only leaf directories qualify: a
 * parent would pull in every file underneath it, which is the repo-wide case
 * this benchmark deliberately leaves out.
 */
function rankedDirectories(store) {
  const perDir = new Map();
  for (const node of store.allNodesLite()) {
    if (!node.path.includes('/')) continue;
    const dir = node.path.slice(0, node.path.lastIndexOf('/'));
    let files = perDir.get(dir);
    if (!files) {
      files = new Set();
      perDir.set(dir, files);
    }
    files.add(node.path);
  }

  return [...perDir.entries()]
    .map(([dirPath, direct]) => ({
      path: dirPath,
      direct: direct.size,
      files: [...new Set(store.nodesUnderPath(dirPath).map((node) => node.path))].sort(),
    }))
    .filter((entry) => entry.files.length >= 3 && entry.files.length === entry.direct)
    .sort((a, b) => b.files.length - a.files.length || a.path.localeCompare(b.path));
}

/**
 * Resolve the sampled symbol the same way the tool will, so the answer and the
 * baseline are talking about the same definition.
 */
function sampleSymbol(store, ranked, fraction) {
  const sampled = sampleAt(ranked, fraction);
  if (!sampled) return null;
  const query = sampled.node.qualified ?? sampled.node.name;
  const node = lookupSymbol(store, query).matches[0];
  return node ? { query, node } : null;
}

function sampleAt(list, fraction) {
  if (list.length === 0) return null;
  return list[Math.min(list.length - 1, Math.floor(fraction * list.length))];
}

function pickConnectedPair(store, ranked) {
  const hub = ranked[0]?.node;
  if (!hub) return null;

  const reached = traverse({ store, roots: [hub.id], direction: 'in', depth: 3 });
  const furthest = [...reached].sort((a, b) => b.distance - a.distance)[0];
  if (!furthest) return null;

  const hops = shortestPath(store, furthest.id, hub.id);
  if (hops === null || hops.length === 0) return null;

  const ids = new Set([furthest.id, hub.id]);
  for (const hop of hops) {
    ids.add(hop.srcId);
    ids.add(hop.dstId);
  }
  const nodes = store.getNodes([...ids]);
  const from = nodes.find((node) => node.id === furthest.id);
  if (!from) return null;

  return {
    a: from.qualified ?? from.name,
    b: hub.qualified ?? hub.name,
    files: [...new Set(nodes.map((node) => node.path))].sort(),
  };
}

function filesOf(store, reached, rootNode) {
  const nodes = store.getNodes(reached.map((hit) => hit.id));
  const paths = new Set(nodes.map((node) => node.path));
  paths.add(rootNode.path);
  return [...paths].sort();
}

async function scoreQuestion(ctx, question) {
  const answer = await question.run(ctx);
  const answerTokens = estimateTokens(answer);
  const readingTokens = await tokensOfFiles(ctx.repoRoot, question.files);
  return {
    tool: question.tool,
    label: question.label,
    answerTokens,
    files: question.files.length,
    readingTokens,
    saving: answerTokens === 0 ? 0 : readingTokens / answerTokens,
  };
}

const fileTokenCache = new Map();

async function tokensOfFiles(repoRoot, files) {
  let total = 0;
  for (const relative of files) {
    const absolute = path.join(repoRoot, relative);
    let tokens = fileTokenCache.get(absolute);
    if (tokens === undefined) {
      try {
        tokens = estimateTokens(await fsp.readFile(absolute, 'utf8'));
      } catch {
        tokens = 0; // an external stub, which has no file to read
      }
      fileTokenCache.set(absolute, tokens);
    }
    total += tokens;
  }
  return total;
}

// ------------------------------------------------------------------ latency

/**
 * changed_since is left out: it shells out to git, so it would measure git
 * rather than the index.
 */
async function measureLatency(ctx, questions) {
  const symbols = unique(questions.map((question) => question.symbol).filter(Boolean));
  const directories = unique(questions.map((question) => question.directory).filter(Boolean));
  const pair = questions.find((question) => question.tool === 'shortest_path')?.pair;

  const plan = [
    ['search_symbols', symbols.map((name) => () => searchSymbols(ctx, { query: searchStem(name) }))],
    ['where_defined', symbols.map((name) => () => whereDefined(ctx, { name }))],
    ['get_symbol', symbols.map((name) => () => getSymbol(ctx, { name }))],
    ['find_callers', symbols.map((name) => () => findCallers(ctx, { symbol: name }))],
    ['find_callees', symbols.map((name) => () => findCallees(ctx, { symbol: name }))],
    ['impact_of', symbols.map((name) => () => impactOf(ctx, { target: name }))],
    ['overview', directories.map((directory) => () => overview(ctx, { path: directory }))],
    ['shortest_path', pair ? [() => shortestPathTool(ctx, pair)] : []],
  ];

  const timings = {};
  for (const [tool, calls] of plan) {
    if (calls.length === 0) continue;
    const samples = [];
    for (let run = 0; run < LATENCY_RUNS; run++) {
      const call = calls[run % calls.length];
      const started = performance.now();
      await call();
      samples.push(performance.now() - started);
    }
    timings[tool] = median(samples);
  }
  return timings;
}

/** A partial name, which is what an agent actually types into a search. */
function searchStem(name) {
  const last = name.split('.').pop() ?? name;
  return last.slice(0, Math.max(4, Math.min(7, last.length - 2)));
}

// ------------------------------------------------------------------- report

function renderReport(results) {
  const questions = results.flatMap((result) => result.questions);
  const answerTokens = sum(questions.map((question) => question.answerTokens));
  const readingTokens = sum(questions.map((question) => question.readingTokens));
  const medianSaving = median(questions.map((question) => question.saving));

  const out = [];
  out.push('codegraph benchmark');
  out.push(`${process.version} on ${process.platform} ${process.arch}`);
  out.push('');
  out.push('headline');
  out.push(`  ${padLeft(ratio(medianSaving), 5)}  median token saving over reading the code, across ${questions.length} questions`);
  out.push(
    `  ${padLeft(ratio(readingTokens / answerTokens), 5)}  saving in total: ${formatCount(answerTokens)} tokens of answers ` +
      `against ${formatCount(readingTokens)} tokens of reading`,
  );
  out.push('');

  for (const result of results) {
    out.push(`token cost, ${result.corpus.name}`);
    out.push(
      `  ${pad('question', 44)}${padLeft('answer', 8)}${padLeft('files', 7)}${padLeft('reading', 10)}${padLeft('saving', 9)}`,
    );
    for (const question of result.questions) {
      out.push(
        `  ${pad(truncate(question.label, 44), 44)}${padLeft(formatCount(question.answerTokens), 8)}` +
          `${padLeft(formatCount(question.files), 7)}${padLeft(formatCount(question.readingTokens), 10)}` +
          `${padLeft(ratio(question.saving), 9)}`,
      );
    }
    const totalAnswer = sum(result.questions.map((question) => question.answerTokens));
    const totalReading = sum(result.questions.map((question) => question.readingTokens));
    out.push(
      `  ${pad('total', 44)}${padLeft(formatCount(totalAnswer), 8)}${padLeft('', 7)}` +
        `${padLeft(formatCount(totalReading), 10)}${padLeft(ratio(totalReading / totalAnswer), 9)}`,
    );
    out.push('');
  }

  out.push('what the reading column counts');
  out.push('  Whole files that hold the answer and nothing else: the callers plus the definition');
  out.push('  for find_callers, everything reachable at the same depth for impact_of, the files');
  out.push('  under the directory for overview, the files along the chain for shortest_path, and');
  out.push('  the defining file for get_symbol. Measured with the same estimator as the answer.');
  out.push('  That hands the reading route perfect foresight, since a real agent pays for greps');
  out.push('  and dead ends before it knows which files to open. search_symbols and where_defined');
  out.push('  are excluded because grep answers them cheaply, and a repo-wide overview because it');
  out.push('  would flatter the ratio. Answers are capped at the default 1200 token budget.');
  out.push('');

  out.push('indexing');
  out.push(
    `  ${pad('corpus', 15)}${padLeft('files', 6)}${padLeft('symbols', 9)}${padLeft('edges', 8)}` +
      `${padLeft('cold', 9)}${padLeft('warm', 9)}${padLeft('1 file', 9)}${padLeft('symbols/s', 11)}${padLeft('edges/s', 10)}`,
  );
  for (const result of results) {
    const seconds = result.cold.ms / 1000;
    out.push(
      `  ${pad(result.corpus.name, 15)}${padLeft(formatCount(result.cold.stats.filesIndexed), 6)}` +
        `${padLeft(formatCount(result.cold.nodes), 9)}${padLeft(formatCount(result.cold.edges), 8)}` +
        `${padLeft(formatDuration(result.cold.ms), 9)}${padLeft(formatDuration(result.warm.ms), 9)}` +
        `${padLeft(formatDuration(result.incremental.ms), 9)}` +
        `${padLeft(formatCount(Math.round(result.cold.nodes / seconds)), 11)}` +
        `${padLeft(formatCount(Math.round(result.cold.edges / seconds)), 10)}`,
    );
  }
  out.push('  warm is a reindex with nothing changed, 1 file is a reindex after one edit.');
  out.push('  Both include the full rescan, which is what runs before every query.');
  out.push('');

  const tools = unique(results.flatMap((result) => Object.keys(result.latency)));
  out.push(`query latency, median of ${LATENCY_RUNS} calls (ms)`);
  out.push(`  ${pad('tool', 16)}${results.map((result) => padLeft(result.corpus.name, 16)).join('')}`);
  for (const tool of tools) {
    const cells = results.map((result) => padLeft(millis(result.latency[tool]), 16)).join('');
    out.push(`  ${pad(tool, 16)}${cells}`);
  }
  return out.join('\n');
}

function toJson(results) {
  const questions = results.flatMap((result) => result.questions);
  const answerTokens = sum(questions.map((question) => question.answerTokens));
  const readingTokens = sum(questions.map((question) => question.readingTokens));

  return {
    node: process.version,
    platform: `${process.platform} ${process.arch}`,
    generatedAt: new Date().toISOString(),
    headline: {
      questions: questions.length,
      medianSaving: round(median(questions.map((question) => question.saving))),
      answerTokens,
      readingTokens,
      totalSaving: round(readingTokens / answerTokens),
    },
    corpora: results.map((result) => ({
      name: result.corpus.name,
      files: result.cold.stats.filesIndexed,
      symbols: result.cold.nodes,
      edges: result.cold.edges,
      languages: result.cold.languages,
      unresolvedRefs: result.cold.stats.unresolvedRefs,
      index: {
        coldMs: round(result.cold.ms),
        warmMs: round(result.warm.ms),
        incrementalMs: round(result.incremental.ms),
        symbolsPerSecond: Math.round(result.cold.nodes / (result.cold.ms / 1000)),
        edgesPerSecond: Math.round(result.cold.edges / (result.cold.ms / 1000)),
      },
      questions: result.questions.map((question) => ({ ...question, saving: round(question.saving) })),
      latencyMs: Object.fromEntries(
        Object.entries(result.latency).map(([tool, value]) => [tool, round(value)]),
      ),
    })),
  };
}

// ------------------------------------------------------------------- corpus

const DOMAINS = [
  'billing',
  'catalog',
  'shipping',
  'identity',
  'inventory',
  'messaging',
  'payments',
  'pricing',
  'search',
  'support',
  'reporting',
  'scheduling',
];

const ENTITIES = [
  'invoice', 'ledger', 'refund', 'statement',
  'product', 'variant', 'bundle', 'catalogue',
  'shipment', 'parcel', 'carrier', 'manifest',
  'account', 'session', 'credential', 'role',
  'warehouse', 'pallet', 'lot', 'reservation',
  'message', 'template', 'digest', 'subscriber',
  'payment', 'mandate', 'payout', 'chargeback',
  'tariff', 'discount', 'markup', 'quote',
  'facet', 'synonym', 'ranking', 'phrase',
  'ticket', 'macro', 'escalation', 'survey',
  'report', 'snapshot', 'dataset', 'dashboard',
  'job', 'trigger', 'calendar', 'slot',
];

const GO_MODULE = 'bench.example/app';

const PYTHON_PROBE = `

def bench_probe(value: str) -> str:
    """Appended by the benchmark to measure an incremental reindex."""
    return value.strip()
`;

const TYPESCRIPT_PROBE = `
/** Appended by the benchmark to measure an incremental reindex. */
export function benchProbe(value: string): string {
  return value.trim();
}
`;

/**
 * A repo shaped like a service tree, in three languages, with imports the
 * resolver has to work for: relative and aliased in TypeScript, dotted in
 * Python, module prefixed and aliased in Go. Cross-domain edges only ever
 * point at a later domain, so the graph stays a DAG with real depth.
 */
function synthesizeRepo(domains, entitiesPerDomain) {
  const ceiling = Math.min(DOMAINS.length, Math.floor(ENTITIES.length / entitiesPerDomain));
  if (domains > ceiling) throw new Error(`--domains must be ${ceiling} or less`);

  const plan = DOMAINS.slice(0, domains).map((name, index) => ({
    name,
    index,
    entities: ENTITIES.slice(index * entitiesPerDomain, index * entitiesPerDomain + entitiesPerDomain),
  }));
  for (const domain of plan) {
    domain.deps = [domain.index + 1, domain.index + 3]
      .filter((index) => index < plan.length)
      .map((index) => ({ domain: plan[index].name, entity: plan[index].entities[0] }));
  }

  const files = new Map();
  files.set('go.mod', `module ${GO_MODULE}\n\ngo 1.22\n`);
  files.set('package.json', JSON.stringify({ name: 'bench-web', private: true, type: 'module' }, null, 2) + '\n');
  files.set('tsconfig.json', TSCONFIG);
  files.set('db/schema.sql', sqlSchema(plan));

  files.set('services/__init__.py', '"""Synthetic service tree used by the codegraph benchmark."""\n');
  files.set('services/common/errors.py', PY_ERRORS);
  files.set('services/common/clock.py', PY_CLOCK);
  files.set('services/common/pagination.py', PY_PAGINATION);
  files.set('services/common/audit.py', PY_AUDIT);
  files.set('services/common/http.py', PY_ROUTER);

  files.set('internal/common/errors.go', GO_ERRORS);
  files.set('internal/common/clock.go', GO_CLOCK);
  files.set('internal/common/page.go', GO_PAGE);
  files.set('internal/common/audit.go', GO_AUDIT);

  files.set('web/src/common/errors.ts', TS_ERRORS);
  files.set('web/src/common/clock.ts', TS_CLOCK);
  files.set('web/src/common/page.ts', TS_PAGE);
  files.set('web/src/common/audit.ts', TS_AUDIT);
  files.set('web/src/common/router.ts', TS_ROUTER);

  for (const domain of plan) {
    files.set(`services/${domain.name}/__init__.py`, pythonPackage(domain));
    files.set(`services/${domain.name}/api/handlers.py`, pythonHandlers(domain));
    files.set(`internal/${domain.name}/api/handlers.go`, goHandlers(domain));
    files.set(`web/src/${domain.name}/routes.ts`, tsRoutes(domain));

    for (const entity of domain.entities) {
      files.set(`services/${domain.name}/models/${entity}.py`, pythonModel(domain, entity));
      files.set(`services/${domain.name}/repository/${entity}_repository.py`, pythonRepository(domain, entity));
      files.set(`services/${domain.name}/service/${entity}_service.py`, pythonService(domain, entity));

      files.set(`internal/${domain.name}/model/${entity}.go`, goModel(domain, entity));
      files.set(`internal/${domain.name}/store/${entity}_store.go`, goStore(domain, entity));
      files.set(`internal/${domain.name}/service/${entity}_service.go`, goService(domain, entity));

      files.set(`web/src/${domain.name}/model/${entity}.ts`, tsModel(domain, entity));
      files.set(`web/src/${domain.name}/repo/${entity}Repo.ts`, tsRepo(domain, entity));
      files.set(`web/src/${domain.name}/service/${entity}Service.ts`, tsService(domain, entity));
    }
  }
  return files;
}

async function writeTree(root, files) {
  for (const [relative, contents] of files) {
    const target = path.join(root, relative);
    await fsp.mkdir(path.dirname(target), { recursive: true });
    await fsp.writeFile(target, contents, 'utf8');
  }
}

const TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "baseUrl": ".",
    "paths": {
      "@common/*": ["web/src/common/*"]
    }
  },
  "include": ["web/src/**/*.ts"]
}
`;

function sqlSchema(plan) {
  const out = ['-- Schema for the synthetic benchmark repo.', ''];
  for (const domain of plan) {
    for (const entity of domain.entities) {
      out.push(`CREATE TABLE ${entity}s (`);
      out.push('  id TEXT PRIMARY KEY,');
      out.push('  tenant_id TEXT NOT NULL,');
      out.push('  amount_cents INTEGER NOT NULL,');
      out.push("  status TEXT NOT NULL DEFAULT 'draft',");
      out.push('  updated_ms INTEGER NOT NULL DEFAULT 0');
      out.push(');');
      out.push(`CREATE INDEX ${entity}s_tenant_idx ON ${entity}s (tenant_id);`);
      out.push('');
    }
  }
  return out.join('\n');
}

// ----------------------------------------------------------- corpus: python

const PY_ERRORS = `"""Errors shared by every service in this tree."""


class ServiceError(Exception):
    """Base class for anything these packages raise."""

    def __init__(self, message: str, code: str = "service_error") -> None:
        super().__init__(message)
        self.code = code

    def to_dict(self) -> dict:
        """Render the error in the shape the API returns."""
        return {"code": self.code, "message": str(self)}


class ValidationError(ServiceError):
    """A record was rejected before it reached storage."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="invalid")


class NotFoundError(ServiceError):
    """A lookup by id found nothing."""

    def __init__(self, message: str) -> None:
        super().__init__(message, code="not_found")
`;

const PY_CLOCK = `"""Time helpers, kept in one place so tests can freeze them."""

import time


def now_ms() -> int:
    """Milliseconds since the epoch."""
    return int(time.time() * 1000)


def deadline_ms(seconds: int) -> int:
    """A timestamp the given number of seconds into the future."""
    return now_ms() + seconds * 1000
`;

const PY_PAGINATION = `"""Offset pagination, shared by every repository."""

from dataclasses import dataclass
from typing import Any, List

PAGE_SIZE = 50


@dataclass
class Page:
    """One page of rows plus the offset that follows it."""

    rows: List[Any]
    next_offset: int

    def is_last(self) -> bool:
        """True when there is nothing after this page."""
        return self.next_offset == 0


def paginate(rows: List[Any], offset: int = 0, size: int = PAGE_SIZE) -> Page:
    """Slice rows into a page starting at offset."""
    window = rows[offset : offset + size]
    following = offset + size if offset + size < len(rows) else 0
    return Page(rows=window, next_offset=following)
`;

const PY_AUDIT = `"""The audit trail every write goes through."""

from dataclasses import dataclass
from typing import Any, Dict, List

from services.common.clock import now_ms


@dataclass
class AuditEvent:
    """One recorded change, ready to be shipped to the audit log."""

    actor: str
    action: str
    subject: str
    at_ms: int

    def to_dict(self) -> Dict[str, Any]:
        return {"actor": self.actor, "action": self.action, "subject": self.subject, "at": self.at_ms}


_EVENTS: List[AuditEvent] = []


def record_event(actor: str, action: str, subject: str) -> AuditEvent:
    """Append one event to the trail and hand it back."""
    event = AuditEvent(actor=actor, action=action, subject=subject, at_ms=now_ms())
    _EVENTS.append(event)
    return event


def events_for(subject: str) -> List[AuditEvent]:
    """Every recorded event about one subject, oldest first."""
    return [event for event in _EVENTS if event.subject == subject]


def clear_events() -> None:
    """Drop the trail, which only the tests need."""
    _EVENTS.clear()
`;

const PY_ROUTER = `"""A small router, so the handler modules have something to register with."""

from typing import Callable, Dict, Tuple


class Router:
    """Collects handlers by method and path."""

    def __init__(self, prefix: str = "") -> None:
        self.prefix = prefix
        self.routes: Dict[Tuple[str, str], Callable] = {}

    def register(self, method: str, route: str) -> Callable:
        """Return a decorator that records one handler."""

        def decorate(handler: Callable) -> Callable:
            self.routes[(method, self.prefix + route)] = handler
            return handler

        return decorate

    def get(self, route: str) -> Callable:
        return self.register("GET", route)

    def post(self, route: str) -> Callable:
        return self.register("POST", route)

    def delete(self, route: str) -> Callable:
        return self.register("DELETE", route)
`;

function pythonPackage(domain) {
  const entity = domain.entities[0];
  return `"""The ${domain.name} domain."""

from services.${domain.name}.service.${entity}_service import ${pascal(entity)}Service

__all__ = ["${pascal(entity)}Service"]
`;
}

function pythonModel(domain, entity) {
  const Type = pascal(entity);
  return `"""${Type} records for the ${domain.name} domain."""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Dict, List

from services.common.clock import now_ms
from services.common.errors import ValidationError

# The states one ${entity} moves through, in the order they are reached.
STATUSES = ("draft", "open", "settled", "void")


@dataclass
class ${Type}Line:
    """One line of one ${entity}."""

    label: str
    amount_cents: int

    def is_credit(self) -> bool:
        """True when this line gives money back."""
        return self.amount_cents < 0


@dataclass
class ${Type}:
    """One ${entity} as the ${domain.name} service stores it."""

    id: str
    tenant_id: str
    amount_cents: int
    status: str = "draft"
    updated_ms: int = 0
    lines: List[${Type}Line] = field(default_factory=list)

    def validate(self) -> None:
        """Raise if the record is not fit to persist."""
        if self.amount_cents < 0:
            raise ValidationError("${entity} amount must not be negative")
        if not self.tenant_id:
            raise ValidationError("${entity} needs a tenant")
        if self.status not in STATUSES:
            raise ValidationError(f"unknown ${entity} status {self.status}")

    def touch(self) -> None:
        """Stamp the record with the current time."""
        self.updated_ms = now_ms()

    def add_line(self, label: str, amount_cents: int) -> ${Type}Line:
        """Append one line and keep the total in step with it."""
        line = ${Type}Line(label=label, amount_cents=amount_cents)
        self.lines.append(line)
        self.amount_cents += amount_cents
        self.touch()
        return line

    def advance(self, status: str) -> None:
        """Move the record forward, never back."""
        if status not in STATUSES:
            raise ValidationError(f"unknown ${entity} status {status}")
        if STATUSES.index(status) < STATUSES.index(self.status):
            raise ValidationError("${entity} status cannot move backwards")
        self.status = status
        self.touch()

    def is_settled(self) -> bool:
        """True once the record has reached a terminal state."""
        return self.status in ("settled", "void")

    def summarise(self) -> str:
        return f"${entity} {self.id} for {self.tenant_id} ({self.status})"

    def to_dict(self) -> Dict[str, Any]:
        """Render the record in the shape the API returns."""
        return {
            "id": self.id,
            "tenant": self.tenant_id,
            "amount_cents": self.amount_cents,
            "status": self.status,
            "lines": [{"label": line.label, "amount_cents": line.amount_cents} for line in self.lines],
        }


def new_${entity}(tenant_id: str, amount_cents: int) -> ${Type}:
    """Build one ${entity} with the server side defaults filled in."""
    record = ${Type}(id=f"${entity}-{tenant_id}", tenant_id=tenant_id, amount_cents=amount_cents)
    record.touch()
    record.validate()
    return record


def parse_${entity}(payload: Dict[str, Any]) -> ${Type}:
    """Build one ${entity} from an API payload, rejecting anything unusable."""
    tenant = payload.get("tenant")
    if not isinstance(tenant, str) or not tenant:
        raise ValidationError("${entity} payload needs a tenant")
    amount = payload.get("amount_cents", 0)
    if not isinstance(amount, int):
        raise ValidationError("${entity} amount must be a whole number of cents")
    record = new_${entity}(tenant, amount)
    for line in payload.get("lines", []):
        record.add_line(str(line.get("label", "")), int(line.get("amount_cents", 0)))
    return record


def total_of(records: List[${Type}]) -> int:
    """Sum the amounts of many ${entity} records."""
    return sum(record.amount_cents for record in records)
`;
}

function pythonRepository(domain, entity) {
  const Type = pascal(entity);
  return `"""Storage access for ${Type}."""

from __future__ import annotations

from typing import Dict, List, Optional

from services.${domain.name}.models.${entity} import ${Type}, new_${entity}, total_of
from services.common.audit import record_event
from services.common.errors import NotFoundError
from services.common.pagination import Page, paginate

SELECT_BY_ID = "SELECT id, tenant_id, amount_cents, status FROM ${entity}s WHERE id = ?"
SELECT_FOR_TENANT = "SELECT id, amount_cents FROM ${entity}s WHERE tenant_id = ? ORDER BY updated_ms DESC"
DELETE_BY_ID = "DELETE FROM ${entity}s WHERE id = ?"


class ${Type}Repository:
    """Keeps ${entity} rows in memory, which is enough for the benchmark."""

    def __init__(self, actor: str = "system") -> None:
        self._rows: Dict[str, ${Type}] = {}
        self._actor = actor

    def save(self, record: ${Type}) -> ${Type}:
        """Validate and store one ${entity}."""
        record.validate()
        record.touch()
        self._rows[record.id] = record
        record_event(self._actor, "save", record.id)
        return record

    def get(self, record_id: str) -> ${Type}:
        """Load one ${entity} or raise."""
        found = self._rows.get(record_id)
        if found is None:
            raise NotFoundError(f"no ${entity} with id {record_id}")
        return found

    def find(self, record_id: str) -> Optional[${Type}]:
        """Load one ${entity}, or None when there is nothing to load."""
        return self._rows.get(record_id)

    def exists(self, record_id: str) -> bool:
        """True when the id is known."""
        return record_id in self._rows

    def create(self, tenant_id: str, amount_cents: int) -> ${Type}:
        """Build and store one new ${entity}."""
        return self.save(new_${entity}(tenant_id, amount_cents))

    def update_status(self, record_id: str, status: str) -> ${Type}:
        """Move one ${entity} to a later status."""
        record = self.get(record_id)
        record.advance(status)
        return self.save(record)

    def rows_for_tenant(self, tenant_id: str) -> List[${Type}]:
        """Every ${entity} belonging to one tenant, newest first."""
        rows = [row for row in self._rows.values() if row.tenant_id == tenant_id]
        rows.sort(key=lambda row: row.updated_ms, reverse=True)
        return rows

    def list_for_tenant(self, tenant_id: str, offset: int = 0) -> Page:
        """One page of this tenant's ${entity} rows."""
        return paginate(self.rows_for_tenant(tenant_id), offset)

    def balance_for_tenant(self, tenant_id: str) -> int:
        """What this tenant's open ${entity} rows come to."""
        return total_of([row for row in self.rows_for_tenant(tenant_id) if not row.is_settled()])

    def delete(self, record_id: str) -> None:
        """Remove one ${entity}, raising if it was never there."""
        self.get(record_id)
        del self._rows[record_id]
        record_event(self._actor, "delete", record_id)
`;
}

function pythonService(domain, entity) {
  const Type = pascal(entity);
  const depImports = domain.deps
    .map((dep) => `from services.${dep.domain}.service.${dep.entity}_service import ${pascal(dep.entity)}Service`)
    .join('\n');
  const depParams = domain.deps.map((dep) => `${dep.entity}: ${pascal(dep.entity)}Service`).join(', ');
  const depAssigns = domain.deps.map((dep) => `        self._${dep.entity} = ${dep.entity}`).join('\n');
  const depCalls = domain.deps.map((dep) => `        self._${dep.entity}.observe(record.summarise())`).join('\n');

  return `"""Business rules for ${entity}."""

from __future__ import annotations

from typing import Any, Dict, List

from services.${domain.name}.models.${entity} import ${Type}, parse_${entity}
from services.${domain.name}.repository.${entity}_repository import ${Type}Repository
from services.common.audit import record_event
from services.common.errors import ValidationError
from services.common.pagination import Page
${depImports}


class ${Type}Service:
    """Coordinates ${entity} storage with the rest of the ${domain.name} domain."""

    def __init__(self, repository: ${Type}Repository${depParams ? `, ${depParams}` : ''}) -> None:
        self._repository = repository
${depAssigns}
        self._last_note = ""

    def create(self, tenant_id: str, amount_cents: int) -> ${Type}:
        """Create one ${entity} and tell the neighbouring services about it."""
        if amount_cents == 0:
            raise ValidationError("${entity} amount must not be zero")
        record = self._repository.create(tenant_id, amount_cents)
        self._announce(record)
        return record

    def submit(self, payload: Dict[str, Any]) -> ${Type}:
        """Accept one ${entity} straight off the wire."""
        record = parse_${entity}(payload)
        stored = self._repository.save(record)
        self._announce(stored)
        return stored

    def fetch(self, record_id: str) -> ${Type}:
        """Load one ${entity}."""
        return self._repository.get(record_id)

    def list_for_tenant(self, tenant_id: str, offset: int = 0) -> Page:
        """One page of this tenant's ${entity} rows."""
        return self._repository.list_for_tenant(tenant_id, offset)

    def settle(self, record_id: str) -> ${Type}:
        """Mark one ${entity} settled and record why."""
        record = self._repository.update_status(record_id, "settled")
        record_event("service", "settle", record.id)
        self._announce(record)
        return record

    def cancel(self, record_id: str) -> ${Type}:
        """Zero one ${entity} out without deleting it."""
        record = self._repository.get(record_id)
        record.amount_cents = 0
        record.advance("void")
        return self._repository.save(record)

    def outstanding(self, tenant_id: str) -> int:
        """What this tenant still owes on ${entity} rows."""
        return self._repository.balance_for_tenant(tenant_id)

    def overdue(self, tenant_id: str, before_ms: int) -> List[${Type}]:
        """Rows that have sat unsettled since before the given time."""
        rows = self._repository.rows_for_tenant(tenant_id)
        return [row for row in rows if not row.is_settled() and row.updated_ms < before_ms]

    def _announce(self, record: ${Type}) -> None:
${depCalls || '        self._last_note = record.summarise()'}

    def observe(self, note: str) -> None:
        """Called by a neighbouring service when something changes."""
        self._last_note = note
`;
}

function pythonHandlers(domain) {
  const imports = domain.entities
    .map((entity) => `from services.${domain.name}.service.${entity}_service import ${pascal(entity)}Service`)
    .join('\n');
  const parameters = domain.entities
    .map((entity) => `${entity}_service: ${pascal(entity)}Service`)
    .join(', ');
  const wiring = domain.entities
    .map((entity) => `    services["${entity}"] = ${entity}_service`)
    .join('\n');

  const handlers = domain.entities
    .map(
      (entity) => `

@router.get("/${domain.name}/${entity}/{record_id}")
def get_${entity}(record_id: str) -> dict:
    """Return one ${entity}."""
    return services["${entity}"].fetch(record_id).to_dict()


@router.post("/${domain.name}/${entity}")
def create_${entity}(payload: dict) -> dict:
    """Create one ${entity} for the calling tenant."""
    return services["${entity}"].submit(payload).to_dict()


@router.delete("/${domain.name}/${entity}/{record_id}")
def cancel_${entity}(record_id: str) -> dict:
    """Void one ${entity} without deleting it."""
    return services["${entity}"].cancel(record_id).to_dict()`,
    )
    .join('\n');

  return `"""HTTP surface for the ${domain.name} domain."""

from __future__ import annotations

from typing import Dict

from services.common.errors import ServiceError
from services.common.http import Router
${imports}

router = Router("/api")
services: Dict[str, object] = {}


def install(${parameters}) -> Router:
    """Wire the domain services in before the routes are served."""
${wiring}
    return router
${handlers}


def handle_error(error: ServiceError) -> dict:
    """Turn a service error into a response body."""
    return error.to_dict()
`;
}

// --------------------------------------------------------------- corpus: go

const GO_ERRORS = `// Package common holds the errors and helpers every service shares.
package common

import (
	"errors"
	"fmt"
)

// ErrInvalid is returned when a record fails validation.
var ErrInvalid = errors.New("invalid record")

// ErrNotFound is returned when a lookup by id finds nothing.
var ErrNotFound = errors.New("not found")

// Wrap adds the operation name to an error without losing the cause.
func Wrap(op string, err error) error {
	if err == nil {
		return nil
	}
	return fmt.Errorf("%s: %w", op, err)
}
`;

const GO_CLOCK = `package common

import "time"

// NowMs returns milliseconds since the epoch.
func NowMs() int64 {
	return time.Now().UnixMilli()
}

// DeadlineMs returns a timestamp the given number of seconds ahead.
func DeadlineMs(seconds int64) int64 {
	return NowMs() + seconds*1000
}
`;

const GO_PAGE = `package common

// PageSize is the number of rows every listing returns.
const PageSize = 50

// Page is one window of results plus the offset that follows it.
type Page struct {
	Offset     int
	NextOffset int
	Size       int
}

// IsLast reports whether anything follows this page.
func (p Page) IsLast() bool {
	return p.NextOffset == 0
}

// Paginate builds the page description for a result set.
func Paginate(total int, offset int) Page {
	next := 0
	if offset+PageSize < total {
		next = offset + PageSize
	}
	return Page{Offset: offset, NextOffset: next, Size: PageSize}
}
`;

const GO_AUDIT = `package common

// AuditEvent is one recorded change, ready to be shipped to the audit log.
type AuditEvent struct {
	Actor   string
	Action  string
	Subject string
	AtMs    int64
}

var events []AuditEvent

// RecordEvent appends one event to the trail and hands it back.
func RecordEvent(actor string, action string, subject string) AuditEvent {
	event := AuditEvent{Actor: actor, Action: action, Subject: subject, AtMs: NowMs()}
	events = append(events, event)
	return event
}

// EventsFor returns every recorded event about one subject, oldest first.
func EventsFor(subject string) []AuditEvent {
	out := make([]AuditEvent, 0)
	for _, event := range events {
		if event.Subject == subject {
			out = append(out, event)
		}
	}
	return out
}

// ClearEvents drops the trail, which only the tests need.
func ClearEvents() {
	events = nil
}
`;

function goModel(domain, entity) {
  const Type = pascal(entity);
  return `// Package model holds the ${domain.name} records.
package model

import (
	"fmt"
	"sort"

	"${GO_MODULE}/internal/common"
)

// ${Type}Statuses are the states one ${entity} moves through, in order.
var ${Type}Statuses = []string{"draft", "open", "settled", "void"}

// ${Type}Line is one line of one ${entity}.
type ${Type}Line struct {
	Label  string
	Amount int64
}

// IsCredit reports whether this line gives money back.
func (l ${Type}Line) IsCredit() bool {
	return l.Amount < 0
}

// ${Type} is one ${entity} as the ${domain.name} service stores it.
type ${Type} struct {
	ID        string
	TenantID  string
	Amount    int64
	Status    string
	UpdatedMs int64
	Lines     []${Type}Line
}

// Validate reports whether the record is fit to persist.
func (r *${Type}) Validate() error {
	if r.Amount < 0 {
		return common.Wrap("${entity} amount", common.ErrInvalid)
	}
	if r.TenantID == "" {
		return common.Wrap("${entity} tenant", common.ErrInvalid)
	}
	if ${entity}StatusRank(r.Status) < 0 {
		return common.Wrap("${entity} status", common.ErrInvalid)
	}
	return nil
}

// Touch stamps the record with the current time.
func (r *${Type}) Touch() {
	r.UpdatedMs = common.NowMs()
}

// AddLine appends one line and keeps the total in step with it.
func (r *${Type}) AddLine(label string, amount int64) ${Type}Line {
	line := ${Type}Line{Label: label, Amount: amount}
	r.Lines = append(r.Lines, line)
	r.Amount += amount
	r.Touch()
	return line
}

// Advance moves the record forward, never back.
func (r *${Type}) Advance(status string) error {
	next := ${entity}StatusRank(status)
	if next < 0 || next < ${entity}StatusRank(r.Status) {
		return common.Wrap("advance ${entity}", common.ErrInvalid)
	}
	r.Status = status
	r.Touch()
	return nil
}

// IsSettled reports whether the record has reached a terminal state.
func (r *${Type}) IsSettled() bool {
	return r.Status == "settled" || r.Status == "void"
}

// Summarise renders the record for logs.
func (r *${Type}) Summarise() string {
	return fmt.Sprintf("${entity} %s for %s (%s)", r.ID, r.TenantID, r.Status)
}

// New${Type} builds one ${entity} with the server side defaults filled in.
func New${Type}(tenantID string, amount int64) *${Type} {
	record := &${Type}{ID: "${entity}-" + tenantID, TenantID: tenantID, Amount: amount, Status: "draft"}
	record.Touch()
	return record
}

// Sort${Type}s orders records newest first.
func Sort${Type}s(records []*${Type}) {
	sort.Slice(records, func(i, j int) bool {
		return records[i].UpdatedMs > records[j].UpdatedMs
	})
}

// Total${Type}s sums the amounts of many records.
func Total${Type}s(records []*${Type}) int64 {
	var total int64
	for _, record := range records {
		total += record.Amount
	}
	return total
}

func ${entity}StatusRank(status string) int {
	for index, known := range ${Type}Statuses {
		if known == status {
			return index
		}
	}
	return -1
}
`;
}

function goStore(domain, entity) {
  const Type = pascal(entity);
  return `// Package store persists the ${domain.name} records.
package store

import (
	"${GO_MODULE}/internal/${domain.name}/model"
	"${GO_MODULE}/internal/common"
)

// selectByID${Type} is the query this store would run against a real database.
const selectByID${Type} = "SELECT id, tenant_id, amount, status FROM ${entity}s WHERE id = ?"

// ${Type}Store keeps ${entity} records in memory.
type ${Type}Store struct {
	rows  map[string]*model.${Type}
	actor string
}

// New${Type}Store builds an empty store.
func New${Type}Store(actor string) *${Type}Store {
	return &${Type}Store{rows: make(map[string]*model.${Type}), actor: actor}
}

// Put writes one record, replacing any earlier version.
func (s *${Type}Store) Put(record *model.${Type}) error {
	if err := record.Validate(); err != nil {
		return common.Wrap("put ${entity}", err)
	}
	record.Touch()
	s.rows[record.ID] = record
	common.RecordEvent(s.actor, "put", record.ID)
	return nil
}

// Get loads one record by id.
func (s *${Type}Store) Get(id string) (*model.${Type}, error) {
	record, ok := s.rows[id]
	if !ok {
		return nil, common.Wrap("get ${entity}", common.ErrNotFound)
	}
	return record, nil
}

// Exists reports whether the id is known, without loading the record.
func (s *${Type}Store) Exists(id string) bool {
	_, ok := s.rows[id]
	return ok
}

// Delete removes one record, reporting whether it was there.
func (s *${Type}Store) Delete(id string) error {
	if !s.Exists(id) {
		return common.Wrap("delete ${entity}", common.ErrNotFound)
	}
	delete(s.rows, id)
	common.RecordEvent(s.actor, "delete", id)
	return nil
}

// RowsFor returns every record belonging to one tenant, newest first.
func (s *${Type}Store) RowsFor(tenantID string) []*model.${Type} {
	out := make([]*model.${Type}, 0, len(s.rows))
	for _, record := range s.rows {
		if record.TenantID == tenantID {
			out = append(out, record)
		}
	}
	model.Sort${Type}s(out)
	return out
}

// List returns one page of a tenant's records.
func (s *${Type}Store) List(tenantID string, offset int) ([]*model.${Type}, common.Page) {
	rows := s.RowsFor(tenantID)
	return rows, common.Paginate(len(rows), offset)
}

// Balance is what a tenant's unsettled records come to.
func (s *${Type}Store) Balance(tenantID string) int64 {
	open := make([]*model.${Type}, 0)
	for _, record := range s.RowsFor(tenantID) {
		if !record.IsSettled() {
			open = append(open, record)
		}
	}
	return model.Total${Type}s(open)
}
`;
}

function goService(domain, entity) {
  const Type = pascal(entity);
  // gofmt aligns struct field types, and generated code that ignores that
  // reads as broken rather than as a stand-in.
  const width = Math.max(7, ...domain.deps.map((dep) => dep.domain.length));
  const depImports = domain.deps
    .map((dep) => `\t${dep.domain}service "${GO_MODULE}/internal/${dep.domain}/service"`)
    .join('\n');
  const depFields = domain.deps
    .map((dep) => `\t${pad(dep.domain, width)} *${dep.domain}service.${pascal(dep.entity)}Service`)
    .join('\n');
  const depParams = domain.deps
    .map((dep) => `, ${dep.domain} *${dep.domain}service.${pascal(dep.entity)}Service`)
    .join('');
  const depInit = domain.deps.map((dep) => `, ${dep.domain}: ${dep.domain}`).join('');
  const depCalls = domain.deps.map((dep) => `\tsvc.${dep.domain}.Observe(record.Summarise())`).join('\n');

  return `// Package service holds the ${domain.name} business rules.
package service

import (
	"${GO_MODULE}/internal/${domain.name}/model"
	"${GO_MODULE}/internal/${domain.name}/store"
	"${GO_MODULE}/internal/common"
${depImports}
)

// ${Type}Service coordinates ${entity} storage with the rest of the domain.
type ${Type}Service struct {
	${pad('repo', width)} *store.${Type}Store
${depFields}
	${pad('lastRef', width)} string
}

// New${Type}Service builds the service over its dependencies.
func New${Type}Service(repo *store.${Type}Store${depParams}) *${Type}Service {
	return &${Type}Service{repo: repo${depInit}}
}

// Create validates the request and stores one new ${entity}.
func (svc *${Type}Service) Create(tenantID string, amount int64) (*model.${Type}, error) {
	if amount == 0 {
		return nil, common.Wrap("create ${entity}", common.ErrInvalid)
	}
	record := model.New${Type}(tenantID, amount)
	if err := svc.repo.Put(record); err != nil {
		return nil, err
	}
	svc.announce(record)
	return record, nil
}

// Fetch loads one ${entity} by id.
func (svc *${Type}Service) Fetch(id string) (*model.${Type}, error) {
	return svc.repo.Get(id)
}

// List returns one page of a tenant's records.
func (svc *${Type}Service) List(tenantID string, offset int) ([]*model.${Type}, common.Page) {
	return svc.repo.List(tenantID, offset)
}

// Settle marks one ${entity} settled and records why.
func (svc *${Type}Service) Settle(id string) (*model.${Type}, error) {
	record, err := svc.repo.Get(id)
	if err != nil {
		return nil, err
	}
	if err := record.Advance("settled"); err != nil {
		return nil, common.Wrap("settle ${entity}", err)
	}
	if err := svc.repo.Put(record); err != nil {
		return nil, err
	}
	svc.announce(record)
	return record, nil
}

// Cancel zeroes one ${entity} out without deleting it.
func (svc *${Type}Service) Cancel(id string) (*model.${Type}, error) {
	record, err := svc.repo.Get(id)
	if err != nil {
		return nil, err
	}
	record.Amount = 0
	if err := record.Advance("void"); err != nil {
		return nil, common.Wrap("cancel ${entity}", err)
	}
	return record, svc.repo.Put(record)
}

// Outstanding is what a tenant still owes on ${entity} records.
func (svc *${Type}Service) Outstanding(tenantID string) int64 {
	return svc.repo.Balance(tenantID)
}

// Overdue returns records that have sat unsettled since before the given time.
func (svc *${Type}Service) Overdue(tenantID string, beforeMs int64) []*model.${Type} {
	out := make([]*model.${Type}, 0)
	for _, record := range svc.repo.RowsFor(tenantID) {
		if !record.IsSettled() && record.UpdatedMs < beforeMs {
			out = append(out, record)
		}
	}
	return out
}

func (svc *${Type}Service) announce(record *model.${Type}) {
${depCalls || '\tsvc.lastRef = record.Summarise()'}
}

// Observe is called by a neighbouring service when something changes.
func (svc *${Type}Service) Observe(ref string) {
	svc.lastRef = ref
}
`;
}

function goHandlers(domain) {
  const width = Math.max(...domain.entities.map((entity) => entity.length));
  const fields = domain.entities
    .map((entity) => `\t${pad(entity, width)} *service.${pascal(entity)}Service`)
    .join('\n');
  const parameters = domain.entities
    .map((entity) => `${entity} *service.${pascal(entity)}Service`)
    .join(', ');
  const init = domain.entities.map((entity) => `${entity}: ${entity}`).join(', ');
  const methods = domain.entities
    .map(
      (entity) => `
// Create${pascal(entity)} handles a create request.
func (h *Handler) Create${pascal(entity)}(tenantID string, amount int64) (string, error) {
	record, err := h.${entity}.Create(tenantID, amount)
	if err != nil {
		return "", common.Wrap("create ${entity}", err)
	}
	return record.ID, nil
}

// Get${pascal(entity)} handles a read request.
func (h *Handler) Get${pascal(entity)}(id string) (string, error) {
	record, err := h.${entity}.Fetch(id)
	if err != nil {
		return "", common.Wrap("get ${entity}", err)
	}
	return record.Summarise(), nil
}`,
    )
    .join('\n');

  return `// Package api wires the ${domain.name} services to the transport layer.
package api

import (
	"${GO_MODULE}/internal/${domain.name}/service"
	"${GO_MODULE}/internal/common"
)

// Handler serves the ${domain.name} routes.
type Handler struct {
${fields}
}

// NewHandler builds a handler over the domain services.
func NewHandler(${parameters}) *Handler {
	return &Handler{${init}}
}
${methods}
`;
}

// ------------------------------------------------------- corpus: typescript

const TS_ERRORS = `/** Errors shared by every module in this tree. */
export class ServiceError extends Error {
  constructor(
    message: string,
    readonly code = 'service_error',
  ) {
    super(message);
    this.name = 'ServiceError';
  }

  /** Render the error in the shape the API returns. */
  toBody(): { code: string; message: string } {
    return { code: this.code, message: this.message };
  }
}

/** A record was rejected before it reached storage. */
export class ValidationError extends ServiceError {
  constructor(message: string) {
    super(message, 'invalid');
  }
}

/** A lookup by id found nothing. */
export class NotFoundError extends ServiceError {
  constructor(message: string) {
    super(message, 'not_found');
  }
}
`;

const TS_CLOCK = `/** Time helpers, kept in one place so tests can freeze them. */
export function nowMs(): number {
  return Date.now();
}

/** A timestamp the given number of seconds into the future. */
export function deadlineMs(seconds: number): number {
  return nowMs() + seconds * 1000;
}
`;

const TS_PAGE = `export const PAGE_SIZE = 50;

/** One page of rows plus the offset that follows it. */
export interface Page<T> {
  rows: T[];
  nextOffset: number;
}

/** Slice rows into a page starting at offset. */
export function paginate<T>(rows: T[], offset = 0, size = PAGE_SIZE): Page<T> {
  const window = rows.slice(offset, offset + size);
  return { rows: window, nextOffset: offset + size < rows.length ? offset + size : 0 };
}

/** True when there is nothing after this page. */
export function isLastPage<T>(page: Page<T>): boolean {
  return page.nextOffset === 0;
}
`;

const TS_AUDIT = `import { nowMs } from './clock.js';

/** One recorded change, ready to be shipped to the audit log. */
export interface AuditEvent {
  actor: string;
  action: string;
  subject: string;
  atMs: number;
}

const events: AuditEvent[] = [];

/** Append one event to the trail and hand it back. */
export function recordEvent(actor: string, action: string, subject: string): AuditEvent {
  const event: AuditEvent = { actor, action, subject, atMs: nowMs() };
  events.push(event);
  return event;
}

/** Every recorded event about one subject, oldest first. */
export function eventsFor(subject: string): AuditEvent[] {
  return events.filter((event) => event.subject === subject);
}

/** Drop the trail, which only the tests need. */
export function clearEvents(): void {
  events.length = 0;
}
`;

const TS_ROUTER = `export type Handler = (...args: never[]) => unknown;

/** A small router, so the route modules have something to register with. */
export class Router {
  private readonly routes = new Map<string, Handler>();

  constructor(private readonly prefix = '') {}

  get(route: string, handler: Handler): void {
    this.routes.set(\`GET \${this.prefix}\${route}\`, handler);
  }

  post(route: string, handler: Handler): void {
    this.routes.set(\`POST \${this.prefix}\${route}\`, handler);
  }

  delete(route: string, handler: Handler): void {
    this.routes.set(\`DELETE \${this.prefix}\${route}\`, handler);
  }

  /** Every route this router knows about, for the startup log. */
  registered(): string[] {
    return [...this.routes.keys()].sort();
  }
}
`;

function tsModel(domain, entity) {
  const Type = pascal(entity);
  const STATUSES = `${entity.toUpperCase()}_STATUSES`;
  return `import { nowMs } from '@common/clock.js';
import { ValidationError } from '@common/errors.js';

/** The states one ${entity} moves through, in the order they are reached. */
export const ${STATUSES} = ['draft', 'open', 'settled', 'void'] as const;

export type ${Type}Status = (typeof ${STATUSES})[number];

/** One line of one ${entity}. */
export interface ${Type}Line {
  label: string;
  amountCents: number;
}

/** One ${entity} as the ${domain.name} area stores it. */
export interface ${Type} {
  id: string;
  tenantId: string;
  amountCents: number;
  status: ${Type}Status;
  updatedMs: number;
  lines: ${Type}Line[];
}

/** Build one ${entity} with the defaults the server would apply. */
export function new${Type}(tenantId: string, amountCents: number): ${Type} {
  const record: ${Type} = {
    id: \`${entity}-\${tenantId}\`,
    tenantId,
    amountCents,
    status: 'draft',
    updatedMs: nowMs(),
    lines: [],
  };
  validate${Type}(record);
  return record;
}

/** Throw if the record is not fit to persist. */
export function validate${Type}(record: ${Type}): void {
  if (record.amountCents < 0) throw new ValidationError('${entity} amount must not be negative');
  if (record.tenantId === '') throw new ValidationError('${entity} needs a tenant');
  if (!${STATUSES}.includes(record.status)) {
    throw new ValidationError(\`unknown ${entity} status \${record.status}\`);
  }
}

/** Append one line and keep the total in step with it. */
export function addLineTo${Type}(record: ${Type}, label: string, amountCents: number): ${Type} {
  return {
    ...record,
    lines: [...record.lines, { label, amountCents }],
    amountCents: record.amountCents + amountCents,
    updatedMs: nowMs(),
  };
}

/** Move the record forward, never back. */
export function advance${Type}(record: ${Type}, status: ${Type}Status): ${Type} {
  const from = ${STATUSES}.indexOf(record.status);
  const to = ${STATUSES}.indexOf(status);
  if (to < 0 || to < from) throw new ValidationError('${entity} status cannot move backwards');
  return { ...record, status, updatedMs: nowMs() };
}

/** True once the record has reached a terminal state. */
export function is${Type}Settled(record: ${Type}): boolean {
  return record.status === 'settled' || record.status === 'void';
}

export function summarise${Type}(record: ${Type}): string {
  return \`${entity} \${record.id} for \${record.tenantId} (\${record.status})\`;
}

/** Sum the amounts of many ${entity} records. */
export function total${Type}s(records: readonly ${Type}[]): number {
  return records.reduce((total, record) => total + record.amountCents, 0);
}
`;
}

function tsRepo(domain, entity) {
  const Type = pascal(entity);
  return `import { recordEvent } from '@common/audit.js';
import { NotFoundError } from '@common/errors.js';
import { paginate, type Page } from '@common/page.js';
import {
  advance${Type},
  is${Type}Settled,
  new${Type},
  total${Type}s,
  validate${Type},
  type ${Type},
  type ${Type}Status,
} from '../model/${entity}.js';

export const SELECT_BY_ID = 'SELECT id, tenant_id, amount_cents, status FROM ${entity}s WHERE id = ?';
export const SELECT_FOR_TENANT = 'SELECT id, amount_cents FROM ${entity}s WHERE tenant_id = ?';

/** Keeps ${entity} rows in memory, which is enough for the benchmark. */
export class ${Type}Repo {
  private readonly rows = new Map<string, ${Type}>();

  constructor(private readonly actor = 'system') {}

  /** Validate and store one ${entity}. */
  save(record: ${Type}): ${Type} {
    validate${Type}(record);
    this.rows.set(record.id, record);
    recordEvent(this.actor, 'save', record.id);
    return record;
  }

  /** Load one ${entity} or throw. */
  get(id: string): ${Type} {
    const found = this.rows.get(id);
    if (!found) throw new NotFoundError(\`no ${entity} with id \${id}\`);
    return found;
  }

  /** Load one ${entity}, or undefined when there is nothing to load. */
  find(id: string): ${Type} | undefined {
    return this.rows.get(id);
  }

  /** True when the id is known. */
  has(id: string): boolean {
    return this.rows.has(id);
  }

  /** Build and store one new ${entity}. */
  create(tenantId: string, amountCents: number): ${Type} {
    return this.save(new${Type}(tenantId, amountCents));
  }

  /** Move one ${entity} to a later status. */
  updateStatus(id: string, status: ${Type}Status): ${Type} {
    return this.save(advance${Type}(this.get(id), status));
  }

  /** Every ${entity} belonging to one tenant, newest first. */
  rowsForTenant(tenantId: string): ${Type}[] {
    return [...this.rows.values()]
      .filter((row) => row.tenantId === tenantId)
      .sort((a, b) => b.updatedMs - a.updatedMs);
  }

  /** One page of this tenant's ${entity} rows. */
  listForTenant(tenantId: string, offset = 0): Page<${Type}> {
    return paginate(this.rowsForTenant(tenantId), offset);
  }

  /** What this tenant's open ${entity} rows come to. */
  balanceForTenant(tenantId: string): number {
    return total${Type}s(this.rowsForTenant(tenantId).filter((row) => !is${Type}Settled(row)));
  }

  /** Remove one ${entity}, throwing if it was never there. */
  remove(id: string): void {
    this.get(id);
    this.rows.delete(id);
    recordEvent(this.actor, 'delete', id);
  }
}
`;
}

function tsService(domain, entity) {
  const Type = pascal(entity);
  const depImports = domain.deps
    .map(
      (dep) =>
        `import { ${pascal(dep.entity)}Service } from '../../${dep.domain}/service/${dep.entity}Service.js';`,
    )
    .join('\n');
  const depParams = domain.deps
    .map((dep) => `\n    private readonly ${dep.entity}: ${pascal(dep.entity)}Service,`)
    .join('');
  const depCalls = domain.deps
    .map((dep) => `    this.${dep.entity}.observe(summarise${Type}(record));`)
    .join('\n');

  return `import { recordEvent } from '@common/audit.js';
import { ValidationError } from '@common/errors.js';
import { type Page } from '@common/page.js';
import { advance${Type}, is${Type}Settled, summarise${Type}, type ${Type} } from '../model/${entity}.js';
import { ${Type}Repo } from '../repo/${entity}Repo.js';
${depImports}

/** Coordinates ${entity} storage with the rest of the ${domain.name} area. */
export class ${Type}Service {
  private lastNote = '';

  constructor(
    private readonly repo: ${Type}Repo,${depParams}
  ) {}

  /** Create one ${entity} and tell the neighbouring services about it. */
  create(tenantId: string, amountCents: number): ${Type} {
    if (amountCents === 0) throw new ValidationError('${entity} amount must not be zero');
    const record = this.repo.create(tenantId, amountCents);
    this.announce(record);
    return record;
  }

  /** Load one ${entity}. */
  fetch(id: string): ${Type} {
    return this.repo.get(id);
  }

  /** One page of this tenant's ${entity} rows. */
  listForTenant(tenantId: string, offset = 0): Page<${Type}> {
    return this.repo.listForTenant(tenantId, offset);
  }

  /** Mark one ${entity} settled and record why. */
  settle(id: string): ${Type} {
    const record = this.repo.updateStatus(id, 'settled');
    recordEvent('service', 'settle', record.id);
    this.announce(record);
    return record;
  }

  /** Zero one ${entity} out without deleting it. */
  cancel(id: string): ${Type} {
    const record = advance${Type}(this.repo.get(id), 'void');
    return this.repo.save({ ...record, amountCents: 0 });
  }

  /** What this tenant still owes on ${entity} rows. */
  outstanding(tenantId: string): number {
    return this.repo.balanceForTenant(tenantId);
  }

  /** Rows that have sat unsettled since before the given time. */
  overdue(tenantId: string, beforeMs: number): ${Type}[] {
    return this.repo
      .rowsForTenant(tenantId)
      .filter((row) => !is${Type}Settled(row) && row.updatedMs < beforeMs);
  }

  private announce(record: ${Type}): void {
${depCalls || `    this.lastNote = summarise${Type}(record);`}
  }

  /** Called by a neighbouring service when something changes. */
  observe(note: string): void {
    this.lastNote = note;
  }
}
`;
}

function tsRoutes(domain) {
  const imports = domain.entities
    .map((entity) => `import { ${pascal(entity)}Service } from './service/${entity}Service.js';`)
    .join('\n');
  const parameters = domain.entities
    .map((entity) => `\n  ${entity}: ${pascal(entity)}Service,`)
    .join('');
  const registrations = domain.entities
    .map(
      (entity) => `  router.get('/${domain.name}/${entity}/:id', (id: string) => ${entity}.fetch(id));
  router.post('/${domain.name}/${entity}', (tenantId: string, amount: number) => ${entity}.create(tenantId, amount));
  router.delete('/${domain.name}/${entity}/:id', (id: string) => ${entity}.cancel(id));`,
    )
    .join('\n');

  return `import { Router } from '@common/router.js';
${imports}

/** Register every ${domain.name} route on the shared router. */
export function register${pascal(domain.name)}Routes(
  router: Router,${parameters}
): void {
${registrations}
}
`;
}

// ------------------------------------------------------------------ helpers

function pascal(word) {
  return word.charAt(0).toUpperCase() + word.slice(1);
}

/**
 * The file holding the most symbols, which is a fair stand-in for the kind of
 * file someone is likely to be editing. Ties break on the path so that two
 * runs over the same repo pick the same file.
 */
function busiestFile(store) {
  const tally = new Map();
  for (const node of store.allNodesLite()) {
    tally.set(node.path, (tally.get(node.path) ?? 0) + 1);
  }
  const ranked = [...tally].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (ranked.length === 0) throw new Error('nothing was indexed, so there is no file to edit');
  return ranked[0][0];
}


function padLeft(text, width) {
  const value = String(text);
  return value.length >= width ? value : ' '.repeat(width - value.length) + value;
}

function ratio(value) {
  if (!Number.isFinite(value)) return '-';
  return value >= 10 ? `${Math.round(value)}x` : `${value.toFixed(1)}x`;
}

function millis(value) {
  return value === undefined ? '-' : value.toFixed(2);
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function median(values) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function unique(values) {
  return [...new Set(values)];
}

function intFlag(name, fallback) {
  const found = args.find((arg) => arg.startsWith(`${name}=`));
  if (!found) return fallback;
  const value = Number(found.slice(name.length + 1));
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function stringFlag(name) {
  const found = args.find((arg) => arg.startsWith(`${name}=`));
  return found ? found.slice(name.length + 1) : null;
}

/** Progress goes to stderr so that --json output on stdout stays parseable. */
function step(message) {
  process.stderr.write(`${message}\n`);
}

main().catch((err) => {
  console.error(err.stack ?? err.message);
  process.exit(1);
});

