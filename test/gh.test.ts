import { describe, it, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPrIndex, prFor, type PrIndex } from '../src/gh.js';
import type { PrInfo } from '../src/types.js';

const found: PrInfo = {
  status: 'found',
  number: 42,
  state: 'MERGED',
  title: 'do the thing',
  url: 'https://github.com/o/r/pull/42',
  mergedAt: '2026-01-02T03:04:05Z',
  closedAt: '2026-01-02T03:04:05Z',
  updatedAt: '2026-01-02T03:04:05Z',
  isCrossRepository: false,
};

const index = (entries: [string, PrInfo][], truncated = false): PrIndex => ({
  available: true,
  byBranch: new Map(entries),
  fromCache: false,
  truncated,
});

const ghPr = { ...found, status: undefined, headRefName: 'feature/reused' };

const ghFixture = async ({ t, script }: { t: TestContext; script: string }) => {
  const root = await mkdtemp(join(tmpdir(), 'wtree-pr-'));
  const bin = join(root, 'bin');
  const calls = join(root, 'calls');
  const originalPath = process.env['PATH'];
  const originalCache = process.env['XDG_CACHE_HOME'];
  t.after(async () => {
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
    if (originalCache === undefined) delete process.env['XDG_CACHE_HOME'];
    else process.env['XDG_CACHE_HOME'] = originalCache;
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(bin);
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const { appendFileSync } = require('node:fs');
appendFileSync(${JSON.stringify(calls)}, 'request\\n');
const args = process.argv.slice(2);
${script}
`, { mode: 0o755 });
  process.env['PATH'] = `${bin}:${originalPath ?? ''}`;
  process.env['XDG_CACHE_HOME'] = join(root, 'cache');
  return { calls, options: { cwd: root, commonDir: join(root, '.git'),
    remoteUrl: 'https://github.com/o/r.git', branches: ['feature/reused'] } };
};

describe('loadPrIndex', () => {
  it('resolves current branches in one request, prefers same-repo PRs, and reuses the cache', async (t) => {
    const response = { data: { repository: {
      b0: { nodes: [
        { ...ghPr, number: 99, isCrossRepository: true },
        { ...ghPr, number: 41 }, ghPr,
      ], pageInfo: { hasNextPage: false } },
      b1: { nodes: [], pageInfo: { hasNextPage: false } },
    } } };
    const fixture = await ghFixture({ t, script: `
const pr = ${JSON.stringify(ghPr)};
const legacy = args.includes('--head')
  ? (args[args.indexOf('--head') + 1] === 'feature/reused' ? [pr] : [])
  : Array.from({ length: 500 }, (_, i) => ({ ...pr, number: 1000 + i, headRefName: 'unrelated' }));
console.log(JSON.stringify(args[0] === 'api' ? ${JSON.stringify(response)} : legacy));
` });
    const options = { ...fixture.options, branches: ['feature/reused', 'no-pr', 'feature/reused'] };
    const fresh = await loadPrIndex(options);
    assert.deepEqual(prFor(fresh, 'feature/reused'), found);
    assert.deepEqual(prFor(fresh, 'no-pr'), { status: 'none' });
    assert.deepEqual(prFor(fresh, null), { status: 'none' });
    const cached = await loadPrIndex(options);
    assert.ok(cached.available && cached.fromCache);
    assert.deepEqual(prFor(cached, 'feature/reused'), found);
    assert.equal((await readFile(fixture.calls, 'utf8')).trim().split('\n').length, 1);
  });

  it('reports unknown for failed or incomplete responses instead of inventing absence', async (t) => {
    const empty = { nodes: [], pageInfo: { hasNextPage: false } };
    for (const [name, output, code] of [
      ['command failure', JSON.stringify({ data: { repository: { b0: empty } } }), 1],
      ['invalid JSON', 'not JSON', 0],
      ['missing repository', JSON.stringify({ data: { repository: null } }), 0],
      ['missing branch', JSON.stringify({ data: { repository: {} } }), 0],
      ['invalid PR', JSON.stringify({ data: { repository: { b0: { ...empty, nodes: [{ ...ghPr, number: '42' }] } } } }), 0],
      ['wrong branch', JSON.stringify({ data: { repository: { b0: { ...empty, nodes: [{ ...ghPr, headRefName: 'other' }] } } } }), 0],
      ['GraphQL errors', JSON.stringify({ errors: [{ message: 'lookup failed' }], data: { repository: { b0: empty } } }), 0],
    ] as const) {
      await t.test(name, async (t) => {
        const fixture = await ghFixture({ t, script: `console.log(${JSON.stringify(output)}); process.exitCode = ${code};` });
        const result = await loadPrIndex(fixture.options);
        assert.equal(prFor(result, 'feature/reused').status, 'unknown');
      });
    }
  });

  it('falls back for a paginated branch history rather than choosing an incomplete fork-only result', async (t) => {
    const response = { data: { repository: { b0: {
      nodes: Array.from({ length: 100 }, (_, i) => ({ ...ghPr, number: 1000 + i, isCrossRepository: true })),
      pageInfo: { hasNextPage: true },
    } } } };
    const fixture = await ghFixture({ t, script: `
console.log(JSON.stringify(args[0] === 'api' ? ${JSON.stringify(response)} : [${JSON.stringify(ghPr)}]));
` });
    const result = await loadPrIndex(fixture.options);
    assert.deepEqual(prFor(result, 'feature/reused'), found);
  });

  it('preserves custom bulk limits and leaves failed targeted lookups unknown', async (t) => {
    const fixture = await ghFixture({ t, script: `
if (args[0] === 'api' || args.includes('--head')) { console.error('lookup failed'); process.exitCode = 1; }
else console.log(JSON.stringify([${JSON.stringify(ghPr)}]));
` });
    const result = await loadPrIndex({ ...fixture.options, branches: ['feature/reused', 'unchecked'], limit: 1 });
    assert.deepEqual(prFor(result, 'feature/reused'), found);
    assert.equal(prFor(result, 'unchecked').status, 'unknown');
  });
});

describe('prFor', () => {
  it('returns unknown with the reason when the index is unavailable', () => {
    const result = prFor({ available: false, reason: 'gh: not authenticated' }, 'feat/x');
    assert.deepEqual(result, { status: 'unknown', reason: 'gh: not authenticated' });
  });

  it('returns none for a worktree with no branch', () => {
    assert.deepEqual(prFor(index([]), null), { status: 'none' });
  });

  it('returns the PR when the branch was resolved', () => {
    assert.deepEqual(prFor(index([['feat/x', found]]), 'feat/x'), found);
  });

  it('returns none when the branch was asked about and has no PR', () => {
    const result = prFor(index([['feat/x', { status: 'none' }]]), 'feat/x');
    assert.deepEqual(result, { status: 'none' });
  });

  // The important one: a branch missing from the map was never answered for.
  // Reporting it as `none` would let `clean --pr-state merged` skip real work,
  // and would let a "no PR" filter delete a worktree whose PR is still open.
  it('returns unknown, never none, for a branch that was never resolved', () => {
    const result = prFor(index([['other', found]], true), 'feat/never-asked');
    assert.equal(result.status, 'unknown');
    assert.match(
      result.status === 'unknown' ? result.reason : '',
      /truncated/,
    );
  });
});
