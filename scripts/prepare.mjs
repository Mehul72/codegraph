// Builds on install when there is a toolchain to build with, and gets out of
// the way when there is not.
//
// npm prepares a git dependency by cloning it into a cache directory and
// running prepare there, and for `npm install -g github:owner/repo` that
// clone gets none of the package's devDependencies: no tsc, no @types/node.
// A prepare that compiles unconditionally therefore fails the entire install
// with `sh: tsc: command not found`, and only for global installs, which is
// what made it easy to miss. dist/ is committed for exactly that case.
//
// A contributor's `npm install` does have the toolchain, so it still gets a
// fresh build and never has to remember to run one.

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(path.join(root, 'package.json'));
const built = path.join(root, 'dist', 'cli', 'main.js');

/** The installed compiler's entry script, or null when it is not there. */
function installedTsc() {
  try {
    return require.resolve('typescript/lib/tsc.js');
  } catch {
    return null;
  }
}

function run(command, args) {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

const tsc = installedTsc();

if (!tsc) {
  if (existsSync(built)) {
    console.log('no typescript here, installing the committed dist/ as it is');
    process.exit(0);
  }
  console.error('cannot build: typescript is not installed and dist/ is not present');
  console.error('run npm install in a clone of the repository to get a toolchain');
  process.exit(1);
}

run(process.execPath, [tsc, '-p', 'tsconfig.json']);
run(process.execPath, [path.join(root, 'scripts', 'finalize-build.mjs')]);
