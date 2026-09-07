/**
 * Stdio MCP server. All four target agents speak MCP, so this is the only
 * transport and the only integration surface. stdout belongs to JSON-RPC;
 * everything we want to say goes to stderr through the logger.
 */
export declare function startMcpServer(options?: {
    cwd?: string;
}): Promise<void>;
