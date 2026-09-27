import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Block } from '../src/clean.js';
import {
  compactBranchLabel,
  compactPath,
  displayPath,
  formatAge,
  formatSize,
  listHints,
  renderList,
  renderPlan,
  unblockHint,
} from '../src/render.js';
import { makeWorktree } from './helpers.js';

describe('formatAge', () => {
  it('uses the real boundaries at one day', () => {
    assert.equal(formatAge(0.999), '24h');
    assert.equal(formatAge(1), '1d');
    assert.equal(formatAge(1.001), '1d');
  });

  it('uses the real boundaries at 45 days', () => {
    assert.equal(formatAge(44.99), '45d');
    assert.equal(formatAge(45), '2mo');
    assert.equal(formatAge(45.01), '2mo');
  });

  it('uses the real boundaries at 365 days', () => {
    assert.equal(formatAge(364.99), '12mo');
    assert.equal(formatAge(365), '1.0y');
    assert.equal(formatAge(365.01), '1.0y');
  });

  it('formats an unknown age as a question mark', () => {
    assert.equal(formatAge(null), '?');
  });
});

describe('formatSize', () => {
  it('uses K below 1024, M at the first boundary, and G at the second', () => {
    assert.equal(formatSize(1023), '1023K');
    assert.equal(formatSize(1024), '1M');
    assert.equal(formatSize(1024 * 1024 - 1), '1024M');
    assert.equal(formatSize(1024 * 1024), '1.0G');
  });

  it('formats an unknown size with a dash', () => {
    assert.equal(formatSize(null), '-');
  });
});

const merged = {
  status: 'found',
  number: 1,
  state: 'MERGED',
  title: 't',
  url: 'u',
  mergedAt: null,
  closedAt: null,
  updatedAt: '',
  isCrossRepository: false,
} as const;

describe('listHints', () => {
  it('suggests clean --done for merged or closed PRs and prune for prunable worktrees', () => {
    assert.deepEqual(
      listHints([
        makeWorktree({ pr: merged }),
        makeWorktree({ pr: { ...merged, state: 'CLOSED' } }),
        makeWorktree({ prunable: true }),
        makeWorktree(),
      ]),
      [
        '2 worktrees have merged/closed PRs — run wtree clean --done',
        '1 prunable — run wtree prune',
      ],
    );
  });

  it('uses the singular for one worktree and says nothing when there is nothing to do', () => {
    assert.deepEqual(listHints([makeWorktree({ pr: merged })]), [
      '1 worktree has a merged/closed PR — run wtree clean --done',
    ]);
    assert.deepEqual(
      listHints([makeWorktree(), makeWorktree({ pr: { status: 'unknown', reason: 'x' } })]),
      [],
    );
  });
});

describe('unblockHint', () => {
  const dirty: Block = { code: 'dirty', message: 'uncommitted changes', force: true };
  const locked: Block = { code: 'locked', message: 'locked', force: true };
  const main: Block = { code: 'main', message: 'main worktree', force: false };
  const unknown: Block = { code: 'pr-unknown', message: 'PR state unknown (x)', force: false };

  it('points at --force only when every block is forceable', () => {
    assert.equal(unblockHint([dirty, locked]), ' (--force to override)');
    assert.equal(unblockHint([dirty, main]), '');
    assert.equal(unblockHint([]), '');
  });

  it('points at --refresh when PR state is unknown', () => {
    assert.equal(unblockHint([unknown]), ' (try --refresh)');
    assert.equal(unblockHint([unknown, dirty]), ' (try --refresh)');
  });

  it('is appended to skip lines in the plan', () => {
    const out = renderPlan(
      [
        {
          worktree: makeWorktree({ dirty: true }),
          blocks: [dirty],
          overridden: [],
          removeBranch: null,
          branchDeleteSafe: false,
        },
      ],
      '/tmp',
      'commit',
    );
    assert.match(out, /uncommitted changes \(--force to override\)/);
  });
});

describe('displayPath', () => {
  let home: string;
  let savedHome: string | undefined;

  before(() => {
    home = realpathSync(mkdtempSync(join(tmpdir(), 'wtree-render-')));
    mkdirSync(join(home, '.wtree', 'api', 'feat'), { recursive: true });
    savedHome = process.env.HOME;
    process.env.HOME = home;
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(home, { recursive: true, force: true });
  });

  it('shows a dot for a worktree at its default location and the path otherwise', () => {
    const atDefault = makeWorktree({ branch: 'feat/foo', path: join(home, '.wtree', 'api', 'feat', 'foo') });
    const elsewhere = makeWorktree({ branch: 'feat/foo', path: '/src/api-foo' });
    const main = makeWorktree({ branch: 'main', path: '/src/api', isMain: true });
    assert.equal(displayPath({ wt: atDefault, cwd: '/src/api', mainPath: '/src/api' }), '·');
    assert.equal(displayPath({ wt: elsewhere, cwd: '/nowhere', mainPath: '/src/api' }), '/src/api-foo');
    assert.equal(displayPath({ wt: main, cwd: '/nowhere', mainPath: '/src/api' }), '/src/api');
    assert.equal(displayPath({ wt: atDefault, cwd: '/src/api', mainPath: null }), '~/.wtree/api/feat/foo');
  });

  it('is used for the PATH column of the list', () => {
    const out = renderList({
      worktrees: [makeWorktree({ branch: 'feat/foo', path: join(home, '.wtree', 'api', 'feat', 'foo') })],
      ageBasis: 'commit',
      cwd: '/src/api',
      showSize: false,
      mainPath: '/src/api',
      compactPaths: true,
    });
    assert.match(out, /·$/);
  });
});

describe('compact worktree identity', () => {
  it('keeps distinguishing branch and path suffixes within their column widths', () => {
    const branch = 'workbench/ma-5503-use-tabledata-first';
    const wt = makeWorktree({ branch, path: '/tmp/shared/worktrees/' + branch });
    const other = makeWorktree({ branch: branch.replace('first', 'second') });
    const label = compactBranchLabel(wt, 26);
    assert.equal(label.length, 26);
    assert.ok(label.startsWith('workbench/ma-'));
    assert.ok(label.endsWith('-first'));
    assert.notEqual(label, compactBranchLabel(other, 26));
    const path = compactPath({ wt, cwd: '/unrelated', mainPath: null, width: 24 });
    assert.equal(path.length, 24);
    assert.ok(path.startsWith('/tmp/shared'));
    assert.ok(path.endsWith('-first'));
  });

  it('leaves short identities intact and handles very narrow columns', () => {
    const wt = makeWorktree({ branch: 'feat/x', path: '/tmp/x' });
    assert.equal(compactBranchLabel(wt, 20), 'feat/x');
    assert.equal(compactBranchLabel(wt, 1), '…');
    assert.equal(compactBranchLabel(wt, 0), '');
    assert.equal(compactPath({ wt, cwd: '/unrelated', mainPath: null, width: 20 }), '/tmp/x');
  });
});
