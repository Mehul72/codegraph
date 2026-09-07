/**
 * Every query subcommand funnels through the same dispatcher the MCP server
 * uses, so `codegraph impact-of X` and the impact_of tool cannot disagree.
 * That makes the CLI a usable debugger for what the agent is actually seeing.
 */
export declare function runQueryCommand(tool: string, args: Record<string, unknown>): Promise<void>;
/** Shared option parsing, since every query command takes a budget. */
export declare function numberOption(value: string | undefined): number | undefined;
