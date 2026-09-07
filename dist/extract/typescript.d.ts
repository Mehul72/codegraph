/**
 * TypeScript, TSX and JavaScript are three grammars over one module system,
 * so they share one extraction pass. The grammars differ only in what they
 * add: JSX nodes for tsx, and no type syntax at all for javascript. Nothing
 * below branches on the language; it checks for the node types and fields
 * that may be absent instead.
 */
import type { Extractor } from './types.js';
export declare const typescriptExtractor: Extractor;
export declare const tsxExtractor: Extractor;
export declare const javascriptExtractor: Extractor;
export declare function tsModulePath(relPath: string): string;
/**
 * The other strings this file answers to. Relative imports are not resolved
 * here: only the importer's own path can do that, and the resolver has it.
 */
export declare function tsModuleAliases(relPath: string): string[];
