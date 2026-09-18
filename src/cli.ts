#!/usr/bin/env node
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
import { NotAGitRepoError, getRepoContext, realpathSafe, type RepoContext } from './git.js';
import {
  legend,
  paint,
  planToJson,
  renderList,
  renderPlan,
  toJson,
} from './render.js';
import type { AgeBasis } from './types.js';

const VERSION = '0.1.0';

const AGE_BASES: readonly AgeBasis[] = ['commit', 'checkout', 'created'];
const SORT_KEYS: readonly SortKey[] = ['age', 'path', 'branch', 'size', 'pr'];

interface GlobalOptions {
  cwd?: string;
  pr: boolean;
  refresh?: boolean;
  size?: boolean;
  ageBy: AgeBasis;
  ttl: number;
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
    const { cwd, collection } = await gather(globals);

    const filters = buildFilters(opts, globals.ageBy, opts.main !== false);
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
    .option('--yes', 'actually remove; without it this is a dry run')
    .option('--force', 'override dirty, unpushed and locked (never main or cwd)')
    .option('--delete-branch', 'also delete the branch of each removed worktree')
    .option('--force-branch-delete', 'use git branch -D instead of -d')
    .option('--all', 'act on every non-main worktree (required when no filter is given)')
    .option('--json', 'machine readable plan and results'),
);

cleanCommand.action(
  async (
    opts: FilterOptions & {
      yes?: boolean;
      force?: boolean;
      deleteBranch?: boolean;
      forceBranchDelete?: boolean;
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

    const filters = buildFilters(opts, globals.ageBy, false);
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

    if (!opts.yes) {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ dryRun: true, plan: planToJson(plans) }, null, 2)}\n`,
        );
        return;
      }
      warnPrUnavailable(collection, false);
      process.stdout.write(`${renderPlan(plans, cwd, globals.ageBy)}\n`);
      if (removable.length > 0) {
        process.stdout.write(
          `\n${paint('dry run. re-run with --yes to remove them.', 'dim')}\n`,
        );
      }
      return;
    }

    if (removable.length === 0) {
      if (opts.json) {
        process.stdout.write(
          `${JSON.stringify({ dryRun: false, plan: planToJson(plans), results: [] }, null, 2)}\n`,
        );
        return;
      }
      process.stdout.write(`${renderPlan(plans, cwd, globals.ageBy)}\n`);
      return;
    }

    const results = await execute(plans, {
      repo,
      force: opts.force === true,
      forceBranchDelete: opts.forceBranchDelete === true,
    });

    if (opts.json) {
      process.stdout.write(
        `${JSON.stringify({ dryRun: false, plan: planToJson(plans), results }, null, 2)}\n`,
      );
    } else {
      for (const r of results) {
        if (r.removed) {
          const branch = r.branch
            ? r.branchDeleted
              ? paint(` (branch ${r.branch} deleted)`, 'dim')
              : paint(` (branch ${r.branch} kept: ${r.branchError ?? 'unknown'})`, 'yellow')
            : '';
          process.stdout.write(`${paint('removed', 'green')} ${r.path}${branch}\n`);
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
  .option('--yes', 'actually prune; without it this is a dry run')
  .action(async (opts: { yes?: boolean }) => {
    const globals = program.opts<GlobalOptions>();
    const repo = await getRepoContext(await realpathSafe(resolveCwd(globals)));
    const output = await prune(repo, opts.yes !== true);
    if (output) {
      process.stdout.write(`${output}\n`);
    } else {
      process.stdout.write(`${paint('nothing to prune.', 'dim')}\n`);
    }
    if (!opts.yes && output) {
      process.stdout.write(`${paint('dry run. re-run with --yes to prune.', 'dim')}\n`);
    }
  });

program
  .command('ui')
  .description('interactive worktree browser')
  .action(async () => {
    const globals = program.opts<GlobalOptions>();
    // An agent invoking this without a terminal would hang forever. Fail loudly instead.
    if (!process.stdin.isTTY || !process.stdout.isTTY) {
      process.stderr.write(
        'wtree ui needs an interactive terminal. Use `wtree list --json` instead.\n',
      );
      process.exitCode = 2;
      return;
    }
    const { cwd, repo, collection } = await gather(globals);
    const { runTui } = await import('./tui.js');
    process.exitCode = await runTui({
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
        }),
    });
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
