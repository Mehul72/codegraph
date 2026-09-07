import type { Node } from 'web-tree-sitter';
import type { GraphNode } from '../types.js';
import { SymbolBuilder, emptyResult } from './builder.js';
import type { ExtractInput, Extractor } from './types.js';
import {
  endLineOf,
  field,
  fieldText,
  firstChildOfType,
  lineOf,
  looksLikeConstant,
  namedChildren,
  signatureOf,
  splitQualified,
  stringLiteralDoc,
} from './ast.js';
import { tablesInSql, unquote } from './sqlrefs.js';

/** Decorator attributes that mean "this function serves an HTTP route". */
const HTTP_DECORATORS = new Set(['route', 'get', 'post', 'put', 'patch', 'delete', 'head', 'options', 'websocket']);

export const pythonExtractor: Extractor = {
  id: 'python',
  extensions: ['.py', '.pyi'],
  grammar: 'tree-sitter-python.wasm',

  extract(input: ExtractInput) {
    const { tree, path: filePath, source, repo } = input;
    if (!tree?.rootNode) return emptyResult();

    const build = new SymbolBuilder(repo, filePath, 'python');
    const dotted = pythonModulePath(filePath);
    const moduleNode = build.module({
      name: dotted.split('.').pop() ?? dotted,
      qualified: dotted,
      lineEnd: endLineOf(tree.rootNode),
      doc: stringLiteralDoc(docstringNode(tree.rootNode)),
    });

    visitChildren(tree.rootNode, { build, moduleNode, owner: moduleNode, className: null, prefix: '' });
    return build.result();
  },

  modulePath(relPath: string) {
    return pythonModulePath(relPath);
  },

  /**
   * Python resolves imports against sys.path, which we cannot know. Register
   * every suffix of the dotted path so `from pkg.mod import x` matches whether
   * the file lives at pkg/mod.py or src/pkg/mod.py.
   */
  moduleAliases(relPath: string) {
    const full = pythonModulePath(relPath);
    const parts = full.split('.');
    const aliases: string[] = [];
    for (let i = 1; i < parts.length; i++) {
      aliases.push(parts.slice(i).join('.'));
    }
    return aliases;
  },
};

interface Scope {
  build: SymbolBuilder;
  moduleNode: GraphNode;
  /** Nearest enclosing symbol, which owns any reference we find. */
  owner: GraphNode;
  /** Set while we are inside a class body, for self.x resolution. */
  className: string | null;
  /** Dotted prefix for qualified names, empty at module level. */
  prefix: string;
}

function visitChildren(node: Node, scope: Scope): void {
  for (const child of namedChildren(node)) visitNode(child, scope);
}

function visitNode(node: Node, scope: Scope): void {
  switch (node.type) {
    case 'function_definition':
      defineFunction(node, scope, []);
      return;

    case 'class_definition':
      defineClass(node, scope, []);
      return;

    case 'decorated_definition': {
      const decorators = namedChildren(node).filter((c) => c.type === 'decorator');
      const inner = field(node, 'definition');
      if (!inner) return;
      if (inner.type === 'function_definition') defineFunction(inner, scope, decorators);
      else if (inner.type === 'class_definition') defineClass(inner, scope, decorators);
      return;
    }

    case 'import_statement':
      recordPlainImport(node, scope);
      return;

    case 'import_from_statement':
      recordFromImport(node, scope);
      return;

    case 'call':
      recordCall(node, scope);
      visitChildren(node, scope);
      return;

    case 'string':
    case 'concatenated_string':
      recordSqlStrings(node, scope);
      return;

    case 'assignment':
      recordAssignment(node, scope);
      return;

    default:
      visitChildren(node, scope);
      return;
  }
}

function defineFunction(node: Node, scope: Scope, decorators: readonly Node[]): void {
  const name = fieldText(node, 'name');
  if (!name) return;

  const qualified = scope.prefix ? `${scope.prefix}.${name}` : name;
  const symbol = scope.build.add({
    name,
    kind: scope.className ? 'method' : 'function',
    qualified,
    lineStart: lineOf(node),
    lineEnd: endLineOf(node),
    signature: signatureOf(node),
    doc: stringLiteralDoc(docstringNode(field(node, 'body'))),
    exported: isPublic(name),
  });

  scope.build.edge(scope.owner, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));

  for (const decorator of decorators) {
    recordDecorator(decorator, symbol, scope);
  }

  // Type annotations on parameters and the return type are real dependencies.
  const params = field(node, 'parameters');
  if (params) recordTypeRefs(params, symbol, scope);
  const returnType = field(node, 'return_type');
  if (returnType) recordTypeRefs(returnType, symbol, scope);

  const body = field(node, 'body');
  if (body) {
    visitChildren(body, { ...scope, owner: symbol, prefix: qualified, className: scope.className });
  }
}

function defineClass(node: Node, scope: Scope, decorators: readonly Node[]): void {
  const name = fieldText(node, 'name');
  if (!name) return;

  const qualified = scope.prefix ? `${scope.prefix}.${name}` : name;
  const symbol = scope.build.add({
    name,
    kind: 'class',
    qualified,
    lineStart: lineOf(node),
    lineEnd: endLineOf(node),
    signature: signatureOf(node),
    doc: stringLiteralDoc(docstringNode(field(node, 'body'))),
    exported: isPublic(name),
  });

  scope.build.edge(scope.owner, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));

  for (const decorator of decorators) {
    recordDecorator(decorator, symbol, scope);
  }

  const bases = field(node, 'superclasses');
  if (bases) {
    for (const base of namedChildren(bases)) {
      if (base.type === 'keyword_argument') continue;
      const { qualifier, name: baseName } = splitQualified(base.text);
      if (baseName && /^[A-Za-z_]\w*$/.test(baseName)) {
        scope.build.ref(symbol, 'inherits', baseName, lineOf(base), qualifier);
      }
    }
  }

  const body = field(node, 'body');
  if (body) {
    visitChildren(body, { ...scope, owner: symbol, prefix: qualified, className: name });
  }
}

function recordPlainImport(node: Node, scope: Scope): void {
  // import a.b.c            -> module a.b.c bound as a
  // import a.b.c as name    -> module a.b.c bound as name
  for (const child of namedChildren(node)) {
    if (child.type === 'dotted_name') {
      const module = child.text;
      scope.build.importEdge(scope.moduleNode, module, lineOf(node), { alias: module.split('.')[0] ?? module });
    } else if (child.type === 'aliased_import') {
      const module = fieldText(child, 'name');
      const alias = fieldText(child, 'alias');
      if (module) scope.build.importEdge(scope.moduleNode, module, lineOf(node), { alias: alias ?? module });
    }
  }
}

function recordFromImport(node: Node, scope: Scope): void {
  const moduleField = field(node, 'module_name');
  if (!moduleField) return;
  const module = moduleField.text;
  const line = lineOf(node);

  // `from . import x` and `from .mod import x` need the package directory,
  // which the resolver derives from the leading dots plus the importer path.
  const names = namedChildren(node).filter((c) => c.startIndex !== moduleField.startIndex);
  let sawName = false;

  for (const child of names) {
    if (child.type === 'dotted_name') {
      sawName = true;
      scope.build.importEdge(scope.moduleNode, module, line, { symbol: child.text, alias: child.text });
    } else if (child.type === 'aliased_import') {
      sawName = true;
      const symbol = fieldText(child, 'name');
      const alias = fieldText(child, 'alias');
      if (symbol) scope.build.importEdge(scope.moduleNode, module, line, { symbol, alias: alias ?? symbol });
    } else if (child.type === 'wildcard_import') {
      sawName = true;
      scope.build.importEdge(scope.moduleNode, module, line, { symbol: null, alias: null });
    }
  }

  if (!sawName) scope.build.importEdge(scope.moduleNode, module, line, {});
}

function recordCall(node: Node, scope: Scope): void {
  const target = field(node, 'function');
  if (!target) return;
  const line = lineOf(node);

  if (target.type === 'identifier') {
    scope.build.ref(scope.owner, 'calls', target.text, line);
    return;
  }

  if (target.type === 'attribute') {
    const attr = fieldText(target, 'attribute');
    const objectNode = field(target, 'object');
    if (!attr) return;
    const qualifier = objectNode ? objectNode.text : null;
    scope.build.ref(scope.owner, 'calls', attr, line, qualifier);
    return;
  }

  // Calls on subscripts or call results (foo()[0]() and friends) are not
  // worth guessing at, so we look no further than the expression itself.
}

function recordDecorator(decorator: Node, symbol: GraphNode, scope: Scope): void {
  const inner = namedChildren(decorator)[0];
  if (!inner) return;
  const line = lineOf(decorator);

  const callNode = inner.type === 'call' ? inner : null;
  const target = callNode ? field(callNode, 'function') : inner;
  if (!target) return;

  const { qualifier, name } = splitQualified(target.text);
  if (name && /^[A-Za-z_]\w*$/.test(name)) {
    scope.build.ref(symbol, 'references', name, line, qualifier);
  }

  if (callNode && name && HTTP_DECORATORS.has(name.toLowerCase())) {
    defineEndpoint(callNode, name, symbol, scope, line);
  }
}

/**
 * Turns @app.post("/orders") into an endpoint node pointing at the handler,
 * so "what serves POST /orders" and "what breaks if I change this handler"
 * are both one lookup.
 */
function defineEndpoint(callNode: Node, decoratorName: string, handler: GraphNode, scope: Scope, line: number): void {
  const args = field(callNode, 'arguments');
  if (!args) return;
  const first = namedChildren(args).find((a) => a.type === 'string' || a.type === 'concatenated_string');
  if (!first) return;

  const route = unquote(first.text).trim();
  if (!route.startsWith('/')) return;

  const method = decoratorName.toLowerCase() === 'route' ? httpMethodFromArgs(args) : decoratorName.toUpperCase();
  const endpoint = scope.build.add({
    name: `${method} ${route}`,
    kind: 'endpoint',
    qualified: `${method} ${route}`,
    lineStart: line,
    lineEnd: line,
    signature: `${method} ${route}`,
    doc: handler.doc,
  });
  scope.build.edge(scope.moduleNode, { kind: 'id', id: endpoint.id }, 'defines', line);
  scope.build.edge(endpoint, { kind: 'id', id: handler.id }, 'references', line);
}

function httpMethodFromArgs(args: Node): string {
  for (const arg of namedChildren(args)) {
    if (arg.type !== 'keyword_argument') continue;
    if (fieldText(arg, 'name') !== 'methods') continue;
    const value = field(arg, 'value');
    if (!value) continue;
    const methods = namedChildren(value)
      .filter((m) => m.type === 'string')
      .map((m) => unquote(m.text).toUpperCase());
    if (methods.length > 0) return methods.join('|');
  }
  return 'ANY';
}

function recordAssignment(node: Node, scope: Scope): void {
  const left = field(node, 'left');
  const right = field(node, 'right');

  // Module-level and class-level SCREAMING_CASE names are worth indexing.
  if (left?.type === 'identifier' && looksLikeConstant(left.text)) {
    const name = left.text;
    const qualified = scope.prefix ? `${scope.prefix}.${name}` : name;
    const symbol = scope.build.add({
      name,
      kind: 'constant',
      qualified,
      lineStart: lineOf(node),
      lineEnd: endLineOf(node),
      signature: signatureOf(node, ['right']).replace(/\s*=\s*$/, ''),
      doc: null,
      exported: isPublic(name),
    });
    scope.build.edge(scope.owner, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));
  }

  const annotation = field(node, 'type');
  if (annotation) recordTypeRefs(annotation, scope.owner, scope);

  if (left && left.type !== 'identifier') visitChildren(left, scope);
  if (right) visitNode(right, scope);
}

function recordSqlStrings(node: Node, scope: Scope): void {
  const text = unquote(node.text);
  for (const table of tablesInSql(text)) {
    scope.build.ref(scope.owner, 'queries', table, lineOf(node));
  }
}

/**
 * Pull identifiers out of a type annotation. Generic parameters count, since
 * `list[Order]` really does depend on Order.
 */
function recordTypeRefs(node: Node, owner: GraphNode, scope: Scope): void {
  const stack: Node[] = [node];
  while (stack.length > 0) {
    const current = stack.pop() as Node;
    if (current.type === 'identifier') {
      const name = current.text;
      if (/^[A-Z]/.test(name)) scope.build.ref(owner, 'references', name, lineOf(current));
      continue;
    }
    if (current.type === 'string') {
      // Forward references are written as strings: def f() -> "Order".
      const inner = unquote(current.text).trim();
      if (/^[A-Z]\w*$/.test(inner)) scope.build.ref(owner, 'references', inner, lineOf(current));
      continue;
    }
    for (const child of current.namedChildren) {
      if (child) stack.push(child);
    }
  }
}

/** The docstring is the first statement of a body, if it is a bare string. */
function docstringNode(body: Node | null): Node | null {
  if (!body) return null;
  const first = namedChildren(body)[0];
  if (!first) return null;
  if (first.type === 'expression_statement') {
    return firstChildOfType(first, 'string', 'concatenated_string');
  }
  if (first.type === 'string') return first;
  return null;
}

/** A single leading underscore means private by convention. Dunders do not. */
function isPublic(name: string): boolean {
  if (name.startsWith('__') && name.endsWith('__')) return true;
  return !name.startsWith('_');
}

export function pythonModulePath(relPath: string): string {
  let clean = relPath.replace(/\.pyi?$/, '');
  if (clean.endsWith('/__init__')) clean = clean.slice(0, -'/__init__'.length);
  if (clean === '__init__') clean = '';
  return clean.split('/').filter(Boolean).join('.');
}
