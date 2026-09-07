import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { sqlExtractor } from '../src/extract/sql.js';
import type { EdgeType, ExtractResult, GraphNode, NodeKind } from '../src/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'sql');

function read(name: string): string {
  return fs.readFileSync(path.join(FIXTURES, name), 'utf8');
}

function extract(name: string): ExtractResult {
  // SQL has no grammar, so the pipeline hands this extractor no tree at all.
  return sqlExtractor.extract({ tree: null, path: `db/${name}`, source: read(name), repo: 'fixture' });
}

function symbol(result: ExtractResult, kind: NodeKind, name: string): GraphNode {
  const found = result.nodes.filter((node) => node.kind === kind && node.name === name);
  assert.equal(found.length, 1, `expected one ${kind} named ${name}, found ${found.length}`);
  const [only] = found;
  assert.ok(only);
  return only;
}

interface NameEdge {
  name: string;
  line: number;
}

function nameEdges(result: ExtractResult, type: EdgeType, from: GraphNode): NameEdge[] {
  return result.edges.flatMap((edge) =>
    edge.type === type && edge.from === from.id && edge.to.kind === 'name'
      ? [{ name: edge.to.name, line: edge.line }]
      : [],
  );
}

function names(result: ExtractResult, type: EdgeType, from: GraphNode): string[] {
  return nameEdges(result, type, from).map((edge) => edge.name);
}

function defines(result: ExtractResult, from: GraphNode): string[] {
  return result.edges.flatMap((edge) =>
    edge.type === 'defines' && edge.from === from.id && edge.to.kind === 'id' ? [edge.to.id] : [],
  );
}

/** Line a snippet sits on, worked out from the fixture rather than hardcoded. */
function lineOf(source: string, needle: string): number {
  const at = source.indexOf(needle);
  assert.ok(at >= 0, `fixture should contain ${JSON.stringify(needle)}`);
  return source.slice(0, at).split('\n').length;
}

/** Every name any edge points at, for the "must not appear" assertions. */
function allTargets(result: ExtractResult): string[] {
  return result.edges.flatMap((edge) => (edge.to.kind === 'name' ? [edge.to.name] : []));
}

const schemaSource = read('schema.sql');
const reportingSource = read('reporting.sql');
const schema = extract('schema.sql');
const reporting = extract('reporting.sql');

test('the extractor claims .sql and .ddl and asks for no grammar', () => {
  assert.equal(sqlExtractor.id, 'sql');
  assert.deepEqual(sqlExtractor.extensions, ['.sql', '.ddl']);
  assert.equal(sqlExtractor.grammar, null);
});

test('SQL has no import system, so there is nothing to resolve module paths against', () => {
  assert.equal(sqlExtractor.modulePath, undefined);
  assert.equal(sqlExtractor.moduleAliases, undefined);
});

test('the module node is the file', () => {
  const module = symbol(schema, 'module', 'schema');
  assert.equal(module.qualified, 'db/schema');
  assert.equal(module.lang, 'sql');
  assert.equal(module.lineStart, 1);
});

test('CREATE TABLE becomes a lower-cased table node the module defines', () => {
  const module = symbol(schema, 'module', 'schema');
  assert.deepEqual(
    schema.nodes.filter((node) => node.kind === 'table').map((node) => node.name),
    ['customers', 'products', 'orders', 'order_lines'],
  );

  const orders = symbol(schema, 'table', 'orders');
  assert.equal(orders.qualified, 'orders');
  assert.equal(orders.signature, 'CREATE TABLE orders');
  assert.equal(orders.doc, 'Orders placed by a customer.');
  assert.ok(defines(schema, module).includes(orders.id));

  // A schema qualifier is dropped, because that is what embedded SQL matches.
  assert.equal(symbol(schema, 'table', 'order_lines').name, 'order_lines');
});

test('columns get no nodes of their own', () => {
  assert.deepEqual(
    [...new Set(schema.nodes.map((node) => node.kind))],
    ['module', 'table'],
  );
  assert.deepEqual(schema.nodes.filter((node) => node.name === 'customer_id'), []);
});

test('an inline REFERENCES and a table level FOREIGN KEY both reference the table', () => {
  assert.deepEqual(nameEdges(schema, 'references', symbol(schema, 'table', 'orders')), [
    { name: 'customers', line: lineOf(schemaSource, 'REFERENCES customers (id)') },
  ]);
  assert.deepEqual(nameEdges(schema, 'references', symbol(schema, 'table', 'order_lines')), [
    { name: 'orders', line: lineOf(schemaSource, 'FOREIGN KEY (order_id) REFERENCES orders (id)') },
    // From the ALTER TABLE further down the same file.
    { name: 'products', line: lineOf(schemaSource, 'FOREIGN KEY (sku) REFERENCES products (sku)') },
  ]);
});

test('ALTER TABLE falls back to the module node for a table declared elsewhere', () => {
  const module = symbol(reporting, 'module', 'reporting');
  assert.deepEqual(nameEdges(reporting, 'references', module), [
    { name: 'report_runs', line: lineOf(reportingSource, 'FOREIGN KEY (last_report_id) REFERENCES report_runs (id)') },
    // CREATE INDEX is always recorded from the module node.
    { name: 'report_runs', line: lineOf(reportingSource, 'CREATE INDEX idx_report_runs_started') },
  ]);
  assert.deepEqual(schema.nodes.filter((node) => node.name === 'orders' && node.path !== 'db/schema.sql'), []);
});

test('CREATE INDEX references its table', () => {
  assert.deepEqual(nameEdges(schema, 'references', symbol(schema, 'module', 'schema')), [
    { name: 'orders', line: lineOf(schemaSource, 'CREATE INDEX idx_orders_customer') },
  ]);
});

test('a view is a table node that queries whatever it selects from', () => {
  const view = symbol(reporting, 'table', 'open_orders');
  assert.equal(view.signature, 'CREATE VIEW open_orders');
  assert.equal(view.doc, 'Orders a support agent can still act on.');
  assert.equal(view.lineStart, lineOf(reportingSource, 'CREATE OR REPLACE VIEW open_orders'));
  assert.deepEqual(names(reporting, 'queries', view), ['orders', 'customers']);
});

test('CREATE FUNCTION becomes a function node', () => {
  const routine = symbol(reporting, 'function', 'order_total');
  assert.equal(routine.signature, 'CREATE FUNCTION order_total');
  assert.equal(routine.lineStart, lineOf(reportingSource, 'CREATE OR REPLACE FUNCTION order_total'));
  assert.ok(defines(reporting, symbol(reporting, 'module', 'reporting')).includes(routine.id));
});

test('a cross-file foreign key is a name ref, since the table is in another file', () => {
  assert.deepEqual(nameEdges(reporting, 'references', symbol(reporting, 'table', 'report_runs')), [
    { name: 'orders', line: lineOf(reportingSource, 'order_id BIGINT REFERENCES orders (id)') },
  ]);
});

test('commented out DDL never reaches the graph', () => {
  // Both comment forms sit inside live statements as well as between them, so
  // a missed comment would show up as a foreign key on a real table.
  for (const commented of [
    '-- Was REFERENCES ghost_table',
    '/* FOREIGN KEY (sku) REFERENCES ghost_table',
    '-- CREATE TABLE ghost_table',
    '/* ALTER TABLE orders',
  ]) {
    assert.ok(schemaSource.includes(commented), `fixture should keep ${JSON.stringify(commented)}`);
  }
  assert.deepEqual(schema.nodes.filter((node) => node.name === 'ghost_table'), []);
  assert.ok(!allTargets(schema).includes('ghost_table'));
});

test('a table name inside a string literal never becomes an edge', () => {
  // "... DEFAULT 'legacy import, references legacy_orders'" in a column, and
  // "'copied from legacy_orders'" in the middle of a view body.
  assert.ok(schemaSource.includes('references legacy_orders'), 'fixture should keep the quoted reference');
  assert.ok(reportingSource.includes("'copied from legacy_orders'"), 'fixture should keep the quoted from');
  assert.ok(!allTargets(schema).includes('legacy_orders'));
  assert.ok(!allTargets(reporting).includes('legacy_orders'));
});

test('a dollar quoted function body is skipped, semicolons and all', () => {
  assert.ok(reportingSource.includes('FROM order_lines'), 'fixture should keep the query in the function body');
  assert.ok(!allTargets(reporting).includes('order_lines'));
  // The semicolon inside the body did not cut the statement short.
  assert.equal(symbol(reporting, 'function', 'order_total').lineEnd, reportingSource.trimEnd().split('\n').length);
});

test('malformed SQL yields partial output instead of throwing', () => {
  const broken = [
    '',
    ';;;',
    'CREATE OR REPLACE',
    'CREATE TABLE (',
    "CREATE TABLE stuck (a TEXT DEFAULT 'unterminated",
    '/* never closed',
    'ALTER TABLE',
    'CREATE TABLE fine (id INT); CREATE TABLE also_fine (id INT)',
  ];
  for (const source of broken) {
    const result = sqlExtractor.extract({ tree: null, path: 'db/broken.sql', source, repo: 'fixture' });
    assert.ok(result.nodes.length >= 1, `${JSON.stringify(source)} should at least yield a module node`);
  }

  const recovered = sqlExtractor.extract({
    tree: null,
    path: 'db/broken.sql',
    source: 'CREATE TABLE fine (id INT); CREATE TABLE also_fine (id INT)',
    repo: 'fixture',
  });
  assert.deepEqual(
    recovered.nodes.filter((node) => node.kind === 'table').map((node) => node.name),
    ['fine', 'also_fine'],
  );
});
