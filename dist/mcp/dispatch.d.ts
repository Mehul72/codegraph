import type { Session } from '../session.js';
/**
 * One place that maps a tool name plus loose arguments onto a typed call. The
 * MCP server and the CLI both go through here, so the two cannot drift apart
 * in what they accept or what they return.
 */
export declare function runTool(session: Session, name: string, args: Record<string, unknown>): Promise<string>;
