/**
 * Shared benchmark CLI flag parser.
 *
 * The benchmark runners expose a small, narrow CLI surface:
 *
 *   --artifacts <path>   override the artifact directory
 *   --no-write           suppress the JSON artifact (the
 *                        runner still prints the human report)
 *   --no-stdout          suppress the human report on stdout
 *                        (the runner still writes the artifact)
 *
 * The parser is a minimal hand-rolled loop that mirrors
 * the per-runner parsers' style. A flag not recognised is
 * a hard error so a reviewer who misspells a flag gets a
 * clear signal.
 *
 * The runner passes the supported flags via `options` so
 * runners that don't accept `--no-write` / `--no-stdout`
 * (e.g. the adaptive-depth runner) reject them as unknown
 * flags instead of silently accepting them. The contract
 * is "the runner's CLI surface stays narrow; a future flag
 * is a deliberate, visible change".
 *
 * Why a single helper instead of per-runner parsers:
 *
 *   The decision-policy runner and the adaptive-depth
 *   runner had near-identical CLI parsers (both loop over
 *   argv, both default to `.curion/benchmark`, both hard-
 *   error on unknown flags). The only meaningful
 *   difference was the supported flag set and the
 *   "context label" used in the error message. A single
 *   helper with opt-in flag support captures the shared
 *   shape without forcing the adaptive-depth runner to
 *   silently accept `--no-write` / `--no-stdout` it never
 *   implemented.
 */

import { defaultBenchmarkArtifactsDir } from "./_artifact.js";

export interface BenchmarkArtifactCliOptions {
  /**
   * Allow `--no-write`. When false, the flag is treated as
   * an unknown flag (rejected). Defaults to false so the
   * helper is opt-in for the no-write path.
   */
  supportNoWrite?: boolean;
  /**
   * Allow `--no-stdout`. When false, the flag is treated as
   * an unknown flag (rejected). Defaults to false.
   */
  supportNoStdout?: boolean;
  /**
   * Allow `--live`. When false, the flag is treated as an
   * unknown flag (rejected). Defaults to false. The `--live`
   * flag is a deliberate opt-in for benchmarks that support
   * a real-provider mode (e.g. decision-policy evaluation);
   * benchmarks that don't expose a live mode leave it
   * disabled so a misspelled flag surfaces as a clear error.
   */
  supportLive?: boolean;
  /**
   * Override the safe default artifact directory. Defaults
   * to `.curion/benchmark` under cwd. Tests pass this so
   * the parser is hermetic.
   */
  defaultArtifactsDir?: string;
  /**
   * Context label used in the "unknown flag" error message.
   * The existing per-runner error strings were
   * `"unknown <contextLabel> cli flag: ..."`; the helper
   * preserves that shape so the existing tests' regex
   * assertions keep passing.
   *
   * The default is a generic `"benchmark"` label.
   */
  contextLabel?: string;
}

export interface BenchmarkArtifactCliResult {
  artifactsDir: string;
  noWrite: boolean;
  noStdout: boolean;
  /**
   * True iff the caller passed `--live`. Defaults to `false`.
   * The CLI flag is a NECESSARY but NOT SUFFICIENT condition
   * for live mode: callers additionally verify the
   * `CURION_<BENCHMARK>_LIVE=1` env flag before invoking the
   * live path, so a single misspelled / single-passed signal
   * cannot enable live mode by surprise.
   */
  live: boolean;
}

/**
 * Parse the benchmark CLI args. Returns the resolved flag
 * values. Throws on unknown flags or missing values (when
 * `--artifacts` is the last arg).
 *
 * The helper is pure: no I/O, no globals beyond `process.cwd`
 * for the default artifact dir (and even that is overridable
 * via `options.defaultArtifactsDir`).
 */
export function parseBenchmarkArtifactCli(
  argv: ReadonlyArray<string>,
  options: BenchmarkArtifactCliOptions = {}
): BenchmarkArtifactCliResult {
  const artifactsDir = options.defaultArtifactsDir ?? defaultBenchmarkArtifactsDir();
  const supportNoWrite = options.supportNoWrite ?? false;
  const supportNoStdout = options.supportNoStdout ?? false;
  const supportLive = options.supportLive ?? false;
  const contextLabel = options.contextLabel ?? "benchmark";
  const out: BenchmarkArtifactCliResult = {
    artifactsDir,
    noWrite: false,
    noStdout: false,
    live: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--artifacts" && argv[i + 1] !== undefined) {
      out.artifactsDir = argv[++i]!;
    } else if (a === "--no-write") {
      if (!supportNoWrite) {
        throw new Error(`unknown ${contextLabel} cli flag: "${a}"`);
      }
      out.noWrite = true;
    } else if (a === "--no-stdout") {
      if (!supportNoStdout) {
        throw new Error(`unknown ${contextLabel} cli flag: "${a}"`);
      }
      out.noStdout = true;
    } else if (a === "--live") {
      if (!supportLive) {
        throw new Error(`unknown ${contextLabel} cli flag: "${a}"`);
      }
      out.live = true;
    } else {
      throw new Error(`unknown ${contextLabel} cli flag: "${a}"`);
    }
  }
  return out;
}
