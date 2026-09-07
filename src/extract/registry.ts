import path from 'node:path';
import type { Extractor } from './types.js';
import { pythonExtractor } from './python.js';
import { goExtractor } from './go.js';
import { javaExtractor } from './java.js';
import { javascriptExtractor, tsxExtractor, typescriptExtractor } from './typescript.js';
import { sqlExtractor } from './sql.js';

/**
 * The whole language registry. Adding a language is one import and one entry
 * here, which is the point.
 */
export const EXTRACTORS: readonly Extractor[] = [
  pythonExtractor,
  goExtractor,
  typescriptExtractor,
  tsxExtractor,
  javascriptExtractor,
  javaExtractor,
  sqlExtractor,
];

/**
 * Languages that resolve against each other. TypeScript, TSX and JavaScript
 * are three grammars but one module system, and imports cross freely between
 * them.
 */
const FAMILIES: Record<string, string> = {
  typescript: 'typescript',
  tsx: 'typescript',
  javascript: 'typescript',
};

export function familyOf(langId: string): string {
  return FAMILIES[langId] ?? langId;
}

const byExtension = new Map<string, Extractor>();
const byFilename = new Map<string, Extractor>();
const byId = new Map<string, Extractor>();

for (const extractor of EXTRACTORS) {
  byId.set(extractor.id, extractor);
  for (const ext of extractor.extensions) {
    if (!byExtension.has(ext)) byExtension.set(ext, extractor);
  }
  for (const name of extractor.filenames ?? []) {
    byFilename.set(name.toLowerCase(), extractor);
  }
}

export function extractorFor(relPath: string): Extractor | null {
  const base = path.posix.basename(relPath).toLowerCase();
  const exact = byFilename.get(base);
  if (exact) return exact;

  // Longest extension wins, so .d.ts style compound suffixes stay possible.
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return null;
  return byExtension.get(base.slice(dot)) ?? null;
}

export function extractorById(id: string): Extractor | null {
  return byId.get(id) ?? null;
}

/** Human-facing names, used by `init` when it reports what it found. */
export const LANGUAGE_LABELS: Record<string, string> = {
  python: 'Python',
  go: 'Go',
  typescript: 'TypeScript',
  tsx: 'TSX',
  javascript: 'JavaScript',
  java: 'Java',
  sql: 'SQL',
};

export function languageLabel(id: string): string {
  return LANGUAGE_LABELS[id] ?? id;
}
