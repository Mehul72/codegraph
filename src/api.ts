/**
 * Programmatic entry point. The CLI and the MCP server are the intended ways
 * to use codegraph; this exists so that a script can build an index or run a
 * query without shelling out.
 */

export { Session, NoIndexError } from './session.js';
export { Store, CorruptIndexError } from './store/store.js';
export { runIndex, repoFacts } from './index/indexer.js';
export { walkRepo } from './index/walker.js';
export { resolveRefs } from './resolve/resolver.js';
export { runTool } from './mcp/dispatch.js';
export { startMcpServer } from './mcp/server.js';
export { TOOL_DEFINITIONS } from './mcp/definitions.js';
export { EXTRACTORS, extractorFor, extractorById, familyOf, languageLabel } from './extract/registry.js';
export { loadConfig, saveConfig, makeDefaultConfig, DEFAULT_CONFIG } from './config/config.js';
export { findRepoRoot, dbPath, configPath, indexDir, registryPath } from './config/paths.js';
export { loadRegistry, registerRepo } from './config/registry.js';
export { PACKAGE_VERSION } from './version.js';

export type { CodegraphConfig } from './config/config.js';
export type { Extractor, ExtractInput } from './extract/types.js';
export type {
  Confidence,
  EdgeRow,
  EdgeType,
  EdgeTarget,
  ExtractResult,
  FileRecord,
  GraphNode,
  IndexStats,
  NodeKind,
  RawEdge,
  RefRow,
} from './types.js';
