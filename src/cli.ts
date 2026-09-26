#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { Command, InvalidArgumentError } from 'commander';
import { collect, type Collection } from './enrich.js';
import { execute, planAll, prune, type Plan } from './clean.js';
import {
  InvalidFilterError,
  applyFilters,
  parseCutoff,
  parsePrStates,
  sortWorktrees,
  type Filters,
  type SortKey,
} from './filter.js';
import { NotAGitRepoError, getRepoContext, listWorktrees, realpathSafe, type RepoContext } from './git.js';
import { CreateError, assertLive, createWorktree, type CreateResult } from './create.js';
import { loadCandidates, pickCandidate } from './pick.js';
import {
  legend,
  paint,
  planToJson,
  renderList,
  renderPlan,
  toJson,
} from './render.js';
import type { AgeBasis } from './types.js';

const packageJson: unknown = JSON.parse(
  readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
);
if (
  typeof packageJson !== 'object' ||
  packageJson === null ||
  !('version' in packageJson) ||
  typeof packageJson.version !== 'string'
) {
  throw new Error('package.json must contain a version string');
}
const VERSION = packageJson.version;

const AGE_BASES: readonly AgeBasis[] = ['commit', 'checkout', 'created'];
const SORT_KEYS: readonly SortKey[] = ['age', 'path', 'branch', 'size', 'pr'];

interface GlobalOptions {
  cwd?: string;
  pr: boolean;
  refresh?: boolean;
  size?: boolean;
  ageBy: AgeBasis;
  ttl: number;
  prLimit: number;
  color?: boolean;
}

interface FilterOptions {
  prState?: string;
  olderThan?: string;
  newerThan?: string;
  branch?: string;
  dirty?: boolean;
  prunable?: boolean;
  missing?: boolean;
  merged?: boolean;
  locked?: boolean;
}

const oneOf = <T extends string>(values: readonly T[]) => (value: string): T => {
  if (!(values as readonly string[]).includes(value)) {
    throw new InvalidArgumentError(`expected one of: ${values.join(', ')}`);
  }
  return value as T;
};

const positiveInt = (value: string): number => {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n) || n < 0) throw new InvalidArgumentError('expected a non-negative integer');
  return n;
};

/** True when a filter option that actually narrows the set was supplied. */
const hasNarrowingFilter = (f: FilterOptions): boolean =>
  f.prState !== undefined ||
  f.olderThan !== undefined ||
  f.newerThan !== undefined ||
  f.branch !== undefined ||
  f.dirty !== undefined ||
  f.prunable !== undefined ||
  f.missing !== undefined ||
  f.merged !== undefined ||
  f.locked !== undefined;

const buildFilters = (
  f: FilterOptions,
  ageBasis: AgeBasis,
  includeMain: boolean,
): Filters => ({
  ageBasis,
  includeMain,
  ...(f.prState !== undefined ? { prState: parsePrStates(f.prState) } : {}),
  ...(f.olderThan !== undefined ? { olderThan: parseCutoff(f.olderThan) } : {}),
  ...(f.newerThan !== undefined ? { newerThan: parseCutoff(f.newerThan) } : {}),
  ...(f.branch !== undefined ? { branch: f.branch } : {}),
  ...(f.dirty !== undefined ? { dirty: f.dirty } : {}),
  ...(f.prunable !== undefined ? { prunable: f.prunable } : {}),
  ...(f.missing !== undefined ? { missing: f.missing } : {}),
  ...(f.merged !== undefined ? { mergedIntoDefault: f.merged } : {}),
  ...(f.locked !== undefined ? { locked: f.locked } : {}),
});

const withFilterOptions = (cmd: Command): Command =>
  cmd
    .option(
      '--pr-state <states>',
      'comma separated: open, merged, closed, none, unknown',
    )
    .option('--older-than <age>', 'only worktrees older than 30d / 3mo / 1y / 2025-01-31')
    .option('--newer-than <age>', 'only worktrees newer than the given age or date')
    .option('--branch <glob>', 'only branches matching this glob (* and ? supported)')
    .option('--dirty', 'only worktrees with uncommitted changes')
    .option('--no-dirty', 'only clean worktrees')
    .option('--prunable', 'only worktrees git reports as prunable')
    .option('--missing', 'only worktrees whose directory is gone')
    .option('--merged', 'only worktrees whose HEAD is already in the default branch')
    .option('--locked', 'only locked worktrees');

const resolveCwd = (opts: GlobalOptions): string => opts.cwd ?? process.cwd();

const gather = async (
  opts: GlobalOptions,
): Promise<{ cwd: string; repo: RepoContext; collection: Collection }> => {
  const cwd = await realpathSafe(resolveCwd(opts));
  const repo = await getRepoContext(cwd);
  const collection = await collect({
    cwd,
    repo,
    size: opts.size === true,
    noPr: opts.pr === false,
    refresh: opts.refresh === true,
    ttlSeconds: opts.ttl,
    prLimit: opts.prLimit,
  });
  return { cwd, repo, collection };
};

/** Warn once, on stderr, when PR state could not be resolved. */
const warnPrUnavailable = (collection: Collection, quiet: boolean): void => {
  if (quiet || collection.prIndex.available) return;
  process.stderr.write(
    paint(
      `note: PR state unavailable (${collection.prIndex.reason}); shown as "?"\n`,
      'yellow',
    ),
  );
};

/**
 * Ask before removing. Only reached on a terminal: without one there is nobody
 * to answer, so the caller must have said --yes or --dry-run up front.
 */
const confirm = async (question: string): Promise<boolean> => {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`${question} [y/N] `);
    return answer.trim().toLowerCase() === 'y';
  } finally {
    rl.close();
  }
};

const program = new Command();

program
  .name('wtree')
  .description('A better git worktree list: age, size, PR state, and bulk cleanup.')
  .version(VERSION)
  .option('-C, --cwd <dir>', 'run as if started in <dir>')
  .option('--no-pr', 'skip GitHub entirely; PR state becomes unknown')
  .option('--refresh', 'ignore the cached PR list and re-query GitHub')
  .option('--size', 'measure disk usage with du (slow on large trees)')
  .option(
    '--age-by <basis>',
    `which timestamp age uses: ${AGE_BASES.join(', ')}`,
    oneOf(AGE_BASES),
    'commit' as AgeBasis,
  )
  .option('--ttl <seconds>', 'PR cache lifetime', positiveInt, 600)
  .option(
    '--pr-limit <n>',
    'how many PRs to fetch in the bulk gh call before falling back to per-branch lookups',
    positiveInt,
    500,
  )
  .showHelpAfterError();

const listCommand = withFilterOptions(
  program
    .command('list', { isDefault: true })
    .description('show every worktree for this repo')
    .option('--json', 'machine readable output')
    .option('--sort <key>', `sort by ${SORT_KEYS.join(', ')}`, oneOf(SORT_KEYS), 'age' as SortKey)
    .option('--reverse', 'reverse the sort')
    .option('--no-main', 'hide the main worktree'),
);

listCommand.action(
  async (
    opts: FilterOptions & { json?: boolean; sort: SortKey; reverse?: boolean; main: boolean },
  ) => {
    const globals = program.opts<GlobalOptions>();
    const filters = buildFilters(opts, globals.ageBy, opts.main !== false);

    const { cwd, collection } = await gather(globals);
    const selected = sortWorktrees(
      applyFilters(collection.worktrees, filters),
      opts.sort,
      globals.ageBy,
      opts.reverse === true,
    );

    if (opts.json) {
      process.stdout.write(`${JSON.stringify(toJson(selected, globals.ageBy), null, 2)}\n`);
      return;
    }

    warnPrUnavailable(collection, false);
    if (selected.length === 0) {
      process.stdout.write(`${paint('no worktrees match.', 'dim')}\n`);
      return;
    }
    process.stdout.write(
      `${renderList({ worktrees: selected, ageBasis: globals.ageBy, cwd, showSize: globals.size === true })}\n`,
    );
    if (process.stdout.isTTY) process.stdout.write(`${legend()}\n`);
  },
);

const cleanCommand = withFilterOptions(
  program
    .command('clean')
    .description('remove worktrees matching the filters (dry run unless --yes)')
    .option('-n, --dry-run', 'show the plan and stop')
    .option('-y, --yes', 'skip the confirmation prompt')
    .option('--force', 'override dirty, unpushed and locked (never main or cwd)')
    .option('--delete-branch', 'also delete the branch of each removed worktree')
    .option('--force-branch-delete', 'use git branch -D instead of -d')
    .option(
      '--keep-directory',
      'when pruning a stale worktree, leave its leftover directory on disk',
    )
    .option('--all', 'act on every non-main worktree (required when no filter is given)')
    .option('--json', 'machine readable plan and results'),
);

cleanCommand.action(
  async (
    opts: FilterOptions & {
      yes?: boolean;
      dryRun?: boolean;
      force?: boolean;
      deleteBranch?: boolean;
      forceBranchDelete?: boolean;
      keepDirectory?: boolean;
      all?: boolean;
      json?: boolean;
    },
  ) => {
    const globals = program.opts<GlobalOptions>();

    if (!hasNarrowingFilter(opts) && !opts.all) {
      throw new InvalidFilterError(
        'refusing to act on every worktree. Pass a filter (--pr-state, --older-than, ...) or --all.',
      );
    }

    // Validate the filters before touching git or GitHub, so a typo reports a
    // usage error rather than whatever the data layer happens to complain about.
    const filters = buildFilters(opts, globals.ageBy, false);

    const { cwd, repo, collection } = await gather(globals);

    // A PR-state filter that we cannot evaluate must not silently match nothing
    // or, worse, match everything. planRemoval turns unknown PR state into a block.
    const requiresPrState = opts.prState !== undefined;

    // "could not check" and "nothing matched" are different answers. An agent
    // that cannot tell them apart will report a clean repo when GitHub was down.
    if (requiresPrState && !collection.prIndex.available) {
      const message = `cannot filter on PR state: ${collection.prIndex.reason}`;
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ error: 'pr-state-unavailable', message }, null, 2)}\n`);
      } else {
        process.stderr.write(`wtree: ${message}\n`);
      }
      process.exitCode = 3;
      return;
    }

    const candidates = sortWorktrees(
      applyFilters(collection.worktrees, filters),
      'age',
      globals.ageBy,
    );

    const plans = planAll(candidates, {
      cwd,
      force: opts.force === true,
      deleteBranch: opts.deleteBranch === true,
      requiresPrState,
    });
    const removable = plans.filter((p: Plan) => p.blocks.length === 0);

    const showPlan = (dryRun: boolean): void => {
      if (opts.json) {
        process.stdout.write(`${JSON.stringify({ dryRun, plan: planToJson(plans) }, null, 2)}\n`);
        return;
      }
      warnPrUnavailable(collection, false);
      process.stdout.write(`${renderPlan(plans, cwd, globals.ageBy)}\n`);
    };

    if (opts.dryRun || removable.length === 0) {
      showPlan(true);
      if (!opts.json && !opts.dryRun && removable.length === 0) return;
      if (!opts.json && removable.length > 0) {
        process.stdout.write(`\n${paint('dry run. drop --dry-run to remove them.', 'dim')}\n`);
      }
      return;
    }

    if (!opts.yes) {
      // Prompting needs someone to answer. In a script, a pipeline or an agent
      // there is nobody, so refuse rather than block forever or delete unasked.
      if (!process.stdin.isTTY || !process.stdout.isTTY || opts.json) {
        showPlan(true);
        process.stderr.write(
          'wtree: refusing to remove without confirmation. Pass --yes to remove, or --dry-run to just see the plan.\n',
        );
        process.exitCode = 2;
        return;
      }
      showPlan(false);
      const branchNote = opts.deleteBranch ? ' and their branches' : '';
      const ok = await confirm(
        `\nRemove ${removable.length} worktree${removable.length === 1 ? '' : 's'}${branchNote}?`,
      );
      if (!ok) {
        process.stdout.write(`${paint('cancelled.', 'dim')}\n`);
        return;
      }
    }

    const results = await execute(plans, {
      repo,
      force: opts.force === true,
      forceBranchDelete: opts.forceBranchDelete === true,
      keepDirectory: opts.keepDirectory === true,
    });

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ dryRun: false, plan: planToJson(plans), results }, null, 2)}\n`,
      );
    } else {
      // --yes skips the plan, so without this the blocked worktrees vanish and
      // the user is left wondering why a match they expected was not removed.
      for (const plan of plans.filter((p: Plan) => p.blocks.length > 0)) {
        process.stdout.write(
          `${paint('skipped', 'yellow')} ${plan.worktree.path}: ${plan.blocks
            .map((b) => b.message)
            .join('; ')}\n`,
        );
      }
      for (const r of results) {
        if (r.removed) {
          const branch = r.branch
            ? r.branchDeleted
              ? paint(` (branch ${r.branch} deleted)`, 'dim')
              : paint(` (branch ${r.branch} kept: ${r.branchError ?? 'unknown'})`, 'yellow')
            : '';
          process.stdout.write(`${paint('removed', 'green')} ${r.path}${branch}\n`);
          if (r.note) process.stdout.write(`${paint(`        ${r.note}`, 'yellow')}\n`);
        } else {
          process.stdout.write(`${paint('failed ', 'red')} ${r.path}: ${r.error ?? 'unknown'}\n`);
        }
      }
    }

    if (results.some((r) => !r.removed)) process.exitCode = 1;
  },
);

program
  .command('prune')
  .description('drop admin records for worktrees whose directory is gone')
  .option('-n, --dry-run', 'show what would be pruned and stop')
  .option('-y, --yes', 'skip the confirmation prompt')
  .action(async (opts: { yes?: boolean; dryRun?: boolean }) => {
    const globals = program.opts<GlobalOptions>();
    const repo = await getRepoContext(await realpathSafe(resolveCwd(globals)));

    const preview = await prune(repo, true);
    if (!preview) {
      process.stdout.write(`${paint('nothing to prune.', 'dim')}\n`);
      return;
    }
    process.stdout.write(`${preview}\n`);

    if (opts.dryRun) {
      process.stdout.write(`${paint('dry run. drop --dry-run to prune.', 'dim')}\n`);
      return;
    }
    if (!opts.yes) {
      if (!process.stdin.isTTY || !process.stdout.isTTY) {
        process.stderr.write('wtree: refusing to prune without confirmation. Pass --yes.\n');
        process.exitCode = 2;
        return;
      }
      if (!(await confirm('\nPrune these records?'))) {
        process.stdout.write(`${paint('cancelled.', 'dim')}\n`);
        return;
      }
    }
    const output = await prune(repo, false);
    if (output) process.stdout.write(`${output}\n`);
  });

/**
 * `new`, `go`, `path` and `ui` feed `cd "$(...)"`, so stdout carries exactly one
 * line, the path. Everything else goes to stderr.
 */
const printPath = (path: string): void => {
  process.stdout.write(`${path}\n`);
};

/**
 * A script or agent with piped stdio usually still has a controlling terminal,
 * so /dev/tty opening is not proof that anyone is there to answer. Require a
 * terminal on stdin and stderr; stdout may be a pipe, as under `p=$(wtree ui)`.
 */
const hasInteractiveTerminal = (): boolean =>
  process.stdin.isTTY === true && process.stderr.isTTY === true;

/**
 * The interactive browser, for `ui` and a bare `clean` at a terminal. It draws
 * on /dev/tty, so stdout carries only the path chosen with `o`, if any.
 */
const runUi = async (globals: GlobalOptions): Promise<void> => {
  if (!hasInteractiveTerminal()) {
    process.stderr.write(
      'wtree ui needs an interactive terminal. Use `wtree list --json` instead.\n',
    );
    process.exitCode = 2;
    return;
  }
  const { cwd, repo, collection } = await gather(globals);
  const { runTui } = await import('./tui.js');
  const result = await runTui({
    cwd,
    repo,
    collection,
    ageBasis: globals.ageBy,
    showSize: globals.size === true,
    reload: ({ refresh, size }: { refresh: boolean; size: boolean }) =>
      collect({
        cwd,
        repo,
        size,
        noPr: globals.pr === false,
        refresh,
        ttlSeconds: globals.ttl,
        prLimit: globals.prLimit,
      }),
    create: async (branch: string) => {
      const res = await createWorktree({ cwd, branch, fetch: globals.pr !== false });
      return { path: res.path, created: res.created, warnings: res.warnings };
    },
  });
  process.exitCode = result.code;
  if (result.openPath) printPath(result.openPath);
};

program
  .command('ui')
  .description('interactive worktree browser; `o` exits and prints the chosen path')
  .action(async () => {
    await runUi(program.opts<GlobalOptions>());
  });

const reportCreate = (branch: string, res: CreateResult): void => {
  if (res.gitOutput) process.stderr.write(`${res.gitOutput}\n`);
  for (const w of res.warnings) process.stderr.write(`${paint(`warning: ${w}`, 'yellow')}\n`);
  if (!res.created) {
    process.stderr.write(`${paint(`${branch} is already checked out at ${res.path}`, 'dim')}\n`);
  }
};

program
  .command('new')
  .description('create a worktree for <branch> under ~/.wtree/<repo>/ and print its path')
  .argument('<branch>', 'branch to check out; created off the base if it does not exist')
  .option('--from <base>', 'start point for a new branch (default: the remote default branch)')
  .option('--no-fetch', 'do not look for the branch on origin first')
  .action(async (branch: string, opts: { from?: string; fetch: boolean }) => {
    const cwd = await realpathSafe(resolveCwd(program.opts<GlobalOptions>()));
    const res = await createWorktree({
      cwd,
      branch,
      base: opts.from,
      fetch: opts.fetch,
    });
    reportCreate(branch, res);
    printPath(res.path);
  });

program
  .command('path')
  .description('print the path of the worktree matching <name> (branch or path)')
  .argument('<name>', 'exact branch, exact path, or a unique substring of either')
  .action(async (name: string) => {
    const cwd = await realpathSafe(resolveCwd(program.opts<GlobalOptions>()));
    const worktrees = (await listWorktrees(cwd)).filter((w) => !w.bare);
    const asPath = await realpathSafe(resolve(cwd, name));
    const exact =
      worktrees.find((w) => w.branch === name) ??
      worktrees.find((w) => w.path === name || w.path === asPath);
    if (exact) {
      await assertLive(exact);
      printPath(exact.path);
      return;
    }
    const matches = worktrees.filter(
      (w) => (w.branch !== null && w.branch.includes(name)) || w.path.includes(name),
    );
    const [only] = matches;
    if (matches.length === 1 && only) {
      await assertLive(only);
      printPath(only.path);
      return;
    }
    if (matches.length === 0) {
      process.stderr.write(`wtree: no worktree matches "${name}"\n`);
      process.exitCode = 1;
      return;
    }
    process.stderr.write(`wtree: "${name}" matches ${matches.length} worktrees:\n`);
    for (const w of matches) process.stderr.write(`  ${w.branch ?? '(detached)'}  ${w.path}\n`);
    process.exitCode = 2;
  });

program
  .command('go')
  .description('pick a worktree or branch (fzf if installed) and print its path, creating it if needed')
  .argument('[query]', 'initial filter; an exact branch name skips the picker')
  .option('--no-fetch', 'when creating, do not look for the branch on origin first')
  .action(async (query: string | undefined, opts: { fetch: boolean }) => {
    const cwd = await realpathSafe(resolveCwd(program.opts<GlobalOptions>()));
    const candidates = await loadCandidates(cwd);

    let chosen = query !== undefined ? candidates.find((c) => c.branch === query) : undefined;
    if (!chosen) {
      if (!hasInteractiveTerminal()) {
        process.stderr.write('wtree go needs an interactive terminal\n');
        process.exitCode = 2;
        return;
      }
      const picked = await pickCandidate({ candidates, query });
      if (picked.status === 'no-tty') {
        process.stderr.write('wtree go needs an interactive terminal\n');
        process.exitCode = 2;
        return;
      }
      if (picked.status === 'failed') {
        process.exitCode = 2;
        return;
      }
      if (picked.status === 'cancelled') {
        process.exitCode = 1;
        return;
      }
      chosen = picked.candidate;
    }

    if (chosen.path) {
      await assertLive({ path: chosen.path, prunable: false });
      printPath(chosen.path);
      return;
    }
    const branch = chosen.branch ?? chosen.label;
    const res = await createWorktree({ cwd, branch, fetch: opts.fetch });
    reportCreate(branch, res);
    printPath(res.path);
  });

const SHELLS = ['zsh', 'bash'] as const;

// Plain POSIX function syntax plus `local`, so the same text works in zsh and bash.
const SHELL_WRAPPER = `wt() {
  case "$1" in
    new|go|path|ui)
      local p
      p=$(command wtree "$@") || return
      if [ -n "$p" ]; then cd "$p"; fi
      ;;
    *) command wtree "$@" ;;
  esac
}
`;

program
  .command('shell-init')
  .description('print a `wt` shell function that cds into the path new/go/path/ui print')
  .argument('[shell]', `one of: ${SHELLS.join(', ')}`, oneOf(SHELLS), 'zsh')
  .action(() => {
    process.stdout.write(SHELL_WRAPPER);
  });

const main = async (): Promise<void> => {
  try {
    await program.parseAsync(process.argv);
  } catch (error) {
    if (error instanceof NotAGitRepoError) {
      process.stderr.write(`wtree: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    if (error instanceof CreateError) {
      process.stderr.write(`wtree: ${error.message}\n`);
      process.exitCode = 1;
      return;
    }
    if (error instanceof InvalidFilterError) {
      process.stderr.write(`wtree: ${error.message}\n`);
      process.exitCode = 2;
      return;
    }
    process.stderr.write(`wtree: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
};

void main();
