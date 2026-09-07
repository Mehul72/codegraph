import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { goExtractor } from '../src/extract/go.js';
import { ParserPool } from '../src/extract/parser.js';
import type { EdgeType, ExtractResult, GraphNode, NodeKind } from '../src/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'go');

const pool = new ParserPool();
after(() => pool.dispose());

async function extractSource(relPath: string, source: string): Promise<ExtractResult> {
  const tree = await pool.parse('tree-sitter-go.wasm', source);
  assert.ok(tree, 'grammars/tree-sitter-go.wasm must be present for this test');
  return goExtractor.extract({ tree, path: relPath, source, repo: 'fixture' });
}

function read(relPath: string): string {
  return fs.readFileSync(path.join(FIXTURES, relPath), 'utf8');
}

function extract(relPath: string): Promise<ExtractResult> {
  return extractSource(relPath, read(relPath));
}

function symbol(result: ExtractResult, kind: NodeKind, qualified: string): GraphNode {
  const found = result.nodes.filter((n) => n.kind === kind && n.qualified === qualified);
  assert.equal(found.length, 1, `expected exactly one ${kind} named ${qualified}`);
  return found[0] as GraphNode;
}

interface NameRef {
  from: string;
  name: string;
  qualifier: string | null;
  line: number;
}

function nameRefs(result: ExtractResult, type: EdgeType): NameRef[] {
  const refs: NameRef[] = [];
  for (const edge of result.edges) {
    if (edge.type !== type || edge.to.kind !== 'name') continue;
    refs.push({ from: edge.from, name: edge.to.name, qualifier: edge.to.qualifier ?? null, line: edge.line });
  }
  return refs;
}

function imports(result: ExtractResult): Array<{ module: string; alias: string | null; line: number }> {
  const found: Array<{ module: string; alias: string | null; line: number }> = [];
  for (const edge of result.edges) {
    if (edge.type !== 'imports' || edge.to.kind !== 'module') continue;
    found.push({ module: edge.to.module, alias: edge.to.alias ?? null, line: edge.line });
  }
  return found;
}

function definesEdge(result: ExtractResult, from: GraphNode, to: GraphNode): boolean {
  return result.edges.some(
    (e) => e.type === 'defines' && e.from === from.id && e.to.kind === 'id' && e.to.id === to.id,
  );
}

function hasRef(refs: NameRef[], from: GraphNode, name: string, qualifier: string | null = null): boolean {
  return refs.some((r) => r.from === from.id && r.name === name && r.qualifier === qualifier);
}

test('the module node names the package and is keyed by the import path', async () => {
  const model = await extract('internal/model/model.go');
  const moduleNode = symbol(model, 'module', 'internal/model');
  assert.equal(moduleNode.name, 'model');
  assert.equal(moduleNode.lineStart, 1);
  assert.equal(moduleNode.doc, 'Package model holds the domain types shared by every other package.');

  const main = await extract('main.go');
  const rootModule = symbol(main, 'module', '.');
  assert.equal(rootModule.name, 'main');
  assert.equal(rootModule.doc, 'Command app serves the user API.');
});

test('model.go yields exactly the symbols we expect, in source order', async () => {
  const model = await extract('internal/model/model.go');
  assert.deepEqual(
    model.nodes.map((n) => `${n.kind}:${n.qualified}`),
    [
      'module:internal/model',
      'struct:UserID',
      'struct:Audit',
      'struct:User',
      'method:User.Label',
      'interface:Reader',
      'method:Reader.Find',
      'interface:ReadWriter',
      'method:ReadWriter.Save',
    ],
  );
});

test('type declarations keep a readable one-line signature', async () => {
  const model = await extract('internal/model/model.go');

  const user = symbol(model, 'struct', 'User');
  assert.equal(user.signature, 'type User struct');
  assert.equal(user.doc, 'User is a person with an account.');
  assert.equal(user.lineStart, 14);
  assert.equal(user.lineEnd, 18);

  // A named non-struct type has nowhere better to go than `struct`.
  assert.equal(symbol(model, 'struct', 'UserID').signature, 'type UserID string');
  assert.equal(symbol(model, 'interface', 'Reader').signature, 'type Reader interface');
});

test('methods are qualified by their receiver and defined by both the file and the type', async () => {
  const model = await extract('internal/model/model.go');
  const moduleNode = symbol(model, 'module', 'internal/model');
  const user = symbol(model, 'struct', 'User');
  const label = symbol(model, 'method', 'User.Label');

  assert.equal(label.name, 'Label');
  assert.equal(label.exported, true);
  assert.equal(label.signature, 'func (u *User) Label() string');
  assert.equal(label.lineStart, 21);
  assert.ok(definesEdge(model, moduleNode, label), 'methods are top level, so the file defines them');
  assert.ok(definesEdge(model, user, label), 'the receiver declared here should define the method too');
});

test('interface methods hang off the interface', async () => {
  const model = await extract('internal/model/model.go');
  const reader = symbol(model, 'interface', 'Reader');
  const find = symbol(model, 'method', 'Reader.Find');

  assert.equal(find.name, 'Find');
  assert.equal(find.signature, 'Find(id UserID) (*User, error)');
  assert.equal(find.lineStart, 30);
  assert.ok(definesEdge(model, reader, find));

  const references = nameRefs(model, 'references');
  assert.ok(hasRef(references, find, 'UserID'), 'parameter types are references');
  assert.ok(hasRef(references, find, 'User'), 'result types are references');
});

test('embedding becomes inherits, for structs and for interfaces', async () => {
  const model = await extract('internal/model/model.go');
  const inherits = nameRefs(model, 'inherits');

  assert.deepEqual(inherits, [
    { from: symbol(model, 'struct', 'User').id, name: 'Audit', qualifier: null, line: 15 },
    { from: symbol(model, 'interface', 'ReadWriter').id, name: 'Reader', qualifier: null, line: 35 },
  ]);
});

test('struct fields produce references but never nodes of their own', async () => {
  const model = await extract('internal/model/model.go');
  assert.equal(
    model.nodes.some((n) => n.name === 'Name' || n.name === 'ID'),
    false,
    'fields are not symbols',
  );

  const references = nameRefs(model, 'references');
  assert.ok(hasRef(references, symbol(model, 'struct', 'User'), 'UserID'));
  assert.ok(hasRef(references, symbol(model, 'struct', 'Audit'), 'UserID'));
  assert.equal(
    references.some((r) => r.name === 'string' || r.name === 'int64'),
    false,
    'predeclared types are not worth an edge',
  );
});

test('exported follows Go, not an underscore convention', async () => {
  const store = await extract('internal/store/store.go');
  assert.equal(symbol(store, 'function', 'New').exported, true);
  assert.equal(symbol(store, 'function', 'clamp').exported, false);

  const main = await extract('main.go');
  assert.equal(symbol(main, 'function', 'main').exported, false);
  assert.equal(symbol(main, 'function', 'run').exported, false);
});

test('file scope constants and vars are indexed, unexported ones are not', async () => {
  const store = await extract('internal/store/store.go');

  const max = symbol(store, 'constant', 'MaxPageSize');
  assert.equal(max.signature, 'const MaxPageSize = 100');
  assert.equal(max.lineStart, 13);
  assert.equal(max.exported, true);

  const err = symbol(store, 'constant', 'ErrNotFound');
  assert.equal(err.signature, 'var ErrNotFound = errors.New("user not found")');
  assert.equal(err.doc, 'ErrNotFound means the id was well formed but matched no row.');

  assert.equal(
    store.nodes.some((n) => n.name === 'minPageSize'),
    false,
    'an unexported const is an implementation detail',
  );
});

test('function local declarations never become symbols', async () => {
  const result = await extractSource(
    'internal/store/reset.go',
    ['package store', '', 'func Reset() {', '\tvar Retries = 3', '\tconst MAX_WAIT = 5', '\t_ = Retries + MAX_WAIT', '}', ''].join('\n'),
  );

  assert.deepEqual(
    result.nodes.map((n) => n.kind),
    ['module', 'function'],
  );
});

test('imports keep the path, and the alias a caller would write', async () => {
  const main = await extract('main.go');
  assert.deepEqual(imports(main), [
    { module: 'log', alias: 'log', line: 5 },
    { module: 'os', alias: 'os', line: 6 },
    { module: 'github.com/acme/app/internal/store', alias: 'userstore', line: 8 },
  ]);

  const postgres = await extract('internal/store/postgres.go');
  assert.deepEqual(imports(postgres), [
    { module: 'database/sql', alias: 'sql', line: 4 },
    { module: 'github.com/lib/pq', alias: '_', line: 6 },
    { module: 'github.com/acme/app/internal/model', alias: 'model', line: 8 },
  ]);

  const moduleNode = symbol(main, 'module', '.');
  assert.ok(
    main.edges.every((e) => e.type !== 'imports' || e.from === moduleNode.id),
    'imports belong to the file, not to whatever symbol follows them',
  );
});

test('calls carry the package or the receiver as a qualifier', async () => {
  const main = await extract('main.go');
  const mainFn = symbol(main, 'function', 'main');
  const calls = nameRefs(main, 'calls');

  // The cross-file, cross-package call the resolver has to turn into an edge.
  assert.ok(hasRef(calls, mainFn, 'Open', 'userstore'));
  assert.ok(hasRef(calls, mainFn, 'New', 'userstore'));
  assert.ok(hasRef(calls, mainFn, 'run'), 'a plain function call has no qualifier');

  // Same package, other file.
  const store = await extract('internal/store/store.go');
  assert.ok(hasRef(nameRefs(store, 'calls'), symbol(store, 'method', 'Store.Get'), 'queryUser', 's.db'));

  // A conversion to a predeclared type is not a call.
  assert.equal(
    nameRefs(await extract('internal/model/model.go'), 'calls').some((r) => r.name === 'string'),
    false,
  );
});

test('SQL strings become queries refs owned by the enclosing symbol', async () => {
  const postgres = await extract('internal/store/postgres.go');
  const queries = nameRefs(postgres, 'queries');

  assert.deepEqual(queries, [
    { from: symbol(postgres, 'constant', 'CountActiveQuery').id, name: 'users', qualifier: null, line: 12 },
    { from: symbol(postgres, 'constant', 'CountActiveQuery').id, name: 'sessions', qualifier: null, line: 12 },
    { from: symbol(postgres, 'method', 'DB.queryUser').id, name: 'users', qualifier: null, line: 34 },
  ]);
});

test('modulePath is the directory, because Go imports name directories', () => {
  assert.equal(goExtractor.modulePath?.('internal/store/store.go', read('internal/store/store.go')), 'internal/store');
  assert.equal(goExtractor.modulePath?.('main.go', read('main.go')), '.');
});

test('moduleAliases register the package name and every directory suffix', () => {
  assert.deepEqual(goExtractor.moduleAliases?.('internal/store/store.go', read('internal/store/store.go')), [
    'store',
    'internal/store',
  ]);
  assert.deepEqual(goExtractor.moduleAliases?.('main.go', read('main.go')), ['main']);

  // The suffixes are what let an import path carrying a go.mod prefix match.
  assert.deepEqual(goExtractor.moduleAliases?.('internal/store/pg/conn.go', 'package pg\n'), [
    'pg',
    'internal/store/pg',
    'store/pg',
  ]);
});

test('a file that does not parse still yields the declarations that do', async () => {
  const result = await extractSource(
    'internal/store/broken.go',
    ['package store', '', 'func Good() error { return nil }', '', 'func Bad( {', ''].join('\n'),
  );

  assert.equal(symbol(result, 'module', 'internal/store').name, 'store');
  assert.equal(symbol(result, 'function', 'Good').lineStart, 3);
});
