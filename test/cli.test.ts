import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';

let root: string;
let home: string;
let main: string;

const PROJECT = resolve(import.meta.dirname, '..');

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

// --no-pr keeps these tests off the network; spawned stdio is never a TTY.
const runCli = (args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '-C', main, '--no-pr', ...args], {
    cwd: PROJECT,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

const addWorktree = (branch: string, dir: string): string => {
  const path = join(root, dir);
  git(['worktree', 'add', '-q', '-b', branch, path], main);
  return path;
};

describe('cli', () => {
  before(() => {
    // git reports real paths, and on macOS /tmp is a symlink to /private/tmp.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wtree-cli-')));
    home = join(root, 'home');
    mkdirSync(home);
    main = join(root, 'api');
    git(['init', '-q', '-b', 'main', 'api'], root);
    git(['config', 'user.email', 't@t'], main);
    git(['config', 'user.name', 't'], main);
    writeFileSync(join(main, 'a.txt'), 'a');
    git(['add', '.'], main);
    git(['commit', '-qm', 'init'], main);
  });

  after(() => rmSync(root, { recursive: true, force: true }));

  it('prints full default-location paths when list output is piped, including JSON', () => {
    const created = runCli(['new', 'piped-path']);
    assert.equal(created.status, 0, created.stderr);
    const path = created.stdout.trim();
    const listed = runCli(['list', '--branch', 'piped-path']);
    assert.equal(listed.status, 0, listed.stderr);
    assert.ok(listed.stdout.includes(path), listed.stdout);
    assert.equal(listed.stdout.includes('·'), false);
    const json = runCli(['list', '--branch', 'piped-path', '--json']);
    assert.equal(json.status, 0, json.stderr);
    const data: unknown = JSON.parse(json.stdout);
    assert.ok(Array.isArray(data));
    const entry: unknown = data[0];
    assert.ok(typeof entry === 'object' && entry !== null && 'path' in entry);
    assert.equal(entry.path, path);
  });

  it('opens a local branch named origin/topic without changing its name', () => {
    git(['branch', 'origin/topic'], main);
    const picked = runCli(['go', 'origin/topic', '--no-fetch']);
    assert.equal(picked.status, 0, picked.stderr);
    assert.equal(git(['branch', '--show-current'], picked.stdout.trim()).trim(), 'origin/topic');
  });

  describe('--done', () => {
    it('fails closed with exit 3 when PR state is unavailable', () => {
      const res = runCli(['clean', '--done', '--dry-run']);
      assert.equal(res.status, 3, res.stderr);
      assert.match(res.stderr, /cannot filter on PR state/);
    });

    it('cannot be combined with --pr-state', () => {
      for (const cmd of ['clean', 'list']) {
        const res = runCli([cmd, '--done', '--pr-state', 'merged']);
        assert.equal(res.status, 2, `${cmd}: ${res.stderr}`);
        assert.match(res.stderr, /--done/);
      }
    });
  });

  describe('clean without a filter', () => {
    it('still refuses when there is no terminal', () => {
      const res = runCli(['clean']);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /refusing to act on every worktree/);
    });
  });

  describe('ui', () => {
    it('exits 2 with nothing on stdout when there is no terminal', () => {
      const res = runCli(['ui']);
      assert.equal(res.status, 2);
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /interactive terminal/);
    });
  });

  describe('rm', () => {
    it('removes an exact branch match with --yes and suggests how to restore it', () => {
      const path = addWorktree('feat/exact', 'exact');
      const res = runCli(['rm', 'feat/exact', '--yes']);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(existsSync(path), false);
      assert.match(res.stdout, /removed .*exact/);
      assert.match(res.stdout, /restore: wtree new feat\/exact/);
    });

    it('matches a relative path against -C, not the process cwd', () => {
      const path = addWorktree('by-path', 'by-path');
      const res = runCli(['rm', '../by-path', '-y']);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(existsSync(path), false);
    });

    it('refuses a substring, lists close matches, and removes nothing', () => {
      const keep = addWorktree('feat/substring', 'substring');
      const other = addWorktree('other', 'other');
      const res = runCli(['rm', 'other', 'substr', '--yes']);
      assert.equal(res.status, 2);
      assert.match(res.stderr, /exact branch or path "substr"/);
      assert.match(res.stderr, /feat\/substring/);
      assert.match(res.stderr, /nothing was removed/);
      assert.equal(existsSync(keep), true);
      assert.equal(existsSync(other), true, 'a valid name must not be removed when another fails');
    });

    it('skips a dirty worktree unless --force', () => {
      const path = addWorktree('dirty', 'dirty');
      writeFileSync(join(path, 'junk.txt'), 'junk');

      const blocked = runCli(['rm', 'dirty', '--yes']);
      assert.equal(blocked.status, 0, blocked.stderr);
      assert.equal(existsSync(path), true);
      assert.match(blocked.stdout, /uncommitted changes \(--force to override\)/);

      const forced = runCli(['rm', 'dirty', '-y', '-f']);
      assert.equal(forced.status, 0, forced.stderr);
      assert.equal(existsSync(path), false);
    });

    it('removes what it can and explains each skip after --yes', () => {
      const clean = addWorktree('clean-x', 'clean-x');
      const dirty = addWorktree('dirty-y', 'dirty-y');
      writeFileSync(join(dirty, 'junk.txt'), 'junk');

      const res = runCli(['rm', 'clean-x', 'dirty-y', '-y']);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(existsSync(clean), false);
      assert.equal(existsSync(dirty), true);
      assert.match(res.stdout, /skipped .*dirty-y: uncommitted changes \(--force to override\)/);
      assert.match(res.stdout, /restore: wtree new clean-x/);
    });

    it('never removes the main worktree', () => {
      const res = runCli(['rm', 'main', '-y', '-f']);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(existsSync(main), true);
      assert.match(res.stdout, /main worktree/);
    });

    it('prints the plan as JSON on a dry run', () => {
      addWorktree('json-me', 'json-me');
      const res = runCli(['rm', 'json-me', '-n', '-j']);
      assert.equal(res.status, 0, res.stderr);
      const out: unknown = JSON.parse(res.stdout);
      assert.ok(typeof out === 'object' && out !== null && 'dryRun' in out && out.dryRun === true);
    });
  });

  describe('shell-init', () => {
    it('ends the cd branch with status 0 when nothing was printed', () => {
      const res = runCli(['shell-init', 'zsh']);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /if \[ -n "\$p" \]; then cd "\$p"; fi/);
    });
  });
});
