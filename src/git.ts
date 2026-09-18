import { realpath, stat, readdir, readFile } from 'node:fs/promises';
import { join, resolve, sep } from 'node:path';
import { git, run } from './exec.js';
import type { RawWorktree } from './types.js';

export class NotAGitRepoError extends Error {}

export interface RepoContext {
  /** Top level of the worktree we were invoked from, or the common dir for a bare repo. */
  root: string;
  /** `.git` directory shared by every worktree of this repo. */
  commonDir: string;
  defaultBranch: string | null;
  remoteUrl: string | null;
}

export const getRepoContext = async (cwd: string): Promise<RepoContext> => {
  const commonDirRes = await git(['rev-parse', '--path-format=absolute', '--git-common-dir'], cwd);
  if (!commonDirRes.ok) {
    throw new NotAGitRepoError(
      `not a git repository (or any parent up to mount point): ${cwd}`,
    );
  }
  const commonDir = commonDirRes.stdout.trim();
  const topRes = await git(['rev-parse', '--path-format=absolute', '--show-toplevel'], cwd);
  const root = topRes.ok && topRes.stdout.trim() ? topRes.stdout.trim() : commonDir;

  const [defaultBranch, remoteUrl] = await Promise.all([
    resolveDefaultBranch(cwd),
    git(['remote', 'get-url', 'origin'], cwd).then((r) => (r.ok ? r.stdout.trim() : null)),
  ]);

  return { root, commonDir, defaultBranch, remoteUrl };
};

/**
 * Best effort default branch: the remote HEAD symref, then the usual names.
 * Null when none of them resolve, in which case merge detection is skipped.
 */
const resolveDefaultBranch = async (cwd: string): Promise<string | null> => {
  const symref = await git(['symbolic-ref', '--quiet', 'refs/remotes/origin/HEAD'], cwd);
  if (symref.ok) {
    const ref = symref.stdout.trim();
    if (ref) return ref.replace(/^refs\/remotes\//, '');
  }
  for (const candidate of ['origin/main', 'origin/master', 'main', 'master']) {
    const res = await git(['rev-parse', '--verify', '--quiet', `${candidate}^{commit}`], cwd);
    if (res.ok && res.stdout.trim()) return candidate;
  }
  return null;
};

/**
 * Parse `git worktree list --porcelain`. Records are separated by blank lines;
 * `locked` and `prunable` may carry a reason on the same line, `detached` and
 * `bare` are bare labels. Verified against git 2.50.
 */
export const parseWorktreePorcelain = (stdout: string): RawWorktree[] => {
  const out: RawWorktree[] = [];
  let current: RawWorktree | null = null;

  const push = () => {
    if (current) out.push(current);
    current = null;
  };

  for (const rawLine of stdout.split('\n')) {
    const line = rawLine.replace(/\r$/, '');
    if (line === '') {
      push();
      continue;
    }
    const spaceAt = line.indexOf(' ');
    const key = spaceAt === -1 ? line : line.slice(0, spaceAt);
    const value = spaceAt === -1 ? '' : line.slice(spaceAt + 1);

    if (key === 'worktree') {
      push();
      current = {
        path: value,
        head: null,
        branch: null,
        bare: false,
        detached: false,
        locked: false,
        lockReason: null,
        prunable: false,
        prunableReason: null,
      };
      continue;
    }
    if (!current) continue;

    switch (key) {
      case 'HEAD':
        current.head = value;
        break;
      case 'branch':
        current.branch = value.replace(/^refs\/heads\//, '');
        break;
      case 'bare':
        current.bare = true;
        break;
      case 'detached':
        current.detached = true;
        break;
      case 'locked':
        current.locked = true;
        current.lockReason = value || null;
        break;
      case 'prunable':
        current.prunable = true;
        current.prunableReason = value || null;
        break;
      default:
        break;
    }
  }
  push();
  return out;
};

export const listWorktrees = async (cwd: string): Promise<RawWorktree[]> => {
  const res = await git(['worktree', 'list', '--porcelain'], cwd);
  if (!res.ok) throw new NotAGitRepoError(res.stderr.trim() || 'git worktree list failed');
  return parseWorktreePorcelain(res.stdout);
};

/**
 * Map each linked worktree path to its admin directory under
 * `$commonDir/worktrees/<name>`, read from the `gitdir` pointer files.
 * Works even when the worktree directory itself is gone.
 */
export const readAdminDirs = async (commonDir: string): Promise<Map<string, string>> => {
  const map = new Map<string, string>();
  const base = join(commonDir, 'worktrees');
  let names: string[];
  try {
    names = await readdir(base);
  } catch {
    return map;
  }
  await Promise.all(
    names.map(async (name) => {
      try {
        const pointer = (await readFile(join(base, name, 'gitdir'), 'utf8')).trim();
        // The pointer targets `<worktree>/.git`; the worktree is its parent.
        const wtPath = pointer.replace(/\/\.git\/?$/, '');
        map.set(resolve(wtPath), join(base, name));
      } catch {
        /* incomplete admin dir; skip */
      }
    }),
  );
  return map;
};

export const mtimeIso = async (path: string): Promise<string | null> => {
  try {
    return (await stat(path)).mtime.toISOString();
  } catch {
    return null;
  }
};

export const birthtimeIso = async (path: string): Promise<string | null> => {
  try {
    const s = await stat(path);
    // birthtime is 0 on filesystems that do not record it; fall back to ctime.
    const ms = s.birthtimeMs > 0 ? s.birthtimeMs : s.ctimeMs;
    return new Date(ms).toISOString();
  } catch {
    return null;
  }
};

export const pathExists = async (path: string): Promise<boolean> => {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
};

/** `du -sk`: kibibytes, portable across macOS and Linux (`du -sb` is GNU-only). */
export const diskUsageKb = async (path: string): Promise<number | null> => {
  const res = await run({ cmd: 'du', args: ['-sk', path], timeoutMs: 120_000 });
  const field = res.stdout.trim().split(/\s+/)[0];
  if (!field) return null;
  const kb = Number.parseInt(field, 10);
  return Number.isFinite(kb) ? kb : null;
};

/**
 * Resolve symlinks so paths compare against git's output. On macOS /tmp is a
 * symlink to /private/tmp, and a plain resolve() would miss the match.
 */
export const realpathSafe = async (path: string): Promise<string> => {
  try {
    return await realpath(path);
  } catch {
    return resolve(path);
  }
};

export const isPathInside = (child: string, parent: string): boolean => {
  const a = resolve(child);
  const b = resolve(parent);
  return a === b || a.startsWith(b.endsWith(sep) ? b : b + sep);
};
