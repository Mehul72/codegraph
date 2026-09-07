import type { Extractor } from './types.js';
/**
 * The whole language registry. Adding a language is one import and one entry
 * here, which is the point.
 */
export declare const EXTRACTORS: readonly Extractor[];
export declare function familyOf(langId: string): string;
export declare function extractorFor(relPath: string): Extractor | null;
export declare function extractorById(id: string): Extractor | null;
/** Human-facing names, used by `init` when it reports what it found. */
export declare const LANGUAGE_LABELS: Record<string, string>;
export declare function languageLabel(id: string): string;
