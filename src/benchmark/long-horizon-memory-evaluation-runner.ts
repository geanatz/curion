/**
 * Benchmark-only long-horizon memory evaluation CLI
 * runner (v1).
 *
 * A small CLI that runs the long-horizon memory
 * evaluation helper
 * (`src/benchmark/long-horizon-memory-evaluation.ts`) and
 * writes the JSON artifact under `.curion/benchmark/`.
 *
 * The runner mirrors the canonical recall-policy /
 * decision-policy runner flag style:
 *   --artifacts <path>   override the artifact directory
 *   --no-write           suppress the JSON artifact
 *   --no-stdout          suppress the human report
 *
 * The runner deliberately does NOT expose `--live`: the
 * long-horizon evaluation is scripted / no-network by
 * design; there is no live mode to opt into (no real
 * provider call is part of the contract). The shared
 * `parseBenchmarkArtifactCli` helper rejects `--live`
 * as an unknown flag unless a runner opts in via
 * `supportLive: true`; this runner deliberately leaves
 * that flag off.
 *
 * Behaviour:
 *   - Runs the full evaluation (8 scenarios in v1) in-
 *     process.
 *   - Builds the evaluation report and (optionally)
 *     writes the JSON artifact under
 *     `.curion/benchmark/`.
 *   - Prints the human summary to stdout.
 *   - Exits with code 0 on success; code 1 on any
 *     unexpected error.
 *
 * Security:
 *   - No API keys, no Authorization headers, no live
 *     network. The harness drives the storage lifecycle
 *     seams against a fresh temp DB.
 *   - No production storage is touched.
 *   - The benchmark harness is consumed ONLY by the
 *     long-horizon memory evaluation harness and its
 *     companion test suite; production code paths do
 *     NOT import the harness.
 *
 * Scope (benchmark-only):
 *   The CLI is read-mostly. It does not write to the
 *   production storage; the only on-disk effects are
 *   the JSON report under `.curion/benchmark/` and the
 *   temp DB each scenario creates in `os.tmpdir()` (the
 *   harness removes the temp dir at the end of every
 *   scenario).
 *
 * Why this is a separate entry point:
 *   The decision-policy runner, the adaptive-depth
 *   runner, the recall-policy runner, and the long-
 *   horizon runner each exercise distinct code paths
 *   with distinct scenario sets and report shapes. A
 *   reviewer who wants to audit the long-horizon
 *   evaluation reads this file plus
 *   `src/benchmark/long-horizon-memory-evaluation.ts`
 *   and `tests/long-horizon-memory-evaluation.test.ts`;
 *   the other runners are not part of the long-horizon
 *   read path.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseBenchmarkArtifactCli } from "./_cli.js";
import {
  formatLongHorizonMemoryEvaluationReport,
  runLongHorizonMemoryEvaluation,
  writeLongHorizonMemoryEvaluationReport,
} from "./long-horizon-memory-evaluation.js";

/**
 * Parse the long-horizon memory evaluation CLI args.
 * The runner's CLI surface is narrow: `--artifacts`,
 * `--no-write`, and `--no-stdout`. The `--live` flag is
 * deliberately NOT supported — the long-horizon
 * evaluation has no live mode (it is a scripted / no-
 * network probe of the storage lifecycle layer by
 * design). Passing `--live` surfaces a clear "unknown
 * flag" error so a misspelled flag is caught at the CLI
 * boundary.
 *
 * The parser is a thin wrapper over the shared
 * `parseBenchmarkArtifactCli` helper so the runner, the
 * recall-policy runner, and the decision-policy runner
 * share the same parsing semantics.
 */
export function parseLongHorizonMemoryEvaluationCli(argv: ReadonlyArray<string>): {
  artifactsDir: string;
  noWrite: boolean;
  noStdout: boolean;
} {
  const parsed = parseBenchmarkArtifactCli(argv, {
    supportNoWrite: true,
    supportNoStdout: true,
    // `supportLive` deliberately left at the default
    // `false`: the long-horizon evaluation has no live
    // mode (scripted / no-network only).
    contextLabel: "long-horizon memory evaluation",
  });
  return {
    artifactsDir: parsed.artifactsDir,
    noWrite: parsed.noWrite,
    noStdout: parsed.noStdout,
  };
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isMain = (() => {
  if (!process.argv[1]) return false;
  try {
    const argvPath = path.resolve(process.argv[1]);
    const thisPath = fileURLToPath(import.meta.url);
    return argvPath === thisPath;
  } catch {
    return false;
  }
})();

if (isMain) {
  main().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[curion-long-horizon-eval] FATAL ${msg}\n`);
    process.exit(1);
  });
}

/**
 * Main entry point. The function is async because
 * `runLongHorizonMemoryEvaluation` is async. The
 * function is `void main()` (not exported) because the
 * CLI is a one-shot tool: the test surface imports the
 * helper directly.
 */
async function main(): Promise<void> {
  const opts = parseLongHorizonMemoryEvaluationCli(process.argv.slice(2));
  const report = await runLongHorizonMemoryEvaluation();
  let artifactPath: string | undefined;
  if (!opts.noWrite) {
    artifactPath = writeLongHorizonMemoryEvaluationReport(report, opts.artifactsDir);
  }
  if (!opts.noStdout) {
    process.stdout.write(formatLongHorizonMemoryEvaluationReport(report) + "\n");
    if (artifactPath) {
      process.stdout.write(`\nartifact written: ${artifactPath}\n`);
    }
  }
}
