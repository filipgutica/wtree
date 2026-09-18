import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { parseWorktreePorcelain } from '../src/git.js';

const HEAD = '856fab46506eaa6e6b964102d22986e7524db931';

const FIXTURE = [
  'worktree /tmp/p/main',
  `HEAD ${HEAD}`,
  'branch refs/heads/main',
  '',
  'worktree /tmp/p/wt-detached',
  `HEAD ${HEAD}`,
  'detached',
  'locked busy',
  '',
  'worktree /tmp/p/wt-gone',
  `HEAD ${HEAD}`,
  'branch refs/heads/gone',
  'prunable gitdir file points to non-existent location',
].join('\n');

describe('parseWorktreePorcelain', () => {
  it('parses all records and their complete state from git 2.50 output', () => {
    assert.deepEqual(parseWorktreePorcelain(FIXTURE), [
      {
        path: '/tmp/p/main',
        head: HEAD,
        branch: 'main',
        bare: false,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        prunableReason: null,
      },
      {
        path: '/tmp/p/wt-detached',
        head: HEAD,
        branch: null,
        bare: false,
        detached: true,
        locked: true,
        lockReason: 'busy',
        prunable: false,
        prunableReason: null,
      },
      {
        path: '/tmp/p/wt-gone',
        head: HEAD,
        branch: 'gone',
        bare: false,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: true,
        prunableReason: 'gitdir file points to non-existent location',
      },
    ]);
  });

  it('parses a bare record with no HEAD or branch', () => {
    assert.deepEqual(parseWorktreePorcelain('worktree /tmp/p/bare\nbare'), [
      {
        path: '/tmp/p/bare',
        head: null,
        branch: null,
        bare: true,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        prunableReason: null,
      },
    ]);
  });

  it('parses a trailing record without a trailing blank line', () => {
    assert.deepEqual(parseWorktreePorcelain('worktree /tmp/p/wt\nHEAD abc\nbranch refs/heads/x'), [
      {
        path: '/tmp/p/wt',
        head: 'abc',
        branch: 'x',
        bare: false,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        prunableReason: null,
      },
    ]);
  });

  it('treats CRLF line endings as equivalent to LF', () => {
    assert.deepEqual(parseWorktreePorcelain(FIXTURE.replaceAll('\n', '\r\n')), parseWorktreePorcelain(FIXTURE));
  });

  it('keeps a lock reason null for a bare locked label', () => {
    assert.deepEqual(
      parseWorktreePorcelain(
        [
          'worktree /tmp/p/no-reason',
          'locked',
          '',
          'worktree /tmp/p/with-reason',
          'locked busy',
        ].join('\n'),
      ),
      [
        {
          path: '/tmp/p/no-reason',
          head: null,
          branch: null,
          bare: false,
          detached: false,
          locked: true,
          lockReason: null,
          prunable: false,
          prunableReason: null,
        },
        {
          path: '/tmp/p/with-reason',
          head: null,
          branch: null,
          bare: false,
          detached: false,
          locked: true,
          lockReason: 'busy',
          prunable: false,
          prunableReason: null,
        },
      ],
    );
  });
});
