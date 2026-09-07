import type { Integration, ServerCommand } from './types.js';
export declare const INTEGRATIONS: readonly Integration[];
export declare function integrationById(id: string): Integration | null;
export declare function detectIntegrations(repoRoot: string): Promise<Integration[]>;
/**
 * What npx has to fetch to get this tool.
 *
 * The bare name `codegraph` belongs to an unrelated package on the npm
 * registry, so it can never appear in a launcher: an agent told to run
 * `npx -y codegraph mcp` downloads a stranger's package and runs it as an
 * MCP server, and the only symptom is that no tool ever answers.
 */
export declare const PACKAGE_SPEC = "github:Mehul72/codegraph";
/**
 * How the agent should launch our MCP server.
 *
 * A bare `codegraph` is best: it stays correct across upgrades and reads
 * cleanly in a config file that may get committed. When it is not on PATH,
 * because the tool was run through npx and never installed, we fall back to
 * npx so the config still works on a machine that has neither.
 *
 * Neither form pins a repo path. Agents launch MCP servers with the project
 * as the working directory, and codegraph walks up to the repo root from
 * there, so the same config file works for everyone on the team.
 */
export declare function resolveServerCommand(): Promise<ServerCommand>;
