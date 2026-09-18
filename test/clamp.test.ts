import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { clampAnsi, paint, visibleWidth } from '../src/render.js';

const RESET = '[0m';

describe('clampAnsi', () => {
  it('leaves a short line alone', () => {
    assert.equal(clampAnsi('hello', 20), 'hello');
  });

  it('leaves a line of exactly the width alone', () => {
    assert.equal(clampAnsi('12345', 5), '12345');
  });

  it('cuts to the width, counting the ellipsis', () => {
    const out = clampAnsi('abcdefghij', 5);
    assert.equal(out, 'abcd…');
    assert.equal(visibleWidth(out), 5);
  });

  // Escape sequences take no columns. A coloured line must clamp to the same
  // visible width as a plain one, and must not be cut mid-sequence.
  it('does not count ANSI sequences toward the width', () => {
    const coloured = `${paint('abcdefghij', 'red', true)} tail`;
    const out = clampAnsi(coloured, 5);
    assert.equal(visibleWidth(out), 5);
    assert.ok(out.endsWith(RESET), 'must reset colour at the cut');
  });

  it('returns nothing for a non-positive width', () => {
    assert.equal(clampAnsi('abc', 0), '');
  });

  // The whole point: a line wider than the terminal wraps, costs a second row,
  // and pushes the header and legend off the top of a full-screen view.
  it('never exceeds the width for any prefix length', () => {
    const line = `${paint('branch/name', 'blue', true)}  ${paint('merged', 'magenta', true)}  ~/some/long/path`;
    for (let w = 1; w <= 60; w += 1) {
      assert.ok(
        visibleWidth(clampAnsi(line, w)) <= w,
        `width ${w} produced ${visibleWidth(clampAnsi(line, w))} columns`,
      );
    }
  });
});
