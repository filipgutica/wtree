import { FLAG_LEGEND_ENTRIES, flags, paint, visibleWidth } from './render.js';
import type { Worktree } from './types.js';

/** Fit whole labels; never truncate a key or a removal-scope count. */
const pack = ({ labels, columns }: { labels: string[]; columns: number }): string[] => {
  const lines: string[] = [];
  for (const label of labels) {
    const previous = lines.at(-1);
    if (previous !== undefined && visibleWidth(`${previous} · ${label}`) <= columns) {
      lines[lines.length - 1] = `${previous} · ${label}`;
    } else lines.push(label);
  }
  return lines;
};

export const popupSize = ({ columns, rows }: { columns: number; rows: number }): { columns: number; rows: number } => ({
  columns: Math.max(16, Math.min(90, Math.floor(columns * 0.75), columns - 4)),
  rows: Math.max(4, Math.min(18, Math.floor(rows * 0.6), rows - 4)),
});

/** Leave at least one table row visible when adding the focused details pane. */
export const previewHeight = ({ rows, headerRows, footerRows }: {
  rows: number; headerRows: number; footerRows: number;
}): number => {
  const available = rows - headerRows - footerRows;
  return available >= 4 ? Math.min(Math.max(3, Math.floor(rows * 0.38)), available - 1) : 0;
};

export const selectionScopeLines = ({ columns, selected, hidden, forced, deleteBranch }: {
  columns: number; selected: number; hidden: number; forced: number; deleteBranch: boolean;
}): string[] => pack({ columns, labels: [
  `delete branches: ${deleteBranch ? 'ON' : 'off'}`,
  `${selected} selected`,
  ...(hidden ? [`${hidden} hidden by filter`] : []),
  ...(forced ? [paint(`${forced} forced`, 'red')] : []),
] });

export const listFooter = ({ columns, rows, worktrees, focused, marker, forceable, reviewCount }: {
  columns: number;
  rows: number;
  worktrees: readonly Worktree[];
  focused: Worktree | undefined;
  marker: '[ ]' | '[x]' | '[!]' | '[-]';
  forceable: boolean;
  reviewCount: number;
}): { shortcuts: string; legend: string[] } => {
  const essential = [['o', 'open'], ['?', 'help'], ['q', 'quit']] as const;
  const fullEssential = essential.map(([key, label]) => `${paint(key, 'cyan')} ${label}`);
  const chosen = visibleWidth(fullEssential.join(' · ')) <= columns ? fullEssential
    : [`${paint('o', 'cyan')} open`, `${paint('?', 'cyan')} help`, paint('q', 'cyan')];
  const hints: (readonly [string, string])[] = [
    ...(forceable ? [['f', 'force'] as const] : []),
    ...(reviewCount ? [['d', `review ${reviewCount}`] as const] : []),
    ['Space', 'select'], ['Enter', 'details'], ['/', 'filter'], ['n', 'new'],
  ];
  for (const [key, label] of hints) {
    const hint = `${paint(key, 'cyan')} ${label}`;
    if (visibleWidth([...chosen, hint].join(' · ')) <= columns) chosen.push(hint);
  }
  const expanded = columns >= 120 && rows >= 28;
  const context = columns >= 80 && rows >= 20 ? worktrees : focused ? [focused] : [];
  const presentFlags = context.map(flags).join('');
  const markerLabel = marker === '[!]' ? paint('[!] force selected', 'red')
    : marker === '[x]' ? paint('[x] selected', 'green')
    : marker === '[ ]' ? '[ ] removable'
    : forceable ? paint('[-] blocked: f force', 'yellow') : paint('[-] protected', 'dim');
  const labels = expanded ? [
    '[ ] removable', paint('[x] selected', 'green'), paint('[!] force selected', 'red'),
    paint('[-] blocked/protected', 'yellow'),
  ] : focused ? [markerLabel] : [];
  for (const [glyph, color, label] of FLAG_LEGEND_ENTRIES) {
    if (expanded || presentFlags.includes(glyph)) labels.push(`${paint(glyph, color)} ${label}`);
  }
  labels.push('path: · default');
  const maxLines = expanded || (columns >= 80 && rows >= 20) ? 2 : 1;
  const legend: string[] = [];
  for (const label of labels) {
    const packed = pack({ columns, labels: [...legend, label] });
    if (packed.length <= maxLines) {
      legend.splice(0, legend.length, ...packed);
    }
  }
  return { shortcuts: chosen.join(' · '), legend };
};
