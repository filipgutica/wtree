import { join, resolve } from 'node:path';
import { git, mapLimit } from './exec.js';
import {
  birthtimeIso,
  diskUsageKb,
  isPathInside,
  listWorktrees,
  mtimeIso,
  pathExists,
  readAdminDirs,
  type RepoContext,
} from './git.js';
import { loadPrIndex, prFor, type PrIndex } from './gh.js';
import type { Worktree } from './types.js';

export interface CollectOptions {
  cwd: string;
  repo: RepoContext;
  /** Measure disk usage with `du`. Off by default: it is the slow part. */
  size?: boolean;
  /** Skip GitHub entirely; every PR state becomes unknown. */
  noPr?: boolean;
  refresh?: boolean;
  ttlSeconds?: number;
  concurrency?: number;
}

export interface Collection {
  worktrees: Worktree[];
  prIndex: PrIndex;
}

export const collect = async ({
  cwd,
  repo,
  size = false,
  noPr = false,
  refresh = false,
  ttlSeconds = 600,
  concurrency = 8,
}: CollectOptions): Promise<Collection> => {
  const [raw, adminDirs, prIndex] = await Promise.all([
    listWorktrees(cwd),
    readAdminDirs(repo.commonDir),
    noPr
      ? Promise.resolve<PrIndex>({ available: false, reason: '--no-pr' })
      : loadPrIndex({
          cwd: repo.root,
          commonDir: repo.commonDir,
          remoteUrl: repo.remoteUrl,
          refresh,
          ttlSeconds,
        }),
  ]);

  const worktrees = await mapLimit(raw, concurrency, async (entry, index): Promise<Worktree> => {
    const path = resolve(entry.path);
    const exists = await pathExists(path);
    // The first porcelain record always owns the common git dir.
    const isMain = index === 0;
    const adminDir = isMain ? repo.commonDir : adminDirs.get(path) ?? null;

    const [lastCommitAt, checkoutAt, createdAt, dirty, unpushed, mergedIntoDefault, sizeKb] =
      await Promise.all([
        entry.head && !entry.bare
          ? git(['log', '-1', '--format=%cI', entry.head], repo.root).then((r) =>
              r.ok ? r.stdout.trim() || null : null,
            )
          : Promise.resolve(null),
        adminDir ? mtimeIso(join(adminDir, 'index')) : Promise.resolve(null),
        exists ? birthtimeIso(path) : Promise.resolve(null),
        exists && !entry.bare ? isDirty(path) : Promise.resolve(false),
        exists && !entry.bare ? countUnpushed(path) : Promise.resolve(null),
        isAncestorOfDefault(entry.head, repo),
        size && exists && !entry.bare ? diskUsageKb(path) : Promise.resolve(null),
      ]);

    return {
      ...entry,
      path,
      isMain,
      isCurrent: exists && isPathInside(cwd, path),
      missing: !exists,
      lastCommitAt,
      checkoutAt,
      createdAt,
      dirty,
      unpushed,
      mergedIntoDefault,
      sizeKb,
      pr: prFor(prIndex, entry.branch),
    };
  });

  return { worktrees, prIndex };
};

const isDirty = async (path: string): Promise<boolean> => {
  const res = await git(['status', '--porcelain'], path);
  return res.ok && res.stdout.trim().length > 0;
};

const countUnpushed = async (path: string): Promise<number | null> => {
  const res = await git(['rev-list', '--count', '@{upstream}..HEAD'], path);
  if (!res.ok) return null; // no upstream configured
  const n = Number.parseInt(res.stdout.trim(), 10);
  return Number.isFinite(n) ? n : null;
};

/**
 * True when HEAD is already contained in the default branch. This catches merge
 * commits and fast-forwards only: squash and rebase merges rewrite the commit,
 * so PR state stays the authoritative signal for those.
 */
const isAncestorOfDefault = async (head: string | null, repo: RepoContext): Promise<boolean> => {
  if (!head || !repo.defaultBranch) return false;
  const res = await git(['merge-base', '--is-ancestor', head, repo.defaultBranch], repo.root);
  return res.ok;
};
