/**
 * The hook path. Agents call this after writing a file, so it has to be quiet,
 * quick, and completely harmless when something is wrong. A failure here must
 * never surface as an error in the agent's tool output, because the staleness
 * check will pick the change up on the next query anyway.
 */
export declare function touchCommand(files: string[]): Promise<void>;
