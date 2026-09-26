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
  it('round-trips the label through a tab separated line', () => {
    const line = formatCandidateLine({ label: 'feat/a', branch: 'feat/a', path: null });
    assert.equal(line, 'feat/a\tnew');
    assert.equal(parsePickedLine(`${line}\n`), 'feat/a');
  });
});
