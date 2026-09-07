import { DatabaseSync } from 'node:sqlite';
import path from 'node:path';
import fs from 'node:fs';
import { MIGRATIONS, SCHEMA_VERSION } from './schema.js';
import { log } from '../util/log.js';
/**
 * The index is a cache, so a broken one is never worth troubleshooting. The
 * message says the one command that fixes it rather than leaving the user to
 * work out that deleting .codegraph is safe.
 */
export class CorruptIndexError extends Error {
    file;
    constructor(file, cause) {
        super(`the index at ${file} could not be read (${cause.message}). ` +
            `Nothing here is irreplaceable, so run 'codegraph reindex' to rebuild it.`);
        this.file = file;
        this.name = 'CorruptIndexError';
    }
}
const NODE_COLS = 'id, repo, path, name, qualified, kind, lang, line_start, line_end, signature, doc, exported, external';
const EDGE_COLS = 'src_id, dst_id, type, confidence, path, line';
const REF_COLS = 'rid, src_id, path, line, type, target_kind, name, qualifier, module, symbol, alias, lang';
/**
 * Every SQL statement in the project lives here. Callers deal in plain
 * objects and never see a column name.
 *
 * Statements are prepared once and cached, because a CLI invocation that runs
 * a hundred small queries should not pay to compile a hundred statements.
 */
export class Store {
    file;
    db;
    prepared = new Map();
    constructor(db, file) {
        this.file = file;
        this.db = db;
    }
    static open(file, options = {}) {
        const readOnly = options.readOnly ?? false;
        if (!readOnly && (options.create ?? true)) {
            fs.mkdirSync(path.dirname(file), { recursive: true });
        }
        let db;
        try {
            db = new DatabaseSync(file, { readOnly, open: true });
            // WAL lets a query run while a background touch writes, which is the
            // normal situation once agent hooks are wired up.
            if (!readOnly) {
                db.exec('PRAGMA journal_mode = WAL');
                db.exec('PRAGMA synchronous = NORMAL');
            }
            // Two writers still have to take turns, though, and SQLite's default is
            // to fail the loser instantly rather than wait for its turn. Nothing
            // here is slow enough to be worth abandoning after a few milliseconds.
            db.exec('PRAGMA busy_timeout = 5000');
            db.exec('PRAGMA temp_store = MEMORY');
            db.exec('PRAGMA cache_size = -32000');
        }
        catch (err) {
            throw new CorruptIndexError(file, err);
        }
        const store = new Store(db, file);
        if (!readOnly)
            store.migrate();
        return store;
    }
    migrate() {
        // The loop below runs migrations up to MIGRATIONS.length and then stamps
        // SCHEMA_VERSION. If those ever disagree the database is labelled with a
        // version whose migrations never ran, and every later read is a mystery.
        if (MIGRATIONS.length !== SCHEMA_VERSION) {
            throw new Error(`codegraph build error: ${MIGRATIONS.length} migrations for schema version ${SCHEMA_VERSION}`);
        }
        const row = this.queryOne('PRAGMA user_version');
        const version = Number(row?.user_version ?? 0);
        if (version > SCHEMA_VERSION) {
            throw new Error(`this index was written by a newer codegraph (schema ${version}, this build speaks ${SCHEMA_VERSION}). Run 'codegraph reindex --force'.`);
        }
        if (version === SCHEMA_VERSION)
            return;
        for (let v = version; v < MIGRATIONS.length; v++) {
            const sql = MIGRATIONS[v];
            if (!sql)
                continue;
            log.debug(`applying schema migration ${v + 1}`);
            this.db.exec(sql);
        }
        this.db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
    }
    stmt(sql) {
        let cached = this.prepared.get(sql);
        if (!cached) {
            cached = this.db.prepare(sql);
            this.prepared.set(sql, cached);
        }
        return cached;
    }
    /**
     * node:sqlite hands back Record<string, SQLOutputValue>. The schema is fixed
     * and lives in this file, so naming the row shape here is safe and keeps the
     * cast in exactly one place.
     */
    queryAll(sql, ...params) {
        return this.stmt(sql).all(...params);
    }
    queryOne(sql, ...params) {
        return this.stmt(sql).get(...params);
    }
    exec(sql, ...params) {
        return Number(this.stmt(sql).run(...params).changes ?? 0);
    }
    close() {
        try {
            this.db.close();
        }
        catch {
            // Closing twice is harmless and not worth surfacing.
        }
    }
    /** Runs `fn` inside a transaction, rolling back if it throws. */
    transaction(fn) {
        this.db.exec('BEGIN');
        try {
            const result = fn();
            this.db.exec('COMMIT');
            return result;
        }
        catch (err) {
            try {
                this.db.exec('ROLLBACK');
            }
            catch {
                // Nothing useful to do if the rollback itself fails.
            }
            throw err;
        }
    }
    // ---------------------------------------------------------------- meta
    getMeta(key) {
        return this.queryOne('SELECT value FROM meta WHERE key = ?', key)?.value ?? null;
    }
    setMeta(key, value) {
        this.exec('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value', key, value);
    }
    // --------------------------------------------------------------- files
    allFiles() {
        return this.queryAll('SELECT path, hash, size, mtime_ms, lang, indexed_at FROM files').map((r) => ({
            path: r.path,
            hash: r.hash,
            size: r.size,
            mtimeMs: r.mtime_ms,
            lang: r.lang,
            indexedAt: r.indexed_at,
        }));
    }
    fileCount() {
        return this.queryOne('SELECT COUNT(*) AS n FROM files')?.n ?? 0;
    }
    upsertFile(record) {
        this.exec(`INSERT INTO files (path, hash, size, mtime_ms, lang, indexed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT(path) DO UPDATE SET hash = excluded.hash, size = excluded.size,
         mtime_ms = excluded.mtime_ms, lang = excluded.lang, indexed_at = excluded.indexed_at`, record.path, record.hash, record.size, Math.round(record.mtimeMs), record.lang, record.indexedAt);
    }
    /** Drops a file and everything the file produced. */
    forgetFile(filePath) {
        this.exec('DELETE FROM files WHERE path = ?', filePath);
        this.clearFileContents(filePath);
    }
    /** Same as forgetFile but keeps the files row, for a file being reparsed. */
    clearFileContents(filePath) {
        this.exec('DELETE FROM nodes WHERE path = ? AND external = 0', filePath);
        this.exec('DELETE FROM edges WHERE path = ?', filePath);
        this.exec('DELETE FROM refs WHERE path = ?', filePath);
        this.exec('DELETE FROM modules WHERE path = ?', filePath);
    }
    // ------------------------------------------------------------- modules
    addModulePath(filePath, family, module, isAlias) {
        this.exec(`INSERT INTO modules (path, family, module, is_alias) VALUES (?, ?, ?, ?)
       ON CONFLICT(path, module) DO UPDATE SET family = excluded.family,
         is_alias = MIN(modules.is_alias, excluded.is_alias)`, filePath, family, module, isAlias ? 1 : 0);
    }
    /** Files that answer to this exact module string, canonical matches first. */
    filesForModule(family, module) {
        return this.queryAll('SELECT path FROM modules WHERE module = ? AND family = ? ORDER BY is_alias, path', module, family).map((r) => r.path);
    }
    allModulePaths() {
        return this.queryAll('SELECT path, family, module, is_alias FROM modules').map((r) => ({ path: r.path, family: r.family, module: r.module, isAlias: r.is_alias === 1 }));
    }
    /** Canonical module string for a file, used when labelling output. */
    moduleNameForPath(filePath) {
        return (this.queryOne('SELECT module FROM modules WHERE path = ? ORDER BY is_alias LIMIT 1', filePath)?.module ?? null);
    }
    // --------------------------------------------------------------- nodes
    /**
     * True when this id already belongs to a node we parsed ourselves. A stub
     * from a linked repo must not land on top of one: ids are
     * repo:path:kind:qualified and the repo segment defaults to the directory
     * basename, so two checkouts that happen to share a directory name collide,
     * and the local node would be flipped to external = 1 and disappear from
     * nodeCount, nodesInFile and overview.
     */
    hasLocalNode(id) {
        return this.queryOne('SELECT COUNT(*) AS n FROM nodes WHERE id = ? AND external = 0', id)?.n === 1;
    }
    insertNode(node, external = false) {
        this.exec(`INSERT INTO nodes (id, repo, path, name, name_lower, qualified, kind, lang, line_start, line_end, signature, doc, exported, external)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         repo = excluded.repo, path = excluded.path, name = excluded.name, name_lower = excluded.name_lower,
         qualified = excluded.qualified, kind = excluded.kind, lang = excluded.lang,
         line_start = excluded.line_start, line_end = excluded.line_end,
         signature = excluded.signature, doc = excluded.doc, exported = excluded.exported, external = excluded.external`, node.id, node.repo, node.path, node.name, node.name.toLowerCase(), node.qualified, node.kind, node.lang, node.lineStart, node.lineEnd, node.signature, node.doc, node.exported ? 1 : 0, external ? 1 : 0);
    }
    nodeCount() {
        return this.queryOne('SELECT COUNT(*) AS n FROM nodes WHERE external = 0')?.n ?? 0;
    }
    getNode(id) {
        const row = this.queryOne(`SELECT ${NODE_COLS} FROM nodes WHERE id = ?`, id);
        return row ? toNode(row) : null;
    }
    getNodes(ids) {
        const out = [];
        for (const chunk of chunked(ids, 400)) {
            const holes = chunk.map(() => '?').join(',');
            out.push(...this.queryAll(`SELECT ${NODE_COLS} FROM nodes WHERE id IN (${holes})`, ...chunk).map(toNode));
        }
        return out;
    }
    nodesByName(name) {
        return this.queryAll(`SELECT ${NODE_COLS} FROM nodes WHERE name = ? ORDER BY path, line_start`, name).map(toNode);
    }
    nodesByNameLower(name) {
        return this.queryAll(`SELECT ${NODE_COLS} FROM nodes WHERE name_lower = ? ORDER BY path, line_start`, name.toLowerCase()).map(toNode);
    }
    nodesByQualified(qualified) {
        return this.queryAll(`SELECT ${NODE_COLS} FROM nodes WHERE qualified = ? ORDER BY path, line_start`, qualified).map(toNode);
    }
    nodesInFile(filePath) {
        return this.queryAll(`SELECT ${NODE_COLS} FROM nodes WHERE path = ? AND external = 0 ORDER BY line_start`, filePath).map(toNode);
    }
    nodesUnderPath(prefix) {
        const like = prefix.endsWith('/') ? `${prefix}%` : `${prefix}/%`;
        return this.queryAll(`SELECT ${NODE_COLS} FROM nodes WHERE external = 0 AND (path = ? OR path LIKE ?) ORDER BY path, line_start`, prefix, like).map(toNode);
    }
    allNodesLite() {
        return this.queryAll('SELECT id, name, path, kind, lang, qualified, exported FROM nodes WHERE external = 0').map((r) => ({
            id: r.id,
            name: r.name,
            path: r.path,
            kind: r.kind,
            lang: r.lang,
            qualified: r.qualified,
            exported: r.exported === 1,
        }));
    }
    /**
     * Candidate set for fuzzy search. SQLite narrows by subsequence with LIKE so
     * the JS scorer only ever sees a few hundred rows instead of the whole table.
     */
    searchCandidates(query, limit) {
        const chars = query.toLowerCase().replace(/[%_\\]/g, '');
        const like = `%${chars.split('').join('%')}%`;
        return this.queryAll(`SELECT ${NODE_COLS} FROM nodes WHERE name_lower LIKE ? ORDER BY LENGTH(name), path LIMIT ?`, like, limit).map(toNode);
    }
    kindCounts() {
        return this.queryAll('SELECT kind, COUNT(*) AS n FROM nodes WHERE external = 0 GROUP BY kind ORDER BY n DESC').map((r) => ({ kind: r.kind, count: r.n }));
    }
    langCounts() {
        return this.queryAll('SELECT lang, COUNT(*) AS n FROM files WHERE lang IS NOT NULL GROUP BY lang ORDER BY n DESC').map((r) => ({ lang: r.lang, count: r.n }));
    }
    deleteOrphanExternalNodes() {
        return this.exec('DELETE FROM nodes WHERE external = 1 AND id NOT IN (SELECT dst_id FROM edges)');
    }
    // --------------------------------------------------------------- edges
    insertEdge(edge, rid = null) {
        this.exec(`INSERT INTO edges (src_id, dst_id, type, confidence, path, line, rid) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(src_id, dst_id, type, path, line) DO UPDATE SET
         confidence = excluded.confidence, rid = excluded.rid`, edge.srcId, edge.dstId, edge.type, edge.confidence, edge.path, edge.line, rid);
    }
    edgeCount() {
        return this.queryOne('SELECT COUNT(*) AS n FROM edges')?.n ?? 0;
    }
    deleteEdgesForRefs(rids) {
        for (const chunk of chunked(rids, 400)) {
            const holes = chunk.map(() => '?').join(',');
            this.exec(`DELETE FROM edges WHERE rid IN (${holes})`, ...chunk);
        }
    }
    outgoing(ids) {
        return this.edgesBy('src_id', ids);
    }
    incoming(ids) {
        return this.edgesBy('dst_id', ids);
    }
    edgesBy(column, ids) {
        const out = [];
        for (const chunk of chunked(ids, 400)) {
            const holes = chunk.map(() => '?').join(',');
            out.push(...this.queryAll(`SELECT ${EDGE_COLS} FROM edges WHERE ${column} IN (${holes})`, ...chunk).map(toEdge));
        }
        return out;
    }
    /**
     * How many other symbols depend on each symbol, for ranking in overview and
     * impact. `defines` is excluded: every symbol is defined by its own module,
     * so counting it would give everything a floor of one and bury the real
     * hubs. It would also make every entry point look like it has a caller.
     */
    degreeCounts() {
        const map = new Map();
        for (const row of this.queryAll("SELECT dst_id, COUNT(*) AS n FROM edges WHERE type != 'defines' GROUP BY dst_id")) {
            map.set(row.dst_id, row.n);
        }
        return map;
    }
    edgeTypeCounts() {
        return this.queryAll('SELECT type, confidence, COUNT(*) AS n FROM edges GROUP BY type, confidence ORDER BY n DESC').map((r) => ({ type: r.type, confidence: r.confidence, count: r.n }));
    }
    // ---------------------------------------------------------------- refs
    insertRef(ref) {
        const result = this.stmt(`INSERT INTO refs (src_id, path, line, type, target_kind, name, qualifier, module, symbol, alias, lang, resolved)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0)`).run(ref.srcId, ref.path, ref.line, ref.type, ref.targetKind, ref.name, ref.qualifier, ref.module, ref.symbol, ref.alias, ref.lang);
        return Number(result.lastInsertRowid);
    }
    refsInFiles(paths) {
        const out = [];
        for (const chunk of chunked(paths, 300)) {
            const holes = chunk.map(() => '?').join(',');
            out.push(...this.queryAll(`SELECT ${REF_COLS} FROM refs WHERE path IN (${holes})`, ...chunk).map(toRef));
        }
        return out;
    }
    refsByNames(names) {
        const out = [];
        const seen = new Set();
        for (const chunk of chunked(names, 300)) {
            const holes = chunk.map(() => '?').join(',');
            const rows = this.queryAll(`SELECT ${REF_COLS} FROM refs WHERE name IN (${holes}) OR symbol IN (${holes})`, ...chunk, ...chunk);
            for (const row of rows) {
                if (seen.has(row.rid))
                    continue;
                seen.add(row.rid);
                out.push(toRef(row));
            }
        }
        return out;
    }
    unresolvedRefs() {
        return this.queryAll(`SELECT ${REF_COLS} FROM refs WHERE resolved = 0`).map(toRef);
    }
    unresolvedRefCount() {
        return this.queryOne('SELECT COUNT(*) AS n FROM refs WHERE resolved = 0')?.n ?? 0;
    }
    /** Imports declared in one file, which is what alias lookup reads. */
    importRefsInFile(filePath) {
        return this.queryAll(`SELECT ${REF_COLS} FROM refs WHERE path = ? AND target_kind = 'module'`, filePath).map(toRef);
    }
    allImportRefs() {
        return this.queryAll(`SELECT ${REF_COLS} FROM refs WHERE target_kind = 'module'`).map(toRef);
    }
    markRefsResolved(rids, resolved) {
        for (const chunk of chunked(rids, 400)) {
            const holes = chunk.map(() => '?').join(',');
            this.exec(`UPDATE refs SET resolved = ${resolved ? 1 : 0} WHERE rid IN (${holes})`, ...chunk);
        }
    }
}
function toNode(row) {
    return {
        id: row.id,
        repo: row.repo,
        path: row.path,
        name: row.name,
        qualified: row.qualified,
        kind: row.kind,
        lang: row.lang,
        lineStart: row.line_start,
        lineEnd: row.line_end,
        signature: row.signature,
        doc: row.doc,
        exported: row.exported === 1,
    };
}
function toEdge(row) {
    return {
        srcId: row.src_id,
        dstId: row.dst_id,
        type: row.type,
        confidence: row.confidence,
        path: row.path,
        line: row.line,
    };
}
function toRef(row) {
    return {
        rid: row.rid,
        srcId: row.src_id,
        path: row.path,
        line: row.line,
        type: row.type,
        targetKind: row.target_kind,
        name: row.name,
        qualifier: row.qualifier,
        module: row.module,
        symbol: row.symbol,
        alias: row.alias,
        lang: row.lang,
    };
}
/** SQLite caps bound parameters, so long IN lists have to be split. */
function* chunked(items, size) {
    for (let i = 0; i < items.length; i += size) {
        yield items.slice(i, i + size);
    }
}
//# sourceMappingURL=store.js.map