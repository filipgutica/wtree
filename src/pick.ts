import { closeSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { createInterface } from 'node:readline';
import { ReadStream } from 'node:tty';
import { git, runWithInput } from './exec.js';
import { listWorktrees } from './git.js';
import type { RawWorktree } from './types.js';

export interface Candidate {
  /** What the user sees and types: the branch, or the path of a detached worktree. */
  label: string;
  branch: string | null;
  /** Worktree directory, null for a branch that has none yet. */
  path: string | null;
}

/**
 * Worktrees first, then branches without one in the order given (most recent
 * commit first). Full refnames distinguish local names from origin's remote
 * branches, so a local `origin/topic` keeps its name. Remote HEAD is dropped.
 */
export const buildCandidates = ({
  worktrees,
  refs,
}: {
  worktrees: readonly RawWorktree[];
  refs: readonly string[];
}): Candidate[] => {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  for (const w of worktrees) {
    if (w.bare) continue;
    const label = w.branch ?? w.path;
    if (seen.has(label)) continue;
    seen.add(label);
    out.push({ label, branch: w.branch, path: w.path });
  }
  for (const ref of refs) {
    let branch: string;
    if (ref.startsWith('refs/heads/')) branch = ref.slice('refs/heads/'.length);
    else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD') {
      branch = ref.slice('refs/remotes/origin/'.length);
    } else continue;
    if (!branch || seen.has(branch)) continue;
    seen.add(branch);
    out.push({ label: branch, branch, path: null });
  }
  return out;
};

/** Read-only and fast: no gh, no per-worktree status. */
export const loadCandidates = async (cwd: string): Promise<Candidate[]> => {
  const [worktrees, refs] = await Promise.all([
    listWorktrees(cwd),
    git(
      [
        'for-each-ref',
        '--sort=-committerdate',
        '--format=%(refname)',
        'refs/heads',
        'refs/remotes/origin',
      ],
      cwd,
    ),
  ]);
  // Full refnames, because %(refname:short) turns an ambiguous name into
  // "heads/x". Other remotes are left out: `new` only knows how to track origin.
  const refNames = refs.ok
    ? refs.stdout
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
    : [];
  return buildCandidates({ worktrees, refs: refNames });
};

const shortenHome = (path: string): string => {
  const home = homedir();
  return path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
};

export const formatCandidateLine = (c: Candidate): string =>
  `${c.label}\t${c.path ? shortenHome(c.path) : 'new'}`;

export const parsePickedLine = (line: string): string => (line.split('\t')[0] ?? '').trim();

export type PickResult =
  | { status: 'picked'; candidate: Candidate }
  | { status: 'cancelled' }
  | { status: 'no-tty' }
  | { status: 'failed'; code: number };

const pickWithFzf = async ({
  candidates,
  query,
}: {
  candidates: readonly Candidate[];
  query?: string;
}): Promise<PickResult | null> => {
  const args = [
    '--height=40%',
    '--reverse',
    '--prompt=worktree> ',
    '--delimiter=\t',
    ...(query ? ['--query', query] : []),
  ];
  const res = await runWithInput({
    cmd: 'fzf',
    args,
    input: candidates.map(formatCandidateLine).join('\n') + '\n',
  });
  if (res.code === 127) return null;
  // 1: no match, 130: interrupted. Both are the user backing out.
  if (res.code === 1 || res.code === 130) return { status: 'cancelled' };
  if (res.code !== 0) return { status: 'failed', code: res.code };
  const label = parsePickedLine(res.stdout);
  const candidate = candidates.find((c) => c.label === label);
  return candidate ? { status: 'picked', candidate } : { status: 'cancelled' };
};

/** One line from the controlling terminal, so stdout stays free for the path. */
const readTtyLine = (fd: number): Promise<string> =>
  new Promise((resolve) => {
    const input = new ReadStream(fd);
    const rl = createInterface({ input, terminal: false });
    let answer = '';
    rl.once('line', (line) => {
      answer = line;
      rl.close();
    });
    rl.once('close', () => {
      // A live tty stream keeps the event loop running after we have our answer.
      input.destroy();
      resolve(answer);
    });
  });

const pickWithPrompt = async ({
  candidates,
  query,
  fd,
}: {
  candidates: readonly Candidate[];
  query?: string;
  fd: number;
}): Promise<PickResult> => {
  const shown = query ? candidates.filter((c) => c.label.includes(query)) : [...candidates];
  if (shown.length === 0) {
    process.stderr.write(`no worktree or branch matches "${query ?? ''}"\n`);
    closeSync(fd);
    return { status: 'cancelled' };
  }
  const width = String(shown.length).length;
  shown.forEach((c, i) => {
    const where = c.path ? shortenHome(c.path) : 'new';
    process.stderr.write(`${String(i + 1).padStart(width)}) ${c.label}  ${where}\n`);
  });
  process.stderr.write('worktree> ');
  const answer = (await readTtyLine(fd)).trim();
  const index = Number.parseInt(answer, 10);
  const candidate = /^\d+$/.test(answer) ? shown[index - 1] : undefined;
  return candidate ? { status: 'picked', candidate } : { status: 'cancelled' };
};

/**
 * fzf when it is installed, else a numbered list on stderr read from /dev/tty.
 * Both need a terminal, so check for one first and fail the same way either way.
 */
export const pickCandidate = async ({
  candidates,
  query,
}: {
  candidates: readonly Candidate[];
  query?: string;
}): Promise<PickResult> => {
  let fd: number;
  try {
    fd = openSync('/dev/tty', 'r');
  } catch {
    return { status: 'no-tty' };
  }
  let viaFzf: PickResult | null;
  try {
    viaFzf = await pickWithFzf({ candidates, query });
  } catch (error) {
    closeSync(fd);
    throw error;
  }
  if (viaFzf) {
    closeSync(fd);
    return viaFzf;
  }
  return pickWithPrompt({ candidates, query, fd });
};
