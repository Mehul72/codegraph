import { squash, truncate } from '../util/text.js';
import { SymbolBuilder, emptyResult } from './builder.js';
import { MAX_SIGNATURE, childrenOfType, endLineOf, field, fieldText, firstChildOfType, leadingCommentDoc, lineOf, looksLikeConstant, namedChildren, signatureOf, walk, } from './ast.js';
import { tablesInSql, unquote } from './sqlrefs.js';
/**
 * Go's predeclared type names. Nearly every signature mentions two or three of
 * them and none of them will ever be a node in the graph, so a reference edge
 * to `string` is volume without information.
 */
const PREDECLARED_TYPES = new Set([
    'any', 'bool', 'byte', 'comparable', 'complex64', 'complex128', 'error', 'float32', 'float64',
    'int', 'int8', 'int16', 'int32', 'int64', 'rune', 'string', 'uint', 'uint8', 'uint16', 'uint32',
    'uint64', 'uintptr',
]);
const NO_TYPE_PARAMS = new Set();
/** Guards the unwrapping loops against a cycle in a recovered tree. */
const MAX_UNWRAP_DEPTH = 16;
const PACKAGE_CLAUSE = /^[ \t]*package[ \t]+([A-Za-z_]\w*)/m;
export const goExtractor = {
    id: 'go',
    extensions: ['.go'],
    grammar: 'tree-sitter-go.wasm',
    extract(input) {
        const { tree, path: filePath, source, repo } = input;
        if (!tree?.rootNode)
            return emptyResult();
        const root = tree.rootNode;
        const build = new SymbolBuilder(repo, filePath, 'go');
        const importPath = goPackageDir(filePath);
        const clause = firstChildOfType(root, 'package_clause');
        const declared = clause ? firstChildOfType(clause, 'package_identifier')?.text : null;
        // A file whose package clause did not parse still gets a module node. The
        // directory name is the package name in all but a handful of Go packages.
        const fallbackName = importPath === '.' ? 'main' : importPath.slice(importPath.lastIndexOf('/') + 1);
        const moduleNode = build.module({
            name: declared || fallbackName,
            qualified: importPath,
            lineEnd: endLineOf(root),
            doc: clause ? leadingCommentDoc(clause, source) : null,
        });
        const file = { build, moduleNode, source, types: new Map(), methods: [] };
        try {
            for (const decl of namedChildren(root))
                visitTopLevel(decl, file);
            linkMethodsToReceivers(file);
        }
        catch {
            // Half a file is worth more than none, so a grammar surprise costs us
            // the rest of the traversal and nothing else.
        }
        return build.result();
    },
    /**
     * Go imports name a directory, not a file, so the directory is the only
     * sensible key. Files at the repo root belong to the root package.
     */
    modulePath(relPath) {
        return goPackageDir(relPath);
    },
    /**
     * An import path carries the module prefix from go.mod, which one file
     * cannot see. Registering the package name plus every suffix of the
     * directory lets the resolver match `github.com/acme/app/internal/store`
     * against `internal/store` without reading go.mod here.
     */
    moduleAliases(relPath, source) {
        const aliases = new Set();
        const packageName = packageNameFromSource(source);
        if (packageName)
            aliases.add(packageName);
        const dir = goPackageDir(relPath);
        if (dir !== '.') {
            const parts = dir.split('/').filter(Boolean);
            for (let i = 0; i < parts.length; i++)
                aliases.add(parts.slice(i).join('/'));
        }
        return [...aliases];
    },
};
function visitTopLevel(node, file) {
    switch (node.type) {
        case 'package_clause':
            return;
        case 'import_declaration':
            recordImports(node, file);
            return;
        case 'function_declaration':
            defineFunction(node, file);
            return;
        case 'method_declaration':
            defineMethod(node, file);
            return;
        case 'type_declaration':
            defineTypes(node, file);
            return;
        case 'const_declaration':
        case 'var_declaration':
            defineValues(node, file);
            return;
        default:
            // Comments and recovered ERROR nodes land here. An ERROR can still hold
            // a call or a query string, so it is scanned with the file as the owner.
            scanBody(node, file.moduleNode, file, NO_TYPE_PARAMS);
            return;
    }
}
function defineFunction(node, file) {
    const name = fieldText(node, 'name');
    if (!name)
        return;
    const symbol = file.build.add({
        name,
        kind: 'function',
        qualified: name,
        lineStart: lineOf(node),
        lineEnd: endLineOf(node),
        signature: signatureOf(node),
        doc: leadingCommentDoc(node, file.source),
        exported: isExported(name),
    });
    file.build.edge(file.moduleNode, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));
    const typeParams = typeParamNames(node);
    recordSignatureTypes(node, symbol, file, typeParams);
    const body = field(node, 'body');
    if (body)
        scanBody(body, symbol, file, typeParams);
}
function defineMethod(node, file) {
    const name = fieldText(node, 'name');
    if (!name)
        return;
    const receiver = receiverTypeName(field(node, 'receiver'));
    const symbol = file.build.add({
        name,
        kind: 'method',
        qualified: receiver ? `${receiver}.${name}` : name,
        lineStart: lineOf(node),
        lineEnd: endLineOf(node),
        signature: signatureOf(node),
        doc: leadingCommentDoc(node, file.source),
        exported: isExported(name),
    });
    // Methods are top level in Go, so the file defines them whether or not the
    // receiver type lives here.
    file.build.edge(file.moduleNode, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));
    if (receiver)
        file.methods.push({ receiver, method: symbol, line: lineOf(node) });
    const typeParams = typeParamNames(node);
    recordSignatureTypes(node, symbol, file, typeParams);
    const body = field(node, 'body');
    if (body)
        scanBody(body, symbol, file, typeParams);
}
/**
 * The second `defines` edge, from the receiver type to the method, is what
 * makes "what is on this struct" one lookup. We can only add it when the type
 * is declared in the same file, which is why it waits for the whole file.
 */
function linkMethodsToReceivers(file) {
    for (const pending of file.methods) {
        const owner = file.types.get(pending.receiver);
        if (!owner)
            continue;
        file.build.edge(owner, { kind: 'id', id: pending.method.id }, 'defines', pending.line);
    }
}
function defineTypes(node, file) {
    for (const spec of namedChildren(node)) {
        if (spec.type === 'type_spec' || spec.type === 'type_alias')
            defineType(spec, file);
    }
}
function defineType(spec, file) {
    const name = fieldText(spec, 'name');
    if (!name)
        return;
    const underlying = field(spec, 'type');
    const symbol = file.build.add({
        name,
        kind: kindOfType(underlying),
        qualified: name,
        lineStart: lineOf(spec),
        lineEnd: endLineOf(spec),
        signature: typeSignature(spec, underlying),
        doc: leadingCommentDoc(spec, file.source),
        exported: isExported(name),
    });
    file.build.edge(file.moduleNode, { kind: 'id', id: symbol.id }, 'defines', lineOf(spec));
    file.types.set(name, symbol);
    const typeParams = typeParamNames(spec);
    if (!underlying)
        return;
    if (underlying.type === 'struct_type')
        recordStructShape(underlying, symbol, file, typeParams);
    else if (underlying.type === 'interface_type')
        recordInterfaceShape(underlying, symbol, file, typeParams);
    else
        recordTypeRefs(underlying, symbol, file, typeParams);
}
/**
 * NodeKind has no member for a named non-struct type, so `type UserID string`
 * and `type Handler func(Ctx)` land on `struct`. It is the kind an agent looks
 * under when it asks about a named Go type, which beats dropping them.
 */
function kindOfType(underlying) {
    return underlying?.type === 'interface_type' ? 'interface' : 'struct';
}
function typeSignature(spec, underlying) {
    const name = fieldText(spec, 'name') ?? '';
    const params = fieldText(spec, 'type_parameters') ?? '';
    const assign = spec.type === 'type_alias' ? '= ' : '';
    return truncate(squash(`type ${name}${params} ${assign}${shapeLabel(underlying)}`), MAX_SIGNATURE);
}
/** Struct and interface bodies are replaced by the keyword, everything else reads fine as is. */
function shapeLabel(underlying) {
    if (!underlying)
        return '';
    if (underlying.type === 'struct_type')
        return 'struct';
    if (underlying.type === 'interface_type')
        return 'interface';
    return underlying.text;
}
function recordStructShape(struct, owner, file, typeParams) {
    const list = firstChildOfType(struct, 'field_declaration_list');
    if (!list)
        return;
    for (const decl of childrenOfType(list, 'field_declaration')) {
        const type = field(decl, 'type');
        if (!type)
            continue;
        // A field declaration with no name is an embedded type, which is how Go
        // spells composition. `inherits` says more than `references` would, so
        // the embedded name gets that edge and not both.
        if (!field(decl, 'name')) {
            const embedded = baseTypeRef(type);
            if (embedded)
                file.build.ref(owner, 'inherits', embedded.name, lineOf(decl), embedded.qualifier);
            continue;
        }
        recordTypeRefs(type, owner, file, typeParams);
    }
}
function recordInterfaceShape(iface, owner, file, typeParams) {
    for (const elem of namedChildren(iface)) {
        if (elem.type === 'method_elem') {
            defineInterfaceMethod(elem, owner, file, typeParams);
            continue;
        }
        if (elem.type !== 'type_elem')
            continue;
        // One name is an embedded interface. Two or more is a type set such as
        // `~int | ~float64`, which constrains a generic rather than composing.
        const parts = namedChildren(elem);
        if (parts.length !== 1)
            continue;
        const embedded = baseTypeRef(parts[0] ?? null);
        if (embedded)
            file.build.ref(owner, 'inherits', embedded.name, lineOf(elem), embedded.qualifier);
    }
}
function defineInterfaceMethod(elem, iface, file, typeParams) {
    const name = fieldText(elem, 'name');
    if (!name)
        return;
    const symbol = file.build.add({
        name,
        kind: 'method',
        qualified: `${iface.name}.${name}`,
        lineStart: lineOf(elem),
        lineEnd: endLineOf(elem),
        signature: signatureOf(elem),
        doc: leadingCommentDoc(elem, file.source),
        exported: isExported(name),
    });
    file.build.edge(iface, { kind: 'id', id: symbol.id }, 'defines', lineOf(elem));
    recordSignatureTypes(elem, symbol, file, typeParams);
}
/**
 * File-scope constants and variables. Anything unexported and not shouting is
 * an implementation detail, and function-local declarations never reach here
 * because bodies are scanned rather than dispatched.
 */
function defineValues(node, file) {
    const keyword = node.type === 'const_declaration' ? 'const' : 'var';
    const specType = `${keyword}_spec`;
    for (const spec of valueSpecs(node, specType)) {
        const declared = [];
        for (const nameNode of fieldNodes(spec, 'name')) {
            const name = nameNode.text;
            if (name === '_' || !(isExported(name) || looksLikeConstant(name)))
                continue;
            const symbol = file.build.add({
                name,
                kind: 'constant',
                qualified: name,
                lineStart: lineOf(spec),
                lineEnd: endLineOf(spec),
                signature: truncate(squash(`${keyword} ${spec.text}`), MAX_SIGNATURE),
                doc: leadingCommentDoc(spec, file.source),
                exported: isExported(name),
            });
            file.build.edge(file.moduleNode, { kind: 'id', id: symbol.id }, 'defines', lineOf(spec));
            declared.push(symbol);
        }
        // `a, b = f(), g()` is one spec with two names. The initialiser is scanned
        // once, against the first name we kept, or the file if we kept none.
        const owner = declared[0] ?? file.moduleNode;
        const type = field(spec, 'type');
        if (type)
            recordTypeRefs(type, owner, file, NO_TYPE_PARAMS);
        const value = field(spec, 'value');
        if (value)
            scanBody(value, owner, file, NO_TYPE_PARAMS);
    }
}
/** A parenthesized `var (...)` block wraps its specs in a list, `const (...)` does not. */
function valueSpecs(node, specType) {
    const specs = [];
    for (const child of namedChildren(node)) {
        if (child.type === specType)
            specs.push(child);
        else if (child.type === `${specType}_list`)
            specs.push(...childrenOfType(child, specType));
    }
    return specs;
}
function recordImports(node, file) {
    for (const spec of importSpecs(node)) {
        const pathNode = field(spec, 'path');
        if (!pathNode)
            continue;
        const module = unquote(pathNode.text);
        if (module === '')
            continue;
        // An unnamed import binds the last path segment. That is wrong for the
        // minority of packages whose name differs from their directory, and it is
        // the best a single file can do. `_` and `.` come through as themselves.
        const nameNode = field(spec, 'name');
        const alias = nameNode ? nameNode.text : module.split('/').pop() || module;
        file.build.importEdge(file.moduleNode, module, lineOf(spec), { alias });
    }
}
function importSpecs(node) {
    const specs = [];
    for (const child of namedChildren(node)) {
        if (child.type === 'import_spec')
            specs.push(child);
        else if (child.type === 'import_spec_list')
            specs.push(...childrenOfType(child, 'import_spec'));
    }
    return specs;
}
/**
 * Everything inside a body that is worth an edge: calls, the types named by
 * conversions and composite literals, and SQL hiding in string literals.
 */
function scanBody(root, owner, file, typeParams) {
    walk(root, (node) => {
        switch (node.type) {
            case 'call_expression':
                recordCall(node, owner, file);
                return true;
            case 'composite_literal':
            case 'type_assertion_expression':
            case 'type_conversion_expression': {
                const type = field(node, 'type');
                if (type)
                    recordTypeRefs(type, owner, file, typeParams);
                return true;
            }
            case 'interpreted_string_literal':
            case 'raw_string_literal':
                recordSqlStrings(node, owner, file);
                return false;
            default:
                return true;
        }
    });
}
function recordCall(node, owner, file) {
    const target = field(node, 'function');
    if (!target)
        return;
    const line = lineOf(node);
    if (target.type === 'identifier') {
        // A conversion is spelled like a call, and for a user defined type the two
        // are indistinguishable without type information. The predeclared names
        // are the ones we can be sure about, and they resolve to nothing anyway.
        if (!PREDECLARED_TYPES.has(target.text))
            file.build.ref(owner, 'calls', target.text, line);
        return;
    }
    if (target.type === 'selector_expression') {
        // Covers both `pkg.Foo()` and `x.Method()`. Which one it is depends on
        // whether the operand names an import, and only the resolver knows that.
        const name = fieldText(target, 'field');
        if (name)
            file.build.ref(owner, 'calls', name, line, callQualifier(field(target, 'operand')));
        return;
    }
    if (target.type === 'generic_type') {
        const instantiated = baseTypeRef(target);
        if (instantiated)
            file.build.ref(owner, 'calls', instantiated.name, line, instantiated.qualifier);
        return;
    }
    // `(*T)(v)` and calls on a call result parse as a call too. Neither has a
    // name we could hand to the resolver, so they are left alone.
}
/**
 * Only a dotted chain of plain names makes a useful qualifier, because the
 * resolver's job is to decide whether it is an import alias or a receiver.
 * `d.conn.QueryRow(q).Scan` answers nothing, so that ref goes out bare.
 */
function callQualifier(operand) {
    let current = operand;
    for (let depth = 0; current && depth < MAX_UNWRAP_DEPTH; depth++) {
        if (current.type === 'identifier')
            return operand?.text ?? null;
        if (current.type !== 'selector_expression')
            return null;
        current = field(current, 'operand');
    }
    return null;
}
function recordSqlStrings(node, owner, file) {
    const text = unquote(node.text);
    for (const table of tablesInSql(text)) {
        file.build.ref(owner, 'queries', table, lineOf(node));
    }
}
function recordSignatureTypes(node, owner, file, typeParams) {
    const params = field(node, 'parameters');
    if (params)
        recordTypeRefs(params, owner, file, typeParams);
    const result = field(node, 'result');
    if (result)
        recordTypeRefs(result, owner, file, typeParams);
}
/**
 * Reference every named type inside a type expression. Slices, maps, channels
 * and function types all nest, and `map[string][]*Order` really does depend
 * on Order.
 */
function recordTypeRefs(node, owner, file, typeParams) {
    walk(node, (current) => {
        if (current.type === 'qualified_type') {
            const name = fieldText(current, 'name');
            if (name)
                file.build.ref(owner, 'references', name, lineOf(current), fieldText(current, 'package'));
            return false;
        }
        if (current.type === 'type_identifier') {
            const name = current.text;
            const worthEdge = /^[A-Za-z]/.test(name) && !PREDECLARED_TYPES.has(name) && !typeParams.has(name);
            if (worthEdge)
                file.build.ref(owner, 'references', name, lineOf(current));
            return false;
        }
        return true;
    });
}
/**
 * Type parameters are scoped to one declaration and resolve to nothing, so
 * their names are collected and kept out of the reference edges.
 */
function typeParamNames(node) {
    const names = new Set();
    const list = field(node, 'type_parameters');
    if (list) {
        for (const decl of childrenOfType(list, 'type_parameter_declaration')) {
            for (const nameNode of fieldNodes(decl, 'name'))
                names.add(nameNode.text);
        }
    }
    // A method on a generic type repeats them in its receiver: (s *Set[T]).
    const receiver = field(node, 'receiver');
    if (receiver) {
        walk(receiver, (current) => {
            if (current.type !== 'type_arguments')
                return true;
            for (const elem of childrenOfType(current, 'type_elem')) {
                const inner = namedChildren(elem)[0];
                if (inner?.type === 'type_identifier')
                    names.add(inner.text);
            }
            return false;
        });
    }
    return names.size === 0 ? NO_TYPE_PARAMS : names;
}
function receiverTypeName(receiver) {
    if (!receiver)
        return null;
    const first = firstChildOfType(receiver, 'parameter_declaration');
    return baseTypeRef(first ? field(first, 'type') : null)?.name ?? null;
}
/** Peels pointers, parentheses and type arguments off a type to reach its name. */
function baseTypeRef(type) {
    let current = type;
    for (let depth = 0; current && depth < MAX_UNWRAP_DEPTH; depth++) {
        switch (current.type) {
            case 'type_identifier':
                return { qualifier: null, name: current.text };
            case 'qualified_type': {
                const name = fieldText(current, 'name');
                return name ? { qualifier: fieldText(current, 'package'), name } : null;
            }
            case 'generic_type':
                current = field(current, 'type');
                break;
            case 'pointer_type':
            case 'parenthesized_type':
                current = namedChildren(current)[0] ?? null;
                break;
            default:
                return null;
        }
    }
    return null;
}
/** Field names repeat on `var a, b = 1, 2`, where childForFieldName sees only the first. */
function fieldNodes(node, name) {
    const found = [];
    for (let i = 0; i < node.childCount; i++) {
        if (node.fieldNameForChild(i) !== name)
            continue;
        const child = node.child(i);
        if (child)
            found.push(child);
    }
    return found;
}
/** Go's own rule: an identifier is exported when it starts with an upper-case letter. */
function isExported(name) {
    return /^\p{Lu}/u.test(name);
}
/** Read without parsing, because moduleAliases runs before any tree exists. */
function packageNameFromSource(source) {
    return PACKAGE_CLAUSE.exec(source)?.[1] ?? null;
}
export function goPackageDir(relPath) {
    const normalized = relPath.replace(/\\/g, '/');
    const slash = normalized.lastIndexOf('/');
    return slash <= 0 ? '.' : normalized.slice(0, slash);
}
//# sourceMappingURL=go.js.map