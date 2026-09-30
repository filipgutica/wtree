import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildCandidates, formatCandidateLine, parsePickedLine } from '../src/pick.js';
import type { RawWorktree } from '../src/types.js';

const wt = (path: string, branch: string | null, extra: Partial<RawWorktree> = {}): RawWorktree => ({
  path,
  head: '0'.repeat(40),
  branch,
  bare: false,
  detached: branch === null,
  locked: false,
  lockReason: null,
  prunable: false,
  prunableReason: null,
  ...extra,
});

describe('buildCandidates', () => {
  it('lists worktrees first, then branches without one, in ref order', () => {
    const candidates = buildCandidates({
      worktrees: [wt('/src/api', 'main'), wt('/w/feat', 'feat/a'), wt('/w/detached', null)],
      refs: [
        'refs/heads/feat/b',
        'refs/heads/main',
        'refs/remotes/origin/HEAD',
        'refs/remotes/origin/main',
        'refs/remotes/origin/feat/c',
        'refs/heads/feat/a',
        'refs/remotes/origin/feat/b',
      ],
    });
    assert.deepEqual(
      candidates.map((c) => [c.label, c.path]),
      [
        ['main', '/src/api'],
        ['feat/a', '/w/feat'],
        ['/w/detached', '/w/detached'],
        ['feat/b', null],
        ['feat/c', null],
      ],
    );
    assert.equal(candidates[2]?.branch, null);
    assert.equal(candidates[3]?.branch, 'feat/b');
  });

  it('skips bare entries and HEAD of any remote', () => {
    const candidates = buildCandidates({
      worktrees: [wt('/src/api.git', null, { bare: true, detached: false })],
      refs: ['refs/remotes/upstream/HEAD', 'refs/heads/x'],
    });
    assert.deepEqual(candidates.map((c) => c.label), ['x']);
  });

  it('preserves local branches that resemble remote names or HEAD aliases', () => {
    const candidates = buildCandidates({
      worktrees: [],
      refs: ['refs/heads/origin/topic', 'refs/heads/origin', 'refs/heads/foo/HEAD'],
    });
    assert.deepEqual(candidates.map((c) => c.branch), ['origin/topic', 'origin', 'foo/HEAD']);
  });
});

describe('picker lines', () => {
  it('shows worktree state and context without changing the selected label', () => {
    const existing = formatCandidateLine({
      label: 'main',
      branch: 'main',
      path: '/tmp/wtree-main',
    }, 6);
    const branchOnly = formatCandidateLine({ label: 'feat/a', branch: 'feat/a', path: null }, 6);

    const existingRow = existing.split('\t')[1] ?? '';
    const branchOnlyRow = branchOnly.split('\t')[1] ?? '';
    assert.match(existingRow, /^worktree\s+main\s+\/tmp\/wtree-main$/);
    assert.match(branchOnlyRow, /^branch only\s+feat\/a\s+—$/);
    assert.equal(existingRow.indexOf('/tmp/wtree-main'), branchOnlyRow.indexOf('—'));
    assert.deepEqual(existing.split('\t').slice(2), [
      'main', 'worktree', '/tmp/wtree-main', 'use existing worktree',
    ]);
    assert.deepEqual(branchOnly.split('\t').slice(2), [
      'feat/a', 'branch only', 'no worktree yet', 'create worktree for this branch',
    ]);
    assert.equal(parsePickedLine(`${existing}\n`), 'main');
    assert.equal(parsePickedLine(`${branchOnly}\n`), 'feat/a');
  });

  it('keeps a long branch and full path in the displayed row', () => {
    const branch = 'feature/many-many-many-words-that-are-long/unique-tail';
    const path = '/tmp/full/path/to/worktree';
    const line = formatCandidateLine({ label: branch, branch, path });
    const row = line.split('\t')[1] ?? '';

    assert.ok(row.includes(branch));
    assert.ok(row.includes(path));
    assert.equal(line.split('\t')[2], branch);
    assert.equal(line.split('\t')[4], path);
    assert.equal(parsePickedLine(`${line}\n`), branch);
  });
});
