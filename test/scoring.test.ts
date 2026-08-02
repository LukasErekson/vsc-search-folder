import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyScore, scoreEntries, isWordBoundary, type ScoreConfig } from '../src/scoring.ts';
import type { FolderEntry } from '../src/tree.ts';

const CFG: ScoreConfig = { threshold: 0.4, maxResults: 50 };

function entry(fullPath: string): FolderEntry {
  return { name: fullPath.split('/').pop()!, fullPath };
}

// Deterministic scores captured from the implementation after the audit. The
// scoring was verified byte-identical to the pre-audit code via a 20 000-case
// randomized parity run, so these values lock the behaviour.
const REGRESSION_CASES: [string, string, number, number][] = [
  ['nom', 'nomination', 0.4, 90],
  ['nom', 'library/nomination', 0.4, 75],
  ['abc', 'someAppBaseConfig', 0.4, -1],
  ['abc', 'someappbaseconfig', 0.4, -1],
  ['sr', 'src', 0.4, 75],
  ['src', 'src', 0.4, 100],
  ['xyz', 'nomination', 0.4, -1],
  ['models/nomination', 'library/models/nomination', 0.4, 360],
  ['Models', 'library/models/nomination', 0.4, -1],
  ['nom', 'nomination', 1, 90],
  ['nom', 'xnomination', 0.9, 60],
  ['m', 'models', 0.4, 50],
  ['m', 'models', 0.9, 50],
];

test('fuzzyScore: regression table (audit parity)', () => {
  for (const [query, name, threshold, expected] of REGRESSION_CASES) {
    assert.equal(
      fuzzyScore(query, name, name, threshold),
      expected,
      `fuzzyScore(${JSON.stringify(query)}, ${JSON.stringify(name)}, ${threshold})`,
    );
  }
});

test('fuzzyScore: empty query never matches', () => {
  assert.equal(fuzzyScore('', 'anything', 'anything', 0.4), -1);
});

test('fuzzyScore: characters must appear in order', () => {
  assert.equal(fuzzyScore('abc', 'cba', 'cba', 0.4), -1);
});

test('fuzzyScore: non-contiguous matches are allowed at a loose threshold', () => {
  assert.ok(fuzzyScore('nm', 'nomination', 'nomination', 0.1) > 0);
  // ...but a weak spread match is filtered out at the default 0.4 threshold.
  assert.equal(fuzzyScore('nm', 'nomination', 'nomination', 0.4), -1);
});

test('fuzzyScore: exact contiguous match outranks a spread match', () => {
  const exact = fuzzyScore('nom', 'nomination', 'nomination', 0.4);
  const spread = fuzzyScore('nm', 'nomination', 'nomination', 0.4);
  assert.ok(exact > spread);
});

test('fuzzyScore: threshold is monotonic – higher never accepts more', () => {
  for (const [query, name] of [
    ['nm', 'nomination'],
    ['mb', 'my-branch'],
    ['sarc', 'src/app/root/components'],
  ] as const) {
    const loose = fuzzyScore(query, name, name, 0);
    const strict = fuzzyScore(query, name, name, 1);
    assert.ok(loose >= strict, `${query} in ${name}: ${loose} vs ${strict}`);
  }
});

test('scoreEntries: displays paths relative to the search root', () => {
  const scored = scoreEntries('nom', [entry('/proj/src/models/nomination')], '/proj/src', CFG);
  assert.equal(scored.length, 1);
  assert.equal(scored[0]!.displayPath, 'models/nomination');
});

test('scoreEntries: the search root itself is shown by its basename', () => {
  const scored = scoreEntries('src', [{ name: 'src', fullPath: '/proj/src' }], '/proj/src', CFG);
  assert.equal(scored[0]?.displayPath, 'src');
  assert.equal(scored[0]?.fullPath, '/proj/src');
});

test('scoreEntries: nested queries match against the full relative path', () => {
  const scored = scoreEntries(
    'models/nomination',
    [entry('/proj/library/models/nomination')],
    '/proj',
    CFG,
  );
  assert.equal(scored.length, 1);
});

test('scoreEntries: normalises backslashes in display paths', (t) => {
  // `path.relative` only treats '\' as a separator on Windows.
  if (process.platform !== 'win32') {
    t.skip('backslash separators only occur on Windows');
    return;
  }
  const scored = scoreEntries('a/b', [{ name: 'b', fullPath: 'C:\\proj\\a\\b' }], 'C:\\proj', CFG);
  assert.equal(scored[0]?.displayPath, 'a/b');
});

test('scoreEntries: sorts by score descending and drops non-matches', () => {
  const scored = scoreEntries(
    'aa',
    [entry('/proj/x/aa'), entry('/proj/other'), entry('/proj/aa')],
    '/proj',
    CFG,
  );
  assert.deepEqual(
    scored.map((s) => s.displayPath),
    ['aa', 'x/aa'],
  );
  assert.ok(scored[0]!.score >= scored[1]!.score);
});

test('scoreEntries: caps results at maxResults', () => {
  const entries = ['aa', 'xaa', 'axa', 'aax'].map((p) => entry(`/proj/${p}`));
  const scored = scoreEntries('a', entries, '/proj', { threshold: 0, maxResults: 2 });
  assert.ok(scored.length <= 2);
});

test('isWordBoundary: separators are boundaries', () => {
  for (const ch of ['_', '-', '.', ' ', '/', '\\']) {
    assert.ok(isWordBoundary(ch), JSON.stringify(ch));
  }
});

test('isWordBoundary: alphanumerics are not boundaries', () => {
  for (const ch of ['a', 'Z', '0']) {
    assert.ok(!isWordBoundary(ch), JSON.stringify(ch));
  }
});
