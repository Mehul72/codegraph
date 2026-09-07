import { readTextFileOrNull, writeTextFile } from '../util/fs.js';

/**
 * Every instruction file we touch belongs to the user, and usually has their
 * own content in it. So we only ever own the text between our own markers:
 * installing replaces that block and nothing else, and uninstalling removes
 * it and leaves the rest byte for byte as it was.
 */
export const MARKER_START = '<!-- codegraph:start -->';
export const MARKER_END = '<!-- codegraph:end -->';

export const TOML_MARKER_START = '# codegraph:start';
export const TOML_MARKER_END = '# codegraph:end';

export interface MarkerStyle {
  start: string;
  end: string;
}

export const MARKDOWN_MARKERS: MarkerStyle = { start: MARKER_START, end: MARKER_END };
export const TOML_MARKERS: MarkerStyle = { start: TOML_MARKER_START, end: TOML_MARKER_END };

/**
 * Put `body` between the markers in `existing`, replacing any previous block.
 * Running this twice with the same body produces the same file, which is what
 * makes `install` safe to re-run.
 */
export function upsertBlock(existing: string, body: string, style: MarkerStyle = MARKDOWN_MARKERS): string {
  const block = `${style.start}\n${body.trimEnd()}\n${style.end}`;
  const startAt = existing.indexOf(style.start);
  const endAt = existing.indexOf(style.end);

  if (startAt !== -1 && endAt > startAt) {
    const before = existing.slice(0, startAt);
    const after = existing.slice(endAt + style.end.length);
    return `${before}${block}${after}`;
  }

  if (existing.trim() === '') return `${block}\n`;
  const separator = existing.endsWith('\n\n') ? '' : existing.endsWith('\n') ? '\n' : '\n\n';
  return `${existing}${separator}${block}\n`;
}

/** Remove our block. Returns null when there was nothing of ours to remove. */
export function removeBlock(existing: string, style: MarkerStyle = MARKDOWN_MARKERS): string | null {
  const startAt = existing.indexOf(style.start);
  const endAt = existing.indexOf(style.end);
  if (startAt === -1 || endAt <= startAt) return null;

  const before = existing.slice(0, startAt);
  const after = existing.slice(endAt + style.end.length);
  const joined = `${before.replace(/\n+$/, '\n')}${after.replace(/^\n+/, '')}`;
  return joined.trim() === '' ? '' : joined;
}

export async function writeMarkedFile(
  file: string,
  body: string,
  style: MarkerStyle = MARKDOWN_MARKERS,
): Promise<boolean> {
  const existing = (await readTextFileOrNull(file)) ?? '';
  const updated = upsertBlock(existing, body, style);
  if (updated === existing) return false;
  await writeTextFile(file, updated);
  return true;
}

export async function stripMarkedFile(file: string, style: MarkerStyle = MARKDOWN_MARKERS): Promise<boolean> {
  const existing = await readTextFileOrNull(file);
  if (existing === null) return false;
  const updated = removeBlock(existing, style);
  if (updated === null || updated === existing) return false;
  await writeTextFile(file, updated);
  return true;
}
