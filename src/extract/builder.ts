import type { EdgeTarget, EdgeType, ExtractResult, GraphNode, NodeKind, RawEdge } from '../types.js';

export interface SymbolSpec {
  name: string;
  kind: NodeKind;
  lineStart: number;
  lineEnd: number;
  qualified?: string | null;
  signature?: string | null;
  doc?: string | null;
  exported?: boolean;
}

/**
 * Collects nodes and edges for one file and hands out ids. Extractors talk to
 * this instead of building GraphNode objects by hand, which keeps id format
 * and duplicate handling in one place.
 */
export class SymbolBuilder {
  private readonly nodes: GraphNode[] = [];
  private readonly edges: RawEdge[] = [];
  private readonly usedIds = new Set<string>();

  constructor(
    private readonly repo: string,
    private readonly path: string,
    private readonly lang: string,
  ) {}

  /**
   * The file itself, as a module node. Every file gets one so that
   * impact_of(file) and overview have something to hang off, and so imports
   * have a source even when they sit at the top level.
   */
  module(spec: { name: string; qualified?: string | null; lineEnd: number; doc?: string | null }): GraphNode {
    return this.add({
      name: spec.name,
      kind: 'module',
      qualified: spec.qualified ?? spec.name,
      lineStart: 1,
      lineEnd: spec.lineEnd,
      doc: spec.doc ?? null,
      signature: null,
      exported: true,
    });
  }

  add(spec: SymbolSpec): GraphNode {
    const qualified = spec.qualified ?? spec.name;
    const node: GraphNode = {
      id: this.uniqueId(spec.kind, qualified),
      repo: this.repo,
      path: this.path,
      name: spec.name,
      qualified,
      kind: spec.kind,
      lang: this.lang,
      lineStart: spec.lineStart,
      lineEnd: Math.max(spec.lineEnd, spec.lineStart),
      signature: spec.signature ?? null,
      doc: spec.doc ?? null,
      exported: spec.exported ?? true,
    };
    this.nodes.push(node);
    return node;
  }

  edge(from: GraphNode | string, to: EdgeTarget, type: EdgeType, line: number): void {
    this.edges.push({ from: typeof from === 'string' ? from : from.id, to, type, line });
  }

  /** Shorthand for the common "this symbol references that bare name" case. */
  ref(from: GraphNode | string, type: EdgeType, name: string, line: number, qualifier: string | null = null): void {
    if (name === '') return;
    this.edge(from, { kind: 'name', name, qualifier }, type, line);
  }

  importEdge(
    from: GraphNode | string,
    module: string,
    line: number,
    opts: { symbol?: string | null; alias?: string | null } = {},
  ): void {
    if (module === '') return;
    this.edge(from, { kind: 'module', module, symbol: opts.symbol ?? null, alias: opts.alias ?? null }, 'imports', line);
  }

  result(): ExtractResult {
    return { nodes: this.nodes, edges: this.edges };
  }

  /**
   * Ids must be deterministic and unique. Overloads, conditional definitions
   * and re-declared names all collide, so the second one onward gets a
   * positional suffix rather than silently overwriting the first.
   */
  private uniqueId(kind: NodeKind, qualified: string): string {
    const base = `${this.repo}:${this.path}:${kind}:${qualified}`;
    if (!this.usedIds.has(base)) {
      this.usedIds.add(base);
      return base;
    }
    for (let n = 2; ; n++) {
      const candidate = `${base}#${n}`;
      if (!this.usedIds.has(candidate)) {
        this.usedIds.add(candidate);
        return candidate;
      }
    }
  }
}

export function emptyResult(): ExtractResult {
  return { nodes: [], edges: [] };
}
