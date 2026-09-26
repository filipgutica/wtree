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

const isDirty = (path: string): boolean => {
  try {
    return git(['status', '--porcelain'], path).trim().length > 0;
  } catch {
    return false;
  }
};

/** Build the enriched record the planner needs, straight from git. */
const worktreeAt = async (path: string): Promise<Worktree> => {
  const raw = (await listWorktrees(main)).find((w) => w.path === path);
  assert.ok(raw, `no worktree record for ${path}`);
  return {
    ...raw,
    isMain: false,
    isCurrent: false,
    missing: !existsSync(path),
    adminDir: join(main, '.git', 'worktrees', path.split('/').pop() as string),
    lastCommitAt: null,
    checkoutAt: null,
    createdAt: null,
    // A missing directory, or one whose .git file is gone, cannot answer.
    dirty: isDirty(path),
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

  // `git worktree remove` validates the path is still a worktree, so it refuses a
  // prunable record whose .git file is gone even though the directory survives.
  it('prunes a stale record and deletes the leftover directory', async () => {
    const path = join(root, 'broke1');
    git(['worktree', 'add', '-q', '-b', 'broke1', path], main);
    writeFileSync(join(path, 'leftover.txt'), 'x');
    rmSync(join(path, '.git'));

    const wt = await worktreeAt(path);
    assert.equal(wt.prunable, true);

    const [result] = await execute([planRemoval(wt, { cwd: main })], { repo });
    assert.equal(result?.removed, true, result?.error ?? '');
    assert.match(result?.note ?? '', /deleted the leftover directory/);
    assert.equal(existsSync(path), false);
    assert.equal(
      (await listWorktrees(main)).some((w) => w.path === path),
      false,
      'the record must be gone',
    );
  });

  it('keeps the leftover directory when asked', async () => {
    const path = join(root, 'broke2');
    git(['worktree', 'add', '-q', '-b', 'broke2', path], main);
    rmSync(join(path, '.git'));

    const plan = planRemoval(await worktreeAt(path), { cwd: main });
    const [result] = await execute([plan], { repo, keepDirectory: true });
    assert.equal(result?.removed, true, result?.error ?? '');
    assert.match(result?.note ?? '', /left the directory on disk/);
    assert.equal(existsSync(path), true);
    rmSync(path, { recursive: true, force: true });
  });

  // The record is what proves the path was ever a worktree. If the directory
  // still looks like a live checkout, the record is stale in some other way and
  // deleting the tree would be guessing.
  it('refuses to delete a directory that still has a .git entry', async () => {
    const path = join(root, 'broke3');
    git(['worktree', 'add', '-q', '-b', 'broke3', path], main);
    const wt = await worktreeAt(path);
    // Break the admin pointer, not the checkout, so the record reads prunable
    // while the directory is still a perfectly good tree.
    const forged = { ...wt, prunable: true, missing: false };

    const [result] = await execute([planRemoval(forged, { cwd: main })], { repo });
    assert.equal(result?.removed, true, result?.error ?? '');
    assert.match(result?.note ?? '', /still has a \.git entry/);
    assert.equal(existsSync(join(path, '.git')), true, 'the checkout must survive');
    rmSync(path, { recursive: true, force: true });
  });

  // A stale record pointing at an ancestor of the repo would take the repo with it.
  it('refuses to delete a directory that contains the repo', async () => {
    const path = join(root, 'guard1');
    git(['worktree', 'add', '-q', '-b', 'guard1', path], main);
    const wt = await worktreeAt(path);
    const pointsAtParent = { ...wt, path: root, prunable: true, missing: false };

    // Plan from outside the tree, so the "you are inside it" block does not fire
    // first and we actually exercise the directory guard.
    const outside = tmpdir();
    const plan = planRemoval(pointsAtParent, { cwd: outside });
    assert.deepEqual(plan.blocks, [], 'the plan must reach execute for this to test anything');

    const [result] = await execute([plan], { repo });
    assert.match(result?.note ?? '', /it contains/);
    assert.equal(existsSync(main), true, 'the repo must survive');
    assert.equal(existsSync(path), true);
  });

  it('prunes a record whose directory vanished, with no note', async () => {
    const path = join(root, 'gone1');
    git(['worktree', 'add', '-q', '-b', 'gone1', path], main);
    rmSync(path, { recursive: true, force: true });

    const [result] = await execute([planRemoval(await worktreeAt(path), { cwd: main })], { repo });
    assert.equal(result?.removed, true, result?.error ?? '');
    assert.equal(result?.note, null);
  });

  // Pruning through `git worktree prune` would drop every stale record at once,
  // which is more than the caller selected.
  it('leaves other prunable records alone', async () => {
    const target = join(root, 'stale1');
    const bystander = join(root, 'stale2');
    for (const [name, path] of [['stale1', target], ['stale2', bystander]] as const) {
      git(['worktree', 'add', '-q', '-b', name, path], main);
      rmSync(path, { recursive: true, force: true });
    }

    await execute([planRemoval(await worktreeAt(target), { cwd: main })], { repo });
    const after = await listWorktrees(main);
    assert.equal(after.some((w) => w.path === target), false);
    assert.equal(after.some((w) => w.path === bystander), true);
  });

  it('removes empty parents under ~/.wtree/<repo> but keeps the repo directory', async () => {
    const home = join(root, 'home');
    const repoDir = join(home, '.wtree', 'main');
    const savedHome = process.env.HOME;
    process.env.HOME = home;
    try {
      const foo = join(repoDir, 'feat', 'foo');
      const bar = join(repoDir, 'feat', 'bar');
      git(['worktree', 'add', '-q', '-b', 'feat/foo', foo], main);
      git(['worktree', 'add', '-q', '-b', 'feat/bar', bar], main);

      await execute([planRemoval(await worktreeAt(foo), { cwd: main })], { repo });
      assert.equal(existsSync(foo), false);
      assert.equal(existsSync(join(repoDir, 'feat')), true, 'feat/bar still lives in feat/');

      await execute([planRemoval(await worktreeAt(bar), { cwd: main })], { repo });
      assert.equal(existsSync(join(repoDir, 'feat')), false);
      assert.equal(existsSync(repoDir), true, '~/.wtree/<repo> itself is kept');
    } finally {
      if (savedHome === undefined) delete process.env.HOME;
      else process.env.HOME = savedHome;
    }
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
