import assert from 'node:assert/strict';
import { test } from 'node:test';

import { cleanDoc } from '../src/extract/ast.js';
import { goExtractor } from '../src/extract/go.js';
import { ParserPool } from '../src/extract/parser.js';
import type { GraphNode } from '../src/types.js';

/**
 * Doc comments are the one field in an answer that comes from prose rather
 * than from structure, so they are the easiest place to waste an agent's
 * budget. These tests pin down how much of a comment survives, because the
 * rule lives in one function that every extractor shares.
 */

test('a tag ends the summary, so a parameter list never reaches the agent', () => {
  assert.equal(cleanDoc('Look up one order by its id.\n\n@param id the order id\n@return the order'), 'Look up one order by its id.');
  // Plenty of code puts the tags straight after the prose with no blank line.
  assert.equal(cleanDoc('Save a row.\n@param row the row'), 'Save a row.');
  // Javadoc's own inline form uses a backslash in some dialects.
  assert.equal(cleanDoc('Fetch it.\n\\param id the id'), 'Fetch it.');
});

test('a sentence wrapped over two lines is kept whole', () => {
  const wrapped = 'Turn parked references into edges. This pass is where the tool\nearns its keep.';
  assert.equal(cleanDoc(wrapped), 'Turn parked references into edges. This pass is where the tool earns its keep.');
});

test('detail after a blank line is dropped, since the summary is the answer', () => {
  const doc = 'Shared plumbing for the row stores.\n\nSubclasses only have to name their table.';
  assert.equal(cleanDoc(doc), 'Shared plumbing for the row stores.');
});

test('a rule drawn out of punctuation is decoration, not a doc', () => {
  assert.equal(cleanDoc('-----------------------------'), null);
  assert.equal(cleanDoc('=== ### ==='), null);
  assert.equal(cleanDoc(''), null);
  assert.equal(cleanDoc('\n\n'), null);
});

test('a long doc is truncated rather than allowed to fill the answer', () => {
  const long = 'word '.repeat(200);
  const out = cleanDoc(long);
  assert.ok(out !== null);
  assert.ok(out.length <= 201, `a doc came back ${out.length} characters long`);
});

/**
 * The rule above only helps if the comment was attached to the right symbol in
 * the first place. A section divider followed by a blank line belongs to the
 * code above it, and quoting it as the next symbol's doc is both wrong and a
 * waste of tokens.
 */
test('a comment separated by a blank line belongs to no symbol', async () => {
  const pool = new ParserPool();
  const source = [
    'package store',
    '',
    '// ----------------------------------------- edges',
    '',
    'func InsertEdge(edge int) int {',
    '\treturn edge',
    '}',
    '',
    '// Attached to what follows, because nothing separates them.',
    'func InsertNode(node int) int {',
    '\treturn node',
    '}',
    '',
  ].join('\n');

  const tree = await pool.parse('tree-sitter-go.wasm', source);
  assert.ok(tree, 'the go grammar should be available, run npm run grammars');
  const result = goExtractor.extract({ tree, path: 'store/store.go', source, repo: 'fixture' });
  pool.dispose();

  const find = (name: string): GraphNode => {
    const node = result.nodes.find((n) => n.name === name);
    assert.ok(node, `expected a symbol named ${name}`);
    return node;
  };

  assert.equal(find('InsertEdge').doc, null, 'the divider is not documentation');
  assert.equal(find('InsertNode').doc, 'Attached to what follows, because nothing separates them.');
});
