import { execFile, spawn } from 'node:child_process';

export interface RunResult {
  ok: boolean;
  code: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  timeoutMs?: number;
  maxBuffer?: number;
  env?: NodeJS.ProcessEnv;
}

/**
 * Run a command and capture its output. Never throws: a non-zero exit, a missing
 * binary, and a timeout all come back as `ok: false` so callers can degrade.
 */
export const run = ({
  cmd,
  args,
  cwd,
  timeoutMs = 20_000,
  maxBuffer = 32 * 1024 * 1024,
  env,
}: RunOptions & { cmd: string; args: string[] }): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { cwd, timeout: timeoutMs, maxBuffer, encoding: 'utf8', env },
      (error, stdout, stderr) => {
        const code =
          error && typeof (error as NodeJS.ErrnoException & { code?: number }).code === 'number'
            ? ((error as unknown as { code: number }).code)
            : error
              ? 1
              : 0;
        resolve({ ok: !error, code, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });

/**
 * Run a command with `input` piped to its stdin, capture stdout, and let it
 * share our stderr. Built for fzf, which draws its UI on /dev/tty itself.
 * Never throws: a missing binary comes back as code 127.
 */
export const runWithInput = ({
  cmd,
  args,
  input,
  cwd,
}: {
  cmd: string;
  args: string[];
  input: string;
  cwd?: string;
}): Promise<{ code: number; stdout: string }> =>
  new Promise((resolve) => {
    let settled = false;
    let stdout = '';
    const finish = (code: number): void => {
      if (settled) return;
      settled = true;
      resolve({ code, stdout });
    };
    const child = spawn(cmd, args, { cwd, stdio: ['pipe', 'pipe', 'inherit'] });
    child.on('error', (error: NodeJS.ErrnoException) => finish(error.code === 'ENOENT' ? 127 : 1));
    child.on('close', (code, signal) => finish(code ?? (signal ? 128 : 1)));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    // EPIPE when the child exits (or never started) before reading everything.
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });

export const git = (args: string[], cwd?: string): Promise<RunResult> =>
  run({ cmd: 'git', args, cwd });

/** Run tasks with a bounded number in flight, preserving input order in the result. */
export const mapLimit = async <T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> => {
  const results = new Array<R>(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      const item = items[index];
      if (index >= items.length || item === undefined) return;
      results[index] = await fn(item, index);
    }
  });
  await Promise.all(workers);
  return results;
};
