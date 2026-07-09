/**
 * Shared benchmark artifact utilities.
 *
 * The benchmark suite writes JSON report artifacts under
 * `.curion/benchmark/` (configurable per-runner via
 * `--artifacts`). Every runner uses the same timestamped
 * filename pattern so a reviewer can scan the artifact
 * directory and reason about which artifact is which.
 *
 * This module centralises the shared steps:
 *
 *   - `defaultBenchmarkArtifactsDir()` — the safe default
 *     artifact directory (`.curion/benchmark` under cwd).
 *
 *   - `isoStampForFilename(date?)` — the shell-safe ISO
 *     timestamp the filename pattern uses.
 *
 *   - `writeTimestampedJsonArtifact(report, dir, prefix)`
 *     — the canonical "mkdir + ISO-stamp + JSON.stringify"
 *     sequence. Returns the absolute path of the written
 *     file so a runner can echo it to stdout.
 *
 * The helper is a pure extraction: the per-runner report
 * shape, the limitations block, and the human report
 * formatter stay where they are (each runner still owns
 * its own report shape).
 *
 * Safety:
 *
 *   - The directory is created with mode `0o700`
 *     (owner-only read/write/execute). The benchmark
 *     output may carry curated scenario text; the
 *     permission matches the existing runners' policy
 *     of "owner-only for benchmark artifacts".
 *
 *   - The timestamp replaces `:` / `.` so the filename is
 *     safe across shells and tools that choke on colons.
 *
 *   - The helper overwrites any existing file at the
 *     same `<prefix>-<stamp>.json` path. The ISO
 *     timestamp is millisecond-precise; a re-run within
 *     the same millisecond will overwrite the previous
 *     artifact. This matches the behaviour of the
 *     existing inline writers (`fs.writeFileSync` is
 *     the file-write step). A future change that wants
 *     explicit collision detection (e.g. EEXIST) is a
 *     deliberate, visible change.
 */

import fs from "node:fs";
import path from "node:path";

/**
 * Resolve the safe default artifact directory. The
 * directory is `<cwd>/.curion/benchmark`; the `.curion`
 * prefix matches the project's existing on-disk config
 * convention.
 */
export function defaultBenchmarkArtifactsDir(cwd: string = process.cwd()): string {
  return path.join(cwd, ".curion", "benchmark");
}

/**
 * Build a shell-safe filename-safe ISO timestamp. The
 * function replaces `:` / `.` so the resulting filename
 * is portable across shells, Windows paths, and tools
 * that choke on colons.
 *
 * The function takes an optional `Date` for tests; the
 * default is the current time. The shape matches the
 * existing inline writers in
 * `src/benchmark/decision-policy-evaluation.ts` and
 * `src/benchmark/adaptive-depth-evaluation.ts`.
 */
export function isoStampForFilename(date: Date = new Date()): string {
  return date.toISOString().replace(/[:.]/g, "-");
}

/**
 * Write a JSON artifact under `dir` using the
 * `<prefix>-<iso-stamp>.json` filename pattern. The
 * directory is created with owner-only permissions if
 * it does not exist. Returns the absolute path of the
 * written file so a runner can echo it to stdout.
 *
 * The helper is the file-on-disk step only: each runner
 * still owns its own report type and the artifact
 * content. The helper centralises the part every
 * benchmark writer was duplicating.
 *
 * The function preserves the existing behaviour:
 *
 *   - `mkdirSync({ recursive: true, mode: 0o700 })` so
 *     nested `--artifacts /tmp/x/y/z` paths work.
 *
 *   - JSON.stringify with a 2-space indent so the file
 *     is human-diffable in review.
 *
 *   - UTF-8 encoding so non-ASCII scenario labels
 *     round-trip cleanly.
 */
export function writeTimestampedJsonArtifact<T>(report: T, dir: string, prefix: string): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const filename = `${prefix}-${isoStampForFilename()}.json`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, JSON.stringify(report, null, 2), "utf8");
  return full;
}
