import { execFile } from 'node:child_process';

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
