import { squash } from '../util/text.js';
import { SymbolBuilder, emptyResult } from './builder.js';
import { childrenOfType, endLineOf, field, fieldText, firstChildOfType, leadingCommentDoc, lineOf, namedChildren, signatureOf, splitQualified, walk, } from './ast.js';
import { tablesInSql, unquote } from './sqlrefs.js';
/**
 * Java, where the package declaration and the import list say almost
 * everything. Resolution barely has to guess, so most of the work here is
 * mapping declaration kinds onto ours and keeping qualified names right
 * through nested types. Spring request mappings become endpoint nodes,
 * because a controller's routes are what people actually look for.
 */
/** Type declarations, and the node kind each one maps to. */
const TYPE_KINDS = {
    class_declaration: 'class',
    interface_declaration: 'interface',
    // An enum is a class with a closed instance set, and a record is a value
    // aggregate. Neither has its own kind, so they take the nearest one.
    enum_declaration: 'class',
    record_declaration: 'struct',
    // An annotation type is declared and implemented like an interface.
    annotation_type_declaration: 'interface',
};
/** Spring mapping annotations. null means the verb comes from an argument. */
const MAPPING_VERBS = {
    getmapping: 'GET',
    postmapping: 'POST',
    putmapping: 'PUT',
    patchmapping: 'PATCH',
    deletemapping: 'DELETE',
    requestmapping: null,
};
export const javaExtractor = {
    id: 'java',
    extensions: ['.java'],
    grammar: 'tree-sitter-java.wasm',
    extract(input) {
        const { tree, path: filePath, source, repo } = input;
        if (!tree?.rootNode)
            return emptyResult();
        const build = new SymbolBuilder(repo, filePath, 'java');
        const fileName = typeNameFromPath(filePath);
        const moduleNode = build.module({
            name: fileName,
            // The package lives here and only here. Symbols below stay
            // module-relative (`MyClass.myMethod`) and the resolver joins the two.
            qualified: packageOf(tree.rootNode) ?? fileName,
            lineEnd: endLineOf(tree.rootNode),
        });
        visitChildren(tree.rootNode, {
            build,
            moduleNode,
            source,
            owner: moduleNode,
            prefix: '',
            inInterface: false,
            typeVars: new Set(),
            basePath: '',
        });
        return build.result();
    },
    modulePath(relPath, source) {
        return packageFromSource(source) ?? typeNameFromPath(relPath);
    },
    /**
     * A Java import names a type, not a file, so `com.acme.store.UserRepository`
     * has to match the file that declares UserRepository. The language requires
     * the public type to be named after the file, which is what makes the second
     * alias derivable without reading the tree.
     */
    moduleAliases(relPath, source) {
        const typeName = typeNameFromPath(relPath);
        const pkg = packageFromSource(source);
        return pkg ? [pkg, `${pkg}.${typeName}`] : [typeName];
    },
};
function visitChildren(node, scope) {
    for (const child of namedChildren(node))
        visitNode(child, scope);
}
function visitNode(node, scope) {
    switch (node.type) {
        case 'class_declaration':
        case 'interface_declaration':
        case 'enum_declaration':
        case 'record_declaration':
        case 'annotation_type_declaration':
            defineType(node, scope);
            return;
        case 'method_declaration':
            defineMethod(node, scope);
            return;
        case 'constructor_declaration':
        case 'compact_constructor_declaration':
            defineConstructor(node, scope);
            return;
        // Interface fields get their own node type and are static final by rule.
        case 'field_declaration':
        case 'constant_declaration':
            defineField(node, scope);
            return;
        case 'import_declaration':
            recordImport(node, scope);
            return;
        case 'method_invocation':
            recordCall(node, scope);
            visitChildren(node, scope);
            return;
        case 'object_creation_expression':
            recordConstruction(node, scope);
            visitChildren(node, scope);
            return;
        case 'string_literal':
            recordSqlStrings(node, scope.owner, scope);
            return;
        case 'package_declaration':
            return;
        default:
            visitChildren(node, scope);
            return;
    }
}
function defineType(node, scope) {
    const name = fieldText(node, 'name');
    if (!name)
        return;
    const qualified = scope.prefix ? `${scope.prefix}.${name}` : name;
    const symbol = scope.build.add({
        name,
        kind: TYPE_KINDS[node.type] ?? 'class',
        qualified,
        lineStart: lineOf(node),
        lineEnd: endLineOf(node),
        signature: declarationSignature(node),
        doc: leadingCommentDoc(node, scope.source),
        exported: isExported(node, scope),
    });
    scope.build.edge(scope.owner, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));
    const typeParams = firstChildOfType(node, 'type_parameters');
    const ownRoute = classRoutePrefix(node);
    const inner = {
        ...scope,
        owner: symbol,
        prefix: qualified,
        inInterface: node.type === 'interface_declaration' || node.type === 'annotation_type_declaration',
        typeVars: typeParams ? withTypeVars(scope.typeVars, typeParams) : scope.typeVars,
        basePath: ownRoute === '' ? scope.basePath : joinPath(scope.basePath, ownRoute),
    };
    recordAnnotationRefs(node, symbol, inner);
    // Bounds are references even though the variable they bind is not.
    if (typeParams)
        recordTypeRefs(typeParams, symbol, inner);
    const superclass = field(node, 'superclass');
    if (superclass)
        recordSupertypes(superclass, symbol, inner, 'inherits');
    const implemented = field(node, 'interfaces');
    if (implemented)
        recordSupertypes(implemented, symbol, inner, 'implements');
    // `interface X extends Y` is inheritance, and the grammar gives it a node of
    // its own with no field name rather than reusing `superclass`.
    const extended = firstChildOfType(node, 'extends_interfaces');
    if (extended)
        recordSupertypes(extended, symbol, inner, 'inherits');
    // Record components are parameters and field types at the same time.
    const components = field(node, 'parameters');
    if (components)
        recordTypeRefs(components, symbol, inner);
    const body = field(node, 'body');
    if (body)
        visitChildren(body, inner);
}
function defineMethod(node, scope) {
    const name = fieldText(node, 'name');
    if (!name)
        return;
    const qualified = scope.prefix ? `${scope.prefix}.${name}` : name;
    const typeParams = firstChildOfType(node, 'type_parameters');
    const inner = {
        ...scope,
        typeVars: typeParams ? withTypeVars(scope.typeVars, typeParams) : scope.typeVars,
    };
    const symbol = scope.build.add({
        name,
        kind: 'method',
        qualified,
        lineStart: lineOf(node),
        lineEnd: endLineOf(node),
        signature: declarationSignature(node),
        doc: leadingCommentDoc(node, scope.source),
        exported: isExported(node, scope),
    });
    scope.build.edge(scope.owner, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));
    recordAnnotationRefs(node, symbol, inner);
    defineEndpoints(node, symbol, inner);
    recordMemberTypes(node, symbol, inner);
    const body = field(node, 'body');
    if (body)
        visitChildren(body, { ...inner, owner: symbol, prefix: qualified });
}
function defineConstructor(node, scope) {
    const name = fieldText(node, 'name');
    if (!name)
        return;
    // The prefix is already the class, so this comes out as `Class.Class`.
    const qualified = scope.prefix ? `${scope.prefix}.${name}` : name;
    const symbol = scope.build.add({
        name,
        kind: 'method',
        qualified,
        lineStart: lineOf(node),
        lineEnd: endLineOf(node),
        signature: declarationSignature(node),
        doc: leadingCommentDoc(node, scope.source),
        exported: isExported(node, scope),
    });
    scope.build.edge(scope.owner, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));
    recordAnnotationRefs(node, symbol, scope);
    recordMemberTypes(node, symbol, scope);
    const body = field(node, 'body');
    if (body)
        visitChildren(body, { ...scope, owner: symbol, prefix: qualified });
}
/** Return type, parameters and thrown exceptions, which read the same way. */
function recordMemberTypes(node, symbol, scope) {
    const typeParams = firstChildOfType(node, 'type_parameters');
    if (typeParams)
        recordTypeRefs(typeParams, symbol, scope);
    const returnType = field(node, 'type');
    if (returnType)
        recordTypeRefs(returnType, symbol, scope);
    const params = field(node, 'parameters');
    if (params)
        recordTypeRefs(params, symbol, scope);
    const thrown = firstChildOfType(node, 'throws');
    if (thrown)
        recordTypeRefs(thrown, symbol, scope);
}
function defineField(node, scope) {
    const mods = modifiersOf(node);
    const isConstant = node.type === 'constant_declaration' || (mods.has('static') && mods.has('final'));
    // An instance field is not worth a node of its own, but the type it names is
    // a real dependency of the class that declares it.
    const type = field(node, 'type');
    if (type)
        recordTypeRefs(type, scope.owner, scope);
    recordAnnotationRefs(node, scope.owner, scope);
    for (const declarator of childrenOfType(node, 'variable_declarator')) {
        const name = fieldText(declarator, 'name');
        let owner = scope.owner;
        if (name && isConstant) {
            const symbol = scope.build.add({
                name,
                kind: 'constant',
                qualified: scope.prefix ? `${scope.prefix}.${name}` : name,
                lineStart: lineOf(node),
                lineEnd: endLineOf(node),
                signature: declarationSignature(node),
                doc: leadingCommentDoc(node, scope.source),
                exported: isExported(node, scope),
            });
            scope.build.edge(scope.owner, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));
            owner = symbol;
        }
        // The initializer is where a DAO keeps its SQL, so it belongs to the
        // constant rather than to the class around it.
        const value = field(declarator, 'value');
        if (value)
            visitNode(value, { ...scope, owner });
    }
}
/**
 * Java imports name a type: `com.acme.store.UserRepository` is the package
 * plus the type. A static import is the same shape one level down
 * (`com.acme.Util.helper`), so splitting off the last segment covers both and
 * the `static` keyword needs no special case.
 */
function recordImport(node, scope) {
    const target = firstChildOfType(node, 'scoped_identifier', 'identifier');
    if (!target)
        return;
    const line = lineOf(node);
    // `import com.acme.store.*` keeps the whole path as the module and binds no
    // single name, which is the one case where the last segment is not a type.
    if (firstChildOfType(node, 'asterisk')) {
        scope.build.importEdge(scope.moduleNode, target.text, line, { symbol: null, alias: null });
        return;
    }
    const { qualifier, name } = splitQualified(target.text);
    if (!qualifier) {
        scope.build.importEdge(scope.moduleNode, name, line, {});
        return;
    }
    scope.build.importEdge(scope.moduleNode, qualifier, line, { symbol: name, alias: name });
}
function recordCall(node, scope) {
    const name = fieldText(node, 'name');
    if (!name)
        return;
    const receiver = field(node, 'object');
    // A chained call has a whole expression as its receiver, which resolution
    // cannot match to a type. Squashing keeps it to one line either way.
    scope.build.ref(scope.owner, 'calls', name, lineOf(node), receiver ? squash(receiver.text) : null);
}
/** `new Foo()` runs a constructor, so it is a call on the type name. */
function recordConstruction(node, scope) {
    const type = field(node, 'type');
    if (!type)
        return;
    scope.build.ref(scope.owner, 'calls', baseTypeName(type), lineOf(node));
}
function recordSupertypes(node, symbol, scope, type) {
    // A class lists its interfaces inside a type_list, a superclass stands alone.
    const list = firstChildOfType(node, 'type_list');
    for (const entry of namedChildren(list ?? node)) {
        const name = baseTypeName(entry);
        if (name === '' || !/^[A-Z]/.test(name) || scope.typeVars.has(name))
            continue;
        scope.build.ref(symbol, type, name, lineOf(entry));
        // Type arguments on a supertype are ordinary references: Comparable<Base>.
        const args = firstChildOfType(entry, 'type_arguments');
        if (args)
            recordTypeRefs(args, symbol, scope);
    }
}
function recordAnnotationRefs(node, owner, scope) {
    for (const annotation of annotationsOf(node)) {
        const name = annotationName(annotation);
        if (name !== '')
            scope.build.ref(owner, 'references', name, lineOf(annotation));
        // Spring Data keeps real queries in @Query, so annotation arguments are
        // worth the same SQL scan as a string constant.
        const args = field(annotation, 'arguments');
        if (args) {
            walk(args, (child) => {
                if (child.type === 'string_literal')
                    recordSqlStrings(child, owner, scope);
            });
        }
    }
}
/**
 * Turns @GetMapping("/{id}") on a controller method into an endpoint node
 * pointing at the handler, with the class level @RequestMapping prefixed, so
 * "what serves GET /api/orders/{id}" is a single lookup.
 */
function defineEndpoints(node, handler, scope) {
    for (const annotation of annotationsOf(node)) {
        const verb = MAPPING_VERBS[annotationName(annotation).toLowerCase()];
        if (verb === undefined)
            continue;
        const args = field(annotation, 'arguments');
        const line = lineOf(annotation);
        const route = joinPath(scope.basePath, args ? routeFromArgs(args) : '');
        const method = verb ?? (args ? methodFromArgs(args) : 'ANY');
        const name = `${method} ${route}`;
        const endpoint = scope.build.add({
            name,
            kind: 'endpoint',
            qualified: name,
            lineStart: line,
            lineEnd: line,
            signature: name,
            doc: handler.doc,
        });
        scope.build.edge(scope.moduleNode, { kind: 'id', id: endpoint.id }, 'defines', line);
        scope.build.edge(endpoint, { kind: 'id', id: handler.id }, 'references', line);
    }
}
/** The class level @RequestMapping("/base") that every handler inherits. */
function classRoutePrefix(node) {
    for (const annotation of annotationsOf(node)) {
        if (annotationName(annotation).toLowerCase() !== 'requestmapping')
            continue;
        const args = field(annotation, 'arguments');
        if (args)
            return routeFromArgs(args);
    }
    return '';
}
/**
 * Spring takes the path three ways: @GetMapping("/x"), @GetMapping(value =
 * "/x") and @GetMapping({"/x", "/y"}). Multiple paths on one handler collapse
 * to the first, since one endpoint node per handler is what stays readable.
 */
function routeFromArgs(args) {
    for (const arg of namedChildren(args)) {
        if (arg.type === 'element_value_pair') {
            const key = fieldText(arg, 'key');
            if (key !== 'value' && key !== 'path')
                continue;
            const value = field(arg, 'value');
            const route = value ? firstStringIn(value) : null;
            if (route !== null)
                return route;
            continue;
        }
        const route = firstStringIn(arg);
        if (route !== null)
            return route;
    }
    return '';
}
/** @RequestMapping(method = RequestMethod.GET), including the array form. */
function methodFromArgs(args) {
    for (const arg of namedChildren(args)) {
        if (arg.type !== 'element_value_pair' || fieldText(arg, 'key') !== 'method')
            continue;
        const value = field(arg, 'value');
        if (!value)
            continue;
        const accesses = value.type === 'field_access' ? [value] : childrenOfType(value, 'field_access');
        const verbs = accesses.map((access) => fieldText(access, 'field') ?? '').filter((verb) => verb !== '');
        if (verbs.length > 0)
            return verbs.join('|');
    }
    return 'ANY';
}
function firstStringIn(node) {
    if (node.type === 'string_literal')
        return unquote(node.text).trim();
    const nested = firstChildOfType(node, 'string_literal');
    return nested ? unquote(nested.text).trim() : null;
}
/** Spring accepts "x" as well as "/x", and "/base/" as well as "/base". */
function joinPath(base, route) {
    const parts = [base, route].flatMap((part) => part.split('/')).filter((part) => part !== '');
    return `/${parts.join('/')}`;
}
function recordSqlStrings(node, owner, scope) {
    // A text block is a string_literal too, so this covers """ ... """ queries.
    const text = unquote(node.text);
    for (const table of tablesInSql(text)) {
        scope.build.ref(owner, 'queries', table, lineOf(node));
    }
}
/**
 * Named types inside a type expression, generic arguments included, because
 * `List<Order>` really does depend on Order. Lower-case identifiers are
 * package segments of a qualified name or primitives, and type variables are
 * declared rather than referenced, so neither is a reference.
 */
function recordTypeRefs(node, owner, scope) {
    walk(node, (current) => {
        if (current.type !== 'type_identifier')
            return;
        const name = current.text;
        if (!/^[A-Z]/.test(name) || scope.typeVars.has(name))
            return;
        scope.build.ref(owner, 'references', name, lineOf(current));
    });
}
/** `java.util.Map.Entry<String, Order>` -> `Entry`. */
function baseTypeName(node) {
    const head = /^[\w$.]+/.exec(squash(node.text));
    return head ? splitQualified(head[0]).name : '';
}
/**
 * Java visibility is explicit, with one exception: interface members carry no
 * modifiers and are public by rule, so the enclosing declaration decides.
 * Protected counts as exported, since a subclass in another file can see it.
 */
function isExported(node, scope) {
    const mods = modifiersOf(node);
    if (mods.has('private'))
        return false;
    if (mods.has('public') || mods.has('protected'))
        return true;
    return scope.inInterface;
}
/**
 * Keyword modifiers are the anonymous children of `modifiers`; annotations are
 * the named ones. Reading the node text instead would let an annotation called
 * @Public pass for the keyword.
 */
function modifiersOf(node) {
    const found = new Set();
    const mods = firstChildOfType(node, 'modifiers');
    if (!mods)
        return found;
    for (const child of mods.children) {
        if (child && !child.isNamed)
            found.add(child.type);
    }
    return found;
}
function annotationsOf(node) {
    const mods = firstChildOfType(node, 'modifiers');
    return mods ? childrenOfType(mods, 'annotation', 'marker_annotation') : [];
}
/** Annotations can be written out in full: @org.junit.jupiter.api.Test. */
function annotationName(annotation) {
    const name = field(annotation, 'name');
    return name ? splitQualified(name.text).name : '';
}
/**
 * Type variables in scope. Without this, `<T> T pick(List<T> in)` records a
 * reference to a type named T that no file anywhere declares.
 */
function withTypeVars(current, typeParams) {
    const next = new Set(current);
    for (const param of childrenOfType(typeParams, 'type_parameter')) {
        const name = firstChildOfType(param, 'type_identifier');
        if (name)
            next.add(name.text);
    }
    return next;
}
/** Declarations with no body keep their semicolon in the raw text. */
function declarationSignature(node) {
    return signatureOf(node).replace(/;$/, '');
}
function packageOf(root) {
    const declaration = firstChildOfType(root, 'package_declaration');
    if (!declaration)
        return null;
    const name = firstChildOfType(declaration, 'scoped_identifier', 'identifier');
    return name ? name.text : null;
}
const PACKAGE_DECLARATION = /^[ \t]*package\s+([\w$]+(?:\s*\.\s*[\w$]+)*)\s*;/m;
/** Resolution needs the package before the file is parsed, hence the regex. */
function packageFromSource(source) {
    const match = PACKAGE_DECLARATION.exec(source);
    return match?.[1] ? match[1].replace(/\s+/g, '') : null;
}
/** The language requires Store.java to declare Store, so the name is the path. */
function typeNameFromPath(relPath) {
    const file = relPath.split('/').pop() ?? relPath;
    return file.replace(/\.java$/i, '');
}
//# sourceMappingURL=java.js.map