import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { planRemoval } from '../src/clean.js';
import { makeWorktree } from './helpers.js';

const EXTERNAL_CWD = '/tmp/elsewhere';

const codes = (plan: ReturnType<typeof planRemoval>): string[] =>
  plan.blocks.map((block) => block.code);

describe('planRemoval', () => {
  it('keeps a main-worktree block even with force', () => {
    const plan = planRemoval(makeWorktree({ isMain: true }), {
      cwd: EXTERNAL_CWD,
      force: true,
    });

    assert.deepEqual(codes(plan), ['main']);
    assert.deepEqual(plan.overridden, []);
  });

  it('keeps a current-worktree block for equal and nested cwd paths, even with force', () => {
    for (const cwd of ['/tmp/repo/wt', '/tmp/repo/wt/src']) {
      const plan = planRemoval(makeWorktree(), { cwd, force: true });
      assert.deepEqual(codes(plan), ['current']);
      assert.deepEqual(plan.overridden, []);
    }

    const currentFlagPlan = planRemoval(makeWorktree({ isCurrent: true }), {
      cwd: EXTERNAL_CWD,
      force: true,
    });
    assert.deepEqual(codes(currentFlagPlan), ['current']);
    assert.deepEqual(currentFlagPlan.overridden, []);
  });

  it('keeps an unknown PR-state block when the plan requires PR state, even with force', () => {
    const plan = planRemoval(
      makeWorktree({ pr: { status: 'unknown', reason: 'x' } }),
      { cwd: EXTERNAL_CWD, requiresPrState: true, force: true },
    );

    assert.deepEqual(codes(plan), ['pr-unknown']);
    assert.deepEqual(plan.overridden, []);
  });

  for (const [field, value, code] of [
    ['dirty', true, 'dirty'],
    ['unpushed', 2, 'unpushed'],
    ['locked', true, 'locked'],
  ] as const) {
    it(`blocks ${code} without force and overrides it with force`, () => {
      const wt = makeWorktree({ [field]: value });
      const normal = planRemoval(wt, { cwd: EXTERNAL_CWD });
      const forced = planRemoval(wt, { cwd: EXTERNAL_CWD, force: true });

      assert.deepEqual(codes(normal), [code]);
      assert.deepEqual(normal.overridden, []);
      assert.deepEqual(codes(forced), []);
      assert.deepEqual(forced.overridden.map((block) => block.code), [code]);
    });
  }

  it('only schedules branch deletion for a linked worktree with a branch', () => {
    assert.equal(
      planRemoval(makeWorktree({ branch: 'feature/x' }), {
        cwd: EXTERNAL_CWD,
        deleteBranch: true,
      }).removeBranch,
      'feature/x',
    );
    assert.equal(
      planRemoval(makeWorktree({ branch: null }), {
        cwd: EXTERNAL_CWD,
        deleteBranch: true,
      }).removeBranch,
      null,
    );
    assert.equal(
      planRemoval(makeWorktree({ isMain: true, branch: 'main' }), {
        cwd: EXTERNAL_CWD,
        deleteBranch: true,
      }).removeBranch,
      null,
    );
    assert.equal(
      planRemoval(makeWorktree({ branch: 'feature/x' }), {
        cwd: EXTERNAL_CWD,
        deleteBranch: false,
      }).removeBranch,
      null,
    );
  });

  it('returns no blocks for a fully clean linked worktree', () => {
    const plan = planRemoval(makeWorktree(), { cwd: EXTERNAL_CWD });
    assert.deepEqual(plan.blocks, []);
  });

  // Squash and rebase merges rewrite the commit, so `git branch -d` refuses the
  // branch of a merged PR. Without this, --delete-branch cleans up almost nothing.
  it('marks the branch of a merged PR as safe to force delete', () => {
    const merged = makeWorktree({
      pr: {
        status: 'found',
        number: 7,
        state: 'MERGED',
        title: 't',
        url: 'u',
        mergedAt: '2026-01-01T00:00:00.000Z',
        closedAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        isCrossRepository: false,
      },
    });
    assert.equal(planRemoval(merged, { cwd: EXTERNAL_CWD }).branchDeleteSafe, true);
  });

  it('does not mark open, closed or unknown PR branches as safe to force delete', () => {
    const base = {
      status: 'found' as const,
      number: 7,
      title: 't',
      url: 'u',
      mergedAt: null,
      closedAt: null,
      updatedAt: '2026-01-01T00:00:00.000Z',
      isCrossRepository: false,
    };
    for (const pr of [
      { ...base, state: 'OPEN' as const },
      { ...base, state: 'CLOSED' as const },
      { status: 'none' as const },
      { status: 'unknown' as const, reason: 'offline' },
    ]) {
      assert.equal(
        planRemoval(makeWorktree({ pr }), { cwd: EXTERNAL_CWD }).branchDeleteSafe,
        false,
      );
    }
  });
});
