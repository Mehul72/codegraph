export interface ServerCommand {
  command: string;
  args: string[];
}

export interface InstallContext {
  repoRoot: string;
  /** How this agent should launch the MCP server. */
  server: ServerCommand;
}

export interface IntegrationReport {
  /** Paths we created or edited, for the summary line. */
  changed: string[];
  /** Anything the user should know, such as a manual step we cannot do. */
  notes: string[];
}

export interface Integration {
  id: string;
  label: string;
  /**
   * Is this agent in use here? Checked against both the repo and the machine,
   * because `init` should wire up what the user actually has without asking.
   */
  detect(repoRoot: string): Promise<boolean>;
  install(ctx: InstallContext): Promise<IntegrationReport>;
  uninstall(repoRoot: string): Promise<IntegrationReport>;
}

export function emptyReport(): IntegrationReport {
  return { changed: [], notes: [] };
}

/**
 * The launcher as a shell command that runs the CLI, for hooks.
 *
 * A hook runs `codegraph touch`, not the MCP server, so it needs everything
 * in the launcher except the `mcp` subcommand. Taking only `server.command`
 * was wrong for the npx form: it produced `npx touch`, which is a real and
 * unrelated package on the registry, so the reindex-on-edit hook silently
 * fetched and ran that instead of ever updating the index.
 */
export function cliInvocation(server: ServerCommand): string {
  const args = server.args.at(-1) === 'mcp' ? server.args.slice(0, -1) : [...server.args];
  return [server.command, ...args].map(shellQuote).join(' ');
}

function shellQuote(word: string): string {
  return /[\s"'\\$`]/.test(word) ? `"${word.replace(/(["\\$`])/g, '\\$1')}"` : word;
}
