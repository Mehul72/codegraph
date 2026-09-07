import fsp from 'node:fs/promises';
import { hashContent } from '../util/fs.js';

export interface FileContent {
  text: string;
  hash: string;
}

/** How much of a file we sniff before deciding it is not text. */
const SNIFF_BYTES = 8192;

/**
 * Read a file as UTF-8 text, or return null when it looks binary. A NUL byte
 * in the first few KiB is the cheap, boring test that everyone uses and it
 * gets images, wasm and compiled objects right.
 */
export async function readSource(absPath: string): Promise<FileContent | null> {
  const buf = await fsp.readFile(absPath);
  const limit = Math.min(buf.length, SNIFF_BYTES);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0) return null;
  }
  // Strip a UTF-8 BOM so line 1 column 1 is really the first character.
  const text = buf.toString('utf8').replace(/^\uFEFF/, '');
  return { text, hash: hashContent(text) };
}
