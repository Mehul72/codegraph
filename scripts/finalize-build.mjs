// tsc does not set the executable bit, so npm-installed bins would fail to run
// directly. Fix that up after every build.

import { chmod, access } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const bin = path.join(root, 'dist', 'cli', 'main.js');

try {
  await access(bin);
  await chmod(bin, 0o755);
  console.log('build ready:', path.relative(root, bin));
} catch {
  console.error('expected dist/cli/main.js to exist after tsc, it does not');
  process.exit(1);
}
