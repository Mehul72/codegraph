import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { claudeIntegration } from './claude.js';
import { codexIntegration } from './codex.js';
import { copilotIntegration } from './copilot.js';
import { cursorIntegration } from './cursor.js';
const run = promisify(execFile);
export const INTEGRATIONS = [
    claudeIntegration,
    cursorIntegration,
    codexIntegration,
    copilotIntegration,
];
export function integrationById(id) {
    return INTEGRATIONS.find((agent) => agent.id === id.toLowerCase()) ?? null;
}
export async function detectIntegrations(repoRoot) {
    const found = [];
    for (const agent of INTEGRATIONS) {
        if (await agent.detect(repoRoot))
            found.push(agent);
    }
    return found;
}
/**
 * What npx has to fetch to get this tool.
 *
 * The bare name `codegraph` belongs to an unrelated package on the npm
 * registry, so it can never appear in a launcher: an agent told to run
 * `npx -y codegraph mcp` downloads a stranger's package and runs it as an
 * MCP server, and the only symptom is that no tool ever answers.
 */
export const PACKAGE_SPEC = 'github:Mehul72/codegraph';
/**
 * How the agent should launch our MCP server.
 *
 * A bare `codegraph` is best: it stays correct across upgrades and reads
 * cleanly in a config file that may get committed. When it is not on PATH,
 * because the tool was run through npx and never installed, we fall back to
 * npx so the config still works on a machine that has neither.
 *
 * Neither form pins a repo path. Agents launch MCP servers with the project
 * as the working directory, and codegraph walks up to the repo root from
 * there, so the same config file works for everyone on the team.
 */
export async function resolveServerCommand() {
    if (await onPath('codegraph'))
        return { command: 'codegraph', args: ['mcp'] };
    return { command: 'npx', args: ['-y', PACKAGE_SPEC, 'mcp'] };
}
async function onPath(binary) {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    try {
        const { stdout } = await run(finder, [binary]);
        return stdout.trim() !== '';
    }
    catch {
        return false;
    }
}
//# sourceMappingURL=index.js.map