/**
 * TypeScript, TSX and JavaScript are three grammars over one module system,
 * so they share one extraction pass. The grammars differ only in what they
 * add: JSX nodes for tsx, and no type syntax at all for javascript. Nothing
 * below branches on the language; it checks for the node types and fields
 * that may be absent instead.
 */

import type { Node } from 'web-tree-sitter';
import type { EdgeType, ExtractResult, GraphNode, NodeKind } from '../types.js';
import { SymbolBuilder, emptyResult } from './builder.js';
import type { ExtractInput, Extractor } from './types.js';
import {
  MAX_SIGNATURE,
  cleanDoc,
  endLineOf,
  field,
  fieldText,
  firstChildOfType,
  leadingCommentDoc,
  lineOf,
  looksLikeConstant,
  namedChildren,
  signatureOf,
  splitQualified,
  walk,
} from './ast.js';
import { tablesInSql, unquote } from './sqlrefs.js';
import { log } from '../util/log.js';
import { squash, truncate } from '../util/text.js';

/** Every extension the three grammars claim between them. */
const MODULE_EXTENSION = /\.[mc]?[jt]sx?$/;

/** Initializers that make a variable or a class field a callable symbol. */
const FUNCTION_VALUES = new Set(['arrow_function', 'function_expression', 'function', 'generator_function']);

/** Express style route registration: `app.get('/widgets/:id', handler)`. */
const ROUTE_METHODS = new Set(['get', 'post', 'put', 'patch', 'delete', 'all', 'use']);

/** The two registrars that do not name a verb. */
const ANY_ROUTE_METHODS = new Set(['all', 'use']);

const IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

function tsExtractor(id: string, extensions: string[], grammar: string): Extractor {
  return {
    id,
    extensions,
    grammar,
    extract(input: ExtractInput) {
      return extractModule(input, id);
    },
    modulePath(relPath: string) {
      return tsModulePath(relPath);
    },
    moduleAliases(relPath: string) {
      return tsModuleAliases(relPath);
    },
  };
}

export const typescriptExtractor = tsExtractor('typescript', ['.ts', '.mts', '.cts'], 'tree-sitter-typescript.wasm');
export const tsxExtractor = tsExtractor('tsx', ['.tsx'], 'tree-sitter-tsx.wasm');
export const javascriptExtractor = tsExtractor(
  'javascript',
  ['.js', '.mjs', '.cjs', '.jsx'],
  'tree-sitter-javascript.wasm',
);

function extractModule(input: ExtractInput, lang: string): ExtractResult {
  const { tree, path: filePath, source, repo } = input;
  if (!tree?.rootNode) return emptyResult();

  const root = tree.rootNode;
  const build = new SymbolBuilder(repo, filePath, lang);
  const modulePath = tsModulePath(filePath);
  const moduleNode = build.module({
    name: modulePath.split('/').pop() || modulePath,
    qualified: modulePath,
    lineEnd: endLineOf(root),
    doc: fileDoc(root, source),
  });

  const scope: Scope = {
    build,
    source,
    moduleNode,
    owner: moduleNode,
    prefix: '',
    moduleScope: true,
    reexported: publicNames(root),
    typeParams: new Set(),
  };

  try {
    visitChildren(root, scope);
  } catch (err) {
    log.debug(`${filePath}: extraction stopped early (${(err as Error).message})`);
  }
  return build.result();
}

interface Scope {
  build: SymbolBuilder;
  source: string;
  moduleNode: GraphNode;
  /** Nearest enclosing symbol, which owns any reference we find. */
  owner: GraphNode;
  /** Dotted prefix for qualified names, empty at module level. */
  prefix: string;
  /** False once we are inside a body, where locals are not worth indexing. */
  moduleScope: boolean;
  /** Local names that an export clause elsewhere in the file makes public. */
  reexported: ReadonlySet<string>;
  /** Type variables declared by the enclosing `<T, U>` clauses. */
  typeParams: ReadonlySet<string>;
}

function visitChildren(node: Node, scope: Scope): void {
  for (const child of namedChildren(node)) visitNode(child, scope);
}

function visitNode(node: Node, scope: Scope): void {
  switch (node.type) {
    case 'export_statement':
      recordExport(node, scope);
      return;

    case 'import_statement':
      recordImport(node, scope);
      return;

    case 'call_expression':
      recordCall(node, scope);
      visitChildren(node, scope);
      return;

    case 'new_expression':
      recordNew(node, scope);
      visitChildren(node, scope);
      return;

    case 'string':
      recordSqlStrings(node, scope);
      return;

    case 'template_string':
      recordSqlStrings(node, scope);
      // The interpolations are ordinary expressions and may contain calls.
      visitChildren(node, scope);
      return;

    default:
      if (!defineDeclaration(node, scope, false)) visitChildren(node, scope);
      return;
  }
}

/**
 * Handles every declaration form, returning false for anything that is not
 * one so the caller can keep walking. The bare and the `export`ed spelling
 * both come through here, which is where the exported flag is settled.
 */
function defineDeclaration(node: Node, scope: Scope, exported: boolean): boolean {
  switch (node.type) {
    case 'function_declaration':
    case 'generator_function_declaration':
      defineFunction(node, scope, exported);
      return true;

    case 'class_declaration':
    case 'abstract_class_declaration':
      defineClass(node, scope, exported);
      return true;

    case 'interface_declaration':
      defineInterface(node, scope, exported);
      return true;

    case 'type_alias_declaration':
      defineTypeAlias(node, scope, exported);
      return true;

    case 'enum_declaration':
      defineEnum(node, scope, exported);
      return true;

    case 'lexical_declaration':
    case 'variable_declaration':
      recordVariables(node, scope, exported);
      return true;

    default:
      return false;
  }
}

/**
 * The half every declaration has in common: a module-relative qualified name,
 * a doc line from the comment above it, and the `defines` edge from whatever
 * encloses it.
 */
function declareSymbol(
  node: Node,
  scope: Scope,
  spec: { name: string; qualified: string; kind: NodeKind; signature: string; exported: boolean },
): GraphNode {
  const symbol = scope.build.add({
    name: spec.name,
    kind: spec.kind,
    qualified: spec.qualified,
    lineStart: lineOf(node),
    lineEnd: endLineOf(node),
    signature: spec.signature,
    doc: leadingCommentDoc(node, scope.source),
    exported: spec.exported,
  });
  scope.build.edge(scope.owner, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));
  return symbol;
}

function defineFunction(node: Node, scope: Scope, exported: boolean, fallbackName?: string): void {
  const name = fieldText(node, 'name') ?? fallbackName;
  if (!name) return;

  const qualified = qualify(name, scope);
  const symbol = declareSymbol(node, scope, {
    name,
    qualified,
    kind: 'function',
    signature: signatureOf(node),
    exported: exported || isReexported(name, scope),
  });
  visitCallable(node, symbol, qualified, scope);
}

function defineClass(node: Node, scope: Scope, exported: boolean, fallbackName?: string): void {
  const name = fieldText(node, 'name') ?? fallbackName;
  if (!name) return;

  const qualified = qualify(name, scope);
  const symbol = declareSymbol(node, scope, {
    name,
    qualified,
    kind: 'class',
    signature: signatureOf(node),
    exported: exported || isReexported(name, scope),
  });

  const inner = withTypeParams(node, scope);
  recordHeritage(node, symbol, inner);
  const body = field(node, 'body');
  if (body) visitMembers(body, symbol, qualified, inner);
}

function defineInterface(node: Node, scope: Scope, exported: boolean): void {
  const name = fieldText(node, 'name');
  if (!name) return;

  const qualified = qualify(name, scope);
  const symbol = declareSymbol(node, scope, {
    name,
    qualified,
    kind: 'interface',
    signature: signatureOf(node),
    exported: exported || isReexported(name, scope),
  });

  const inner = withTypeParams(node, scope);
  // `interface X extends Y, Z` is one clause holding every base.
  const heritage = firstChildOfType(node, 'extends_type_clause');
  for (const base of heritage ? namedChildren(heritage) : []) {
    recordSuperType(base, symbol, 'inherits', inner);
  }

  const body = field(node, 'body');
  if (body) visitMembers(body, symbol, qualified, inner);
}

/** NodeKind has no separate type kind, so an alias is indexed as an interface. */
function defineTypeAlias(node: Node, scope: Scope, exported: boolean): void {
  const name = fieldText(node, 'name');
  if (!name) return;

  const symbol = declareSymbol(node, scope, {
    name,
    qualified: qualify(name, scope),
    kind: 'interface',
    // An alias has no body to leave out: the right hand side is the whole
    // declaration and it is what a reader wants to see.
    signature: signatureOf(node),
    exported: exported || isReexported(name, scope),
  });

  const value = field(node, 'value');
  if (value) recordTypeRefs(value, symbol, withTypeParams(node, scope));
}

/** An enum is a named set of values with a type, which is close enough to a class. */
function defineEnum(node: Node, scope: Scope, exported: boolean): void {
  const name = fieldText(node, 'name');
  if (!name) return;

  declareSymbol(node, scope, {
    name,
    qualified: qualify(name, scope),
    kind: 'class',
    signature: signatureOf(node),
    exported: exported || isReexported(name, scope),
  });
}

/**
 * Only module-scope variables become symbols, and only when they hold a
 * function or look like a constant. A local `const rows = ...` is noise no
 * other file can refer to, but its initializer still has to be walked for
 * calls, imports and embedded SQL.
 */
function recordVariables(node: Node, scope: Scope, exported: boolean): void {
  const keyword = fieldText(node, 'kind') ?? (node.type === 'variable_declaration' ? 'var' : 'const');

  for (const declarator of namedChildren(node)) {
    if (declarator.type !== 'variable_declarator') continue;

    const nameNode = field(declarator, 'name');
    const value = field(declarator, 'value');
    const annotation = field(declarator, 'type');
    // A destructuring pattern binds several names and none of them is a
    // symbol an edge could point at.
    const name = nameNode?.type === 'identifier' ? nameNode.text : null;
    const callable = value !== null && FUNCTION_VALUES.has(value.type);

    if (name === null || !scope.moduleScope || !(callable || looksLikeConstant(name))) {
      if (annotation) recordTypeRefs(annotation, scope.owner, scope);
      if (value) visitNode(value, scope);
      continue;
    }

    const qualified = qualify(name, scope);
    const symbol = declareSymbol(declarator, scope, {
      name,
      qualified,
      kind: callable ? 'function' : 'constant',
      signature: declaratorSignature(keyword, name, declarator, value),
      exported: exported || isReexported(name, scope),
    });

    if (annotation) recordTypeRefs(annotation, symbol, scope);
    if (!value) continue;
    if (callable) visitCallable(value, symbol, qualified, scope);
    else visitNode(value, { ...scope, owner: symbol });
  }
}

function recordExport(node: Node, scope: Scope): void {
  const source = field(node, 'source');
  if (source) {
    recordReexport(node, source, scope);
    return;
  }

  const declaration = field(node, 'declaration');
  if (declaration) {
    // A namespace or an ambient block is not a symbol we model, but the
    // declarations inside it are still exported.
    if (!defineDeclaration(declaration, scope, true)) visitChildren(declaration, scope);
    return;
  }

  // `export default <expression>`. A named function or class keeps its name;
  // an anonymous one is only ever imported as the module default.
  const value = field(node, 'value');
  if (!value) return;
  if (FUNCTION_VALUES.has(value.type)) defineFunction(value, scope, true, 'default');
  else if (value.type === 'class') defineClass(value, scope, true, 'default');
  else visitNode(value, scope);
}

function recordImport(node: Node, scope: Scope): void {
  const source = field(node, 'source');
  if (!source) return;

  const module = unquote(source.text);
  const line = lineOf(node);
  const clause = firstChildOfType(node, 'import_clause');
  let bound = false;

  for (const child of clause ? namedChildren(clause) : []) {
    if (child.type === 'identifier') {
      bound = true;
      scope.build.importEdge(scope.moduleNode, module, line, { symbol: 'default', alias: child.text });
      continue;
    }
    if (child.type === 'namespace_import') {
      // `import * as ns`: no single symbol, so the alias carries the binding.
      bound = true;
      const alias = namedChildren(child)[0];
      scope.build.importEdge(scope.moduleNode, module, line, { symbol: null, alias: alias?.text ?? null });
      continue;
    }
    if (child.type !== 'named_imports') continue;
    for (const spec of namedChildren(child)) {
      const symbol = spec.type === 'import_specifier' ? fieldText(spec, 'name') : null;
      if (!symbol) continue;
      bound = true;
      scope.build.importEdge(scope.moduleNode, module, line, { symbol, alias: fieldText(spec, 'alias') ?? symbol });
    }
  }

  // `import './setup'` binds nothing but still pulls the module in.
  if (!bound) scope.build.importEdge(scope.moduleNode, module, line, {});
}

/**
 * `export { a } from './m'` and `export * from './m'` are imports as far as
 * the dependency graph is concerned: this file cannot load without that one.
 */
function recordReexport(node: Node, source: Node, scope: Scope): void {
  const module = unquote(source.text);
  const line = lineOf(node);
  const clause = firstChildOfType(node, 'export_clause');
  let bound = false;

  for (const spec of clause ? namedChildren(clause) : []) {
    const symbol = spec.type === 'export_specifier' ? fieldText(spec, 'name') : null;
    if (!symbol) continue;
    bound = true;
    scope.build.importEdge(scope.moduleNode, module, line, { symbol, alias: fieldText(spec, 'alias') ?? symbol });
  }
  if (bound) return;

  const namespace = firstChildOfType(node, 'namespace_export');
  const alias = namespace ? namedChildren(namespace)[0] : null;
  scope.build.importEdge(scope.moduleNode, module, line, { symbol: null, alias: alias?.text ?? null });
}

function recordCall(node: Node, scope: Scope): void {
  const target = field(node, 'function');
  if (!target) return;
  const line = lineOf(node);

  const typeArgs = field(node, 'type_arguments');
  if (typeArgs) recordTypeRefs(typeArgs, scope.owner, scope);

  if (target.type === 'identifier') {
    // `require` is module syntax wearing a call's clothes, so it records an
    // import and nothing else.
    if (target.text === 'require') recordModuleArgument(node, scope, line);
    else scope.build.ref(scope.owner, 'calls', target.text, line);
    return;
  }

  if (target.type === 'import') {
    recordModuleArgument(node, scope, line);
    return;
  }

  if (target.type === 'member_expression') {
    const property = fieldText(target, 'property');
    if (!property) return;
    // The object field skips the `?.` token, so `a?.b()` reads like `a.b()`.
    const object = field(target, 'object');
    scope.build.ref(scope.owner, 'calls', property, line, object?.text ?? null);
    if (ROUTE_METHODS.has(property.toLowerCase())) defineEndpoint(node, property, scope, line);
    return;
  }

  // Calls on a subscript or on another call's result (foo()[0]()) are not
  // worth guessing at, so we look no further than the expression itself.
}

function recordNew(node: Node, scope: Scope): void {
  const typeArgs = field(node, 'type_arguments');
  if (typeArgs) recordTypeRefs(typeArgs, scope.owner, scope);

  const target = field(node, 'constructor');
  if (!target) return;
  const { qualifier, name } = splitQualified(target.text);
  if (IDENTIFIER.test(name)) scope.build.ref(scope.owner, 'calls', name, lineOf(node), qualifier);
}

/** `require('./m')` and dynamic `import('./m')`, when the path is a literal. */
function recordModuleArgument(node: Node, scope: Scope, line: number): void {
  const first = firstArgument(node);
  if (!first || (first.type !== 'string' && first.type !== 'template_string')) return;
  const module = unquote(first.text);
  // A computed path tells the resolver nothing it can match against.
  if (module.includes('${')) return;
  scope.build.importEdge(scope.moduleNode, module, line, {});
}

/**
 * Turns `router.post('/widgets', handler)` into an endpoint node pointing at
 * the enclosing symbol, so "what serves POST /widgets" and "what breaks if I
 * change this handler" are both one lookup. Named the same way as the
 * decorator form in the Python extractor.
 */
function defineEndpoint(callNode: Node, methodName: string, scope: Scope, line: number): void {
  const first = firstArgument(callNode);
  if (first?.type !== 'string') return;

  const route = unquote(first.text).trim();
  if (!route.startsWith('/')) return;

  const method = ANY_ROUTE_METHODS.has(methodName.toLowerCase()) ? 'ANY' : methodName.toUpperCase();
  const name = `${method} ${route}`;
  const endpoint = scope.build.add({
    name,
    kind: 'endpoint',
    qualified: name,
    lineStart: line,
    lineEnd: line,
    signature: name,
    // The handler's doc line describes the route; the module's would just be
    // the file header.
    doc: scope.owner === scope.moduleNode ? null : scope.owner.doc,
  });

  scope.build.edge(scope.moduleNode, { kind: 'id', id: endpoint.id }, 'defines', line);
  scope.build.edge(endpoint, { kind: 'id', id: scope.owner.id }, 'references', line);
}

function recordSqlStrings(node: Node, scope: Scope): void {
  for (const table of tablesInSql(unquote(node.text))) {
    scope.build.ref(scope.owner, 'queries', table, lineOf(node));
  }
}

/**
 * TypeScript wraps heritage in extends_clause and implements_clause nodes.
 * The JavaScript grammar has neither: class_heritage holds the base
 * expression directly, and there is nothing to implement.
 */
function recordHeritage(node: Node, symbol: GraphNode, scope: Scope): void {
  const heritage = firstChildOfType(node, 'class_heritage');
  if (!heritage) return;

  for (const child of namedChildren(heritage)) {
    if (child.type === 'implements_clause') {
      for (const base of namedChildren(child)) recordSuperType(base, symbol, 'implements', scope);
      continue;
    }
    if (child.type === 'extends_clause') {
      const value = field(child, 'value');
      for (const base of value ? [value] : namedChildren(child)) {
        recordSuperType(base, symbol, 'inherits', scope);
      }
      continue;
    }
    recordSuperType(child, symbol, 'inherits', scope);
  }
}

function recordSuperType(node: Node, symbol: GraphNode, type: EdgeType, scope: Scope): void {
  if (node.type === 'type_arguments') return;
  // `Base<T>` depends on Base; the argument list is not part of the name.
  const text = node.type === 'generic_type' ? (fieldText(node, 'name') ?? node.text) : node.text;
  const { qualifier, name } = splitQualified(text);
  if (IDENTIFIER.test(name)) scope.build.ref(symbol, type, name, lineOf(node), qualifier);
}

function visitMembers(body: Node, container: GraphNode, prefix: string, scope: Scope): void {
  const inner: Scope = { ...scope, owner: container, prefix, moduleScope: false };

  for (const member of namedChildren(body)) {
    switch (member.type) {
      case 'method_definition':
      case 'method_signature':
      case 'abstract_method_signature':
        defineMethod(member, inner);
        continue;

      case 'public_field_definition':
      case 'property_signature':
        recordMemberField(member, inner);
        continue;

      // Decorators are not modelled, and skipping them here keeps class level
      // and member level decorators consistent.
      case 'decorator':
        continue;

      default:
        // Index and call signatures, and static blocks: nothing to name, but
        // the types and the calls inside them belong to the container.
        recordTypeRefs(member, container, inner);
        visitNode(member, inner);
        continue;
    }
  }
}

function defineMethod(node: Node, scope: Scope): void {
  const name = memberName(node);
  if (!name) return;

  const qualified = qualify(name, scope);
  const symbol = declareSymbol(node, scope, {
    name,
    qualified,
    kind: 'method',
    signature: signatureOf(node),
    exported: scope.owner.exported && !isPrivateMember(node, name),
  });
  visitCallable(node, symbol, qualified, scope);
}

/**
 * A field holding a function is a method in everything but syntax, and that
 * is how bound handlers are written. Anything else is state: no symbol, but
 * its declared type and its initializer still matter.
 */
function recordMemberField(node: Node, scope: Scope): void {
  const name = memberName(node);
  const value = field(node, 'value');
  const annotation = field(node, 'type');
  const callable =
    (value !== null && FUNCTION_VALUES.has(value.type)) || (annotation !== null && holdsFunctionType(annotation));

  if (!name || !callable) {
    if (annotation) recordTypeRefs(annotation, scope.owner, scope);
    if (value) visitNode(value, scope);
    return;
  }

  const qualified = qualify(name, scope);
  const symbol = declareSymbol(node, scope, {
    name,
    qualified,
    kind: 'method',
    signature: value ? callableSignature(name, value) : signatureOf(node),
    exported: scope.owner.exported && !isPrivateMember(node, name),
  });

  if (annotation) recordTypeRefs(annotation, symbol, scope);
  if (value) visitCallable(value, symbol, qualified, scope);
}

/**
 * Walks the inside of anything callable: a declaration, a method, or the
 * arrow function a variable was assigned. The types in the signature are real
 * dependencies, and the body owns every reference found in it.
 */
function visitCallable(node: Node, symbol: GraphNode, qualified: string, scope: Scope): void {
  const inner: Scope = { ...withTypeParams(node, scope), owner: symbol, prefix: qualified, moduleScope: false };

  // A type parameter constraint (`<T extends Widget>`) is a dependency too.
  for (const part of ['type_parameters', 'parameters', 'return_type'] as const) {
    const child = field(node, part);
    if (child) recordTypeRefs(child, symbol, inner);
  }

  const body = field(node, 'body');
  if (body) visitNode(body, inner);
}

/**
 * Pulls type names out of an annotation. Only capital-initial names are worth
 * an edge: the built-ins arrive as their own node types, but a stray `id` or
 * `props` would otherwise become a reference to nothing. Generic arguments do
 * count, because `Promise<Widget>` really does depend on Widget.
 */
function recordTypeRefs(node: Node, owner: GraphNode, scope: Scope): void {
  walk(node, (current) => {
    if (current.type === 'nested_type_identifier') {
      // A qualified type: the module half becomes the qualifier, as for calls.
      const name = fieldText(current, 'name');
      if (name && /^[A-Z]/.test(name)) {
        scope.build.ref(owner, 'references', name, lineOf(current), fieldText(current, 'module'));
      }
      return false;
    }
    if (current.type !== 'type_identifier') return true;
    const name = current.text;
    if (/^[A-Z]/.test(name) && !scope.typeParams.has(name)) {
      scope.build.ref(owner, 'references', name, lineOf(current));
    }
    return false;
  });
}

/**
 * `<T, U>` binds names that exist only inside the declaration, so a later
 * `T[]` in a parameter is not a reference to anything the graph can resolve.
 * The names stay in scope for the members of a generic class.
 */
function withTypeParams(node: Node, scope: Scope): Scope {
  const params = field(node, 'type_parameters');
  if (!params) return scope;

  const names = new Set(scope.typeParams);
  for (const param of namedChildren(params)) {
    const name = fieldText(param, 'name');
    if (name) names.add(name);
  }
  return { ...scope, typeParams: names };
}

/**
 * The file header comment, which is as close as TypeScript gets to a module
 * docstring. A blank line has to follow it: without that gap the comment
 * belongs to whatever is declared underneath.
 */
function fileDoc(root: Node, source: string): string | null {
  const children = namedChildren(root);
  const header = children[0];
  if (header?.type !== 'comment' || header.startIndex !== 0) return null;

  const next = children[1];
  if (next && !/\n[ \t]*\n/.test(source.slice(header.endIndex, next.startIndex))) return null;
  return cleanDoc(stripCommentMarkers(header.text));
}

/** Reduces a `//` line or a block comment to its bare text. */
function stripCommentMarkers(text: string): string {
  return text
    .replace(/^\/\*+/, '')
    .replace(/\*+\/$/, '')
    .split('\n')
    .map((line) => line.trim().replace(/^(?:\/\/+|\*+)\s?/, ''))
    .filter((line) => line !== '')
    .join(' ');
}

/**
 * `export { a, b as c }` with no source makes earlier declarations public,
 * and so does the CommonJS spelling. Either can sit anywhere in the file, so
 * the names are collected up front.
 */
function publicNames(root: Node): ReadonlySet<string> {
  const names = new Set<string>();

  for (const child of namedChildren(root)) {
    if (child.type === 'expression_statement') {
      collectCommonJsExports(child, names);
      continue;
    }
    if (child.type !== 'export_statement' || field(child, 'source')) continue;

    const clause = firstChildOfType(child, 'export_clause');
    if (clause) {
      for (const spec of namedChildren(clause)) {
        const name = fieldText(spec, 'name');
        if (name) names.add(name);
      }
      continue;
    }

    // `export default local` and the CommonJS interop form `export = local`.
    const value = field(child, 'value') ?? firstChildOfType(child, 'identifier');
    if (value?.type === 'identifier') names.add(value.text);
  }
  return names;
}

/**
 * `module.exports = { a, b }` and `exports.c = c` are the public surface of a
 * CommonJS file, which is most of the JavaScript in an older repo.
 */
function collectCommonJsExports(statement: Node, names: Set<string>): void {
  const assignment = firstChildOfType(statement, 'assignment_expression');
  if (!assignment) return;
  const left = field(assignment, 'left');
  if (!left) return;

  if (left.text.startsWith('exports.')) {
    names.add(left.text.slice('exports.'.length));
    return;
  }
  if (left.text !== 'module.exports') return;

  const right = field(assignment, 'right');
  if (right?.type !== 'object') return;
  for (const property of namedChildren(right)) {
    if (property.type === 'shorthand_property_identifier') {
      names.add(property.text);
      continue;
    }
    const value = property.type === 'pair' ? field(property, 'value') : null;
    if (value?.type === 'identifier') names.add(value.text);
  }
}

function qualify(name: string, scope: Scope): string {
  return scope.prefix ? `${scope.prefix}.${name}` : name;
}

function isReexported(name: string, scope: Scope): boolean {
  return scope.moduleScope && scope.reexported.has(name);
}

function firstArgument(callNode: Node): Node | null {
  const args = field(callNode, 'arguments');
  // A tagged template puts a template_string where the argument list goes.
  if (args?.type !== 'arguments') return null;
  return namedChildren(args)[0] ?? null;
}

function memberName(node: Node): string | null {
  const nameNode = field(node, 'name');
  if (!nameNode) return null;
  // A computed key is an expression, not a name an edge could ever match.
  if (nameNode.type === 'computed_property_name') return null;
  return nameNode.text;
}

/**
 * `private` and `#name` members are not part of the public surface.
 * `protected` is, because a subclass in another module depends on it.
 */
function isPrivateMember(node: Node, name: string): boolean {
  if (name.startsWith('#')) return true;
  return firstChildOfType(node, 'accessibility_modifier')?.text === 'private';
}

function holdsFunctionType(annotation: Node): boolean {
  return namedChildren(annotation)[0]?.type === 'function_type';
}

/** `handler = (req, res) => ...`, with the body left out. */
function callableSignature(head: string, value: Node): string {
  return truncate(squash(`${head} = ${signatureOf(value)} ...`), MAX_SIGNATURE);
}

function declaratorSignature(keyword: string, name: string, declarator: Node, value: Node | null): string {
  if (value && FUNCTION_VALUES.has(value.type)) return callableSignature(`${keyword} ${name}`, value);
  // For a constant the value is the interesting part, so keep it.
  return truncate(squash(`${keyword} ${declarator.text}`), MAX_SIGNATURE);
}

export function tsModulePath(relPath: string): string {
  return relPath.replace(MODULE_EXTENSION, '');
}

/**
 * The other strings this file answers to. Relative imports are not resolved
 * here: only the importer's own path can do that, and the resolver has it.
 */
export function tsModuleAliases(relPath: string): string[] {
  const base = tsModulePath(relPath);
  const aliases = new Set<string>();

  // TypeScript is imported with the extension as written, and NodeNext code
  // imports a .ts file by the .js name it compiles to.
  aliases.add(relPath);
  aliases.add(`${base}.js`);

  if (base.endsWith('/index')) {
    const dir = base.slice(0, -'/index'.length);
    if (dir) aliases.add(dir);
  }

  aliases.delete(base);
  return [...aliases];
}
