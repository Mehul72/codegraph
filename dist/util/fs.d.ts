export declare function pathExists(target: string): Promise<boolean>;
export declare function pathExistsSync(target: string): boolean;
export declare function ensureDir(dir: string): Promise<void>;
export declare function readTextFileOrNull(file: string): Promise<string | null>;
/**
 * Write UTF-8 with LF endings through a temp file and a rename, so a crash
 * halfway through never leaves a half-written config behind.
 */
export declare function writeTextFile(file: string, contents: string): Promise<void>;
export declare function hashContent(text: string): string;
/** Repo-relative path with forward slashes, so ids match across platforms. */
export declare function toPosix(relPath: string): string;
/** True when `child` is inside `parent` (or is `parent` itself). */
export declare function isInside(parent: string, child: string): boolean;
