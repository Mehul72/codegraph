import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { javaExtractor } from '../src/extract/java.js';
import { ParserPool } from '../src/extract/parser.js';
import type { EdgeType, ExtractResult, GraphNode, NodeKind } from '../src/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'java');
const PACKAGE_ROOT = 'src/main/java/com/acme';

const pool = new ParserPool();
after(() => pool.dispose());

function read(relPath: string): string {
  return fs.readFileSync(path.join(FIXTURES, ...relPath.split('/')), 'utf8');
}

async function extract(relPath: string): Promise<ExtractResult> {
  const source = read(relPath);
  const tree = await pool.parse('tree-sitter-java.wasm', source);
  assert.ok(tree, 'grammars/tree-sitter-java.wasm must be present for this test');
  return javaExtractor.extract({ tree, path: relPath, source, repo: 'fixture' });
}

function symbol(result: ExtractResult, kind: NodeKind, qualified: string): GraphNode {
  const found = result.nodes.filter((node) => node.kind === kind && node.qualified === qualified);
  assert.equal(found.length, 1, `expected one ${kind} named ${qualified}, found ${found.length}`);
  const [only] = found;
  assert.ok(only);
  return only;
}

interface NameEdge {
  from: string;
  name: string;
  qualifier: string | null;
  line: number;
}

function nameEdges(result: ExtractResult, type: EdgeType, from?: GraphNode): NameEdge[] {
  return result.edges.flatMap((edge) =>
    edge.type === type && edge.to.kind === 'name' && (!from || edge.from === from.id)
      ? [{ from: edge.from, name: edge.to.name, qualifier: edge.to.qualifier ?? null, line: edge.line }]
      : [],
  );
}

function names(result: ExtractResult, type: EdgeType, from?: GraphNode): string[] {
  return nameEdges(result, type, from).map((edge) => edge.name);
}

function imports(result: ExtractResult): { module: string; symbol: string | null; alias: string | null }[] {
  return result.edges.flatMap((edge) =>
    edge.type === 'imports' && edge.to.kind === 'module'
      ? [{ module: edge.to.module, symbol: edge.to.symbol ?? null, alias: edge.to.alias ?? null }]
      : [],
  );
}

function defines(result: ExtractResult, from: GraphNode): string[] {
  return result.edges.flatMap((edge) =>
    edge.type === 'defines' && edge.from === from.id && edge.to.kind === 'id' ? [edge.to.id] : [],
  );
}

const base = await extract(`${PACKAGE_ROOT}/core/BaseEntity.java`);
const generic = await extract(`${PACKAGE_ROOT}/core/Repository.java`);
const order = await extract(`${PACKAGE_ROOT}/store/Order.java`);
const events = await extract(`${PACKAGE_ROOT}/store/OrderEvent.java`);
const contract = await extract(`${PACKAGE_ROOT}/store/OrderRepository.java`);
const dao = await extract(`${PACKAGE_ROOT}/store/JdbcOrderRepository.java`);
const controller = await extract(`${PACKAGE_ROOT}/web/OrderController.java`);

test('the module node is named after the file and qualified by the package', () => {
  const module = symbol(order, 'module', 'com.acme.store');
  assert.equal(module.name, 'Order');
  assert.equal(module.lang, 'java');
  assert.equal(module.lineStart, 1);
});

test('a file with no package declaration falls back to its own name', () => {
  const source = 'class Loose {\n  void go() {}\n}\n';
  assert.equal(javaExtractor.modulePath?.('Loose.java', source), 'Loose');
  assert.deepEqual(javaExtractor.moduleAliases?.('Loose.java', source), ['Loose']);
});

test('each declaration kind maps to a node kind', () => {
  assert.equal(symbol(contract, 'interface', 'OrderRepository').name, 'OrderRepository');
  assert.equal(symbol(order, 'class', 'Order').name, 'Order');
  // An enum is a class and a record is a struct, being the nearest kinds.
  assert.equal(symbol(events, 'class', 'OrderEvent').name, 'OrderEvent');
  assert.equal(symbol(events, 'struct', 'OrderEvent.Entry').name, 'Entry');
});

test('qualified names are module relative and nest through inner types', () => {
  assert.deepEqual(
    dao.nodes.filter((node) => node.kind === 'method').map((node) => node.qualified),
    [
      'JdbcOrderRepository.JdbcOrderRepository',
      'JdbcOrderRepository.recent',
      'JdbcOrderRepository.byId',
      'JdbcOrderRepository.close',
      'JdbcOrderRepository.RowMapper.map',
    ],
  );
  assert.equal(symbol(dao, 'class', 'JdbcOrderRepository.RowMapper').name, 'RowMapper');
  assert.equal(symbol(events, 'method', 'OrderEvent.Entry.isTerminal').name, 'isTerminal');
});

test('a constructor is a method named after its class', () => {
  const constructor = symbol(order, 'method', 'Order.Order');
  assert.equal(constructor.name, 'Order');
  assert.equal(constructor.signature, 'public Order(long id, String status)');
  assert.ok(defines(order, symbol(order, 'class', 'Order')).includes(constructor.id));
});

test('static final fields are constants and instance fields are not nodes', () => {
  const constant = symbol(order, 'constant', 'Order.STATUS_OPEN');
  assert.equal(constant.name, 'STATUS_OPEN');
  assert.equal(constant.lineStart, 7);
  assert.ok(defines(order, symbol(order, 'class', 'Order')).includes(constant.id));
  assert.deepEqual(order.nodes.filter((node) => node.name === 'status' && node.kind !== 'method'), []);

  // Interface fields are static final by rule and get their own node type.
  assert.equal(symbol(contract, 'constant', 'OrderRepository.PAGE_SIZE').exported, true);
});

test('exported follows Java visibility, with interface members implicitly public', () => {
  assert.equal(symbol(order, 'class', 'Order').exported, true);
  assert.equal(symbol(order, 'method', 'Order.status').exported, true);
  // Package-private.
  assert.equal(symbol(order, 'method', 'Order.isOpen').exported, false);
  assert.equal(symbol(dao, 'method', 'JdbcOrderRepository.close').exported, false);
  // Protected is visible to subclasses in other files.
  assert.equal(symbol(base, 'method', 'BaseEntity.BaseEntity').exported, true);
  // No modifiers at all, inside an interface.
  assert.equal(symbol(contract, 'method', 'OrderRepository.recent').exported, true);
});

test('extends is inherits and implements is implements', () => {
  assert.deepEqual(nameEdges(order, 'inherits', symbol(order, 'class', 'Order')), [
    { from: symbol(order, 'class', 'Order').id, name: 'BaseEntity', qualifier: null, line: 6 },
  ]);
  assert.deepEqual(names(order, 'implements'), []);
  assert.deepEqual(names(dao, 'implements', symbol(dao, 'class', 'JdbcOrderRepository')), ['OrderRepository']);
  assert.deepEqual(names(dao, 'inherits'), []);

  // One interface extending another is inheritance, not implementation.
  const contractNode = symbol(contract, 'interface', 'OrderRepository');
  assert.deepEqual(names(contract, 'inherits', contractNode), ['Repository']);
  assert.deepEqual(names(contract, 'implements'), []);
  // The type argument on the supertype is an ordinary reference.
  assert.deepEqual(names(contract, 'references', contractNode), ['Order']);
});

test('an import records the package as the module and the type as the symbol', () => {
  assert.deepEqual(imports(order), [{ module: 'com.acme.core', symbol: 'BaseEntity', alias: 'BaseEntity' }]);
  assert.deepEqual(imports(controller), [
    { module: 'java.util', symbol: 'List', alias: 'List' },
    // A wildcard binds no single name.
    { module: 'org.springframework.web.bind.annotation', symbol: null, alias: null },
    { module: 'com.acme.store', symbol: 'Order', alias: 'Order' },
    { module: 'com.acme.store', symbol: 'OrderRepository', alias: 'OrderRepository' },
  ]);
  // A static import names the member, so the type becomes the module.
  assert.ok(
    imports(dao).some(
      (entry) => entry.module === 'java.util.Objects' && entry.symbol === 'requireNonNull' && entry.alias === 'requireNonNull',
    ),
  );
});

test('a call keeps its receiver as the qualifier', () => {
  const recent = symbol(dao, 'method', 'JdbcOrderRepository.recent');
  assert.deepEqual(
    nameEdges(dao, 'calls', recent)
      .filter((edge) => edge.name === 'prepareStatement')
      .map((edge) => ({ name: edge.name, qualifier: edge.qualifier, line: edge.line })),
    [{ name: 'prepareStatement', qualifier: 'connection', line: 33 }],
  );

  // An unqualified call has no receiver to record.
  const constructor = symbol(dao, 'method', 'JdbcOrderRepository.JdbcOrderRepository');
  assert.deepEqual(nameEdges(dao, 'calls', constructor), [
    { from: constructor.id, name: 'requireNonNull', qualifier: null, line: 27 },
  ]);

  // Cross-package: the controller calls into com.acme.store.
  const summary = symbol(controller, 'method', 'OrderController.summary');
  assert.ok(nameEdges(controller, 'calls', summary).some((edge) => edge.name === 'recent' && edge.qualifier === 'repository'));
});

test('new Foo() is a call on the type', () => {
  const map = symbol(dao, 'method', 'JdbcOrderRepository.RowMapper.map');
  assert.ok(names(dao, 'calls', map).includes('Order'));
  assert.ok(names(dao, 'calls', symbol(dao, 'method', 'JdbcOrderRepository.recent')).includes('ArrayList'));
});

test('types in signatures and fields become references', () => {
  const recent = symbol(contract, 'method', 'OrderRepository.recent');
  // Return type plus its generic argument.
  assert.deepEqual(names(contract, 'references', recent), ['List', 'Order']);

  const map = symbol(dao, 'method', 'JdbcOrderRepository.RowMapper.map');
  assert.deepEqual(names(dao, 'references', map), ['Order', 'ResultSet', 'SQLException']);

  // An instance field has no node, so its type belongs to the class.
  assert.ok(names(dao, 'references', symbol(dao, 'class', 'JdbcOrderRepository')).includes('Connection'));

  // Annotations used on a declaration count too.
  assert.ok(names(dao, 'references', symbol(dao, 'method', 'JdbcOrderRepository.recent')).includes('Override'));
  assert.ok(names(controller, 'references', symbol(controller, 'class', 'OrderController')).includes('RestController'));
});

test('a type variable is a declaration, not a reference', () => {
  const declaration = symbol(generic, 'interface', 'Repository');
  // <T extends BaseEntity>: the bound is a real dependency, T is not.
  assert.deepEqual(names(generic, 'references', declaration), ['BaseEntity']);
  assert.deepEqual(names(generic, 'references', symbol(generic, 'method', 'Repository.byId')), ['Optional']);
});

test('SQL in a string constant becomes queries refs on that constant', () => {
  const inline = symbol(dao, 'constant', 'JdbcOrderRepository.SELECT_RECENT');
  assert.deepEqual(names(dao, 'queries', inline), ['orders', 'customers']);

  // Text blocks are string literals too.
  const textBlock = symbol(dao, 'constant', 'JdbcOrderRepository.SELECT_BY_ID');
  assert.deepEqual(names(dao, 'queries', textBlock), ['orders']);
});

test('Spring mappings become endpoints under the class level path', () => {
  const module = symbol(controller, 'module', 'com.acme.web');
  assert.deepEqual(
    controller.nodes.filter((node) => node.kind === 'endpoint').map((node) => node.name),
    ['GET /api/orders', 'GET /api/orders/{id}', 'GET /api/orders/summary'],
  );

  const endpoint = symbol(controller, 'endpoint', 'GET /api/orders/{id}');
  assert.equal(endpoint.lineStart, 26);
  assert.ok(defines(controller, module).includes(endpoint.id));

  const handler = symbol(controller, 'method', 'OrderController.byId');
  assert.deepEqual(
    controller.edges.flatMap((edge) =>
      edge.from === endpoint.id && edge.to.kind === 'id' ? [{ type: edge.type, to: edge.to.id }] : [],
    ),
    [{ type: 'references', to: handler.id }],
  );

  // The class level @RequestMapping is a prefix, not an endpoint of its own.
  assert.deepEqual(controller.nodes.filter((node) => node.name === 'ANY /api/orders'), []);
});

test('javadoc above a declaration becomes its doc line', () => {
  assert.equal(symbol(order, 'class', 'Order').doc, 'One customer order.');
  assert.equal(symbol(base, 'class', 'BaseEntity').doc, 'Fields every persisted row carries.');
  assert.equal(symbol(contract, 'constant', 'OrderRepository.PAGE_SIZE').doc, 'Rows one listing page returns.');
  assert.equal(symbol(dao, 'class', 'JdbcOrderRepository.RowMapper').doc, 'Turns one result row into an order.');
  assert.equal(symbol(order, 'method', 'Order.status').doc, null);
});

test('signatures stop before the body', () => {
  assert.equal(symbol(base, 'class', 'BaseEntity').signature, 'public abstract class BaseEntity');
  assert.equal(symbol(dao, 'method', 'JdbcOrderRepository.recent').signature, '@Override public List<Order> recent(int limit)');
  // No body to stop at, and the trailing semicolon is not part of a signature.
  assert.equal(symbol(contract, 'method', 'OrderRepository.recent').signature, 'List<Order> recent(int limit)');
});

test('modulePath is the package and moduleAliases add the declared type', () => {
  const relPath = `${PACKAGE_ROOT}/store/OrderRepository.java`;
  const source = read(relPath);
  assert.equal(javaExtractor.modulePath?.(relPath, source), 'com.acme.store');
  assert.deepEqual(javaExtractor.moduleAliases?.(relPath, source), [
    'com.acme.store',
    'com.acme.store.OrderRepository',
  ]);
});
