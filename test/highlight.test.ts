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

  it('uses one uniform highlight while preserving markers and text', () => {
    const row = `${paint('[x]', 'red', true)} ${paint('M@', 'blue', true)} /repo/main`;
    assert.equal(
      highlightRow(row, 24, true),
      `${REVERSE}[x] M@ /repo/main       ${RESET}`,
    );
  });

  it('does not pad a row already at or over the width', () => {
    const out = highlightRow('abcdefghij', 5, true);
    assert.equal(visibleWidth(out), 10);
  });
});
