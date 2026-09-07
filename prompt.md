# Build Prompt: `codegraph` — a token-saving code knowledge graph for AI coding agents

You are building a complete, publishable open-source tool from scratch. Read this entire brief before writing code. Build it incrementally in the milestones given, and make each milestone actually work before moving to the next.

---

## 1. Mission

Large repositories burn enormous numbers of tokens because AI coding agents answer structural questions by grepping and reading whole files. `codegraph` builds a local, deterministic index of a codebase's structure — symbols and the relationships between them — and exposes it to coding agents so they can ask precise questions and receive small, targeted answers instead of reading source.

The single metric that matters: **an agent answering "what calls this function and what breaks if I change it" should spend ~300 tokens instead of ~15,000.**

Everything in this project is judged against that. A feature that produces a beautiful graph but returns 5,000 tokens per query is a failure.

### Non-goals (do not build these)

- No LLM calls anywhere in the indexing pipeline. Indexing is 100% local, deterministic, and free. If you find yourself adding an API key, you've gone wrong.
- No embeddings, no vector store, no semantic search over text.
- No graph visualization, HTML output, or web UI.
- No PDF, image, video, or Office document ingestion.
- No Neo4j/GraphML/Obsidian/wiki export formats.
- No multi-user, team, or server-hosted mode. No auth, no HTTP transport.
- No PR dashboards, CI integration, or GitHub API features.

---

## 2. Users and environment

Single user: a backend engineer who works across several large repositories (Python, Go, TypeScript, Java, SQL) and uses Claude Code, Codex, Cursor, and GitHub Copilot. Repos may reach 300k+ lines. Some repos depend on shared internal libraries that live in *other* repos, and cross-repo impact questions matter.

---

## 3. Required user experience

These three flows define acceptance. Build to them exactly.

### 3.1 Install and first index — one command

```bash
npx codegraph init
```

Run inside a repo, this must, without further prompting:
1. Detect the repo root (walk up to `.git`).
2. Detect which languages are present and which supported agents are configured on this machine.
3. Write a `.codegraph/` directory and a `codegraph.config.json`.
4. Build the full index, with a live progress indicator.
5. Register itself with every detected agent (MCP config + instruction file + hooks).
6. Print a summary: files indexed, symbols found, edges found, time taken, which agents were wired up, and one example query to try.

Global install must also work: `npm i -g codegraph` then `codegraph init`.

Cold index of a 100k-line repo: under 60 seconds. Warm re-index with no changes: under 2 seconds. These are hard requirements — design for them, don't discover them at the end.

### 3.2 Agents query it when it saves tokens

All four agents must be able to call it, and must be told *when* to call it.

**Transport: an MCP server over stdio.** This is the primary interface; all four target agents support MCP. Do not build four separate integrations.

`codegraph install <agent>` (and `init`, which does all detected agents) writes:

| Agent | MCP registration | Instruction file | Auto-update hook |
|---|---|---|---|
| Claude Code | `.mcp.json` in repo root | `CLAUDE.md` section | `PostToolUse` hook on `Edit`/`Write`/`MultiEdit` in `.claude/settings.json` |
| Cursor | `.cursor/mcp.json` | `.cursor/rules/codegraph.mdc` with `alwaysApply: true` | none — staleness check covers it |
| Codex | `mcp_servers` entry in `~/.codex/config.toml` | `AGENTS.md` section | none — staleness check covers it |
| GitHub Copilot | `.vscode/mcp.json` | `.github/copilot-instructions.md` | none — staleness check covers it |

All writes must be **idempotent and non-destructive**: use fenced marker blocks (`<!-- codegraph:start -->` / `<!-- codegraph:end -->`) in instruction files so re-running replaces only your section; merge into existing JSON/TOML rather than overwriting; never clobber unrelated keys. `codegraph uninstall` cleanly removes every marker block and config entry it added.

The instruction text you write into these files is a core deliverable, not boilerplate. It must tell the agent *when* the graph beats reading files, and when it doesn't. Draft it along these lines and refine it:

> Before answering structural questions about this codebase — what calls X, what does X depend on, where is X defined, what breaks if X changes, how do A and B connect, what's in this module — call the `codegraph` MCP tools first. They return a scoped answer in a few hundred tokens instead of requiring file reads.
>
> Use codegraph for: locating a symbol, finding callers or callees, tracing a dependency path, assessing blast radius before an edit, getting an overview of an unfamiliar module.
>
> Read files directly for: the actual implementation body you're about to modify, exact logic or algorithm details, comments and docstrings, anything where you need the literal text. codegraph tells you *where to look and what connects to what*; it does not replace reading the code you're changing.

### 3.3 The index updates itself when the agent edits code

Requirement: if an agent modifies files during a session, subsequent queries in that same session must reflect the changes. Three layers, in order of importance:

**Layer 1 — staleness check on every query (the mechanism).** Before serving any query, do a cheap freshness pass: walk tracked files, compare `mtime` + `size` against the cache, and re-index only what changed. This must be fast enough to run on every single call — target under 200ms warm on a large repo. Debounce so rapid successive queries don't rescan repeatedly. This layer alone satisfies the requirement for every agent, regardless of hook support. Get it right.

**Layer 2 — agent hooks (optimization).** Claude Code's `PostToolUse` hook fires a fire-and-forget `codegraph touch <file>` after each edit, so the reindex has already happened by query time. Never block the agent's tool call.

**Layer 3 — git hooks (optional, opt-in).** `codegraph hook install` adds `post-commit` and `post-checkout` hooks for background reindexing. Not enabled by `init`.

---

## 4. Technical constraints

- **Language:** TypeScript, compiled to ESM. Strict mode on.
- **Runtime:** Node 22+. State this in `engines` and fail with a clear message on older versions.
- **Storage:** SQLite through Node's built-in `node:sqlite`. No native compilation, fast cold start, indexed lookups. Do not use a JSON blob as primary storage — loading a large graph per CLI invocation is exactly the latency problem to avoid.
- **Parsing:** `web-tree-sitter` with WASM grammars. WASM avoids native build steps that break `npm install` on some machines. Bundle grammars for the shipped languages; load them lazily so a Python-only repo never loads the Java grammar.
- **Dependencies:** keep them few and boring. A CLI framework, tree-sitter WASM, an MCP SDK, an ignore-file matcher. Nothing else without a good reason.
- **Cross-platform:** must work on macOS, Linux, and Windows. Always use `path.join`, never assume `/`. Write files with explicit UTF-8 and `\n`.

---

## 5. Data model

**Nodes** — one row per symbol:

```
id            stable, deterministic: <repo>:<relpath>:<kind>:<qualified_name>
repo          repo identifier
path          repo-relative file path
name          bare symbol name
qualified     fully qualified name where the language provides one
kind          function | method | class | interface | struct | module | constant | table | endpoint
lang          language id
line_start    int
line_end      int
signature     one-line signature, truncated to ~200 chars
doc           first line of docstring/leading comment only, truncated to ~200 chars
exported      bool — is it public/exported
```

**Edges** — one row per relationship:

```
src_id, dst_id
type          calls | imports | inherits | implements | references | defines | queries
confidence    exact | resolved | heuristic
path, line    where the relationship was observed
```

`confidence` is important and must be surfaced in output. `exact` means the parser saw it unambiguously in the AST. `resolved` means name resolution linked it across files with reasonable certainty. `heuristic` means a name matched but it could be wrong. An agent that can't distinguish these will state guesses as facts.

Also store a `files` table with path, content hash, size, mtime, language, and last-indexed timestamp. This drives incremental indexing.

---

## 6. Language extractors

Define one interface:

```ts
interface Extractor {
  id: string;
  extensions: string[];
  grammar: string;              // wasm grammar filename
  extract(tree: Tree, filePath: string, source: string): { nodes: Node[]; edges: RawEdge[] };
}
```

Adding a language must mean adding one file and one registry line. Nothing else.

Ship with: **Python, Go, TypeScript/JavaScript, Java, SQL (DDL — tables, columns, foreign keys as edges).** Write them in that order. Do not build forty languages.

After per-file extraction, run a **resolution pass** that turns unresolved call/import references into real edges using each language's import semantics — Python module paths, Go package paths, TS path aliases from `tsconfig.json`, Java package/import statements. This pass is where most of the tool's real value lives; budget serious effort here. Mark cross-file resolutions `resolved`, and bare name matches with no import evidence `heuristic`.

---

## 7. MCP tools

Every tool takes an optional `budget` (max output tokens, default 1200) and **must** truncate to it, appending an explicit note about what was omitted and how to narrow the query. Never emit raw JSON dumps — emit compact, readable text designed for an LLM to consume. Aggressively deduplicate.

| Tool | Purpose |
|---|---|
| `search_symbols(query, kind?, lang?, limit?)` | Fuzzy symbol lookup. Returns name, kind, file:line, one-line signature. |
| `get_symbol(name_or_id)` | One symbol: signature, location, doc line, immediate neighbors grouped by edge type with confidence tags. |
| `find_callers(symbol, depth=1)` | Who calls this, transitively to `depth`. |
| `find_callees(symbol, depth=1)` | What this calls. |
| `impact_of(symbol_or_file)` | Blast radius: everything transitively reachable that would be affected by a change, ranked by distance, grouped by file. The highest-value tool — make its output genuinely decision-useful. |
| `shortest_path(a, b)` | How two symbols connect, hop by hop with edge types. |
| `overview(path?)` | Structural summary of repo or subdirectory: entry points, most-connected symbols, module breakdown, file count. Replaces "read the whole directory to orient myself." |
| `where_defined(name)` | Fast definition lookup. Replaces grep. |
| `changed_since(ref)` | Symbols touched since a git ref, with their impact sets. |

Also expose all of these as CLI subcommands with identical output, both for debugging and for agents that can shell out but not speak MCP.

---

## 8. Cross-repo support

The user works across repos that share internal libraries. Cross-repo impact analysis is a first-class feature, not a bolt-on.

- Global registry at `~/.codegraph/registry.json`: repo name → absolute path → index location.
- `codegraph link <path-or-name>` registers another indexed repo as a dependency of the current one.
- During resolution, if an import can't be resolved locally, attempt resolution against linked repos, matching by package name (`go.mod` module path, `package.json` name, Python distribution name, Maven coordinates). Mark these edges `resolved` and tag the node with its owning repo.
- `impact_of` and `find_callers` must accept a `cross_repo` flag (default true when links exist) and clearly label which repo each result lives in.
- `codegraph repos` lists registered repos with symbol counts and last-index times.

---

## 9. Repository layout

```
codegraph/
├── src/
│   ├── cli/              # command definitions, output formatting
│   ├── index/            # walker, hasher, incremental scheduler
│   ├── extract/          # one file per language + registry
│   ├── resolve/          # cross-file and cross-repo name resolution
│   ├── store/            # SQLite schema, migrations, queries
│   ├── query/            # traversal, ranking, token budgeting
│   ├── mcp/              # MCP server, tool definitions
│   ├── integrations/     # one file per agent: claude, cursor, codex, copilot
│   └── config/
├── grammars/             # bundled .wasm
├── test/
│   ├── fixtures/         # small real repos per language
│   └── ...
├── README.md
├── package.json
└── tsconfig.json
```

---

## 10. Testing

- **Fixture repos per language** in `test/fixtures/`, each with known-correct expected symbols and edges. Assert against them. Every new extractor needs a fixture.
- **Incremental correctness:** index → mutate a file → reindex → assert the graph matches a from-scratch index of the mutated state. This test catches the worst class of bug in this tool: a stale graph that confidently reports wrong answers.
- **Deletion handling:** delete a file, reindex, assert its nodes and inbound edges are gone.
- **Token budget:** assert every tool's output respects `budget` on a large fixture.
- **Integration writers:** assert idempotency — run `install` twice, assert the config files are byte-identical to one run. Assert `uninstall` restores the original.
- **Benchmark script** that reports cold and warm index time on a large real repo (clone something substantial), so performance regressions are visible.

---

## 11. Milestones

Build in this order. Each must work end to end before you start the next.

1. **Skeleton + storage.** CLI scaffold, SQLite schema, config file, repo walker respecting `.gitignore` and `.codegraphignore`, content hashing. `codegraph index` records files but extracts nothing.
2. **Python extractor + query core.** Full extraction and resolution for Python. `search_symbols`, `where_defined`, `get_symbol`, `find_callers`, `find_callees` working via CLI. Fixture tests passing.
3. **Incremental indexing.** Content-hash cache, changed-file detection, deletion handling, the fast staleness check. Hit the warm-reindex performance target and prove it with the benchmark.
4. **MCP server + Claude Code integration.** Stdio server, all tools, token budgeting. `codegraph install claude` writing `.mcp.json`, the `CLAUDE.md` block, and the `PostToolUse` hook. Verify end to end in a real Claude Code session.
5. **Remaining agents.** Cursor, Codex, Copilot. `codegraph init` auto-detecting and wiring all present agents.
6. **Remaining languages.** Go, TypeScript/JavaScript, Java, SQL, with resolution and fixtures for each.
7. **Cross-repo.** Registry, `link`, cross-repo resolution, repo-labeled output.
8. **Polish and publish.** `impact_of` and `overview` output quality tuning, README, `npx` verification from a clean machine, npm publish config.

---

## 12. Standing rules

- Ship each milestone working. No stubs left behind, no `TODO: implement` in merged code.
- Handle failure gracefully: an unparseable file logs a warning and is skipped — it never aborts an index. A missing grammar degrades to skipping that language with a clear message. A corrupt database offers `codegraph reindex --force`.
- The index is disposable. Anything in `.codegraph/` must be reconstructible from source in one command. Add it to `.gitignore` by default.
- Never write outside the repo root or `~/.codegraph/` without the user explicitly asking.
- Prefer boring, obvious code. This tool's value is correctness and speed, not cleverness. A wrong answer delivered confidently is worse than no tool at all, because the agent will act on it.
- When you hit an ambiguous design decision not covered here, choose the option that produces fewer output tokens per query, and note the decision in the README.