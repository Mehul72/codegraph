/**
 * Node version gate plus warning cleanup. node:sqlite is still flagged
 * experimental, and its warning would otherwise show up in the middle of
 * every command's output.
 *
 * 22.13 rather than 22.5, which is when node:sqlite stopped needing
 * --experimental-sqlite. Supporting the window below it meant passing that
 * flag, and a flag is not a thing a released Node either has or ignores: a
 * runtime that has dropped it refuses to start at all.
 */
export declare function requiredNodeVersion(): string;
export declare function checkNodeVersion(): void;
export declare function silenceExperimentalWarnings(): void;
