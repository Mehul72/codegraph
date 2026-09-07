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
