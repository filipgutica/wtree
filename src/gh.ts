import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { run } from './exec.js';
import type { PrInfo, PrState } from './types.js';

interface GhPr {
  number: number;
  state: string;
  title: string;
  url: string;
  headRefName: string;
  mergedAt: string | null;
  closedAt: string | null;
  updatedAt: string;
  isCrossRepository: boolean;
}

/** Either a usable branch->PR index, or the reason we have none. */
export type PrIndex =
  | { available: true; byBranch: Map<string, PrInfo>; fromCache: boolean }
  | { available: false; reason: string };

const PR_FIELDS = [
  'number',
  'state',
  'title',
  'url',
  'headRefName',
  'mergedAt',
  'closedAt',
  'updatedAt',
  'isCrossRepository',
].join(',');

const cacheDir = (): string => {
  const base =
    process.env['XDG_CACHE_HOME'] ??
    (process.platform === 'darwin' ? join(homedir(), 'Library', 'Caches') : join(homedir(), '.cache'));
  return join(base || tmpdir(), 'wtree');
};

const cacheFile = (commonDir: string): string =>
  join(cacheDir(), `${createHash('sha256').update(commonDir).digest('hex').slice(0, 16)}.json`);

const isGitHubRemote = (url: string | null): boolean =>
  url !== null && /(^|@|\/\/)github\.com([:/]|$)/.test(url);

const toState = (raw: string): PrState => {
  const s = raw.toUpperCase();
  return s === 'MERGED' || s === 'CLOSED' ? s : 'OPEN';
};

/**
 * Pick one PR per branch. Branch names get reused and fork PRs can share a
 * headRefName, so prefer a same-repo PR and then the highest number.
 */
const indexByBranch = (prs: GhPr[]): Map<string, PrInfo> => {
  const best = new Map<string, GhPr>();
  for (const pr of prs) {
    const current = best.get(pr.headRefName);
    if (!current) {
      best.set(pr.headRefName, pr);
      continue;
    }
    const currentScore = (current.isCrossRepository ? 0 : 1) * 1e9 + current.number;
    const prScore = (pr.isCrossRepository ? 0 : 1) * 1e9 + pr.number;
    if (prScore > currentScore) best.set(pr.headRefName, pr);
  }

  const out = new Map<string, PrInfo>();
  for (const [branch, pr] of best) {
    out.set(branch, {
      status: 'found',
      number: pr.number,
      state: toState(pr.state),
      title: pr.title,
      url: pr.url,
      mergedAt: pr.mergedAt,
      closedAt: pr.closedAt,
      updatedAt: pr.updatedAt,
      isCrossRepository: pr.isCrossRepository,
    });
  }
  return out;
};

export interface LoadPrIndexOptions {
  cwd: string;
  commonDir: string;
  remoteUrl: string | null;
  /** Ignore any cached list and re-query GitHub. */
  refresh?: boolean;
  /** Cache lifetime in seconds. */
  ttlSeconds?: number;
  /** Upper bound on PRs fetched. gh defaults to 30, which silently truncates. */
  limit?: number;
}

/**
 * Fetch every PR for the repo in one `gh` call and index it by head branch.
 * Any failure (no gh, not authenticated, offline, non-GitHub remote) returns
 * `available: false` so PR state degrades to unknown instead of failing the run.
 */
export const loadPrIndex = async ({
  cwd,
  commonDir,
  remoteUrl,
  refresh = false,
  ttlSeconds = 600,
  limit = 1000,
}: LoadPrIndexOptions): Promise<PrIndex> => {
  if (!isGitHubRemote(remoteUrl)) {
    return {
      available: false,
      reason: remoteUrl ? 'origin remote is not github.com' : 'no origin remote',
    };
  }

  const file = cacheFile(commonDir);
  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(file, 'utf8')) as { at: number; prs: GhPr[] };
      if (Date.now() - cached.at < ttlSeconds * 1000) {
        return { available: true, byBranch: indexByBranch(cached.prs), fromCache: true };
      }
    } catch {
      /* no usable cache */
    }
  }

  const res = await run({
    cmd: 'gh',
    args: ['pr', 'list', '--state', 'all', '--limit', String(limit), '--json', PR_FIELDS],
    cwd,
    timeoutMs: 60_000,
  });
  if (!res.ok) {
    const stderr = res.stderr.trim().split('\n')[0] ?? '';
    return { available: false, reason: stderr || 'gh pr list failed' };
  }

  let prs: GhPr[];
  try {
    prs = JSON.parse(res.stdout) as GhPr[];
  } catch {
    return { available: false, reason: 'could not parse gh output' };
  }

  try {
    await mkdir(cacheDir(), { recursive: true });
    await writeFile(file, JSON.stringify({ at: Date.now(), prs }), 'utf8');
  } catch {
    /* cache is an optimisation; ignore write failures */
  }

  return { available: true, byBranch: indexByBranch(prs), fromCache: false };
};

export const prFor = (index: PrIndex, branch: string | null): PrInfo => {
  if (!index.available) return { status: 'unknown', reason: index.reason };
  if (!branch) return { status: 'none' };
  return index.byBranch.get(branch) ?? { status: 'none' };
};
