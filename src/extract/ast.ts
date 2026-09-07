import type { Node } from 'web-tree-sitter';
import { squash, truncate } from '../util/text.js';

export const MAX_SIGNATURE = 200;
export const MAX_DOC = 200;

/** tree-sitter rows are 0-based, everything user-facing is 1-based. */
export function lineOf(node: Node): number {
  return node.startPosition.row + 1;
}

export function endLineOf(node: Node): number {
  return node.endPosition.row + 1;
}

export function field(node: Node, name: string): Node | null {
  return node.childForFieldName(name);
}

export function fieldText(node: Node, name: string): string | null {
  const child = node.childForFieldName(name);
  return child ? child.text : null;
}

export function namedChildren(node: Node): Node[] {
  return node.namedChildren.filter((c): c is Node => c !== null);
}

export function childrenOfType(node: Node, ...types: string[]): Node[] {
  const wanted = new Set(types);
  return namedChildren(node).filter((c) => wanted.has(c.type));
}

export function firstChildOfType(node: Node, ...types: string[]): Node | null {
  const wanted = new Set(types);
  for (const child of namedChildren(node)) {
    if (wanted.has(child.type)) return child;
  }
  return null;
}

/**
 * Depth-first walk that lets the callback prune subtrees by returning false.
 * Uses an explicit stack because deeply nested files blow the JS stack.
 */
export function walk(root: Node, visit: (node: Node) => boolean | void): void {
  const stack: Node[] = [root];
  while (stack.length > 0) {
    const node = stack.pop() as Node;
    const descend = visit(node);
    if (descend === false) continue;
    const kids = node.namedChildren;
    for (let i = kids.length - 1; i >= 0; i--) {
      const kid = kids[i];
      if (kid) stack.push(kid);
    }
  }
}

/**
 * A readable one-line signature. Takes the declaration text up to the body,
 * so we get the name, parameters and return type without the implementation.
 */
export function signatureOf(node: Node, bodyFieldNames: readonly string[] = ['body']): string {
  let end = node.endIndex;
  for (const name of bodyFieldNames) {
    const body = node.childForFieldName(name);
    if (body) {
      end = Math.min(end, body.startIndex);
      break;
    }
  }
  const raw = node.text.slice(0, Math.max(0, end - node.startIndex));
  return truncate(squash(raw).replace(/[\s{:=]+$/, ''), MAX_SIGNATURE);
}

/**
 * The doc comment sitting immediately above `node`, whether it is written
 * with `//`, `#` or `/* *\/`. Only the opening paragraph survives, because a
 * full docstring is often longer than the answer the agent asked for. See
 * cleanDoc for where that cut is made.
 */
export function leadingCommentDoc(node: Node, source: string): string | null {
  const lines = source.split('\n');
  let row = node.startPosition.row - 1;
  const collected: string[] = [];

  while (row >= 0) {
    const raw = (lines[row] ?? '').trim();
    // A doc comment sits flush against the thing it documents. A blank line in
    // between means the comment above belongs to whatever came before, which
    // is how a `// ----- section` divider ends up quoted as a symbol's doc.
    if (raw === '') break;
    if (raw.startsWith('//') || raw.startsWith('#')) {
      collected.unshift(raw.replace(/^(\/\/+|#+)\s?/, ''));
      row--;
      continue;
    }
    if (raw.endsWith('*/')) {
      const block: string[] = [];
      while (row >= 0) {
        const blockLine = (lines[row] ?? '').trim();
        block.unshift(blockLine.replace(/^\/\*+\s?/, '').replace(/\*+\/$/, '').replace(/^\*\s?/, ''));
        if (blockLine.startsWith('/*')) break;
        row--;
      }
      collected.unshift(...block);
      break;
    }
    // Anything else means we ran into real code.
    break;
  }

  // Newlines, not spaces: cleanDoc decides how much of the block to keep, and
  // it cannot see where the lines were once they have been joined.
  return cleanDoc(collected.join('\n'));
}

/** Python and friends put the doc inside the body as a bare string. */
export function stringLiteralDoc(node: Node | null): string | null {
  if (!node) return null;
  const raw = node.text;
  const stripped = raw
    .replace(/^[rRuUbBfF]{0,2}("""|'''|"|')/, '')
    .replace(/("""|'''|"|')$/, '')
    .trim();
  return cleanDoc(stripped);
}

/**
 * The opening paragraph of a doc comment, flattened onto one line.
 *
 * Stopping at the first blank line or the first `@param` style tag is what
 * keeps a parameter list out of an answer nobody asked one for. Keeping the
 * whole paragraph rather than just its first line matters too, because a
 * sentence wrapped over two lines would otherwise be cut mid-word.
 */
export function cleanDoc(text: string): string | null {
  const summary = leadingParagraph(text.split(/\r?\n/));
  if (summary === '') return null;
  const cleaned = squash(summary);
  if (cleaned === '') return null;
  // Rules and boxes drawn out of punctuation are decoration, not documentation.
  if (!/[\p{L}\p{N}]/u.test(cleaned)) return null;
  return truncate(cleaned, MAX_DOC);
}

function leadingParagraph(lines: readonly string[]): string {
  const kept: string[] = [];
  for (const line of lines) {
    const text = line.trim();
    // A tag ends the prose whether or not a blank line came first.
    if (/^[@\\]\w/.test(text)) break;
    if (text === '') {
      if (kept.length > 0) break;
      continue;
    }
    kept.push(text);
  }
  return kept.join(' ');
}

/**
 * Splits a dotted or scoped expression like `a.b.c` into the trailing name and
 * everything before it. Used to turn call expressions into (qualifier, name).
 */
export function splitQualified(expr: string): { qualifier: string | null; name: string } {
  const cleaned = expr.trim();
  const dot = cleaned.lastIndexOf('.');
  const colon = cleaned.lastIndexOf('::');
  if (dot <= 0 && colon <= 0) return { qualifier: null, name: cleaned };
  if (colon > dot) {
    return { qualifier: cleaned.slice(0, colon) || null, name: cleaned.slice(colon + 2).trim() };
  }
  return { qualifier: cleaned.slice(0, dot) || null, name: cleaned.slice(dot + 1).trim() };
}

/** True when the identifier looks like a constant by convention. */
export function looksLikeConstant(name: string): boolean {
  return /^[A-Z][A-Z0-9_]*$/.test(name) && name.length > 1;
}
