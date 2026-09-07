/**
 * Everything logs to stderr. The MCP server owns stdout for JSON-RPC frames,
 * so a stray console.log there corrupts the protocol.
 */
const RANK = {
    silent: 0,
    error: 1,
    warn: 2,
    info: 3,
    debug: 4,
};
/**
 * An unrecognised CODEGRAPH_LOG is ignored rather than trusted. Casting it
 * straight through left `RANK[current]` undefined, every level comparison
 * false, and the tool completely silent down to and including errors, which
 * is the opposite of what someone setting the variable was reaching for.
 */
function parseLevel(value) {
    return value !== undefined && Object.hasOwn(RANK, value) ? value : null;
}
let current = parseLevel(process.env.CODEGRAPH_LOG) ?? 'info';
export function setLogLevel(level) {
    if (Object.hasOwn(RANK, level))
        current = level;
}
function enabled(level) {
    return RANK[level] <= RANK[current];
}
function write(line) {
    process.stderr.write(line + '\n');
}
export const log = {
    error(msg) {
        if (enabled('error'))
            write(`error: ${msg}`);
    },
    warn(msg) {
        if (enabled('warn'))
            write(`warning: ${msg}`);
    },
    info(msg) {
        if (enabled('info'))
            write(msg);
    },
    debug(msg) {
        if (enabled('debug'))
            write(`debug: ${msg}`);
    },
};
/**
 * A one-line progress indicator that rewrites itself. Falls back to periodic
 * newline-terminated lines when stderr is not a TTY, so piped logs stay sane.
 */
export class Progress {
    label;
    tty;
    lastWidth = 0;
    lastPrint = 0;
    done = false;
    constructor(label) {
        this.label = label;
        this.tty = Boolean(process.stderr.isTTY) && enabled('info');
    }
    update(detail) {
        if (this.done || !enabled('info'))
            return;
        const now = Date.now();
        if (this.tty) {
            if (now - this.lastPrint < 60)
                return;
            this.lastPrint = now;
            const line = `${this.label} ${detail}`;
            process.stderr.write('\r' + line + ' '.repeat(Math.max(0, this.lastWidth - line.length)));
            this.lastWidth = line.length;
        }
        else {
            if (now - this.lastPrint < 3000)
                return;
            this.lastPrint = now;
            write(`${this.label} ${detail}`);
        }
    }
    finish(detail) {
        if (this.done)
            return;
        this.done = true;
        if (!enabled('info'))
            return;
        if (this.tty) {
            const line = `${this.label} ${detail}`;
            process.stderr.write('\r' + line + ' '.repeat(Math.max(0, this.lastWidth - line.length)) + '\n');
        }
        else {
            write(`${this.label} ${detail}`);
        }
    }
}
//# sourceMappingURL=log.js.map