import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { highlightRow, paint, visibleWidth } from '../src/render.js';

const REVERSE = '[7m';
const RESET = '[0m';

describe('highlightRow', () => {
  it('returns the row untouched when colour is off', () => {
    assert.equal(highlightRow('row', 40, false), 'row');
  });

  it('pads to the full width so the highlight reaches the right edge', () => {
    const out = highlightRow('ab', 10, true);
    assert.equal(visibleWidth(out), 10);
    assert.ok(out.startsWith(REVERSE));
    assert.ok(out.endsWith(RESET));
  });

  // Each coloured span in a row ends with a full reset, which also clears the
  // reverse attribute. Without re-opening it the highlight stops at the first
  // coloured cell instead of covering the row.
  it('re-opens reverse after every inner reset', () => {
    const row = `${paint('a', 'red', true)} ${paint('b', 'blue', true)} c`;
    const out = highlightRow(row, 20, true);
    const resets = out.split(RESET).length - 1;
    const reverses = out.split(REVERSE).length - 1;
    assert.equal(reverses, resets, 'every reset must be followed by a reverse');
    assert.ok(out.endsWith(RESET), 'the row must not leave reverse set');
  });

  it('does not pad a row already at or over the width', () => {
    const out = highlightRow('abcdefghij', 5, true);
    assert.equal(visibleWidth(out), 10);
  });
});
