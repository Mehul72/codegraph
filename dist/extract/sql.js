import { SymbolBuilder } from './builder.js';
import { cleanDoc } from './ast.js';
import { tablesInSql } from './sqlrefs.js';
/** One identifier, optionally delimited. Schema qualifiers are dropped here. */
const NAME = '[`"\\[]?[A-Za-z_][\\w$]*[`"\\]]?';
const TABLE_REF = `(?:${NAME}\\s*\\.\\s*)*(${NAME})`;
const CREATE_TABLE = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?table\\s+(?:if\\s+not\\s+exists\\s+)?${TABLE_REF}`, 'i');
// A materialized view is a view as far as the graph is concerned.
const CREATE_VIEW = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(?:materialized\\s+)?view\\s+(?:if\\s+not\\s+exists\\s+)?${TABLE_REF}`, 'i');
const CREATE_ROUTINE = new RegExp(`^create\\s+(?:or\\s+replace\\s+)?(function|procedure)\\s+${TABLE_REF}`, 'i');
// Whatever sits between INDEX and ON is the index name plus dialect noise
// (CONCURRENTLY, IF NOT EXISTS), and none of it can contain a parenthesis.
const CREATE_INDEX = new RegExp(`^create\\s+(?:unique\\s+)?index\\b[^(]*?\\bon\\s+${TABLE_REF}`, 'i');
const ALTER_TABLE = new RegExp(`^alter\\s+table\\s+(?:only\\s+)?(?:if\\s+exists\\s+)?${TABLE_REF}`, 'i');
/** Covers both the inline column form and a table level FOREIGN KEY clause. */
const REFERENCES = new RegExp(`\\breferences\\s+${TABLE_REF}`, 'gi');
const DOLLAR_TAG = /\$(?:[A-Za-z_]\w*)?\$/y;
export const sqlExtractor = {
    id: 'sql',
    extensions: ['.sql', '.ddl'],
    grammar: null,
    extract(input) {
        const { path: filePath, source, repo } = input;
        const build = new SymbolBuilder(repo, filePath, 'sql');
        const lineStarts = lineIndex(source);
        const moduleNode = build.module({
            name: fileStem(filePath),
            qualified: filePath.replace(/\.[^./]+$/, ''),
            lineEnd: lineStarts.length,
        });
        const scan = { build, moduleNode, lines: source.split('\n'), lineStarts, declared: new Map() };
        const statements = splitStatements(maskNoise(source));
        // Two passes, because a file is free to ALTER a table it declares further
        // down, and the reference has to hang off the table node when we have one.
        for (const statement of statements)
            declare(statement, scan);
        for (const statement of statements)
            relate(statement, scan);
        return build.result();
    },
};
function declare(statement, scan) {
    const table = CREATE_TABLE.exec(statement.text);
    if (table) {
        define(statement, scan, bareName(table[1]), 'table', 'CREATE TABLE');
        return;
    }
    // A view has no kind of its own. 'table' is the closest one, and it is also
    // what application SQL sees: something you select from by name.
    const view = CREATE_VIEW.exec(statement.text);
    if (view) {
        define(statement, scan, bareName(view[1]), 'table', 'CREATE VIEW');
        return;
    }
    const routine = CREATE_ROUTINE.exec(statement.text);
    if (routine) {
        const keyword = (routine[1] ?? 'function').toUpperCase();
        define(statement, scan, bareName(routine[2]), 'function', `CREATE ${keyword}`);
    }
}
function define(statement, scan, name, kind, keyword) {
    if (name === '')
        return;
    const line = lineAt(scan.lineStarts, statement.start);
    const node = scan.build.add({
        name,
        kind,
        qualified: name,
        lineStart: line,
        lineEnd: lineAt(scan.lineStarts, statement.end - 1),
        signature: `${keyword} ${name}`,
        doc: leadingComment(scan, line),
    });
    scan.build.edge(scan.moduleNode, { kind: 'id', id: node.id }, 'defines', line);
    if (!scan.declared.has(name))
        scan.declared.set(name, node);
}
function relate(statement, scan) {
    const table = CREATE_TABLE.exec(statement.text);
    if (table) {
        const node = scan.declared.get(bareName(table[1]));
        if (node)
            recordForeignKeys(statement, node, scan);
        return;
    }
    const view = CREATE_VIEW.exec(statement.text);
    if (view) {
        const node = scan.declared.get(bareName(view[1]));
        if (node)
            recordViewQueries(statement, view[0].length, node, scan);
        return;
    }
    const alter = ALTER_TABLE.exec(statement.text);
    if (alter) {
        // The altered table is often declared in another file. When it is, the
        // module node owns the reference and resolution places it by name.
        const from = scan.declared.get(bareName(alter[1])) ?? scan.moduleNode;
        recordForeignKeys(statement, from, scan);
        return;
    }
    const index = CREATE_INDEX.exec(statement.text);
    if (index) {
        const target = bareName(index[1]);
        if (target !== '')
            scan.build.ref(scan.moduleNode, 'references', target, lineAt(scan.lineStarts, statement.start));
    }
}
function recordForeignKeys(statement, from, scan) {
    REFERENCES.lastIndex = 0;
    let match;
    while ((match = REFERENCES.exec(statement.text)) !== null) {
        const target = bareName(match[1]);
        if (target === '')
            continue;
        scan.build.ref(from, 'references', target, lineAt(scan.lineStarts, statement.start + match.index));
    }
}
/**
 * A view is the one place where DDL contains a query, so the tables in its
 * body are `queries` edges. They all take the line of the CREATE, since
 * tablesInSql reports names and not positions.
 */
function recordViewQueries(statement, headLength, view, scan) {
    const line = lineAt(scan.lineStarts, statement.start);
    for (const table of tablesInSql(statement.text.slice(headLength))) {
        scan.build.ref(view, 'queries', table, line);
    }
}
/**
 * Comments, string literals and dollar-quoted bodies become spaces, and every
 * other character keeps its offset so line numbers stay exact. Delimited
 * identifiers survive: "orders" and `orders` are names we still have to read,
 * and the scan only has to step over them so that a quoted `--` or `'` inside
 * one cannot open a comment or a literal.
 */
function maskNoise(source) {
    const chars = source.split('');
    const blank = (from, to) => {
        for (let k = from; k < to; k++) {
            if (chars[k] !== '\n')
                chars[k] = ' ';
        }
    };
    let i = 0;
    while (i < source.length) {
        const ch = source[i];
        if (ch === '-' && source[i + 1] === '-') {
            const stop = source.indexOf('\n', i);
            const end = stop === -1 ? source.length : stop;
            blank(i, end);
            i = end;
            continue;
        }
        if (ch === '/' && source[i + 1] === '*') {
            const stop = source.indexOf('*/', i + 2);
            const end = stop === -1 ? source.length : stop + 2;
            blank(i, end);
            i = end;
            continue;
        }
        if (ch === "'") {
            const end = closingQuote(source, i, "'");
            blank(i, end);
            i = end;
            continue;
        }
        if (ch === '"' || ch === '`') {
            i = closingQuote(source, i, ch);
            continue;
        }
        if (ch === '$') {
            DOLLAR_TAG.lastIndex = i;
            const tag = DOLLAR_TAG.exec(source);
            if (tag) {
                const stop = source.indexOf(tag[0], i + tag[0].length);
                const end = stop === -1 ? source.length : stop + tag[0].length;
                blank(i, end);
                i = end;
                continue;
            }
        }
        i++;
    }
    return chars.join('');
}
/**
 * Offset just past the closing quote of the run that starts at `open`. A
 * doubled quote is an escaped one, which is the standard SQL escape; dialect
 * backslash escapes are not treated as special.
 */
function closingQuote(source, open, quote) {
    let k = open + 1;
    while (k < source.length) {
        if (source[k] !== quote) {
            k++;
            continue;
        }
        if (source[k + 1] === quote) {
            k += 2;
            continue;
        }
        return k + 1;
    }
    return source.length;
}
/**
 * Statements, split on top-level semicolons. Parentheses are tracked so that a
 * stray semicolon inside a body cannot cut a statement in half.
 */
function splitStatements(masked) {
    const statements = [];
    let start = 0;
    let depth = 0;
    const push = (from, to) => {
        let head = from;
        let tail = to;
        while (head < tail && isSpace(masked[head]))
            head++;
        while (tail > head && isSpace(masked[tail - 1]))
            tail--;
        if (tail > head)
            statements.push({ start: head, end: tail, text: masked.slice(head, tail) });
    };
    for (let i = 0; i < masked.length; i++) {
        const ch = masked[i];
        if (ch === '(')
            depth++;
        else if (ch === ')')
            depth = Math.max(0, depth - 1);
        else if (ch === ';' && depth === 0) {
            push(start, i);
            start = i + 1;
        }
    }
    push(start, masked.length);
    return statements;
}
function isSpace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}
/**
 * Names are lower-cased because src/extract/sqlrefs.ts lower-cases the tables
 * it finds in SQL strings embedded in application code, and the resolver
 * matches those against these nodes by name. That match is what connects a
 * Java DAO to the schema file, and different casing breaks it silently.
 * Unquoted SQL identifiers are case-insensitive anyway, so nothing is lost.
 */
function bareName(raw) {
    if (!raw)
        return '';
    return raw.replace(/[`"[\]]/g, '').trim().toLowerCase();
}
/** The `--` comment block directly above a statement, first line only. */
function leadingComment(scan, line) {
    const collected = [];
    for (let row = line - 2; row >= 0; row--) {
        const text = (scan.lines[row] ?? '').trim();
        if (text.startsWith('--')) {
            collected.unshift(text.replace(/^-+\s?/, ''));
            continue;
        }
        break;
    }
    return cleanDoc(collected.join('\n'));
}
/** Offset of the start of every line, so an offset can become a line number. */
function lineIndex(source) {
    const starts = [0];
    for (let i = 0; i < source.length; i++) {
        if (source[i] === '\n')
            starts.push(i + 1);
    }
    return starts;
}
function lineAt(starts, offset) {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        const start = starts[mid];
        if (start !== undefined && start <= offset)
            low = mid;
        else
            high = mid - 1;
    }
    return low + 1;
}
function fileStem(relPath) {
    const file = relPath.split('/').pop() ?? relPath;
    return file.replace(/\.[^.]+$/, '');
}
//# sourceMappingURL=sql.js.map