/**
 * Test timing helpers.
 *
 * These functions give the diagnostic test suite a low-overhead way
 * to assert that the critical-path operations stay inside a loose
 * performance envelope. They are intentionally simple: no bench
 * framework, no `tinybench`, no statistical inference. Just warmup +
 * a small fixed number of timed runs, and a median-bound assertion
 * that catches real regressions (2x or worse) without flaking on
 * cold-cache or noisy CI.
 *
 * Design notes:
 *   - Uses `node:perf_hooks` `performance.now()`, which is a
 *     monotonic high-resolution timer independent of the wall clock.
 *     `Date.now()` is NOT used because it can jump backwards when
 *     NTP corrects the system clock.
 *   - Median (not mean) so a single noisy run cannot push the
 *     assertion over the bound.
 *   - `assertMedianUnder` throws a plain `Error` (not a Node assert)
 *     so the caller can use it inside a `node:test` test body or
 *     inside an async helper without coupling to the test
 *     framework's assertion shape.
 */

import { performance } from "node:perf_hooks";

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Run `fn` `warmup` times (no timing), then `runs` timed runs, and
 * assert that the MEDIAN elapsed time is below `maxMs`. Returns
 * the result of the last timed run so callers can also assert on
 * the returned value (e.g. that the controller actually saved a
 * row).
 *
 * Throws an Error with diagnostics if the median exceeds `maxMs`.
 *
 * Use this for performance guard-rails: catches real regressions
 * (2x+) without flaking on cold-cache or noisy CI.
 *
 * Defaults: `warmup: 1`, `runs: 3`. The defaults keep the test
 * fast; bump `runs` to 5 or 7 if a single benchmark is wildly
 * variable on your machine.
 */
export async function assertMedianUnder<T>(
  label: string,
  fn: () => T | Promise<T>,
  maxMs: number,
  opts: { warmup?: number; runs?: number } = {}
): Promise<T> {
  const warmup = opts.warmup ?? 1;
  const runs = opts.runs ?? 3;
  if (warmup < 0) {
    throw new Error(`assertMedianUnder(${label}): warmup must be >= 0, got ${warmup}`);
  }
  if (runs < 1) {
    throw new Error(`assertMedianUnder(${label}): runs must be >= 1, got ${runs}`);
  }

  // Warmup: identical calls, results discarded. Warms V8 inline
  // caches, JIT, and the SQLite page cache.
  let lastResult: T;
  for (let i = 0; i < warmup; i++) {
    lastResult = await fn();
  }

  // Timed runs.
  const elapsed: number[] = new Array(runs);
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    lastResult = await fn();
    elapsed[i] = performance.now() - t0;
  }

  // Median (sort + take middle; if even count, average the two
  // middle values). Robust to a single outlier.
  const sorted = elapsed.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;

  if (median > maxMs) {
    const samples = elapsed.map((e) => e.toFixed(2)).join(", ");
    const message =
      `assertMedianUnder(${label}): median ${median.toFixed(2)}ms ` +
      `exceeds bound ${maxMs}ms (samples ms: [${samples}], ` +
      `warmup=${warmup}, runs=${runs})`;
    throw new Error(message);
  }

  return lastResult!;
}

/**
 * Run `fn` once, measure the elapsed time, and return both the
 * result and the elapsed milliseconds. Does NOT assert; the caller
 * decides what to do with the timing. Useful for benchmark reports
 * and for the measure-only pass that sets the bound before
 * committing `assertMedianUnder` to the suite.
 */
export async function measure<T>(
  fn: () => T | Promise<T>
): Promise<{ result: T; elapsedMs: number }> {
  const t0 = performance.now();
  const result = await fn();
  const elapsedMs = performance.now() - t0;
  return { result, elapsedMs };
}
