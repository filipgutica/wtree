import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { emitKeypressEvents } from 'node:readline';
import type { Key } from 'node:readline';
import { ReadStream, WriteStream } from 'node:tty';

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
  compactBranchLabel,
  compactPath,
  flags,
  formatAge,
  formatPr,
  formatSize,
  clampAnsi,
  highlightRow,
  legend,
  paint,
  restoreHint,
  setColorOverride,
  shortPath,
  visibleWidth,
} from './render.js';
import { run } from './exec.js';
import type { AgeBasis, Worktree } from './types.js';

export interface TuiOptions {
  cwd: string;
  repo: RepoContext;
  collection: Collection;
  ageBasis: AgeBasis;
  showSize: boolean;
  /** Re-run collection (used by the refresh key). */
  reload: (opts: { refresh: boolean; size: boolean }) => Promise<Collection>;
  /** Create a worktree for `branch` (the `n` key). May reject; the message is shown. */
  create: (branch: string) => Promise<{ path: string; created: boolean; warnings: string[] }>;
}

export interface TuiResult {
  code: number;
  /** Worktree the user chose to open with `o`; the caller prints it to stdout. */
  openPath: string | null;
}

/** Every key, for the `?` screen. The footer only shows the essentials. */
export const HELP_ENTRIES: readonly (readonly [key: string, description: string])[] = [
  ['j / k, arrows', 'move the cursor (scroll on paged screens)'],
  ['g / G', 'jump to the top / bottom'],
  ['Space', 'select or unselect the worktree under the cursor'],
  ['f', 'force-select a dirty, unpushed or locked worktree'],
  ['a', 'select every removable worktree'],
  ['F', 'select every removable worktree, forcing where needed'],
  ['c / A', 'clear the selection'],
  ['/', 'filter by branch or path (Enter applies, Esc cancels)'],
  ['s', 'cycle the sort key'],
  ['p', 'cycle the PR filter'],
  ['b', 'toggle deleting branches along with worktrees'],
  ['r', 'refresh worktrees and PR state'],
  ['S', 'show or hide the size column'],
  ['Enter', 'show details for the worktree under the cursor'],
  ['o', 'open the worktree: exit and print its path'],
  ['n', 'create a worktree for a new or existing branch'],
  ['d', 'delete the selection, or the worktree under the cursor'],
  ['w', 'open the focused worktree PR in the browser'],
  ['y', 'copy the focused worktree path'],
  ['y / b / Esc', 'confirm screen: remove / toggle branch deletion / cancel'],
  ['?', 'show this help'],
  ['q / Esc', 'quit (Esc goes back on other screens)'],
  ['Ctrl-C', 'quit from any screen'],
];

/**
 * OSC 52 asks the terminal to set its clipboard. It works over SSH and in
 * terminals that allow it; others ignore it, hence "best effort".
 */
export const osc52 = (text: string): string =>
  `\u001b]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;

// Lives in render.ts so the CLI shares it; re-exported for existing callers.
export { restoreHint } from './render.js';

type Screen = 'list' | 'detail' | 'help' | 'confirm' | 'working' | 'results';
type PrFilter = 'all' | 'merged+closed' | 'open' | 'none';

const SORT_KEYS: readonly SortKey[] = ['age', 'path', 'branch', 'size', 'pr'];
const ESC = '\u001b[';

/** Reserve one row each for the title and footer of every paged screen. */
export const pagedWindow = ({
  rows,
  contentLength,
  scroll,
}: {
  rows: number;
  contentLength: number;
  scroll: number;
}): { start: number; end: number; maxScroll: number } => {
  const capacity = Math.max(1, rows - 2);
  const maxScroll = Math.max(0, contentLength - capacity);
  const start = Math.max(0, Math.min(scroll, maxScroll));
  return { start, end: start + capacity, maxScroll };
};

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const oneLine = (value: string): string => value.replace(/[\r\n]+/g, ' ');

/** Paged content wraps instead of discarding the ends of paths, branches or legends. */
const wrapLine = (line: string, columns: number): string[] => {
  const plain = line.replace(/\u001b\[[0-9;]*m/g, '');
  if (plain.length === 0) return [''];
  const rows: string[] = [];
  for (let start = 0; start < plain.length; start += columns) rows.push(plain.slice(start, start + columns));
  return rows;
};

const padCell = (cell: string, width: number): string =>
  cell + ' '.repeat(Math.max(0, width - visibleWidth(cell)));

const isEnter = (key: Key): boolean => key.name === 'return' || key.name === 'enter';

const isEscape = (key: Key): boolean => key.name === 'escape' || key.sequence === '\u001b';

const isUpper = (key: Key, value: string): boolean => key.name === value && key.shift === true;

const renderCells = ({ headers, rows, widths }: { headers: string[]; rows: string[][]; widths: number[] }): string[] => {
  const line = (cells: string[]): string =>
    cells
      .map((cell, index) => {
        const cellWidth = widths[index] ?? visibleWidth(cell);
        const fitted = clampAnsi(cell, cellWidth);
        return index === cells.length - 1 ? fitted : padCell(fitted, cellWidth);
      })
      .join('  ')
      .trimEnd();
  return [line(headers.map((header) => paint(header, 'dim'))), ...rows.map(line)];
};

/**
 * Open /dev/tty as separate read and write streams, so destroying one cannot
 * close the other's descriptor. Null when there is no controlling terminal.
 */
const openTerminal = (): { input: ReadStream; output: WriteStream } | null => {
  let readFd: number | null = null;
  let writeFd: number | null = null;
  let input: ReadStream | null = null;
  try {
    readFd = openSync('/dev/tty', 'r');
    writeFd = openSync('/dev/tty', 'w');
    input = new ReadStream(readFd);
    return { input, output: new WriteStream(writeFd) };
  } catch {
    // Any failure here (typically ENXIO: no controlling terminal) means the TUI
    // cannot run; the caller reports that. Release whatever was opened.
    if (input) input.destroy();
    else if (readFd !== null) closeSync(readFd);
    if (writeFd !== null) closeSync(writeFd);
    return null;
  }
};

/**
 * Runs the interactive worktree view. Terminal restoration is kept in the
 * outer finally because reload and deletion both cross asynchronous boundaries.
 */
export const runTui = async (options: TuiOptions): Promise<TuiResult> => {
  // Draw and read on the controlling terminal, not stdout/stdin: under
  // `p=$(wtree ui)` stdout is a pipe that must carry only the chosen path.
  const terminal = openTerminal();
  if (!terminal) {
    process.stderr.write('wtree ui needs an interactive terminal. Use `wtree list --json` instead.\n');
    return { code: 2, openPath: null };
  }
  const { input, output } = terminal;

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
  let createDraft = '';
  let createMode = false;
  let helpScroll = 0;
  let detailScroll = 0;
  let deleteBranch = false;
  let pendingTargets: Worktree[] = [];
  let pendingPlans: Plan[] = [];
  let progressLines: string[] = [];
  let confirmScroll = 0;
  let resultLines: string[] = [];
  let resultScroll = 0;
  let busy = false;
  let rawModeEnabled = false;
  let resolveExit: ((result: TuiResult) => void) | null = null;

  const finish = (code: number, openPath: string | null = null): void => {
    if (resolveExit) {
      resolveExit({ code, openPath });
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
    status = null;
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
      `branch: ${wt.branch ?? (wt.bare ? '(bare)' : `(detached ${wt.head ?? '—'})`)}`,
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
      paint('o open   w PR in browser   y copy path   Enter or Esc return', 'dim'),
    ].flatMap((line) => wrapLine(line, width()));
  };

  const listCells = (visible: Worktree[]): { headers: string[]; rows: string[][]; widths: number[] } => {
    // On small terminals give branch and path priority over optional metadata.
    const showMetadata = width() >= 70;
    const showFlags = width() >= 45;
    const headers = ['', '', 'BRANCH', ...(showMetadata ? ['AGE', 'PR', ...(showSize ? ['SIZE'] : [])] : []), ...(showFlags ? ['FLAGS'] : []), 'PATH'];
    const rows = visible.map((wt, index) => [
      index === cursor ? paint('>', 'cyan') : ' ',
      forced.has(wt.path) ? paint('[!]', 'red')
        : selected.has(wt.path) ? paint('[x]', 'green')
          : isRemovable(wt) ? '[ ]' : paint('[-]', 'dim'),
      '',
      ...(showMetadata ? [formatAge(ageDays(wt, options.ageBasis)), formatPr(wt), ...(showSize ? [formatSize(wt.sizeKb)] : [])] : []),
      ...(showFlags ? [flags(wt)] : []),
      '',
    ]);
    const widths = headers.map((header, index) =>
      Math.max(visibleWidth(header), ...rows.map((row) => visibleWidth(row[index] ?? ''))),
    );
    const pathIndex = headers.length - 1;
    const fixedWidth = widths.reduce((total, value, index) => total + (index === 2 || index === pathIndex ? 0 : value), 0);
    const identityWidth = Math.max(2, width() - fixedWidth - (headers.length - 1) * 2);
    const branchWidth = Math.max(1, Math.min(42, Math.floor(identityWidth / 2)));
    const pathWidth = Math.max(1, identityWidth - branchWidth);
    widths[2] = branchWidth;
    widths[pathIndex] = pathWidth;
    const mainPath = collection.worktrees.find((wt) => wt.isMain)?.path ?? null;
    for (const [index, wt] of visible.entries()) {
      const cells = rows[index];
      if (!cells) continue;
      cells[2] = compactBranchLabel(wt, branchWidth);
      cells[pathIndex] = compactPath({ wt, cwd: options.cwd, mainPath, width: pathWidth });
    }
    return { headers, rows, widths };
  };

  // getWindowSize() returns cached properties. Refresh them on SIGWINCH using
  // a new stream; Node only refreshes process.stdout's stream automatically.
  let dimensions = { columns: output.columns || 80, rows: output.rows || 24 };
  const terminalSize = (): { columns: number; rows: number } => dimensions;

  const width = (): number => Math.max(20, terminalSize().columns);

  /** Nothing may wrap: a wrapped line costs a row the layout did not budget for. */
  const clampLines = (lines: string[]): string[] => lines.map((l) => clampAnsi(l, width()));

  /** Prefer the full text, fall back to a shorter one rather than truncating key hints away. */
  const fit = (full: string, short: string): string =>
    visibleWidth(full) <= width() ? full : short;

  const renderList = (): void => {
    const visible = getVisibleWorktrees();
    const height = Math.max(1, terminalSize().rows);
    // repo, filters, removal scope, table header, footer, status.
    const rowCapacity = Math.max(0, height - 6);
    if (visible.length === 0) cursor = 0;
    else cursor = Math.min(cursor, visible.length - 1);
    const maxScroll = Math.max(0, visible.length - rowCapacity);
    scrollTop = Math.min(scrollTop, maxScroll);
    if (cursor < scrollTop) scrollTop = cursor;
    if (rowCapacity > 0 && cursor >= scrollTop + rowCapacity) {
      scrollTop = cursor - rowCapacity + 1;
    }

    const { headers, rows, widths } = listCells(visible);
    const tableLines = renderCells({ headers, rows, widths });
    const firstRow = Math.max(0, scrollTop) + 1;
    const shownRows = tableLines.slice(firstRow, firstRow + rowCapacity);
    const removable = collection.worktrees.filter(isRemovable).length;
    const count = visible.length === collection.worktrees.length
      ? `${visible.length} worktrees` : `${visible.length} of ${collection.worktrees.length} match`;
    const header = `wtree — ${basename(options.repo.root)} · ${count} · ${removable} removable overall`;
    const visiblePaths = new Set(visible.map((wt) => wt.path));
    const hidden = [...selected].filter((path) => !visiblePaths.has(path)).length;
    const selectionLine = `delete branches: ${deleteBranch ? 'ON' : 'off'} · ${selected.size} selected${hidden ? ` · ${hidden} hidden by filter` : ''}${forced.size ? ` · ${forced.size} forced` : ''}`;
    const range = visible.length > 0 && shownRows.length > 0
      ? `Rows ${firstRow}–${firstRow + shownRows.length - 1} of ${visible.length}` : `Rows 0 of ${visible.length}`;
    const filterLine = `${range} · s sort: ${sortKey} · p PR: ${prFilter} · filter: ${filterMode ? `/${filterDraft}_` : pathFilter || 'none'} · age: ${options.ageBasis}`;
    const removalScope = selected.size > 0 ? String(selected.size) : 'focused';
    const footer = fit(
      `o open · Enter details · / filter · n new · Space select · d review removal (${removalScope}) · ? help · q quit`,
      `o open · Enter details · / filter · n new · d review (${removalScope}) · ? help`,
    );
    const focused = visible[cursor];
    const blocks = focused ? planFor(focused).blocks : [];
    const blocked = blocks.length > 0 ? `blocked: ${blocks.map((block) => block.message).join('; ')} · ` : '';
    const identityWidth = Math.max(2, width() - visibleWidth(blocked) - 3);
    const focusedBranchWidth = Math.max(1, Math.min(42, Math.floor(identityWidth / 2)));
    const focusStatus = focused
      ? `${blocked}${compactBranchLabel(focused, focusedBranchWidth)} — ${compactPath({ wt: focused, cwd: '', mainPath: null, width: Math.max(1, identityWidth - focusedBranchWidth) })}`
      : `No matches${pathFilter || filterDraft ? ` for ${filterMode ? filterDraft : pathFilter}` : ` for PR: ${prFilter}`}`;
    const footerStatus = createMode ? `new worktree for branch: ${createDraft}_` : status ?? focusStatus;
    const headerLines = [header, filterLine, selectionLine, tableLines[0] ?? ''];
    if (visible.length === 0 && rowCapacity > 0) shownRows.push(focusStatus);
    const lines = [...headerLines, ...shownRows];
    while (lines.length < Math.max(0, height - 2)) lines.push('');
    lines.push(footer, footerStatus);

    const clamped = clampLines(lines);
    // Highlight the cursor row only when it is actually on screen.
    const cursorLine = headerLines.length + (cursor - scrollTop);
    if (visible.length > 0 && cursorLine >= headerLines.length && cursorLine < headerLines.length + shownRows.length) {
      clamped[cursorLine] = highlightRow(clamped[cursorLine] ?? '', width());
    }
    output.write(`${ESC}2J${ESC}H${clamped.join('\n')}`);
  };

  const renderPaged = (
    title: string,
    content: string[],
    scroll: number,
    hints: [full: string, short: string],
  ): void => {
    const height = Math.max(1, terminalSize().rows);
    const { start, end } = pagedWindow({ rows: height, contentLength: content.length, scroll });
    const lines = [title, ...content.slice(start, end)];
    while (lines.length < Math.max(1, height - 1)) lines.push('');
    lines.push(fit(hints[0], hints[1]));
    output.write(`${ESC}2J${ESC}H${clampLines(lines).join('\n')}`);
  };

  const render = (): void => {
    switch (screen) {
      case 'list':
        renderList();
        break;
      case 'detail': {
        const wt = currentWorktree();
        renderPaged('wtree — worktree detail', wt ? detailLines(wt) : ['no worktree selected'], detailScroll, [
          'j/k scroll   o open   w PR in browser   y copy path   Enter or Esc back   q quit',
          'j/k scroll  o open  w PR  y copy  Esc back  q quit',
        ]);
        break;
      }
      case 'help':
        renderPaged('wtree — keys and legend', helpLines(), helpScroll, [
          'j/k scroll   Esc, Enter or ? back to the list   q quit',
          'j/k scroll  Esc back  q quit',
        ]);
        break;
      case 'confirm': {
        const content = confirmationLines();
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
        renderPaged('wtree — deletion results', resultLines.flatMap((line) => wrapLine(line, width())), resultScroll, [
          'j/k scroll   Enter or Esc returns to the list   q quit',
          'j/k scroll  Enter back  q quit',
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
      const leftover =
        wt.prunable && !wt.missing ? paint(' + leftover directory', 'yellow') : '';
      const override =
        plan.overridden.length > 0
          ? ` ${paint(`[FORCED: ${plan.overridden.map((b) => b.message).join('; ')}]`, 'red')}`
          : '';
      lines.push(
        `  ${paint(plan.overridden.length > 0 ? 'FORCE ' : 'REMOVE', 'red')} ${shortPath(
          wt.path,
          options.cwd,
        )}${branch}${leftover} ${paint(
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
    return lines.flatMap((line) => wrapLine(line, width()));
  };

  const confirmationLines = (): string[] => [
    ...wrapLine(paint(
      `DELETE WORKTREES — also delete branches: ${deleteBranch ? 'YES' : 'NO'}${
        forced.size > 0 ? `  —  ${forced.size} FORCED, uncommitted work will be lost` : ''
      }`,
      'bold',
    ), width()),
    '',
    ...renderPlanLines(pendingPlans),
  ];

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
        lines.push(`${paint(result.note ? 'PRUNED ' : 'REMOVED', 'green')} ${path}${branch}`);
        if (result.note) lines.push(`  ${paint(result.note, 'yellow')}`);
        // result.branch is only set when branch deletion was requested.
        const hint = restoreHint({
          ...result,
          branch:
            result.branch ??
            plans.find((plan) => plan.worktree.path === result.path)?.worktree.branch ??
            null,
        });
        if (hint) lines.push(`  ${paint(hint, 'dim')}`);
      } else {
        lines.push(`${paint('ERROR', 'red')} ${path} — ${result.error ?? 'removal failed'}`);
      }
      if (result.branchError) {
        lines.push(`  ${paint('BRANCH ERROR', 'red')} ${result.branchError}`);
      }
    }
    if (lines.length === 0) lines.push(paint('nothing was removed.', 'dim'));
    lines.push('', paint('j/k scroll; Enter or Esc returns to the list.', 'dim'));
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
        const mark = event.result.removed
          ? paint(event.result.note ? 'pruned' : 'done  ', 'green')
          : paint('failed', 'red');
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

  const helpLines = (): string[] => {
    const keyWidth = Math.max(...HELP_ENTRIES.map(([key]) => key.length));
    return [
      ...HELP_ENTRIES.flatMap(([key, description]) => wrapLine(`${key.padEnd(keyWidth)}  ${description}`, width())),
      '',
      'FLAGS AND PATHS',
      ...wrapLine(legend(), width()),
      ...wrapLine('[ ] removable   [x] selected   [!] force selected   [-] blocked (f may override)', width()),
      ...wrapLine('Selections survive filtering. d reviews all selected worktrees, including hidden ones.', width()),
    ];
  };

  const showHelp = (): void => {
    screen = 'help';
    helpScroll = 0;
    status = null;
    render();
  };

  /** Exit and hand the path to the caller, which prints it for the shell wrapper to cd into. */
  const openCurrent = (): void => {
    const wt = currentWorktree();
    if (!wt) {
      status = 'no worktree is visible';
      render();
      return;
    }
    if (wt.missing || !existsSync(wt.path)) {
      status = `cannot open ${shortPath(wt.path, options.cwd)}: its directory is missing`;
      render();
      return;
    }
    finish(0, wt.path);
  };

  const copyCurrentPath = (): void => {
    const wt = currentWorktree();
    if (!wt) {
      status = 'no worktree selected';
      return;
    }
    output.write(osc52(wt.path));
    if (process.platform === 'darwin') {
      // Deliberately unchecked: OSC 52 is the primary route, and pbcopy failing
      // (missing, sandboxed) should not turn a best-effort copy into an error.
      spawnSync('pbcopy', { input: wt.path });
    }
    status = 'copied path (best effort)';
  };

  const openCurrentPr = async (): Promise<void> => {
    const wt = currentWorktree();
    if (!wt || wt.pr.status !== 'found') {
      status = 'no PR found for this worktree';
      return;
    }
    status = `opening PR #${wt.pr.number} in the browser...`;
    render();
    const result = await run({
      cmd: 'gh',
      args: ['pr', 'view', String(wt.pr.number), '--web'],
      cwd: options.repo.root,
    });
    status = result.ok
      ? `opened PR #${wt.pr.number} in the browser`
      : `gh pr view failed: ${oneLine(result.stderr.trim() || `exit code ${result.code}`)}`;
  };

  /** Put the cursor on `path` (or, failing that, `branch`); false when filters hide it. */
  const focusWorktree = (path: string, branch: string): boolean => {
    const target = resolve(path);
    const visible = getVisibleWorktrees();
    const byPath = visible.findIndex((wt) => resolve(wt.path) === target);
    // git may report a different spelling of the same directory (macOS /var vs /private/var).
    const index = byPath >= 0 ? byPath : visible.findIndex((wt) => wt.branch === branch);
    if (index < 0) return false;
    cursor = index;
    return true;
  };

  const submitCreate = async (branch: string): Promise<void> => {
    busy = true;
    status = `creating worktree for ${branch}...`;
    render();
    try {
      const created = await options.create(branch);
      const reloaded = await reloadCollection({ refresh: false, size: showSize });
      // reloadCollection clears status on success and sets it on failure.
      const reloadNote = reloaded ? '' : `; ${status ?? 'reload failed'}`;
      const where = shortPath(created.path, options.cwd);
      const outcome = created.created ? `created ${where}` : `already exists at ${where}`;
      const warnings = created.warnings.map(oneLine).join('; ');
      const hidden = reloaded && !focusWorktree(created.path, branch) ? ' (hidden by the current filter)' : '';
      status = `${outcome}${hidden}${warnings ? ` — ${warnings}` : ''}${reloadNote}`;
    } catch (error) {
      status = `create failed: ${oneLine(errorMessage(error))}`;
    } finally {
      busy = false;
      render();
    }
  };

  const handleCreateKey = async (str: string, key: Key): Promise<void> => {
    if (isEscape(key)) {
      createMode = false;
      createDraft = '';
      status = 'create cancelled';
      render();
      return;
    }
    if (isEnter(key)) {
      const branch = createDraft.trim();
      createMode = false;
      createDraft = '';
      if (!branch) {
        status = 'create cancelled: no branch name';
        render();
        return;
      }
      await submitCreate(branch);
      return;
    }
    if (key.name === 'backspace') {
      createDraft = Array.from(createDraft).slice(0, -1).join('');
      render();
      return;
    }
    if (!key.ctrl && !key.meta && str >= ' ' && str !== '\u007f') {
      createDraft += str;
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
      status = null;
      render();
      return;
    }
    if (isUpper(key, 'g') || str === 'G') {
      const visible = getVisibleWorktrees();
      cursor = Math.max(0, visible.length - 1);
      status = null;
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
        detailScroll = 0;
        status = null;
      } else {
        status = 'no worktree is visible';
      }
      render();
      return;
    }
    if (str === 'o') {
      openCurrent();
      return;
    }
    if (str === 'y') {
      copyCurrentPath();
      render();
      return;
    }
    if (str === 'w') {
      busy = true;
      try {
        await openCurrentPr();
      } finally {
        busy = false;
        render();
      }
      return;
    }
    if (str === 'n') {
      createMode = true;
      createDraft = '';
      render();
      return;
    }
    if (str === '?') {
      showHelp();
      return;
    }
    if (str === 'd') {
      beginDeletion();
      render();
    }
  };

  const handleDetailKey = async (str: string, key: Key): Promise<void> => {
    const wt = currentWorktree();
    const nextScroll = scrollForKey({ str, key, scroll: detailScroll, contentLength: wt ? detailLines(wt).length : 1 });
    if (nextScroll !== null) {
      detailScroll = nextScroll;
      render();
      return;
    }
    if (str === 'q') {
      finish(0);
      return;
    }
    if (isEscape(key) || isEnter(key)) {
      screen = 'list';
      render();
      return;
    }
    if (str === 'o') {
      openCurrent();
      return;
    }
    if (str === '?') {
      showHelp();
      return;
    }
    if (str === 'y') {
      copyCurrentPath();
      render();
      return;
    }
    if (str === 'w') {
      busy = true;
      try {
        await openCurrentPr();
      } finally {
        busy = false;
        render();
      }
    }
  };

  const scrollForKey = ({
    str,
    key,
    scroll,
    contentLength,
  }: { str: string; key: Key; scroll: number; contentLength: number }): number | null => {
    const { start, maxScroll } = pagedWindow({ rows: terminalSize().rows, contentLength, scroll });
    if (key.name === 'down' || str === 'j') return Math.min(maxScroll, start + 1);
    if (key.name === 'up' || str === 'k') return Math.max(0, start - 1);
    if (str === 'g') return 0;
    if (str === 'G' || isUpper(key, 'g')) return maxScroll;
    return null;
  };

  const handlePagedKey = (str: string, key: Key): void => {
    if (str === 'q') {
      finish(0);
      return;
    }
    if (screen === 'help') {
      if (isEscape(key) || isEnter(key) || str === '?') {
        screen = 'list';
        render();
        return;
      }
      const nextScroll = scrollForKey({ str, key, scroll: helpScroll, contentLength: helpLines().length });
      if (nextScroll === null) return;
      helpScroll = nextScroll;
      render();
      return;
    }
    if (screen === 'results') {
      const nextScroll = scrollForKey({ str, key, scroll: resultScroll, contentLength: resultLines.flatMap((line) => wrapLine(line, width())).length });
      if (nextScroll !== null) {
        resultScroll = nextScroll;
        render();
        return;
      }
      if (isEscape(key) || isEnter(key) || str) {
        screen = 'list';
        status = null;
        render();
      }
      return;
    }
    if (screen === 'confirm') {
      const contentLength = confirmationLines().length;
      const nextScroll = scrollForKey({ str, key, scroll: confirmScroll, contentLength });
      if (nextScroll !== null) confirmScroll = nextScroll;
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
    if (createMode) {
      await handleCreateKey(str, key);
      return;
    }
    if (screen === 'list') await handleListKey(str, key);
    else if (screen === 'detail') await handleDetailKey(str, key);
    else handlePagedKey(str, key);
  };

  /** First unexpected error; the TUI exits, restores the terminal, then rethrows it. */
  const failures: unknown[] = [];
  const fail = (error: unknown): void => {
    failures.push(error);
    finish(1);
  };

  const onKeypress = (str: string, key: Key): void => {
    handleKeypress(str, key).catch(fail);
  };
  const onResize = (): void => {
    let fd: number | null = null;
    let resized: WriteStream | null = null;
    try {
      fd = openSync('/dev/tty', 'w');
      resized = new WriteStream(fd);
      dimensions = { columns: resized.columns || 80, rows: resized.rows || 24 };
      if (resolveExit) render();
    } catch (error) {
      fail(error);
    } finally {
      if (resized) resized.destroy();
      else if (fd !== null) closeSync(fd);
    }
  };
  const onSigint = (): void => finish(130);

  try {
    setColorOverride(true);
    // Left attached through teardown so a failing final write cannot crash the process.
    input.on('error', fail);
    output.on('error', fail);
    emitKeypressEvents(input);
    input.setRawMode(true);
    rawModeEnabled = true;
    input.resume();
    input.on('keypress', onKeypress);
    // A WriteStream on /dev/tty never emits 'resize'; only process.stdout does.
    process.on('SIGWINCH', onResize);
    process.once('SIGINT', onSigint);
    output.write(`${ESC}?1049h${ESC}?25l${ESC}2J${ESC}H`);
    render();
    const result = await new Promise<TuiResult>((done) => {
      resolveExit = done;
    });
    if (failures.length > 0) throw failures[0];
    return result;
  } finally {
    input.off('keypress', onKeypress);
    process.off('SIGWINCH', onResize);
    process.off('SIGINT', onSigint);
    resolveExit = null;
    try {
      output.write(`${ESC}?25h${ESC}?1049l${ESC}0m`);
    } finally {
      try {
        if (rawModeEnabled) input.setRawMode(false);
      } finally {
        // An undestroyed ReadStream keeps the event loop alive after quitting.
        input.destroy();
        output.destroy();
        setColorOverride(false);
      }
    }
  }
};
