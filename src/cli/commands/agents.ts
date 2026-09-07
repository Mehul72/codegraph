import { findRepoRoot } from '../../config/paths.js';
import { detectIntegrations, integrationById, INTEGRATIONS, resolveServerCommand } from '../../integrations/index.js';
import { installGitHooks, uninstallGitHooks } from '../../integrations/githooks.js';
import type { Integration } from '../../integrations/types.js';

export async function installCommand(names: string[]): Promise<void> {
  const repoRoot = findRepoRoot();
  const out = (line: string) => process.stdout.write(line + '\n');

  const agents = await pickAgents(repoRoot, names);
  if (agents.length === 0) {
    out(`no agent matched. Known agents: ${INTEGRATIONS.map((a) => a.id).join(', ')}`);
    return;
  }

  const server = await resolveServerCommand();
  for (const agent of agents) {
    const report = await agent.install({ repoRoot, server });
    out(
      report.changed.length === 0
        ? `${agent.label}: already up to date`
        : `${agent.label}: ${report.changed.join(', ')}`,
    );
    for (const note of report.notes) out(`  ${note}`);
  }
  out(`server command: ${server.command} ${server.args.join(' ')}`);
}

export async function uninstallCommand(names: string[]): Promise<void> {
  const repoRoot = findRepoRoot();
  const out = (line: string) => process.stdout.write(line + '\n');
  const agents = names.length === 0 ? [...INTEGRATIONS] : await pickAgents(repoRoot, names);

  let touched = 0;
  for (const agent of agents) {
    const report = await agent.uninstall(repoRoot);
    if (report.changed.length === 0) continue;
    touched++;
    out(`${agent.label}: removed from ${report.changed.join(', ')}`);
  }

  const hooks = await uninstallGitHooks(repoRoot);
  if (hooks.changed.length > 0) {
    touched++;
    out(`git hooks: removed from ${hooks.changed.join(', ')}`);
  }

  out(touched === 0 ? 'nothing to remove' : 'the .codegraph directory and codegraph.config.json were left in place');
}

async function pickAgents(repoRoot: string, names: readonly string[]): Promise<Integration[]> {
  if (names.length === 0 || names.includes('all')) return detectIntegrations(repoRoot);

  const picked: Integration[] = [];
  for (const name of names) {
    const agent = integrationById(name);
    if (agent) picked.push(agent);
  }
  return picked;
}

export async function hookCommand(action: string): Promise<void> {
  const repoRoot = findRepoRoot();
  const out = (line: string) => process.stdout.write(line + '\n');

  if (action === 'install') {
    const server = await resolveServerCommand();
    const command = server.command === 'npx' ? 'npx -y codegraph' : server.command;
    const report = await installGitHooks(repoRoot, command);
    for (const note of report.notes) out(note);
    out(
      report.changed.length === 0
        ? 'git hooks already installed'
        : `installed ${report.changed.join(', ')}, they reindex in the background after commit and checkout`,
    );
    return;
  }

  if (action === 'uninstall') {
    const report = await uninstallGitHooks(repoRoot);
    out(report.changed.length === 0 ? 'no codegraph git hooks found' : `removed ${report.changed.join(', ')}`);
    return;
  }

  out(`unknown action "${action}". Use: codegraph hook install | codegraph hook uninstall`);
}
