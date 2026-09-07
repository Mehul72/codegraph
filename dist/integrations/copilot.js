import os from 'node:os';
import path from 'node:path';
import { pathExists } from '../util/fs.js';
import { objectAt, peekObject, pruneEmpty, updateJsonFile } from './jsonfile.js';
import { stripMarkedFile, writeMarkedFile } from './markers.js';
import { genericInstructions } from './instructions.js';
import { emptyReport } from './types.js';
const INSTRUCTIONS_RELATIVE = path.join('.github', 'copilot-instructions.md');
export const copilotIntegration = {
    id: 'copilot',
    label: 'GitHub Copilot',
    async detect(repoRoot) {
        const candidates = [
            path.join(repoRoot, '.vscode'),
            path.join(repoRoot, INSTRUCTIONS_RELATIVE),
            path.join(os.homedir(), '.vscode'),
            path.join(os.homedir(), 'Library', 'Application Support', 'Code'),
            path.join(os.homedir(), '.config', 'Code'),
            path.join(os.homedir(), 'AppData', 'Roaming', 'Code'),
        ];
        for (const candidate of candidates) {
            if (await pathExists(candidate))
                return true;
        }
        return false;
    },
    async install(ctx) {
        const report = emptyReport();
        const { repoRoot, server } = ctx;
        // VS Code keys workspace MCP servers under "servers", not "mcpServers".
        const mcpFile = path.join(repoRoot, '.vscode', 'mcp.json');
        if (await updateJsonFile(mcpFile, (root) => {
            objectAt(root, 'servers')['codegraph'] = { type: 'stdio', command: server.command, args: server.args };
            return true;
        })) {
            report.changed.push(path.join('.vscode', 'mcp.json'));
        }
        if (await writeMarkedFile(path.join(repoRoot, INSTRUCTIONS_RELATIVE), genericInstructions())) {
            report.changed.push(INSTRUCTIONS_RELATIVE);
        }
        return report;
    },
    async uninstall(repoRoot) {
        const report = emptyReport();
        if (await updateJsonFile(path.join(repoRoot, '.vscode', 'mcp.json'), (root) => {
            const servers = peekObject(root, 'servers');
            if (!servers || !('codegraph' in servers))
                return false;
            delete servers['codegraph'];
            pruneEmpty(root, 'servers');
            return true;
        })) {
            report.changed.push(path.join('.vscode', 'mcp.json'));
        }
        if (await stripMarkedFile(path.join(repoRoot, INSTRUCTIONS_RELATIVE))) {
            report.changed.push(INSTRUCTIONS_RELATIVE);
        }
        return report;
    },
};
//# sourceMappingURL=copilot.js.map