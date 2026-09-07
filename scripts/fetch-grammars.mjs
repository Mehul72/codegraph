// Maintainer script. Downloads the tree-sitter wasm grammars we ship and drops
// them in grammars/. The .wasm files are committed so that `npx codegraph`
// never needs the network or a native toolchain.
//
// Run this when bumping a grammar: node scripts/fetch-grammars.mjs

import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'grammars');

const GRAMMARS = [
  { file: 'tree-sitter-python.wasm', repo: 'tree-sitter/tree-sitter-python', tag: 'v0.25.0' },
  { file: 'tree-sitter-go.wasm', repo: 'tree-sitter/tree-sitter-go', tag: 'v0.25.0' },
  { file: 'tree-sitter-javascript.wasm', repo: 'tree-sitter/tree-sitter-javascript', tag: 'v0.25.0' },
  { file: 'tree-sitter-typescript.wasm', repo: 'tree-sitter/tree-sitter-typescript', tag: 'v0.23.2' },
  { file: 'tree-sitter-tsx.wasm', repo: 'tree-sitter/tree-sitter-typescript', tag: 'v0.23.2' },
  { file: 'tree-sitter-java.wasm', repo: 'tree-sitter/tree-sitter-java', tag: 'v0.23.5' },
];

async function main() {
  await mkdir(outDir, { recursive: true });
  const manifest = [];

  for (const g of GRAMMARS) {
    const url = `https://github.com/${g.repo}/releases/download/${g.tag}/${g.file}`;
    process.stdout.write(`fetching ${g.file} (${g.repo}@${g.tag}) ... `);
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} returned ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.subarray(0, 4).toString('hex') !== '0061736d') {
      throw new Error(`${g.file} does not look like a wasm module`);
    }
    await writeFile(path.join(outDir, g.file), buf);
    const sha = createHash('sha256').update(buf).digest('hex');
    manifest.push({ file: g.file, repo: g.repo, tag: g.tag, bytes: buf.length, sha256: sha });
    console.log(`${(buf.length / 1024).toFixed(0)} KiB`);
  }

  const manifestPath = path.join(outDir, 'MANIFEST.json');
  await writeFile(manifestPath, JSON.stringify({ grammars: manifest }, null, 2) + '\n', 'utf8');
  console.log(`\nwrote ${manifest.length} grammars and ${path.relative(root, manifestPath)}`);

  // Sanity check: the runtime has to be able to load every one of them.
  const { Parser, Language } = await import('web-tree-sitter');
  await Parser.init();
  for (const g of manifest) {
    await Language.load(path.join(outDir, g.file));
    console.log(`loads ok: ${g.file}`);
  }
  const rt = JSON.parse(await readFile(path.join(root, 'node_modules/web-tree-sitter/package.json'), 'utf8'));
  console.log(`all grammars load under web-tree-sitter ${rt.version}`);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
