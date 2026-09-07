/**
 * Every instruction file we touch belongs to the user, and usually has their
 * own content in it. So we only ever own the text between our own markers:
 * installing replaces that block and nothing else, and uninstalling removes
 * it and leaves the rest byte for byte as it was.
 */
export declare const MARKER_START = "<!-- codegraph:start -->";
export declare const MARKER_END = "<!-- codegraph:end -->";
export declare const TOML_MARKER_START = "# codegraph:start";
export declare const TOML_MARKER_END = "# codegraph:end";
export interface MarkerStyle {
    start: string;
    end: string;
}
export declare const MARKDOWN_MARKERS: MarkerStyle;
export declare const TOML_MARKERS: MarkerStyle;
/**
 * Put `body` between the markers in `existing`, replacing any previous block.
 * Running this twice with the same body produces the same file, which is what
 * makes `install` safe to re-run.
 */
export declare function upsertBlock(existing: string, body: string, style?: MarkerStyle): string;
/** Remove our block. Returns null when there was nothing of ours to remove. */
export declare function removeBlock(existing: string, style?: MarkerStyle): string | null;
export declare function writeMarkedFile(file: string, body: string, style?: MarkerStyle): Promise<boolean>;
export declare function stripMarkedFile(file: string, style?: MarkerStyle): Promise<boolean>;
