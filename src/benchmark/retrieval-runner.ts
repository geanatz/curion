/**
 * Retrieval benchmark runner.
 *
 * A small CLI that exercises the current lexical retrieval
 * baseline against a hand-curated fixture corpus and emits a
 * sanitized JSON report.
 *
 * Behavior:
 *   - Loads the in-memory corpus and query set from
 *     `src/benchmark/corpus.ts` and `src/benchmark/queries.ts`.
 *   - Runs the production `rankLexical` function from
 *     `src/retrieval/lexical.ts` against every query. The
 *     production path is therefore exercised end-to-end without
 *     touching the database, providers, or the network.
 *   - Computes per-query results and aggregate metrics
 *     (hit@1, hit@3, hit@5, no-answer TNR, per-family
 *     breakdown, failure list).
 *   - Writes a JSON report under `.cortex/benchmark/` (or
 *     `--artifacts <path>`) and prints a human summary to
 *     stdout. The benchmark runner is NOT the MCP stdio server,
 *     so writing to stdout is fine here.
 *
 * Security:
 *   - No API keys, no Authorization headers, no live network.
 *   - The fixture corpus is sanitized memory summaries (no raw
 *     input, no credentials); the corpus hygiene is
 *     regression-checked by `tests/retrieval-benchmark.test.ts`.
 *
 * Why this exists:
 *   - To establish a reproducible baseline of the lexical
 *     ranker's strengths and failure modes before any future
 *     retrieval variant (FTS5, vector, hybrid-rrf, rerank,
 *     entity-temporal) is wired into the controller. The report
 *     is the reference point for later A/B comparisons.
 *
 * Design notes:
 *   - The runner is intentionally read-only. It does not write
 *     to the database. The only on-disk effect is the JSON
 *     report under `.cortex/benchmark/`.
 *   - The runner does not call the provider. The lexical
 *     baseline is a candidate retriever; provider synthesis is
 *     out of scope for this measurement harness. Per-query
 *     metrics are computed over the ranker's top-K ids, not
 *     over the synthesized answer.
 *   - The runner is deterministic for a given corpus + query
 *     set + threshold. No timers affect scoring. Timing is
 *     reported per-query for context but is not part of the
 *     pass/fail contract.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  rankLexical,
  DEFAULT_RELEVANCE_THRESHOLD,
  DEFAULT_TOP_K,
  type LexicalCandidate,
  type LexicalScoredCandidate,
} from "../retrieval/lexical.js";
import { BENCHMARK_RECORDS, type BenchmarkMemoryRecord } from "./corpus.js";
import {
  BENCHMARK_QUERIES,
  type BenchmarkQuery,
  type BenchmarkQueryFamily,
} from "./queries.js";
import {
  aggregateMetrics,
  aggregateOrientationMetrics,
  evaluateQuery,
  type BenchmarkMetrics,
  type QueryEval,
  type OrientationMetrics,
} from "./metrics.js";
import {
  buildAnswerQualityScaffold,
  ANSWER_QUALITY_DISABLED_LABEL,
  type AnswerQualityScaffold,
} from "./answer-quality.js";
import {
  rankFts5,
  DEFAULT_FTS5_THRESHOLD,
  type Fts5RankingOptions,
} from "./variants/fts5.js";
import {
  rankVector,
  DEFAULT_VECTOR_THRESHOLD,
  type VectorRankingOptions,
} from "./variants/vector.js";
import {
  rankHybrid,
  DEFAULT_RRF_K,
  DEFAULT_HYBRID_THRESHOLD,
  DEFAULT_HYBRID_TOP_K,
  type HybridRankingOptions,
  type HybridScoredCandidate,
  type RrfContributor,
} from "./variants/hybrid.js";
import {
  DEFAULT_CALIBRATION_SWEEP,
  buildSweepForVariant,
  pickBestRow,
  type CalibrationConfig,
  type CalibrationReport,
  type CalibrationVariantResult,
} from "./calibration.js";
import { buildHybridPerFamilyDelta, type HybridPerFamilyDeltaRow } from "./metrics.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface RetrievalBenchmarkOptions {
  /**
   * Override the relevance threshold. Default: the production
   * default (0.2). This is the same default the recall
   * controller uses in production.
   */
  threshold?: number;
  /**
   * Override the top-K. Default: the production default (5).
   * The metric aggregation is hard-coded to hit@1/3/5; raising
   * top-K above 5 does NOT add a hit@K bucket.
   */
  topK?: number;
  /** Override artifacts directory. */
  artifactsDir?: string;
  /** Restrict to a subset of families (comma-separated names). */
  onlyFamilies?: string[];
  /**
   * Retrieval variant to run. Default: `"lexical"`.
   *   - `"lexical"` — the production `rankLexical` baseline.
   *   - `"fts5"`    — the benchmark-only `rankFts5` variant
   *                   (in-memory SQLite FTS5 with BM25).
   *   - `"vector"`  — the benchmark-only `rankVector` variant
   *                   (cosine similarity over a deterministic
   *                   local hashed-bag-of-words embedding).
   *   - `"hybrid"`  — the benchmark-only `rankHybrid` variant
   *                   (Reciprocal Rank Fusion over lexical /
   *                   FTS5 / vector). The fusion k defaults to
   *                   60 (the conventional RRF value) and can
   *                   be overridden via `hybridK` / `--hybrid-k`.
   *   - `"all"`     — run ALL four variants back-to-back. The
   *                   `runRetrievalBenchmark` function returns
   *                   a single comparison report; the CLI entry
   *                   point additionally writes a separate
   *                   per-variant report file for each variant.
   *
   * The FTS5, vector, and hybrid variants are benchmark-only.
   * They are NOT wired into the production `recall(text)`
   * controller and do not change the public MCP API.
   */
  variant?: BenchmarkVariant;
  /**
   * RRF smoothing constant for the hybrid variant. Default
   * `60` (the conventional value from the RRF paper and
   * the value most implementations pick). The benchmark
   * sweep covers k ∈ {20, 60, 100} so a reviewer can see
   * the trade-off; this option lets a caller pin a
   * specific k for an explicit-per-k run. Ignored unless
   * `variant: "hybrid"` (or `"all"` — the all-mode runner
   * threads the k through the hybrid report).
   */
  hybridK?: number;
  /**
   * Run the abstention / calibration experiment instead of
   * (or in addition to) the regular benchmark. Default:
   * `false`. When `true`, the runner:
   *   - Still runs the regular per-variant benchmark for
   *     the chosen variant(s) so the headline metrics are
   *     available for sanity-checking the calibration
   *     baseline row.
   *   - Additionally runs the calibration sweep for the
   *     same variant(s) and emits a `CalibrationReport`
   *     under `--artifacts` (or `.cortex/benchmark/`).
   *
   * The calibration experiment is benchmark-only. It does
   * NOT change the production `recall(text)` behavior, the
   * public MCP API, or the existing single-variant /
   * comparison benchmark report shapes.
   */
  calibration?: boolean;
  /**
   * Optional custom calibration config. Defaults to a
   * three-family sweep (threshold, margin, ratio) with the
   * `DEFAULT_CALIBRATION_SWEEP` grid. Only used when
   * `calibration: true`.
   */
  calibrationConfig?: CalibrationConfig;
}

/**
 * Retrieval variant selector. The lexical variant is the
 * production baseline; the FTS5, vector, and hybrid
 * variants are benchmark-only comparison points. `"all"`
 * runs all four and emits a comparison report.
 */
export type BenchmarkVariant = "lexical" | "fts5" | "vector" | "hybrid" | "all";

export interface FailureEntry {
  queryId: string;
  family: string;
  expectedIds: number[];
  currentTruthIds: number[];
  topIds: number[];
  topScores: number[];
  /**
   * `true` iff the top result was one of `expectedIds`. This is
   * reported on every failure so the temporal wrong-rank1 case
   * (current fact in top-K, old fact at the top) is visible in
   * the failure list.
   */
  rank1: boolean;
  /**
   * `true` iff the top result was one of `currentTruthIds`.
   * For non-temporal families this mirrors `rank1`; for the
   * `temporal` family it is the metric the reviewer flagged.
   */
  currentTruthAt1: boolean;
  reason: string;
}

/**
 * A single-variant retrieval benchmark report.
 *
 * `variant` is the human-readable label of the ranker that
 * produced the report. `"lexical-baseline"` is kept as the
 * lexical variant label so the existing report consumers and
 * test assertions continue to work unchanged. `"fts5-benchmark"`,
 * `"vector-benchmark"`, and `"hybrid-benchmark"` are the FTS5,
 * vector, and hybrid variant labels.
 *
 * The report carries:
 *   - `evals`        — per-query evaluations.
 *   - `metrics`      — the aggregate metrics, including the
 *                      derived IR / no-answer / currentTruth
 *                      / score-diagnostics block and the
 *                      failure-category table.
 *   - `orientation`  — the project-status sub-aggregate. The
 *                      block is always present and well-formed
 *                      even if the corpus has no orientation
 *                      queries (e.g. a future corpus revision
 *                      drops the family).
 *   - `answerQuality`— the answer-quality scaffold, always
 *                      `enabled: false` in this phase. A
 *                      future phase can flip the flag and
 *                      populate `evaluations` without
 *                      changing the report shape.
 *   - `failures`     — the failing-evals summary, unchanged
 *                      from the prior phase.
 *   - `hybridPerFamilyDelta` — for the hybrid variant only:
 *     the per-family "hybrid vs best baseline" richer-
 *     diagnostics table the Architect's brief asks for.
 *     `undefined` on lexical / FTS5 / vector reports so
 *     the existing per-variant report shapes are
 *     byte-stable.
 */
export interface RetrievalBenchmarkReport {
  generatedAt: string;
  variant:
    | "lexical-baseline"
    | "fts5-benchmark"
    | "vector-benchmark"
    | "hybrid-benchmark";
  config: {
    threshold: number;
    topK: number;
    recordCount: number;
    queryCount: number;
    /**
     * Hybrid RRF smoothing constant. Present only on
     * `hybrid-benchmark` reports; `undefined` on the
     * other variants. Reported so a reviewer can audit
     * the k choice without re-running.
     */
    hybridK?: number;
  };
  evals: QueryEval[];
  metrics: BenchmarkMetrics;
  orientation: import("./metrics.js").OrientationMetrics;
  answerQuality: import("./answer-quality.js").AnswerQualityScaffold;
  failures: FailureEntry[];
  /**
   * Hybrid per-family delta table. Present only on
   * `hybrid-benchmark` reports; `undefined` on the other
   * variants. The richer-diagnostics block the brief
   * asks for: for each family, the table reports
   * `hybridRank1` / `hybridHit5`, the three baseline
   * `rank1` numbers, the `bestBaselineRank1`, the
   * `deltaHybridVsLexical`, the `deltaHybridVsBest`,
   * and the no-answer TNR pair.
   */
  hybridPerFamilyDelta?: HybridPerFamilyDeltaRow[];
}

/**
 * A multi-variant comparison report. Produced when
 * `runRetrievalBenchmark` is called with `variant: "all"`.
 * Contains the per-variant reports plus a side-by-side
 * `comparison` block summarizing the headline metrics.
 */
export interface ComparisonBenchmarkReport {
  generatedAt: string;
  variant: "all";
  config: {
    recordCount: number;
    queryCount: number;
    /**
     * Hybrid RRF smoothing constant used for the
     * comparison's hybrid run. Present only when
     * `hybridK` was passed on the runner options;
     * `undefined` otherwise. Reported so a reviewer can
     * audit the k choice without re-running.
     */
    hybridK?: number;
  };
  lexical: RetrievalBenchmarkReport;
  fts5: RetrievalBenchmarkReport;
  vector: RetrievalBenchmarkReport;
  hybrid: RetrievalBenchmarkReport;
  /** Headline metric side-by-side, computed from the same
   * corpus + query set. Per-family deltas are out of scope for
   * the v1 comparison; if a future phase needs them, extend
   * `aggregateMetrics` with a delta helper rather than
   * recomputing here. */
  comparison: ComparisonRow[];
  /**
   * Per-family "hybrid vs best baseline" delta table.
   * The richer-diagnostics block the brief asks for.
   * Built from the four per-variant reports and
   * surfaced next to the per-family metrics so a
   * reviewer can see the rank-1 trade-off per family.
   */
  hybridPerFamilyDelta: HybridPerFamilyDeltaRow[];
}

/** One row in a comparison report. */
export interface ComparisonRow {
  metric: string;
  lexical: number;
  fts5: number;
  vector: number;
  hybrid: number;
  /**
   * Positive number = FTS5 better than lexical. Negative
   * = lexical better. The delta is computed against the
   * lexical baseline for backward-compat with the
   * two-variant comparison shape; a separate
   * `hybridPerFamilyDelta` block carries the
   * hybrid-specific deltas.
   */
  delta: number;
}

// ---------------------------------------------------------------------------
// CLI parsing
// ---------------------------------------------------------------------------

export function parseRetrievalCli(argv: string[]): RetrievalBenchmarkOptions {
  const opts: RetrievalBenchmarkOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--threshold" && argv[i + 1]) {
      const n = Number.parseFloat(argv[++i]);
      if (!Number.isFinite(n) || n < 0 || n > 1) {
        throw new Error(`--threshold requires a number in [0, 1] (got "${argv[i]}")`);
      }
      opts.threshold = n;
    } else if (a === "--top-k" && argv[i + 1]) {
      const n = Number.parseInt(argv[++i], 10);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(`--top-k requires a positive integer (got "${argv[i]}")`);
      }
      opts.topK = n;
    } else if (a === "--artifacts" && argv[i + 1]) {
      opts.artifactsDir = argv[++i];
    } else if (a === "--only-family" && argv[i + 1]) {
      opts.onlyFamilies = argv[++i]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    } else if (a === "--variant" && argv[i + 1]) {
      const v = argv[++i];
      if (
        v !== "lexical" &&
        v !== "fts5" &&
        v !== "vector" &&
        v !== "hybrid" &&
        v !== "all"
      ) {
        throw new Error(
          `--variant must be one of lexical|fts5|vector|hybrid|all (got "${v}")`,
        );
      }
      opts.variant = v;
    } else if (a === "--hybrid-k" && argv[i + 1]) {
      const n = Number.parseFloat(argv[++i]);
      if (!Number.isFinite(n) || n <= 0) {
        throw new Error(
          `--hybrid-k requires a positive finite number (got "${argv[i]}")`,
        );
      }
      opts.hybridK = n;
    } else if (a === "--calibrate") {
      opts.calibration = true;
    } else if (a === "--calibrate-direction" && argv[i + 1]) {
      const d = argv[++i];
      if (d !== "higher-is-better" && d !== "lower-is-better") {
        throw new Error(
          `--calibrate-direction must be higher-is-better|lower-is-better (got "${d}")`,
        );
      }
      // Build a calibration config with the requested
      // direction. The default sweep grid is the same; the
      // direction is the only thing that changes.
      opts.calibrationConfig = {
        gatesByVariant: {},
        sweep: DEFAULT_CALIBRATION_SWEEP,
        direction: d,
      };
    } else if (a === "--help" || a === "-h") {
      printRetrievalHelp();
      process.exit(0);
    } else {
      throw new Error(`unknown argument: ${a}`);
    }
  }
  // If --calibrate was passed without --calibrate-direction,
  // ensure the calibration config has the default direction
  // so the artifact is self-describing.
  if (opts.calibration && !opts.calibrationConfig) {
    opts.calibrationConfig = {
      gatesByVariant: {},
      sweep: DEFAULT_CALIBRATION_SWEEP,
    };
  }
  // Warn (not error) if --hybrid-k was passed with a
  // non-hybrid / non-all variant. The RRF smoothing
  // constant is only consumed by the hybrid and "all"
  // paths; passing it for lexical / fts5 / vector is
  // a no-op and most likely a user mistake. A stderr
  // warning is enough — we do not want to break
  // existing CLI invocations that pass --hybrid-k
  // unconditionally.
  if (
    opts.hybridK !== undefined &&
    opts.variant !== undefined &&
    opts.variant !== "hybrid" &&
    opts.variant !== "all"
  ) {
    process.stderr.write(
      `[cortex-benchmark] note: --hybrid-k ${opts.hybridK} is ignored for --variant ${opts.variant} (RRF k is only used by hybrid / all runs)\n`,
    );
  }
  return opts;
}

function printRetrievalHelp(): void {
  process.stdout.write(
    [
      "cortex-mcp-v2 retrieval benchmark runner",
      "",
      "Usage:",
      "  tsx src/benchmark/retrieval-runner.ts [options]",
      "  npm run benchmark:retrieval -- [--options...]",
      "",
      "Options:",
      "  --threshold <n>         Relevance threshold in [0, 1] (default 0.2).",
      "  --top-k <n>            Top-K candidates to return (default 5).",
      "  --only-family <list>   Comma-separated family filter, e.g. exact,paraphrase",
      "  --variant <name>       Retrieval variant: lexical|fts5|vector|hybrid|all (default lexical).",
      "                         fts5, vector, and hybrid are benchmark-only and do not change the public API.",
      "  --hybrid-k <n>         RRF smoothing constant for the hybrid variant (default 60).",
      "  --artifacts <path>     Override the JSON report directory.",
      "  --calibrate            Run the abstention / calibration experiment after the regular",
      "                         benchmark. Benchmark-only: no production path or API change.",
      "  --calibrate-direction <dir>  Score direction for the calibration gate comparison.",
      "                         higher-is-better (default) | lower-is-better. All three variants",
      "                         return \"higher is better\" in their public score; lower-is-better",
      "                         is supported for experiments against the raw FTS5 bm25 value.",
      "  -h, --help             Show this help.",
      "",
      "Default artifacts directory: <cwd>/.cortex/benchmark/",
    ].join("\n") + "\n",
  );
}

// ---------------------------------------------------------------------------
// Artifacts directory
// ---------------------------------------------------------------------------

const ARTIFACT_DIRNAME = "benchmark";
const ARTIFACT_FILE_PREFIX_LEXICAL = "retrieval-baseline";
const ARTIFACT_FILE_PREFIX_FTS5 = "retrieval-fts5";
const ARTIFACT_FILE_PREFIX_VECTOR = "retrieval-vector";
const ARTIFACT_FILE_PREFIX_HYBRID = "retrieval-hybrid";
const ARTIFACT_FILE_PREFIX_COMPARE = "retrieval-compare";
const ARTIFACT_FILE_PREFIX_CALIBRATION = "retrieval-calibration";

export function resolveBenchmarkArtifactsDir(
  options: RetrievalBenchmarkOptions,
): string {
  const root = options.artifactsDir
    ? path.resolve(options.artifactsDir)
    : path.join(process.cwd(), ".cortex", ARTIFACT_DIRNAME);
  if (!fs.existsSync(root)) {
    fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  }
  return root;
}

export function writeBenchmarkReport(
  report: RetrievalBenchmarkReport,
  dir: string,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const prefix =
    report.variant === "fts5-benchmark"
      ? ARTIFACT_FILE_PREFIX_FTS5
      : report.variant === "vector-benchmark"
        ? ARTIFACT_FILE_PREFIX_VECTOR
        : report.variant === "hybrid-benchmark"
          ? ARTIFACT_FILE_PREFIX_HYBRID
          : ARTIFACT_FILE_PREFIX_LEXICAL;
  const filename = `${prefix}-${stamp}.json`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, JSON.stringify(report, null, 2), "utf8");
  return full;
}

/**
 * Write a comparison report (one file, both variants side by
 * side). Used by `--variant all`.
 */
export function writeComparisonReport(
  report: ComparisonBenchmarkReport,
  dir: string,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ARTIFACT_FILE_PREFIX_COMPARE}-${stamp}.json`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, JSON.stringify(report, null, 2), "utf8");
  return full;
}

/**
 * Write a calibration report. The calibration experiment is
 * benchmark-only; the artifact is intentionally written under
 * the same `.cortex/benchmark/` directory as the regular
 * benchmark reports so a reviewer can find them next to each
 * other, but the file prefix is distinct
 * (`retrieval-calibration-*.json`) so the existing
 * single-variant / comparison report consumers do not pick
 * it up accidentally.
 */
export function writeCalibrationReport(
  report: CalibrationReport,
  dir: string,
): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `${ARTIFACT_FILE_PREFIX_CALIBRATION}-${stamp}.json`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, JSON.stringify(report, null, 2), "utf8");
  return full;
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

function selectQueries(opts: RetrievalBenchmarkOptions): BenchmarkQuery[] {
  if (!opts.onlyFamilies || opts.onlyFamilies.length === 0) {
    return [...BENCHMARK_QUERIES];
  }
  const wanted = new Set(opts.onlyFamilies);
  return BENCHMARK_QUERIES.filter((q) => wanted.has(q.family));
}

// ---------------------------------------------------------------------------
// Core run
// ---------------------------------------------------------------------------

/**
 * Build the in-memory candidate list from the corpus.
 *
 * The function is exported so tests can assert on the
 * `LexicalCandidate` shape. It never mutates the input.
 */
export function buildCandidates(
  records: ReadonlyArray<BenchmarkMemoryRecord>,
): LexicalCandidate[] {
  return records.map((r) => {
    const c: LexicalCandidate = { id: r.id, text: r.summary };
    if (r.tags && r.tags.length > 0) c.tags = r.tags;
    return c;
  });
}

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

/**
 * Narrow `runRetrievalBenchmark`'s union return type to the
 * single-variant shape. The discriminant field is `evals`,
 * which exists on `RetrievalBenchmarkReport` and not on
 * `ComparisonBenchmarkReport`.
 */
export function isSingleVariantReport(
  report: RetrievalBenchmarkReport | ComparisonBenchmarkReport,
): report is RetrievalBenchmarkReport {
  return Array.isArray((report as RetrievalBenchmarkReport).evals);
}

/**
 * Narrow to the comparison shape. The discriminant is the
 * `comparison` array, which only exists on the comparison
 * report.
 */
export function isComparisonReport(
  report: RetrievalBenchmarkReport | ComparisonBenchmarkReport,
): report is ComparisonBenchmarkReport {
  return Array.isArray(
    (report as ComparisonBenchmarkReport).comparison,
  );
}

/**
 * Run the benchmark. Pure: no I/O beyond what the caller does
 * with the returned report. Tests use this directly; the CLI
 * entry point below writes the report to disk.
 *
 * Returns:
 *   - a `RetrievalBenchmarkReport` when `options.variant` is
 *     `"lexical"` (the default) or `"fts5"`.
 *   - a `ComparisonBenchmarkReport` when `options.variant` is
 *     `"all"`. The comparison report contains both
 *     `RetrievalBenchmarkReport`s plus a side-by-side metric
 *     table.
 *
 * The function is deterministic for a given corpus + query set
 * + threshold + top-K + variant. The FTS5 variant builds an
 * IN-MEMORY SQLite database for the duration of the run; the
 * project `.cortex/cortex.sqlite` is NOT touched.
 */
export function runRetrievalBenchmark(
  options: RetrievalBenchmarkOptions = {},
): RetrievalBenchmarkReport | ComparisonBenchmarkReport {
  const variant: BenchmarkVariant = options.variant ?? "lexical";
  if (variant === "all") {
    const lexical = runSingleVariant("lexical", options);
    const fts5 = runSingleVariant("fts5", options);
    const vector = runSingleVariant("vector", options);
    const hybrid = runSingleVariant("hybrid", options);
    return buildComparisonReport(lexical, fts5, vector, hybrid, options);
  }
  return runSingleVariant(variant, options);
}

// ---------------------------------------------------------------------------
// Calibration
// ---------------------------------------------------------------------------

/**
 * Run the abstention / calibration experiment.
 *
 * The function is benchmark-only and does NOT modify the
 * production `recall(text)` behavior, the public MCP API, or
 * the existing single-variant / comparison benchmark report
 * shape. It is a research artifact: a sweep of abstention
 * gates (threshold / margin / ratio) per variant, with
 * per-query diagnostics, so a reviewer can see the
 * trade-off between no-answer TNR and positive retrieval
 * quality.
 *
 * Algorithm:
 *   1. For each variant in the request, run the ranker with
 *      `threshold: 0` and `topK: <options.topK ?? 5>` so we
 *      capture the full score distribution (no candidates
 *      are filtered out by the ranker). The calibration
 *      gates are applied in the JS calibration layer, not in
 *      the ranker, so a single per-query score trace can be
 *      evaluated under every candidate gate.
 *   2. Build the `CalibrationVariantResult` baseline row
 *      (no extra gate) and one row per (gate kind, sweep
 *      value) using `buildSweepForVariant`.
 *   3. Pick the "best" row per variant using the documented
 *      scoring rule (maximize no-answer TNR delta over
 *      baseline, tie-break on smallest positive-regression
 *      count, then on largest hit@5, then on smallest gate
 *      value).
 *   4. Return a `CalibrationReport` artifact. The CLI
 *      entry point writes it to disk under the same
 *      `.cortex/benchmark/` directory.
 *
 * The function is pure: no I/O, no provider calls, no
 * network. It is safe to call from tests.
 */
export function runCalibration(
  options: RetrievalBenchmarkOptions = {},
): CalibrationReport {
  const config: CalibrationConfig = options.calibrationConfig ?? {
    gatesByVariant: {},
    sweep: DEFAULT_CALIBRATION_SWEEP,
  };
  const direction = config.direction ?? "higher-is-better";
  const queries = selectQueries(options);
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const topK = options.topK ?? DEFAULT_TOP_K;

  // Determine which variants to run. Default: all three
  // calibratable variants (matching the comparison report).
  // The `--variant` flag narrows the set. The hybrid
  // variant is intentionally excluded from the
  // calibration experiment: the calibration study is
  // about abstention gates on the single-variant
  // rankers, and the hybrid is a rank-fusion layer that
  // builds on top of them. Calibrating the fusion is a
  // future phase; the v1 contract is "hybrid is rank-
  // only and never produces an abstention gate of its
  // own".
  const requested: BenchmarkVariant = options.variant ?? "all";
  const variants: Array<"lexical" | "fts5" | "vector"> =
    requested === "all"
      ? ["lexical", "fts5", "vector"]
      : requested === "hybrid"
        ? [] // no calibratable single-variant selected
        : [requested];

  // Build the per-query "no threshold" score trace for each
  // variant. We use threshold = 0 for all three so the
  // calibration layer can apply gates independently of the
  // ranker's own threshold. The lexical ranker honors
  // threshold = 0 (passes everything that has any overlap
  // and the min-overlap floor); the FTS5 and vector
  // variants default to threshold = 0 anyway.
  const perVariantTrace: Record<
    "lexical" | "fts5" | "vector",
    Array<{
      queryId: string;
      family: string;
      isPositive: boolean;
      scored: LexicalScoredCandidate[];
    }>
  > = {
    lexical: [],
    fts5: [],
    vector: [],
  };
  for (const v of variants) {
    const rankFn: (
      q: string,
      c: ReadonlyArray<LexicalCandidate>,
    ) => LexicalScoredCandidate[] =
      v === "fts5"
        ? (q, c) =>
            rankFts5(q, c, {
              threshold: 0,
              topK,
            } satisfies Fts5RankingOptions)
        : v === "vector"
          ? (q, c) =>
              rankVector(q, c, {
                threshold: 0,
                topK,
              } satisfies VectorRankingOptions)
          : (q, c) => rankLexical(q, c, { threshold: 0, topK });
    for (const q of queries) {
      const scored = rankFn(q.query, candidates);
      perVariantTrace[v].push({
        queryId: q.id,
        family: q.family,
        isPositive: q.family !== "no-answer",
        scored,
      });
    }
  }

  // Build the baseline + sweep rows for each variant. We
  // also build a "shadow" single-variant report per variant
  // so the baseline row can be sanity-checked against the
  // existing single-variant benchmark's no-answer TNR. The
  // sanity check is performed in the test, not stored on
  // the report.
  const baselineRows: CalibrationVariantResult[] = [];
  const sweepRows: CalibrationVariantResult[] = [];
  const bestByVariant: CalibrationReport["bestByVariant"] = {
    lexical: null,
    fts5: null,
    vector: null,
  };
  for (const v of variants) {
    // Use the regular per-variant runner (with the same
    // options as the calibration pass) so the baseline
    // row's no-answer TNR matches the single-variant
    // benchmark's no-answer TNR exactly. This is the
    // sanity-check anchor.
    const shadow = runSingleVariant(v, options);
    const evals = shadow.evals;
    const { baseline, sweep } = buildSweepForVariant(
      v,
      shadow.metrics,
      evals,
      perVariantTrace[v],
      config.sweep,
      direction,
    );
    baselineRows.push(baseline);
    for (const r of sweep) sweepRows.push(r);
    bestByVariant[v] = pickBestRow(baseline, sweep);
  }
  return {
    generatedAt: new Date().toISOString(),
    config: {
      recordCount: BENCHMARK_RECORDS.length,
      queryCount: queries.length,
      direction,
    },
    baseline: baselineRows,
    sweep: sweepRows,
    bestByVariant,
  };
}

// ---------------------------------------------------------------------------
// Single-variant core
// ---------------------------------------------------------------------------

/**
 * Internal: run a single retrieval variant against the corpus
 * + query set. The returned report is what the public
 * `runRetrievalBenchmark` returns for `"lexical"`, `"fts5"`,
 * `"vector"`, and `"hybrid"`, and what
 * `runRetrievalBenchmark({ variant: "all" })` nests inside
 * the comparison report.
 *
 * The hybrid variant extends the per-query eval with
 * `hybridContributors` and `hybridTopScore` and adds the
 * `hybridPerFamilyDelta` block to the report. The other
 * variants do NOT carry these fields, so the existing
 * per-variant report shapes are byte-stable.
 */
function runSingleVariant(
  variant: "lexical" | "fts5" | "vector" | "hybrid",
  options: RetrievalBenchmarkOptions,
): RetrievalBenchmarkReport {
  const queries = selectQueries(options);
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const topK = options.topK ?? DEFAULT_TOP_K;
  // Per-variant threshold: lexical keeps the production default
  // (0.2) for behavioral parity; FTS5 and vector use 0 (no
  // threshold) by default because their scores are not on the
  // same scale as the lexical Jaccard and the natural
  // separation between "match" and "no match" comes from the
  // ranker returning an empty hit set for missing terms, not
  // from a threshold cut. The hybrid variant mirrors the FTS5
  // / vector default: RRF scores for any candidate with at
  // least one contributing variant are positive, and the
  // default threshold of 0 means "no filter". Callers that
  // want strict parity can still pass `options.threshold` and
  // it will be honored by all four variants.
  const threshold =
    options.threshold ??
    (variant === "fts5"
      ? DEFAULT_FTS5_THRESHOLD
      : variant === "vector"
        ? DEFAULT_VECTOR_THRESHOLD
        : variant === "hybrid"
          ? DEFAULT_HYBRID_THRESHOLD
          : DEFAULT_RELEVANCE_THRESHOLD);
  const rankFn: (q: string, c: ReadonlyArray<LexicalCandidate>) => LexicalScoredCandidate[] =
    variant === "fts5"
      ? (q, c) =>
          rankFts5(q, c, { threshold, topK } satisfies Fts5RankingOptions)
      : variant === "vector"
        ? (q, c) =>
            rankVector(q, c, { threshold, topK } satisfies VectorRankingOptions)
        : variant === "hybrid"
          ? (q, c) =>
              rankHybridAsLexicalShim(q, c, {
                k: options.hybridK ?? DEFAULT_RRF_K,
                threshold,
                topK,
              } satisfies HybridRankingOptions)
          : (q, c) => rankLexical(q, c, { threshold, topK });

  const evals: QueryEval[] = [];
  for (const q of queries) {
    let ranked: LexicalScoredCandidate[];
    let contributors: RrfContributor[] | undefined;
    let topHybridScore: number | null | undefined;
    if (variant === "hybrid") {
      // We call `rankHybrid` (not the lexical-shape
      // shim) so we keep the per-contributor
      // diagnostics for the richer-diagnostics block.
      const hybrid: HybridScoredCandidate[] = rankHybrid(
        q.query,
        candidates,
        {
          k: options.hybridK ?? DEFAULT_RRF_K,
          threshold,
          topK,
        } satisfies HybridRankingOptions,
      );
      ranked = hybrid.map((c) => ({ id: c.id, score: c.score }));
      topHybridScore = ranked.length > 0 ? ranked[0]!.score : null;
      // The contributors for the TOP-1 candidate carry
      // the most signal for a reviewer; the FTS5 / vector
      // / lexical "did this candidate get its rank from
      // any one source?" question is what the brief
      // asks for. We capture the top-1 contributors;
      // the per-source top-K ids / scores are also on
      // `e.topIds` / `e.topScores`.
      if (hybrid.length > 0) {
        const top0 = hybrid[0]!;
        contributors = top0.contributors.map((c) => ({
          source: c.source,
          rank: c.rank,
          score: c.score,
          contribution: c.contribution,
          weight: c.weight,
        }));
      } else {
        // No fused result: build a no-hit contributors
        // entry for each source so the report is
        // well-formed.
        contributors = [
          { source: "lexical", rank: null, score: null, contribution: 0, weight: 1 },
          { source: "fts5", rank: null, score: null, contribution: 0, weight: 1 },
          { source: "vector", rank: null, score: null, contribution: 0, weight: 1 },
        ];
      }
    } else {
      ranked = rankFn(q.query, candidates);
    }
    const topIds = ranked.map((r) => r.id);
    const topScores = ranked.map((r) => r.score);
    const eval_ = evaluateQuery(
      q.id,
      q.family,
      q.query,
      q.expectedIds,
      q.currentTruthIds,
      topIds,
      topScores,
    );
    if (variant === "hybrid") {
      if (contributors) eval_.hybridContributors = contributors;
      eval_.hybridTopScore = topHybridScore ?? null;
    }
    evals.push(eval_);
  }

  const metrics = aggregateMetrics(evals);
  const orientation = aggregateOrientationMetrics(evals);
  const answerQuality = buildAnswerQualityScaffold();
  const failures: FailureEntry[] = evals
    .filter((e) => !e.passed)
    .map((e) => ({
      queryId: e.queryId,
      family: e.family,
      expectedIds: [...e.expectedIds],
      currentTruthIds: [...e.currentTruthIds],
      topIds: [...e.topIds],
      topScores: [...e.topScores],
      rank1: e.rank1,
      currentTruthAt1: e.currentTruthAt1,
      reason: e.reason,
    }));

  const variantLabel: RetrievalBenchmarkReport["variant"] =
    variant === "fts5"
      ? "fts5-benchmark"
      : variant === "vector"
        ? "vector-benchmark"
        : variant === "hybrid"
          ? "hybrid-benchmark"
          : "lexical-baseline";
  const config: RetrievalBenchmarkReport["config"] = {
    threshold,
    topK,
    recordCount: BENCHMARK_RECORDS.length,
    queryCount: queries.length,
  };
  if (variant === "hybrid") {
    config.hybridK = options.hybridK ?? DEFAULT_RRF_K;
  }
  const report: RetrievalBenchmarkReport = {
    generatedAt: new Date().toISOString(),
    variant: variantLabel,
    config,
    evals,
    metrics,
    orientation,
    answerQuality,
    failures,
  };
  // The hybrid single-variant report (when run in
  // isolation, not via `--variant all`) still needs the
  // per-family delta table for the richer-diagnostics
  // block. The comparison-run path attaches the table in
  // `buildComparisonReport`; here we compute the lexical /
  // FTS5 / vector baselines inline (same corpus, same
  // query set, same per-variant default thresholds) and
  // call the same `buildHybridPerFamilyDelta` helper the
  // comparison path uses. The result: a `--variant
  // hybrid` run carries the same real per-family
  // delta table as `--variant all`, instead of a stub
  // with all-zero baselines that misleadingly shows the
  // best baseline as 0. The extra work is the cost of
  // giving the single-variant hybrid report the same
  // diagnostic quality as the comparison report.
  if (variant === "hybrid" && !report.hybridPerFamilyDelta) {
    const baselines = runBaselineMetricsForHybridDelta(queries, options);
    report.hybridPerFamilyDelta = buildHybridPerFamilyDelta(
      metrics,
      baselines.lexical,
      baselines.fts5,
      baselines.vector,
    );
  }
  return report;
}

/**
 * Internal: compute the lexical / FTS5 / vector baseline
 * `BenchmarkMetrics` blocks needed to build the hybrid
 * per-family delta table on a single-variant hybrid run.
 * The function runs each baseline variant on the same
 * query set with the same per-variant default thresholds
 * the canonical single-variant benchmark uses, and
 * returns the aggregated metrics (no full report, no
 * per-query trace). The result feeds
 * `buildHybridPerFamilyDelta` and is then discarded.
 *
 * Why this exists: a `--variant hybrid` run does not go
 * through `buildComparisonReport` (which would otherwise
 * supply the baselines). Without this helper the
 * per-family delta would either be omitted or carry
 * misleading zero baselines. Computing three lightweight
 * per-query evals is cheaper than building three full
 * reports, and the helper is private to this module.
 */
function runBaselineMetricsForHybridDelta(
  queries: ReadonlyArray<BenchmarkQuery>,
  options: RetrievalBenchmarkOptions,
): {
  lexical: BenchmarkMetrics;
  fts5: BenchmarkMetrics;
  vector: BenchmarkMetrics;
} {
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const topK = options.topK ?? DEFAULT_TOP_K;
  // Honor an explicit `options.threshold` for behavioral
  // parity with the main single-variant run; otherwise
  // fall back to the same per-variant defaults the
  // runner uses. The hybrid report's config block also
  // records `threshold`; a reviewer who sees a non-zero
  // threshold there will see the same threshold applied
  // to the baselines.
  const lexicalThreshold = options.threshold ?? DEFAULT_RELEVANCE_THRESHOLD;
  const fts5Threshold = options.threshold ?? DEFAULT_FTS5_THRESHOLD;
  const vectorThreshold = options.threshold ?? DEFAULT_VECTOR_THRESHOLD;
  const rankLex = (q: string): LexicalScoredCandidate[] =>
    rankLexical(q, candidates, { threshold: lexicalThreshold, topK });
  const rankFts = (q: string): LexicalScoredCandidate[] =>
    rankFts5(q, candidates, {
      threshold: fts5Threshold,
      topK,
    } satisfies Fts5RankingOptions);
  const rankVec = (q: string): LexicalScoredCandidate[] =>
    rankVector(q, candidates, {
      threshold: vectorThreshold,
      topK,
    } satisfies VectorRankingOptions);
  const buildEvals = (
    rankFn: (q: string) => LexicalScoredCandidate[],
  ): QueryEval[] =>
    queries.map((q) => {
      const ranked = rankFn(q.query);
      return evaluateQuery(
        q.id,
        q.family,
        q.query,
        q.expectedIds,
        q.currentTruthIds,
        ranked.map((r) => r.id),
        ranked.map((r) => r.score),
      );
    });
  return {
    lexical: aggregateMetrics(buildEvals(rankLex)),
    fts5: aggregateMetrics(buildEvals(rankFts)),
    vector: aggregateMetrics(buildEvals(rankVec)),
  };
}

/**
 * Tiny shim that calls `rankHybrid` and projects the result
 * into the `LexicalScoredCandidate[]` shape. Used as the
 * `rankFn` for the hybrid variant in `runSingleVariant`
 * when the per-query `hybridContributors` diagnostic is
 * not needed (i.e. the helper path; the main per-query
 * loop calls `rankHybrid` directly to capture the
 * contributors).
 *
 * Kept as a separate named function so the `rankFn`
 * selector above stays a one-liner ternary chain.
 */
function rankHybridAsLexicalShim(
  query: string,
  candidates: ReadonlyArray<LexicalCandidate>,
  options: HybridRankingOptions,
): LexicalScoredCandidate[] {
  return rankHybrid(query, candidates, options).map((c) => ({
    id: c.id,
    score: c.score,
  }));
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * Internal: build a comparison report from three single-variant
 * reports. The comparison block is a small set of headline
 * metric rows: rank1, currentTruthAt1, hit@1, hit@3, hit@5,
 * and no-answer TNR. Per-family deltas are out of scope for
 * the v1 comparison; a future phase can add them.
 *
 * The `delta` field is the FTS5 minus lexical difference for
 * that metric. A positive delta means FTS5 is better; a
 * negative delta means lexical is better. The vector column
 * is included for the A/B/C view but the delta is computed
 * against the lexical baseline for backward-compat with the
 * two-variant comparison shape.
 */
function buildComparisonReport(
  lexical: RetrievalBenchmarkReport,
  fts5: RetrievalBenchmarkReport,
  vector: RetrievalBenchmarkReport,
  hybrid: RetrievalBenchmarkReport,
  options: RetrievalBenchmarkOptions,
): ComparisonBenchmarkReport {
  const L = lexical.metrics;
  const F = fts5.metrics;
  const V = vector.metrics;
  const H = hybrid.metrics;
  const Ld = L.derived;
  const Fd = F.derived;
  const Vd = V.derived;
  const Hd = H.derived;
  // Raw rows: lexical / fts5 / vector / hybrid are the
  // underlying numbers, and `delta` is the exact
  // `fts5 - lexical` difference (kept for backward-
  // compat with the two-variant comparison shape; a
  // separate `hybridPerFamilyDelta` block carries the
  // hybrid-specific deltas). The
  // `formatComparisonReport` helper formats these for
  // the human report (integer counts stay integer,
  // percentages render as one-decimal points). The
  // contract `r.delta === r.fts5 - r.lexical` holds
  // because we don't round the JSON values.
  const countRow = (
    metric: string,
    l: number,
    f: number,
    v: number,
    h: number,
  ): ComparisonRow => ({
    metric,
    lexical: l,
    fts5: f,
    vector: v,
    hybrid: h,
    delta: f - l,
  });
  const rows: ComparisonRow[] = [
    countRow("rank1 (positive)", L.rank1, F.rank1, V.rank1, H.rank1),
    countRow("currentTruth@1 (positive)", L.currentTruthAt1, F.currentTruthAt1, V.currentTruthAt1, H.currentTruthAt1),
    countRow("hit@1 (positive)", L.hitAt1, F.hitAt1, V.hitAt1, H.hitAt1),
    countRow("hit@3 (positive)", L.hitAt3, F.hitAt3, V.hitAt3, H.hitAt3),
    countRow("hit@5 (positive)", L.hitAt5, F.hitAt5, V.hitAt5, H.hitAt5),
    countRow("no-answer TNR", L.noAnswerCorrect, F.noAnswerCorrect, V.noAnswerCorrect, H.noAnswerCorrect),
    countRow("precision@5 (%)", Ld.precisionAtK * 100, Fd.precisionAtK * 100, Vd.precisionAtK * 100, Hd.precisionAtK * 100),
    countRow("recall@5 (%)", Ld.recallAtK * 100, Fd.recallAtK * 100, Vd.recallAtK * 100, Hd.recallAtK * 100),
    countRow("F1@5 (%)", Ld.f1At5 * 100, Fd.f1At5 * 100, Vd.f1At5 * 100, Hd.f1At5 * 100),
    countRow("MRR@5 (%)", Ld.mrrAtK * 100, Fd.mrrAtK * 100, Vd.mrrAtK * 100, Hd.mrrAtK * 100),
    countRow("currentTruth@5 (%)", Ld.currentTruthRecallAt5 * 100, Fd.currentTruthRecallAt5 * 100, Vd.currentTruthRecallAt5 * 100, Hd.currentTruthRecallAt5 * 100),
    countRow("answer coverage (%)", Ld.answerCoverage * 100, Fd.answerCoverage * 100, Vd.answerCoverage * 100, Hd.answerCoverage * 100),
    countRow("abstention precision (%)", Ld.abstentionPrecision * 100, Fd.abstentionPrecision * 100, Vd.abstentionPrecision * 100, Hd.abstentionPrecision * 100),
    countRow("specificity (no-answer, %)", Ld.noAnswerSpecificity * 100, Fd.noAnswerSpecificity * 100, Vd.noAnswerSpecificity * 100, Hd.noAnswerSpecificity * 100),
    countRow("confabulation FPR (%)", Ld.noAnswerFpr * 100, Fd.noAnswerFpr * 100, Vd.noAnswerFpr * 100, Hd.noAnswerFpr * 100),
    countRow("multi-hop partial (%)", Ld.multiHopAnyRate * 100, Fd.multiHopAnyRate * 100, Vd.multiHopAnyRate * 100, Hd.multiHopAnyRate * 100),
    countRow("multi-hop complete (%)", Ld.multiHopCompleteRate * 100, Fd.multiHopCompleteRate * 100, Vd.multiHopCompleteRate * 100, Hd.multiHopCompleteRate * 100),
    countRow("orientation recall@5 (%)",
      lexical.orientation.total > 0 ? (lexical.orientation.recallAt5 * 100) / lexical.orientation.total : 0,
      fts5.orientation.total > 0 ? (fts5.orientation.recallAt5 * 100) / fts5.orientation.total : 0,
      vector.orientation.total > 0 ? (vector.orientation.recallAt5 * 100) / vector.orientation.total : 0,
      hybrid.orientation.total > 0 ? (hybrid.orientation.recallAt5 * 100) / hybrid.orientation.total : 0,
    ),
    countRow("orientation slotCoverage@5 (%)",
      lexical.orientation.slotCoverageAt5 * 100,
      fts5.orientation.slotCoverageAt5 * 100,
      vector.orientation.slotCoverageAt5 * 100,
      hybrid.orientation.slotCoverageAt5 * 100,
    ),
    countRow("orientation noisyReturnRate (%)",
      lexical.orientation.noisyReturnRate * 100,
      fts5.orientation.noisyReturnRate * 100,
      vector.orientation.noisyReturnRate * 100,
      hybrid.orientation.noisyReturnRate * 100,
    ),
  ];
  // The per-family "hybrid vs best baseline" delta table.
  // The richer-diagnostics block the brief asks for.
  const hybridPerFamilyDelta = buildHybridPerFamilyDelta(
    hybrid.metrics,
    lexical.metrics,
    fts5.metrics,
    vector.metrics,
  );
  // The per-family delta is also attached to the hybrid
  // single-variant report so a `--variant hybrid` run
  // carries the same richer-diagnostics block the
  // comparison report does.
  hybrid.hybridPerFamilyDelta = hybridPerFamilyDelta;
  const config: ComparisonBenchmarkReport["config"] = {
    recordCount: BENCHMARK_RECORDS.length,
    queryCount: lexical.config.queryCount,
  };
  if (options.hybridK !== undefined) {
    config.hybridK = options.hybridK;
  }
  return {
    generatedAt: new Date().toISOString(),
    variant: "all",
    config,
    lexical,
    fts5,
    vector,
    hybrid,
    comparison: rows,
    hybridPerFamilyDelta,
  };
}

// ---------------------------------------------------------------------------
// Human summary
// ---------------------------------------------------------------------------

function pct(n: number, d: number): string {
  if (d === 0) return "n/a";
  return `${((n / d) * 100).toFixed(1)}%`;
}

export function formatHumanReport(report: RetrievalBenchmarkReport): string {
  const lines: string[] = [];
  lines.push("=== cortex-mcp-v2 retrieval benchmark ===");
  lines.push(`variant:      ${report.variant}`);
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push("");
  lines.push("--- config ---");
  lines.push(`  threshold:   ${report.config.threshold}`);
  lines.push(`  top-k:       ${report.config.topK}`);
  if (report.config.hybridK !== undefined) {
    lines.push(`  hybrid-k:    ${report.config.hybridK}`);
  }
  lines.push(`  records:     ${report.config.recordCount}`);
  lines.push(`  queries:     ${report.config.queryCount}`);
  lines.push("");
  lines.push("--- metrics ---");
  const m = report.metrics;
  const d = m.derived;
  lines.push(`  total queries:        ${m.totalQueries}`);
  lines.push(
    `  rank1 (top-hit, positive):      ${m.rank1} / ${m.positiveTotal} = ${pct(m.rank1, m.positiveTotal)}`,
  );
  lines.push(
    `  current-truth@1 (positive):     ${m.currentTruthAt1} / ${m.positiveTotal} = ${pct(m.currentTruthAt1, m.positiveTotal)}`,
  );
  lines.push(
    `  hit@1 (positive):               ${m.hitAt1} / ${m.positiveTotal} = ${pct(m.hitAt1, m.positiveTotal)}`,
  );
  lines.push(
    `  hit@3 (positive):               ${m.hitAt3} / ${m.positiveTotal} = ${pct(m.hitAt3, m.positiveTotal)}`,
  );
  lines.push(
    `  hit@5 (positive):               ${m.hitAt5} / ${m.positiveTotal} = ${pct(m.hitAt5, m.positiveTotal)}`,
  );
  lines.push(
    `  no-answer TNR:                  ${m.noAnswerCorrect} / ${m.noAnswerTotal} = ${pct(m.noAnswerCorrect, m.noAnswerTotal)}`,
  );
  lines.push("");
  lines.push("--- IR (precision/recall/F1/MRR) ---");
  lines.push(
    `  precision@5  ${pct(d.precisionAtK, 1)}   (tp=${d.tp} fp=${d.fp} fn=${d.fn})`,
  );
  lines.push(
    `  recall@5     ${pct(d.recallAtK, 1)}`,
  );
  lines.push(
    `  F1@5         ${pct(d.f1At5, 1)}`,
  );
  lines.push(
    `  MRR@5        ${pct(d.mrrAtK, 1)}`,
  );
  lines.push("");
  lines.push("--- currentTruth (positive queries) ---");
  lines.push(
    `  currentTruth@1: ${d.currentTruthAt1} / ${d.positiveTotalForCurrentTruth} = ${pct(d.currentTruthAt1, d.positiveTotalForCurrentTruth)}`,
  );
  lines.push(
    `  currentTruth@3: ${d.currentTruthAt3} / ${d.positiveTotalForCurrentTruth} = ${pct(d.currentTruthAt3, d.positiveTotalForCurrentTruth)}`,
  );
  lines.push(
    `  currentTruth@5: ${d.currentTruthAt5} / ${d.positiveTotalForCurrentTruth} = ${pct(d.currentTruthAt5, d.positiveTotalForCurrentTruth)}`,
  );
  lines.push(
    `  currentTruthRecall@5 = ${pct(d.currentTruthRecallAt5, 1)}`,
  );
  lines.push("");
  lines.push("--- no-answer confusion matrix ---");
  lines.push(
    `  TP=${d.noAnswerTp}  FP=${d.noAnswerFp}  TN=${d.noAnswerTn}  FN=${d.noAnswerFn}`,
  );
  lines.push(
    `  specificity (TNR)   = ${pct(d.noAnswerSpecificity, 1)}`,
  );
  lines.push(
    `  confabulation (FPR) = ${pct(d.noAnswerFpr, 1)}`,
  );
  lines.push(
    `  answer coverage     = ${pct(d.answerCoverage, 1)}`,
  );
  lines.push(
    `  abstention precision= ${pct(d.abstentionPrecision, 1)}`,
  );
  lines.push("");
  lines.push("--- multi-hop coverage ---");
  lines.push(
    `  partial (>=1 expected in top-K): ${d.multiHopAny} / ${d.multiHopTotal} = ${pct(d.multiHopAnyRate, 1)}`,
  );
  lines.push(
    `  complete (all expected in top-K): ${d.multiHopComplete} / ${d.multiHopTotal} = ${pct(d.multiHopCompleteRate, 1)}`,
  );
  lines.push("");
  lines.push("--- score diagnostics ---");
  lines.push(
    `  meanTopScore (all)    = ${d.meanTopScore.toFixed(3)} (n=${d.scoreSampleCountAll})`,
  );
  lines.push(
    `  meanTopScore (pass)   = ${d.meanTopScorePass.toFixed(3)} (n=${d.scoreSampleCountPass})`,
  );
  lines.push(
    `  meanTopScore (fail)   = ${d.meanTopScoreFail.toFixed(3)} (n=${d.scoreSampleCountFail})`,
  );
  lines.push(
    `  meanTopScore (no-ans) = ${d.meanTopScoreNoAnswer.toFixed(3)} (n=${d.scoreSampleCountNoAnswer})`,
  );
  lines.push(
    `  meanScoreGap1To2      = ${d.meanScoreGap1To2.toFixed(3)}`,
  );
  lines.push(
    `  meanReturnedCount     = ${d.meanReturnedCount.toFixed(2)}`,
  );
  lines.push("");
  lines.push("--- orientation (project-status queries) ---");
  if (report.orientation.total === 0) {
    lines.push("  (no orientation queries in this run)");
  } else {
    const o = report.orientation;
    lines.push(`  queries:           ${o.total}`);
    lines.push(
      `  recall@1:          ${o.recallAt1} / ${o.total} = ${pct(o.recallAt1, o.total)}`,
    );
    lines.push(
      `  recall@3:          ${o.recallAt3} / ${o.total} = ${pct(o.recallAt3, o.total)}`,
    );
    lines.push(
      `  recall@5:          ${o.recallAt5} / ${o.total} = ${pct(o.recallAt5, o.total)}`,
    );
    lines.push(
      `  slotCoverage@5:    ${o.slotsHit} / ${o.slotsExpected} = ${pct(o.slotCoverageAt5, 1)}`,
    );
    lines.push(
      `  noisyReturnRate:   ${o.noisyReturnQueries} / ${o.total} = ${pct(o.noisyReturnRate, 1)}`,
    );
    lines.push(
      `  meanNoisePerQuery: ${o.meanNoisePerQuery.toFixed(2)}`,
    );
    lines.push(
      `  currentTruthCov@5: ${o.currentTruthCoverageAt5} / ${o.total} = ${pct(o.currentTruthCoverageAt5Rate, 1)}`,
    );
  }
  lines.push("");
  lines.push("--- answer-quality scaffold ---");
  lines.push(`  ${ANSWER_QUALITY_DISABLED_LABEL}`);
  lines.push(`  note: ${report.answerQuality.note}`);
  lines.push("");
  lines.push("--- per-family ---");
  const families = Object.keys(m.perFamily).sort();
  if (families.length === 0) {
    lines.push("  (no families — check --only-family filter)");
  }
  for (const f of families) {
    const s = m.perFamily[f]!;
    const isNoAnswer = f === "no-answer";
    if (isNoAnswer) {
      lines.push(
        `  ${f.padEnd(12)} total=${s.total} passed=${s.passed} (no-answer TNR=${pct(s.noAnswerCorrect, s.total)})`,
      );
    } else {
      lines.push(
        `  ${f.padEnd(12)} total=${s.total} passed=${s.passed} ` +
          `rank1=${pct(s.rank1, s.total)} ` +
          `curTruth@1=${pct(s.currentTruthAt1, s.total)} ` +
          `p@5=${pct(s.precisionAt5, 1)} ` +
          `r@5=${pct(s.recallAt5, 1)} ` +
          `f1@5=${pct(s.f1At5, 1)} ` +
          `mrr@5=${pct(s.mrrAt5, 1)} ` +
          `hit@1=${pct(s.hitAt1, s.total)} ` +
          `hit@3=${pct(s.hitAt3, s.total)} ` +
          `hit@5=${pct(s.hitAt5, s.total)}`,
      );
    }
  }
  lines.push("");
  // Structured failure categories. The per-family lines
  // above are the table; this block is the labeled
  // categoriser output so a reviewer can see the failure
  // mode at a glance.
  const catLines: string[] = [];
  const catNames = Object.keys(m.failureCategories).sort();
  for (const c of catNames) {
    catLines.push(`  ${c.padEnd(40)} ${m.failureCategories[c]}`);
  }
  lines.push("--- failure categories ---");
  if (catLines.length === 0) {
    lines.push("  (none)");
  } else {
    lines.push(...catLines);
  }
  lines.push("");
  // Rank-1 misses: positive queries whose top result is NOT the
  // expected id. Includes queries that still passed hit@K (e.g.
  // a temporal query where the old fact is at the top but the
  // new fact is somewhere in the top-K). This is the gap the
  // reviewer flagged; making it visible in the headline summary
  // is the whole point of the stricter rank1 metric.
  const rank1Misses = report.evals.filter(
    (e) => e.expectedIds.length > 0 && !e.rank1,
  );
  lines.push("--- rank-1 misses (top-hit wrong, hit@K may still pass) ---");
  if (rank1Misses.length === 0) {
    lines.push("  (none)");
  } else {
    for (const e of rank1Misses) {
      const expected =
        e.expectedIds.length === 0 ? "(none)" : e.expectedIds.join(", ");
      const top0 =
        e.topIds.length === 0 ? "(empty)" : String(e.topIds[0]);
      lines.push(`  [${e.family}] ${e.queryId}`);
      lines.push(`     expected top-hit: ${expected}`);
      lines.push(`     actual top-hit:   ${top0}`);
      lines.push(
        `     current-truth@1:  ${e.currentTruthAt1 ? "yes" : "no"} ` +
          `(hit@K=${e.passed ? "pass" : "fail"})`,
      );
    }
  }
  lines.push("");
  lines.push("--- failures (hit@K contract miss) ---");
  if (report.failures.length === 0) {
    lines.push("  (none)");
  } else {
    for (const f of report.failures) {
      const expected =
        f.expectedIds.length === 0
          ? "(none)"
          : f.expectedIds.join(", ");
      const actual =
        f.topIds.length === 0 ? "(empty)" : f.topIds.join(", ");
      lines.push(`  [${f.family}] ${f.queryId}`);
      lines.push(`     expected: ${expected}`);
      lines.push(`     actual:   ${actual}`);
      lines.push(`     reason:   ${f.reason}`);
    }
  }
  // Hybrid-only richer-diagnostics sections. The
  // lexical / FTS5 / vector reports do not carry these
  // blocks; the hybrid report does, and the comparison
  // report delegates to `formatHumanReport` per variant
  // so the same block appears in the `### hybrid ###`
  // section of the comparison view.
  if (report.variant === "hybrid-benchmark" && report.hybridPerFamilyDelta) {
    lines.push("");
    lines.push("--- hybrid per-family (vs best baseline) ---");
    lines.push(
      "  family         total  hybrid(rank1)  best(rank1)  Δhybrid  " +
        "hybrid(hit5)  ΔvsLexical  bestSources",
    );
    for (const row of report.hybridPerFamilyDelta) {
      const sources =
        row.bestBaselineSources.length === 0
          ? "-"
          : row.bestBaselineSources.join("/");
      const delta = row.deltaHybridVsBest;
      const sign = delta > 0 ? "+" : delta < 0 ? "" : "=";
      lines.push(
        `  ${row.family.padEnd(14)} ${String(row.total).padStart(3)}  ` +
          `${String(row.hybridRank1).padStart(13)}  ` +
          `${String(row.bestBaselineRank1).padStart(12)}  ` +
          `${(sign + String(delta)).padStart(7)}  ` +
          `${String(row.hybridHit5).padStart(12)}  ` +
          `${String(row.deltaHybridVsLexical).padStart(11)}  ` +
          `${sources}`,
      );
    }
  }
  if (report.variant === "hybrid-benchmark") {
    lines.push("");
    lines.push("--- hybrid contributors (top-1 per query) ---");
    let contribLines = 0;
    const maxContribLines = 12;
    for (const e of report.evals) {
      if (contribLines >= maxContribLines) break;
      if (!e.hybridContributors) continue;
      const top0 = e.topIds.length === 0 ? "(empty)" : String(e.topIds[0]);
      const total = e.hybridTopScore ?? 0;
      const contributors = e.hybridContributors
        .map((c) => {
          if (c.rank === null) {
            return `${c.source}=absent`;
          }
          return `${c.source}=rank${c.rank}(${c.contribution.toFixed(4)})`;
        })
        .join(" ");
      lines.push(
        `  [${e.family}] ${e.queryId}` +
          `  topId=${top0}  rrf=${total.toFixed(4)}  contributors: ${contributors}`,
      );
      contribLines += 1;
    }
    if (contribLines === 0) {
      lines.push("  (no contributor diagnostics — empty result set)");
    } else {
      lines.push(
        `  ... (${report.evals.length - contribLines} more queries; full trace in the JSON artifact)`,
      );
    }
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Comparison report (human)
// ---------------------------------------------------------------------------

/**
 * Format a side-by-side human-readable comparison report.
 * The per-variant sections use the same `formatHumanReport`
 * helper so the on-disk JSON + the stdout view are
 * structurally consistent.
 */
export function formatComparisonReport(
  report: ComparisonBenchmarkReport,
): string {
  const lines: string[] = [];
  lines.push("=== cortex-mcp-v2 retrieval benchmark (variant=all) ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push(
    `  records:     ${report.config.recordCount}`,
  );
  lines.push(`  queries:     ${report.config.queryCount}`);
  if (report.config.hybridK !== undefined) {
    lines.push(`  hybrid-k:    ${report.config.hybridK}`);
  }
  lines.push("");
  // Headline comparison table first so the reader can see the
  // delta before scrolling through per-variant details.
  lines.push("--- comparison (lexical vs fts5 vs vector vs hybrid) ---");
  const rows = [...report.comparison];
  for (const r of rows) {
    // The comparison table mixes integer counts (e.g. rank1)
    // and percentages (e.g. precision@5). The percentage
    // rows are tagged with "(%)" in the metric label so
    // the reader can scan them at a glance.
    const isPct = r.metric.includes("(%)");
    const fmt = (n: number): string => {
      if (isPct) return n.toFixed(1).padStart(5);
      return n.toString().padStart(3);
    };
    const arrow = r.delta > 0 ? "+" : r.delta < 0 ? "" : "=";
    const deltaStr = isPct ? r.delta.toFixed(1) : r.delta.toString();
    lines.push(
      `  ${r.metric.padEnd(30)}  lexical=${fmt(r.lexical)}  fts5=${fmt(r.fts5)}  vector=${fmt(r.vector)}  hybrid=${fmt(r.hybrid)}  delta(fts5-lex)=${arrow}${deltaStr}`,
    );
  }
  // Hybrid per-family "vs best baseline" table. The
  // richer-diagnostics block the brief asks for. Lives
  // next to the per-variant details so a reviewer can
  // scan it once.
  if (report.hybridPerFamilyDelta && report.hybridPerFamilyDelta.length > 0) {
    lines.push("");
    lines.push("--- hybrid per-family (vs best baseline) ---");
    lines.push(
      "  family         total  hybrid(rank1)  best(rank1)  Δhybrid  " +
        "hybrid(hit5)  ΔvsLexical  bestSources",
    );
    for (const row of report.hybridPerFamilyDelta) {
      const sources =
        row.bestBaselineSources.length === 0
          ? "-"
          : row.bestBaselineSources.join("/");
      const delta = row.deltaHybridVsBest;
      const sign = delta > 0 ? "+" : delta < 0 ? "" : "=";
      lines.push(
        `  ${row.family.padEnd(14)} ${String(row.total).padStart(3)}  ` +
          `${String(row.hybridRank1).padStart(13)}  ` +
          `${String(row.bestBaselineRank1).padStart(12)}  ` +
          `${(sign + String(delta)).padStart(7)}  ` +
          `${String(row.hybridHit5).padStart(12)}  ` +
          `${String(row.deltaHybridVsLexical).padStart(11)}  ` +
          `${sources}`,
      );
    }
  }
  lines.push("");
  lines.push("### lexical ###");
  lines.push(formatHumanReport(report.lexical));
  lines.push("");
  lines.push("### fts5 ###");
  lines.push(formatHumanReport(report.fts5));
  lines.push("");
  lines.push("### vector ###");
  lines.push(formatHumanReport(report.vector));
  lines.push("");
  lines.push("### hybrid ###");
  lines.push(formatHumanReport(report.hybrid));
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Calibration report (human)
// ---------------------------------------------------------------------------

/**
 * Format a human-readable calibration report.
 *
 * The report has four sections:
 *   1. A small header with the artifact metadata.
 *   2. A per-variant "best" row (one per variant). The row
 *      is picked by the rule in `pickBestRow`.
 *   3. A per-variant, per-gate-kind sweep table. Each row
 *      shows the trade-off (TNR, FPR, regressions, hit@5,
 *      rank1, currentTruth@1) for one candidate gate value.
 *   4. A per-query diagnostics block. Only the most
 *      informative queries (forced abstention, no-answer
 *      fix, or natural abstention) are listed by default to
 *      keep the report readable. The full per-query trace
 *      is on disk in the JSON artifact.
 */
export function formatCalibrationReport(
  report: CalibrationReport,
  options: { perQueryLimit?: number } = {},
): string {
  const perQueryLimit = options.perQueryLimit ?? 20;
  const lines: string[] = [];
  lines.push("=== cortex-mcp-v2 retrieval calibration ===");
  lines.push(`generated at: ${report.generatedAt}`);
  lines.push(`  records:    ${report.config.recordCount}`);
  lines.push(`  queries:    ${report.config.queryCount}`);
  lines.push(`  direction:  ${report.config.direction}`);
  lines.push("");
  // Best rows.
  lines.push("--- best per variant ---");
  for (const v of ["lexical", "fts5", "vector"] as const) {
    const b = report.bestByVariant[v];
    if (!b) {
      lines.push(`  ${v.padEnd(8)} (no sweep rows)`);
      continue;
    }
    const baseTnr = baselineTnrForVariant(report, v);
    const tnr = b.metrics.noAnswerTotal > 0
      ? (b.metrics.noAnswerCorrect / b.metrics.noAnswerTotal) * 100
      : 0;
    const deltaTnr = tnr - baseTnr;
    lines.push(
      `  ${v.padEnd(8)} gate=${b.gateLabel.padEnd(20)} ` +
        `TNR=${tnr.toFixed(1)}% (Δ${deltaTnr >= 0 ? "+" : ""}${deltaTnr.toFixed(1)}pp) ` +
        `regressions=${b.positiveRegressions} ` +
        `hit@5=${b.metrics.hitAt5} ` +
        `rank1=${b.metrics.rank1} ` +
        `noAnsFixed=${b.noAnswerFixed} ` +
        `noAnsRemaining=${b.noAnswerRemainingFp}`,
    );
  }
  lines.push("");
  // Sweep tables grouped by variant then by gate kind.
  const byVariant: Record<"lexical" | "fts5" | "vector", CalibrationVariantResult[]> = {
    lexical: [],
    fts5: [],
    vector: [],
  };
  for (const r of report.sweep) byVariant[r.variant].push(r);
  const kinds: CalibrationVariantResult["gateKind"][] = [
    "threshold",
    "margin",
    "ratio",
  ];
  for (const v of ["lexical", "fts5", "vector"] as const) {
    const rows = byVariant[v];
    if (rows.length === 0) continue;
    lines.push(`### ${v} sweep ###`);
    // Baseline row first.
    const base = report.baseline.find((b) => b.variant === v);
    if (base) {
      lines.push(
        `  ${"no-extra-gate".padEnd(20)} ` +
          `TNR=${tnrPct(base)} ` +
          `hit@5=${base.metrics.hitAt5} ` +
          `rank1=${base.metrics.rank1} ` +
          `regressions=${base.positiveRegressions} ` +
          `noAnsFixed=${base.noAnswerFixed} ` +
          `noAnsRemain=${base.noAnswerRemainingFp}`,
      );
    }
    for (const k of kinds) {
      const sub = rows.filter((r) => r.gateKind === k);
      if (sub.length === 0) continue;
      lines.push(`  -- ${k} --`);
      for (const r of sub) {
        lines.push(
          `  ${r.gateLabel.padEnd(20)} ` +
            `TNR=${tnrPct(r)} ` +
            `hit@5=${r.metrics.hitAt5} ` +
            `rank1=${r.metrics.rank1} ` +
            `regressions=${r.positiveRegressions} ` +
            `noAnsFixed=${r.noAnswerFixed} ` +
            `noAnsRemain=${r.noAnswerRemainingFp}`,
        );
      }
    }
    lines.push("");
  }
  // Per-query diagnostics summary: only the rows that are
  // informative. The "best" rows are the natural anchor;
  // for each variant we list the forced-abstention positive
  // queries and the no-answer FPs that were fixed.
  //
  // Counts are computed BEFORE the perQueryLimit slice, and
  // the human-readable summary labels truncation clearly
  // (e.g. "24 (showing first 20)"). The slice only limits
  // the per-row drill-down list. The on-disk JSON artifact
  // is unaffected; the artifact's `diagnostics` array still
  // carries every query, and the headline
  // `positiveRegressions` / `noAnswerFixed` /
  // `noAnswerRemainingFp` numbers on the row are the true
  // totals (those are the numbers a reviewer should trust).
  lines.push("--- per-query diagnostics (best per variant) ---");
  for (const v of ["lexical", "fts5", "vector"] as const) {
    const b = report.bestByVariant[v];
    if (!b) continue;
    lines.push(`  variant=${v} gate=${b.gateLabel}`);
    // Positive queries forced to abstain.
    const regressionsAll = b.diagnostics.filter(
      (d) => d.isPositive && d.abstained,
    );
    const regressions = regressionsAll.slice(0, perQueryLimit);
    lines.push(
      `    positive queries forced to abstain: ${regressionsAll.length}` +
        (regressionsAll.length > perQueryLimit
          ? ` (showing first ${perQueryLimit})`
          : ""),
    );
    for (const d of regressions) {
      lines.push(
        `      [${d.family}] ${d.queryId}  topScore=${d.topScore.toFixed(3)} ` +
          `gap=${d.scoreGap.toFixed(3)} ratio=${formatRatio(d.scoreRatio)} ` +
          `gate=${d.abstainedByGate.join("|") || "(none)"}`,
      );
    }
    // No-answer queries fixed by abstention.
    const fixedAll = b.diagnostics.filter(
      (d) => !d.isPositive && d.abstained && !d.naturallyAbstained,
    );
    const fixed = fixedAll.slice(0, perQueryLimit);
    lines.push(
      `    no-answer queries fixed by abstention: ${fixedAll.length}` +
        (fixedAll.length > perQueryLimit
          ? ` (showing first ${perQueryLimit})`
          : ""),
    );
    for (const d of fixed) {
      lines.push(
        `      [${d.family}] ${d.queryId}  topScore=${d.topScore.toFixed(3)} ` +
          `gap=${d.scoreGap.toFixed(3)} ratio=${formatRatio(d.scoreRatio)} ` +
          `gate=${d.abstainedByGate.join("|") || "(none)"}`,
      );
    }
    // No-answer queries still confabulating.
    const remainAll = b.diagnostics.filter(
      (d) => !d.isPositive && !d.abstained,
    );
    const remain = remainAll.slice(0, perQueryLimit);
    lines.push(
      `    no-answer queries still confabulating: ${remainAll.length}` +
        (remainAll.length > perQueryLimit
          ? ` (showing first ${perQueryLimit})`
          : ""),
    );
    for (const d of remain) {
      lines.push(
        `      [${d.family}] ${d.queryId}  topScore=${d.topScore.toFixed(3)} ` +
          `gap=${d.scoreGap.toFixed(3)} ratio=${formatRatio(d.scoreRatio)} ` +
          `before=${d.originalTopIds.join(",") || "(empty)"}`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

function tnrPct(r: CalibrationVariantResult): string {
  if (r.metrics.noAnswerTotal === 0) return "n/a";
  return `${((r.metrics.noAnswerCorrect / r.metrics.noAnswerTotal) * 100).toFixed(1)}%`;
}

function baselineTnrForVariant(
  report: CalibrationReport,
  v: "lexical" | "fts5" | "vector",
): number {
  const b = report.baseline.find((x) => x.variant === v);
  if (!b || b.metrics.noAnswerTotal === 0) return 0;
  return (b.metrics.noAnswerCorrect / b.metrics.noAnswerTotal) * 100;
}

function formatRatio(r: number): string {
  if (!Number.isFinite(r)) return "Inf";
  if (r === 0) return "0";
  if (r >= 100) return r.toFixed(0);
  if (r >= 10) return r.toFixed(1);
  return r.toFixed(2);
}

// ---------------------------------------------------------------------------
// CLI entry point
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const opts = parseRetrievalCli(process.argv.slice(2));
  const variant: BenchmarkVariant = opts.variant ?? "lexical";
  const report = runRetrievalBenchmark(opts);
  const dir = resolveBenchmarkArtifactsDir(opts);
  const written: string[] = [];
  if (variant === "all") {
    // The CLI writes four artifacts for a comparison run:
    //   - one lexical single-variant file
    //   - one fts5 single-variant file
    //   - one vector single-variant file
    //   - one combined comparison file
    // The combined file is what the human summary uses; the
    // per-variant files are kept so existing tooling that
    // expects `retrieval-baseline-*.json` still finds one.
    if (isComparisonReport(report)) {
      // The CLI writes five artifacts for a comparison run:
      //   - one lexical single-variant file
      //   - one fts5 single-variant file
      //   - one vector single-variant file
      //   - one hybrid single-variant file
      //   - one combined comparison file
      // The combined file is what the human summary uses; the
      // per-variant files are kept so existing tooling that
      // expects `retrieval-baseline-*.json` / `retrieval-fts5-*.json`
      // / `retrieval-vector-*.json` still finds one, and a
      // `retrieval-hybrid-*.json` is added next to them.
      written.push(writeBenchmarkReport(report.lexical, dir));
      written.push(writeBenchmarkReport(report.fts5, dir));
      written.push(writeBenchmarkReport(report.vector, dir));
      written.push(writeBenchmarkReport(report.hybrid, dir));
      written.push(writeComparisonReport(report, dir));
      process.stdout.write(formatComparisonReport(report) + "\n");
    }
  } else {
    // Single-variant run. The report IS a
    // `RetrievalBenchmarkReport`. Use a custom type guard to
    // narrow: comparison reports have `lexical` / `fts5`
    // fields, single reports have `evals` / `metrics` /
    // `failures`. The discriminant `"variant" in report` does
    // not narrow because both shapes declare it.
    if (!isSingleVariantReport(report)) {
      throw new Error("internal: single-variant run produced a comparison report");
    }
    const file = writeBenchmarkReport(report, dir);
    written.push(file);
    process.stdout.write(formatHumanReport(report) + "\n");
  }
  for (const f of written) {
    process.stdout.write(`\nartifact written: ${f}\n`);
  }
  // Calibration: benchmark-only abstention / gate sweep.
  // Always opt-in via --calibrate; the existing single-
  // variant and comparison reports are unaffected when
  // the flag is not set.
  if (opts.calibration) {
    const calReport = runCalibration(opts);
    const calFile = writeCalibrationReport(calReport, dir);
    written.push(calFile);
    process.stdout.write("\n" + formatCalibrationReport(calReport) + "\n");
    process.stdout.write(`\nartifact written: ${calFile}\n`);
  }
}

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
    process.stderr.write(`[cortex-benchmark] FATAL ${msg}\n`);
    process.exit(1);
  });
}

// Re-export the family type so callers can build their own
// filters without redeclaring the union.
export type { BenchmarkQueryFamily };
