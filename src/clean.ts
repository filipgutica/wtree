import { readdir, rm, rmdir, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { realWorktreeHome } from './create.js';
import { git } from './exec.js';
import { isPathInside, type RepoContext } from './git.js';
import type { Worktree } from './types.js';

/** A reason a worktree must not be removed. `force` says whether --force clears it. */
export interface Block {
  code:
    | 'main'
    | 'current'
    | 'locked'
    | 'dirty'
    | 'unpushed'
    | 'pr-unknown';
  message: string;
  force: boolean;
}

export interface Plan {
  worktree: Worktree;
  /** Removal proceeds only when this is empty. */
  blocks: Block[];
  /** Blocks that `--force` would clear. Empty when nothing is forceable. */
  overridden: Block[];
  removeBranch: string | null;
  /**
   * GitHub holds the commits of a merged PR, so its branch can be force deleted.
   * Most repos squash or rebase, which rewrites the commit and makes
   * `git branch -d` refuse every branch it was asked to clean up.
   */
  branchDeleteSafe: boolean;
}

export interface PlanOptions {
  cwd: string;
  force?: boolean;
  deleteBranch?: boolean;
  /** True when the caller filtered on PR state and so depends on it being known. */
  requiresPrState?: boolean;
}

/**
 * Decide, per worktree, whether removal is allowed and why not.
 * Every check is evaluated so the printed plan is complete rather than
 * stopping at the first problem.
 */
export const planRemoval = (wt: Worktree, opts: PlanOptions): Plan => {
  const raw: Block[] = [];

  if (wt.isMain) {
    raw.push({ code: 'main', message: 'main worktree', force: false });
  }
  if (wt.isCurrent || isPathInside(opts.cwd, wt.path)) {
    raw.push({ code: 'current', message: 'you are inside it', force: false });
  }
  if (opts.requiresPrState && wt.pr.status === 'unknown') {
    // A PR-state filter that cannot be evaluated must never match. Fail closed.
    raw.push({
      code: 'pr-unknown',
      message: `PR state unknown (${wt.pr.reason})`,
      force: false,
    });
  }
  if (wt.locked) {
    raw.push({
      code: 'locked',
      message: wt.lockReason ? `locked: ${wt.lockReason}` : 'locked',
      force: true,
    });
  }
  if (wt.dirty) {
    raw.push({ code: 'dirty', message: 'uncommitted changes', force: true });
  }
  if (wt.unpushed !== null && wt.unpushed > 0) {
    raw.push({
      code: 'unpushed',
      message: `${wt.unpushed} unpushed commit${wt.unpushed === 1 ? '' : 's'}`,
      force: true,
    });
  }

  const forcing = opts.force === true;
  const blocks = forcing ? raw.filter((b) => !b.force) : raw;
  const overridden = forcing ? raw.filter((b) => b.force) : [];

  return {
    worktree: wt,
    blocks,
    overridden,
    removeBranch: opts.deleteBranch && wt.branch && !wt.isMain ? wt.branch : null,
    branchDeleteSafe: wt.pr.status === 'found' && wt.pr.state === 'MERGED',
  };
};

export const planAll = (worktrees: Worktree[], opts: PlanOptions): Plan[] =>
  worktrees.map((wt) => planRemoval(wt, opts));

export interface RemovalResult {
  path: string;
  branch: string | null;
  removed: boolean;
  branchDeleted: boolean;
  error: string | null;
  branchError: string | null;
  /** Something the caller should know that is not an error, e.g. a leftover directory. */
  note: string | null;
}

/** Emitted around each removal so a caller can show progress on a long batch. */
export type ExecuteEvent =
  | { phase: 'start'; index: number; total: number; path: string }
  | { phase: 'done'; index: number; total: number; path: string; result: RemovalResult };

export interface ExecuteOptions {
  repo: RepoContext;
  onProgress?: (event: ExecuteEvent) => void;
  force?: boolean;
  /** Use `git branch -D` for every branch, not just the ones with a merged PR. */
  forceBranchDelete?: boolean;
  /** Prune a stale record but leave its directory on disk. */
  keepDirectory?: boolean;
}

/**
 * Remove the worktrees in `plans` that have no blocking reason.
 * Each removal is independent: one failure does not stop the rest.
 */
export const execute = async (
  plans: Plan[],
  { repo, force = false, forceBranchDelete = false, keepDirectory = false, onProgress }: ExecuteOptions,
): Promise<RemovalResult[]> => {
  const results: RemovalResult[] = [];
  const runnable = plans.filter((plan) => plan.blocks.length === 0);
  const total = runnable.length;

  for (const [index, plan] of runnable.entries()) {
    const { worktree } = plan;
    onProgress?.({ phase: 'start', index, total, path: worktree.path });

    const result: RemovalResult = {
      path: worktree.path,
      branch: plan.removeBranch,
      removed: false,
      branchDeleted: false,
      error: null,
      branchError: null,
      note: null,
    };

    if (worktree.prunable) {
      // `git worktree remove` first validates that the path is still a worktree,
      // which a prunable record by definition is not - its .git file or its whole
      // directory is gone. Dropping the record under .git/worktrees is exactly
      // what `git worktree prune` does, scoped to this one entry so the other
      // prunable records are left alone.
      const removed = await pruneRecord(worktree, repo, keepDirectory);
      result.removed = removed.ok;
      result.error = removed.ok ? null : removed.reason;
      result.note = removed.ok ? removed.note : null;
    } else {
      const args = ['worktree', 'remove'];
      if (force) {
        args.push('--force');
        // git needs --force twice to remove a locked worktree: once for the lock,
        // once for whatever else (a dirty tree) it would have refused anyway.
        if (worktree.locked) args.push('--force');
      }
      args.push(worktree.path);
      const removal = await git(args, repo.root);
      result.removed = removal.ok;
      result.error = removal.ok ? null : removal.stderr.trim() || `git exited ${removal.code}`;
    }

    if (result.removed) await removeEmptyParents(worktree.path);

    // Deleting the branch of a worktree that is still there would orphan the checkout.
    if (result.removed && plan.removeBranch) {
      const flag = forceBranchDelete || plan.branchDeleteSafe ? '-D' : '-d';
      const del = await git(['branch', flag, plan.removeBranch], repo.root);
      result.branchDeleted = del.ok;
      if (!del.ok) result.branchError = del.stderr.trim() || `git exited ${del.code}`;
    }

    results.push(result);
    onProgress?.({ phase: 'done', index, total, path: worktree.path, result });
  }

  return results;
};

/**
 * `feat/foo` lives at `~/.wtree/<repo>/feat/foo`, so removing it can leave an
 * empty `feat/`. Walk up removing empty directories, stopping at (and keeping)
 * `~/.wtree/<repo>`. rmdir refuses a non-empty directory, which is what makes
 * this safe; paths outside `~/.wtree` are never touched.
 */
const removeEmptyParents = async (path: string): Promise<void> => {
  const base = realWorktreeHome();
  const rel = relative(base, resolve(path));
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return;
  const [repoDir] = rel.split(sep);
  if (!repoDir) return;
  const stop = join(base, repoDir);
  for (let dir = dirname(resolve(path)); dir.startsWith(stop + sep); dir = dirname(dir)) {
    try {
      await rmdir(dir);
    } catch {
      // Not empty, already gone, or not ours to remove: the walk ends here and
      // the removal itself still succeeded.
      return;
    }
  }
};

type PruneOutcome =
  | { ok: true; note: string | null }
  | { ok: false; reason: string };

/**
 * Whether it is safe to delete a leftover worktree directory.
 *
 * The path comes from git's own worktree record, so it was created by
 * `git worktree add` and deleting it is what `remove` would have done. These
 * checks exist for the cases where that record has gone stale in a way that
 * would make the delete catastrophic rather than merely wrong.
 */
const canDeleteDirectory = async (
  path: string,
  repo: RepoContext,
): Promise<{ ok: true } | { ok: false; reason: string }> => {
  const target = resolve(path);

  if (target === sep || target === resolve(homedir()) || dirname(target) === target) {
    return { ok: false, reason: 'refusing to delete a root or home directory' };
  }
  // An ancestor of the repo, or of the common git dir, would take them with it.
  for (const guarded of [repo.root, repo.commonDir, process.cwd()]) {
    const g = resolve(guarded);
    if (g === target || g.startsWith(target.endsWith(sep) ? target : target + sep)) {
      return { ok: false, reason: `it contains ${guarded}` };
    }
  }
  try {
    if (!(await stat(target)).isDirectory()) {
      return { ok: false, reason: 'not a directory' };
    }
    // A live .git means git should have been able to remove it normally, so the
    // record is not stale in the way we think it is. Do not guess.
    const entries = await readdir(target);
    if (entries.includes('.git')) {
      return { ok: false, reason: 'it still has a .git entry' };
    }
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
  return { ok: true };
};

/**
 * Drop one stale worktree record. `git worktree prune` has no per-path form, so
 * pruning through it would also drop every other prunable record in the repo -
 * more than the caller selected. Removing this record's directory under
 * .git/worktrees is the same operation, scoped to one entry.
 */
const pruneRecord = async (
  worktree: Plan['worktree'],
  repo: RepoContext,
  keepDirectory: boolean,
): Promise<PruneOutcome> => {
  if (!worktree.adminDir) {
    return { ok: false, reason: 'no worktree record to prune' };
  }

  let note: string | null = null;

  // Delete the directory before the record, while git's own bookkeeping still
  // vouches for the path. Once the record is pruned there is nothing left to
  // prove this directory was ever a worktree of this repo.
  if (!worktree.missing) {
    if (keepDirectory) {
      note = `left the directory on disk at ${worktree.path}`;
    } else {
      const check = await canDeleteDirectory(worktree.path, repo);
      if (!check.ok) {
        note = `left the directory on disk at ${worktree.path}: ${check.reason}`;
      } else {
        try {
          await rm(worktree.path, { recursive: true, force: true });
          note = 'pruned the stale record and deleted the leftover directory';
        } catch (error) {
          const why = error instanceof Error ? error.message : String(error);
          note = `left the directory on disk at ${worktree.path}: ${why}`;
        }
      }
    }
  }

  try {
    await rm(worktree.adminDir, { recursive: true, force: true });
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }

  return { ok: true, note };
};

/** `git worktree prune`: drop admin records whose directory is gone. */
export const prune = async (repo: RepoContext, dryRun: boolean): Promise<string> => {
  const args = ['worktree', 'prune', '--verbose'];
  if (dryRun) args.push('--dry-run');
  const res = await git(args, repo.root);
  // git worktree prune reports on stderr, including under --dry-run.
  return [res.stdout, res.stderr].map((s) => s.trim()).filter(Boolean).join('\n');
};
