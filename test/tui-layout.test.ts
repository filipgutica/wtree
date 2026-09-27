import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { listFooter, popupSize, selectionScopeLines } from '../src/tui-layout.js';
import { visibleWidth } from '../src/render.js';
import { makeWorktree } from './helpers.js';

const plain = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('responsive TUI layout', () => {
  it('leaves the list visible around the popup at normal and small sizes', () => {
    for (const [columns, rows] of [[80, 20], [120, 24], [160, 40], [40, 12]] as const) {
      const size = popupSize({ columns, rows });
      assert.ok(size.columns <= columns * 0.75);
      assert.ok(size.rows <= rows * 0.6);
      assert.ok(size.columns >= 16 && size.rows >= 4);
    }
  });

  it('keeps removal scope complete rather than clipping hidden or forced counts', () => {
    for (const columns of [40, 80, 120]) {
      const lines = selectionScopeLines({ columns, selected: 12, hidden: 7, forced: 4, deleteBranch: true });
      const text = plain(lines.join('\n'));
      for (const label of ['delete branches: ON', '12 selected', '7 hidden by filter', '4 forced']) {
        assert.ok(text.includes(label), text);
      }
      assert.ok(lines.every((line) => visibleWidth(line) <= columns));
    }
  });

  it('keeps essential keys, contextual force/review and whole legend labels within the available width', () => {
    const focused = makeWorktree({ dirty: true, unpushed: true, locked: true });
    for (const [columns, rows] of [[20, 10], [40, 12], [80, 20], [120, 24], [160, 40]] as const) {
      const footer = listFooter({ columns, rows, worktrees: [focused], focused,
        marker: '[-]', forceable: true, reviewCount: 3 });
      const shortcuts = plain(footer.shortcuts);
      for (const key of ['o open', '? help', 'q']) assert.ok(shortcuts.includes(key), shortcuts);
      if (columns >= 40) assert.ok(shortcuts.includes('f force'), shortcuts);
      if (columns >= 80) assert.ok(shortcuts.includes('d review (3)'), shortcuts);
      assert.ok([footer.shortcuts, ...footer.legend].every((line) => visibleWidth(line) <= columns));
      assert.ok(plain(footer.legend.join('\n')).includes('[-] blocked'), footer.legend.join('\n'));
      assert.ok(footer.legend.length <= (rows < 20 ? 1 : 2));
    }
  });

  it('expands the legend only when both dimensions have room', () => {
    const focused = makeWorktree({ isMain: true, isCurrent: true });
    const footer = (rows: number) => listFooter({ columns: 160, rows, worktrees: [focused], focused,
      marker: '[-]', forceable: false, reviewCount: 0 });
    const expanded = plain(footer(40).legend.join('\n'));
    for (const label of ['[x] selected', '[!] force selected', 'M main', '@ current', '* dirty', 'L locked', 'P prunable', 'path: · default']) {
      assert.ok(expanded.includes(label), expanded);
    }
    assert.ok(!plain(footer(12).legend.join('\n')).includes('* dirty'));
    assert.ok(plain(footer(12).legend.join('\n')).includes('[-] protected'));
  });
});
