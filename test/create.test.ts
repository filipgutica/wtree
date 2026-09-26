import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { after, before, describe, it } from 'node:test';
import {
  CreateError,
  createWorktree,
  defaultWorktreePath,
  isDefaultLocation,
} from '../src/create.js';
import { loadCandidates } from '../src/pick.js';

let root: string;
let home: string;
let main: string;
let savedHome: string | undefined;

const PROJECT = resolve(import.meta.dirname, '..');

const git = (args: string[], cwd: string): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

const upstreamOf = (branch: string, cwd: string): string | null => {
  try {
    return git(['rev-parse', '--abbrev-ref', `${branch}@{upstream}`], cwd).trim();
  } catch {
    return null;
  }
};

const runCli = (args: string[]) =>
  spawnSync(process.execPath, ['--import', 'tsx', 'src/cli.ts', '-C', main, ...args], {
    cwd: PROJECT,
    encoding: 'utf8',
    env: { ...process.env, HOME: home, NO_COLOR: '1' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

describe('createWorktree', () => {
  before(() => {
    // git reports real paths, and on macOS /tmp is a symlink to /private/tmp.
    root = realpathSync(mkdtempSync(join(tmpdir(), 'wtree-create-')));
    home = join(root, 'home');
    mkdirSync(home);
    savedHome = process.env.HOME;
    process.env.HOME = home;

    git(['init', '-q', '--bare', '-b', 'main', 'origin.git'], root);
    git(['clone', '-q', join(root, 'origin.git'), 'api'], root);
    main = join(root, 'api');
    git(['config', 'user.email', 't@t'], main);
    git(['config', 'user.name', 't'], main);
    git(['checkout', '-q', '-b', 'main'], main);
    writeFileSync(join(main, 'a.txt'), 'a');
    git(['add', '.'], main);
    git(['commit', '-qm', 'init'], main);
    git(['push', '-q', '-u', 'origin', 'main'], main);
    git(['remote', 'set-head', 'origin', 'main'], main);

    // A branch that exists only on the remote.
    git(['push', '-q', 'origin', 'main:remote-only'], main);
    git(['push', '-q', 'origin', 'main:fetch-me'], main);
    git(['branch', '-q', '-D', '-r', 'origin/remote-only'], main);
    git(['branch', '-q', '-D', '-r', 'origin/fetch-me'], main);
    git(['fetch', '-q', 'origin', '+refs/heads/remote-only:refs/remotes/origin/remote-only'], main);
    git(['branch', '-q', 'local-one'], main);
  });

  after(() => {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(root, { recursive: true, force: true });
  });

  it('builds the default path from the main worktree name and the branch', () => {
    assert.equal(
      defaultWorktreePath({ mainPath: '/src/api', branch: 'feat/foo' }),
      join(home, '.wtree', 'api', 'feat', 'foo'),
    );
    assert.equal(
      isDefaultLocation({
        path: join(home, '.wtree', 'api', 'feat', 'foo'),
        mainPath: '/src/api',
        branch: 'feat/foo',
      }),
      true,
    );
    assert.equal(
      isDefaultLocation({ path: '/elsewhere/foo', mainPath: '/src/api', branch: 'feat/foo' }),
      false,
    );
  });

  it('recognises the default location when $HOME is a symlink', () => {
    const link = join(root, 'home-link');
    symlinkSync(home, link);
    process.env.HOME = link;
    try {
      // git reports the real path, not the one through the symlink.
      assert.equal(
        isDefaultLocation({
          path: join(home, '.wtree', 'api', 'feat', 'foo'),
          mainPath: '/src/api',
          branch: 'feat/foo',
        }),
        true,
      );
    } finally {
      process.env.HOME = home;
    }
  });

  it('checks out an existing local branch', async () => {
    const res = await createWorktree({ cwd: main, branch: 'local-one', fetch: false });
    assert.equal(res.created, true);
    assert.equal(res.path, join(home, '.wtree', 'api', 'local-one'));
    assert.equal(git(['branch', '--show-current'], res.path).trim(), 'local-one');
  });

  it('checks out a branch that only exists on origin and tracks it', async () => {
    const res = await createWorktree({ cwd: main, branch: 'remote-only', fetch: false });
    assert.equal(res.created, true);
    assert.equal(upstreamOf('remote-only', main), 'origin/remote-only');
  });

  it('fetches a branch missing locally before falling back to the base', async () => {
    const res = await createWorktree({ cwd: main, branch: 'fetch-me', fetch: true });
    assert.equal(res.created, true);
    assert.deepEqual(res.warnings, []);
    assert.equal(upstreamOf('fetch-me', main), 'origin/fetch-me');
  });

  it('branches a new name off the default branch with no upstream', async () => {
    const res = await createWorktree({ cwd: main, branch: 'brand-new', fetch: true });
    assert.equal(res.created, true);
    assert.deepEqual(res.warnings, [], 'a missing remote ref is not a warning');
    assert.equal(upstreamOf('brand-new', main), null);
    assert.equal(
      git(['rev-parse', 'brand-new'], main).trim(),
      git(['rev-parse', 'origin/main'], main).trim(),
    );
  });

  it('returns the existing worktree when the branch is already checked out', async () => {
    const res = await createWorktree({ cwd: main, branch: 'main', fetch: false });
    assert.equal(res.created, false);
    assert.equal(res.path, main);
  });

  it('refuses when the target directory already exists', async () => {
    mkdirSync(join(home, '.wtree', 'api', 'taken'), { recursive: true });
    await assert.rejects(
      createWorktree({ cwd: main, branch: 'taken', fetch: false }),
      (error: unknown) => error instanceof CreateError && /already exists/.test(error.message),
    );
  });

  it('rejects an invalid branch name', async () => {
    await assert.rejects(
      createWorktree({ cwd: main, branch: '../escape', fetch: false }),
      CreateError,
    );
  });

  it('names the path after the main worktree when run from a linked one', async () => {
    const linked = join(root, 'linked-elsewhere');
    git(['worktree', 'add', '-q', '-b', 'linked', linked], main);
    const res = await createWorktree({ cwd: linked, branch: 'from-linked', fetch: false });
    assert.equal(res.path, join(home, '.wtree', 'api', 'from-linked'));
  });

  it('nests slash separated branch names', async () => {
    const res = await createWorktree({ cwd: main, branch: 'feat/foo', fetch: false });
    assert.equal(res.path, join(home, '.wtree', 'api', 'feat', 'foo'));
    assert.ok(existsSync(join(res.path, 'a.txt')));
  });

  it('warns and falls back to the base when the remote is unreachable', async () => {
    git(['remote', 'set-url', 'origin', join(root, 'gone.git')], main);
    try {
      const res = await createWorktree({ cwd: main, branch: 'offline', fetch: true });
      assert.equal(res.created, true);
      assert.equal(res.warnings.length, 1);
      assert.match(res.warnings[0] ?? '', /^fetch failed: .*; branching off origin\/main$/);
    } finally {
      git(['remote', 'set-url', 'origin', join(root, 'origin.git')], main);
    }
  });

  describe('cli', () => {
    it('new prints exactly the path on stdout', () => {
      const res = runCli(['new', 'cli-new', '--no-fetch']);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, `${join(home, '.wtree', 'api', 'cli-new')}\n`);
    });

    it('new on a branch with a worktree prints its path and notes it on stderr', () => {
      const res = runCli(['new', 'main', '--no-fetch']);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, `${main}\n`);
      assert.match(res.stderr, /already/);
    });

    it('path resolves an exact branch', () => {
      const res = runCli(['path', 'main']);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, `${main}\n`);
    });

    it('path exits 1 with empty stdout when nothing matches', () => {
      const res = runCli(['path', 'zzz-no-such']);
      assert.equal(res.status, 1);
      assert.equal(res.stdout, '');
    });

    it('path exits 2 and lists candidates when ambiguous', () => {
      // Every worktree created above has an "o" in its branch or path.
      const res = runCli(['path', 'o']);
      assert.equal(res.status, 2);
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /local-one/);
    });

    it('go with an exact branch prints its path without a picker', () => {
      const res = runCli(['go', 'main']);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, `${main}\n`);
    });

    it('go with an exact branch that has no worktree creates one', () => {
      git(['branch', '-q', 'go-target'], main);
      const res = runCli(['go', 'go-target', '--no-fetch']);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, `${join(home, '.wtree', 'api', 'go-target')}\n`);
    });

    it('refuses a worktree whose directory is gone instead of printing it', async () => {
      const path = (await createWorktree({ cwd: main, branch: 'stale-one', fetch: false })).path;
      rmSync(path, { recursive: true, force: true });
      await assert.rejects(
        createWorktree({ cwd: main, branch: 'stale-one', fetch: false }),
        (error: unknown) => error instanceof CreateError && /wtree prune/.test(error.message),
      );
      for (const args of [['go', 'stale-one'], ['path', 'stale-one']]) {
        const res = runCli(args);
        assert.notEqual(res.status, 0);
        assert.equal(res.stdout, '');
        assert.match(res.stderr, /wtree prune/);
      }
    });

    it('go offers only local and origin branches', async () => {
      git(['remote', 'add', 'upstream', join(root, 'origin.git')], main);
      git(['fetch', '-q', 'upstream'], main);
      const labels = (await loadCandidates(main)).map((c) => c.label);
      assert.ok(labels.includes('remote-only'));
      assert.ok(!labels.some((l) => l.startsWith('upstream/')), labels.join(', '));
    });

    it('go refuses to open a picker when stdin is not a terminal', () => {
      const res = runCli(['go', 'no-such-exact-name']);
      assert.equal(res.status, 2);
      assert.equal(res.stdout, '');
      assert.match(res.stderr, /interactive terminal/);
    });

    it('path resolves a relative path against -C', async () => {
      const path = (await createWorktree({ cwd: main, branch: 'rel-one', fetch: false })).path;
      const res = runCli(['path', relative(main, path)]);
      assert.equal(res.status, 0, res.stderr);
      assert.equal(res.stdout, `${path}\n`);
    });

    it('shell-init prints the wrapper', () => {
      const res = runCli(['shell-init', 'bash']);
      assert.equal(res.status, 0, res.stderr);
      assert.match(res.stdout, /^wt\(\) \{\n/);
      assert.match(res.stdout, /new\|go\|path\|ui\)/);
    });
  });
});
