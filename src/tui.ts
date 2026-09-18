import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';

import {
  execute,
  planRemoval,
  type ExecuteEvent,
  type Plan,
  type RemovalResult,
} from './clean.js';
import type { Collection } from './enrich.js';
import type { RepoContext } from './git.js';
import { ageDays, prStateOf, sortWorktrees, type SortKey } from './filter.js';
import {
  branchLabel,
  flags,
  formatAge,
  formatPr,
  formatSize,
  BRANCH_MAX,
  clampAnsi,
  highlightRow,
  legend,
  paint,
  shortPath,
  visibleWidth,
} from './render.js';
import type { AgeBasis, Worktree } from './types.js';

export interface TuiOptions {
  cwd: string;
  repo: RepoContext;
  collection: Collection;
  ageBasis: AgeBasis;
  showSize: boolean;
  /** Re-run collection (used by the refresh key). */
  reload: (opts: { refresh: boolean; size: boolean }) => Promise<Collection>;
}

type Screen = 'list' | 'detail' | 'confirm' | 'working' | 'results';
type PrFilter = 'all' | 'merged+closed' | 'open' | 'none';

const SORT_KEYS: readonly SortKey[] = ['age', 'path', 'branch', 'size', 'pr'];
const ESC = '\u001b[';

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ');

const padCell = (cell: string, width: number): string =>
  cell + ' '.repeat(Math.max(0, width - visibleWidth(cell)));

const isEnter = (key: Key): boolean => key.name === 'return' || key.name === 'enter';

const isEscape = (key: Key): boolean => key.name === 'escape' || key.sequence === '\u001b';

const isUpper = (key: Key, value: string): boolean => key.name === value && key.shift === true;

const renderCells = (headers: string[], rows: string[][]): string[] => {
  const widths = headers.map((header, index) =>
    Math.max(visibleWidth(header), ...rows.map((row) => visibleWidth(row[index] ?? ''))),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, index) =>
        index === cells.length - 1 ? cell : padCell(cell, widths[index] ?? visibleWidth(cell)),
      )
      .join('  ')
      .trimEnd();
  return [line(headers.map((header) => paint(header, 'dim'))), ...rows.map(line)];
};

/**
 * Runs the interactive worktree view. Terminal restoration is kept in the
 * outer finally because reload and deletion both cross asynchronous boundaries.
 */
export const runTui = async (options: TuiOptions): Promise<number> => {
  const stdin = process.stdin;
  const stdout = process.stdout;

  if (!stdin.isTTY || !stdout.isTTY) {
    process.stderr.write('wtree tui requires an interactive terminal\n');
    return 2;
  }

  let collection = options.collection;
  let showSize = options.showSize;
  let sizeLoaded = options.showSize;
  let screen: Screen = 'list';
  let cursor = 0;
  let scrollTop = 0;
  let status: string | null = null;
  let selected = new Set<string>();
  /** Subset of `selected` that was picked with force, overriding dirty/unpushed/locked. */
  let forced = new Set<string>();
  let sortKey: SortKey = 'age';
  let prFilter: PrFilter = 'all';
  let pathFilter = '';
  let filterDraft = '';
  let filterMode = false;
  let deleteBranch = false;
  let pendingTargets: Worktree[] = [];
  let pendingPlans: Plan[] = [];
  let progressLines: string[] = [];
  let confirmScroll = 0;
  let resultLines: string[] = [];
  let resultScroll = 0;
  let busy = false;
  let rawModeEnabled = false;
  let resolveExit: ((code: number) => void) | null = null;

  const finish = (code: number): void => {
    if (resolveExit) {
      resolveExit(code);
      resolveExit = null;
    }
  };

  const planFor = (wt: Worktree, force = forced.has(wt.path)): Plan =>
    planRemoval(wt, {
      cwd: options.cwd,
      force,
      deleteBranch,
      requiresPrState: false,
    });

  const isRemovable = (wt: Worktree): boolean => planFor(wt, false).blocks.length === 0;

  /**
   * Removable once dirty, unpushed and locked are overridden. The main worktree
   * and the one holding the cwd stay blocked: --force cannot clear those either.
   */
  const isForceRemovable = (wt: Worktree): boolean => planFor(wt, true).blocks.length === 0;

  const pruneSelection = (): void => {
    const current = new Map(collection.worktrees.map((wt) => [wt.path, wt]));
    for (const path of selected) {
      const wt = current.get(path);
      const ok = wt && (forced.has(path) ? isForceRemovable(wt) : isRemovable(wt));
      if (!ok) {
        selected.delete(path);
        forced.delete(path);
      }
    }
  };

  const replaceCollection = (next: Collection, clearSelection: boolean): void => {
    collection = next;
    if (clearSelection) {
      selected = new Set<string>();
      forced = new Set<string>();
    }
    else pruneSelection();
    const visible = getVisibleWorktrees();
    if (visible.length === 0) cursor = 0;
    else cursor = Math.min(cursor, visible.length - 1);
  };

  const matchesPrFilter = (wt: Worktree): boolean => {
    const state = prStateOf(wt);
    switch (prFilter) {
      case 'all':
        return true;
      case 'merged+closed':
        return state === 'merged' || state === 'closed';
      case 'open':
        return state === 'open';
      case 'none':
        return state === 'none';
    }
  };

  const getVisibleWorktrees = (): Worktree[] => {
    const query = (filterMode ? filterDraft : pathFilter).trim().toLocaleLowerCase();
    const filtered = collection.worktrees.filter((wt) => {
      if (!matchesPrFilter(wt)) return false;
      if (!query) return true;
      return [wt.branch ?? '', wt.path].some((value) => value.toLocaleLowerCase().includes(query));
    });
    return sortWorktrees(filtered, sortKey, options.ageBasis);
  };

  const currentWorktree = (): Worktree | undefined => getVisibleWorktrees()[cursor];

  const moveCursor = (delta: number): void => {
    const visible = getVisibleWorktrees();
    if (visible.length === 0) return;
    cursor = Math.max(0, Math.min(visible.length - 1, cursor + delta));
  };

  const selectAllRemovable = (): void => {
    const visible = getVisibleWorktrees();
    selected = new Set(visible.filter(isRemovable).map((wt) => wt.path));
    forced = new Set<string>();
    status = `${selected.size} removable worktree${selected.size === 1 ? '' : 's'} selected`;
  };

  /** Select everything that only force can unblock, plus everything already removable. */
  const forceSelectAll = (): void => {
    const visible = getVisibleWorktrees().filter(isForceRemovable);
    selected = new Set(visible.map((wt) => wt.path));
    forced = new Set(visible.filter((wt) => !isRemovable(wt)).map((wt) => wt.path));
    status =
      forced.size > 0
        ? `${selected.size} selected, ${forced.size} forced (dirty, unpushed or locked)`
        : `${selected.size} removable worktree${selected.size === 1 ? '' : 's'} selected`;
  };

  const toggleCurrentForce = (): void => {
    const wt = currentWorktree();
    if (!wt) {
      status = 'no worktree is visible';
      return;
    }
    if (selected.has(wt.path)) {
      selected.delete(wt.path);
      forced.delete(wt.path);
      status = `unselected ${shortPath(wt.path, options.cwd)}`;
      return;
    }
    const hard = planFor(wt, true).blocks;
    if (hard.length > 0) {
      // main and cwd are not forceable, so say so rather than pretending f helps.
      status = `cannot force ${shortPath(wt.path, options.cwd)}: ${hard
        .map((block) => block.message)
        .join('; ')}`;
      return;
    }
    selected.add(wt.path);
    const overrides = planFor(wt, true).overridden;
    if (overrides.length > 0) {
      forced.add(wt.path);
      status = `force selected ${shortPath(wt.path, options.cwd)} (${overrides
        .map((block) => block.message)
        .join('; ')})`;
    } else {
      status = `selected ${shortPath(wt.path, options.cwd)}`;
    }
  };

  const toggleCurrentSelection = (): void => {
    const wt = currentWorktree();
    if (!wt) {
      status = 'no worktree is visible';
      return;
    }
    const plan = planFor(wt, false);
    if (plan.blocks.length > 0) {
      const forceable = plan.blocks.every((block) => block.force);
      status = `cannot select ${shortPath(wt.path, options.cwd)}: ${plan.blocks
        .map((block) => block.message)
        .join('; ')}${forceable ? ' — press f to force' : ''}`;
      return;
    }
    if (selected.has(wt.path)) {
      selected.delete(wt.path);
      forced.delete(wt.path);
      status = `unselected ${shortPath(wt.path, options.cwd)}`;
    } else {
      selected.add(wt.path);
      status = `selected ${shortPath(wt.path, options.cwd)}`;
    }
  };

  const setFilterMode = (): void => {
    filterMode = true;
    filterDraft = pathFilter;
    status = 'filter: type branch or path, Enter applies, Esc cancels';
  };

  const cyclePrFilter = (): void => {
    const values: readonly PrFilter[] = ['all', 'merged+closed', 'open', 'none'];
    const current = values.indexOf(prFilter);
    prFilter = values[(current + 1) % values.length] ?? 'all';
    cursor = 0;
    scrollTop = 0;
    status = `PR filter: ${prFilter}`;
  };

  const cycleSortKey = (): void => {
    const current = SORT_KEYS.indexOf(sortKey);
    sortKey = SORT_KEYS[(current + 1) % SORT_KEYS.length] ?? 'age';
    cursor = 0;
    scrollTop = 0;
    status = `sort: ${sortKey}`;
  };

  const detailLines = (wt: Worktree): string[] => {
    const prLines = (() => {
      switch (wt.pr.status) {
        case 'found':
          return [`PR title: ${wt.pr.title}`, `PR URL: ${wt.pr.url}`];
        case 'unknown':
          return [`PR: unknown (${wt.pr.reason})`];
        case 'none':
          return ['PR: none'];
      }
    })();
    return [
      paint('DETAIL', 'bold'),
      `path: ${wt.path}`,
      `branch: ${branchLabel(wt)}`,
      `head: ${wt.head ?? '—'}`,
      `last commit: ${wt.lastCommitAt ?? '—'}`,
      `checkout: ${wt.checkoutAt ?? '—'}`,
      `created: ${wt.createdAt ?? '—'}`,
      `dirty: ${wt.dirty ? 'yes' : 'no'}`,
      `unpushed: ${wt.unpushed === null ? 'unknown' : wt.unpushed}`,
      `lock reason: ${wt.locked ? wt.lockReason ?? 'locked' : '—'}`,
      `prune reason: ${wt.prunable ? wt.prunableReason ?? 'prunable' : '—'}`,
      `PR state: ${formatPr(wt)}`,
      ...prLines,
      '',
      paint('Press Enter or Esc to return.', 'dim'),
    ];
  };

  const listRows = (visible: Worktree[]): string[][] =>
    visible.map((wt, index) => {
      const marker = index === cursor ? paint('>', 'cyan') : ' ';
      const checkbox = forced.has(wt.path)
        ? paint('[!]', 'red')
        : selected.has(wt.path)
          ? paint('[x]', 'green')
          : '[ ]';
      return [
        marker,
        checkbox,
        branchLabel(wt, branchWidth()),
        formatAge(ageDays(wt, options.ageBasis)),
        formatPr(wt),
        ...(showSize ? [formatSize(wt.sizeKb)] : []),
        flags(wt),
        wt.missing ? paint(shortPath(wt.path, options.cwd), 'red') : shortPath(wt.path, options.cwd),
      ];
    });

  const width = (): number => Math.max(20, stdout.columns || 80);

  /** Nothing may wrap: a wrapped line costs a row the layout did not budget for. */
  const clampLines = (lines: string[]): string[] => lines.map((l) => clampAnsi(l, width()));

  /**
   * Give BRANCH at most a third of the terminal, so PATH stays readable in a
   * narrow window instead of being clamped away entirely.
   */
  const branchWidth = (): number => Math.max(12, Math.min(BRANCH_MAX, Math.floor(width() / 3)));

  /** Prefer the full text, fall back to a shorter one rather than truncating key hints away. */
  const fit = (full: string, short: string): string =>
    visibleWidth(full) <= width() ? full : short;

  const renderList = (): void => {
    const visible = getVisibleWorktrees();
    const height = Math.max(1, stdout.rows || 24);
    // header, filters, legend, table header, footer, status.
    const rowCapacity = Math.max(0, height - 6);
    if (visible.length === 0) cursor = 0;
    else cursor = Math.min(cursor, visible.length - 1);
    const maxScroll = Math.max(0, visible.length - rowCapacity);
    scrollTop = Math.min(scrollTop, maxScroll);
    if (cursor < scrollTop) scrollTop = cursor;
    if (rowCapacity > 0 && cursor >= scrollTop + rowCapacity) {
      scrollTop = cursor - rowCapacity + 1;
    }

    const headers = ['', '', 'BRANCH', 'AGE', 'PR', ...(showSize ? ['SIZE'] : []), 'FLAGS', 'PATH'];
    const rows = listRows(visible);
    const tableLines = renderCells(headers, rows);
    const firstRow = Math.max(0, scrollTop) + 1;
    const shownRows = tableLines.slice(firstRow, firstRow + rowCapacity);
    const removable = collection.worktrees.filter(isRemovable).length;
    const forcedNote = forced.size > 0 ? `, ${forced.size} forced` : '';
    const header = `wtree — ${options.repo.root} — ${visible.length}/${collection.worktrees.length} shown, ${removable} removable, ${selected.size} selected${forcedNote}`;
    const filterLine = `sort: ${sortKey}  PR: ${prFilter}  filter: ${
      filterMode ? `/${filterDraft}_` : pathFilter || 'none'
    }  age: ${options.ageBasis}  delete branches: ${deleteBranch ? 'on' : 'off'}`;
    const footer = fit(
      'j/k move  g/G top/bottom  Space select  f force  a select all  F force all  c clear all  / filter  s sort  p PR  r refresh  S size  Enter details  d delete  b branches  q/Esc quit',
      'j/k move  Space select  f force  a all  F force all  c clear  / filter  d delete  q quit',
    );
    const footerStatus = status ?? '';
    const headerLines = [header, filterLine, legend(), tableLines[0] ?? ''];
    const lines = [...headerLines, ...shownRows];
    while (lines.length < Math.max(0, height - 2)) lines.push('');
    lines.push(footer, footerStatus);

    const clamped = clampLines(lines);
    // Highlight the cursor row only when it is actually on screen.
    const cursorLine = headerLines.length + (cursor - scrollTop);
    if (visible.length > 0 && cursorLine >= headerLines.length && cursorLine < headerLines.length + shownRows.length) {
      clamped[cursorLine] = highlightRow(clamped[cursorLine] ?? '', width());
    }
    stdout.write(`${ESC}2J${ESC}H${clamped.join('\n')}`);
  };

  const renderPaged = (
    title: string,
    content: string[],
    scroll: number,
    hints: [full: string, short: string],
  ): void => {
    const height = Math.max(1, stdout.rows || 24);
    const capacity = Math.max(1, height - 2);
    const maxScroll = Math.max(0, content.length - capacity);
    const start = Math.min(scroll, maxScroll);
    const lines = [title, ...content.slice(start, start + capacity - 1)];
    while (lines.length < Math.max(1, height - 1)) lines.push('');
    lines.push(fit(hints[0], hints[1]));
    stdout.write(`${ESC}2J${ESC}H${clampLines(lines).join('\n')}`);
  };

  const render = (): void => {
    switch (screen) {
      case 'list':
        renderList();
        break;
      case 'detail': {
        const wt = currentWorktree();
        renderPaged('wtree — worktree detail', wt ? detailLines(wt) : ['no worktree selected'], 0, [
          'j/k or arrows scroll   Enter or Esc back to the list   q quit',
          'j/k scroll  Esc back  q quit',
        ]);
        break;
      }
      case 'confirm': {
        const content = [
          paint(
            `DELETE WORKTREES — also delete branches: ${deleteBranch ? 'YES' : 'NO'}${
              forced.size > 0 ? `  —  ${forced.size} FORCED, uncommitted work will be lost` : ''
            }`,
            'bold',
          ),
          '',
          ...renderPlanLines(pendingPlans),
        ];
        const count = pendingPlans.filter((plan) => plan.blocks.length === 0).length;
        const noun = `${count} worktree${count === 1 ? '' : 's'}`;
        const branches = deleteBranch ? ' and their branches' : '';
        renderPaged('wtree — confirmation', content, confirmScroll, [
          `${paint(`Press y to remove ${noun}${branches}`, 'bold')}   Esc cancel   b toggle branch deletion   j/k scroll`,
          `${paint(`y remove ${count}`, 'bold')}  Esc cancel  b branches`,
        ]);
        break;
      }
      case 'working':
        renderPaged('wtree — removing', progressLines, Math.max(0, progressLines.length - 1), [
          'working — please wait',
          'working…',
        ]);
        break;
      case 'results':
        renderPaged('wtree — deletion results', resultLines, resultScroll, [
          'any key returns to the list   q quit',
          'any key back  q quit',
        ]);
        break;
    }
  };

  const renderPlanLines = (plans: Plan[]): string[] => {
    const removable = plans.filter((plan) => plan.blocks.length === 0);
    const skipped = plans.filter((plan) => plan.blocks.length > 0);
    const lines: string[] = [];
    lines.push(`will remove: ${removable.length}`);
    for (const plan of removable) {
      const wt = plan.worktree;
      const branch = plan.removeBranch ? ` + branch ${plan.removeBranch}` : '';
      const override =
        plan.overridden.length > 0
          ? ` ${paint(`[FORCED: ${plan.overridden.map((b) => b.message).join('; ')}]`, 'red')}`
          : '';
      lines.push(
        `  ${paint(plan.overridden.length > 0 ? 'FORCE ' : 'REMOVE', 'red')} ${shortPath(
          wt.path,
          options.cwd,
        )}${branch} ${paint(
          `(${formatAge(ageDays(wt, options.ageBasis))}, ${prStateOf(wt)})`,
          'dim',
        )}${override}`,
      );
    }
    lines.push('', `skipped: ${skipped.length}`);
    for (const plan of skipped) {
      lines.push(
        `  ${paint('SKIP', 'yellow')} ${shortPath(plan.worktree.path, options.cwd)} — ${plan.blocks
          .map((block) => block.message)
          .join('; ')}`,
      );
    }
    return lines;
  };

  const removalResultLines = (
    plans: Plan[],
    results: RemovalResult[],
    deletionError: string | null,
  ): string[] => {
    const lines: string[] = [];
    if (deletionError) lines.push(paint(`ERROR: ${deletionError}`, 'red'));
    for (const plan of plans.filter((item) => item.blocks.length > 0)) {
      lines.push(
        `${paint('SKIP', 'yellow')} ${shortPath(plan.worktree.path, options.cwd)} — ${plan.blocks
          .map((block) => block.message)
          .join('; ')}`,
      );
    }
    for (const result of results) {
      const path = shortPath(result.path, options.cwd);
      if (result.removed) {
        const branch = result.branch
          ? result.branchDeleted
            ? `; branch ${result.branch} deleted`
            : `; branch ${result.branch} not deleted`
          : '';
        lines.push(`${paint('REMOVED', 'green')} ${path}${branch}`);
      } else {
        lines.push(`${paint('ERROR', 'red')} ${path} — ${result.error ?? 'removal failed'}`);
      }
      if (result.branchError) {
        lines.push(`  ${paint('BRANCH ERROR', 'red')} ${result.branchError}`);
      }
    }
    if (lines.length === 0) lines.push(paint('nothing was removed.', 'dim'));
    lines.push('', paint('Press any key to return to the list.', 'dim'));
    return lines;
  };

  const reloadCollection = async (reloadOptions: { refresh: boolean; size: boolean }): Promise<boolean> => {
    try {
      const next = await options.reload(reloadOptions);
      replaceCollection(next, false);
      status = null;
      return true;
    } catch (error) {
      status = `reload failed: ${oneLine(errorMessage(error))}`;
      return false;
    }
  };

  const beginDeletion = (): void => {
    const visible = getVisibleWorktrees();
    const targets = selected.size > 0
      ? collection.worktrees.filter((wt) => selected.has(wt.path))
      : visible[cursor]
        ? [visible[cursor] as Worktree]
        : [];
    if (targets.length === 0) {
      status = 'no worktree is visible to delete';
      return;
    }
    const plans = targets.map((wt) => planFor(wt));
    const runnable = plans.filter((plan) => plan.blocks.length === 0);
    if (runnable.length === 0) {
      // Offering to remove nothing is not a question worth asking.
      const reasons = [...new Set(plans.flatMap((plan) => plan.blocks.map((b) => b.message)))];
      const forceable = plans.some((plan) => plan.blocks.every((block) => block.force));
      status = `nothing to remove: ${reasons.join('; ')}${forceable ? ' — press f to force' : ''}`;
      return;
    }

    pendingTargets = targets;
    pendingPlans = plans;
    confirmScroll = 0;
    screen = 'confirm';
    status = null;
  };

  const togglePendingBranchDeletion = (): void => {
    deleteBranch = !deleteBranch;
    pendingPlans = pendingTargets.map((wt) => planFor(wt));
    confirmScroll = 0;
  };

  const performDeletion = async (): Promise<void> => {
    busy = true;
    // execute() takes one force flag for the batch, so the forced rows run
    // as their own batch rather than loosening the rule for everything.
    const forcedPlans = pendingPlans.filter((plan) => forced.has(plan.worktree.path));
    const normalPlans = pendingPlans.filter((plan) => !forced.has(plan.worktree.path));
    const runnable = [...normalPlans, ...forcedPlans].filter((plan) => plan.blocks.length === 0);
    const total = runnable.length;
    let completed = 0;

    // Each removal is a separate git call, so without this the UI sits frozen
    // on the confirmation screen for the whole batch with no sign of progress.
    const onProgress = (event: ExecuteEvent): void => {
      if (event.phase === 'start') {
        progressLines = [
          ...progressLines.filter((line) => !line.startsWith('\u2026')),
          `\u2026 removing ${completed + 1}/${total}: ${shortPath(event.path, options.cwd)}`,
        ];
      } else {
        completed += 1;
        const mark = event.result.removed ? paint('done ', 'green') : paint('failed', 'red');
        const why = event.result.removed ? '' : ` — ${oneLine(event.result.error ?? 'unknown')}`;
        progressLines = [
          ...progressLines.filter((line) => !line.startsWith('\u2026')),
          `${mark} ${shortPath(event.path, options.cwd)}${why}`,
        ];
      }
      render();
    };

    progressLines = [`removing ${total} worktree${total === 1 ? '' : 's'}\u2026`, ''];
    screen = 'working';
    render();

    try {
      const results = [
        ...(await execute(normalPlans, { repo: options.repo, force: false, onProgress })),
        ...(await execute(forcedPlans, { repo: options.repo, force: true, onProgress })),
      ];
      let reloadError: string | null = null;
      try {
        progressLines = [...progressLines, '', paint('reloading worktrees\u2026', 'dim')];
        render();
        const next = await options.reload({ refresh: false, size: showSize });
        replaceCollection(next, true);
      } catch (error) {
        reloadError = `reload failed: ${oneLine(errorMessage(error))}`;
      }
      resultLines = removalResultLines(pendingPlans, results, reloadError);
      resultScroll = 0;
      screen = 'results';
      status = reloadError;
    } catch (error) {
      resultLines = removalResultLines(pendingPlans, [], oneLine(errorMessage(error)));
      resultScroll = 0;
      screen = 'results';
      status = oneLine(errorMessage(error));
    } finally {
      busy = false;
      render();
    }
  };

  const handleFilterKey = (str: string, key: Key): void => {
    if (isEscape(key)) {
      filterMode = false;
      filterDraft = '';
      status = null;
      cursor = 0;
      scrollTop = 0;
      render();
      return;
    }
    if (isEnter(key)) {
      pathFilter = filterDraft.trim();
      filterMode = false;
      filterDraft = '';
      status = pathFilter ? `filter applied: ${pathFilter}` : 'filter cleared';
      cursor = 0;
      scrollTop = 0;
      render();
      return;
    }
    if (key.name === 'backspace') {
      filterDraft = Array.from(filterDraft).slice(0, -1).join('');
      cursor = 0;
      scrollTop = 0;
      render();
      return;
    }
    if (!key.ctrl && !key.meta && str >= ' ' && str !== '\u007f') {
      filterDraft += str;
      cursor = 0;
      scrollTop = 0;
      render();
    }
  };

  const handleListKey = async (str: string, key: Key): Promise<void> => {
    if (isEscape(key) || str === 'q') {
      finish(0);
      return;
    }
    if (str === '/') {
      setFilterMode();
      render();
      return;
    }
    if (key.name === 'down' || str === 'j') {
      moveCursor(1);
      render();
      return;
    }
    if (key.name === 'up' || str === 'k') {
      moveCursor(-1);
      render();
      return;
    }
    if (str === 'g' && !key.shift) {
      cursor = 0;
      scrollTop = 0;
      render();
      return;
    }
    if (isUpper(key, 'g') || str === 'G') {
      const visible = getVisibleWorktrees();
      cursor = Math.max(0, visible.length - 1);
      render();
      return;
    }
    if (key.name === 'space' || str === ' ') {
      toggleCurrentSelection();
      render();
      return;
    }
    if (str === 'a') {
      selectAllRemovable();
      render();
      return;
    }
    if (str === 'f') {
      toggleCurrentForce();
      render();
      return;
    }
    if (str === 'F' || isUpper(key, 'f')) {
      forceSelectAll();
      render();
      return;
    }
    if (str === 'c' || str === 'A' || isUpper(key, 'a')) {
      const had = selected.size;
      selected.clear();
      forced.clear();
      status = had > 0 ? `cleared ${had} selection${had === 1 ? '' : 's'}` : 'nothing was selected';
      render();
      return;
    }
    if (str === 's') {
      cycleSortKey();
      render();
      return;
    }
    if (str === 'p') {
      cyclePrFilter();
      render();
      return;
    }
    if (str === 'b') {
      deleteBranch = !deleteBranch;
      status = `also delete branches: ${deleteBranch ? 'on' : 'off'}`;
      render();
      return;
    }
    if (str === 'r') {
      busy = true;
      status = 'refreshing...';
      render();
      try {
        const loaded = await reloadCollection({ refresh: true, size: showSize });
        if (loaded) status = 'refreshed';
      } finally {
        busy = false;
        render();
      }
      return;
    }
    if (str === 'S' || isUpper(key, 's')) {
      if (showSize) {
        showSize = false;
        status = 'size column hidden';
        render();
        return;
      }
      if (!sizeLoaded) {
        busy = true;
        status = 'measuring sizes...';
        render();
        try {
          const loaded = await reloadCollection({ refresh: false, size: true });
          if (loaded) {
            sizeLoaded = true;
            showSize = true;
            status = 'size column shown';
          }
        } finally {
          busy = false;
          render();
        }
      } else {
        showSize = true;
        status = 'size column shown';
        render();
      }
      return;
    }
    if (isEnter(key)) {
      if (currentWorktree()) {
        screen = 'detail';
        status = null;
      } else {
        status = 'no worktree is visible';
      }
      render();
      return;
    }
    if (str === 'd') {
      beginDeletion();
      render();
    }
  };

  const handlePagedKey = (str: string, key: Key): void => {
    if (str === 'q') {
      finish(0);
      return;
    }
    if (screen === 'detail') {
      if (isEscape(key) || isEnter(key)) {
        screen = 'list';
        render();
      }
      return;
    }
    if (screen === 'results') {
      if (isEscape(key) || isEnter(key) || str) {
        screen = 'list';
        status = null;
        render();
      }
      return;
    }
    if (screen === 'confirm') {
      const contentLength = renderPlanLines(pendingPlans).length + 2;
      const capacity = Math.max(1, (stdout.rows || 24) - 3);
      const maxScroll = Math.max(0, contentLength - capacity);
      if (key.name === 'down' || str === 'j') confirmScroll = Math.min(maxScroll, confirmScroll + 1);
      else if (key.name === 'up' || str === 'k') confirmScroll = Math.max(0, confirmScroll - 1);
      else if (str === 'g') confirmScroll = 0;
      else if (str === 'G' || isUpper(key, 'g')) confirmScroll = maxScroll;
      else if (str === 'b') {
        togglePendingBranchDeletion();
      } else if (str === 'y') {
        void performDeletion();
        return;
      } else if (isEscape(key)) {
        screen = 'list';
        status = 'deletion cancelled';
      }
      render();
    }
  };

  const handleKeypress = async (str: string, key: Key): Promise<void> => {
    if (key.ctrl && key.name === 'c') {
      finish(130);
      return;
    }
    if (busy || resolveExit === null) return;
    if (filterMode) {
      handleFilterKey(str, key);
      return;
    }
    if (screen === 'list') await handleListKey(str, key);
    else handlePagedKey(str, key);
  };

  const onKeypress = (str: string, key: Key): void => {
    void handleKeypress(str, key);
  };
  const onResize = (): void => {
    if (resolveExit) render();
  };
  const onSigint = (): void => finish(130);

  try {
    emitKeypressEvents(stdin);
    stdin.setRawMode(true);
    rawModeEnabled = true;
    stdin.resume();
    stdin.on('keypress', onKeypress);
    stdout.on('resize', onResize);
    process.once('SIGINT', onSigint);
    stdout.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H`);
    render();
    const result = await new Promise<number>((resolve) => {
      resolveExit = resolve;
    });
    return result;
  } finally {
    stdin.off('keypress', onKeypress);
    stdout.off('resize', onResize);
    process.off('SIGINT', onSigint);
    try {
      stdout.write(`${ESC}?25h${ESC}?1049l${ESC}0m`);
    } finally {
      if (rawModeEnabled) stdin.setRawMode(false);
      stdin.pause();
    }
    resolveExit = null;
  }
};
