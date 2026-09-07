import type { EdgeRow, GraphNode } from '../types.js';
/**
 * Output is written for a model to read, not a terminal to look pretty in.
 * That means: no boxes, no ANSI, no repeated file paths, and no JSON. Every
 * character costs, and the shape has to be obvious without a legend.
 */
export declare function location(node: GraphNode): string;
/** Repo tag for symbols that came in from a linked repo. */
export declare function repoTag(node: GraphNode, localRepo: string): string;
export declare function symbolHeadline(node: GraphNode, localRepo: string): string;
export declare function detailLines(node: GraphNode): string[];
/** One symbol per line, name padded so a list of them reads as columns. */
export declare function symbolLine(node: GraphNode, localRepo: string, nameWidth?: number): string;
export interface Neighbour {
    node: GraphNode;
    edge: EdgeRow;
    distance?: number;
}
/**
 * Group by file so a path is written once rather than once per symbol. On a
 * wide blast radius this is the single biggest saving in the whole output.
 */
export declare function groupByFile(items: readonly Neighbour[]): Array<{
    path: string;
    items: Neighbour[];
}>;
export declare function neighbourLine(item: Neighbour, localRepo: string, showDistance: boolean): string;
export declare function confidenceSummary(items: readonly {
    edge: EdgeRow;
}[]): string;
export declare function countPhrase(n: number, noun: string): string;
/** The standard closing line explaining what confidence tags mean. */
export declare const CONFIDENCE_LEGEND = "confidence: exact = seen in one AST, resolved = linked via imports, heuristic = name match only, verify before acting";
