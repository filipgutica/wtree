import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { RemovalResult } from '../src/clean.js';
import { osc52, pagedWindow, restoreHint } from '../src/tui.js';

describe('pagedWindow', () => {
  it('fills the body and reaches its last line on short and normal terminals', () => {
    const content = Array.from({ length: 30 }, (_, index) => index);
    for (const rows of [4, 12, 24]) {
      const first = pagedWindow({ rows, contentLength: content.length, scroll: 0 });
      assert.equal(content.slice(first.start, first.end).length, rows - 2);
      const last = pagedWindow({ rows, contentLength: content.length, scroll: 100 });
      assert.equal(last.start, last.maxScroll);
      assert.equal(content.slice(last.start, last.end).at(-1), 29);
    }
  });
});

const removal = (overrides: Partial<RemovalResult> = {}): RemovalResult => ({
  path: '/tmp/repo/wt',
  branch: 'feature/x',
  removed: true,
  branchDeleted: false,
  error: null,
  branchError: null,
  note: null,
  ...overrides,
});

describe('restoreHint', () => {
  it('offers to recreate a removed worktree whose branch survived', () => {
    assert.equal(restoreHint(removal()), 'restore: wtree new feature/x');
  });

  it('says nothing when the branch was deleted, the removal failed, or there was no branch', () => {
    assert.equal(restoreHint(removal({ branchDeleted: true })), null);
    assert.equal(restoreHint(removal({ removed: false, error: 'boom' })), null);
    assert.equal(restoreHint(removal({ branch: null })), null);
  });
});

describe('osc52', () => {
  it('frames the clipboard request and encodes the text as UTF-8 base64', () => {
    const path = '/Users/zoë/código/wt';
    const out = osc52(path);
    const match = /^\u001b\]52;c;([A-Za-z0-9+/=]+)\u0007$/.exec(out);
    assert.ok(match, 'expected ESC ] 52 ; c ; <base64> BEL');
    assert.equal(Buffer.from(match[1] ?? '', 'base64').toString('utf8'), path);
  });
});
