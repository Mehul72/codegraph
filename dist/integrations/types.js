export function emptyReport() {
    return { changed: [], notes: [] };
}
/**
 * The launcher as a shell command that runs the CLI, for hooks.
 *
 * A hook runs `codegraph touch`, not the MCP server, so it needs everything
 * in the launcher except the `mcp` subcommand. Taking only `server.command`
 * was wrong for the npx form: it produced `npx touch`, which is a real and
 * unrelated package on the registry, so the reindex-on-edit hook silently
 * fetched and ran that instead of ever updating the index.
 */
export function cliInvocation(server) {
    const args = server.args.at(-1) === 'mcp' ? server.args.slice(0, -1) : [...server.args];
    return [server.command, ...args].map(shellQuote).join(' ');
}
function shellQuote(word) {
    return /[\s"'\\$`]/.test(word) ? `"${word.replace(/(["\\$`])/g, '\\$1')}"` : word;
}
//# sourceMappingURL=types.js.map