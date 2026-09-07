import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { Session } from '../session.js';
import { TOOL_DEFINITIONS } from './definitions.js';
import { runTool } from './dispatch.js';
import { log } from '../util/log.js';
import { PACKAGE_VERSION } from '../version.js';
/**
 * Stdio MCP server. All four target agents speak MCP, so this is the only
 * transport and the only integration surface. stdout belongs to JSON-RPC;
 * everything we want to say goes to stderr through the logger.
 */
export async function startMcpServer(options = {}) {
    const session = await Session.open({ cwd: options.cwd, requireIndex: false });
    const server = new Server({ name: 'codegraph', version: PACKAGE_VERSION }, { capabilities: { tools: {} } });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({
        tools: TOOL_DEFINITIONS.map((tool) => ({
            name: tool.name,
            description: tool.description,
            inputSchema: tool.inputSchema,
        })),
    }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const args = (request.params.arguments ?? {});
        try {
            // Every call starts by catching up with edits made since the last one.
            // This is what makes the index correct inside a live session.
            await session.ensureFresh();
            const text = await runTool(session, name, args);
            return { content: [{ type: 'text', text }] };
        }
        catch (err) {
            const message = err.message;
            log.warn(`${name} failed: ${message}`);
            return { content: [{ type: 'text', text: `codegraph ${name} failed: ${message}` }], isError: true };
        }
    });
    const shutdown = () => {
        session.close();
        process.exit(0);
    };
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);
    await server.connect(new StdioServerTransport());
    log.debug(`codegraph mcp server ready for ${session.repoRoot}`);
}
//# sourceMappingURL=server.js.map