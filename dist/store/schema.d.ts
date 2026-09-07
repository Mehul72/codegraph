/**
 * The schema is versioned through SQLite's own user_version. Migrations are a
 * plain list: each entry moves the database up one version. There is no
 * downgrade path, because the index is disposable and `codegraph reindex
 * --force` is always available.
 */
export declare const SCHEMA_VERSION = 1;
export declare const MIGRATIONS: readonly string[];
