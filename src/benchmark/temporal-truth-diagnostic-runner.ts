/**
 * Benchmark-only temporal / current-truth diagnostic
 * runner.
 *
 * The runner is a thin orchestrator that:
 *   1. Loads the most recent lexical-baseline
 *      benchmark artifact under
 *      `.curion/benchmark/`. The artifact's
 *      `evals` array is the source the diagnostic
 *      consumes (the `evals` carry `topIds` /
 *      `topScores` / `currentTruthIds` / `passed`
 *      / `rank1` / `currentTruthAt1`).
 *   2. (Optionally) loads a pre-computed
 *      semantic-evidence map from a JSON file.
 *      The map is a `{queryId -> "hit"|"miss"}`
 *      object derived from a separate dense
 *      benchmark run; the runner NEVER runs a
 *      new dense benchmark.
 *   3. Calls
 *      `buildTemporalTruthDiagnosticReport` to
 *      produce the report.
 *   4. Writes the JSON artifact to disk and
 *      prints the human-readable report.
 *
 * The runner is benchmark-only and never
 * modifies the production `recall(text)`
 * controller, the public MCP API, or the
 * storage schema. It is a CLI entry point
 * over the pure functions in
 * `src/benchmark/temporal-truth-diagnostic.ts`.
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
 *     `retrieval-baseline-*.json` (or
 *     equivalent) artifact the diagnostic
 *     consumes. Default: the most recent
 *     `retrieval-baseline-*.json` under
 *     `.curion/benchmark/`.
 *   --semantic-evidence <path>    — OPTIONAL
 *     JSON file with shape
 *     `{source: string, byQueryId: {[qid]:
 *     "hit"|"miss"}}`. When omitted, the
 *     report has no semantic annotation; the
 *     honest-reading block is unchanged.
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
 *     variant label for the report. Default:
 *     the upstream artifact's `variant` field
 *     (e.g. `lexical-baseline`). A reviewer
 *     who wants to compare diagnostics across
 *     multiple sources overrides the label
 *     here.
 */

import fs from "node:fs";
import path from "node:path";

import { BENCHMARK_QUERIES } from "./queries.js";
import type { BenchmarkQuery } from "./queries.js";
import {
  buildTemporalTruthDiagnosticReport,
  formatTemporalTruthDiagnosticReport,
  type TemporalTruthDiagnosticReport,
} from "./temporal-truth-diagnostic.js";

// ---------------------------------------------------------------------------
// Artifact reader
// ---------------------------------------------------------------------------

/**
 * Shape of a `retrieval-baseline-*.json` artifact. The runner
 * reads just enough fields to drive the diagnostic; the
 * full artifact has more keys (`metrics`, `orientation`,
 * `failures`, ...) that the diagnostic does not consume.
 */
export interface BenchmarkArtifact {
  generatedAt: string;
  variant: string;
  config: {
    recordCount?: number;
  };
  evals: ReadonlyArray<{
    queryId: string;
    family: string;
    query: string;
    expectedIds: number[];
    currentTruthIds: number[];
    topIds: number[];
    topScores: number[];
    rank1: boolean;
    currentTruthAt1: boolean;
    passed: boolean;
    reason: string;
  }>;
}

/**
 * Read a baseline benchmark artifact from disk and return
 * its in-memory shape. The runner validates that the
 * `evals` array is well-formed (the function is
 * defensive; the upstream `retrieval-runner.ts` writes
 * the shape the diagnostic expects).
 */
export function readBenchmarkArtifact(filePath: string): BenchmarkArtifact {
  const text = fs.readFileSync(filePath, "utf8");
  const raw = JSON.parse(text) as BenchmarkArtifact;
  if (!raw || typeof raw !== "object") {
    throw new Error(
      `readBenchmarkArtifact: ${filePath} must be a JSON object, got ${typeof raw}`,
    );
  }
  if (!Array.isArray(raw.evals)) {
    throw new Error(
      `readBenchmarkArtifact: ${filePath} must have an 'evals' array, got ${typeof raw.evals}`,
    );
  }
  for (let i = 0; i < raw.evals.length; i++) {
    const e = raw.evals[i]!;
    if (typeof e.queryId !== "string" || e.queryId.length === 0) {
      throw new Error(
        `readBenchmarkArtifact: ${filePath} evals[${i}] must have a non-empty 'queryId'`,
      );
    }
    if (typeof e.family !== "string") {
      throw new Error(
        `readBenchmarkArtifact: ${filePath} evals[${i}].family must be a string`,
      );
    }
    if (!Array.isArray(e.topIds)) {
      throw new Error(
        `readBenchmarkArtifact: ${filePath} evals[${i}].topIds must be an array`,
      );
    }
    if (!Array.isArray(e.currentTruthIds)) {
      throw new Error(
        `readBenchmarkArtifact: ${filePath} evals[${i}].currentTruthIds must be an array`,
      );
    }
  }
  return raw;
}

/**
 * Read a semantic-evidence file. The file's shape is
 * `{source: string, byQueryId: {[qid]: "hit"|"miss"}}`. The
 * runner re-uses the upstream reader's contract from the
 * false-abstention-damage-runner module; the field shape is
 * the same.
 */
export interface SemanticEvidenceMap {
  source: string;
  byQueryId: ReadonlyMap<string, "hit" | "miss">;
}

export function readSemanticEvidenceFile(filePath: string): SemanticEvidenceMap {
  const text = fs.readFileSync(filePath, "utf8");
  const raw = JSON.parse(text);
  if (typeof raw.source !== "string" || raw.source.length === 0) {
    throw new Error(
      `readSemanticEvidenceFile: ${filePath} must have a non-empty string 'source' field`,
    );
  }
  if (typeof raw.byQueryId !== "object" || raw.byQueryId === null) {
    throw new Error(
      `readSemanticEvidenceFile: ${filePath} must have an object 'byQueryId' field`,
    );
  }
  const map = new Map<string, "hit" | "miss">();
  for (const [k, v] of Object.entries(raw.byQueryId)) {
    if (v !== "hit" && v !== "miss") {
      throw new Error(
        `readSemanticEvidenceFile: ${filePath} byQueryId.${k} must be "hit" or "miss", got ${JSON.stringify(v)}`,
      );
    }
    map.set(k, v);
  }
  return { source: raw.source, byQueryId: map };
}

// ---------------------------------------------------------------------------
// Artifact scanner
// ---------------------------------------------------------------------------

/**
 * Find the most recent artifact under `dir` whose filename
 * matches `prefix`. Returns `undefined` if no artifact
 * matches. The function is synchronous and never mutates
 * the directory.
 */
export function findMostRecentArtifact(
  dir: string,
  prefix: string,
): string | undefined {
  if (!fs.existsSync(dir)) return undefined;
  const entries = fs
    .readdirSync(dir)
    .filter((e) => e.startsWith(prefix) && e.endsWith(".json"))
    .map((e) => ({
      name: e,
      full: path.join(dir, e),
      mtime: fs.statSync(path.join(dir, e)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return entries[0]?.full;
}

// ---------------------------------------------------------------------------
// Per-query alignment
// ---------------------------------------------------------------------------

/**
 * Build a per-query alignment between the artifact's evals
 * and the `BENCHMARK_QUERIES` corpus. The function looks up
 * each `eval.queryId` in `BENCHMARK_QUERIES` and returns a
 * list of `BenchmarkQuery` objects in the same order as
 * the artifact's evals. A query not in the corpus is a
 * fixture-contract bug; the function throws so the bug
 * is caught at runner time rather than silently producing
 * a malformed report.
 */
export function alignQueriesToEvals(
  evals: ReadonlyArray<{ queryId: string }>,
): BenchmarkQuery[] {
  const byId = new Map(BENCHMARK_QUERIES.map((q) => [q.id, q]));
  const out: BenchmarkQuery[] = [];
  for (let i = 0; i < evals.length; i++) {
    const e = evals[i]!;
    const q = byId.get(e.queryId);
    if (!q) {
      throw new Error(
        `alignQueriesToEvals: evals[${i}].queryId="${e.queryId}" not found in BENCHMARK_QUERIES`,
      );
    }
    out.push(q);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Top-level runner
// ---------------------------------------------------------------------------

/**
 * Top-level runner. Consumes the benchmark artifact +
 * (optionally) the semantic-evidence map and emits the
 * `TemporalTruthDiagnosticReport`. The function is pure: no
 * I/O. The CLI entry point writes the artifact to disk; the
 * function itself is a pure orchestrator.
 *
 * The function does NOT call any provider, any ranker, or
 * any external service. It consumes the artifacts the
 * benchmark runner produced.
 */
export function runTemporalTruthDiagnosticAnalysis(args: {
  benchmarkArtifact: BenchmarkArtifact;
  semantic?: SemanticEvidenceMap;
  /** Override the variant label. The runner defaults to
   *  the upstream artifact's `variant` field. */
  variant?: string;
}): TemporalTruthDiagnosticReport {
  const { benchmarkArtifact, semantic, variant } = args;
  const queries = alignQueriesToEvals(benchmarkArtifact.evals);
  return buildTemporalTruthDiagnosticReport({
    variant: variant ?? benchmarkArtifact.variant,
    evals: benchmarkArtifact.evals,
    queries,
    sourceVariant: benchmarkArtifact.variant,
    recordCount: benchmarkArtifact.config.recordCount ?? null,
    ...(semantic ? { semantic } : {}),
  });
}

// ---------------------------------------------------------------------------
// Artifact writer
// ---------------------------------------------------------------------------

const ARTIFACT_FILE_PREFIX = "retrieval-temporal-truth-diagnostic";

/**
 * Write a temporal diagnostic report to disk. The file
 * prefix is
 * `retrieval-temporal-truth-diagnostic-*.json`
 * (distinct from the existing audit / policy / diagnostic /
 * benchmark / calibration / no-answer-abstention /
 * false-abstention-damage / paraphrase-recovery prefixes)
 * so a reviewer can find the experiment artifacts next to
 * the regular reports without confusing them.
 */
export function writeTemporalTruthDiagnosticReport(
  report: TemporalTruthDiagnosticReport,
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
 * CLI argument shape. The CLI is small: each field is
 * OPTIONAL; the defaults pick the most recent lexical-
 * baseline artifacts under `.curion/benchmark/`.
 */
export interface TemporalTruthDiagnosticCliArgs {
  benchmarkArtifact?: string;
  semanticEvidence?: string;
  outDir?: string;
  noWrite?: boolean;
  noStdout?: boolean;
  variant?: string;
}

/**
 * Run the CLI. The function is the entry point the
 * `tsx` invocation calls; it is not part of the public
 * TypeScript surface (the function does its own
 * argument parsing).
 */
export async function runTemporalTruthDiagnosticCli(
  args: TemporalTruthDiagnosticCliArgs,
): Promise<{
  report: TemporalTruthDiagnosticReport;
  written?: string;
}> {
  const outDir = args.outDir ?? ".curion/benchmark";
  const defaultBenchmark =
    args.benchmarkArtifact ??
    findMostRecentArtifact(outDir, "retrieval-baseline-");
  if (!defaultBenchmark) {
    throw new Error(
      `runTemporalTruthDiagnosticCli: no --benchmark-artifact given and no ` +
        `retrieval-baseline-*.json found under ${outDir}`,
    );
  }
  const benchmarkArtifact = readBenchmarkArtifact(defaultBenchmark);
  let semantic: SemanticEvidenceMap | undefined;
  if (args.semanticEvidence) {
    semantic = readSemanticEvidenceFile(args.semanticEvidence);
  }
  const report = runTemporalTruthDiagnosticAnalysis({
    benchmarkArtifact,
    ...(semantic ? { semantic } : {}),
    ...(args.variant !== undefined ? { variant: args.variant } : {}),
  });
  let written: string | undefined;
  if (!args.noWrite) {
    written = writeTemporalTruthDiagnosticReport(report, outDir);
  }
  if (!args.noStdout) {
    process.stderr.write(
      `[temporal-truth-diagnostic] benchmark artifact: ${defaultBenchmark}\n`,
    );
    if (semantic) {
      process.stderr.write(
        `[temporal-truth-diagnostic] semantic evidence:  ${args.semanticEvidence}\n`,
      );
    }
    if (written) {
      process.stderr.write(
        `[temporal-truth-diagnostic] wrote:              ${written}\n`,
      );
    }
    process.stdout.write(
      formatTemporalTruthDiagnosticReport(report) + "\n",
    );
  }
  return { report, ...(written ? { written } : {}) };
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

/**
 * Minimal argument parser. The CLI is small; a
 * hand-rolled parser keeps the surface narrow. The
 * parser is permissive: unknown flags are ignored so a
 * reviewer can pass `--help` / `--version` and the
 * runner silently accepts them. The order of
 * arguments does not matter.
 */
export function parseTemporalTruthDiagnosticCliArgs(
  argv: ReadonlyArray<string>,
): TemporalTruthDiagnosticCliArgs {
  const out: TemporalTruthDiagnosticCliArgs = {};
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
 * Process argv-based main entry point. The function is
 * the one a `tsx` invocation calls. It returns the
 * report promise so tests can `await` it; in CLI mode
 * the process exits normally.
 */
export async function main(
  argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<TemporalTruthDiagnosticReport> {
  const args = parseTemporalTruthDiagnosticCliArgs(argv);
  const { report } = await runTemporalTruthDiagnosticCli(args);
  return report;
}

/**
 * Run the CLI when this module is the entry point.
 * The guard compares `import.meta.url` to the resolved
 * path of the script (when available) so tests can
 * `import` the module without triggering a CLI run.
 */
const isMainEntry = (() => {
  if (typeof process === "undefined") return false;
  if (!Array.isArray(process.argv)) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  if (!/temporal-truth-diagnostic-runner\.(ts|js)$/.test(entry)) return false;
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
      `[temporal-truth-diagnostic] error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
