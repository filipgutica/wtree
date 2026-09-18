import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { prFor, type PrIndex } from '../src/gh.js';
import type { PrInfo } from '../src/types.js';

const found: PrInfo = {
  status: 'found',
  number: 42,
  state: 'MERGED',
  title: 'do the thing',
  url: 'https://github.com/o/r/pull/42',
  mergedAt: '2026-01-02T03:04:05Z',
  closedAt: '2026-01-02T03:04:05Z',
  updatedAt: '2026-01-02T03:04:05Z',
  isCrossRepository: false,
};

const index = (entries: [string, PrInfo][], truncated = false): PrIndex => ({
  available: true,
  byBranch: new Map(entries),
  fromCache: false,
  truncated,
});

describe('prFor', () => {
  it('returns unknown with the reason when the index is unavailable', () => {
    const result = prFor({ available: false, reason: 'gh: not authenticated' }, 'feat/x');
    assert.deepEqual(result, { status: 'unknown', reason: 'gh: not authenticated' });
  });

  it('returns none for a worktree with no branch', () => {
    assert.deepEqual(prFor(index([]), null), { status: 'none' });
  });

  it('returns the PR when the branch was resolved', () => {
    assert.deepEqual(prFor(index([['feat/x', found]]), 'feat/x'), found);
  });

  it('returns none when the branch was asked about and has no PR', () => {
    const result = prFor(index([['feat/x', { status: 'none' }]]), 'feat/x');
    assert.deepEqual(result, { status: 'none' });
  });

  // The important one: a branch missing from the map was never answered for.
  // Reporting it as `none` would let `clean --pr-state merged` skip real work,
  // and would let a "no PR" filter delete a worktree whose PR is still open.
  it('returns unknown, never none, for a branch that was never resolved', () => {
    const result = prFor(index([['other', found]], true), 'feat/never-asked');
    assert.equal(result.status, 'unknown');
    assert.match(
      result.status === 'unknown' ? result.reason : '',
      /truncated/,
    );
  });
});
