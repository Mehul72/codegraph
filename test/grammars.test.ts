import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { EXTRACTORS } from '../src/extract/registry.js';
import { grammarDir } from '../src/extract/parser.js';

/**
 * The grammars are committed binaries, and MANIFEST.json records what each one
 * should be. Nothing read those hashes back, so the manifest documented an
 * intention rather than enforcing one: a wasm file that was swapped, truncated
 * by a bad checkout, or refetched from a moved release tag would have been
 * indistinguishable from the reviewed one. Re-hashing here is what turns the
 * record into a check.
 */
interface ManifestEntry {
  file: string;
  repo: string;
  tag: string;
  bytes: number;
  sha256: string;
}

async function manifest(): Promise<ManifestEntry[]> {
  const raw = await fsp.readFile(path.join(grammarDir(), 'MANIFEST.json'), 'utf8');
  return (JSON.parse(raw) as { grammars: ManifestEntry[] }).grammars;
}

test('every committed grammar matches the size and hash in MANIFEST.json', async () => {
  const entries = await manifest();
  assert.ok(entries.length > 0, 'the manifest lists no grammars');

  for (const entry of entries) {
    const bytes = await fsp.readFile(path.join(grammarDir(), entry.file));
    assert.equal(bytes.length, entry.bytes, `${entry.file} is not the size the manifest records`);
    assert.equal(
      createHash('sha256').update(bytes).digest('hex'),
      entry.sha256,
      `${entry.file} does not hash to what the manifest records`,
    );
    assert.equal(bytes.subarray(0, 4).toString('hex'), '0061736d', `${entry.file} is not a wasm module`);
  }
});

test('every grammar an extractor asks for is present and recorded', async () => {
  const recorded = new Set((await manifest()).map((entry) => entry.file));

  for (const extractor of EXTRACTORS) {
    if (!extractor.grammar) continue; // sql does its own lexing
    assert.ok(
      recorded.has(extractor.grammar),
      `the ${extractor.id} extractor needs ${extractor.grammar}, which the manifest does not list`,
    );
    await assert.doesNotReject(
      () => fsp.access(path.join(grammarDir(), extractor.grammar as string)),
      `${extractor.grammar} is missing from ${grammarDir()}`,
    );
  }
});
