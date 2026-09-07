/**
 * Everything logs to stderr. The MCP server owns stdout for JSON-RPC frames,
 * so a stray console.log there corrupts the protocol.
 */
export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';
export declare function setLogLevel(level: LogLevel): void;
export declare const log: {
    error(msg: string): void;
    warn(msg: string): void;
    info(msg: string): void;
    debug(msg: string): void;
};
/**
 * A one-line progress indicator that rewrites itself. Falls back to periodic
 * newline-terminated lines when stderr is not a TTY, so piped logs stay sane.
 */
export declare class Progress {
    private readonly label;
    private readonly tty;
    private lastWidth;
    private lastPrint;
    private done;
    constructor(label: string);
    update(detail: string): void;
    finish(detail: string): void;
}
