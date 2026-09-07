import type { Tree } from 'web-tree-sitter';
import type { ExtractResult } from '../types.js';
export interface ExtractInput {
    /** Parsed tree, or null for extractors that do their own lexing (see sql). */
    tree: Tree | null;
    /** Repo-relative path with forward slashes. */
    path: string;
    source: string;
    repo: string;
}
/**
 * Everything a language needs to plug in. Adding a language means writing one
 * file that exports this and adding one line to the registry.
 *
 * The parse tree is handed over already built, so extractors never touch
 * grammar loading or file IO.
 */
export interface Extractor {
    /** Stable id, also the value stored in files.lang and nodes.lang. */
    id: string;
    /** Lower-case file extensions, with the dot. */
    extensions: string[];
    /** Exact file names to claim, for languages where extension is not enough. */
    filenames?: string[];
    /** Grammar file in grammars/, or null to skip parsing entirely. */
    grammar: string | null;
    extract(input: ExtractInput): ExtractResult;
    /**
     * The dotted or slashed module path other files use to import this one.
     * Resolution matches import strings against these.
     */
    modulePath?(relPath: string, source: string): string | null;
    /**
     * Additional strings this file can be imported as. Python packages on a src
     * layout and Go package names both need this.
     */
    moduleAliases?(relPath: string, source: string): string[];
}
