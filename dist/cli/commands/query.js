import { Session } from '../../session.js';
import { runTool } from '../../mcp/dispatch.js';
/**
 * Every query subcommand funnels through the same dispatcher the MCP server
 * uses, so `codegraph impact-of X` and the impact_of tool cannot disagree.
 * That makes the CLI a usable debugger for what the agent is actually seeing.
 */
export async function runQueryCommand(tool, args) {
    const session = await Session.open();
    try {
        await session.ensureFresh({ debounceMs: 0 });
        const text = await runTool(session, tool, args);
        process.stdout.write(text + '\n');
    }
    finally {
        session.close();
    }
}
/** Shared option parsing, since every query command takes a budget. */
export function numberOption(value) {
    if (value === undefined)
        return undefined;
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}
//# sourceMappingURL=query.js.map