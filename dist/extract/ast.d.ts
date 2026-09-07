import type { Node } from 'web-tree-sitter';
export declare const MAX_SIGNATURE = 200;
export declare const MAX_DOC = 200;
/** tree-sitter rows are 0-based, everything user-facing is 1-based. */
export declare function lineOf(node: Node): number;
export declare function endLineOf(node: Node): number;
export declare function field(node: Node, name: string): Node | null;
export declare function fieldText(node: Node, name: string): string | null;
export declare function namedChildren(node: Node): Node[];
export declare function childrenOfType(node: Node, ...types: string[]): Node[];
export declare function firstChildOfType(node: Node, ...types: string[]): Node | null;
/**
 * Depth-first walk that lets the callback prune subtrees by returning false.
 * Uses an explicit stack because deeply nested files blow the JS stack.
 */
export declare function walk(root: Node, visit: (node: Node) => boolean | void): void;
/**
 * A readable one-line signature. Takes the declaration text up to the body,
 * so we get the name, parameters and return type without the implementation.
 */
export declare function signatureOf(node: Node, bodyFieldNames?: readonly string[]): string;
/**
 * The doc comment sitting immediately above `node`, whether it is written
 * with `//`, `#` or `/* *\/`. Only the opening paragraph survives, because a
 * full docstring is often longer than the answer the agent asked for. See
 * cleanDoc for where that cut is made.
 */
export declare function leadingCommentDoc(node: Node, source: string): string | null;
/** Python and friends put the doc inside the body as a bare string. */
export declare function stringLiteralDoc(node: Node | null): string | null;
/**
 * The opening paragraph of a doc comment, flattened onto one line.
 *
 * Stopping at the first blank line or the first `@param` style tag is what
 * keeps a parameter list out of an answer nobody asked one for. Keeping the
 * whole paragraph rather than just its first line matters too, because a
 * sentence wrapped over two lines would otherwise be cut mid-word.
 */
export declare function cleanDoc(text: string): string | null;
/**
 * Splits a dotted or scoped expression like `a.b.c` into the trailing name and
 * everything before it. Used to turn call expressions into (qualifier, name).
 */
export declare function splitQualified(expr: string): {
    qualifier: string | null;
    name: string;
};
/** True when the identifier looks like a constant by convention. */
export declare function looksLikeConstant(name: string): boolean;
