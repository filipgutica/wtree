import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { execute, planRemoval } from '../src/clean.js';
import { getRepoContext, listWorktrees } from '../src/git.js';
import type { RepoContext } from '../src/git.js';
import type { Worktree } from '../src/types.js';

let root: string;
let main: string;
let repo: RepoContext;

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

/** Build the enriched record the planner needs, straight from git. */
const worktreeAt = async (path: string): Promise<Worktree> => {
  const raw = (await listWorktrees(main)).find((w) => w.path === path);
  assert.ok(raw, `no worktree record for ${path}`);
  return {
    ...raw,
    isMain: false,
    isCurrent: false,
    missing: false,
    lastCommitAt: null,
    checkoutAt: null,
    createdAt: null,
    dirty: git(['status', '--porcelain'], path).trim().length > 0,
    unpushed: null,
    mergedIntoDefault: false,
    sizeKb: null,
    pr: { status: 'none' },
  };
};

describe('execute', () => {
  before(async () => {
    // git reports real paths, and on macOS /tmp is a symlink to /private/tmp.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wtree-exec-')));
    main = join(root, 'main');
    git(['init', '-q', 'main'], root);
    git(['config', 'user.email', 't@t'], main);
    git(['config', 'user.name', 't'], main);
    writeFileSync(join(main, 'a.txt'), 'a');
    git(['add', '.'], main);
    git(['commit', '-qm', 'init'], main);
    repo = await getRepoContext(main);
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('removes a clean worktree without force', async () => {
    const path = join(root, 'clean1');
    git(['worktree', 'add', '-q', '-b', 'clean1', path], main);
    const plan = planRemoval(await worktreeAt(path), { cwd: main });
    assert.deepEqual(plan.blocks, []);

    const [result] = await execute([plan], { repo });
    assert.equal(result?.removed, true, result?.error ?? '');
    assert.equal(existsSync(path), false);
  });

  it('refuses a dirty worktree without force and removes it with force', async () => {
    const path = join(root, 'dirty1');
    git(['worktree', 'add', '-q', '-b', 'dirty1', path], main);
    writeFileSync(join(path, 'junk.txt'), 'junk');

    const blocked = planRemoval(await worktreeAt(path), { cwd: main });
    assert.equal(blocked.blocks.some((b) => b.code === 'dirty'), true);
    assert.equal(await execute([blocked], { repo }).then((r) => r.length), 0);
    assert.equal(existsSync(path), true);

    const forcedPlan = planRemoval(await worktreeAt(path), { cwd: main, force: true });
    assert.deepEqual(forcedPlan.blocks, []);
    const [result] = await execute([forcedPlan], { repo, force: true });
    assert.equal(result?.removed, true, result?.error ?? '');
    assert.equal(existsSync(path), false);
  });

  // git refuses a locked worktree with a single --force; it wants -f -f.
  // A single flag made the TUI's force-select report an error for locked rows.
  it('removes a locked worktree with force', async () => {
    const path = join(root, 'locked1');
    git(['worktree', 'add', '-q', '-b', 'locked1', path], main);
    git(['worktree', 'lock', path], main);

    const plan = planRemoval(await worktreeAt(path), { cwd: main, force: true });
    assert.deepEqual(plan.blocks, []);
    const [result] = await execute([plan], { repo, force: true });
    assert.equal(result?.removed, true, result?.error ?? '');
    assert.equal(existsSync(path), false);
  });

  it('reports a failure per worktree instead of aborting the batch', async () => {
    const good = join(root, 'good1');
    git(['worktree', 'add', '-q', '-b', 'good1', good], main);
    const goodPlan = planRemoval(await worktreeAt(good), { cwd: main });

    const gonePlan = { ...goodPlan, worktree: { ...goodPlan.worktree, path: join(root, 'nope') } };

    const results = await execute([gonePlan, goodPlan], { repo });
    assert.equal(results.length, 2);
    assert.equal(results[0]?.removed, false);
    assert.ok(results[0]?.error);
    assert.equal(results[1]?.removed, true, results[1]?.error ?? '');
  });
});
