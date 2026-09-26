import { realpathSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { git, run } from './exec.js';
import { getRepoContext, listWorktrees, pathExists, realpathSafe } from './git.js';
import type { RawWorktree } from './types.js';

/** A request we refuse or cannot carry out; the CLI prints the message as is. */
export class CreateError extends Error {}

export interface CreateResult {
  path: string;
  /** False when the branch already had a worktree and we returned it. */
  created: boolean;
  warnings: string[];
  gitOutput: string;
}

const worktreeHome = (): string => join(homedir(), '.wtree');

/** `~/.wtree/<repo>/<branch>`, branch used as is so `feat/foo` nests. */
export const defaultWorktreePath = ({
  mainPath,
  branch,
}: {
  mainPath: string;
  branch: string;
}): string => join(worktreeHome(), basename(mainPath), branch);

let homeCache: { raw: string; real: string } | null = null;

/**
 * The home directory with symlinks resolved. git reports real paths and $HOME
 * may be a symlink. Keyed on the raw value so a changed $HOME is picked up.
 */
export const realHome = (): string => {
  const raw = homedir();
  if (homeCache?.raw !== raw) {
    let real = raw;
    try {
      real = realpathSync(raw);
    } catch {
      // A home that does not exist cannot contain worktrees; the raw path is fine.
    }
    homeCache = { raw, real };
  }
  return homeCache.real;
};

/** `~/.wtree` with the home directory's symlinks resolved. */
export const realWorktreeHome = (): string => join(realHome(), '.wtree');

export const isDefaultLocation = ({
  path,
  mainPath,
  branch,
}: {
  path: string;
  mainPath: string;
  branch: string;
}): boolean => {
  const target = resolve(path);
  return (
    target === join(realWorktreeHome(), basename(mainPath), branch) ||
    target === defaultWorktreePath({ mainPath, branch })
  );
};

export const findByBranch = async ({
  cwd,
  branch,
}: {
  cwd: string;
  branch: string;
}): Promise<RawWorktree | null> =>
  (await listWorktrees(cwd)).find((w) => w.branch === branch) ?? null;

/**
 * A worktree whose directory is gone still has a record, and its branch stays
 * "checked out". Printing that path would send the shell wrapper to a cd that fails.
 */
export const assertLive = async (wt: { path: string; prunable: boolean }): Promise<void> => {
  if (wt.prunable || !(await pathExists(wt.path))) {
    throw new CreateError(`${wt.path} no longer exists; run wtree prune to drop its record`);
  }
};

const refExists = async (ref: string, cwd: string): Promise<boolean> =>
  (await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], cwd)).ok;

const joinOutput = (...parts: string[]): string =>
  parts
    .map((p) => p.trim())
    .filter(Boolean)
    .join('\n');

/**
 * Fetch one branch from origin into its remote-tracking ref. A branch the
 * remote does not have is the normal case for a new name, so it is silent;
 * anything else (network, auth) becomes a warning and we carry on offline.
 */
const fetchBranch = async ({
  cwd,
  branch,
}: {
  cwd: string;
  branch: string;
}): Promise<{ warning: string | null; output: string }> => {
  const res = await run({
    cmd: 'git',
    args: ['fetch', 'origin', `+refs/heads/${branch}:refs/remotes/origin/${branch}`],
    cwd,
    timeoutMs: 60_000,
    // Match on git's English message regardless of the user's locale.
    env: { ...process.env, LC_ALL: 'C' },
  });
  if (res.ok) return { warning: null, output: res.stderr };
  if (/couldn't find remote ref/.test(res.stderr)) return { warning: null, output: '' };
  const firstLine =
    res.stderr
      .split('\n')
      .map((l) => l.replace(/^fatal:\s*/, '').trim())
      .find(Boolean) ?? `exit ${res.code}`;
  return { warning: `fetch failed: ${firstLine}`, output: '' };
};

export const createWorktree = async ({
  cwd,
  branch,
  base,
  fetch,
}: {
  cwd: string;
  branch: string;
  base?: string;
  fetch: boolean;
}): Promise<CreateResult> => {
  // Rejects leading "-", "..", "@{-1}" and friends before they reach a path or an argv.
  const check = await git(['check-ref-format', '--branch', branch], cwd);
  if (!check.ok || check.stdout.trim() !== branch) {
    throw new CreateError(`invalid branch name: ${branch}`);
  }

  const worktrees = await listWorktrees(cwd);
  const mainPath = worktrees[0]?.path;
  if (!mainPath) throw new CreateError('could not find the main worktree');

  const existing = worktrees.find((w) => w.branch === branch);
  if (existing) {
    await assertLive(existing);
    return { path: existing.path, created: false, warnings: [], gitOutput: '' };
  }

  const dir = defaultWorktreePath({ mainPath, branch });
  if (await pathExists(dir)) {
    throw new CreateError(`${dir} already exists but is not a worktree of ${branch}`);
  }

  const warnings: string[] = [];
  const outputs: string[] = [];
  const hasLocal = await refExists(`refs/heads/${branch}`, cwd);

  let fetchWarning: string | null = null;
  if (!hasLocal && fetch && (await git(['remote', 'get-url', 'origin'], cwd)).ok) {
    const fetched = await fetchBranch({ cwd, branch });
    outputs.push(fetched.output);
    fetchWarning = fetched.warning;
  }
  const hasRemote = !hasLocal && (await refExists(`refs/remotes/origin/${branch}`, cwd));

  let args: string[];
  if (hasLocal) {
    if (base) warnings.push(`branch ${branch} already exists; ignoring --from ${base}`);
    args = [dir, branch];
  } else if (hasRemote) {
    // A failed fetch still leaves an older origin/<branch> to start from.
    if (fetchWarning) warnings.push(`${fetchWarning}; using the last fetched origin/${branch}`);
    if (base) warnings.push(`branch ${branch} exists on origin; ignoring --from ${base}`);
    // Explicit, so the result does not depend on branch.autoSetupMerge.
    args = ['--track', '-b', branch, dir, `origin/${branch}`];
  } else {
    const start = base ?? (await getRepoContext(cwd)).defaultBranch;
    if (!start) {
      throw new CreateError(`no base branch to create ${branch} from; pass --from <base>`);
    }
    if (!(await refExists(start, cwd))) throw new CreateError(`base ${start} does not resolve`);
    // A fresh branch must not track the base, or `git push` would target main.
    args = ['--no-track', '-b', branch, dir, start];
    if (fetchWarning) warnings.push(`${fetchWarning}; branching off ${start}`);
  }

  await mkdir(dirname(dir), { recursive: true });
  const res = await git(['worktree', 'add', ...args], cwd);
  if (!res.ok) {
    throw new CreateError(
      `git worktree add failed: ${res.stderr.trim() || res.stdout.trim() || `exit ${res.code}`}`,
    );
  }
  outputs.push(res.stdout, res.stderr);

  // git reports real paths; match them so callers can compare with `list` output.
  return { path: await realpathSafe(dir), created: true, warnings, gitOutput: joinOutput(...outputs) };
};
