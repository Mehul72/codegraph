export interface FileContent {
    text: string;
    hash: string;
}
/**
 * Read a file as UTF-8 text, or return null when it looks binary. A NUL byte
 * in the first few KiB is the cheap, boring test that everyone uses and it
 * gets images, wasm and compiled objects right.
 */
export declare function readSource(absPath: string): Promise<FileContent | null>;
