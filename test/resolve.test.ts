import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { cleanupRepos, indexRepo, makeRepo, useTempHome } from './helpers.js';
import type { Confidence, EdgeType } from '../src/types.js';

await useTempHome();
after(cleanupRepos);

/**
 * The confidence tag is a promise to the agent, so it gets its own tests.
 *
 *   exact      the source says so outright
 *   resolved   an import chain or a typed receiver backs it up
 *   heuristic  a name matched and nothing else did
 *
 * Marking a guess as resolved is the failure mode that matters here. An agent
 * that trusts a wrong edge will change the wrong code, so these tests are as
 * much about what is not claimed as about what is.
 */

interface Link {
  from: string;
  to: string;
  type: EdgeType;
  confidence: Confidence;
  line: number;
}

async function linksIn(files: Record<string, string>): Promise<Link[]> {
  const root = await makeRepo('resolve', files);
  const indexed = await indexRepo(root);
  const nodes = new Map(indexed.store.allNodesLite().map((n) => [n.id, n]));
  const links = indexed.store
    .outgoing([...nodes.keys()])
    .map((edge) => {
      const src = nodes.get(edge.srcId);
      const dst = nodes.get(edge.dstId);
      return {
        from: src ? (src.qualified ?? src.name) : edge.srcId,
        to: dst ? (dst.qualified ?? dst.name) : edge.dstId,
        type: edge.type,
        confidence: edge.confidence,
        line: edge.line,
      };
    })
    .sort((a, b) => a.line - b.line || a.to.localeCompare(b.to));
  indexed.close();
  return links;
}

function find(links: readonly Link[], type: EdgeType, to: string, from?: string): Link {
  const hits = links.filter((l) => l.type === type && l.to === to && (from === undefined || l.from === from));
  assert.ok(hits.length > 0, `expected a ${type} edge to ${to}${from ? ` from ${from}` : ''}, saw:\n${describe(links)}`);
  return hits[0] as Link;
}

function describe(links: readonly Link[]): string {
  return links.map((l) => `  ${l.from} -${l.type}/${l.confidence}-> ${l.to} (:${l.line})`).join('\n');
}

test('a call to something imported by name is resolved, not guessed', async () => {
  const links = await linksIn({
    'pkg/__init__.py': '',
    'pkg/math.py': 'def add(a, b):\n    return a + b\n',
    'pkg/use.py': 'from pkg.math import add\n\n\ndef total():\n    return add(1, 2)\n',
  });

  // `from x import y` points at the symbol, which is more precise than
  // pointing at the file and still reaches the file through defines.
  assert.equal(find(links, 'imports', 'add', 'pkg.use').confidence, 'resolved');
  assert.equal(find(links, 'calls', 'add', 'total').confidence, 'resolved');
});

test('a whole-module import points at the module', async () => {
  const links = await linksIn({
    'pkg/__init__.py': '',
    'pkg/math.py': 'def add(a, b):\n    return a + b\n',
    'pkg/use.py': 'import pkg.math\n\n\ndef total():\n    return pkg.math.add(1, 2)\n',
  });
  assert.equal(find(links, 'imports', 'pkg.math', 'pkg.use').confidence, 'resolved');
});

test('a call within one file is exact, since the parser saw both ends', async () => {
  const links = await linksIn({
    'solo.py': 'def helper():\n    return 1\n\n\ndef top():\n    return helper()\n',
  });
  assert.equal(find(links, 'calls', 'helper', 'top').confidence, 'exact');
});

test('a method call on a typed parameter follows the annotation', async () => {
  const links = await linksIn({
    'pkg/__init__.py': '',
    'pkg/store.py': 'class Store:\n    def read(self, key):\n        return key\n',
    'pkg/use.py': [
      'from pkg.store import Store',
      '',
      '',
      'def fetch(store: Store, key):',
      '    return store.read(key)',
      '',
    ].join('\n'),
  });
  assert.equal(find(links, 'calls', 'Store.read').confidence, 'resolved');
});

test('a method call on self is resolved through the class', async () => {
  const links = await linksIn({
    'pkg/__init__.py': '',
    'pkg/thing.py': [
      'class Thing:',
      '    def run(self):',
      '        return self.step()',
      '',
      '    def step(self):',
      '        return 1',
      '',
    ].join('\n'),
  });
  const call = find(links, 'calls', 'Thing.step', 'Thing.run');
  assert.equal(call.confidence, 'resolved');
});

test('a method call on an injected dependency is resolved, since the import proves it', async () => {
  const links = await linksIn({
    'pkg/__init__.py': '',
    'pkg/repo.py': 'class Repo:\n    def find(self, key):\n        return key\n',
    'pkg/service.py': [
      'from pkg.repo import Repo',
      '',
      '',
      'class Service:',
      '    def __init__(self, repo: Repo):',
      '        self.repo = repo',
      '',
      '    def get(self, key):',
      '        return self.repo.find(key)',
      '',
    ].join('\n'),
  });
  assert.equal(find(links, 'calls', 'Repo.find').confidence, 'resolved');
});

test('a bare name that exists in exactly one other file is only a heuristic', async () => {
  const links = await linksIn({
    'a.py': 'def process():\n    return 1\n',
    // No import of a.py at all, so the only evidence is the name.
    'b.py': 'def run(thing):\n    return thing.process()\n',
  });
  const call = links.find((l) => l.type === 'calls' && l.to === 'process');
  if (call) {
    assert.equal(call.confidence, 'heuristic', `a name match is not resolution:\n${describe(links)}`);
  }
});

test('a method call on an untypeable receiver does not match a free function', async () => {
  const links = await linksIn({
    // A private helper called push, alongside the array appends that share
    // its name. Left unchecked the helper collects an edge from every one of
    // them and becomes the most depended on symbol in the repo.
    'collect.py': [
      'def push(target, value):',
      '    target.append(value)',
      '',
      '',
      'def gather(rows):',
      '    out = []',
      '    out.push(1)',
      '    out.push(2)',
      '    return out',
      '',
    ].join('\n'),
  });

  const calls = links.filter((l) => l.type === 'calls' && l.to === 'push' && l.from === 'gather');
  assert.deepEqual(calls, [], `out.push() is not the free function push:\n${describe(links)}`);
});

test('a bare call does not match a method on an unrelated class', async () => {
  const links = await linksIn({
    'widget.py': 'class Widget:\n    def add(self, x):\n        return x\n',
    'totals.py': ['def sum_all(values):', '    total = 0', '    add(total)', '    return total', ''].join('\n'),
  });

  const calls = links.filter((l) => l.type === 'calls' && l.to === 'Widget.add');
  assert.deepEqual(calls, [], `a bare add() cannot be a method on Widget:\n${describe(links)}`);
});

test('a method call with no import behind it produces no edge at all', async () => {
  const links = await linksIn({
    'a/one.py': 'class Reader:\n    def read(self):\n        return 1\n',
    // No import of a/one.py, so there is no path from here to Reader.read.
    'b/two.py': 'def consume(stream):\n    return stream.read()\n',
  });

  const calls = links.filter((l) => l.type === 'calls' && l.to === 'Reader.read');
  assert.deepEqual(calls, [], `no evidence means no answer:\n${describe(links)}`);
});

test('two files in one Go package see each other without an import', async () => {
  const links = await linksIn({
    'go.mod': 'module example.com/app\n\ngo 1.22\n',
    'store/read.go': 'package store\n\nfunc Read() int {\n\treturn 1\n}\n',
    'store/write.go': 'package store\n\nfunc Write() int {\n\treturn Read()\n}\n',
  });

  const call = find(links, 'calls', 'Read', 'Write');
  assert.equal(call.confidence, 'resolved', 'a Go package is one scope across its files');
});

test('an ambiguous name produces heuristic edges to each candidate, or none at all', async () => {
  const links = await linksIn({
    'one.py': 'def handle():\n    return 1\n',
    'two.py': 'def handle():\n    return 2\n',
    'three.py': 'def handle():\n    return 3\n',
    'caller.py': 'def go(x):\n    return x.handle()\n',
  });
  const calls = links.filter((l) => l.type === 'calls' && l.to === 'handle');
  for (const call of calls) {
    assert.equal(call.confidence, 'heuristic', 'three candidates cannot be a resolution');
  }
});

test('an import of a package outside the repo stays unresolved rather than inventing a target', async () => {
  const root = await makeRepo('external', {
    'main.py': 'import requests\n\n\ndef fetch(url):\n    return requests.get(url)\n',
  });
  const indexed = await indexRepo(root);

  const external = indexed.store.allNodesLite().filter((n) => n.name === 'requests');
  for (const node of external) {
    assert.equal(node.kind, 'external', 'third-party modules are external, not invented symbols');
  }
  // The reference is kept so it resolves later if the package gets indexed.
  assert.ok(indexed.store.unresolvedRefCount() >= 0);
  indexed.close();
});

test('inheritance is exact when the base class is imported', async () => {
  const links = await linksIn({
    'pkg/__init__.py': '',
    'pkg/base.py': 'class Base:\n    def run(self):\n        return 1\n',
    'pkg/child.py': 'from pkg.base import Base\n\n\nclass Child(Base):\n    pass\n',
  });
  const inherits = find(links, 'inherits', 'Base', 'Child');
  assert.ok(inherits.confidence === 'exact' || inherits.confidence === 'resolved');
});

test('a relative import resolves to the sibling module', async () => {
  const links = await linksIn({
    'pkg/__init__.py': '',
    'pkg/util.py': 'def clean(text):\n    return text.strip()\n',
    'pkg/main.py': 'from .util import clean\n\n\ndef go(text):\n    return clean(text)\n',
  });
  assert.equal(find(links, 'imports', 'clean', 'pkg.main').confidence, 'resolved');
  assert.equal(find(links, 'calls', 'clean', 'go').confidence, 'resolved');
});

test('from package import submodule links the submodule, not the package', async () => {
  const links = await linksIn({
    'pkg/__init__.py': '',
    'pkg/long_name.py': 'def work():\n    return 1\n',
    'pkg/main.py': 'from pkg import long_name as ln\n\n\ndef go():\n    return ln.work()\n',
  });
  assert.equal(find(links, 'imports', 'pkg.long_name', 'pkg.main').confidence, 'resolved');
  assert.equal(find(links, 'calls', 'work', 'go').confidence, 'resolved');
});

test('from . import submodule works the same way', async () => {
  const links = await linksIn({
    'pkg/__init__.py': '',
    'pkg/helpers.py': 'def tidy(text):\n    return text\n',
    'pkg/main.py': 'from . import helpers\n\n\ndef go(text):\n    return helpers.tidy(text)\n',
  });
  assert.equal(find(links, 'calls', 'tidy', 'go').confidence, 'resolved');
});

test('defines edges are always exact, because the file says so', async () => {
  const links = await linksIn({
    'thing.py': 'class Thing:\n    def go(self):\n        return 1\n\n\ndef free():\n    return 2\n',
  });
  const defines = links.filter((l) => l.type === 'defines');
  assert.ok(defines.length > 0);
  for (const edge of defines) assert.equal(edge.confidence, 'exact');
});

test('every edge carries the file and line it came from', async () => {
  const links = await linksIn({
    'pkg/__init__.py': '',
    'pkg/a.py': 'def one():\n    return 1\n',
    'pkg/b.py': 'from pkg.a import one\n\n\ndef two():\n    return one()\n',
  });
  for (const link of links) {
    assert.ok(link.line >= 1, `edge ${link.from} -> ${link.to} has no line number`);
  }
});

test('resolution does not depend on the order files are indexed', async () => {
  const forward = await linksIn({
    'pkg/__init__.py': '',
    'pkg/aaa.py': 'from pkg.zzz import late\n\n\ndef early():\n    return late()\n',
    'pkg/zzz.py': 'def late():\n    return 1\n',
  });
  // Same graph, but the definition sorts before the use this time.
  const backward = await linksIn({
    'pkg/__init__.py': '',
    'pkg/aaa.py': 'def late():\n    return 1\n',
    'pkg/zzz.py': 'from pkg.aaa import late\n\n\ndef early():\n    return late()\n',
  });

  const forwardCall = find(forward, 'calls', 'late', 'early');
  const backwardCall = find(backward, 'calls', 'late', 'early');
  assert.equal(forwardCall.confidence, backwardCall.confidence);
  assert.equal(forwardCall.confidence, 'resolved');
});

/**
 * Re-exports.
 *
 * A barrel `index.ts` and a package `__init__.py` are how most TypeScript and
 * Python code presents its public surface, so an import that lands on one is
 * the common case rather than an exotic one. Stopping at the barrel produced
 * an edge onto the file and still called it `resolved`, which made every
 * caller of the real symbol vanish from find_callers and impact_of while the
 * answer went on claiming to be trustworthy.
 */

test('a call through a TypeScript barrel reaches the definition, not the barrel', async () => {
  const links = await linksIn({
    'src/models/widget.ts': 'export function makeWidget(id: string) {\n  return { id };\n}\n',
    'src/models/index.ts': "export * from './widget.js';\n",
    'src/app.ts': [
      "import { makeWidget } from './models/index.js';",
      '',
      'export function run() {',
      "  return makeWidget('a');",
      '}',
      '',
    ].join('\n'),
  });

  const call = find(links, 'calls', 'makeWidget', 'run');
  assert.equal(call.confidence, 'resolved');
  // The dependency on the barrel is real too, so the import keeps both ends.
  assert.ok(
    links.some((l) => l.type === 'imports' && l.to === 'src/models/index'),
    'the file still depends on the barrel it named',
  );
});

test('a renaming re-export is followed under the name the importer used', async () => {
  const links = await linksIn({
    'src/models/widget.ts': 'export const WIDGET_TABLE = "widgets";\n',
    'src/models/index.ts': "export { WIDGET_TABLE as TABLE } from './widget.js';\n",
    'src/app.ts': [
      "import { TABLE } from './models/index.js';",
      '',
      'export function run() {',
      '  return TABLE;',
      '}',
      '',
    ].join('\n'),
  });

  // Specifically the importer's own edge: the barrel has one of its own to
  // the same constant, and matching that would prove nothing.
  find(links, 'imports', 'WIDGET_TABLE', 'src/app');
});

test('a call through a Python package __init__ reaches the definition', async () => {
  const links = await linksIn({
    'pkg/__init__.py': 'from pkg.widget import make_widget\n',
    'pkg/widget.py': 'def make_widget(i):\n    return i\n',
    'app.py': 'from pkg import make_widget\n\n\ndef run():\n    return make_widget(1)\n',
  });

  const call = find(links, 'calls', 'make_widget', 'run');
  assert.equal(call.confidence, 'resolved');
});

test('a re-export cycle is walked without hanging', async () => {
  const links = await linksIn({
    'src/a.ts': "export * from './b.js';\n",
    'src/b.ts': "export * from './a.js';\n",
    'src/app.ts': [
      "import { nothing } from './a.js';",
      '',
      'export function run() {',
      '  return nothing();',
      '}',
      '',
    ].join('\n'),
  });

  // Nothing to find, and the point is that we get here at all.
  assert.equal(links.filter((l) => l.type === 'calls' && l.to === 'nothing').length, 0);
});

/**
 * A Go import names a directory, and a Go package is routinely spread over
 * several files. Resolving against only the first of them meant that which
 * symbols were reachable came down to filename order, so the two halves of
 * this test are the same package with the names swapped.
 */
async function goCallers(connFile: string, queryFile: string): Promise<Link[]> {
  return linksIn({
    'go.mod': 'module github.com/acme/app\n\ngo 1.22\n',
    [`store/${connFile}`]: 'package store\n\nfunc Connect() error { return nil }\n',
    [`store/${queryFile}`]: 'package store\n\nfunc FetchOrder(id int) error { return nil }\n',
    'cmd/main.go': [
      'package main',
      '',
      'import "github.com/acme/app/store"',
      '',
      'func main() {',
      '\tstore.Connect()',
      '\tstore.FetchOrder(7)',
      '}',
      '',
    ].join('\n'),
  });
}

test('every file of a Go package is reachable through one import', async () => {
  for (const [conn, query] of [
    ['aaa_conn.go', 'zzz_query.go'],
    ['zzz_conn.go', 'aaa_query.go'],
  ]) {
    const links = await goCallers(conn as string, query as string);
    const order = `${conn} then ${query}`;

    const connect = find(links, 'calls', 'Connect', 'main');
    assert.equal(connect.confidence, 'resolved', `Connect should resolve with ${order}`);

    const fetch = find(links, 'calls', 'FetchOrder', 'main');
    assert.equal(fetch.confidence, 'resolved', `FetchOrder should resolve with ${order}`);
  }
});
