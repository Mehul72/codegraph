import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

import { ParserPool } from '../src/extract/parser.js';
import { extractorFor } from '../src/extract/registry.js';
import { swiftExtractor, swiftModuleOf } from '../src/extract/swift.js';
import type { EdgeType, ExtractResult, GraphNode, NodeKind } from '../src/types.js';

const FIXTURES = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'swift');

const pool = new ParserPool();
after(() => pool.dispose());

/** Parses the way the indexer does, source rewrite included. */
async function extractSource(relPath: string, source: string): Promise<ExtractResult> {
  const tree = await pool.parse('tree-sitter-swift.wasm', swiftExtractor.prepareSource?.(source) ?? source);
  assert.ok(tree, 'grammars/tree-sitter-swift.wasm must be present for this test');
  return swiftExtractor.extract({ tree, path: relPath, source, repo: 'fixture' });
}

function extract(relPath: string): Promise<ExtractResult> {
  return extractSource(relPath, fs.readFileSync(path.join(FIXTURES, ...relPath.split('/')), 'utf8'));
}

function symbol(result: ExtractResult, kind: NodeKind, qualified: string): GraphNode {
  const found = result.nodes.filter((node) => node.kind === kind && node.qualified === qualified);
  assert.equal(found.length, 1, `expected one ${kind} named ${qualified}, found ${found.length}`);
  const [only] = found;
  assert.ok(only);
  return only;
}

interface NameRef {
  name: string;
  qualifier: string | null;
  line: number;
}

function refs(result: ExtractResult, type: EdgeType, from: GraphNode): NameRef[] {
  return result.edges.flatMap((edge) =>
    edge.type === type && edge.to.kind === 'name' && edge.from === from.id
      ? [{ name: edge.to.name, qualifier: edge.to.qualifier ?? null, line: edge.line }]
      : [],
  );
}

/** `qualifier::name`, or the bare name, which reads well in an assertion message. */
function refNames(result: ExtractResult, type: EdgeType, from: GraphNode): string[] {
  return refs(result, type, from).map((ref) => (ref.qualifier ? `${ref.qualifier}::${ref.name}` : ref.name));
}

function definedBy(result: ExtractResult, from: GraphNode): string[] {
  return result.edges.flatMap((edge) =>
    edge.type === 'defines' && edge.from === from.id && edge.to.kind === 'id' ? [edge.to.id] : [],
  );
}

function imports(result: ExtractResult): { module: string; alias: string | null; line: number }[] {
  return result.edges.flatMap((edge) =>
    edge.type === 'imports' && edge.to.kind === 'module'
      ? [{ module: edge.to.module, alias: edge.to.alias ?? null, line: edge.line }]
      : [],
  );
}

const order = await extract('Sources/Store/Order.swift');
const store = await extract('Sources/Store/OrderStore.swift');
const formatting = await extract('Sources/Store/Order+Formatting.swift');
const viewModel = await extract('Sources/App/OrderViewModel.swift');
const tests = await extract('Tests/StoreTests/OrderStoreTests.swift');

test('.swift files go to the swift extractor', () => {
  assert.equal(extractorFor('Sources/Store/Order.swift')?.id, 'swift');
  assert.equal(extractorFor('App/Order+Formatting.swift')?.id, 'swift');
  assert.equal(swiftExtractor.grammar, 'tree-sitter-swift.wasm');
});

test('a file belongs to its SwiftPM target, or else to its top-level folder', () => {
  assert.equal(swiftModuleOf('Sources/Store/Order.swift'), 'Store');
  assert.equal(swiftModuleOf('Sources/Store/Models/Order.swift'), 'Store');
  assert.equal(swiftModuleOf('Tests/StoreTests/OrderStoreTests.swift'), 'StoreTests');
  // A package inside a monorepo still has its own targets.
  assert.equal(swiftModuleOf('Packages/Payments/Sources/Payments/Card.swift'), 'Payments');
  // Xcode keeps one folder per target.
  assert.equal(swiftModuleOf('ShopApp/Views/OrderList.swift'), 'ShopApp');
  assert.equal(swiftModuleOf('Package.swift'), '.');
  assert.equal(swiftExtractor.modulePath?.('Sources/App/main.swift', ''), 'App');
});

test('the module node is named after the file and qualified by the module', () => {
  const moduleNode = symbol(formatting, 'module', 'Store');
  assert.equal(moduleNode.name, 'Order+Formatting');
  assert.equal(moduleNode.lang, 'swift');
  assert.equal(moduleNode.lineStart, 1);
  assert.equal(symbol(viewModel, 'module', 'App').name, 'OrderViewModel');
});

test('Order.swift yields exactly the symbols we expect, in source order', () => {
  assert.deepEqual(
    order.nodes.map((node) => `${node.kind}:${node.qualified}`),
    [
      'module:Store',
      'interface:OrderID',
      'struct:Order',
      'class:Order.Status',
      'constant:Order.TABLE',
      'method:Order.init',
      'method:Order.isPending',
      'method:Order.add',
      'method:Order.<',
      'method:Order.audit',
      'struct:LineItem',
    ],
  );
});

test('each declaration kind maps to the nearest node kind', () => {
  assert.equal(symbol(store, 'interface', 'OrderStore').name, 'OrderStore');
  assert.equal(symbol(store, 'class', 'SQLOrderStore').name, 'SQLOrderStore');
  // An actor and an enum have no kind of their own and take class.
  assert.equal(symbol(store, 'class', 'OrderCache').signature, 'actor OrderCache');
  assert.equal(symbol(order, 'class', 'Order.Status').signature, 'public enum Status: String, CaseIterable');
  // A typealias is filed under interface, as TypeScript does.
  assert.equal(symbol(order, 'interface', 'OrderID').signature, 'public typealias OrderID = UUID');
});

test('initializers, deinitializers and computed properties are methods', () => {
  assert.equal(symbol(order, 'method', 'Order.init').signature, 'public init(id: OrderID, totalCents: Int)');
  assert.equal(symbol(store, 'method', 'SQLOrderStore.deinit').lineStart, 27);
  assert.equal(symbol(order, 'method', 'Order.isPending').signature, 'public var isPending: Bool');
  // Protocol requirements are methods on the protocol.
  assert.equal(symbol(store, 'method', 'OrderStore.find').signature, 'func find(id: OrderID) async throws -> Order?');
  // An operator is a method named after its symbol.
  assert.equal(symbol(order, 'method', 'Order.<').name, '<');
});

test('static and top-level lets are constants, and stored properties are not nodes', async () => {
  const table = symbol(order, 'constant', 'Order.TABLE');
  assert.equal(table.signature, 'static let TABLE = "orders"');
  assert.ok(definedBy(order, symbol(order, 'struct', 'Order')).includes(table.id));
  assert.deepEqual(
    order.nodes.filter((node) => ['id', 'status', 'totalCents', 'lines'].includes(node.name)),
    [],
  );

  const pkg = symbol(await extract('Package.swift'), 'constant', 'package');
  assert.equal(pkg.lineStart, 4);
});

test('exported means public or open, and a member takes its container default', () => {
  assert.equal(symbol(order, 'struct', 'Order').exported, true);
  assert.equal(symbol(store, 'class', 'BaseStore').exported, true);
  assert.equal(symbol(store, 'method', 'SQLOrderStore.find').exported, true);
  // Internal by default, whatever the type's own level.
  assert.equal(symbol(order, 'constant', 'Order.TABLE').exported, false);
  assert.equal(symbol(store, 'method', 'BaseStore.log').exported, false);
  assert.equal(symbol(order, 'struct', 'LineItem').exported, false);
  // Requirements share their protocol's level.
  assert.equal(symbol(store, 'method', 'OrderStore.save').exported, true);
  assert.equal(symbol(formatting, 'method', 'Auditable.audit').exported, false);
  // `public extension` makes its members public unless they say otherwise.
  assert.equal(symbol(formatting, 'method', 'Order.formatted').exported, true);
  assert.equal(symbol(formatting, 'method', 'Order.centsLabel').exported, false);
});

test('private(set) narrows the setter, not the declaration', async () => {
  const result = await extractSource(
    'Sources/Store/Counter.swift',
    'public struct Counter {\n    public private(set) var total: Int { 0 }\n    private(set) var last: Int { 0 }\n}\n',
  );
  assert.equal(symbol(result, 'method', 'Counter.total').exported, true);
  assert.equal(symbol(result, 'method', 'Counter.last').exported, false);
});

test('signatures stop at the body and keep attributes', () => {
  assert.equal(
    symbol(store, 'class', 'SQLOrderStore').signature,
    'public final class SQLOrderStore: BaseStore, OrderStore',
  );
  assert.equal(
    symbol(viewModel, 'class', 'OrderViewModel').signature,
    '@MainActor final class OrderViewModel: ObservableObject',
  );
  assert.equal(
    symbol(viewModel, 'method', 'OrderViewModel.init').signature,
    'init(store: any OrderStore = Store.makeDefaultStore())',
  );
});

test('doc comments keep their first paragraph, from /// or /** */', () => {
  assert.equal(symbol(order, 'struct', 'Order').doc, 'A customer order.');
  assert.equal(symbol(order, 'class', 'Order.Status').doc, 'Where an order is in its life.');
  assert.equal(symbol(order, 'method', 'Order.isPending').doc, 'Whether the order still needs to be shipped.');
  // The attribute line sits between the comment and the keyword.
  assert.equal(symbol(store, 'interface', 'OrderStore').doc, 'Reads and writes orders.');
});

test('a compiler directive above a declaration is not its doc', async () => {
  const result = await extractSource(
    'Sources/Store/Flags.swift',
    'struct Flags {\n    #if DEBUG\n    func verbose() {}\n    #endif\n}\n',
  );
  assert.equal(symbol(result, 'method', 'Flags.verbose').doc, null);
});

test('extension members are qualified by the type they extend and defined by the file', () => {
  const moduleNode = symbol(formatting, 'module', 'Store');
  const formatted = symbol(formatting, 'method', 'Order.formatted');
  const findAll = symbol(formatting, 'method', 'OrderStore.findAll');
  assert.ok(definedBy(formatting, moduleNode).includes(formatted.id));
  assert.ok(definedBy(formatting, moduleNode).includes(findAll.id));
  assert.equal(symbol(formatting, 'method', 'SQLOrderStore.audit').name, 'audit');
});

test('an extension in the same file as its type is defined by the type as well', () => {
  const type = symbol(order, 'struct', 'Order');
  const less = symbol(order, 'method', 'Order.<');
  assert.ok(definedBy(order, type).includes(less.id));
  assert.ok(definedBy(order, symbol(order, 'module', 'Store')).includes(less.id));
});

test('a conformance added by an extension hangs off the type, or off the file when the type is elsewhere', () => {
  // Comparable is the standard library's, so only Auditable becomes an edge.
  assert.deepEqual(refNames(order, 'implements', symbol(order, 'struct', 'Order')), ['Auditable']);
  // SQLOrderStore is declared in OrderStore.swift, so this file is what promised the conformance.
  assert.deepEqual(refNames(formatting, 'implements', symbol(formatting, 'module', 'Store')), ['Auditable']);
});

test('a class inherits its first supertype and implements the rest', () => {
  const sql = symbol(store, 'class', 'SQLOrderStore');
  assert.deepEqual(refNames(store, 'inherits', sql), ['BaseStore']);
  assert.deepEqual(refNames(store, 'implements', sql), ['OrderStore']);
});

test('a protocol inherits what it refines, and a struct implements what it adopts', async () => {
  const result = await extractSource(
    'Sources/Store/Shipping.swift',
    [
      'protocol Shippable: Auditable {}',
      'struct Parcel: Shippable, Repository<Order> {}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(refNames(result, 'inherits', symbol(result, 'interface', 'Shippable')), ['Auditable']);
  const parcel = symbol(result, 'struct', 'Parcel');
  assert.deepEqual(refNames(result, 'implements', parcel), ['Shippable', 'Repository']);
  // Generic arguments on a supertype are references.
  assert.deepEqual(refNames(result, 'references', parcel), ['Order']);
});

test('an import binds the module name, whatever form it takes', async () => {
  assert.deepEqual(imports(viewModel), [
    { module: 'Foundation', alias: 'Foundation', line: 1 },
    { module: 'Store', alias: 'Store', line: 2 },
  ]);
  assert.deepEqual(imports(tests).map((entry) => entry.module), ['XCTest', 'Store']);

  const scoped = await extractSource(
    'Sources/App/Scoped.swift',
    'import struct Store.Order\nimport class UIKit.UIView\n',
  );
  assert.deepEqual(imports(scoped).map((entry) => entry.module), ['Store', 'UIKit']);
});

test('bare calls and constructions are recorded by name', () => {
  const makeDefault = symbol(formatting, 'function', 'makeDefaultStore');
  assert.deepEqual(refNames(formatting, 'calls', makeDefault), ['SQLOrderStore', 'Database']);
  // An implicit-self call is bare; resolution looks for it on the enclosing type.
  assert.deepEqual(refNames(formatting, 'calls', symbol(formatting, 'method', 'Order.formatted')), ['centsLabel']);
  // `Order.init(row:)` builds an Order, exactly like `Order(row:)`.
  assert.ok(refNames(store, 'calls', symbol(store, 'method', 'SQLOrderStore.find')).includes('Order'));
});

test('a method call is recorded against the receiver type the source states', () => {
  const sql = (name: string) => refNames(store, 'calls', symbol(store, 'method', `SQLOrderStore.${name}`));
  // `db` is a stored property declared as Database.
  assert.deepEqual(sql('deinit'), ['Database::close']);
  assert.deepEqual(sql('save'), ['Database::execute', 'self::log']);

  const place = refNames(viewModel, 'calls', symbol(viewModel, 'method', 'OrderViewModel.place'));
  // `store` is `any OrderStore`, and `order` was built by `Order(...)` in this body.
  assert.deepEqual(place, ['Order', 'UUID', 'OrderStore::save', 'Order::formatted']);

  const load = refNames(viewModel, 'calls', symbol(viewModel, 'method', 'OrderViewModel.load'));
  assert.deepEqual(load, ['OrderStore::findAll', 'refresh']);

  // A capitalised receiver that is not a variable names a type or a module.
  const init = refNames(viewModel, 'calls', symbol(viewModel, 'method', 'OrderViewModel.init'));
  assert.deepEqual(init, ['Store::makeDefaultStore']);

  const testCase = refNames(tests, 'calls', symbol(tests, 'method', 'OrderStoreTests.testSaveThenFind'));
  // An implicitly unwrapped `SQLOrderStore!` property still types its receiver.
  assert.deepEqual(testCase, ['Order', 'UUID', 'SQLOrderStore::save', 'SQLOrderStore::find', 'XCTAssertEqual']);
});

test('calls that no evidence could place are not recorded at all', () => {
  const place = refNames(viewModel, 'calls', symbol(viewModel, 'method', 'OrderViewModel.place'));
  // An array's append, a closure property and the standard library's print.
  for (const name of ['append', 'onChange', 'print']) {
    assert.ok(!place.some((entry) => entry.endsWith(name)), `${name} should not be recorded, saw ${place.join(', ')}`);
  }
  // `rows` has no declared type, and super.init() names no type of its own.
  const find = refNames(store, 'calls', symbol(store, 'method', 'SQLOrderStore.find'));
  assert.ok(!find.some((entry) => entry.endsWith('map')), find.join(', '));
  assert.deepEqual(refNames(store, 'calls', symbol(store, 'method', 'SQLOrderStore.init')), []);
});

test('Self and self both name the enclosing type', async () => {
  const result = await extractSource(
    'Sources/Store/Clock.swift',
    [
      'struct Clock {',
      '    static func now() -> Int { 0 }',
      '    func tick() {',
      '        Self.now()',
      '        self.reset()',
      '    }',
      '    func reset() {}',
      '}',
      '',
    ].join('\n'),
  );
  assert.deepEqual(refNames(result, 'calls', symbol(result, 'method', 'Clock.tick')), ['self::now', 'self::reset']);
});

test('signature types are references, without the standard library or generic parameters', async () => {
  assert.deepEqual(refNames(store, 'references', symbol(store, 'method', 'OrderStore.find')), ['OrderID', 'Order']);
  assert.deepEqual(refNames(store, 'references', symbol(store, 'class', 'OrderCache')), ['OrderID', 'Order']);

  const result = await extractSource(
    'Sources/Store/Codec.swift',
    [
      'struct Codec<Value: Encodable> {',
      '    func decode<T>(_ type: T.Type, from row: Row, as status: Order.Status) -> [String: T] {',
      '        let kind = Order.Kind.self',
      '        return decoder.decode(Order.self, from: row)',
      '    }',
      '    func meta(_ type: Order.Type) -> Value? { nil }',
      '}',
      '',
    ].join('\n'),
  );
  const decode = symbol(result, 'method', 'Codec.decode');
  // A nested type keeps its outer type as the qualifier, and `X.self` is a reference to X.
  assert.deepEqual(refNames(result, 'references', decode), ['Row', 'Order::Status', 'Order::Kind', 'Order']);
  // `Order.Type` is Order's metatype, and Order is the type depended on.
  assert.deepEqual(refNames(result, 'references', symbol(result, 'method', 'Codec.meta')), ['Order']);
});

test('SQL in plain, multi-line and raw strings becomes queries edges', async () => {
  assert.deepEqual(refNames(store, 'queries', symbol(store, 'method', 'SQLOrderStore.find')), ['orders']);
  assert.deepEqual(refNames(store, 'queries', symbol(store, 'method', 'SQLOrderStore.save')), ['orders']);

  const result = await extractSource(
    'Sources/Store/Purge.swift',
    'let PURGE = #"DELETE FROM carts WHERE note = "stale""#\n',
  );
  assert.deepEqual(refNames(result, 'queries', symbol(result, 'constant', 'PURGE')), ['carts']);
});

test('property wrappers and global actors are references, compiler attributes are not', () => {
  const model = symbol(viewModel, 'class', 'OrderViewModel');
  const refs = refNames(viewModel, 'references', model);
  assert.ok(refs.includes('Published'), refs.join(', '));
  assert.ok(!refs.includes('MainActor'), 'MainActor is the standard library\'s');
});

test('`if let x = try await f()` no longer costs the grammar the rest of the file', async () => {
  const result = await extractSource(
    'Sources/Store/Sync.swift',
    [
      'final class Syncer {',
      '    func sync() async throws {',
      '        if let order = try await fetchOrder(id: 1) {',
      '            archive(order)',
      '        }',
      '        while let next = try? await queue.next() {',
      '            archive(next)',
      '        }',
      '    }',
      '    func archive(_ order: Order) {}',
      '}',
      '',
    ].join('\n'),
  );
  const sync = symbol(result, 'method', 'Syncer.sync');
  assert.deepEqual(refNames(result, 'calls', sync), ['fetchOrder', 'archive', 'archive']);
  assert.equal(symbol(result, 'method', 'Syncer.archive').lineStart, 10);
});

test('the source rewrite blanks await after try and nothing else, keeping every offset', () => {
  const prepare = (text: string) => swiftExtractor.prepareSource?.(text) ?? text;
  const source = [
    'let a = try await f()',
    'let b = try? await f()',
    'let c = try!  await f()',
    'for try await line in lines {}',
    'for await tick in clock {}',
    'let d = await f()',
    'let awaitable = tryAgain()',
    '',
  ].join('\n');
  const prepared = prepare(source);
  assert.equal(prepared.length, source.length);
  assert.deepEqual(prepared.split('\n'), [
    'let a = try       f()',
    'let b = try?       f()',
    'let c = try!        f()',
    'for try await line in lines {}',
    'for await tick in clock {}',
    'let d = await f()',
    'let awaitable = tryAgain()',
    '',
  ]);
});

test('a syntax error costs only the code around it', async () => {
  const result = await extractSource(
    'Sources/Store/Broken.swift',
    'func first() {\n    fetchOrder(id: 1)\n    )))\n}\n\nfunc second() {\n    archive()\n}\n',
  );
  const tree = await pool.parse('tree-sitter-swift.wasm', 'func first() {\n    )))\n}\n');
  assert.ok(tree?.rootNode.hasError, 'the snippet has to be one the grammar rejects');
  tree?.delete();
  assert.ok(refNames(result, 'calls', symbol(result, 'function', 'first')).includes('fetchOrder'));
  assert.deepEqual(refNames(result, 'calls', symbol(result, 'function', 'second')), ['archive']);
});
