import type { Store } from '../store/store.js';
export interface ToolContext {
    store: Store;
    repo: string;
    repoRoot: string;
    defaultBudget: number;
    /** True when this repo has linked repos or is linked from elsewhere. */
    hasLinks: boolean;
}
export interface BudgetArg {
    budget?: number;
}
export interface SearchArgs extends BudgetArg {
    query: string;
    kind?: string;
    lang?: string;
    limit?: number;
}
export declare function searchSymbols(ctx: ToolContext, args: SearchArgs): string;
export interface GetSymbolArgs extends BudgetArg {
    name: string;
}
export declare function getSymbol(ctx: ToolContext, args: GetSymbolArgs): string;
export interface DirectionArgs extends BudgetArg {
    symbol: string;
    depth?: number;
    cross_repo?: boolean;
}
export declare function findCallers(ctx: ToolContext, args: DirectionArgs): Promise<string>;
export declare function findCallees(ctx: ToolContext, args: DirectionArgs): Promise<string>;
export interface ImpactArgs extends BudgetArg {
    target: string;
    depth?: number;
    cross_repo?: boolean;
}
/**
 * The highest-value tool: everything that could break if the target changes.
 * The output has to be decision-useful on its own, so it leads with a verdict
 * line, then the affected files closest to the change, then the caveats.
 */
export declare function impactOf(ctx: ToolContext, args: ImpactArgs): Promise<string>;
export interface PathArgs extends BudgetArg {
    a: string;
    b: string;
}
export declare function shortestPathTool(ctx: ToolContext, args: PathArgs): string;
export interface OverviewArgs extends BudgetArg {
    path?: string;
}
/**
 * Meant to replace "read the whole directory to orient myself", so it leads
 * with the shape of the code and the places an agent should start reading.
 */
export declare function overview(ctx: ToolContext, args: OverviewArgs): string;
export interface WhereArgs extends BudgetArg {
    name: string;
}
export declare function whereDefined(ctx: ToolContext, args: WhereArgs): string;
export interface ChangedArgs extends BudgetArg {
    ref: string;
    depth?: number;
}
export declare function changedSince(ctx: ToolContext, args: ChangedArgs): Promise<string>;
/** Used by the CLI status command and by init's summary line. */
export declare function indexSummary(ctx: ToolContext): string;
export declare function toolContext(session: {
    store: Store;
    config: {
        repo: string;
        defaultBudget: number;
        links: string[];
    };
    repoRoot: string;
}): ToolContext;
