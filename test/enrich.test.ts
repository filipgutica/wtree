import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { it } from 'node:test';
import { collect } from '../src/enrich.js';
import { getRepoContext } from '../src/git.js';

it('collects local state while PRs load and returns both complete results', async (t) => {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'wtree-collect-')));
  const bin = join(root, 'bin');
  const main = join(root, 'main');
  const marker = join(root, 'status-started');
  const originalPath = process.env['PATH'];
  const originalCache = process.env['XDG_CACHE_HOME'];
  t.after(async () => {
    if (originalPath === undefined) delete process.env['PATH'];
    else process.env['PATH'] = originalPath;
    if (originalCache === undefined) delete process.env['XDG_CACHE_HOME'];
    else process.env['XDG_CACHE_HOME'] = originalCache;
    await rm(root, { recursive: true, force: true });
  });

  const realGit = execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
  const git = (args: string[], cwd = main): string =>
    execFileSync(realGit, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  await mkdir(bin);
  git(['init', '-q', '-b', 'main', main], root);
  git(['config', 'user.name', 'test']);
  git(['config', 'user.email', 'test@example.com']);
  await writeFile(join(main, 'tracked'), 'tracked');
  git(['add', '.']);
  git(['commit', '-qm', 'initial']);
  await writeFile(join(main, 'untracked'), 'keep me');
  const repo = { ...await getRepoContext(main), remoteUrl: 'https://github.com/o/r.git' };
  const pr = { number: 42, state: 'OPEN', title: 'main PR', url: 'https://github.com/o/r/pull/42',
    headRefName: 'main', mergedAt: null, closedAt: null, updatedAt: '2026-01-01T00:00:00Z',
    isCrossRepository: false };
  await writeFile(join(bin, 'git'), `#!${process.execPath}
const { writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
if (process.argv[2] === 'status') writeFileSync(${JSON.stringify(marker)}, 'started');
const result = spawnSync(${JSON.stringify(realGit)}, process.argv.slice(2), { stdio: 'inherit' });
process.exit(result.status ?? 1);
`, { mode: 0o755 });
  await writeFile(join(bin, 'gh'), `#!${process.execPath}
const { existsSync } = require('node:fs');
const deadline = Date.now() + 3000;
const wait = () => {
  if (existsSync(${JSON.stringify(marker)})) {
    const pr = ${JSON.stringify(pr)};
    console.log(JSON.stringify(process.argv[2] === 'api'
      ? { data: { repository: { b0: { nodes: [pr], pageInfo: { hasNextPage: false } } } } }
      : [pr]));
  } else if (Date.now() < deadline) setTimeout(wait, 10);
  else { console.error('local Git checks did not start while PRs were loading'); process.exitCode = 1; }
};
wait();
`, { mode: 0o755 });
  process.env['PATH'] = `${bin}:${originalPath ?? ''}`;
  process.env['XDG_CACHE_HOME'] = join(root, 'cache');

  const collection = await collect({ cwd: main, repo });
  assert.equal(collection.worktrees.length, 1);
  const wt = collection.worktrees[0];
  assert.ok(wt);
  assert.equal(wt.branch, 'main');
  assert.equal(wt.dirty, true, 'untracked files must still count as dirty');
  assert.equal(wt.isMain, true);
  assert.equal(wt.isCurrent, true);
  assert.equal(wt.unpushed, null);
  assert.equal(wt.mergedIntoDefault, true);
  assert.equal(wt.pr.status, 'found', 'PR loading must overlap local checks and finish before returning');
  if (wt.pr.status === 'found') assert.equal(wt.pr.number, 42);
});
