/**
 * Benchmark harness for the production superseded-memory demotion helper.
 *
 * This harness exercises the actual `demoteSupersededMemories` production
 * helper (not a simulation) using the same simulated supersession edges
 * as `supersession-edge-simulation`. The harness:
 *
 *   1. Loads the most recent lexical-baseline benchmark artifact under
 *      `.curion/benchmark/`. The artifact's `evals` array carries
 *      `topIds` / `topScores` / `currentTruthIds` / `passed` /
 *      `rank1` / `currentTruthAt1`).
 *   2. (Optionally) loads a pre-computed semantic-evidence map from
 *      a JSON file.
 *   3. For each temporal query, converts the lexical top-K into
 *      `ScoredCandidateWithRelationship[]` using the same
 *      `SIMULATED_SUPERSESSION_EDGES` the supersession-edge-simulation
 *      uses.
 *   4. Calls `demoteSupersededMemories` directly on the candidate list.
 *   5. Classifies the baseline and after outcomes using the existing
 *      `classifyTemporalTruthFailure` helper.
 *   6. Reports `currentTruthAt1` delta and regressions.
 *
 * The harness does NOT call any provider, any ranker, or any external
 * service. It consumes the artifacts the benchmark runner produced.
 *
 * CLI flags:
 *   --benchmark-artifact <path>   — the `retrieval-baseline-*.json`
 *     artifact. Default: most recent under `.curion/benchmark/`.
 *   --semantic-evidence <path>    — optional semantic evidence JSON.
 *   --out-dir <path>              — output dir. Default: `.curion/benchmark/`.
 *   --no-write                    — do not write JSON artifact.
 *   --no-stdout                   — do not print human report.
 *   --variant <name>              — source-variant label override.
 */

import fs from "node:fs";
import path from "node:path";

import {
  demoteSupersededMemories,
  DEMOTION_FACTOR,
  type ScoredCandidateWithRelationship,
} from "../retrieval/superseded-demotion.js";
import { SIMULATED_SUPERSESSION_EDGES } from "./supersession-edge-simulation.js";
import {
  classifyTemporalTruthFailure,
} from "./temporal-truth-diagnostic.js";
import {
  alignQueriesToEvals,
  readBenchmarkArtifact,
  findMostRecentArtifact,
  type BenchmarkArtifact,
} from "./temporal-truth-diagnostic-runner.js";
import type { BenchmarkQuery } from "./queries.js";
import type { QueryEval } from "./metrics.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProductionDemotionMetrics {
  /** Total temporal queries the harness covers. */
  total: number;
  /** Baseline `currentTruthAt1` count. */
  baselineCurrentTruthAt1: number;
  /** After-demotion `currentTruthAt1` count. */
  afterCurrentTruthAt1: number;
  /** `afterCurrentTruthAt1 - baselineCurrentTruthAt1`. */
  currentTruthAt1Delta: number;
  /** Regression count: baseline was `currentTruthAt1`, after is not. */
  regressionCount: number;
  /** Queries unchanged because current was missing from top-K. */
  unchangedBecauseCurrentMissing: number;
  /** Clean / fixture-ambiguous split. */
  cleanTotal: number;
  cleanBaselineCurrentTruthAt1: number;
  cleanAfterCurrentTruthAt1: number;
  cleanRegressionCount: number;
  fixtureAmbiguousTotal: number;
  fixtureAmbiguousBaselineCurrentTruthAt1: number;
  fixtureAmbiguousAfterCurrentTruthAt1: number;
  fixtureAmbiguousRegressionCount: number;
  /** Per-category change counts. */
  perCategoryChange: Record<string, number>;
  /** Per-query detail. */
  perQuery: ProductionDemotionPerQuery[];
}

export interface ProductionDemotionPerQuery {
  queryId: string;
  family: string;
  baselineTop1Id: number | null;
  baselineCurrentTruthAt1: boolean;
  afterTop1Id: number | null;
  afterCurrentTruthAt1: boolean;
  categoryChange: string;
  regression: boolean;
  unchangedBecauseCurrentMissing: boolean;
  isClean: boolean;
  isFixtureAmbiguous: boolean;
}

export interface ProductionDemotionReport {
  variant: string;
  sourceVariant: string;
  generatedAt: string;
  metrics: ProductionDemotionMetrics;
  recordCount: number | null;
}

// ---------------------------------------------------------------------------
// Core: apply production demotion helper to a single query's top-K
// ---------------------------------------------------------------------------

/**
 * Apply the production `demoteSupersededMemories` helper to a single
 * query's lexical top-K candidate list, using the simulated supersession
 * edges to provide relationship metadata.
 *
 * The function:
 *   1. Builds `ScoredCandidateWithRelationship[]` from the lexical top-K
 *      by attaching relationship data from `SIMULATED_SUPERSESSION_EDGES`.
 *   2. Calls `demoteSupersededMemories` on the list.
 *   3. Returns the new top-K ids and scores.
 *
 * This is the production code path, not a simulation.
 */
function applyProductionDemotion(args: {
  topIds: number[];
  topScores: number[];
}): { topIds: number[]; topScores: number[] } {
  const { topIds, topScores } = args;
  if (topIds.length <= 1) {
    return { topIds, topScores };
  }

  // Build ScoredCandidateWithRelationship[] from the lexical top-K.
  // Attach relationship metadata from SIMULATED_SUPERSESSION_EDGES.
  const candidates: ScoredCandidateWithRelationship[] = topIds.map((id, i) => {
    const edge = SIMULATED_SUPERSESSION_EDGES.get(id);
    if (!edge) return { id, score: topScores[i]! };
    return {
      id,
      score: topScores[i]!,
      relationship: {
        supersedes: edge.supersedes !== null ? [edge.supersedes] : [],
        supersededBy: edge.supersededBy !== null ? [edge.supersededBy] : [],
      },
    };
  });

  // Call the production helper.
  void DEMOTION_FACTOR; // referenced for documentation; helper uses it internally
  const result = demoteSupersededMemories(candidates);

  return {
    topIds: result.map((r) => r.id),
    topScores: result.map((r) => r.score),
  };
}

// ---------------------------------------------------------------------------
// Per-query evaluation
// ---------------------------------------------------------------------------

function evaluateForQuery(args: {
  eval: QueryEval;
  query: BenchmarkQuery;
}): ProductionDemotionPerQuery {
  const { eval: e, query: q } = args;

  // Build the candidate list and apply production demotion.
  const demoted = applyProductionDemotion({
    topIds: e.topIds,
    topScores: e.topScores,
  });

  // Classify baseline.
  const baselineDiag = classifyTemporalTruthFailure(e, q);

  // Build synthetic after-eval with demoted top-K.
  const afterEval: QueryEval = {
    ...e,
    topIds: demoted.topIds,
    topScores: demoted.topScores,
  };
  const afterDiag = classifyTemporalTruthFailure(afterEval, q);

  const categoryChange = `${baselineDiag.category} -> ${afterDiag.category}`;
  const regression =
    baselineDiag.top1IsCurrentTruth === true &&
    afterDiag.top1IsCurrentTruth === false;
  const unchangedBecauseCurrentMissing =
    baselineDiag.topKHasCurrentTruth === false &&
    afterDiag.topKHasCurrentTruth === false;
  const isFixtureAmbiguous = baselineDiag.isDivergentLabeled;
  const isClean = !isFixtureAmbiguous;

  return {
    queryId: e.queryId,
    family: e.family,
    baselineTop1Id: baselineDiag.top1Id,
    baselineCurrentTruthAt1: baselineDiag.top1IsCurrentTruth,
    afterTop1Id: afterDiag.top1Id,
    afterCurrentTruthAt1: afterDiag.top1IsCurrentTruth,
    categoryChange,
    regression,
    unchangedBecauseCurrentMissing,
    isClean,
    isFixtureAmbiguous,
  };
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

function aggregateMetrics(
  perQuery: ReadonlyArray<ProductionDemotionPerQuery>,
): ProductionDemotionMetrics {
  let total = 0;
  let cleanTotal = 0;
  let fixtureAmbiguousTotal = 0;
  let baselineCurrentTruthAt1 = 0;
  let afterCurrentTruthAt1 = 0;
  let regressionCount = 0;
  let unchangedBecauseCurrentMissing = 0;
  let cleanBaselineCurrentTruthAt1 = 0;
  let cleanAfterCurrentTruthAt1 = 0;
  let cleanRegressionCount = 0;
  let fixtureAmbiguousBaselineCurrentTruthAt1 = 0;
  let fixtureAmbiguousAfterCurrentTruthAt1 = 0;
  let fixtureAmbiguousRegressionCount = 0;
  const perCategoryChange: Record<string, number> = {};

  for (const p of perQuery) {
    total += 1;
    if (p.isClean) cleanTotal += 1;
    else fixtureAmbiguousTotal += 1;

    if (p.baselineCurrentTruthAt1) baselineCurrentTruthAt1 += 1;
    if (p.afterCurrentTruthAt1) afterCurrentTruthAt1 += 1;
    if (p.regression) regressionCount += 1;
    if (p.unchangedBecauseCurrentMissing) unchangedBecauseCurrentMissing += 1;

    if (p.isClean) {
      if (p.baselineCurrentTruthAt1) cleanBaselineCurrentTruthAt1 += 1;
      if (p.afterCurrentTruthAt1) cleanAfterCurrentTruthAt1 += 1;
      if (p.regression) cleanRegressionCount += 1;
    } else {
      if (p.baselineCurrentTruthAt1)
        fixtureAmbiguousBaselineCurrentTruthAt1 += 1;
      if (p.afterCurrentTruthAt1)
        fixtureAmbiguousAfterCurrentTruthAt1 += 1;
      if (p.regression) fixtureAmbiguousRegressionCount += 1;
    }

    perCategoryChange[p.categoryChange] =
      (perCategoryChange[p.categoryChange] ?? 0) + 1;
  }

  return {
    total,
    baselineCurrentTruthAt1,
    afterCurrentTruthAt1,
    currentTruthAt1Delta: afterCurrentTruthAt1 - baselineCurrentTruthAt1,
    regressionCount,
    unchangedBecauseCurrentMissing,
    cleanTotal,
    cleanBaselineCurrentTruthAt1,
    cleanAfterCurrentTruthAt1,
    cleanRegressionCount,
    fixtureAmbiguousTotal,
    fixtureAmbiguousBaselineCurrentTruthAt1,
    fixtureAmbiguousAfterCurrentTruthAt1,
    fixtureAmbiguousRegressionCount,
    perCategoryChange,
    perQuery: [...perQuery],
  };
}

// ---------------------------------------------------------------------------
// Report builder
// ---------------------------------------------------------------------------

export function buildProductionDemotionReport(args: {
  sourceVariant: string;
  evals: ReadonlyArray<QueryEval>;
  queries: ReadonlyArray<BenchmarkQuery>;
  recordCount?: number | null;
}): ProductionDemotionReport {
  const { sourceVariant, evals, queries, recordCount } = args;
  const perQuery: ProductionDemotionPerQuery[] = [];

  for (let i = 0; i < evals.length; i++) {
    const e = evals[i]!;
    const q = queries[i]!;
    if (q.family !== "temporal") continue;
    perQuery.push(evaluateForQuery({ eval: e, query: q }));
  }

  const metrics = aggregateMetrics(perQuery);

  return {
    variant: "production-demotion-helper",
    sourceVariant,
    generatedAt: new Date().toISOString(),
    metrics,
    recordCount: recordCount ?? null,
  };
}

// ---------------------------------------------------------------------------
// CLI runner
// ---------------------------------------------------------------------------

export interface ProductionDemotionCliArgs {
  benchmarkArtifact?: string;
  outDir?: string;
  noWrite?: boolean;
  noStdout?: boolean;
  variant?: string;
}

function formatReport(report: ProductionDemotionReport): string {
  const { metrics } = report;

  const lines: string[] = [];
  lines.push("=== Production Demotion Helper Benchmark ===");
  lines.push(`source: ${report.sourceVariant}`);
  lines.push(`variant: ${report.variant}`);
  lines.push(`generated: ${report.generatedAt}`);
  lines.push("");
  lines.push("--- Headline ---");
  lines.push(
    `currentTruthAt1: ${metrics.baselineCurrentTruthAt1} -> ${metrics.afterCurrentTruthAt1} ` +
      `(delta=${metrics.currentTruthAt1Delta >= 0 ? "+" : ""}${metrics.currentTruthAt1Delta})`,
  );
  lines.push(
    `regressions: ${metrics.regressionCount} ${metrics.regressionCount > 0 ? "FAIL" : "PASS"}`,
  );
  lines.push("");
  lines.push("--- Slice breakdown ---");
  lines.push(
    `clean:         ${metrics.cleanBaselineCurrentTruthAt1} -> ${metrics.cleanAfterCurrentTruthAt1} ` +
      `(delta=${metrics.cleanAfterCurrentTruthAt1 - metrics.cleanBaselineCurrentTruthAt1})`,
  );
  lines.push(
    `fixture-ambig: ${metrics.fixtureAmbiguousBaselineCurrentTruthAt1} -> ${metrics.fixtureAmbiguousAfterCurrentTruthAt1} ` +
      `(delta=${metrics.fixtureAmbiguousAfterCurrentTruthAt1 - metrics.fixtureAmbiguousBaselineCurrentTruthAt1})`,
  );
  lines.push("");
  lines.push("--- Counts ---");
  lines.push(`total:                              ${metrics.total}`);
  lines.push(`clean total:                        ${metrics.cleanTotal}`);
  lines.push(`fixture-ambiguous total:           ${metrics.fixtureAmbiguousTotal}`);
  lines.push(`unchangedBecauseCurrentMissing:    ${metrics.unchangedBecauseCurrentMissing}`);
  lines.push("");
  lines.push("--- Per-category changes ---");
  for (const [key, count] of Object.entries(metrics.perCategoryChange).sort()) {
    lines.push(`  ${key}: ${count}`);
  }

  return lines.join("\n");
}

export async function runProductionDemotionAnalysis(args: {
  benchmarkArtifact: BenchmarkArtifact;
  sourceVariant?: string;
}): Promise<ProductionDemotionReport> {
  const { benchmarkArtifact, sourceVariant } = args;
  const queries = alignQueriesToEvals(benchmarkArtifact.evals);
  return buildProductionDemotionReport({
    sourceVariant: sourceVariant ?? benchmarkArtifact.variant,
    evals: benchmarkArtifact.evals,
    queries,
    recordCount: benchmarkArtifact.config.recordCount ?? null,
  });
}

export function writeProductionDemotionReport(
  report: ProductionDemotionReport,
  dir: string,
): string {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `retrieval-production-demotion-${stamp}.json`;
  const full = path.join(dir, filename);
  fs.writeFileSync(full, JSON.stringify(report, null, 2), "utf8");
  return full;
}

export async function runProductionDemotionCli(
  args: ProductionDemotionCliArgs,
): Promise<{ report: ProductionDemotionReport; written?: string }> {
  const outDir = args.outDir ?? ".curion/benchmark";
  const defaultBenchmark =
    args.benchmarkArtifact ??
    findMostRecentArtifact(outDir, "retrieval-baseline-");
  if (!defaultBenchmark) {
    throw new Error(
      `runProductionDemotionCli: no --benchmark-artifact given and no ` +
        `retrieval-baseline-*.json found under ${outDir}`,
    );
  }
  const benchmarkArtifact = readBenchmarkArtifact(defaultBenchmark);
  const report = await runProductionDemotionAnalysis({
    benchmarkArtifact,
    sourceVariant: args.variant,
  });
  let written: string | undefined;
  if (!args.noWrite) {
    written = writeProductionDemotionReport(report, outDir);
  }
  if (!args.noStdout) {
    process.stderr.write(
      `[production-demotion] benchmark artifact: ${defaultBenchmark}\n`,
    );
    if (written) {
      process.stderr.write(`[production-demotion] wrote:              ${written}\n`);
    }
    process.stdout.write(formatReport(report) + "\n");
  }
  return { report, ...(written ? { written } : {}) };
}

// ---------------------------------------------------------------------------
// Argument parser
// ---------------------------------------------------------------------------

export function parseProductionDemotionCliArgs(
  argv: ReadonlyArray<string>,
): ProductionDemotionCliArgs {
  const out: ProductionDemotionCliArgs = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--benchmark-artifact" && i + 1 < argv.length) {
      out.benchmarkArtifact = argv[++i];
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

export async function main(
  argv: ReadonlyArray<string> = process.argv.slice(2),
): Promise<ProductionDemotionReport> {
  const args = parseProductionDemotionCliArgs(argv);
  const { report } = await runProductionDemotionCli(args);
  return report;
}

const isMainEntry = (() => {
  if (typeof process === "undefined") return false;
  if (!Array.isArray(process.argv)) return false;
  const entry = process.argv[1];
  if (!entry) return false;
  if (!/superseded-demotion-production-runner\.(ts|js)$/.test(entry))
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
      `[production-demotion] error: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(1);
  });
}
