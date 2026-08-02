import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { walkTree } from '../src/tree.ts';

const noCancel = { isCancellationRequested: false };
const cancelled = { isCancellationRequested: true };

/**
 * Build a throwaway tree:
 *
 *   root/
 *     a/
 *       b/c
 *       deep/deeper
 *       file.txt
 *       (loop -> root, alias -> a/deep added by tests that need symlinks)
 *     node_modules/pkg    (excluded by default)
 *     dist/x              (excluded by default)
 */
function makeTree(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'search-folder-test-'));
  fs.mkdirSync(path.join(root, 'a', 'b', 'c'), { recursive: true });
  fs.mkdirSync(path.join(root, 'a', 'deep', 'deeper'), { recursive: true });
  fs.mkdirSync(path.join(root, 'node_modules', 'pkg'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dist', 'x'), { recursive: true });
  fs.writeFileSync(path.join(root, 'a', 'file.txt'), 'x');
  return root;
}

test('walkTree: lists nested folders and skips files', async () => {
  const root = makeTree();
  try {
    const entries = await walkTree(root, noCancel);
    const rels = entries.map((e) => path.relative(root, e.fullPath)).sort();
    assert.deepEqual(rels, ['a', 'a/b', 'a/b/c', 'a/deep', 'a/deep/deeper']);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('walkTree: prunes excluded folders including their subtree', async () => {
  const root = makeTree();
  try {
    const rels = walkTree(root, noCancel).then((entries) =>
      entries.map((e) => path.relative(root, e.fullPath)),
    );
    const all = await rels;
    assert.ok(!all.includes('node_modules'));
    assert.ok(!all.includes(path.join('node_modules', 'pkg')));
    assert.ok(!all.includes('dist'));
    assert.ok(!all.includes(path.join('dist', 'x')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('walkTree: honours a custom excludePatterns list', async () => {
  const root = makeTree();
  try {
    const entries = await walkTree(root, noCancel, ['a']);
    const rels = entries.map((e) => path.relative(root, e.fullPath));
    assert.ok(!rels.includes('a'));
    // The default list is not applied when a custom one is passed.
    assert.ok(rels.includes('node_modules'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('walkTree: symlink cycle terminates and symlinks are skipped', async () => {
  const root = makeTree();
  try {
    fs.symlinkSync(root, path.join(root, 'a', 'loop')); // cycle back to root
    fs.symlinkSync(path.join(root, 'a', 'deep'), path.join(root, 'a', 'alias'));

    const entries = await Promise.race([
      walkTree(root, noCancel),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('walkTree hung on symlink cycle')), 2000),
      ),
    ]);
    const rels = entries.map((e) => path.relative(root, e.fullPath));
    assert.ok(!rels.includes(path.join('a', 'loop')));
    assert.ok(!rels.includes(path.join('a', 'alias')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('walkTree: pre-cancelled token returns no entries', async () => {
  const root = makeTree();
  try {
    const entries = await walkTree(root, cancelled);
    assert.deepEqual(entries, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('walkTree: missing root returns no entries without throwing', async () => {
  const entries = await walkTree('/nonexistent/search-folder-test', noCancel);
  assert.deepEqual(entries, []);
});
