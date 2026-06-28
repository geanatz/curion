/**
 * Shared environment helpers.
 *
 * `withCleanEnv` snapshots the listed env vars, deletes them
 * for the duration of `fn`, and restores the snapshot on
 * completion (whether the body resolves or rejects).
 */

/**
 * Run `fn` with `process.env[k]` deleted for every key in
 * `keys`. Restores the original value (or absence) afterwards.
 * Returns whatever `fn` returns / resolves to.
 */
export function withCleanEnv<T>(
  keys: string[],
  fn: () => Promise<T> | T,
): Promise<T> | T {
  const before: Record<string, string | undefined> = {};
  for (const k of keys) before[k] = process.env[k];
  for (const k of keys) delete process.env[k];
  return Promise.resolve(fn()).finally(() => {
    for (const k of keys) {
      const v = before[k];
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });
}