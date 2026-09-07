#!/usr/bin/env node
import { checkNodeVersion, silenceExperimentalWarnings } from '../util/runtime.js';

// Both of these have to happen before anything touches node:sqlite.
checkNodeVersion();
silenceExperimentalWarnings();

const { Command } = await import('commander');
const { PACKAGE_VERSION } = await import('../version.js');
const { setLogLevel, log } = await import('../util/log.js');
const { initCommand } = await import('./commands/init.js');
const { indexCommand } = await import('./commands/index-cmd.js');
const { runQueryCommand, numberOption } = await import('./commands/query.js');
const { installCommand, uninstallCommand, hookCommand } = await import('./commands/agents.js');
const { linkCommand, unlinkCommand, reposCommand } = await import('./commands/repos.js');
const { statusCommand } = await import('./commands/status.js');
const { touchCommand } = await import('./commands/touch.js');

const program = new Command();

program
  .name('codegraph')
  .description('Local code knowledge graph that answers structural questions for AI coding agents')
  .version(PACKAGE_VERSION)
  .option('-v, --verbose', 'log what it is doing to stderr')
  .option('-q, --quiet', 'errors only')
  .hook('preAction', (thisCommand) => {
    const opts = thisCommand.opts<{ verbose?: boolean; quiet?: boolean }>();
    if (opts.verbose) setLogLevel('debug');
    else if (opts.quiet) setLogLevel('error');
  });

// ------------------------------------------------------------------ setup

program
  .command('init')
  .description('detect the repo, index it, and wire up every coding agent found on this machine')
  .option('--agents <list>', 'comma separated agent ids instead of auto-detection')
  .option('--skip-agents', 'index only, do not touch any agent config')
  .option('--force', 'rebuild the index from scratch')
  .action(async (options) => initCommand(options));

program
  .command('index')
  .description('build or update the index')
  .argument('[paths...]', 'limit the run to these files or directories')
  .option('--force', 'reparse everything, ignoring the content cache')
  .action(async (paths: string[], options) => indexCommand(paths, options));

program
  .command('reindex')
  .description('rebuild the index from scratch, the fix for a database that has gone bad')
  .option('--force', 'kept for symmetry, reindex always starts clean')
  .action(async () => indexCommand([], { force: true }));

program
  .command('status')
  .description('what is indexed, how fresh it is, and which agents are wired up')
  .action(async () => statusCommand());

program
  .command('touch')
  .description('reindex specific files, used by the agent edit hooks')
  .argument('<files...>')
  .action(async (files: string[]) => touchCommand(files));

program
  .command('mcp')
  .description('run the MCP server on stdio, which is how agents talk to it')
  .action(async () => {
    const { startMcpServer } = await import('../mcp/server.js');
    await startMcpServer();
  });

// ----------------------------------------------------------------- agents

program
  .command('install')
  .description('register codegraph with one or more agents: claude, cursor, codex, copilot, all')
  .argument('[agents...]')
  .action(async (agents: string[]) => installCommand(agents));

program
  .command('uninstall')
  .description('remove every config entry and instruction block codegraph added')
  .argument('[agents...]')
  .action(async (agents: string[]) => uninstallCommand(agents));

program
  .command('hook')
  .description('install or remove the optional git hooks that reindex after commit and checkout')
  .argument('<action>', 'install or uninstall')
  .action(async (action: string) => hookCommand(action));

// -------------------------------------------------------------- cross repo

program
  .command('link')
  .description('resolve imports against another indexed repo')
  .argument('<repo>', 'a repo name from codegraph repos, or a path')
  .action(async (repo: string) => linkCommand(repo));

program
  .command('unlink')
  .description('stop resolving against a linked repo')
  .argument('<repo>')
  .action(async (repo: string) => unlinkCommand(repo));

program
  .command('repos')
  .description('list every indexed repo with its symbol count and last index time')
  .action(async () => reposCommand());

// -------------------------------------------------------------- queries

const budget = ['-b, --budget <tokens>', 'maximum output tokens'] as const;

program
  .command('search-symbols')
  .alias('search')
  .description('fuzzy symbol search')
  .argument('<query>')
  .option('-k, --kind <kind>', 'restrict to one kind of symbol')
  .option('-l, --lang <lang>', 'restrict to one language')
  .option('-n, --limit <n>', 'maximum results')
  .option(...budget)
  .action(async (query: string, options) =>
    runQueryCommand('search_symbols', {
      query,
      kind: options.kind,
      lang: options.lang,
      limit: numberOption(options.limit),
      budget: numberOption(options.budget),
    }),
  );

program
  .command('where-defined')
  .alias('where')
  .description('where a name is defined')
  .argument('<name>')
  .option(...budget)
  .action(async (name: string, options) =>
    runQueryCommand('where_defined', { name, budget: numberOption(options.budget) }),
  );

program
  .command('get-symbol')
  .alias('symbol')
  .description('one symbol with its immediate neighbours')
  .argument('<name>')
  .option(...budget)
  .action(async (name: string, options) =>
    runQueryCommand('get_symbol', { name, budget: numberOption(options.budget) }),
  );

program
  .command('find-callers')
  .alias('callers')
  .description('who calls or references a symbol')
  .argument('<symbol>')
  .option('-d, --depth <n>', 'hops to follow')
  .option('--no-cross-repo', 'ignore linked repos')
  .option(...budget)
  .action(async (symbol: string, options) =>
    runQueryCommand('find_callers', {
      symbol,
      depth: numberOption(options.depth),
      cross_repo: options.crossRepo,
      budget: numberOption(options.budget),
    }),
  );

program
  .command('find-callees')
  .alias('callees')
  .description('what a symbol calls or references')
  .argument('<symbol>')
  .option('-d, --depth <n>', 'hops to follow')
  .option(...budget)
  .action(async (symbol: string, options) =>
    runQueryCommand('find_callees', {
      symbol,
      depth: numberOption(options.depth),
      budget: numberOption(options.budget),
    }),
  );

program
  .command('impact-of')
  .alias('impact')
  .description('everything that would be affected by changing a symbol or a file')
  .argument('<target>', 'symbol name, or a file or directory path')
  .option('-d, --depth <n>', 'hops to follow')
  .option('--no-cross-repo', 'ignore linked repos')
  .option(...budget)
  .action(async (target: string, options) =>
    runQueryCommand('impact_of', {
      target,
      depth: numberOption(options.depth),
      cross_repo: options.crossRepo,
      budget: numberOption(options.budget),
    }),
  );

program
  .command('shortest-path')
  .alias('path')
  .description('how two symbols are connected')
  .argument('<a>')
  .argument('<b>')
  .option(...budget)
  .action(async (a: string, b: string, options) =>
    runQueryCommand('shortest_path', { a, b, budget: numberOption(options.budget) }),
  );

program
  .command('overview')
  .description('structural summary of the repo or a directory')
  .argument('[path]')
  .option(...budget)
  .action(async (dir: string | undefined, options) =>
    runQueryCommand('overview', { path: dir, budget: numberOption(options.budget) }),
  );

program
  .command('changed-since')
  .alias('changed')
  .description('symbols touched since a git ref, with what depends on them')
  .argument('<ref>')
  .option('-d, --depth <n>', 'hops to follow per changed symbol')
  .option(...budget)
  .action(async (ref: string, options) =>
    runQueryCommand('changed_since', {
      ref,
      depth: numberOption(options.depth),
      budget: numberOption(options.budget),
    }),
  );

try {
  await program.parseAsync(process.argv);
} catch (err) {
  log.error((err as Error).message);
  if (process.env.CODEGRAPH_LOG === 'debug') process.stderr.write(String((err as Error).stack) + '\n');
  process.exit(1);
}
