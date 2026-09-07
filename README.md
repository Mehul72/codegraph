# codegraph

A local code knowledge graph for AI coding agents.

Coding agents burn a lot of tokens rediscovering structure. Asking "what calls
this function" turns into a grep, then five file reads, then a guess. That is
fifteen thousand tokens to answer a question the shape of the code already
knows. codegraph indexes your repo once, keeps the index current, and answers
those questions in a few hundred tokens instead.

It does not replace reading code. It tells the agent where to look.

```
$ codegraph impact-of Answer.add
impact of changing Answer.add (method, src/query/budget.ts:31)
32 symbols across 10 files would be affected, 16 directly. 3 exact, 29 resolved

src/query/budget.ts
  d1 Answer.addAll                  method    :44 calls/resolved
  d1 Answer.blank                   method    :53 calls/resolved
src/query/tools.ts
  d1 searchSymbols                  function  :48 calls/resolved
  d1 getSymbol                      function  :91 calls/resolved
  d1 writeNeighbourGroups           function  :122 calls/resolved
  ...
```

## Install

Node 22 or newer. Nothing to compile, no language toolchains to install: the
parsers ship as WebAssembly.

```
cd your-repo
npx codegraph init
```

That detects the repo root and its languages, builds the index, finds every
coding agent you have installed, and wires itself into each one. Then restart
your agent. That is the whole setup.

```
$ npx codegraph init
codegraph init in /Users/you/code/shop
languages  Python
config     wrote codegraph.config.json
index      8 files, 38 symbols, 68 edges in 31ms
agents     Claude Code (.mcp.json, CLAUDE.md, .claude/settings.json)

ready in 61ms. Try:
  codegraph overview
  codegraph impact-of OrderRepository.find

Your agents will call it themselves for structural questions. To see what they were told:
  codegraph status
```

To install it properly rather than through `npx`:

```
npm install -g codegraph
```

## What the agent gets

Nine tools over MCP. The descriptions the agent sees explain when each one
beats reading files, and when it does not.

| Tool | Answers |
|---|---|
| `search_symbols` | I know roughly what it is called, where is it |
| `where_defined` | exact name to file and line |
| `get_symbol` | signature, doc, and everything one hop away |
| `find_callers` | who calls this, transitively |
| `find_callees` | what does this call |
| `impact_of` | what breaks if I change this |
| `shortest_path` | how are these two connected |
| `overview` | what is in this directory, where do I start reading |
| `changed_since` | what did I touch, and what depends on it |

Every tool is also a CLI command, which is useful for checking what the agent
is being told:

```
$ codegraph get-symbol resolveRefs
resolveRefs (function, src/resolve/resolver.ts:48)
  sig  function resolveRefs(input: ResolveInput): ResolveOutcome
  doc  Turn parked references into edges.

used by (4): 1 exact, 3 resolved
  calls (1)
    runIndex                       src/index/indexer.ts:36 resolved
  defines (1)
    src/resolve/resolver           src/resolve/resolver.ts:1 exact
  imports (2)
    src/api                        src/api.ts:1 resolved
    src/index/indexer              src/index/indexer.ts:1 resolved

uses (8): 5 exact, 3 resolved
  calls (6)
    buildDefinitionIndex           src/resolve/definitions.ts:27 resolved
    ImportTable                    src/resolve/resolver.ts:485 exact
    Resolver                       src/resolve/resolver.ts:70 exact
    ...
  references (2)
    ResolveInput                   src/resolve/resolver.ts:18 exact
    ResolveOutcome                 src/resolve/resolver.ts:27 exact
```

## Confidence, and why it is on every line

Static analysis without a compiler cannot always be certain. Pretending
otherwise is how a tool like this does damage: the agent reads a confident
answer, believes it, and edits the wrong file. So every edge carries how it
was established.

**`exact`** means the parser saw both ends in one syntax tree. A class and its
methods, a call to a function defined in the same file.

**`resolved`** means name resolution linked it across files using the
language's own import rules. `from app.store import OrderStore` followed by
`store.save()` where the parameter is annotated `OrderStore`.

**`resolved`** is also used for the interesting middle case: a receiver whose
type is not written down, but whose name is defined in exactly one file this
file imports. That import is real evidence.

**`heuristic`** means a name matched and nothing else did. Worth showing,
never worth trusting without a look.

When there is no evidence at all, codegraph returns nothing rather than
guessing. `rows.push(x)` matches every method named `push` in your repo and
means none of them, so it produces no edge. Fewer answers, but the ones you
get are worth something.

## Languages

Python, Go, TypeScript, TSX, JavaScript, Java, and SQL DDL.

Each has real import resolution, not just name matching: Python module paths
and relative imports, Go package paths from `go.mod` plus package scope across
files, TypeScript path aliases from `tsconfig.json` including barrel files,
Java packages and imports. SQL gets tables, columns, foreign keys and views,
and strings that look like SQL in the other languages become `queries` edges
onto those tables.

## Staying current

An index that lags is worse than no index. Three things keep it honest.

Every query checks freshness first. That check is a directory walk and a stat
per file, and it parses only what changed, so it costs a few tens of
milliseconds on a repo of this size.

`codegraph install` adds a post-edit hook to each agent, so a file the agent
writes is reindexed before the next question.

`codegraph hook install` adds optional git hooks for after a commit or a
checkout, which matters when you switch branches.

You can always run it by hand:

```
codegraph index            # update
codegraph reindex          # rebuild from scratch
codegraph status           # what is indexed and how fresh
```

Incremental correctness is the property the test suite cares about most. After
any change, the graph has to equal what a from-scratch index of the same tree
would produce, and there are tests for edits, renames, new files, deletions,
and files that come back.

## More than one repo

A service that depends on a library you also own is a common shape, and the
interesting question crosses the boundary.

```
cd ~/code/toolkit && codegraph index
cd ~/code/api && codegraph link ../toolkit && codegraph index
```

The second `index` is what pulls the link through: linking only records the
path, so the imports get re-resolved on the next pass. Now imports from `api`
into `toolkit` land on real symbols, and asking about a `toolkit` function
finds its callers in `api`, from either side:

```
$ codegraph find-callers Slugify
callers of Slugify (function, text/text.go:3)
none in this repo

other repos (1):
  api
    Handle                         handler/handler.go:5 calls/resolved
```

This works because symbol ids are deterministic. The same symbol gets the same
id whichever repo's index computed it, so finding outside callers means asking
the other databases the same question. There is no shared server and no
central database.

`codegraph repos` lists what is registered. Pass `--no-cross-repo` to any
query to keep the answer local.

## Configuration

`codegraph.config.json` in the repo root, all of it optional:

```json
{
  "repo": "api",
  "languages": ["python", "go"],
  "ignore": ["migrations/", "*.generated.ts"],
  "links": ["../toolkit"],
  "defaultBudget": 1200,
  "maxFileBytes": 1048576
}
```

`.gitignore` and `.codegraphignore` are both honoured, including nested ones.
The usual heavy directories (`node_modules`, `dist`, `target`, `.venv` and so
on) are skipped whether or not you list them.

The index lives in `.codegraph/` and is disposable. Deleting it costs one
`codegraph index`. Nothing is written outside the repo except the registry in
`~/.codegraph/`, and Codex's config file if you install that integration.

## What it actually saves

`npm run bench` measures it. Two corpora: a generated service repo of 416
files across Python, Go and TypeScript, and a copy of this project's own
`src/`. Ten questions each, sampled at different depths in the dependency
ranking.

```
headline
    14x  median token saving over reading the code, across 20 questions
    21x  saving in total: 5,242 tokens of answers against 108,661 tokens of reading

token cost, codegraph src
  question                                      answer  files   reading   saving
  find_callers Store.setMeta                        74      2     7,916     107x
  find_callers recordCall                           71      1     5,344      75x
  impact_of Store.queryOne                         808     14    29,015      36x
  impact_of Integration.detect                     276      6     5,597      20x
  get_symbol Store.insertNode                      138      1     4,933      36x
  overview src/util                                212      5     2,554      12x
  shortest_path initCommand to GraphNode            79      4     5,452      69x
  ...
  total                                          2,490           82,921      33x
```

The reading column counts the files that hold the answer and nothing else:
the callers plus the definition, everything reachable at the same depth, every
indexed file under the directory. That gives the reading route perfect
foresight, since a real agent pays for greps and wrong guesses before it knows
which files to open. `search_symbols` and `where_defined` are left out because
grep answers those cheaply, and a repo-wide `overview` is left out because it
would flatter the ratio.

Speed, same run:

```
indexing
  corpus          files  symbols   edges     cold     warm   1 file
  synthetic         416    5,448  19,145    714ms     24ms    126ms
  codegraph src      60      693   3,333    148ms      3ms     36ms
```

`warm` is a reindex with nothing changed, which is the check that runs before
every query. Queries themselves are well under a millisecond apart from
`overview`, which is a few milliseconds because it aggregates the whole tree.

## Output size

Every tool takes a `budget` in tokens and truncates to fit, and says what it
dropped and how to ask a narrower question:

```
omitted: 34 symbols in 6 more files, narrow with a lower depth or by passing a subdirectory
```

Silent truncation would be worse than useless, because the agent would treat a
partial list as the whole answer. The default is 1200 tokens, which is enough
for a real answer and small enough that asking is always cheaper than reading.

## Agent integrations

`codegraph init` detects and configures what you have. To do it one at a time:

```
codegraph install claude
codegraph install cursor codex copilot
codegraph uninstall all
```

Each integration registers the MCP server, adds a short instruction block
telling the agent what the tools are for and when to read files instead, and
installs a post-edit hook where the agent supports one. Everything it writes
sits inside markers or in its own key, so installing twice changes nothing and
uninstalling leaves your file as it was. The MCP command is never pinned to an
absolute path, so a committed config works for everyone on the team.

| Agent | Files touched |
|---|---|
| Claude Code | `.mcp.json`, `CLAUDE.md`, `.claude/settings.json` |
| Cursor | `.cursor/mcp.json`, `.cursor/rules/codegraph.mdc` |
| Codex | `~/.codex/config.toml`, `AGENTS.md` |
| GitHub Copilot | `.vscode/mcp.json`, `.github/copilot-instructions.md` |

## Programmatic use

```js
import { Session, runTool } from 'codegraph';

const session = await Session.open({ cwd: process.cwd() });
await session.ensureFresh();
console.log(await runTool(session, 'impact_of', { target: 'OrderService' }));
session.close();
```

## How it works

The pipeline is four stages, and the third is where the value is.

**Walk.** Find candidate files, respecting ignore rules, skipping binaries and
anything over the size limit. Record size and mtime.

**Extract.** Parse each changed file with tree-sitter and pull out symbols and
relationships. A relationship whose target is in the same file becomes an edge
immediately. Everything else is parked as a reference: a name, an optional
receiver, and the import that might explain it.

**Resolve.** Turn parked references into edges. Strategies run strongest
evidence first and the first hit wins: the enclosing type for `self.x()`, the
same file, an import of that exact name, an import of the receiver, a type
declared locally, then a single candidate in a file this one can actually
reach. This pass decides both what gets linked and what confidence it carries.

**Query.** Traverse, rank by how many things depend on a symbol, group by file,
and write through a token budget.

Storage is SQLite through Node's built-in `node:sqlite`, so a CLI invocation
opens the database and runs indexed lookups instead of loading a graph into
memory. Extraction is skipped when a file's size and mtime are unchanged, and
skipped again when its content hash is unchanged, which is what makes a warm
pass cheap.

## Repository layout

```
src/
  cli/            command definitions and output
  index/          walker, content hashing, incremental scheduler
  extract/        one file per language, plus a registry
  resolve/        cross-file and cross-repo name resolution
  store/          SQLite schema, migrations, every query
  query/          traversal, ranking, token budgeting
  mcp/            server and tool definitions
  integrations/   one file per agent
  config/         config file, paths, cross-repo registry
grammars/         bundled tree-sitter WebAssembly
test/
  fixtures/       small repos per language with known-correct output
```

## Development

```
npm install
npm run grammars     # download the tree-sitter wasm grammars
npm run build
npm run typecheck    # covers the tests too, which tsx does not
npm test
npm run bench
```

Tests use real files on disk rather than a mocked filesystem, because a good
half of the behaviour worth testing lives in the walker, the mtime cache and
the ignore rules.

The benchmark takes a repo of your own, which is the honest way to check
whether a change made indexing slower on real code:

```
git clone --depth 1 https://github.com/django/django /tmp/django
npm run bench -- --repo=/tmp/django
```

It copies the tree into `.scratch/` before touching anything, since timing an
incremental pass means editing a file. `--json` gives machine readable output
for tracking numbers over time, and `--domains=N` resizes the synthetic
corpus.

## Adding a language

Write an extractor in `src/extract/`, implementing `Extractor` from
`src/extract/types.ts`: which extensions you claim, which grammar you need,
and an `extract` function returning symbols and relationships. Add
`modulePath` and `moduleAliases` so imports can find your files. Register it
in `src/extract/registry.ts`, add a fixture under `test/fixtures/`, and add
the module-path rules to `src/resolve/modules.ts` if the language resolves
imports differently from the ones already there.

`src/extract/python.ts` is the reference implementation and the one to read
first.

## Design notes

A few decisions worth explaining, since they are the ones a reader would
question.

**No answer beats a wrong answer.** Past a handful of equally plausible
candidates, and for a qualified call with no import behind it, codegraph
returns nothing. An agent that acts on a confident wrong edge edits the wrong
code, which costs far more than the query saved.

**Module-level import edges point at symbols, not files.** `from x import y`
records a dependency on `y`, which is more precise and still reaches the file
through the `defines` edge.

**`defines` edges are excluded from dependency counts.** Every symbol is
defined by its own module, so counting those would give everything a floor of
one, bury the real hubs, and make every entry point look like it has a caller.

**One symbol per line, columns not prose.** Where two formats were equally
clear, the shorter one won.

## License

MIT
