import os from 'node:os';
import path from 'node:path';
import { pathExists } from '../util/fs.js';
import { objectAt, peekObject, pruneEmpty, updateJsonFile } from './jsonfile.js';
import { stripMarkedFile, writeMarkedFile } from './markers.js';
import { claudeInstructions } from './instructions.js';
import { emptyReport, type Integration, type IntegrationReport, type InstallContext } from './types.js';

const HOOK_MATCHER = 'Edit|Write|MultiEdit';

export const claudeIntegration: Integration = {
  id: 'claude',
  label: 'Claude Code',

  async detect(repoRoot: string): Promise<boolean> {
    const candidates = [
      path.join(repoRoot, '.claude'),
      path.join(repoRoot, 'CLAUDE.md'),
      path.join(repoRoot, '.mcp.json'),
      path.join(os.homedir(), '.claude'),
      path.join(os.homedir(), '.claude.json'),
    ];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return true;
    }
    return false;
  },

  async install(ctx: InstallContext): Promise<IntegrationReport> {
    const report = emptyReport();
    const { repoRoot, server } = ctx;

    const mcpFile = path.join(repoRoot, '.mcp.json');
    if (
      await updateJsonFile(mcpFile, (root) => {
        objectAt(root, 'mcpServers')['codegraph'] = { command: server.command, args: server.args };
        return true;
      })
    ) {
      report.changed.push('.mcp.json');
    }

    if (await writeMarkedFile(path.join(repoRoot, 'CLAUDE.md'), claudeInstructions())) {
      report.changed.push('CLAUDE.md');
    }

    // Reindexing after an edit is an optimisation, never a blocker, so the
    // hook is fire and forget: it backgrounds itself and always exits 0.
    const settingsFile = path.join(repoRoot, '.claude', 'settings.json');
    const hookCommand = `${quote(server.command)} touch "$CLAUDE_FILE_PATHS" >/dev/null 2>&1 &`;

    if (
      await updateJsonFile(settingsFile, (root) => {
        const hooks = objectAt(root, 'hooks');
        const list = Array.isArray(hooks.PostToolUse) ? (hooks.PostToolUse as unknown[]) : [];
        const withoutOurs = list.filter((entry) => !isOurHook(entry));
        withoutOurs.push({
          matcher: HOOK_MATCHER,
          hooks: [{ type: 'command', command: hookCommand }],
        });
        hooks.PostToolUse = withoutOurs;
        return true;
      })
    ) {
      report.changed.push(path.join('.claude', 'settings.json'));
    }

    return report;
  },

  async uninstall(repoRoot: string): Promise<IntegrationReport> {
    const report = emptyReport();

    if (
      await updateJsonFile(path.join(repoRoot, '.mcp.json'), (root) => {
        const servers = peekObject(root, 'mcpServers');
        if (!servers || !('codegraph' in servers)) return false;
        delete servers['codegraph'];
        pruneEmpty(root, 'mcpServers');
        return true;
      })
    ) {
      report.changed.push('.mcp.json');
    }

    if (await stripMarkedFile(path.join(repoRoot, 'CLAUDE.md'))) report.changed.push('CLAUDE.md');

    if (
      await updateJsonFile(path.join(repoRoot, '.claude', 'settings.json'), (root) => {
        const hooks = peekObject(root, 'hooks');
        if (!hooks || !Array.isArray(hooks.PostToolUse)) return false;
        const kept = (hooks.PostToolUse as unknown[]).filter((entry) => !isOurHook(entry));
        if (kept.length === (hooks.PostToolUse as unknown[]).length) return false;
        if (kept.length === 0) delete hooks.PostToolUse;
        else hooks.PostToolUse = kept;
        pruneEmpty(root, 'hooks');
        return true;
      })
    ) {
      report.changed.push(path.join('.claude', 'settings.json'));
    }

    return report;
  },
};

/** Recognise our own hook entry so re-running install replaces it in place. */
function isOurHook(entry: unknown): boolean {
  if (!entry || typeof entry !== 'object') return false;
  const hooks = (entry as { hooks?: unknown }).hooks;
  if (!Array.isArray(hooks)) return false;
  return hooks.some((hook) => {
    const command = (hook as { command?: unknown }).command;
    return typeof command === 'string' && command.includes('codegraph') && command.includes('touch');
  });
}

function quote(command: string): string {
  return /[\s"']/.test(command) ? `"${command}"` : command;
}
