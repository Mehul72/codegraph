import path from 'node:path';
import { Session } from '../../session.js';
import { indexSummary, toolContext } from '../../query/tools.js';
import { detectIntegrations } from '../../integrations/index.js';
import { ParserPool } from '../../extract/parser.js';
import { describeHead } from '../../util/git.js';
import { pathExistsSync } from '../../util/fs.js';
import { formatDuration } from '../../util/text.js';
export async function statusCommand() {
    const out = (line) => process.stdout.write(line + '\n');
    const session = await Session.open();
    try {
        const started = Date.now();
        const refresh = await session.ensureFresh({ debounceMs: 0 });
        const freshnessMs = Date.now() - started;
        out(indexSummary(toolContext(session)));
        const indexedAt = session.indexedAt();
        if (indexedAt)
            out(`updated   ${indexedAt.toISOString().replace('T', ' ').slice(0, 19)}`);
        const head = await describeHead(session.repoRoot);
        if (head)
            out(`git       ${head}`);
        out(`freshness ${formatDuration(freshnessMs)} to check${refresh && refresh.filesIndexed > 0 ? `, reindexed ${refresh.filesIndexed} changed files` : ', nothing changed'}`);
        if (session.config.links.length > 0) {
            out(`links     ${session.config.links.map((l) => path.basename(l)).join(', ')}`);
        }
        const grammars = new ParserPool().availableGrammars();
        out(`grammars  ${grammars.length > 0 ? grammars.map((g) => g.replace(/^tree-sitter-|\.wasm$/g, '')).join(', ') : 'none found'}`);
        const agents = await detectIntegrations(session.repoRoot);
        if (agents.length === 0) {
            out('agents    none detected');
        }
        else {
            const rows = agents.map((agent) => `${agent.label}${wiredMarker(session.repoRoot, agent.id)}`);
            out(`agents    ${rows.join(', ')}`);
            out('          (wired) means the config file codegraph writes for that agent exists');
        }
    }
    finally {
        session.close();
    }
}
/** Look for the file each integration writes, rather than re-running install. */
function wiredMarker(repoRoot, agentId) {
    const probes = {
        claude: ['.mcp.json'],
        cursor: [path.join('.cursor', 'mcp.json')],
        copilot: [path.join('.vscode', 'mcp.json')],
        codex: ['AGENTS.md'],
    };
    const files = probes[agentId] ?? [];
    return files.some((file) => pathExistsSync(path.join(repoRoot, file))) ? ' (wired)' : '';
}
//# sourceMappingURL=status.js.map