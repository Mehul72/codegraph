/**
 * Finds table names inside embedded SQL strings. This is what connects a
 * handler in application code to a table in a schema file, and it is one of
 * the few things an agent cannot get quickly by grepping.
 *
 * Deliberately shallow: we look for the table position of the common
 * statements and stop there. No SQL parser, no dialect handling.
 */
export declare function looksLikeSql(text: string): boolean;
/**
 * Returns bare table names, lower-cased and de-duplicated, in the order they
 * first appear. A schema-qualified name keeps only its last segment, because
 * that is what the DDL extractor names the table node.
 */
export declare function tablesInSql(text: string): string[];
/** Strip the quotes and prefixes off a string literal from any of our languages. */
export declare function unquote(literal: string): string;
