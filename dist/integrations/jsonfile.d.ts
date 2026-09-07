type JsonObject = Record<string, unknown>;
/**
 * Merge into a JSON config without disturbing anything else in it.
 *
 * These files belong to the user and often to their whole team. Rewriting one
 * wholesale would silently drop other MCP servers or editor settings, so we
 * read, mutate the one key we own, and write back. Some of them are JSON with
 * comments, so parsing is lenient; comments are lost on write, which is the
 * one compromise here and it is called out in the README.
 */
export declare function updateJsonFile(file: string, mutate: (root: JsonObject) => boolean): Promise<boolean>;
/** Get or create a nested object at `keys`, without replacing what is there. */
export declare function objectAt(root: JsonObject, ...keys: string[]): JsonObject;
/** Read a nested object if it is already there, without creating anything. */
export declare function peekObject(root: JsonObject, ...keys: string[]): JsonObject | null;
/** Drop empty objects we created, so uninstall leaves no residue. */
export declare function pruneEmpty(root: JsonObject, ...keys: string[]): void;
export {};
