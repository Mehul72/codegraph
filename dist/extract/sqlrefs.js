/**
 * Finds table names inside embedded SQL strings. This is what connects a
 * handler in application code to a table in a schema file, and it is one of
 * the few things an agent cannot get quickly by grepping.
 *
 * Deliberately shallow: we look for the table position of the common
 * statements and stop there. No SQL parser, no dialect handling.
 */
const SQL_HINT = /\b(select|insert\s+into|update|delete\s+from|create\s+table|join)\b/i;
const TABLE_PATTERNS = [
    /\bfrom\s+([`"[]?[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?[`"\]]?)/gi,
    /\bjoin\s+([`"[]?[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?[`"\]]?)/gi,
    /\binsert\s+into\s+([`"[]?[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?[`"\]]?)/gi,
    /\bupdate\s+([`"[]?[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?[`"\]]?)/gi,
    /\bdelete\s+from\s+([`"[]?[a-zA-Z_][\w$]*(?:\.[a-zA-Z_][\w$]*)?[`"\]]?)/gi,
];
/** SQL keywords that can follow FROM or JOIN and are not table names. */
const NOT_TABLES = new Set([
    'select',
    'where',
    'dual',
    'values',
    'set',
    'lateral',
    'unnest',
    'only',
    'table',
    'generate_series',
]);
export function looksLikeSql(text) {
    return text.length > 12 && SQL_HINT.test(text);
}
/**
 * Returns bare table names, lower-cased and de-duplicated, in the order they
 * first appear. A schema-qualified name keeps only its last segment, because
 * that is what the DDL extractor names the table node.
 */
export function tablesInSql(text) {
    if (!looksLikeSql(text))
        return [];
    const found = [];
    const seen = new Set();
    for (const pattern of TABLE_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(text)) !== null) {
            const raw = match[1];
            if (!raw)
                continue;
            const cleaned = raw.replace(/[`"[\]]/g, '');
            const bare = (cleaned.includes('.') ? cleaned.split('.').pop() : cleaned).toLowerCase();
            if (bare.length < 2 || NOT_TABLES.has(bare) || seen.has(bare))
                continue;
            seen.add(bare);
            found.push(bare);
        }
    }
    return found;
}
/** Strip the quotes and prefixes off a string literal from any of our languages. */
export function unquote(literal) {
    let text = literal.trim();
    text = text.replace(/^[rRuUbBfFlL]{0,2}/, '');
    for (const quote of ['"""', "'''", '`', '"', "'"]) {
        if (text.startsWith(quote) && text.endsWith(quote) && text.length >= quote.length * 2) {
            return text.slice(quote.length, text.length - quote.length);
        }
    }
    return text;
}
//# sourceMappingURL=sqlrefs.js.map