// Process wide request timer. Imported for its side effects.

import * as os from 'node:os';

const started = Date.now();

/** Milliseconds since this module was loaded. */
export function uptimeMs(): number {
  return Date.now() - started;
}

process.on('exit', () => {
  process.stderr.write(`${os.hostname()} up for ${uptimeMs()}ms\n`);
});
