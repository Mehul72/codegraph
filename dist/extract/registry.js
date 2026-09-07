import path from 'node:path';
import { pythonExtractor } from './python.js';
import { goExtractor } from './go.js';
import { javaExtractor } from './java.js';
import { javascriptExtractor, tsxExtractor, typescriptExtractor } from './typescript.js';
import { sqlExtractor } from './sql.js';
/**
 * The whole language registry. Adding a language is one import and one entry
 * here, which is the point.
 */
export const EXTRACTORS = [
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
const FAMILIES = {
    typescript: 'typescript',
    tsx: 'typescript',
    javascript: 'typescript',
};
export function familyOf(langId) {
    return FAMILIES[langId] ?? langId;
}
const byExtension = new Map();
const byFilename = new Map();
const byId = new Map();
for (const extractor of EXTRACTORS) {
    byId.set(extractor.id, extractor);
    for (const ext of extractor.extensions) {
        if (!byExtension.has(ext))
            byExtension.set(ext, extractor);
    }
    for (const name of extractor.filenames ?? []) {
        byFilename.set(name.toLowerCase(), extractor);
    }
}
export function extractorFor(relPath) {
    const base = path.posix.basename(relPath).toLowerCase();
    const exact = byFilename.get(base);
    if (exact)
        return exact;
    // The last dot wins, so `widget.d.ts` and `widget.test.ts` are both just
    // TypeScript. A compound suffix would need its own entry in byFilename.
    const dot = base.lastIndexOf('.');
    if (dot <= 0)
        return null;
    return byExtension.get(base.slice(dot)) ?? null;
}
export function extractorById(id) {
    return byId.get(id) ?? null;
}
/** Human-facing names, used by `init` when it reports what it found. */
export const LANGUAGE_LABELS = {
    python: 'Python',
    go: 'Go',
    typescript: 'TypeScript',
    tsx: 'TSX',
    javascript: 'JavaScript',
    java: 'Java',
    sql: 'SQL',
};
export function languageLabel(id) {
    return LANGUAGE_LABELS[id] ?? id;
}
//# sourceMappingURL=registry.js.map