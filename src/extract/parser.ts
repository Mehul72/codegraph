import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Language, Parser, type Tree } from 'web-tree-sitter';
import { log } from '../util/log.js';

/** grammars/ sits next to src/ in the repo and next to dist/ in the package. */
export function grammarDir(): string {
  if (process.env.CODEGRAPH_GRAMMARS) return path.resolve(process.env.CODEGRAPH_GRAMMARS);
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, '..', '..', 'grammars');
}

export class MissingGrammarError extends Error {
  constructor(readonly grammar: string) {
    super(`grammar ${grammar} is not present in ${grammarDir()}`);
    this.name = 'MissingGrammarError';
  }
}

/**
 * Loads grammars on demand and keeps one parser per grammar. A Python-only
 * repo never pays to load the Java grammar, which is the whole point of
 * doing this lazily.
 */
export class ParserPool {
  private static runtimeReady: Promise<void> | null = null;
  private readonly languages = new Map<string, Promise<Language>>();
  /**
   * Keyed on the promise, not the finished parser. Two callers that miss a
   * half-built entry would both build one, and the loser was dropped on the
   * floor still holding its wasm instance, which dispose() then never freed.
   */
  private readonly parsers = new Map<string, Promise<Parser>>();
  private readonly broken = new Set<string>();

  static async initRuntime(): Promise<void> {
    if (!ParserPool.runtimeReady) {
      ParserPool.runtimeReady = Parser.init();
    }
    await ParserPool.runtimeReady;
  }

  /** Returns null when the grammar is missing or refuses to load. */
  async parserFor(grammar: string): Promise<Parser | null> {
    if (this.broken.has(grammar)) return null;

    const existing = this.parsers.get(grammar);
    if (existing) return existing;

    const file = path.join(grammarDir(), grammar);
    if (!fs.existsSync(file)) {
      this.broken.add(grammar);
      log.warn(`grammar ${grammar} is missing, skipping the languages that need it`);
      return null;
    }

    // Registered before the first await, so a concurrent caller waits on this
    // build instead of starting a second one.
    const building = this.build(grammar, file);
    this.parsers.set(grammar, building);

    try {
      return await building;
    } catch (err) {
      this.broken.add(grammar);
      this.parsers.delete(grammar);
      this.languages.delete(grammar);
      log.warn(`grammar ${grammar} failed to load (${(err as Error).message}), skipping that language`);
      return null;
    }
  }

  private async build(grammar: string, file: string): Promise<Parser> {
    await ParserPool.initRuntime();
    let loading = this.languages.get(grammar);
    if (!loading) {
      loading = Language.load(file);
      this.languages.set(grammar, loading);
    }
    const language = await loading;
    const parser = new Parser();
    parser.setLanguage(language);
    log.debug(`loaded grammar ${grammar}`);
    return parser;
  }

  /**
   * Parse one file. Returns null when the grammar is unavailable, and a tree
   * even when it contains errors: tree-sitter recovers well enough that a file
   * with one syntax error still yields most of its symbols.
   */
  async parse(grammar: string, source: string): Promise<Tree | null> {
    const parser = await this.parserFor(grammar);
    if (!parser) return null;
    try {
      return parser.parse(source);
    } catch (err) {
      log.debug(`parse failed with ${grammar}: ${(err as Error).message}`);
      return null;
    }
  }

  dispose(): void {
    for (const building of this.parsers.values()) {
      // A build still in flight is settled before its parser is freed, so an
      // abandoned one cannot outlive the pool.
      void building.then(
        (parser) => {
          try {
            parser.delete();
          } catch {
            // Nothing to do if the wasm instance is already gone.
          }
        },
        () => {},
      );
    }
    this.parsers.clear();
  }

  availableGrammars(): string[] {
    try {
      return fs
        .readdirSync(grammarDir())
        .filter((f) => f.endsWith('.wasm'))
        .sort();
    } catch {
      return [];
    }
  }
}
