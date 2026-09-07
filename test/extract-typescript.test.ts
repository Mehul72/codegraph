import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ParserPool } from '../src/extract/parser.js';
import type { Extractor } from '../src/extract/types.js';
import { javascriptExtractor, tsxExtractor, typescriptExtractor } from '../src/extract/typescript.js';
import type { EdgeType, ExtractResult, GraphNode, NodeKind } from '../src/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'typescript');

const pool = new ParserPool();
after(() => pool.dispose());

async function extractSource(relPath: string, source: string, extractor: Extractor): Promise<ExtractResult> {
  const { grammar } = extractor;
  assert.ok(grammar, `${extractor.id} declares no grammar`);
  const tree = await pool.parse(grammar, source);
  assert.ok(tree, `grammar ${grammar} failed to load`);
  return extractor.extract({ tree, path: relPath, source, repo: 'fixture' });
}

function extract(relPath: string, extractor: Extractor = typescriptExtractor): Promise<ExtractResult> {
  const source = fs.readFileSync(path.join(FIXTURES, relPath), 'utf8');
  return extractSource(relPath, source, extractor);
}

/** Node ids are repo:path:kind:qualified, and only the tail is interesting here. */
function shortId(id: string): string {
  return id.split(':').slice(2).join(':');
}

function symbolOf(result: ExtractResult, qualified: string): GraphNode {
  const found = result.nodes.filter((node) => node.qualified === qualified);
  assert.equal(found.length, 1, `expected one symbol named ${qualified}, found ${found.length}`);
  return found[0] as GraphNode;
}

function qualifiedOfKind(result: ExtractResult, kind: NodeKind): string[] {
  return result.nodes.filter((node) => node.kind === kind).map((node) => node.qualified ?? '');
}

/** Name-target edges as `from -> qualifier.name`, which is what the assertions read like. */
function refs(result: ExtractResult, type: EdgeType): string[] {
  const out: string[] = [];
  for (const edge of result.edges) {
    if (edge.type !== type || edge.to.kind !== 'name') continue;
    const target = edge.to.qualifier ? `${edge.to.qualifier}.${edge.to.name}` : edge.to.name;
    out.push(`${shortId(edge.from)} -> ${target}`);
  }
  return out;
}

/** Id-target edges, which are the ones the extractor could resolve on its own. */
function links(result: ExtractResult, type: EdgeType): string[] {
  const out: string[] = [];
  for (const edge of result.edges) {
    if (edge.type !== type || edge.to.kind !== 'id') continue;
    out.push(`${shortId(edge.from)} -> ${shortId(edge.to.id)}`);
  }
  return out;
}

function imports(result: ExtractResult): string[] {
  const out: string[] = [];
  for (const edge of result.edges) {
    if (edge.type !== 'imports' || edge.to.kind !== 'module') continue;
    out.push(`${edge.to.module} symbol=${edge.to.symbol ?? '-'} alias=${edge.to.alias ?? '-'}`);
  }
  return out;
}

test('the three extractors share one implementation but keep their own identity', () => {
  assert.equal(typescriptExtractor.id, 'typescript');
  assert.deepEqual(typescriptExtractor.extensions, ['.ts', '.mts', '.cts']);
  assert.equal(typescriptExtractor.grammar, 'tree-sitter-typescript.wasm');

  assert.equal(tsxExtractor.id, 'tsx');
  assert.deepEqual(tsxExtractor.extensions, ['.tsx']);
  assert.equal(tsxExtractor.grammar, 'tree-sitter-tsx.wasm');

  assert.equal(javascriptExtractor.id, 'javascript');
  assert.deepEqual(javascriptExtractor.extensions, ['.js', '.mjs', '.cjs', '.jsx']);
  assert.equal(javascriptExtractor.grammar, 'tree-sitter-javascript.wasm');
});

test('every file gets a module node named after its path', async () => {
  const widget = await extract('src/models/widget.ts');
  const module = symbolOf(widget, 'src/models/widget');
  assert.equal(module.kind, 'module');
  assert.equal(module.name, 'widget');
  assert.equal(module.lang, 'typescript');
  assert.equal(module.lineStart, 1);
  assert.equal(module.exported, true);
  assert.equal(module.doc, 'Widget shapes shared by the store and the HTTP layer.');

  // An index file keeps the name `index`; the directory alias is a resolver concern.
  const barrel = await extract('src/models/index.ts');
  const barrelModule = symbolOf(barrel, 'src/models/index');
  assert.equal(barrelModule.name, 'index');
  assert.equal(barrelModule.doc, 'Barrel for the model types.');
});

test('types, enums and constants become symbols with module-relative names', async () => {
  const result = await extract('src/models/widget.ts');

  assert.deepEqual(qualifiedOfKind(result, 'interface'), ['Entity', 'Widget', 'WidgetId']);
  assert.deepEqual(qualifiedOfKind(result, 'class'), ['WidgetStatus']);
  assert.deepEqual(qualifiedOfKind(result, 'constant'), ['WIDGET_TABLE']);
  assert.deepEqual(qualifiedOfKind(result, 'function'), ['isVisible', 'slugify', 'firstMatch']);

  // A type alias has no kind of its own, so it is indexed as an interface.
  const alias = symbolOf(result, 'WidgetId');
  assert.equal(alias.signature, 'type WidgetId = string;');
  assert.equal(alias.doc, 'Primary key of a widget row.');

  const constant = symbolOf(result, 'WIDGET_TABLE');
  assert.equal(constant.signature, "const WIDGET_TABLE = 'widgets'");
  assert.equal(constant.exported, true);

  assert.equal(symbolOf(result, 'WidgetStatus').signature, 'enum WidgetStatus');

  // `interface Widget extends Entity` and the property types it depends on.
  assert.ok(refs(result, 'inherits').includes('interface:Widget -> Entity'));
  assert.ok(refs(result, 'references').includes('interface:Widget -> WidgetStatus'));

  assert.ok(links(result, 'defines').includes('module:src/models/widget -> function:isVisible'));
});

test('a type variable is a declaration, not a reference', async () => {
  const result = await extract('src/models/widget.ts');
  const fromGeneric = refs(result, 'references').filter((ref) => ref.startsWith('function:firstMatch'));

  // `<T extends Entity>` binds T locally, so only the constraint is a real edge.
  assert.deepEqual(fromGeneric, ['function:firstMatch -> Entity']);
});

test('exported is true for export statements and for a later export clause', async () => {
  const result = await extract('src/models/widget.ts');

  assert.equal(symbolOf(result, 'isVisible').exported, true);
  // `function slugify` is declared bare and made public by `export { slugify }`.
  assert.equal(symbolOf(result, 'slugify').exported, true);

  const routes = await extract('src/routes/widgets.ts');
  assert.equal(symbolOf(routes, 'showWidget').exported, true);
  assert.equal(symbolOf(routes, 'buildWidget').exported, false);
  assert.equal(symbolOf(routes, 'logTraffic').exported, false);
});

test('classes carry their methods, heritage and visibility', async () => {
  const result = await extract('src/store/widget-repo.ts');

  const klass = symbolOf(result, 'WidgetRepo');
  assert.equal(klass.kind, 'class');
  assert.equal(klass.exported, true);
  assert.equal(klass.signature, 'class WidgetRepo extends BaseRepo implements Findable');
  assert.equal(klass.doc, 'Reads widget rows.');

  assert.deepEqual(qualifiedOfKind(result, 'method'), [
    'WidgetRepo.constructor',
    'WidgetRepo.tableName',
    'WidgetRepo.find',
    'WidgetRepo.onMiss',
    'WidgetRepo.remember',
  ]);

  const find = symbolOf(result, 'WidgetRepo.find');
  assert.equal(find.kind, 'method');
  assert.equal(find.signature, 'async find(id: WidgetId): Promise<Widget | null>');
  assert.equal(find.doc, 'Fetch one widget row, or null when it is gone or hidden.');

  // A field holding an arrow function is a method, with the body left out.
  assert.equal(symbolOf(result, 'WidgetRepo.onMiss').signature, 'onMiss = (id: WidgetId): void => ...');

  assert.equal(symbolOf(result, 'WidgetRepo.remember').exported, false);

  assert.deepEqual(refs(result, 'inherits'), ['class:WidgetRepo -> BaseRepo']);
  assert.deepEqual(refs(result, 'implements'), ['class:WidgetRepo -> Findable']);

  const defines = links(result, 'defines');
  assert.ok(defines.includes('module:src/store/widget-repo -> class:WidgetRepo'));
  assert.ok(defines.includes('class:WidgetRepo -> method:WidgetRepo.find'));
});

test('abstract classes and interface members come through the same path', async () => {
  const result = await extract('src/store/base.ts');

  const base = symbolOf(result, 'BaseRepo');
  assert.equal(base.kind, 'class');
  assert.equal(base.signature, 'abstract class BaseRepo');
  // A JSDoc block is flattened into one line by the shared doc helper.
  assert.equal(base.doc, 'Shared plumbing for the row stores. Subclasses only have to name their table.');

  assert.equal(symbolOf(result, 'BaseRepo.tableName').signature, 'abstract tableName(): string');
  assert.equal(symbolOf(result, 'BaseRepo.count').exported, false, 'private members are not public');
  assert.equal(symbolOf(result, 'BaseRepo.touch').exported, true, 'protected members are part of the surface');

  // Interface methods, and a property whose type is a function.
  assert.equal(symbolOf(result, 'Pool.query').kind, 'method');
  assert.equal(symbolOf(result, 'Findable.onMiss').kind, 'method');
  assert.ok(links(result, 'defines').includes('interface:Findable -> method:Findable.find'));
  assert.deepEqual(refs(result, 'inherits'), ['interface:Findable -> Entity']);
});

test('imports keep the module string exactly as written', async () => {
  const repo = await extract('src/store/widget-repo.ts');
  assert.deepEqual(imports(repo), [
    './base.js symbol=BaseRepo alias=BaseRepo',
    './base.js symbol=Findable alias=Findable',
    './base.js symbol=Pool alias=Pool',
    '@app/models/widget.js symbol=WIDGET_TABLE alias=WIDGET_TABLE',
    '@app/models/widget.js symbol=isVisible alias=isVisible',
    '@app/models/widget.js symbol=Widget alias=Widget',
    '@app/models/widget.js symbol=WidgetId alias=WidgetId',
  ]);

  const routes = await extract('src/routes/widgets.ts');
  const routeImports = imports(routes);
  assert.ok(routeImports.includes('express symbol=default alias=express'), 'default import');
  assert.ok(routeImports.includes('../store/widget-repo.js symbol=openWidgetRepo alias=openWidgetRepo'));
  assert.ok(routeImports.includes('../telemetry.js symbol=- alias=-'), 'side effect only import');
  assert.ok(routeImports.includes('../ui/WidgetCard.js symbol=- alias=-'), 'dynamic import');

  const telemetry = await extract('src/telemetry.ts');
  assert.ok(imports(telemetry).includes('node:os symbol=- alias=os'), 'namespace import binds an alias');

  // Re-exports are real dependencies, so they are recorded as imports.
  const barrel = await extract('src/models/index.ts');
  assert.deepEqual(imports(barrel), [
    './widget.js symbol=- alias=-',
    './widget.js symbol=WIDGET_TABLE alias=TABLE',
  ]);
});

test('calls carry the receiver as a qualifier and new expressions count as calls', async () => {
  const repo = await extract('src/store/widget-repo.ts');
  const calls = refs(repo, 'calls');
  assert.ok(calls.includes('method:WidgetRepo.find -> this.pool.query'));
  assert.ok(calls.includes('method:WidgetRepo.find -> isVisible'), 'a bare call has no qualifier');
  assert.ok(calls.includes('function:openWidgetRepo -> WidgetRepo'), 'new WidgetRepo() is a call');

  const routes = await extract('src/routes/widgets.ts');
  assert.ok(refs(routes, 'calls').includes('module:src/routes/widgets -> express.Router'));
});

test('embedded SQL produces one queries ref per table', async () => {
  const repo = await extract('src/store/widget-repo.ts');
  assert.deepEqual(refs(repo, 'queries'), [
    'method:WidgetRepo.find -> widgets',
    'method:WidgetRepo.find -> owners',
  ]);

  // The same treatment for a plain string literal rather than a template.
  const routes = await extract('src/routes/widgets.ts');
  assert.deepEqual(refs(routes, 'queries'), ['function:listWidgetIds -> widgets']);
});

test('express route registration produces endpoint nodes', async () => {
  const result = await extract('src/routes/widgets.ts');

  assert.deepEqual(qualifiedOfKind(result, 'endpoint'), ['GET /widgets/:id', 'POST /widgets', 'ANY /widgets']);

  const endpoint = symbolOf(result, 'GET /widgets/:id');
  assert.equal(endpoint.kind, 'endpoint');
  assert.equal(endpoint.name, 'GET /widgets/:id');
  assert.equal(endpoint.signature, 'GET /widgets/:id');

  assert.ok(links(result, 'defines').includes('module:src/routes/widgets -> endpoint:GET /widgets/:id'));
  assert.ok(links(result, 'references').includes('endpoint:POST /widgets -> function:registerWidgetRoutes'));
});

test('only module scope functions and constants become variable symbols', async () => {
  const routes = await extract('src/routes/widgets.ts');

  assert.equal(symbolOf(routes, 'DEFAULT_PAGE_SIZE').kind, 'constant');
  const arrow = symbolOf(routes, 'listWidgetIds');
  assert.equal(arrow.kind, 'function');
  assert.equal(arrow.signature, 'const listWidgetIds = async (): Promise<string[]> => ...');

  const named = routes.nodes.map((node) => node.name);
  assert.ok(!named.includes('router'), 'a plain module scope binding is not a symbol');
  assert.ok(!named.includes('repo'));
  assert.ok(!named.includes('widget'), 'function locals are never symbols');
  assert.ok(!named.includes('ui'));

  // An annotated but unindexed binding still contributes its type reference.
  const poolModule = await extract('src/store/pool.ts');
  assert.deepEqual(
    poolModule.nodes.map((node) => node.kind),
    ['module'],
  );
  assert.deepEqual(refs(poolModule, 'references'), ['module:src/store/pool -> Pool']);
});

test('a tsx file yields its component, props and hook calls', async () => {
  const result = await extract('src/ui/WidgetCard.tsx', tsxExtractor);

  const component = symbolOf(result, 'WidgetCard');
  assert.equal(component.kind, 'function');
  assert.equal(component.lang, 'tsx');
  // `export default function WidgetCard` keeps its real name.
  assert.equal(component.name, 'WidgetCard');
  assert.equal(component.exported, true);
  assert.equal(component.doc, 'One widget rendered as a card.');

  assert.equal(symbolOf(result, 'WidgetCardProps').kind, 'interface');
  assert.equal(symbolOf(result, 'StatusBadge').signature, 'const StatusBadge = ({ status }: { status: string }) => ...');

  const calls = refs(result, 'calls');
  assert.ok(calls.includes('function:WidgetCard -> useState'));
  assert.ok(calls.includes('function:WidgetCard -> isVisible'));
  assert.ok(refs(result, 'references').includes('function:WidgetCard -> WidgetCardProps'));
});

test('a plain javascript file works without any type syntax', async () => {
  const result = await extract('legacy/metrics.js', javascriptExtractor);

  assert.deepEqual(qualifiedOfKind(result, 'constant'), ['MAX_SAMPLES']);
  assert.deepEqual(qualifiedOfKind(result, 'function'), ['loadAccount']);
  assert.deepEqual(qualifiedOfKind(result, 'class'), ['SampleWindow']);
  assert.deepEqual(qualifiedOfKind(result, 'method'), ['SampleWindow.push', 'SampleWindow.summary']);

  const loadAccount = symbolOf(result, 'loadAccount');
  assert.equal(loadAccount.lang, 'javascript');
  assert.equal(loadAccount.signature, 'async function loadAccount(db, id)');
  assert.equal(loadAccount.doc, 'Look up the account behind a widget owner.');
  // The JavaScript grammar has no export statements here, so module.exports
  // is what makes these names public.
  assert.equal(loadAccount.exported, true);

  // The JavaScript grammar has no extends_clause node, only a bare heritage.
  assert.deepEqual(refs(result, 'inherits'), ['class:SampleWindow -> Array']);

  assert.deepEqual(imports(result), ['express symbol=- alias=-', './format.js symbol=- alias=-']);
  assert.deepEqual(refs(result, 'queries'), ['function:loadAccount -> accounts']);
  assert.deepEqual(qualifiedOfKind(result, 'endpoint'), ['GET /metrics']);
});

test('anonymous default exports, optional chaining and generators', async () => {
  const source = [
    'export default function () {',
    '  return handler?.run();',
    '}',
    'export function* pages() {',
    '  yield 1;',
    '}',
  ].join('\n');
  const result = await extractSource('src/anon.ts', source, typescriptExtractor);

  const fallback = symbolOf(result, 'default');
  assert.equal(fallback.kind, 'function');
  assert.equal(fallback.exported, true);
  // `a?.b()` is recorded the same way as `a.b()`.
  assert.deepEqual(refs(result, 'calls'), ['function:default -> handler.run']);

  const generator = symbolOf(result, 'pages');
  assert.equal(generator.kind, 'function');
  assert.equal(generator.exported, true);
});

test('a truncated file still yields what parsed', async () => {
  const source = 'export function good() {\n  return 1;\n}\n\nexport class Bad extends {\n';
  const result = await extractSource('src/broken.ts', source, typescriptExtractor);

  assert.equal(symbolOf(result, 'good').kind, 'function');
  assert.ok(result.nodes.length >= 2, 'the module node and the healthy function survive');
});

test('modulePath and moduleAliases describe how a file can be imported', () => {
  assert.equal(typescriptExtractor.modulePath?.('src/models/widget.ts', ''), 'src/models/widget');
  assert.equal(tsxExtractor.modulePath?.('src/ui/WidgetCard.tsx', ''), 'src/ui/WidgetCard');
  assert.equal(javascriptExtractor.modulePath?.('legacy/metrics.js', ''), 'legacy/metrics');
  assert.equal(typescriptExtractor.modulePath?.('src/models/index.ts', ''), 'src/models/index');

  // The extension as written, plus the .js name NodeNext code imports.
  assert.deepEqual(typescriptExtractor.moduleAliases?.('src/store/base.ts', ''), [
    'src/store/base.ts',
    'src/store/base.js',
  ]);
  assert.deepEqual(tsxExtractor.moduleAliases?.('src/ui/WidgetCard.tsx', ''), [
    'src/ui/WidgetCard.tsx',
    'src/ui/WidgetCard.js',
  ]);

  // A directory import resolves to its index file.
  assert.deepEqual(typescriptExtractor.moduleAliases?.('src/models/index.ts', ''), [
    'src/models/index.ts',
    'src/models/index.js',
    'src/models',
  ]);

  // A .js file is already its own import name, so there is nothing to add.
  assert.deepEqual(javascriptExtractor.moduleAliases?.('legacy/metrics.js', ''), ['legacy/metrics.js']);
});
