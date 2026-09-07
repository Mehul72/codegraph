import { createRequire } from 'node:module';

const requireFromHere = createRequire(import.meta.url);

/** Read from package.json so the version lives in exactly one place. */
export const PACKAGE_VERSION: string = (requireFromHere('../package.json') as { version: string }).version;
