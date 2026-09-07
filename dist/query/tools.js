import path from 'node:path';
import { readFileSync } from 'node:fs';
import { configPath, registryPath } from '../config/paths.js';
import { Answer, normalizeBudget } from './budget.js';
import { fuzzySearch, lookupSymbol } from './lookup.js';
import { CONFIDENCE_LEGEND, confidenceSummary, countPhrase, detailLines, groupByFile, location, neighbourLine, repoTag, symbolHeadline, symbolLine, } from './format.js';
import { CALL_TYPES, IMPACT_TYPES, shortestPath as findPath, traverse } from './traverse.js';
import { foreignCallers } from './crossrepo.js';
import { changedFilesSince, GitError } from '../util/git.js';
import { formatCount, pad, plural, truncate } from '../util/text.js';
export function searchSymbols(ctx, args) {
    const answer = new Answer(normalizeBudget(args.budget, ctx.defaultBudget));
    const limit = clampLimit(args.limit, 25);
    const matches = fuzzySearch(ctx.store, args.query.trim(), limit + 1, { kind: args.kind, lang: args.lang });
    if (matches.length === 0) {
        answer.add(`no symbol matches "${args.query}"`);
        answer.add(hintForEmptySearch(ctx, args));
        return answer.render();
    }
    const shown = matches.slice(0, limit);
    answer.add(`${countPhrase(shown.length, 'match')} for "${args.query}"${filterSuffix(args)}`);
    for (const node of shown) {
        if (!answer.add(symbolLine(node, ctx.repo)))
            break;
        if (node.signature && node.signature.length < 90)
            answer.add(`        ${node.signature}`);
    }
    if (matches.length > limit)
        answer.omit(`more matches exist, raise limit or add kind/lang filters`);
    if (answer.isFull)
        answer.omit('output budget reached, use a narrower query');
    return answer.render();
}
function filterSuffix(args) {
    const parts = [];
    if (args.kind)
        parts.push(`kind=${args.kind}`);
    if (args.lang)
        parts.push(`lang=${args.lang}`);
    return parts.length > 0 ? ` (${parts.join(' ')})` : '';
}
function hintForEmptySearch(ctx, args) {
    const kinds = ctx.store.kindCounts().map((k) => k.kind);
    if (args.kind && !kinds.includes(args.kind)) {
        return `kind "${args.kind}" is not present in this index. Available: ${kinds.join(', ')}`;
    }
    return 'try a shorter query, or where_defined for an exact name';
}
export function getSymbol(ctx, args) {
    const answer = new Answer(normalizeBudget(args.budget, ctx.defaultBudget));
    const found = lookupSymbol(ctx.store, args.name);
    const node = found.matches[0];
    if (!node)
        return notFound(answer, ctx, args.name);
    if (found.matches.length > 1) {
        answer.add(`${found.matches.length} symbols match "${args.name}", showing the first`);
    }
    answer.add(symbolHeadline(node, ctx.repo));
    answer.addAll(detailLines(node));
    const outgoing = neighbours(ctx.store, [node.id], 'out');
    const incoming = neighbours(ctx.store, [node.id], 'in');
    answer.blank();
    writeNeighbourGroups(answer, ctx, 'used by', incoming);
    answer.blank();
    writeNeighbourGroups(answer, ctx, 'uses', outgoing);
    if (found.matches.length > 1) {
        answer.blank();
        answer.add('other matches:');
        for (const other of found.matches.slice(1, 6)) {
            if (!answer.add(symbolLine(other, ctx.repo)))
                break;
        }
    }
    return answer.render();
}
/** Neighbours grouped by edge type, which is how the brief wants them read. */
function writeNeighbourGroups(answer, ctx, heading, items) {
    if (items.length === 0) {
        answer.add(`${heading}: none`);
        return;
    }
    const byType = new Map();
    for (const item of items) {
        const list = byType.get(item.edge.type);
        if (list)
            list.push(item);
        else
            byType.set(item.edge.type, [item]);
    }
    answer.add(`${heading} (${items.length}): ${confidenceSummary(items)}`);
    for (const [type, group] of [...byType.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
        if (!answer.add(`  ${type} (${group.length})`)) {
            answer.omit(`remaining ${heading} groups, ask get_symbol with a larger budget`);
            return;
        }
        let written = 0;
        for (const item of group.slice(0, 12)) {
            const label = item.node.qualified ?? item.node.name;
            if (!answer.add(`    ${pad(truncate(label, 30), 30)} ${location(item.node)} ${item.edge.confidence}${repoTag(item.node, ctx.repo)}`))
                break;
            written++;
        }
        if (written < group.length)
            answer.omit(`${countPhrase(group.length - written, `more ${type} edge`)}`);
    }
}
function neighbours(store, ids, direction) {
    const edges = direction === 'in' ? store.incoming(ids) : store.outgoing(ids);
    if (edges.length === 0)
        return [];
    const otherIds = [...new Set(edges.map((e) => (direction === 'in' ? e.srcId : e.dstId)))];
    const nodes = new Map(store.getNodes(otherIds).map((n) => [n.id, n]));
    const out = [];
    const seen = new Set();
    for (const edge of edges) {
        const other = direction === 'in' ? edge.srcId : edge.dstId;
        const node = nodes.get(other);
        if (!node)
            continue;
        const key = `${other}|${edge.type}`;
        if (seen.has(key))
            continue;
        seen.add(key);
        out.push({ node, edge, distance: 1 });
    }
    return out;
}
export async function findCallers(ctx, args) {
    return callGraph(ctx, args, 'in');
}
export async function findCallees(ctx, args) {
    return callGraph(ctx, args, 'out');
}
async function callGraph(ctx, args, direction) {
    const answer = new Answer(normalizeBudget(args.budget, ctx.defaultBudget));
    const depth = clampDepth(args.depth, 1);
    const found = lookupSymbol(ctx.store, args.symbol);
    const node = found.matches[0];
    if (!node)
        return notFound(answer, ctx, args.symbol);
    const reached = traverse({ store: ctx.store, roots: [node.id], direction, depth, types: CALL_TYPES });
    const nodes = new Map(ctx.store.getNodes(reached.map((r) => r.id)).map((n) => [n.id, n]));
    const items = [];
    for (const hit of reached) {
        const other = nodes.get(hit.id);
        if (other)
            items.push({ node: other, edge: hit.via, distance: hit.distance });
    }
    const label = direction === 'in' ? 'callers of' : 'callees of';
    answer.add(`${label} ${symbolHeadline(node, ctx.repo)}`);
    const canLookFurther = direction === 'in' && (args.cross_repo ?? true) && ctx.hasLinks;
    if (items.length === 0) {
        answer.add(depth > 1 ? `none in this repo within ${depth} hops` : 'none in this repo');
        // A linked repo may still have some, so this is not the end of the answer.
        if (!canLookFurther)
            return answer.render();
    }
    else {
        answer.add(`${countPhrase(items.length, 'symbol')} within ${depth} ${plural(depth, 'hop')}: ${confidenceSummary(items)}`);
        answer.blank();
        writeGroupedByFile(answer, ctx, items, depth > 1);
    }
    if (canLookFurther)
        await appendForeignCallers(answer, ctx, [node.id]);
    answer.blank();
    answer.add(CONFIDENCE_LEGEND);
    return answer.render();
}
/**
 * The highest-value tool: everything that could break if the target changes.
 * The output has to be decision-useful on its own, so it leads with a verdict
 * line, then the affected files closest to the change, then the caveats.
 */
export async function impactOf(ctx, args) {
    const answer = new Answer(normalizeBudget(args.budget, ctx.defaultBudget));
    const depth = clampDepth(args.depth, 3);
    const target = args.target.trim();
    const roots = resolveImpactRoots(ctx, target);
    if (roots.length === 0)
        return notFound(answer, ctx, target);
    const rootIds = roots.map((r) => r.id);
    const reached = traverse({
        store: ctx.store,
        roots: rootIds,
        direction: 'in',
        depth,
        types: IMPACT_TYPES,
        maxNodes: 4000,
    });
    const nodes = new Map(ctx.store.getNodes(reached.map((r) => r.id)).map((n) => [n.id, n]));
    const items = [];
    for (const hit of reached) {
        const node = nodes.get(hit.id);
        if (node)
            items.push({ node, edge: hit.via, distance: hit.distance });
    }
    const heading = roots.length === 1 ? symbolHeadline(roots[0], ctx.repo) : `${target} (${roots.length} symbols)`;
    answer.add(`impact of changing ${heading}`);
    if (items.length === 0) {
        answer.add('nothing in this repo depends on it');
        if ((args.cross_repo ?? true) && ctx.hasLinks)
            await appendForeignCallers(answer, ctx, rootIds);
        return answer.render();
    }
    const files = new Set(items.map((i) => i.node.path));
    const direct = items.filter((i) => i.distance === 1).length;
    answer.add(`${countPhrase(items.length, 'symbol')} across ${countPhrase(files.size, 'file')} would be affected, ${direct} directly. ${confidenceSummary(items)}`);
    const risky = items.filter((i) => i.edge.confidence === 'heuristic').length;
    if (risky > 0) {
        answer.add(`${risky} of these rest on a name match alone, so confirm them before relying on this list`);
    }
    answer.blank();
    writeGroupedByFile(answer, ctx, items, true);
    if ((args.cross_repo ?? true) && ctx.hasLinks) {
        await appendForeignCallers(answer, ctx, rootIds);
    }
    answer.blank();
    answer.add(CONFIDENCE_LEGEND);
    return answer.render();
}
/** impact_of takes a symbol or a file, so figure out which one we were given. */
function resolveImpactRoots(ctx, target) {
    const looksLikePath = target.includes('/') || /\.[a-zA-Z]{1,5}$/.test(target);
    if (looksLikePath) {
        const asPath = target.replace(/^\.\//, '');
        const inFile = ctx.store.nodesInFile(asPath);
        if (inFile.length > 0)
            return inFile;
        const underDir = ctx.store.nodesUnderPath(asPath.replace(/\/$/, ''));
        if (underDir.length > 0)
            return underDir;
    }
    return lookupSymbol(ctx.store, target).matches.slice(0, 1);
}
async function appendForeignCallers(answer, ctx, ids) {
    const foreign = await foreignCallers(ctx.repoRoot, ids);
    if (foreign.length === 0)
        return;
    const byRepo = new Map();
    for (const hit of foreign) {
        const list = byRepo.get(hit.repo);
        if (list)
            list.push(hit);
        else
            byRepo.set(hit.repo, [hit]);
    }
    answer.blank();
    answer.add(`other repos (${foreign.length}):`);
    for (const [repo, hits] of byRepo) {
        if (!answer.add(`  ${repo}`)) {
            answer.omit('cross-repo callers, raise the budget to see them');
            return;
        }
        let written = 0;
        for (const hit of hits.slice(0, 10)) {
            const label = hit.node.qualified ?? hit.node.name;
            if (!answer.add(`    ${pad(truncate(label, 30), 30)} ${location(hit.node)} ${hit.edge.type}/${hit.edge.confidence}`))
                break;
            written++;
        }
        if (written < hits.length)
            answer.omit(`${countPhrase(hits.length - written, 'more caller')} in ${repo}`);
    }
}
function writeGroupedByFile(answer, ctx, items, showDistance) {
    const groups = groupByFile(items);
    let filesWritten = 0;
    for (const group of groups) {
        if (!answer.add(group.path))
            break;
        filesWritten++;
        let written = 0;
        for (const item of group.items) {
            if (!answer.add(neighbourLine(item, ctx.repo, showDistance)))
                break;
            written++;
        }
        if (written < group.items.length) {
            answer.omit(`${countPhrase(group.items.length - written, 'more symbol')} in ${group.path}`);
            break;
        }
    }
    if (filesWritten < groups.length) {
        const remaining = groups.slice(filesWritten);
        const count = remaining.reduce((sum, g) => sum + g.items.length, 0);
        answer.omit(`${countPhrase(count, 'symbol')} in ${countPhrase(remaining.length, 'more file')}, narrow with a lower depth or by passing a subdirectory`);
    }
}
export function shortestPathTool(ctx, args) {
    const answer = new Answer(normalizeBudget(args.budget, ctx.defaultBudget));
    const from = lookupSymbol(ctx.store, args.a).matches[0];
    const to = lookupSymbol(ctx.store, args.b).matches[0];
    if (!from)
        return notFound(answer, ctx, args.a);
    if (!to)
        return notFound(answer, ctx, args.b);
    const hops = findPath(ctx.store, from.id, to.id);
    if (hops === null) {
        answer.add(`no path between ${from.name} and ${to.name} within 8 hops of either one`);
        answer.add('they may be connected only through code this index does not cover, such as a framework or a queue');
        return answer.render();
    }
    if (hops.length === 0) {
        answer.add(`${from.name} and ${to.name} are the same symbol`);
        return answer.render();
    }
    answer.add(`${from.name} to ${to.name}: ${hops.length} ${hops.length === 1 ? 'hop' : 'hops'}`);
    const ids = new Set();
    for (const hop of hops) {
        ids.add(hop.srcId);
        ids.add(hop.dstId);
    }
    const nodes = new Map(ctx.store.getNodes([...ids]).map((n) => [n.id, n]));
    let cursor = from.id;
    answer.add(`  ${symbolHeadline(from, ctx.repo)}`);
    for (const hop of hops) {
        const nextId = hop.srcId === cursor ? hop.dstId : hop.srcId;
        const node = nodes.get(nextId);
        const arrow = hop.srcId === cursor ? '->' : '<-';
        const label = node ? `${node.qualified ?? node.name} (${location(node)})` : nextId;
        if (!answer.add(`  ${arrow} ${hop.type}/${hop.confidence} at ${hop.path}:${hop.line}`))
            break;
        if (!answer.add(`     ${label}`))
            break;
        cursor = nextId;
    }
    return answer.render();
}
/**
 * Meant to replace "read the whole directory to orient myself", so it leads
 * with the shape of the code and the places an agent should start reading.
 */
export function overview(ctx, args) {
    const answer = new Answer(normalizeBudget(args.budget, ctx.defaultBudget));
    const scope = args.path?.replace(/^\.?\//, '').replace(/\/$/, '') ?? '';
    const nodes = scope === '' ? ctx.store.allNodesLite() : ctx.store.nodesUnderPath(scope);
    if (nodes.length === 0) {
        answer.add(scope === '' ? 'the index is empty, run codegraph index' : `nothing indexed under ${scope}`);
        return answer.render();
    }
    const files = new Set(nodes.map((n) => n.path));
    const kinds = new Map();
    for (const node of nodes)
        kinds.set(node.kind, (kinds.get(node.kind) ?? 0) + 1);
    const where = scope === '' ? ctx.repo : `${ctx.repo}/${scope}`;
    const counts = `${formatCount(files.size)} ${plural(files.size, 'file')}, ${formatCount(nodes.length)} ${plural(nodes.length, 'symbol')}`;
    answer.add(`${where}: ${counts}`);
    answer.add([...kinds.entries()]
        .sort((a, b) => b[1] - a[1])
        .map(([kind, count]) => `${count} ${kind}`)
        .join(', '));
    const degrees = ctx.store.degreeCounts();
    // Endpoints are the truest entry points when a repo has them.
    const endpoints = nodes.filter((n) => n.kind === 'endpoint');
    if (endpoints.length > 0) {
        answer.blank();
        answer.add(`http endpoints (${endpoints.length}):`);
        for (const endpoint of endpoints.slice(0, 15)) {
            if (!answer.add(`  ${pad(truncate(endpoint.name, 34), 34)} ${endpoint.path}`))
                break;
        }
        if (endpoints.length > 15)
            answer.omit(countPhrase(endpoints.length - 15, 'more endpoint'));
    }
    const hubs = nodes
        .filter((n) => n.kind !== 'module')
        .map((n) => ({ node: n, degree: degrees.get(n.id) ?? 0 }))
        .filter((h) => h.degree > 0)
        .sort((a, b) => b.degree - a.degree || a.node.path.localeCompare(b.node.path))
        .slice(0, 12);
    if (hubs.length > 0) {
        answer.blank();
        answer.add('most depended on:');
        for (const hub of hubs) {
            if (!answer.add(`  ${pad(String(hub.degree), 4)} ${pad(truncate(hub.node.qualified ?? hub.node.name, 30), 30)} ${hub.node.path}`))
                break;
        }
    }
    const entries = nodes
        .filter((n) => n.kind === 'function' && n.exported && (degrees.get(n.id) ?? 0) === 0)
        .sort((a, b) => a.path.localeCompare(b.path) || a.name.localeCompare(b.name));
    if (entries.length > 0) {
        answer.blank();
        answer.add(`nothing calls these, so they are entry points or dead (${entries.length}):`);
        for (const entry of entries.slice(0, 12)) {
            if (!answer.add(`  ${pad(truncate(entry.name, 30), 30)} ${entry.path}`))
                break;
        }
        if (entries.length > 12)
            answer.omit(countPhrase(entries.length - 12, 'more uncalled function'));
    }
    answer.blank();
    answer.add('modules:');
    const breakdown = moduleBreakdown(nodes, scope);
    for (const row of breakdown.slice(0, 20)) {
        const counts = `${row.files} ${plural(row.files, 'file')}, ${row.symbols} ${plural(row.symbols, 'symbol')}`;
        if (!answer.add(`  ${pad(truncate(row.dir, 40), 40)} ${counts}`))
            break;
    }
    if (breakdown.length > 20) {
        answer.omit(`${countPhrase(breakdown.length - 20, 'more directory')}, pass path= to drill in`);
    }
    return answer.render();
}
function moduleBreakdown(nodes, scope) {
    const perDir = new Map();
    for (const node of nodes) {
        const relative = scope === '' ? node.path : node.path.slice(scope.length + 1);
        // Group by the containing directory, not the top-level one: a repo where
        // everything lives under src/ would otherwise report a single row.
        const dir = relative.includes('/') ? relative.slice(0, relative.lastIndexOf('/')) : '.';
        let entry = perDir.get(dir);
        if (!entry) {
            entry = { files: new Set(), symbols: 0 };
            perDir.set(dir, entry);
        }
        entry.files.add(node.path);
        entry.symbols++;
    }
    return [...perDir.entries()]
        .map(([dir, entry]) => ({ dir, files: entry.files.size, symbols: entry.symbols }))
        .sort((a, b) => b.symbols - a.symbols || a.dir.localeCompare(b.dir));
}
export function whereDefined(ctx, args) {
    const answer = new Answer(normalizeBudget(args.budget, ctx.defaultBudget));
    const found = lookupSymbol(ctx.store, args.name);
    if (found.matches.length === 0)
        return notFound(answer, ctx, args.name);
    if (found.how === 'fuzzy')
        answer.add(`no exact match for "${args.name}", closest names:`);
    for (const node of found.matches.slice(0, 20)) {
        if (!answer.add(`${location(node)}  ${pad(node.kind, 9)} ${node.qualified ?? node.name}${repoTag(node, ctx.repo)}`))
            break;
    }
    if (found.matches.length > 20)
        answer.omit(countPhrase(found.matches.length - 20, 'more definition'));
    return answer.render();
}
export async function changedSince(ctx, args) {
    const answer = new Answer(normalizeBudget(args.budget, ctx.defaultBudget));
    const depth = clampDepth(args.depth, 2);
    let files;
    try {
        files = await changedFilesSince(ctx.repoRoot, args.ref);
    }
    catch (err) {
        if (err instanceof GitError) {
            answer.add(`could not diff against ${args.ref}: ${err.message}`);
            return answer.render();
        }
        throw err;
    }
    // Kept as (file, symbols) pairs: the filter and the loop below both need
    // the node list, and looking it up twice per changed file was pure waste.
    const indexed = files
        .map((file) => ({ file, nodes: ctx.store.nodesInFile(file) }))
        .filter((entry) => entry.nodes.length > 0);
    if (indexed.length === 0) {
        answer.add(`${countPhrase(files.length, 'file')} changed since ${args.ref}, none containing indexed symbols`);
        if (files.length > 0)
            answer.addAll(files.slice(0, 10).map((f) => `  ${f}`));
        return answer.render();
    }
    answer.add(`${countPhrase(indexed.length, 'changed file')} since ${args.ref}`);
    for (const { file, nodes: inFile } of indexed) {
        const symbols = inFile.filter((n) => n.kind !== 'module');
        if (!answer.add(`${file} (${countPhrase(symbols.length, 'symbol')})`))
            break;
        const reached = traverse({
            store: ctx.store,
            roots: symbols.map((s) => s.id),
            direction: 'in',
            depth,
            types: IMPACT_TYPES,
            maxNodes: 400,
        });
        const nodes = ctx.store.getNodes(reached.map((r) => r.id)).filter((n) => n.path !== file);
        if (nodes.length === 0) {
            answer.add('  nothing outside this file depends on it');
            continue;
        }
        const affectedFiles = new Set(nodes.map((n) => n.path));
        answer.add(`  ${countPhrase(nodes.length, 'dependent symbol')} in ${countPhrase(affectedFiles.size, 'file')}`);
        for (const affected of [...affectedFiles].sort().slice(0, 6)) {
            if (!answer.add(`    ${affected}`))
                break;
        }
        if (affectedFiles.size > 6)
            answer.omit(`more dependents of ${file}, run impact_of on it directly`);
    }
    return answer.render();
}
// -------------------------------------------------------------- helpers
function notFound(answer, ctx, query) {
    answer.add(`no symbol named "${query}" in the ${ctx.repo} index`);
    const close = fuzzySearch(ctx.store, query.split(/[.:/]/).at(-1), 5);
    if (close.length > 0) {
        answer.add('did you mean:');
        for (const node of close)
            answer.add(symbolLine(node, ctx.repo));
    }
    else {
        answer.add('run search_symbols with a partial name, or codegraph index if the file is new');
    }
    return answer.render();
}
function clampDepth(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.min(6, Math.floor(value)));
}
function clampLimit(value, fallback) {
    if (typeof value !== 'number' || !Number.isFinite(value))
        return fallback;
    return Math.max(1, Math.min(200, Math.floor(value)));
}
/** Used by the CLI status command and by init's summary line. */
export function indexSummary(ctx) {
    const lines = [];
    lines.push(`repo      ${ctx.repo} (${ctx.repoRoot})`);
    lines.push(`files     ${formatCount(ctx.store.fileCount())}`);
    lines.push(`symbols   ${formatCount(ctx.store.nodeCount())}`);
    lines.push(`edges     ${formatCount(ctx.store.edgeCount())}`);
    const byLang = ctx.store.langCounts();
    if (byLang.length > 0) {
        lines.push(`languages ${byLang.map((l) => `${l.lang} ${l.count}`).join(', ')}`);
    }
    const byType = ctx.store.edgeTypeCounts();
    if (byType.length > 0) {
        const rolled = new Map();
        for (const row of byType)
            rolled.set(row.type, (rolled.get(row.type) ?? 0) + row.count);
        lines.push(`edge types ${[...rolled.entries()].map(([t, c]) => `${t} ${c}`).join(', ')}`);
        const byConfidence = new Map();
        for (const row of byType)
            byConfidence.set(row.confidence, (byConfidence.get(row.confidence) ?? 0) + row.count);
        lines.push(`confidence ${[...byConfidence.entries()].map(([t, c]) => `${t} ${c}`).join(', ')}`);
    }
    const unresolved = ctx.store.unresolvedRefCount();
    if (unresolved > 0) {
        lines.push(`unresolved ${formatCount(unresolved)} references, mostly third-party imports and calls on values whose type is not knowable from the source`);
    }
    return lines.join('\n');
}
export function toolContext(session) {
    return {
        store: session.store,
        repo: session.config.repo,
        repoRoot: session.repoRoot,
        defaultBudget: session.config.defaultBudget,
        hasLinks: session.config.links.length > 0 || hasIncomingLinks(session.repoRoot),
    };
}
/**
 * Is this repo a dependency of another indexed repo?
 *
 * Only the small config files are read, never the other databases, because a
 * false answer here is expensive in both directions: saying no hides real
 * cross-repo callers, and saying yes makes every find_callers and impact_of
 * open and query every registered index. The earlier version answered yes as
 * soon as the registry held any other repo at all, which is true the moment
 * you have indexed two unrelated projects.
 */
function hasIncomingLinks(repoRoot) {
    const self = path.resolve(repoRoot);
    let roots;
    try {
        const parsed = JSON.parse(readFileSync(registryPath(), 'utf8'));
        roots = (parsed.repos ?? []).map((r) => path.resolve(r.root)).filter((root) => root !== self);
    }
    catch {
        return false;
    }
    return roots.some((root) => linksTo(root, self));
}
/** Does the repo at `root` list `target` among the repos it resolves against? */
function linksTo(root, target) {
    try {
        const config = JSON.parse(readFileSync(configPath(root), 'utf8'));
        if (!Array.isArray(config.links))
            return false;
        return config.links.some((link) => typeof link === 'string' && path.resolve(link) === target);
    }
    catch {
        // No config, or one we cannot read. Nothing links here as far as we know.
        return false;
    }
}
//# sourceMappingURL=tools.js.map