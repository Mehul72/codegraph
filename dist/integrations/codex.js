import os from 'node:os';
import path from 'node:path';
import { codexConfigPath } from '../config/paths.js';
import { pathExists } from '../util/fs.js';
import { stripMarkedFile, TOML_MARKERS, writeMarkedFile } from './markers.js';
import { genericInstructions } from './instructions.js';
import { emptyReport } from './types.js';
export const codexIntegration = {
    id: 'codex',
    label: 'Codex',
    async detect(repoRoot) {
        const candidates = [
            path.join(os.homedir(), '.codex'),
            codexConfigPath(),
            path.join(repoRoot, 'AGENTS.md'),
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
        // Codex keeps MCP servers in a global TOML file. Rather than take on a
        // TOML parser to edit one table, our entry sits inside comment markers,
        // which makes install idempotent and uninstall exact.
        const body = [
            '[mcp_servers.codegraph]',
            `command = ${tomlString(server.command)}`,
            `args = [${server.args.map(tomlString).join(', ')}]`,
        ].join('\n');
        const configFile = codexConfigPath();
        if (await writeMarkedFile(configFile, body, TOML_MARKERS)) {
            report.changed.push(configFile);
        }
        if (await writeMarkedFile(path.join(repoRoot, 'AGENTS.md'), genericInstructions())) {
            report.changed.push('AGENTS.md');
        }
        return report;
    },
    async uninstall(repoRoot) {
        const report = emptyReport();
        const configFile = codexConfigPath();
        if (await stripMarkedFile(configFile, TOML_MARKERS))
            report.changed.push(configFile);
        if (await stripMarkedFile(path.join(repoRoot, 'AGENTS.md')))
            report.changed.push('AGENTS.md');
        return report;
    },
};
function tomlString(value) {
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}
//# sourceMappingURL=codex.js.map