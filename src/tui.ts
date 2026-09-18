import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';

import { execute, planRemoval, type Plan, type RemovalResult } from './clean.js';
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

type Screen = 'list' | 'detail' | 'confirm' | 'results';
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
  let sortKey: SortKey = 'age';
  let prFilter: PrFilter = 'all';
  let pathFilter = '';
  let filterDraft = '';
  let filterMode = false;
  let deleteBranch = false;
  let pendingTargets: Worktree[] = [];
  let pendingPlans: Plan[] = [];
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

  const planFor = (wt: Worktree): Plan =>
    planRemoval(wt, {
      cwd: options.cwd,
      force: false,
      deleteBranch,
      requiresPrState: false,
    });

  const isRemovable = (wt: Worktree): boolean => planFor(wt).blocks.length === 0;

  const pruneSelection = (): void => {
    const current = new Map(collection.worktrees.map((wt) => [wt.path, wt]));
    for (const path of selected) {
      const wt = current.get(path);
      if (!wt || !isRemovable(wt)) selected.delete(path);
    }
  };

  const replaceCollection = (next: Collection, clearSelection: boolean): void => {
    collection = next;
    if (clearSelection) selected = new Set<string>();
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
    status = `${selected.size} removable worktree${selected.size === 1 ? '' : 's'} selected`;
  };

  const toggleCurrentSelection = (): void => {
    const wt = currentWorktree();
    if (!wt) {
      status = 'no worktree is visible';
      return;
    }
    const plan = planFor(wt);
    if (plan.blocks.length > 0) {
      status = `cannot select ${shortPath(wt.path, options.cwd)}: ${plan.blocks
        .map((block) => block.message)
        .join('; ')}`;
      return;
    }
    if (selected.has(wt.path)) {
      selected.delete(wt.path);
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
      const checkbox = selected.has(wt.path) ? paint('[x]', 'green') : '[ ]';
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
    const header = `wtree — ${options.repo.root} — ${visible.length}/${collection.worktrees.length} shown, ${removable} removable, ${selected.size} selected`;
    const filterLine = `sort: ${sortKey}  PR: ${prFilter}  filter: ${
      filterMode ? `/${filterDraft}_` : pathFilter || 'none'
    }  age: ${options.ageBasis}  delete branches: ${deleteBranch ? 'on' : 'off'}`;
    const footer = fit(
      'j/k or arrows move  g/G top/bottom  Space select  a all removable  A/c clear  / filter  s sort  p PR  r refresh  S size  Enter details  d delete  b branches  q/Esc quit',
      'j/k move  Space select  a all  / filter  s sort  p PR  r refresh  Enter details  d delete  q quit',
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

  const renderPaged = (title: string, content: string[], scroll: number): void => {
    const height = Math.max(1, stdout.rows || 24);
    const capacity = Math.max(1, height - 2);
    const maxScroll = Math.max(0, content.length - capacity);
    const start = Math.min(scroll, maxScroll);
    const lines = [title, ...content.slice(start, start + capacity - 1)];
    while (lines.length < Math.max(1, height - 1)) lines.push('');
    lines.push(
      fit(
        'j/k or arrows scroll  y confirm where offered  b toggle branches  Esc cancel  q quit',
        'j/k scroll  y confirm  b branches  Esc cancel  q quit',
      ),
    );
    stdout.write(`${ESC}2J${ESC}H${clampLines(lines).join('\n')}`);
  };

  const render = (): void => {
    switch (screen) {
      case 'list':
        renderList();
        break;
      case 'detail': {
        const wt = currentWorktree();
        renderPaged('wtree — worktree detail', wt ? detailLines(wt) : ['no worktree selected'], 0);
        break;
      }
      case 'confirm': {
        const content = [
          paint(
            `DELETE WORKTREES — also delete branches: ${deleteBranch ? 'YES' : 'NO'}`,
            'bold',
          ),
          '',
          ...renderPlanLines(pendingPlans),
        ];
        renderPaged('wtree — confirmation', content, confirmScroll);
        break;
      }
      case 'results':
        renderPaged('wtree — deletion results', resultLines, resultScroll);
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
      lines.push(
        `  ${paint('REMOVE', 'red')} ${shortPath(wt.path, options.cwd)}${branch} ${paint(
          `(${formatAge(ageDays(wt, options.ageBasis))}, ${prStateOf(wt)})`,
          'dim',
        )}`,
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
    pendingTargets = targets;
    pendingPlans = targets.map(planFor);
    confirmScroll = 0;
    screen = 'confirm';
    status = null;
  };

  const togglePendingBranchDeletion = (): void => {
    deleteBranch = !deleteBranch;
    pendingPlans = pendingTargets.map(planFor);
    confirmScroll = 0;
  };

  const performDeletion = async (): Promise<void> => {
    busy = true;
    try {
      const results = await execute(pendingPlans, { repo: options.repo, force: false });
      let reloadError: string | null = null;
      try {
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
    if (str === 'c' || str === 'A' || isUpper(key, 'a')) {
      selected.clear();
      status = 'selection cleared';
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
