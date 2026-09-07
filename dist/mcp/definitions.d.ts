/**
 * Tool definitions handed to the agent.
 *
 * The descriptions are part of the product, not documentation. An agent picks
 * a tool from this text alone, so each one says what question it answers and,
 * where it matters, when reading the file directly is the better move.
 */
export interface ToolDefinition {
    name: string;
    description: string;
    inputSchema: {
        type: 'object';
        properties: Record<string, unknown>;
        required?: string[];
    };
}
export declare const TOOL_DEFINITIONS: readonly ToolDefinition[];
