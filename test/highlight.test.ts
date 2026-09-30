import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { highlightRow, paint, visibleWidth } from '../src/render.js';

const BACKGROUND = '[100m';
const RESET = '[0m';

describe('highlightRow', () => {
  it('returns the row untouched when colour is off', () => {
    assert.equal(highlightRow('row', 40, false), 'row');
  });

  it('pads to the full width so the highlight reaches the right edge', () => {
    const out = highlightRow('ab', 10, true);
    assert.equal(visibleWidth(out), 10);
    assert.ok(out.startsWith(BACKGROUND));
    assert.ok(out.endsWith(RESET));
  });

  it('keeps coloured markers readable on one continuous selection background', () => {
    const row = `${paint('[x]', 'red', true)} ${paint('M@', 'blue', true)} /repo/main`;
    const out = highlightRow(row, 24, true);
    assert.ok(out.startsWith(BACKGROUND));
    assert.match(out, /\u001b\[31m\[x\]/);
    assert.match(out, /\u001b\[34mM@/);
    assert.ok(out.includes(`${RESET}${BACKGROUND}`));
    assert.equal(visibleWidth(out), 24);
    assert.equal(out.replace(/\u001b\[[0-9;]*m/g, ''), '[x] M@ /repo/main       ');
  });

  it('does not pad a row already at or over the width', () => {
    const out = highlightRow('abcdefghij', 5, true);
    assert.equal(visibleWidth(out), 10);
  });
});
