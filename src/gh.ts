import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { mapLimit, run } from './exec.js';
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
  | {
      available: true;
      byBranch: Map<string, PrInfo>;
      fromCache: boolean;
      /** The bulk list hit its limit, so absence from it proves nothing. */
      truncated: boolean;
    }
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

/** How many branches we are willing to look up one at a time after a truncated list. */
const MAX_TARGETED_LOOKUPS = 60;

const cacheDir = (): string => {
  const base =
    process.env['XDG_CACHE_HOME'] ??
    (process.platform === 'darwin'
      ? join(homedir(), 'Library', 'Caches')
      : join(homedir(), '.cache'));
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

const toInfo = (pr: GhPr): PrInfo => ({
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

/**
 * Pick one PR per branch. Branch names get reused and fork PRs can share a
 * headRefName, so prefer a same-repo PR and then the highest number.
 */
const bestPerBranch = (prs: GhPr[]): Map<string, GhPr> => {
  const best = new Map<string, GhPr>();
  const score = (pr: GhPr): number => (pr.isCrossRepository ? 0 : 1) * 1e9 + pr.number;
  for (const pr of prs) {
    const current = best.get(pr.headRefName);
    if (!current || score(pr) > score(current)) best.set(pr.headRefName, pr);
  }
  return best;
};

const listPrs = async (cwd: string, args: string[]): Promise<GhPr[] | string> => {
  const res = await run({
    cmd: 'gh',
    args: ['pr', 'list', '--state', 'all', '--json', PR_FIELDS, ...args],
    cwd,
    timeoutMs: 60_000,
  });
  if (!res.ok) return res.stderr.trim().split('\n')[0] || 'gh pr list failed';
  try {
    return JSON.parse(res.stdout) as GhPr[];
  } catch {
    return 'could not parse gh output';
  }
};

interface CacheShape {
  at: number;
  /** branch -> PR, or null for "asked and there is none". */
  entries: Record<string, GhPr | null>;
  truncated: boolean;
}

const toIndex = (
  entries: Record<string, GhPr | null>,
  truncated: boolean,
  fromCache: boolean,
): PrIndex => {
  const byBranch = new Map<string, PrInfo>();
  for (const [branch, pr] of Object.entries(entries)) {
    byBranch.set(branch, pr === null ? { status: 'none' } : toInfo(pr));
  }
  return { available: true, byBranch, fromCache, truncated };
};

export interface LoadPrIndexOptions {
  cwd: string;
  commonDir: string;
  remoteUrl: string | null;
  /** The branches we actually need an answer for. */
  branches: readonly string[];
  /** Ignore any cached list and re-query GitHub. */
  refresh?: boolean;
  /** Cache lifetime in seconds. */
  ttlSeconds?: number;
  /** Upper bound on PRs fetched in the bulk call. gh defaults to 30. */
  limit?: number;
}

/**
 * Resolve the PR for each branch we care about.
 *
 * One bulk `gh pr list` covers the common case. That list is newest-first, so on
 * a busy repo it truncates away exactly the old PRs that old worktrees belong to;
 * when it does, each still-unresolved branch gets a targeted lookup. Branches we
 * never managed to ask about stay out of the map and read as unknown, never "none".
 *
 * Any failure (no gh, not authenticated, offline, non-GitHub remote) returns
 * `available: false` so PR state degrades instead of failing the run.
 */
export const loadPrIndex = async ({
  cwd,
  commonDir,
  remoteUrl,
  branches,
  refresh = false,
  ttlSeconds = 600,
  limit = 500,
}: LoadPrIndexOptions): Promise<PrIndex> => {
  if (!isGitHubRemote(remoteUrl)) {
    return {
      available: false,
      reason: remoteUrl ? 'origin remote is not github.com' : 'no origin remote',
    };
  }

  const wanted = [...new Set(branches)];
  const file = cacheFile(commonDir);

  if (!refresh) {
    try {
      const cached = JSON.parse(await readFile(file, 'utf8')) as CacheShape;
      const fresh = Date.now() - cached.at < ttlSeconds * 1000;
      const covers = wanted.every((b) => b in cached.entries);
      if (fresh && covers) return toIndex(cached.entries, cached.truncated, true);
    } catch {
      /* no usable cache */
    }
  }

  const bulk = await listPrs(cwd, ['--limit', String(limit)]);
  if (typeof bulk === 'string') return { available: false, reason: bulk };

  const best = bestPerBranch(bulk);
  const entries: Record<string, GhPr | null> = {};
  const truncated = bulk.length >= limit;

  const missing: string[] = [];
  for (const branch of wanted) {
    const hit = best.get(branch);
    if (hit) entries[branch] = hit;
    else if (truncated) missing.push(branch);
    // Not truncated and not present means the repo genuinely has no PR for it.
    else entries[branch] = null;
  }

  if (missing.length > 0) {
    const askable = missing.slice(0, MAX_TARGETED_LOOKUPS);
    const found = await mapLimit(askable, 6, async (branch) => {
      const res = await listPrs(cwd, ['--head', branch, '--limit', '20']);
      // A failed call and a genuine absence must stay distinguishable: only an
      // answered lookup may record `none`, or we are back to guessing.
      if (typeof res === 'string') return { answered: false as const };
      return { answered: true as const, pr: bestPerBranch(res).get(branch) ?? null };
    });
    askable.forEach((branch, i) => {
      const result = found[i];
      if (result?.answered) entries[branch] = result.pr;
    });
  }

  try {
    await mkdir(cacheDir(), { recursive: true });
    const payload: CacheShape = { at: Date.now(), entries, truncated };
    await writeFile(file, JSON.stringify(payload), 'utf8');
  } catch {
    /* cache is an optimisation; ignore write failures */
  }

  return toIndex(entries, truncated, false);
};

export const prFor = (index: PrIndex, branch: string | null): PrInfo => {
  if (!index.available) return { status: 'unknown', reason: index.reason };
  if (!branch) return { status: 'none' };
  return (
    index.byBranch.get(branch) ?? {
      status: 'unknown',
      reason: 'PR list was truncated and this branch could not be checked',
    }
  );
};
