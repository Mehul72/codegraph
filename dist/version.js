import { createRequire } from 'node:module';
const requireFromHere = createRequire(import.meta.url);
/** Read from package.json so the version lives in exactly one place. */
export const PACKAGE_VERSION = requireFromHere('../package.json').version;
//# sourceMappingURL=version.js.map