import { squash, truncate } from '../util/text.js';
import { SymbolBuilder, emptyResult } from './builder.js';
import { MAX_SIGNATURE, childrenOfType, endLineOf, field, fieldText, firstChildOfType, leadingCommentDoc, lineOf, namedChildren, walk, } from './ast.js';
import { tablesInSql, unquote } from './sqlrefs.js';
/**
 * Swift, where the unit of scope is a whole build target: every file in a
 * module sees every other one without an import, and `import Foo` brings in
 * all of Foo. Two things follow. Extensions spread one type over many files,
 * so a member is qualified by the type it extends rather than by the file it
 * sits in. And a name that matches somewhere in the module proves very little,
 * so a method call is recorded against its receiver's declared type, and not
 * recorded at all when the source never says what that type is.
 */
/** Declarations that get a type node, and the kind each one maps to. */
const TYPE_KINDS = {
    class: 'class',
    struct: 'struct',
    protocol: 'interface',
    // An actor is a class with isolated state and an enum is a closed set of
    // values with methods. Neither has a kind of its own, so both take class.
    actor: 'class',
    enum: 'class',
};
/**
 * Standard library names that fill nearly every signature and resolve to
 * nothing in any repo, so an edge to them is volume without information.
 */
const BUILTIN_TYPES = new Set([
    'Any', 'AnyObject', 'Array', 'Bool', 'CaseIterable', 'Character', 'Codable', 'Comparable',
    'CustomStringConvertible', 'Decodable', 'Dictionary', 'Double', 'Encodable', 'Equatable', 'Error', 'Float',
    'Hashable', 'Identifiable', 'Int', 'Int8', 'Int16', 'Int32', 'Int64', 'MainActor', 'Never', 'Optional', 'Self',
    'Sendable', 'Set', 'String', 'Substring', 'UInt', 'UInt8', 'UInt16', 'UInt32', 'UInt64', 'Void',
]);
/** Free functions from the standard library, called everywhere and declared in no repo. */
const BUILTIN_FUNCTIONS = new Set([
    'abs', 'assert', 'assertionFailure', 'debugPrint', 'dump', 'fatalError', 'max', 'min', 'precondition',
    'preconditionFailure', 'print', 'stride', 'swap', 'type', 'zip',
]);
/** SwiftPM's source directories. The directory under one is a target, and a target is a module. */
const TARGET_ROOTS = new Set(['Sources', 'Source', 'Tests']);
/** Where a declaration's body starts, which is where its signature stops. */
const BODY_TYPES = new Set([
    'class_body',
    'computed_property',
    'enum_class_body',
    'function_body',
    'protocol_body',
    'willset_didset_block',
]);
/** `Order.Type` is the metatype of Order, and Order is the type it names. */
const METATYPE_SUFFIXES = new Set(['Type', 'Protocol']);
/** Guards the receiver walk against a pathological chain of member accesses. */
const MAX_CHAIN_DEPTH = 16;
/** `try await`, `try? await` and `try! await`, except as the head of a `for` loop. See prepareSource. */
const TRY_AWAIT = /(?<!\bfor\s+)(\btry[?!]?\s+)await\b/g;
/** Swift comments start with `//`. A line starting with `#` is `#if` or `#warning`, which is code. */
const LINE_COMMENT = /^\/\/+\s?/;
const NO_VARIABLES = new Map();
export const swiftExtractor = {
    id: 'swift',
    extensions: ['.swift'],
    grammar: 'tree-sitter-swift.wasm',
    /**
     * The 0.7.3 grammar reads the block after `if let x = try await f()` as a
     * trailing closure and turns the rest of the file into one ERROR node,
     * losing every type in it. Upstream fixed this after that release
     * (alex-pinkus/tree-sitter-swift#598, #611). `await` carries nothing the
     * graph uses, so it is blanked out after `try`, keeping every offset.
     * `for try await x in` is a loop over an async sequence, which parses
     * fine and would not parse without its await.
     */
    prepareSource(source) {
        return source.replace(TRY_AWAIT, (_match, tryKeyword) => tryKeyword + ' '.repeat('await'.length));
    },
    extract(input) {
        const { tree, path: filePath, source, repo } = input;
        if (!tree?.rootNode)
            return emptyResult();
        const root = tree.rootNode;
        const build = new SymbolBuilder(repo, filePath, 'swift');
        const moduleNode = build.module({
            name: fileStem(filePath),
            // The module lives here and only here, as the package does for Java.
            // Symbols below are qualified from their outermost type down.
            qualified: swiftModuleOf(filePath),
            lineEnd: endLineOf(root),
        });
        const importedModules = importedModuleNames(root);
        const file = {
            build,
            moduleNode,
            source,
            importedModules,
            propertyTypes: collectPropertyTypes(root, importedModules),
            declaredTypes: new Map(),
            extensionMembers: [],
            extensionConformances: [],
        };
        visitDeclarations(root, {
            file,
            owner: moduleNode,
            typeName: null,
            extensionOf: null,
            exportedByDefault: false,
            typeParams: new Set(),
            variables: file.propertyTypes.get('') ?? NO_VARIABLES,
        });
        linkExtensions(file);
        return build.result();
    },
    /** Swift imports name a module, and a module is a whole target, so that is the only key. */
    modulePath(relPath) {
        return swiftModuleOf(relPath);
    },
};
function visitDeclarations(container, scope) {
    for (const node of namedChildren(container))
        visitDeclaration(node, scope);
}
function visitDeclaration(node, scope) {
    switch (node.type) {
        case 'import_declaration':
            recordImport(node, scope);
            return;
        case 'class_declaration':
            if (declarationKind(node) === 'extension')
                defineExtension(node, scope);
            else
                defineType(node, scope);
            return;
        case 'protocol_declaration':
            defineType(node, scope);
            return;
        case 'function_declaration':
        case 'protocol_function_declaration':
            defineFunction(node, fieldText(node, 'name'), scope);
            return;
        case 'init_declaration':
            defineFunction(node, 'init', scope);
            return;
        case 'deinit_declaration':
            defineFunction(node, 'deinit', scope);
            return;
        case 'subscript_declaration':
            defineFunction(node, 'subscript', scope);
            return;
        case 'property_declaration':
            defineProperty(node, scope);
            return;
        case 'typealias_declaration':
            defineTypeAlias(node, scope);
            return;
        default:
            // Top-level statements, enum cases, property requirements and recovered
            // ERROR nodes all hold references, which belong to whatever encloses them.
            scan(node, scope);
            return;
    }
}
/** A class, struct, enum, actor or protocol. Extensions are defineExtension's. */
function defineType(node, scope) {
    const name = fieldText(node, 'name');
    if (!name)
        return;
    const keyword = declarationKind(node);
    const symbol = defineSymbol(node, scope, { name, kind: TYPE_KINDS[keyword] ?? 'class' });
    const typeName = symbol.qualified ?? name;
    scope.file.declaredTypes.set(typeName, symbol);
    const body = field(node, 'body');
    const isProtocol = keyword === 'protocol';
    const inner = {
        ...scope,
        owner: symbol,
        typeName,
        extensionOf: null,
        // A requirement takes its protocol's access level. Any other member is
        // internal unless it says otherwise, however public its type is.
        exportedByDefault: isProtocol && symbol.exported,
        typeParams: withTypeParams(scope.typeParams, node, isProtocol && body ? associatedTypeNames(body) : []),
        variables: variablesOf(scope.file, typeName),
    };
    recordAttributes(node, symbol, inner);
    recordConformances(node, inner, (ref, index, line) => {
        scope.file.build.ref(symbol, conformanceEdge(keyword, index), ref.name, line, ref.qualifier);
    });
    recordGenericConstraints(node, inner);
    if (body)
        visitDeclarations(body, inner);
}
/**
 * An extension adds members to a type that may be declared in another file,
 * or in another module altogether. Its members are qualified by that type,
 * defined by this file, and linked to the type as well when it is declared
 * here, which linkExtensions does once the whole file has been seen.
 */
function defineExtension(node, scope) {
    const extended = field(node, 'name');
    const typeName = extended ? typeChainName(extended, scope.file.importedModules) : null;
    if (!typeName)
        return;
    const level = accessLevel(node);
    const inner = {
        ...scope,
        owner: scope.file.moduleNode,
        typeName,
        extensionOf: typeName,
        // `public extension` makes its members public unless they say otherwise.
        exportedByDefault: level === 'public' || level === 'open',
        typeParams: withTypeParams(scope.typeParams, node),
        variables: variablesOf(scope.file, typeName),
    };
    recordAttributes(node, scope.file.moduleNode, inner);
    recordConformances(node, inner, (ref, _index, line) => {
        scope.file.extensionConformances.push({ typeName, name: ref.name, qualifier: ref.qualifier, line });
    });
    recordGenericConstraints(node, inner);
    const body = field(node, 'body');
    if (body)
        visitDeclarations(body, inner);
}
/**
 * Functions, methods, initializers, deinitializers and subscripts, which all
 * have parameters, maybe a result type, and maybe a body.
 */
function defineFunction(node, name, scope) {
    if (!name)
        return;
    const symbol = defineSymbol(node, scope, { name, kind: scope.typeName ? 'method' : 'function' });
    const body = namedChildren(node).find((child) => BODY_TYPES.has(child.type)) ?? null;
    const inner = {
        ...scope,
        owner: symbol,
        typeParams: withTypeParams(scope.typeParams, node),
        variables: withLocals(scope, node, body),
    };
    recordAttributes(node, symbol, inner);
    // Parameter and result types, generic constraints, the thrown type and
    // default values, which can call things too. The body is found by type,
    // since tree-sitter hands out a fresh wrapper object on every access.
    for (const part of namedChildren(node)) {
        if (part.type !== 'modifiers' && !BODY_TYPES.has(part.type))
            scan(part, inner);
    }
    if (body)
        scan(body, inner);
}
/**
 * A `let` or `var`. Only some of them become symbols: a computed property is
 * a getter, so it becomes a function or method, and a top-level or static
 * `let` is a constant. A stored property is not worth a node of its own, but
 * its type and initial value are dependencies of the type that holds it.
 */
function defineProperty(node, scope) {
    const isConstant = mutability(node) === 'let' && (scope.typeName === null || isStatic(node));
    const symbols = [];
    for (const binding of propertyBindings(node)) {
        if (binding.getter) {
            const symbol = defineSymbol(node, scope, { name: binding.name, kind: scope.typeName ? 'method' : 'function' });
            symbols.push(symbol);
            const getterScope = { ...scope, owner: symbol, variables: withLocals(scope, node, binding.getter) };
            scanAll([binding.type, binding.getter], getterScope);
        }
        else if (isConstant) {
            const symbol = defineSymbol(node, scope, { name: binding.name, kind: 'constant' });
            symbols.push(symbol);
            scanAll([binding.type, binding.value], { ...scope, owner: symbol });
        }
        else {
            scanAll([binding.type, binding.value, binding.observers], scope);
        }
    }
    // A property wrapper or a global actor applies to the declaration as a whole.
    recordAttributes(node, symbols[0] ?? scope.owner, scope);
}
function defineTypeAlias(node, scope) {
    // The grammar labels both the new name and the aliased type `name`.
    const [nameNode, ...aliased] = fieldNodes(node, 'name');
    if (!nameNode)
        return;
    // No node kind means "a name for another type". TypeScript files its
    // aliases under interface, and Swift follows it.
    const symbol = defineSymbol(node, scope, { name: nameNode.text, kind: 'interface' });
    const inner = { ...scope, owner: symbol, typeParams: withTypeParams(scope.typeParams, node) };
    scanAll(aliased, inner);
}
/**
 * The part every declaration shares: a node qualified by its enclosing type,
 * and the `defines` edge from whatever holds it. Inside an extension that is
 * the file, and the extended type is linked up later.
 */
function defineSymbol(node, scope, spec) {
    const { build } = scope.file;
    const symbol = build.add({
        name: spec.name,
        kind: spec.kind,
        qualified: scope.typeName ? `${scope.typeName}.${spec.name}` : spec.name,
        lineStart: lineOf(node),
        lineEnd: endLineOf(node),
        signature: headerSignature(node),
        doc: leadingCommentDoc(node, scope.file.source, LINE_COMMENT),
        exported: isExported(node, scope),
    });
    build.edge(scope.owner, { kind: 'id', id: symbol.id }, 'defines', lineOf(node));
    if (scope.extensionOf) {
        scope.file.extensionMembers.push({ typeName: scope.extensionOf, member: symbol, line: lineOf(node) });
    }
    return symbol;
}
/**
 * Members of an extension are defined by the file, since that is where they
 * live, and by the extended type too when this file declares it, which makes
 * "what is on this type" one lookup. A conformance goes on the type when it is
 * here and on the file otherwise, so that changing the protocol still reaches
 * the file that promised to satisfy it.
 */
function linkExtensions(file) {
    for (const pending of file.extensionMembers) {
        const type = file.declaredTypes.get(pending.typeName);
        if (type)
            file.build.edge(type, { kind: 'id', id: pending.member.id }, 'defines', pending.line);
    }
    for (const pending of file.extensionConformances) {
        const owner = file.declaredTypes.get(pending.typeName) ?? file.moduleNode;
        file.build.ref(owner, 'implements', pending.name, pending.line, pending.qualifier);
    }
}
/**
 * Only a class has a superclass, and Swift requires it to come first in the
 * list. Without knowing what the first name is, a class's first entry is taken
 * as the superclass and the rest as protocols. A protocol refines the
 * protocols it lists, which is inheritance.
 */
function conformanceEdge(keyword, index) {
    if (keyword === 'protocol')
        return 'inherits';
    return keyword === 'class' && index === 0 ? 'inherits' : 'implements';
}
function recordConformances(node, scope, record) {
    childrenOfType(node, 'inheritance_specifier').forEach((spec, index) => {
        const type = field(spec, 'inherits_from');
        if (!type)
            return;
        const ref = typeRefOf(type, scope);
        if (ref)
            record(ref, index, lineOf(spec));
        // Generic arguments on a supertype are ordinary references: Repository<Order>.
        for (const args of childrenOfType(type, 'type_arguments'))
            scan(args, scope);
    });
}
/** Constraints in `<T: OrderStore>` and in a where clause are dependencies of the declaration. */
function recordGenericConstraints(node, scope) {
    scanAll([firstChildOfType(node, 'type_parameters'), firstChildOfType(node, 'type_constraints')], scope);
}
/**
 * Capitalised attributes are types: property wrappers, global actors and
 * macros. The lower-case ones (@objc, @available, @discardableResult) belong
 * to the compiler.
 */
function recordAttributes(node, owner, scope) {
    const modifiers = firstChildOfType(node, 'modifiers');
    if (!modifiers)
        return;
    for (const attribute of childrenOfType(modifiers, 'attribute')) {
        const type = firstChildOfType(attribute, 'user_type');
        const ref = type ? typeRefOf(type, scope) : null;
        if (ref && isTypeLike(ref.name)) {
            scope.file.build.ref(owner, 'references', ref.name, lineOf(attribute), ref.qualifier);
        }
    }
}
/**
 * One edge per import, from the file, binding the module's name for qualified
 * access. `import struct Foo.Bar` narrows the import to one declaration, and it
 * is recorded as an import of Foo, which is the most a module import can say.
 */
function recordImport(node, scope) {
    const module = importedModule(node);
    if (module)
        scope.file.build.importEdge(scope.file.moduleNode, module, lineOf(node), { alias: module });
}
function scanAll(nodes, scope) {
    for (const node of nodes) {
        if (node)
            scan(node, scope);
    }
}
/**
 * Everything worth an edge inside an expression or a signature: calls, the
 * types it names, and SQL in string literals. Declarations nested in a body
 * are not symbols of their own, so what they refer to belongs to the owner.
 */
function scan(root, scope) {
    walk(root, (node) => {
        switch (node.type) {
            case 'call_expression':
                recordCall(node, scope);
                return true;
            case 'constructor_expression':
                recordConstruction(node, scope);
                // The constructed type is a call, not also a reference, but its
                // generic arguments and the call's arguments are scanned as usual.
                for (const part of namedChildren(node)) {
                    if (part.type === 'user_type')
                        scanAll(childrenOfType(part, 'type_arguments'), scope);
                    else
                        scan(part, scope);
                }
                return false;
            case 'user_type':
                recordTypeRef(node, scope);
                return true;
            case 'navigation_expression':
                recordMetatypeRef(node, scope);
                return true;
            case 'line_string_literal':
            case 'multi_line_string_literal':
            case 'raw_string_literal':
                recordSqlStrings(node, scope);
                // Interpolations are code, and can hold calls.
                return true;
            case 'attribute':
                // Attributes are recorded with the declaration they decorate.
                return false;
            default:
                return true;
        }
    });
}
function recordCall(node, scope) {
    const callee = namedChildren(node)[0];
    if (!callee)
        return;
    const line = lineOf(node);
    if (callee.type === 'simple_identifier') {
        const name = callee.text;
        // A variable in scope holds a closure, a generic parameter is not a type
        // that exists anywhere, and the standard library is declared in no repo.
        const skip = scope.variables.has(name) || scope.typeParams.has(name) || BUILTIN_FUNCTIONS.has(name) || BUILTIN_TYPES.has(name);
        if (!skip)
            scope.file.build.ref(scope.owner, 'calls', name, line);
        return;
    }
    // `.make()` and a call on a closure or on another call's result name
    // nothing resolution could check, so only member calls go further.
    if (callee.type !== 'navigation_expression')
        return;
    const name = memberName(callee);
    const target = field(callee, 'target');
    if (!name || !target)
        return;
    if (name === 'init') {
        // `Order.init(...)` builds an Order exactly as `Order(...)` does. A
        // delegating self.init or super.init names no type of its own.
        const type = typeNamedBy(target, scope.file.importedModules);
        if (type)
            recordTypeCall(type, line, scope);
        return;
    }
    // A method on a receiver of unknown type would match every method of that
    // name in the module, and that is a guess rather than an answer.
    const receiver = receiverType(target, scope, 0);
    if (receiver !== null)
        scope.file.build.ref(scope.owner, 'calls', name, line, receiver);
}
/** `Box<Int>(value: 1)` is how a generic type is built. */
function recordConstruction(node, scope) {
    const type = field(node, 'constructed_type');
    const typeName = type ? typeChainName(type, scope.file.importedModules) : null;
    if (typeName)
        recordTypeCall(typeName, lineOf(node), scope);
}
/** Running an initializer is a call on the type, as Java records `new Foo()`. */
function recordTypeCall(typeName, line, scope) {
    const cut = typeName.lastIndexOf('.');
    const name = typeName.slice(cut + 1);
    const qualifier = cut === -1 ? null : typeName.slice(0, cut);
    if (qualifier === null && (BUILTIN_TYPES.has(name) || scope.typeParams.has(name)))
        return;
    scope.file.build.ref(scope.owner, 'calls', name, line, qualifier);
}
function recordTypeRef(node, scope) {
    const ref = typeRefOf(node, scope);
    if (ref)
        scope.file.build.ref(scope.owner, 'references', ref.name, lineOf(node), ref.qualifier);
}
/** `decoder.decode(Order.self, ...)` depends on Order as surely as a signature naming it does. */
function recordMetatypeRef(node, scope) {
    if (memberName(node) !== 'self')
        return;
    const target = field(node, 'target');
    const chain = target ? typeCallChain(target, 0) : null;
    const head = chain?.[0];
    const name = chain?.[chain.length - 1];
    if (!chain || !head || !name || BUILTIN_TYPES.has(head) || scope.typeParams.has(head))
        return;
    const qualifier = chain.length > 1 ? chain.slice(0, -1).join('.') : null;
    scope.file.build.ref(scope.owner, 'references', name, lineOf(node), qualifier);
}
function recordSqlStrings(node, scope) {
    for (const table of tablesInSql(literalText(node.text))) {
        scope.file.build.ref(scope.owner, 'queries', table, lineOf(node));
    }
}
/** A raw string wraps its quotes in hashes: #"..."#. */
function literalText(literal) {
    return unquote(literal.trim().replace(/^#+/, '').replace(/#+$/, ''));
}
/**
 * What a method call's receiver is known to be: 'self', 'super', or the name
 * of a type or module. Null means the source never says, which is the case
 * for most chains through call results, and the call is then not recorded.
 */
function receiverType(node, scope, depth) {
    if (depth >= MAX_CHAIN_DEPTH)
        return null;
    switch (node.type) {
        case 'self_expression':
            return 'self';
        case 'super_expression':
            return 'super';
        case 'simple_identifier':
            return namedReceiverType(node.text, scope);
        case 'postfix_expression': {
            // `store!.save()` calls the same method as `store.save()`.
            const target = field(node, 'target');
            return target ? receiverType(target, scope, depth + 1) : null;
        }
        case 'navigation_expression':
            return memberReceiverType(node, scope, depth);
        case 'call_expression':
        case 'constructor_expression':
            // `Order(...).pay()` is a method on the Order just built.
            return constructionType(node, scope.file.importedModules);
        default:
            return null;
    }
}
function namedReceiverType(name, scope) {
    // `Self` is the enclosing type, which resolution treats just like self.
    if (name === 'Self')
        return 'self';
    if (scope.variables.has(name))
        return scope.variables.get(name) ?? null;
    // Nothing in scope has this name, so a capitalised one is a type or a module.
    return isTypeLike(name) ? name : null;
}
/** `self.store`, `order.customer` and `Store.shared`, through properties declared in this file. */
function memberReceiverType(node, scope, depth) {
    const member = memberName(node);
    const target = field(node, 'target');
    if (!member || !target)
        return null;
    const base = receiverType(target, scope, depth + 1);
    if (base === null || base === 'super')
        return null;
    const holder = base === 'self' ? scope.typeName : base;
    if (!holder)
        return null;
    const declared = scope.file.propertyTypes.get(holder)?.get(member);
    if (declared)
        return declared;
    // `Order.Status` is a nested type, and `Store.Order` a type in a module.
    return base !== 'self' && isTypeLike(member) ? `${base}.${member}` : null;
}
/** The type an expression builds: `Order(...)`, `Order.init(...)` or `Box<Int>(...)`, even behind try or await. */
function constructionType(node, modules) {
    let current = node;
    for (let depth = 0; current && depth < MAX_CHAIN_DEPTH; depth++) {
        switch (current.type) {
            case 'try_expression':
            case 'await_expression':
                current = field(current, 'expr');
                break;
            case 'constructor_expression': {
                const type = field(current, 'constructed_type');
                return type ? typeChainName(type, modules) : null;
            }
            case 'call_expression': {
                const callee = namedChildren(current)[0];
                return callee ? typeNamedBy(callee, modules) : null;
            }
            default:
                return null;
        }
    }
    return null;
}
/** A callee that names a type: `Order`, `Order.init` or `Order.Line`, without the module. */
function typeNamedBy(callee, modules) {
    const chain = typeCallChain(callee, 0);
    if (!chain)
        return null;
    if (chain.length > 1 && modules.has(chain[0]))
        chain.shift();
    return chain.join('.');
}
function typeCallChain(node, depth) {
    if (depth >= MAX_CHAIN_DEPTH)
        return null;
    if (node.type === 'simple_identifier')
        return isTypeLike(node.text) ? [node.text] : null;
    if (node.type !== 'navigation_expression')
        return null;
    const member = memberName(node);
    const target = field(node, 'target');
    const base = member && target ? typeCallChain(target, depth + 1) : null;
    if (!member || !base)
        return null;
    if (member === 'init')
        return base;
    return isTypeLike(member) ? [...base, member] : null;
}
function memberName(navigation) {
    const suffix = field(navigation, 'suffix');
    const name = suffix ? field(suffix, 'suffix') : null;
    return name?.type === 'simple_identifier' ? name.text : null;
}
/**
 * A named type as a reference: the last name in the chain, qualified by the
 * rest, so `Order.Status` can resolve to the nested type and `Store.Order` to
 * a type in module Store. Standard library types and generic parameters are
 * left out.
 */
function typeRefOf(node, scope) {
    if (node.type !== 'user_type')
        return null;
    const chain = typeChain(node);
    const head = chain[0];
    const name = chain[chain.length - 1];
    if (!head || !name || BUILTIN_TYPES.has(head) || scope.typeParams.has(head))
        return null;
    return { name, qualifier: chain.length > 1 ? chain.slice(0, -1).join('.') : null };
}
/** The dotted name of a user type, without its generic arguments or a metatype suffix. */
function typeChain(type) {
    const chain = childrenOfType(type, 'type_identifier').map((part) => part.text);
    if (chain.length > 1 && METATYPE_SUFFIXES.has(chain[chain.length - 1]))
        chain.pop();
    return chain;
}
/** A user type's name as this file's module would qualify it: `Store.Order` is Order. */
function typeChainName(type, modules) {
    const chain = typeChain(type);
    if (chain.length > 1 && modules.has(chain[0]))
        chain.shift();
    return chain.length > 0 ? chain.join('.') : null;
}
/**
 * The type whose methods a variable of this declared type calls. `Order?`,
 * `Order!`, `some Order` and `any Order` all call Order's. Collections,
 * tuples and closures call nothing declared in the repo.
 */
function declaredTypeName(type, modules) {
    let current = type;
    for (let depth = 0; current && depth < MAX_CHAIN_DEPTH; depth++) {
        switch (current.type) {
            case 'user_type':
                return typeChainName(current, modules);
            case 'optional_type':
                current = field(current, 'wrapped');
                break;
            case 'opaque_type':
            case 'existential_type':
                current = firstChildOfType(current, 'user_type');
                break;
            default:
                return null;
        }
    }
    return null;
}
/** The type of a binding: what it is annotated with, or what its initial value builds. */
function bindingType(binding, modules) {
    if (binding.type)
        return declaredTypeName(binding.type, modules);
    return binding.value ? constructionType(binding.value, modules) : null;
}
/**
 * The bindings of one `let` or `var`. `let a = 1, b: Int = 2` repeats the
 * name, annotation and value fields, so they are paired up in order.
 */
function propertyBindings(decl) {
    const bindings = [];
    let current = null;
    for (let i = 0; i < decl.childCount; i++) {
        const child = decl.child(i);
        if (!child)
            continue;
        const fieldName = decl.fieldNameForChild(i);
        if (fieldName === 'name') {
            // A tuple pattern binds no single name, and nothing after it is kept.
            const bound = field(child, 'bound_identifier');
            current = bound ? { name: bound.text, type: null, value: null, getter: null, observers: null } : null;
            if (current)
                bindings.push(current);
            continue;
        }
        if (!current)
            continue;
        if (child.type === 'type_annotation')
            current.type = field(child, 'name');
        else if (fieldName === 'value')
            current.value = child;
        else if (fieldName === 'computed_value')
            current.getter = child;
        else if (child.type === 'willset_didset_block')
            current.observers = child;
    }
    return bindings;
}
/**
 * Property types for every type declared in this file, and for its top-level
 * variables under ''. Extensions add to the type they extend. A name declared
 * twice with different types is marked unknown rather than guessed at.
 */
function collectPropertyTypes(root, modules) {
    const byType = new Map();
    const collect = (container, typeName) => {
        let declared = byType.get(typeName);
        if (!declared) {
            declared = new Map();
            byType.set(typeName, declared);
        }
        for (const member of namedChildren(container)) {
            if (member.type === 'property_declaration' || member.type === 'protocol_property_declaration') {
                for (const binding of propertyBindings(member)) {
                    addVariable(declared, binding.name, bindingType(binding, modules));
                }
                continue;
            }
            if (member.type !== 'class_declaration' && member.type !== 'protocol_declaration')
                continue;
            const nestedName = nestedTypeName(member, typeName, modules);
            const body = field(member, 'body');
            if (nestedName && body)
                collect(body, nestedName);
        }
    };
    collect(root, '');
    return byType;
}
function nestedTypeName(decl, outer, modules) {
    if (declarationKind(decl) === 'extension') {
        const extended = field(decl, 'name');
        return extended ? typeChainName(extended, modules) : null;
    }
    const name = fieldText(decl, 'name');
    if (!name)
        return null;
    return outer === '' ? name : `${outer}.${name}`;
}
/** A type's own properties over the file's top-level variables. */
function variablesOf(file, typeName) {
    const globals = file.propertyTypes.get('') ?? NO_VARIABLES;
    const own = file.propertyTypes.get(typeName);
    if (!own || own.size === 0)
        return globals;
    return new Map([...globals, ...own]);
}
/**
 * Variables visible inside a function: its parameters, and every local `let`
 * and `var` in its body, which shadow properties of the same name. Branches
 * are not told apart, so a local bound to two different types is unknown.
 */
function withLocals(scope, declaration, body) {
    const variables = new Map(scope.variables);
    for (const param of childrenOfType(declaration, 'parameter')) {
        // The internal name and the type are both labelled `name` here.
        const [nameNode, typeNode] = fieldNodes(param, 'name');
        if (nameNode)
            variables.set(nameNode.text, declaredTypeName(typeNode ?? null, scope.file.importedModules));
    }
    if (!body)
        return variables;
    const locals = new Map();
    walk(body, (node) => {
        if (node.type !== 'property_declaration')
            return true;
        for (const binding of propertyBindings(node)) {
            addVariable(locals, binding.name, bindingType(binding, scope.file.importedModules));
        }
        return true;
    });
    for (const [name, type] of locals)
        variables.set(name, type);
    return variables;
}
function addVariable(variables, name, type) {
    if (variables.has(name) && variables.get(name) !== type)
        variables.set(name, null);
    else
        variables.set(name, type);
}
/** Generic parameters declared on `node`, plus any extra names, added to those already in scope. */
function withTypeParams(current, node, extra = []) {
    const params = firstChildOfType(node, 'type_parameters');
    const declared = params
        ? childrenOfType(params, 'type_parameter').flatMap((param) => {
            const name = firstChildOfType(param, 'type_identifier');
            return name ? [name.text] : [];
        })
        : [];
    if (declared.length === 0 && extra.length === 0)
        return current;
    return new Set([...current, ...declared, ...extra]);
}
/** A protocol's associated types work like generic parameters inside it. */
function associatedTypeNames(body) {
    return childrenOfType(body, 'associatedtype_declaration').flatMap((decl) => {
        const name = fieldText(decl, 'name');
        return name ? [name] : [];
    });
}
function importedModuleNames(root) {
    const names = new Set();
    for (const decl of childrenOfType(root, 'import_declaration')) {
        const module = importedModule(decl);
        if (module)
            names.add(module);
    }
    return names;
}
/** `import Foo`, `import struct Foo.Bar` and `@testable import Foo` all bring in module Foo. */
function importedModule(decl) {
    const path = firstChildOfType(decl, 'identifier');
    const head = path ? namedChildren(path)[0] : null;
    return head?.text ?? null;
}
/**
 * Exported means visible outside the module, which in Swift takes `public`
 * or `open`. A declaration that names no level gets its container's default:
 * internal almost everywhere, but the protocol's own level for a requirement
 * and the extension's for a member of `public extension`.
 */
function isExported(node, scope) {
    const level = accessLevel(node);
    if (level === null)
        return scope.exportedByDefault;
    return level === 'public' || level === 'open';
}
function accessLevel(node) {
    const modifiers = firstChildOfType(node, 'modifiers');
    if (!modifiers)
        return null;
    for (const modifier of childrenOfType(modifiers, 'visibility_modifier')) {
        // `private(set)` narrows only the setter, not the declaration.
        const narrowsSetter = modifier.children.some((token) => token?.type === 'set');
        if (!narrowsSetter)
            return modifier.text;
    }
    return null;
}
function isStatic(node) {
    const modifiers = firstChildOfType(node, 'modifiers');
    if (!modifiers)
        return false;
    return childrenOfType(modifiers, 'property_modifier').some((mod) => mod.text === 'static' || mod.text === 'class');
}
function mutability(node) {
    const pattern = firstChildOfType(node, 'value_binding_pattern');
    return pattern ? fieldText(pattern, 'mutability') : null;
}
/** `class`, `struct`, `enum`, `actor`, `extension` or `protocol`, which the grammar keeps in one field. */
function declarationKind(node) {
    return fieldText(node, 'declaration_kind') ?? '';
}
/** The declaration up to its body: attributes, name, parameters, result and conformances, on one line. */
function headerSignature(node) {
    const body = namedChildren(node).find((child) => BODY_TYPES.has(child.type));
    const end = body ? body.startIndex : node.endIndex;
    const header = node.text.slice(0, Math.max(0, end - node.startIndex));
    return truncate(squash(header).replace(/[\s{:=]+$/, ''), MAX_SIGNATURE);
}
/** Field names repeat in this grammar, where childForFieldName sees only the first. */
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
function isTypeLike(name) {
    return /^\p{Lu}/u.test(name);
}
function fileStem(relPath) {
    const file = relPath.split('/').pop() ?? relPath;
    return file.replace(/\.swift$/i, '');
}
/**
 * The module a file compiles into. SwiftPM keeps each target in its own
 * directory under Sources/ or Tests/, and the nearest such directory wins, so
 * a package nested in a monorepo still gets its own targets. Anything else is
 * taken as an Xcode layout, which keeps one top-level folder per target. A
 * file at the root belongs to '.'.
 */
export function swiftModuleOf(relPath) {
    const dirs = relPath.replace(/\\/g, '/').split('/').slice(0, -1);
    for (let i = dirs.length - 2; i >= 0; i--) {
        if (TARGET_ROOTS.has(dirs[i]))
            return dirs[i + 1];
    }
    return dirs[0] ?? '.';
}
//# sourceMappingURL=swift.js.map