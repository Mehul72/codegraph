import path from 'node:path';
import { loadConfig, makeDefaultConfig, saveConfig } from '../../config/config.js';
import { configPath, dbPath, findRepoRoot } from '../../config/paths.js';
import { Store } from '../../store/store.js';
import { runIndex } from '../../index/indexer.js';
import { registerRepo } from '../../config/registry.js';
import { walkRepo } from '../../index/walker.js';
import { extractorFor, languageLabel } from '../../extract/registry.js';
import { detectIntegrations, resolveServerCommand } from '../../integrations/index.js';
import { pathExistsSync } from '../../util/fs.js';
import { formatCount, formatDuration, plural } from '../../util/text.js';
import { writeIndexGitignore } from './index-cmd.js';

export interface InitOptions {
  agents?: string;
  skipAgents?: boolean;
  force?: boolean;
}

/**
 * The one command a new user runs. It has to work with no arguments, no
 * questions, and no follow-up steps: detect the repo, detect the languages,
 * detect the agents, build the index, wire everything up, and print something
 * the user can immediately try.
 */
export async function initCommand(options: InitOptions): Promise<void> {
  const out = (line: string) => process.stdout.write(line + '\n');
  const started = Date.now();

  const repoRoot = findRepoRoot();
  out(`codegraph init in ${repoRoot}`);

  const languages = await detectLanguages(repoRoot);
  if (languages.length === 0) {
    out('');
    out('No files in a supported language were found here.');
    out('codegraph reads Python, Go, TypeScript, JavaScript, Java and SQL.');
    out('If your sources live somewhere unexpected, check your .gitignore and try again.');
    return;
  }

  const existingConfig = pathExistsSync(configPath(repoRoot));
  const config = existingConfig ? await loadConfig(repoRoot) : makeDefaultConfig(repoRoot);
  await saveConfig(repoRoot, config);
  await writeIndexGitignore(repoRoot);
  out(`languages  ${languages.map(languageLabel).join(', ')}`);
  out(`config     ${existingConfig ? 'kept' : 'wrote'} ${path.basename(configPath(repoRoot))}`);

  const store = Store.open(dbPath(repoRoot));
  let firstSymbol: string | null = null;
  try {
    const stats = await runIndex({ repoRoot, config, store, force: options.force, progress: true });
    await registerRepo(config.repo, repoRoot);

    out(
      `index      ${formatCount(stats.filesIndexed)} ${plural(stats.filesIndexed, 'file')}, ${formatCount(stats.nodes)} ${plural(stats.nodes, 'symbol')}, ${formatCount(stats.edges)} ${plural(stats.edges, 'edge')} in ${formatDuration(stats.durationMs)}`,
    );
    if (stats.warnings.length > 0) {
      const skipped = `${stats.warnings.length} ${plural(stats.warnings.length, 'file')}`;
      out(`           ${skipped} skipped, run 'codegraph index' with CODEGRAPH_LOG=debug for detail`);
    }
    firstSymbol = pickExampleSymbol(store);
  } finally {
    store.close();
  }

  if (!options.skipAgents) {
    await wireUpAgents(repoRoot, options.agents, out);
  }

  out('');
  out(`ready in ${formatDuration(Date.now() - started)}. Try:`);
  out(`  codegraph overview`);
  if (firstSymbol) out(`  codegraph impact-of ${firstSymbol}`);
  out('');
  out('Your agents will call it themselves for structural questions. To see what they were told:');
  out('  codegraph status');
}

async function detectLanguages(repoRoot: string): Promise<string[]> {
  const walked = await walkRepo({ repoRoot });
  const counts = new Map<string, number>();
  for (const file of walked) {
    const extractor = extractorFor(file.relPath);
    if (!extractor) continue;
    counts.set(extractor.id, (counts.get(extractor.id) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([id]) => id);
}

/**
 * Pick something worth showing in the example command: a function plenty of
 * other code depends on makes for a far better first impression than
 * whatever happens to sort first.
 */
function pickExampleSymbol(store: Store): string | null {
  const degrees = store.degreeCounts();
  let best: { name: string; degree: number } | null = null;

  for (const node of store.allNodesLite()) {
    if (node.kind !== 'function' && node.kind !== 'method') continue;
    const degree = degrees.get(node.id) ?? 0;
    if (degree === 0) continue;
    if (!best || degree > best.degree) best = { name: node.qualified ?? node.name, degree };
  }
  return best?.name ?? null;
}

async function wireUpAgents(repoRoot: string, requested: string | undefined, out: (line: string) => void): Promise<void> {
  const wanted = requested
    ? requested
        .split(',')
        .map((a) => a.trim().toLowerCase())
        .filter(Boolean)
    : null;

  const detected = await detectIntegrations(repoRoot);
  const agents = wanted ? detected.filter((a) => wanted.includes(a.id)) : detected;

  if (agents.length === 0) {
    out('agents     none detected. Run: codegraph install claude|cursor|codex|copilot');
    return;
  }

  const server = await resolveServerCommand();
  const wired: string[] = [];
  for (const agent of agents) {
    const report = await agent.install({ repoRoot, server });
    wired.push(`${agent.label} (${report.changed.length === 0 ? 'already current' : report.changed.join(', ')})`);
    for (const note of report.notes) out(`           ${note}`);
  }
  out(`agents     ${wired.join('; ')}`);
  if (server.command === 'npx') {
    out('           codegraph is not on your PATH, so the agents will run it through npx.');
    out('           Install it globally for faster starts: npm i -g codegraph');
  }
}
