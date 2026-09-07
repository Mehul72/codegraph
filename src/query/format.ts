import type { Confidence, EdgeRow, GraphNode } from '../types.js';
import { pad, plural, truncate } from '../util/text.js';

/**
 * Output is written for a model to read, not a terminal to look pretty in.
 * That means: no boxes, no ANSI, no repeated file paths, and no JSON. Every
 * character costs, and the shape has to be obvious without a legend.
 */

export function location(node: GraphNode): string {
  return `${node.path}:${node.lineStart}`;
}

/** Repo tag for symbols that came in from a linked repo. */
export function repoTag(node: GraphNode, localRepo: string): string {
  return node.repo === localRepo ? '' : ` [repo:${node.repo}]`;
}

export function symbolHeadline(node: GraphNode, localRepo: string): string {
  const name = node.qualified && node.qualified !== node.name ? node.qualified : node.name;
  return `${name} (${node.kind}, ${location(node)})${repoTag(node, localRepo)}`;
}

export function detailLines(node: GraphNode): string[] {
  const out: string[] = [];
  if (node.signature) out.push(`  sig  ${truncate(node.signature, 180)}`);
  if (node.doc) out.push(`  doc  ${truncate(node.doc, 160)}`);
  if (!node.exported) out.push('  not exported');
  return out;
}

/** One symbol per line, name padded so a list of them reads as columns. */
export function symbolLine(node: GraphNode, localRepo: string, nameWidth = 28): string {
  const label = node.qualified && node.qualified !== node.name ? node.qualified : node.name;
  return `  ${pad(truncate(label, nameWidth), nameWidth)} ${pad(node.kind, 9)} ${location(node)}${repoTag(node, localRepo)}`;
}

export interface Neighbour {
  node: GraphNode;
  edge: EdgeRow;
  distance?: number;
}

/**
 * Group by file so a path is written once rather than once per symbol. On a
 * wide blast radius this is the single biggest saving in the whole output.
 */
export function groupByFile(items: readonly Neighbour[]): Array<{ path: string; items: Neighbour[] }> {
  const groups = new Map<string, Neighbour[]>();
  for (const item of items) {
    const list = groups.get(item.node.path);
    if (list) list.push(item);
    else groups.set(item.node.path, [item]);
  }
  const out = [...groups.entries()].map(([filePath, group]) => ({
    path: filePath,
    items: group.sort((a, b) => (a.distance ?? 0) - (b.distance ?? 0) || a.node.lineStart - b.node.lineStart),
  }));
  out.sort((a, b) => {
    const aBest = Math.min(...a.items.map((i) => i.distance ?? 0));
    const bBest = Math.min(...b.items.map((i) => i.distance ?? 0));
    return aBest - bBest || (a.path < b.path ? -1 : 1);
  });
  return out;
}

export function neighbourLine(item: Neighbour, localRepo: string, showDistance: boolean): string {
  const label = item.node.qualified && item.node.qualified !== item.node.name ? item.node.qualified : item.node.name;
  const distance = showDistance ? `d${item.distance ?? 1} ` : '';
  return `  ${distance}${pad(truncate(label, 30), 30)} ${pad(item.node.kind, 9)} :${item.node.lineStart} ${item.edge.type}/${item.edge.confidence}${repoTag(item.node, localRepo)}`;
}

export function confidenceSummary(items: readonly { edge: EdgeRow }[]): string {
  const counts: Record<Confidence, number> = { exact: 0, resolved: 0, heuristic: 0 };
  for (const item of items) counts[item.edge.confidence]++;
  const parts: string[] = [];
  for (const key of ['exact', 'resolved', 'heuristic'] as Confidence[]) {
    if (counts[key] > 0) parts.push(`${counts[key]} ${key}`);
  }
  return parts.join(', ');
}

export function countPhrase(n: number, noun: string): string {
  return `${n} ${plural(n, noun)}`;
}

/** The standard closing line explaining what confidence tags mean. */
export const CONFIDENCE_LEGEND =
  'confidence: exact = seen in one AST, resolved = linked via imports, heuristic = name match only, verify before acting';
