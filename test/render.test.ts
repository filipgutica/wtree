import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { formatAge, formatSize } from '../src/render.js';

describe('formatAge', () => {
  it('uses the real boundaries at one day', () => {
    assert.equal(formatAge(0.999), '24h');
    assert.equal(formatAge(1), '1d');
    assert.equal(formatAge(1.001), '1d');
  });

  it('uses the real boundaries at 45 days', () => {
    assert.equal(formatAge(44.99), '45d');
    assert.equal(formatAge(45), '2mo');
    assert.equal(formatAge(45.01), '2mo');
  });

  it('uses the real boundaries at 365 days', () => {
    assert.equal(formatAge(364.99), '12mo');
    assert.equal(formatAge(365), '1.0y');
    assert.equal(formatAge(365.01), '1.0y');
  });

  it('formats an unknown age as a question mark', () => {
    assert.equal(formatAge(null), '?');
  });
});

describe('formatSize', () => {
  it('uses K below 1024, M at the first boundary, and G at the second', () => {
    assert.equal(formatSize(1023), '1023K');
    assert.equal(formatSize(1024), '1M');
    assert.equal(formatSize(1024 * 1024 - 1), '1024M');
    assert.equal(formatSize(1024 * 1024), '1.0G');
  });

  it('formats an unknown size with a dash', () => {
    assert.equal(formatSize(null), '-');
  });
});
