/**
 * Benchmark-only supersession / metadata edge
 * simulation runner (Experiment 7).
 *
 * The runner is a thin orchestrator that:
 *   1. Loads the most recent lexical-baseline
 *      benchmark artifact under
 *      `.curion/benchmark/`. The artifact's
 *      `evals` array is the source the
 *      re-ranker consumes (the `evals` carry
 *      `topIds` / `topScores` /
 *      `currentTruthIds` / `passed` / `rank1` /
 *      `currentTruthAt1`).
 *   2. (Optionally) loads a pre-computed
 *      semantic-evidence map from a JSON file.
 *      The map is a `{queryId -> "hit"|"miss"}`
 *      object derived from a separate dense
 *      benchmark run; the runner NEVER runs a
 *      new dense benchmark.
 *   3. Calls `buildSupersessionRerankReport`
 *      to produce the report.
 *   4. Writes the JSON artifact to disk and
 *      prints the human-readable report.
 *
 * The runner is benchmark-only and never
 * modifies the production `recall(text)`
 * controller, the public MCP API, or the
 * storage schema. It is a CLI entry point
 * over the pure functions in
 * `src/benchmark/supersession-edge-simulation.ts`.
 *
 * Determinism:
 *   The runner is deterministic for a given
 *   (benchmark artifact, semantic evidence
 *   file). The pure-function report is
 *   byte-stable; the human report's column
 *   order is fixed; the JSON artifact's
 *   entries are in declaration order. The
 *   on-disk artifact is byte-stable for a
 *   fixed input. The only non-deterministic
 *   field is `generatedAt` (an ISO timestamp
 *   the formatter documents).
 *
 * CLI flags:
 *   --benchmark-artifact <path>   — the
 *     `retrieval-baseline-*.json` artifact
 *     the re-ranker consumes. Default: the
 *     most recent `retrieval-baseline-*.json`
 *     under `.curion/benchmark/`.
 *   --semantic-evidence <path>    — OPTIONAL
 *     JSON file with shape
 *     `{source: string, byQueryId: {[qid]:
 *     "hit"|"miss"}}`. When omitted, the
 *     report has no semantic cross-reference;
 *     the honest-reading block is unchanged.
 *   --out-dir <path>              — output
 *     dir. Default: `.curion/benchmark/`.
 *   --no-write                    — do not
 *     write the JSON artifact. Useful for
 *     CI / smoke tests that just want the
 *     human report on stdout.
 *   --no-stdout                   — do not
 *     print the human report. Useful for
 *     scripts that only want the JSON
 *     artifact.
 *   --variant <name>              — OPTIONAL
 *     source-variant label override. The
 *     runner defaults to the upstream
 *     artifact's `variant` field.
 */

import fs from "node:fs";
import path from "node:path";

import { BENCHMARK_QUERIES } from "./queries.js";
import type { BenchmarkQuery } from "./queries.js";
import {
  buildSupersessionRerankReport,
  formatSupersessionRerankReport,
  type SupersessionRerankReport,
} from "./supersession-edge-simulation.js";
import {
  alignQueriesToEvals,
  readBenchmarkArtifact,
  readSemanticEvidenceFile,
  findMostRecentArtifact,
  type BenchmarkArtifact,
  type SemanticEvidenceMap,
} from "./temporal-truth-diagnostic-runner.js";

// ---------------------------------------------------------------------------
// Top-level runner
// ---------------------------------------------------------------------------

/**
 * Top-level runner. Consumes the benchmark
 * artifact + (optionally) the semantic-evidence
 * map and emits the `SupersessionRerankReport`.
 * The function is pure: no I/O. The CLI entry
 * point writes the artifact to disk; the
 * function itself is a pure orchestrator.
 *
 * The function does NOT call any provider, any
 * ranker, or any external service. It consumes
 * the artifacts the benchmark runner produced.
 */
export function runSupersessionRerankAnalysis(args: {
  benchmarkArtifact: BenchmarkArtifact;
  semantic?: SemanticEvidenceMap;
  /** Override the source-variant label. The
   *  runner defaults to the upstream
   *  artifact's `variant` field. */
  sourceVariant?: string;
}): SupersessionRerankReport {
  const { benchmarkArtifact, semantic, sourceVariant } = args;
  const queries = alignQueriesToEvals(benchmarkArtifact.evals);
  return buildSupersessionRerankReport({
    sourceVariant: sourceVariant ?? benchmarkArtifact.variant,
    evals: benchmarkArtifact.evals,
    queries,
    recordCount: benchmarkArtifact.config.recordCount ?? null,
    ...(semantic ? { semantic } : {}),
  });
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "retrieval-supersession-edge-simulation";

/**
 * Write a supersession re-ranker report to disk.
 * The file prefix is
 * `retrieval-supersession-edge-simulation-*.json`
 * (distinct from the existing audit / policy /
 * diagnostic / benchmark / calibration /
 * no-answer-abstention /
 * false-abstention-damage / paraphrase-recovery /
 * temporal-truth-diagnostic /
 * temporal-ranking-preference prefixes) so a
 * reviewer can find the experiment artifacts
 * next to the regular reports without
 * confusing them.
 */
export function writeSupersessionRerankReport(
  report: SupersessionRerankReport,
  dir: string,
): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ARTIFACT_FILE_PREFIX}-${stamp}.json`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, JSON.stringify(report, null, 2), "utf8");
  return full;
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

/**
 * CLI argument shape. The CLI is small: each
 * field is OPTIONAL; the defaults pick the most
 * recent lexical-baseline artifacts under
 * `.curion/benchmark/`.
 */
export interface SupersessionRerankCliArgs {
  benchmarkArtifact?: string;
  semanticEvidence?: string;
  outDir?: string;
  noWrite?: boolean;
  noStdout?: boolean;
  variant?: string;
}

/**
 * Run the CLI. The function is the entry point
 * the `tsx` invocation calls; it is not part of
 * the public TypeScript surface (the function
 * does its own argument parsing).
 */
export async function runSupersessionRerankCli(
  args: SupersessionRerankCliArgs,
): Promise<{
  report: SupersessionRerankReport;
  written?: string;
}> {
  const outDir = args.outDir ?? ".curion/benchmark";
  const defaultBenchmark =
    args.benchmarkArtifact ??
    findMostRecentArtifact(outDir, "retrieval-baseline-");
  if (!defaultBenchmark) {
    throw new Error(
      `runSupersessionRerankCli: no --benchmark-artifact given and no ` +
        `retrieval-baseline-*.json found under ${outDir}`,
    );
  }
  const benchmarkArtifact = readBenchmarkArtifact(defaultBenchmark);
  let semantic: SemanticEvidenceMap | undefined;
  if (args.semanticEvidence) {
    semantic = readSemanticEvidenceFile(args.semanticEvidence);
  }
  const report = runSupersessionRerankAnalysis({
    benchmarkArtifact,
    ...(semantic ? { semantic } : {}),
    ...(args.variant !== undefined ? { sourceVariant: args.variant } : {}),
  });
  let written: string | undefined;
  if (!args.noWrite) {
    written = writeSupersessionRerankReport(report, outDir);
  }
  if (!args.noStdout) {
    process.stderr.write(
      `[supersession-edge-simulation] benchmark artifact: ${defaultBenchmark}\n`,
    );
    if (semantic) {
      process.stderr.write(
        `[supersession-edge-simulation] semantic evidence:  ${args.semanticEvidence}\n`,
      );
    }
    if (written) {
      process.stderr.write(
        `[supersession-edge-simulation] wrote:              ${written}\n`,
      );
    }
    process.stdout.write(
      formatSupersessionRerankReport(report) + "\n",
    );
  }
  return { report, ...(written ? { written } : {}) };
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

/**
 * Minimal argument parser. The CLI is small; a
 * hand-rolled parser keeps the surface narrow.
 * The parser is permissive: unknown flags are
 * ignored so a reviewer can pass `--help` /
 * `--version` and the runner silently accepts
 * them. The order of arguments does not matter.
 */
export function parseSupersessionRerankCliArgs(
  argv: ReadonlyArray<string>,
): SupersessionRerankCliArgs {
  const out: SupersessionRerankCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--benchmark-artifact" && i + 1 < argv.length) {
      out.benchmarkArtifact = argv[++i];
    } else if (a === "--semantic-evidence" && i + 1 < argv.length) {
      out.semanticEvidence = argv[++i];
    } else if (a === "--out-dir" && i + 1 < argv.length) {
      out.outDir = argv[++i];
    } else if (a === "--variant" && i + 1 < argv.length) {
      out.variant = argv[++i];
    } else if (a === "--no-write") {
      out.noWrite = true;
    } else if (a === "--no-stdout") {
      out.noStdout = true;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Process argv-based main entry point. The
 * function is the one a `tsx` invocation calls.
 * It returns the report promise so tests can
 * `await` it; in CLI mode the process exits
 * normally.
 */
export async function main(
  argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<SupersessionRerankReport> {
  const args = parseSupersessionRerankCliArgs(argv);
  const { report } = await runSupersessionRerankCli(args);
  return report;
}

/**
 * Run the CLI when this module is the entry
 * point. The guard compares `import.meta.url`
 * to the resolved path of the script (when
 * available) so tests can `import` the module
 * without triggering a CLI run.
 */
const isMainEntry = (() => {
  if (typeof process === "undefined") return false;
  if (!Array.isArray(process.argv)) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  if (
    !/supersession-edge-simulation-runner\.(ts|js)$/.test(entry)
  )
    return false;
  try {
    const url = new URL(import.meta.url);
    return url.pathname === entry || url.pathname.endsWith(entry);
  } catch {
    return false;
  }
})();

if (isMainEntry) {
  main().catch((err) => {
    process.stderr.write(
      `[supersession-edge-simulation] error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}

// Re-export the import-only types so a
// downstream test can `import { type
// BenchmarkArtifact }` from this module. The
// re-export is a no-op at the type level; the
// runtime side is empty.
export type { BenchmarkArtifact, BenchmarkQuery };
// Touch the BENCHMARK_QUERIES import so
// downstream tree-shakers do not strip it
// out. The constant is used by
// `alignQueriesToEvals` via the diagnostic
// runner.
export const __BENCHMARK_QUERIES_TOUCH: ReadonlyArray<unknown> = BENCHMARK_QUERIES;
