import os from 'node:os';
import path from 'node:path';
import fsp from 'node:fs/promises';
import { pathExists, readTextFileOrNull, writeTextFile } from '../util/fs.js';
import { objectAt, peekObject, pruneEmpty, updateJsonFile } from './jsonfile.js';
import { cursorRule } from './instructions.js';
import { emptyReport, type Integration, type IntegrationReport, type InstallContext } from './types.js';

const RULE_RELATIVE = path.join('.cursor', 'rules', 'codegraph.mdc');

export const cursorIntegration: Integration = {
  id: 'cursor',
  label: 'Cursor',

  async detect(repoRoot: string): Promise<boolean> {
    const candidates = [
      path.join(repoRoot, '.cursor'),
      path.join(os.homedir(), '.cursor'),
      path.join(os.homedir(), 'Library', 'Application Support', 'Cursor'),
      path.join(os.homedir(), '.config', 'Cursor'),
      path.join(os.homedir(), 'AppData', 'Roaming', 'Cursor'),
    ];
    for (const candidate of candidates) {
      if (await pathExists(candidate)) return true;
    }
    return false;
  },

  async install(ctx: InstallContext): Promise<IntegrationReport> {
    const report = emptyReport();
    const { repoRoot, server } = ctx;

    const mcpFile = path.join(repoRoot, '.cursor', 'mcp.json');
    if (
      await updateJsonFile(mcpFile, (root) => {
        objectAt(root, 'mcpServers')['codegraph'] = { command: server.command, args: server.args };
        return true;
      })
    ) {
      report.changed.push(path.join('.cursor', 'mcp.json'));
    }

    // A rule file is ours end to end, so it is written whole rather than
    // merged. Front matter has to stay at the very top for Cursor to read it.
    const ruleFile = path.join(repoRoot, RULE_RELATIVE);
    const desired = cursorRule();
    if ((await readTextFileOrNull(ruleFile)) !== desired) {
      await writeTextFile(ruleFile, desired);
      report.changed.push(RULE_RELATIVE);
    }

    return report;
  },

  async uninstall(repoRoot: string): Promise<IntegrationReport> {
    const report = emptyReport();

    if (
      await updateJsonFile(path.join(repoRoot, '.cursor', 'mcp.json'), (root) => {
        const servers = peekObject(root, 'mcpServers');
        if (!servers || !('codegraph' in servers)) return false;
        delete servers['codegraph'];
        pruneEmpty(root, 'mcpServers');
        return true;
      })
    ) {
      report.changed.push(path.join('.cursor', 'mcp.json'));
    }

    const ruleFile = path.join(repoRoot, RULE_RELATIVE);
    if (await pathExists(ruleFile)) {
      await fsp.rm(ruleFile, { force: true });
      report.changed.push(RULE_RELATIVE);
    }

    return report;
  },
};
