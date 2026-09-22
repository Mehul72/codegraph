import type { Extractor } from './types.js';
export declare const swiftExtractor: Extractor;
/**
 * The module a file compiles into. SwiftPM keeps each target in its own
 * directory under Sources/ or Tests/, and the nearest such directory wins, so
 * a package nested in a monorepo still gets its own targets. Anything else is
 * taken as an Xcode layout, which keeps one top-level folder per target. A
 * file at the root belongs to '.'.
 */
export declare function swiftModuleOf(relPath: string): string;
