import { relative } from 'node:path';
import { ageDays, prStateOf } from './filter.js';
import type { Plan } from './clean.js';
import type { AgeBasis, Worktree } from './types.js';

const ESC = '[';

const useColor = (): boolean =>
  !process.env['NO_COLOR'] && process.env['TERM'] !== 'dumb' && process.stdout.isTTY === true;

const CODES = {
  reset: `${ESC}0m`,
  dim: `${ESC}2m`,
  bold: `${ESC}1m`,
  red: `${ESC}31m`,
  green: `${ESC}32m`,
  yellow: `${ESC}33m`,
  blue: `${ESC}34m`,
  magenta: `${ESC}35m`,
  cyan: `${ESC}36m`,
} as const;

export type ColorName = keyof Omit<typeof CODES, 'reset'>;

export const paint = (text: string, color: ColorName, enabled = useColor()): string =>
  enabled ? `${CODES[color]}${text}${CODES.reset}` : text;

const ANSI_RE = new RegExp(`${ESC.replace('[', '\\[')}[0-9;]*m`, 'g');

/** Visible width, ignoring the ANSI sequences added by `paint`. */
export const visibleWidth = (text: string): number => text.replace(ANSI_RE, '').length;

/**
 * Cut a string to `width` visible columns, keeping ANSI sequences intact.
 * A full-screen view must never emit a line wider than the terminal: a wrapped
 * line silently costs a second row and pushes content off the top of the screen.
 */
export const clampAnsi = (text: string, width: number): string => {
  if (width <= 0) return '';
  if (visibleWidth(text) <= width) return text;

  let out = '';
  let shown = 0;
  let i = 0;
  let sawEscape = false;

  while (i < text.length && shown < width - 1) {
    if (text.startsWith(ESC, i)) {
      const end = text.indexOf('m', i);
      if (end === -1) break;
      out += text.slice(i, end + 1);
      sawEscape = true;
      i = end + 1;
      continue;
    }
    out += text[i];
    shown += 1;
    i += 1;
  }
  return `${out}\u2026${sawEscape ? CODES.reset : ''}`;
};

const pad = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - visibleWidth(text)));

export const table = (headers: string[], rows: string[][]): string => {
  const widths = headers.map((h, i) =>
    Math.max(visibleWidth(h), ...rows.map((r) => visibleWidth(r[i] ?? ''))),
  );
  const line = (cells: string[]): string =>
    cells
      .map((c, i) => (i === cells.length - 1 ? c : pad(c, widths[i] ?? 0)))
      .join('  ')
      .trimEnd();
  return [line(headers.map((h) => paint(h, 'dim'))), ...rows.map(line)].join('\n');
};

export const formatAge = (days: number | null): string => {
  if (days === null) return '?';
  if (days < 1) return `${Math.max(0, Math.round(days * 24))}h`;
  if (days < 45) return `${Math.round(days)}d`;
  if (days < 365) return `${Math.round(days / 30)}mo`;
  return `${(days / 365).toFixed(1)}y`;
};

export const formatSize = (kb: number | null): string => {
  if (kb === null) return '-';
  if (kb < 1024) return `${kb}K`;
  if (kb < 1024 * 1024) return `${(kb / 1024).toFixed(0)}M`;
  return `${(kb / 1024 / 1024).toFixed(1)}G`;
};

export const formatPr = (wt: Worktree): string => {
  switch (wt.pr.status) {
    case 'unknown':
      return paint('?', 'dim');
    case 'none':
      return paint('-', 'dim');
    default: {
      const label = `#${wt.pr.number}`;
      if (wt.pr.state === 'MERGED') return `${paint('merged', 'magenta')} ${paint(label, 'dim')}`;
      if (wt.pr.state === 'CLOSED') return `${paint('closed', 'red')} ${paint(label, 'dim')}`;
      return `${paint('open', 'green')} ${paint(label, 'dim')}`;
    }
  }
};

/** Single-character markers for state that does not deserve its own column. */
export const flags = (wt: Worktree): string => {
  const out: string[] = [];
  if (wt.isMain) out.push(paint('M', 'blue'));
  if (wt.isCurrent) out.push(paint('@', 'cyan'));
  if (wt.dirty) out.push(paint('*', 'yellow'));
  if (wt.unpushed !== null && wt.unpushed > 0) out.push(paint('↑', 'yellow'));
  if (wt.locked) out.push(paint('L', 'yellow'));
  if (wt.prunable || wt.missing) out.push(paint('P', 'red'));
  if (wt.detached) out.push(paint('d', 'dim'));
  if (wt.mergedIntoDefault && !wt.isMain) out.push(paint('✓', 'magenta'));
  return out.join('');
};

/** Generated branch names run long enough to push every other column off screen. */
export const truncate = (text: string, max: number): string =>
  text.length <= max ? text : `${text.slice(0, Math.max(1, max - 1))}\u2026`;

export const BRANCH_MAX = 42;

export const branchLabel = (wt: Worktree, max = BRANCH_MAX): string => {
  if (wt.bare) return paint('(bare)', 'dim');
  if (wt.branch) {
    const name = truncate(wt.branch, max);
    return wt.isMain ? paint(name, 'bold') : name;
  }
  return paint(`(detached ${wt.head?.slice(0, 7) ?? '?'})`, 'dim');
};

export const shortPath = (path: string, cwd: string): string => {
  const rel = relative(cwd, path);
  if (rel && !rel.startsWith('..') && rel.length < path.length) return rel;
  const home = process.env['HOME'];
  return home && path.startsWith(home) ? `~${path.slice(home.length)}` : path;
};

export interface ListRenderOptions {
  worktrees: Worktree[];
  ageBasis: AgeBasis;
  cwd: string;
  showSize: boolean;
  now?: Date;
}

export const renderList = ({
  worktrees,
  ageBasis,
  cwd,
  showSize,
  now = new Date(),
}: ListRenderOptions): string => {
  const headers = ['BRANCH', 'AGE', 'PR', ...(showSize ? ['SIZE'] : []), 'FLAGS', 'PATH'];
  const rows = worktrees.map((wt) => [
    branchLabel(wt),
    formatAge(ageDays(wt, ageBasis, now)),
    formatPr(wt),
    ...(showSize ? [formatSize(wt.sizeKb)] : []),
    flags(wt),
    wt.missing ? paint(shortPath(wt.path, cwd), 'red') : shortPath(wt.path, cwd),
  ]);
  return table(headers, rows);
};

const LEGEND_ENTRIES: [string, ColorName, string][] = [
  ['M', 'blue', 'main'],
  ['@', 'cyan', 'current'],
  ['*', 'yellow', 'dirty'],
  ['\u2191', 'yellow', 'unpushed'],
  ['L', 'yellow', 'locked'],
  ['P', 'red', 'prunable'],
  ['d', 'dim', 'detached'],
  ['\u2713', 'magenta', 'in default branch'],
];

/**
 * Each marker keeps the colour it has in the table, so the key reads as a key.
 * Labels stay plain: dimming the whole line makes it vanish on some themes.
 */
export const legend = (): string =>
  `flags: ${LEGEND_ENTRIES.map(([glyph, color, label]) => `${paint(glyph, color)} ${label}`).join('  ')}`;

export const renderPlan = (plans: Plan[], cwd: string, ageBasis: AgeBasis): string => {
  const lines: string[] = [];
  const removable = plans.filter((p) => p.blocks.length === 0);
  const skipped = plans.filter((p) => p.blocks.length > 0);

  if (removable.length > 0) {
    lines.push(paint(`remove (${removable.length}):`, 'bold'));
    for (const plan of removable) {
      const wt = plan.worktree;
      const extras = [
        formatAge(ageDays(wt, ageBasis)),
        prStateOf(wt),
        ...(wt.sizeKb !== null ? [formatSize(wt.sizeKb)] : []),
      ].join(', ');
      const branch = plan.removeBranch
        ? paint(
            ` +branch ${plan.removeBranch}${plan.branchDeleteSafe ? '' : ' (only if merged)'}`,
            'yellow',
          )
        : '';
      const over =
        plan.overridden.length > 0
          ? paint(` [forced: ${plan.overridden.map((b) => b.code).join(', ')}]`, 'red')
          : '';
      lines.push(
        `  ${paint('-', 'red')} ${shortPath(wt.path, cwd)} ${paint(`(${extras})`, 'dim')}${branch}${over}`,
      );
    }
  }

  if (skipped.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push(paint(`skip (${skipped.length}):`, 'bold'));
    for (const plan of skipped) {
      lines.push(
        `  ${paint('·', 'dim')} ${shortPath(plan.worktree.path, cwd)} ${paint(
          `— ${plan.blocks.map((b) => b.message).join('; ')}`,
          'dim',
        )}`,
      );
    }
  }

  if (lines.length === 0) lines.push(paint('nothing matches those filters.', 'dim'));
  return lines.join('\n');
};

/** Stable machine shape. Agents read this; keep additions backward compatible. */
export const toJson = (worktrees: Worktree[], ageBasis: AgeBasis, now = new Date()): unknown[] =>
  worktrees.map((wt) => {
    const days = ageDays(wt, ageBasis, now);
    return {
      path: wt.path,
      branch: wt.branch,
      head: wt.head,
      isMain: wt.isMain,
      isCurrent: wt.isCurrent,
      bare: wt.bare,
      detached: wt.detached,
      locked: wt.locked,
      lockReason: wt.lockReason,
      prunable: wt.prunable,
      prunableReason: wt.prunableReason,
      missing: wt.missing,
      dirty: wt.dirty,
      unpushed: wt.unpushed,
      mergedIntoDefault: wt.mergedIntoDefault,
      lastCommitAt: wt.lastCommitAt,
      checkoutAt: wt.checkoutAt,
      createdAt: wt.createdAt,
      ageBasis,
      ageDays: days === null ? null : Number(days.toFixed(2)),
      sizeKb: wt.sizeKb,
      prState: prStateOf(wt),
      pr: wt.pr.status === 'found' ? wt.pr : null,
      prUnknownReason: wt.pr.status === 'unknown' ? wt.pr.reason : null,
    };
  });

export const planToJson = (plans: Plan[]): unknown[] =>
  plans.map((plan) => ({
    path: plan.worktree.path,
    branch: plan.worktree.branch,
    willRemove: plan.blocks.length === 0,
    deleteBranch: plan.removeBranch,
    branchDeleteSafe: plan.branchDeleteSafe,
    blockedBy: plan.blocks.map((b) => ({ code: b.code, message: b.message, forceable: b.force })),
    overriddenByForce: plan.overridden.map((b) => ({ code: b.code, message: b.message })),
  }));
