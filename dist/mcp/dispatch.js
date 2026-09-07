import { changedSince, findCallees, findCallers, getSymbol, impactOf, overview, searchSymbols, shortestPathTool, toolContext, whereDefined, } from '../query/tools.js';
/**
 * One place that maps a tool name plus loose arguments onto a typed call. The
 * MCP server and the CLI both go through here, so the two cannot drift apart
 * in what they accept or what they return.
 */
export async function runTool(session, name, args) {
    const ctx = toolContext(session);
    const budget = num(args.budget);
    switch (name) {
        case 'search_symbols':
            return searchSymbols(ctx, {
                query: str(args.query, 'query'),
                kind: optionalStr(args.kind),
                lang: optionalStr(args.lang),
                limit: num(args.limit),
                budget,
            });
        case 'where_defined':
            return whereDefined(ctx, { name: str(args.name, 'name'), budget });
        case 'get_symbol':
            return getSymbol(ctx, { name: str(args.name ?? args.name_or_id, 'name'), budget });
        case 'find_callers':
            return findCallers(ctx, {
                symbol: str(args.symbol, 'symbol'),
                depth: num(args.depth),
                cross_repo: bool(args.cross_repo),
                budget,
            });
        case 'find_callees':
            return findCallees(ctx, { symbol: str(args.symbol, 'symbol'), depth: num(args.depth), budget });
        case 'impact_of':
            return impactOf(ctx, {
                target: str(args.target ?? args.symbol_or_file, 'target'),
                depth: num(args.depth),
                cross_repo: bool(args.cross_repo),
                budget,
            });
        case 'shortest_path':
            return shortestPathTool(ctx, { a: str(args.a, 'a'), b: str(args.b, 'b'), budget });
        case 'overview':
            return overview(ctx, { path: optionalStr(args.path), budget });
        case 'changed_since':
            return changedSince(ctx, { ref: str(args.ref, 'ref'), depth: num(args.depth), budget });
        default:
            throw new Error(`unknown tool "${name}"`);
    }
}
function str(value, field) {
    if (typeof value !== 'string' || value.trim() === '') {
        throw new Error(`${field} is required and must be a non-empty string`);
    }
    return value;
}
function optionalStr(value) {
    return typeof value === 'string' && value.trim() !== '' ? value : undefined;
}
function num(value) {
    if (typeof value === 'number' && Number.isFinite(value))
        return value;
    if (typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value)))
        return Number(value);
    return undefined;
}
function bool(value) {
    if (typeof value === 'boolean')
        return value;
    if (value === 'true')
        return true;
    if (value === 'false')
        return false;
    return undefined;
}
//# sourceMappingURL=dispatch.js.map