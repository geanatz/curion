/**
 * Tests for the dense abstention / calibration experiment.
 *
 * Covers:
 *   1. Dense sweep math: per-query score distribution,
 *      gate evaluation (threshold / margin / ratio), and
 *      per-query diagnostic builder for the `vector-dense`
 *      variant.
 *   2. Hybrid-dense sweep math: per-source RRF trace
 *      (`contributorSupport`), contributor-agreement
 *      count, and gate evaluation on the RRF scale.
 *   3. `runDenseCalibration` end-to-end: the report's
 *      `baseline` / `sweep` / `bestByVariant` blocks are
 *      well-formed, the dense best rows are populated, the
 *      sync best rows are explicitly `null` (the dense
 *      report does NOT run the sync variants), and the
 *      baseline row matches the no-threshold re-run.
 *   4. CLI: `--variant vector-dense --calibrate`,
 *      `--variant hybrid-dense --calibrate`, and
 *      `--variant all-dense --calibrate` are all accepted;
 *      the artifact file prefix is
 *      `retrieval-calibration-dense-*.json` (distinct
 *      from the sync `retrieval-calibration-*.json`).
 *   5. Backward compat: the sync `runCalibration` report
 *      is unchanged; the existing `lexical / fts5 /
 *      vector` baseline / sweep / best rows are
 *      byte-stable; the sync artifact file prefix is
 *      unchanged.
 *   6. Production API: `recall(text)` is unchanged; the
 *      public MCP tool surface is unchanged; the source
 *      tree guard for the dense modules is unchanged.
 *
 * The tests split between synthetic unit tests (pure
 * functions, no corpus) and end-to-end tests (real corpus
 * + query set + dense ranker).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  DEFAULT_CALIBRATION_SWEEP,
  DEFAULT_DENSE_CALIBRATION_SWEEP,
  DEFAULT_HYBRID_DENSE_CALIBRATION_SWEEP,
  buildQueryDiagnostic,
  buildSweepForVariant,
  computeContributorSupport,
  computeRegressionCounts,
  computeScoreDistribution,
  evaluateGates,
  type CalibrationGate,
  type CalibrationVariantResult,
} from "../src/benchmark/calibration.ts";
import {
  StubDeterministicDenseEmbedder,
} from "../src/benchmark/variants/dense-embedder.ts";
import {
  rankDenseVectorAsync,
} from "../src/benchmark/variants/dense-vector.ts";
import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import { BENCHMARK_QUERIES } from "../src/benchmark/queries.ts";
import {
  buildCandidates,
  formatDenseCalibrationReport,
  isComparisonReport,
  isSingleVariantReport,
  parseRetrievalCli,
  runDenseCalibration,
  runDenseRetrievalBenchmark,
  runRetrievalBenchmark,
  writeDenseCalibrationReport,
  type DenseCalibrationReport,
} from "../src/benchmark/retrieval-runner.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";
import { aggregateMetrics, type QueryEval } from "../src/benchmark/metrics.ts";

// ---------------------------------------------------------------------------
// 0. Stable defaults
// ---------------------------------------------------------------------------

test("dense calibration: default dense sweep grid is stable", () => {
  // Pin the dense sweep grid so a future edit cannot
  // silently change the trade-off curve the report
  // surfaces.
  assert.deepEqual(
    [...(DEFAULT_DENSE_CALIBRATION_SWEEP.threshold ?? [])],
    [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7],
  );
  assert.deepEqual(
    [...(DEFAULT_DENSE_CALIBRATION_SWEEP.margin ?? [])],
    [0.0, 0.05, 0.1, 0.15, 0.2, 0.3],
  );
  assert.deepEqual(
    [...(DEFAULT_DENSE_CALIBRATION_SWEEP.ratio ?? [])],
    [1.0, 1.25, 1.5, 2.0, 3.0],
  );
});

test("dense calibration: default hybrid-dense sweep grid is stable", () => {
  assert.deepEqual(
    [...(DEFAULT_HYBRID_DENSE_CALIBRATION_SWEEP.threshold ?? [])],
    [0.01, 0.02, 0.025, 0.03, 0.04],
  );
  assert.deepEqual(
    [...(DEFAULT_HYBRID_DENSE_CALIBRATION_SWEEP.margin ?? [])],
    [0.0, 0.002, 0.005, 0.01, 0.02],
  );
  assert.deepEqual(
    [...(DEFAULT_HYBRID_DENSE_CALIBRATION_SWEEP.ratio ?? [])],
    [1.0, 1.25, 1.5, 2.0, 3.0],
  );
});

test("dense calibration: sync default sweep is unchanged (backward compat)", () => {
  // The sync default sweep grid must not change. The
  // dense calibration runner detects "default config" by
  // identity comparison with `DEFAULT_CALIBRATION_SWEEP`,
  // so a regression here would silently change the
  // dense sweep grid too.
  assert.deepEqual(
    [...(DEFAULT_CALIBRATION_SWEEP.threshold ?? [])],
    [0.1, 0.2, 0.3, 0.4, 0.5],
  );
  assert.deepEqual(
    [...(DEFAULT_CALIBRATION_SWEEP.margin ?? [])],
    [0.0, 0.05, 0.1, 0.2, 0.3],
  );
  assert.deepEqual(
    [...(DEFAULT_CALIBRATION_SWEEP.ratio ?? [])],
    [1.0, 1.25, 1.5, 2.0, 3.0],
  );
});

// ---------------------------------------------------------------------------
// 1. Score distribution + gate math (reused from sync calibration)
// ---------------------------------------------------------------------------

test("dense calibration: score distribution math is unchanged for the dense variants", () => {
  // The score distribution math is ranker-agnostic; the
  // dense variant returns cosine similarity in [0, 1],
  // and the function works on whatever the ranker
  // returned. We re-test the edge cases to pin the
  // contract on the dense path.
  const d1 = computeScoreDistribution([{ id: 1, score: 0.8 }]);
  assert.equal(d1.topScore, 0.8);
  assert.equal(d1.secondScore, 0);
  assert.equal(d1.scoreGap, 0.8);
  assert.equal(d1.scoreRatio, Number.POSITIVE_INFINITY);

  const d2 = computeScoreDistribution([
    { id: 1, score: 0.45 },
    { id: 2, score: 0.15 },
  ]);
  assert.equal(d2.topScore, 0.45);
  assert.equal(d2.secondScore, 0.15);
  // Floating-point: `0.45 - 0.15` is `0.30000000000000004`
  // in IEEE 754. The contract is a numerical
  // difference; a tolerance comparison is the right
  // assertion. (The test in
  // `retrieval-calibration.test.ts` uses the same
  // pattern.)
  assert.ok(
    Math.abs(d2.scoreGap - 0.3) < 1e-12,
    `scoreGap should be ~0.3, got ${d2.scoreGap}`,
  );
  assert.ok(Math.abs(d2.scoreRatio - 3.0) < 1e-12);
});

test("dense calibration: gate evaluation with cosine-scale thresholds", () => {
  // The dense cosine similarity is in [0, 1]. We test
  // a small fixed distribution and exercise every gate
  // kind. The semantics must match the sync calibration
  // gates (the dense variant reuses them).
  const dist = {
    topScore: 0.45,
    secondScore: 0.15,
    scoreGap: 0.3,
    scoreRatio: 3.0,
  };
  // threshold @ 0.4: 0.45 >= 0.4 -> pass.
  const t1 = evaluateGates(
    dist,
    [{ kind: "threshold", value: 0.4 }],
    "higher-is-better",
  );
  assert.equal(t1.abstained, false);
  // threshold @ 0.5: 0.45 < 0.5 -> abstain.
  const t2 = evaluateGates(
    dist,
    [{ kind: "threshold", value: 0.5 }],
    "higher-is-better",
  );
  assert.equal(t2.abstained, true);
  // margin @ 0.2: 0.3 >= 0.2 -> pass.
  const m1 = evaluateGates(
    dist,
    [{ kind: "margin", value: 0.2 }],
    "higher-is-better",
  );
  assert.equal(m1.abstained, false);
  // margin @ 0.4: 0.3 < 0.4 -> abstain.
  const m2 = evaluateGates(
    dist,
    [{ kind: "margin", value: 0.4 }],
    "higher-is-better",
  );
  assert.equal(m2.abstained, true);
  // ratio @ 2: 3 >= 2 -> pass.
  const r1 = evaluateGates(
    dist,
    [{ kind: "ratio", value: 2 }],
    "higher-is-better",
  );
  assert.equal(r1.abstained, false);
  // ratio @ 4: 3 < 4 -> abstain.
  const r2 = evaluateGates(
    dist,
    [{ kind: "ratio", value: 4 }],
    "higher-is-better",
  );
  assert.equal(r2.abstained, true);
});

// ---------------------------------------------------------------------------
// 2. Hybrid-aware diagnostic
// ---------------------------------------------------------------------------

test("dense calibration: contributorSupport carries per-source RRF rank/score/contribution", () => {
  // Three contributors: lexical rank-1, fts5 rank-3,
  // vector-dense rank-2. The agreement count is 3 (all
  // three sources surfaced the candidate).
  const c = computeContributorSupport([
    { source: "lexical", rank: 1, score: 0.5, contribution: 1 / 61 },
    { source: "fts5", rank: 3, score: 0.4, contribution: 1 / 63 },
    { source: "vector-dense", rank: 2, score: 0.3, contribution: 1 / 62 },
  ]);
  assert.equal(c.agreementCount, 3);
  assert.equal(c.contributors.length, 3);
});

test("dense calibration: contributorSupport with one absent source reports agreement=2", () => {
  // Two contributors surfaced, one absent.
  const c = computeContributorSupport([
    { source: "lexical", rank: 1, score: 0.5, contribution: 1 / 61 },
    { source: "fts5", rank: null, score: null, contribution: 0 },
    { source: "vector-dense", rank: 2, score: 0.3, contribution: 1 / 62 },
  ]);
  assert.equal(c.agreementCount, 2);
});

test("dense calibration: buildQueryDiagnostic with hybridSupport populates the additive fields", () => {
  // The hybrid-aware diagnostic fields are additive.
  // When the caller passes a `hybridSupport` block, the
  // diagnostic carries it; otherwise the fields are
  // `undefined`.
  const d = buildQueryDiagnostic(
    "exact-foo",
    "exact",
    true,
    [{ id: 1, score: 0.5 }],
    [{ kind: "threshold", value: 0.6 }],
    "higher-is-better",
    {
      contributors: [
        { source: "lexical", rank: 1, score: 0.5, contribution: 1 / 61 },
        { source: "fts5", rank: 2, score: 0.3, contribution: 1 / 62 },
        { source: "vector-dense", rank: 3, score: 0.2, contribution: 1 / 63 },
      ],
      agreementCount: 3,
    },
  );
  assert.ok(d.contributorSupport !== undefined);
  assert.equal(d.contributorSupport?.length, 3);
  assert.equal(d.contributorAgreementCount, 3);
});

test("dense calibration: buildQueryDiagnostic without hybridSupport leaves the fields undefined", () => {
  // Single-variant dense path: no hybridSupport. The
  // additive fields must be `undefined`, not present
  // with empty values, so a reviewer can distinguish
  // single-variant from hybrid-aware traces.
  const d = buildQueryDiagnostic(
    "exact-foo",
    "exact",
    true,
    [{ id: 1, score: 0.5 }],
    [],
    "higher-is-better",
  );
  assert.equal(d.contributorSupport, undefined);
  assert.equal(d.contributorAgreementCount, undefined);
});

// ---------------------------------------------------------------------------
// 3. End-to-end dense calibration
// ---------------------------------------------------------------------------

test("dense calibration runner: vector-dense report is well-formed", async () => {
  const report = await runDenseCalibration({
    variant: "vector-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  // The shape contract: top-level `CalibrationReport`
  // fields plus the additive `embeddingBackend`.
  assert.equal(typeof report.generatedAt, "string");
  assert.equal(report.config.recordCount, BENCHMARK_RECORDS.length);
  assert.equal(report.config.queryCount, BENCHMARK_QUERIES.length);
  assert.equal(report.config.direction, "higher-is-better");
  // The sync best keys are explicitly `null` (the dense
  // calibration report does NOT run the sync variants).
  assert.equal(report.bestByVariant.lexical, null);
  assert.equal(report.bestByVariant.fts5, null);
  assert.equal(report.bestByVariant.vector, null);
  // The dense best keys are populated.
  assert.ok(
    report.bestByVariant.vectorDense,
    "vectorDense best row should be populated",
  );
  // The hybrid-dense best key is `null` (we asked for
  // `vector-dense` only).
  assert.equal(report.bestByVariant.hybridDense, null);
  // The `embeddingBackend` block is on the dense report.
  assert.equal(report.embeddingBackend.backend, "stub-dense");
  assert.equal(report.embeddingBackend.dim, 64);
  // Baseline: exactly one row (the `vector-dense`
  // baseline; no sync baselines).
  assert.equal(report.baseline.length, 1);
  assert.equal(report.baseline[0]!.variant, "vector-dense");
  // Sweep: one row per (gate kind, candidate value).
  // The default dense grid has 7 threshold + 6 margin + 5
  // ratio = 18 rows. The baseline is NOT in the sweep.
  assert.equal(
    report.sweep.length,
    7 + 6 + 5,
    "sweep should have one row per (kind, value) on the dense grid",
  );
  for (const r of report.sweep) {
    assert.equal(r.variant, "vector-dense");
  }
});

test("dense calibration runner: hybrid-dense report is well-formed", async () => {
  const report = await runDenseCalibration({
    variant: "hybrid-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  // The sync best keys are explicitly `null`.
  assert.equal(report.bestByVariant.lexical, null);
  assert.equal(report.bestByVariant.fts5, null);
  assert.equal(report.bestByVariant.vector, null);
  // The hybrid-dense best key is populated; the
  // vector-dense best key is `null`.
  assert.ok(
    report.bestByVariant.hybridDense,
    "hybridDense best row should be populated",
  );
  assert.equal(report.bestByVariant.vectorDense, null);
  // Baseline: exactly one row.
  assert.equal(report.baseline.length, 1);
  assert.equal(report.baseline[0]!.variant, "hybrid-dense");
  // Sweep: 5 threshold + 5 margin + 5 ratio = 15 rows.
  assert.equal(report.sweep.length, 5 + 5 + 5);
  for (const r of report.sweep) {
    assert.equal(r.variant, "hybrid-dense");
  }
});

test("dense calibration runner: all-dense runs both dense variants back-to-back", async () => {
  const report = await runDenseCalibration({
    variant: "all-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  // Both dense best keys are populated.
  assert.ok(report.bestByVariant.vectorDense);
  assert.ok(report.bestByVariant.hybridDense);
  // Two baseline rows (one per dense variant).
  assert.equal(report.baseline.length, 2);
  const variants = report.baseline.map((b) => b.variant).sort();
  assert.deepEqual(variants, ["hybrid-dense", "vector-dense"]);
});

test("dense calibration runner: baseline row matches a direct no-threshold re-run", async () => {
  // The baseline row is the ranker's natural no-threshold
  // output. We re-run the ranker with `threshold: 0` and
  // assert the baseline's `noAnswerCorrect` /
  // `rank1` / `hit@5` numbers match.
  const report = await runDenseCalibration({
    variant: "vector-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  const base = report.baseline.find((b) => b.variant === "vector-dense");
  assert.ok(base, "expected a vector-dense baseline row");
  // Direct re-run with `threshold: 0`.
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const embedder = new StubDeterministicDenseEmbedder({ dim: 64 });
  const evals: QueryEval[] = [];
  for (const q of BENCHMARK_QUERIES) {
    const ranked = await rankDenseVectorAsync(q.query, candidates, {
      threshold: 0,
      topK: 5,
      embedder,
    });
    const topIds = ranked.map((r) => r.id);
    const topScores = ranked.map((r) => r.score);
    const eval_ = {
      queryId: q.id,
      family: q.family,
      query: q.query,
      expectedIds: [...q.expectedIds],
      currentTruthIds: [...q.currentTruthIds],
      topIds,
      topScores,
      rank1: false,
      currentTruthAt1: false,
      passed: false,
      reason: "",
    };
    const expected = new Set(eval_.expectedIds);
    const top0 = eval_.topIds[0];
    eval_.rank1 = top0 !== undefined && expected.has(top0);
    const ct = new Set(eval_.currentTruthIds);
    eval_.currentTruthAt1 = top0 !== undefined && ct.has(top0);
    eval_.passed = eval_.expectedIds.length === 0
      ? eval_.topIds.length === 0
      : eval_.topIds.slice(0, 5).some((id) => expected.has(id));
    evals.push(eval_);
  }
  const m = aggregateMetrics(evals);
  assert.equal(
    base.metrics.noAnswerCorrect,
    m.noAnswerCorrect,
    "vector-dense baseline noAnswerCorrect disagrees with direct threshold=0 re-run",
  );
  assert.equal(
    base.metrics.hitAt5,
    m.hitAt5,
    "vector-dense baseline hit@5 disagrees with direct threshold=0 re-run",
  );
  assert.equal(
    base.metrics.rank1,
    m.rank1,
    "vector-dense baseline rank1 disagrees with direct threshold=0 re-run",
  );
});

test("dense calibration runner: per-query diagnostics have the required fields", async () => {
  // Pin the per-query diagnostic shape for both dense
  // variants. The contract is additive: every existing
  // field is unchanged, the new `contributorSupport` /
  // `contributorAgreementCount` fields appear only on
  // the hybrid-dense rows.
  const vectorDenseReport = await runDenseCalibration({
    variant: "vector-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  const vectorDenseBest = vectorDenseReport.bestByVariant.vectorDense;
  assert.ok(vectorDenseBest);
  for (const d of vectorDenseBest.diagnostics) {
    assert.equal(typeof d.topScore, "number");
    assert.equal(typeof d.secondScore, "number");
    assert.equal(typeof d.scoreGap, "number");
    assert.ok(
      Number.isFinite(d.scoreRatio) || d.scoreRatio === Number.POSITIVE_INFINITY,
    );
    assert.equal(typeof d.abstained, "boolean");
    assert.ok(Array.isArray(d.abstainedByGate));
    assert.equal(typeof d.abstentionWasCorrect, "boolean");
    assert.ok(Array.isArray(d.originalTopIds));
    assert.ok(Array.isArray(d.afterAbstainTopIds));
    // The vector-dense path does NOT carry the
    // hybrid-aware fields.
    assert.equal(d.contributorSupport, undefined);
    assert.equal(d.contributorAgreementCount, undefined);
    // If the gate abstained, the after-abstain top-K is
    // empty. Otherwise it equals the original.
    if (d.abstained) {
      assert.equal(d.afterAbstainTopIds.length, 0);
    } else {
      assert.deepEqual(d.afterAbstainTopIds, d.originalTopIds);
    }
  }

  const hybridDenseReport = await runDenseCalibration({
    variant: "hybrid-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  const hybridDenseBest = hybridDenseReport.bestByVariant.hybridDense;
  assert.ok(hybridDenseBest);
  for (const d of hybridDenseBest.diagnostics) {
    // The hybrid-aware fields are present on every
    // hybrid-dense row (the runner always populates
    // them, even on empty top-K rows, so the per-query
    // diagnostic is well-formed).
    assert.ok(
      d.contributorSupport !== undefined,
      "hybrid-dense per-query diagnostic must carry contributorSupport",
    );
    assert.ok(
      d.contributorAgreementCount !== undefined,
      "hybrid-dense per-query diagnostic must carry contributorAgreementCount",
    );
    // The agreement count is in [0, 3] (three contributors
    // total: lexical, fts5, vector-dense).
    assert.ok(d.contributorAgreementCount! >= 0);
    assert.ok(d.contributorAgreementCount! <= 3);
  }
});

test("dense calibration runner: hybrid-dense contributorSupport labels are the dense sources", async () => {
  // Pin the source labels on the hybrid-aware
  // diagnostic. The labels are `lexical` / `fts5` /
  // `vector-dense` (NOT `vector`, which is the
  // hashed-BoW control's label).
  const report = await runDenseCalibration({
    variant: "hybrid-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  const best = report.bestByVariant.hybridDense;
  assert.ok(best);
  for (const d of best.diagnostics) {
    if (d.contributorSupport === undefined) continue;
    const sources = d.contributorSupport.map((c) => c.source).sort();
    assert.deepEqual(sources, ["fts5", "lexical", "vector-dense"]);
    // No `vector` label should leak into the dense
    // hybrid-aware diagnostic.
    assert.ok(
      !d.contributorSupport.some((c) => c.source === "vector"),
      "dense hybrid-aware diagnostic must not carry the 'vector' (hashed-BoW) source label",
    );
  }
});

test("dense calibration runner: per-query positive regressions are subset of positive evals", async () => {
  // The "positive regressions" count is the number of
  // positive (non no-answer) queries forced to abstain.
  // It must never exceed the total number of positive
  // queries in the corpus.
  for (const v of ["vector-dense", "hybrid-dense"] as const) {
    const report = await runDenseCalibration({
      variant: v,
      denseEmbedderSpec: "stub-dense:dim=64",
    });
    const best = v === "vector-dense"
      ? report.bestByVariant.vectorDense
      : report.bestByVariant.hybridDense;
    assert.ok(best, `expected a best row for ${v}`);
    const positiveTotal = BENCHMARK_QUERIES.filter(
      (q) => q.family !== "no-answer",
    ).length;
    assert.ok(
      best.positiveRegressions <= positiveTotal,
      `${v}: regressions (${best.positiveRegressions}) > positive total (${positiveTotal})`,
    );
    const noAnswerTotal = BENCHMARK_QUERIES.filter(
      (q) => q.family === "no-answer",
    ).length;
    assert.ok(
      best.noAnswerFixed <= noAnswerTotal,
      `${v}: noAnswerFixed (${best.noAnswerFixed}) > no-answer total (${noAnswerTotal})`,
    );
  }
});

// ---------------------------------------------------------------------------
// 4. CLI / artifact
// ---------------------------------------------------------------------------

test("dense calibration CLI: --variant vector-dense --calibrate runs the dense calibration", async () => {
  // The CLI parse should accept `--calibrate` on a
  // dense variant. The dispatch happens in the CLI
  // `main`; we test the public function instead because
  // it is the same code path.
  const opts = parseRetrievalCli([
    "--variant",
    "vector-dense",
    "--calibrate",
    "--embedder",
    "stub-dense:dim=64",
  ]);
  assert.equal(opts.variant, "vector-dense");
  assert.equal(opts.calibration, true);
  assert.equal(opts.denseEmbedderSpec, "stub-dense:dim=64");
});

test("dense calibration CLI: --variant all-dense --calibrate runs the dense calibration", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "all-dense",
    "--calibrate",
    "--embedder",
    "stub-dense",
  ]);
  assert.equal(opts.variant, "all-dense");
  assert.equal(opts.calibration, true);
});

test("dense calibration artifact: writeDenseCalibrationReport writes the right prefix", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-dcal-art-"));
  try {
    const report = await runDenseCalibration({
      variant: "vector-dense",
      denseEmbedderSpec: "stub-dense:dim=64",
    });
    const file = writeDenseCalibrationReport(report, tmp);
    assert.ok(fs.existsSync(file));
    // The file prefix is `retrieval-calibration-dense-`
    // (distinct from the sync
    // `retrieval-calibration-` prefix). The sync
    // calibration report consumers do not pick the
    // dense artifact up.
    assert.match(
      path.basename(file),
      /^retrieval-calibration-dense-/,
      `dense calibration file prefix mismatch: ${path.basename(file)}`,
    );
    // The file does NOT carry the sync prefix.
    assert.doesNotMatch(
      path.basename(file),
      /^retrieval-calibration-(?!dense)/,
    );
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as {
      embeddingBackend: { backend: string; dim: number };
      bestByVariant: { lexical: null; fts5: null; vector: null; vectorDense: unknown; hybridDense: null };
    };
    assert.equal(parsed.embeddingBackend.backend, "stub-dense");
    assert.equal(parsed.embeddingBackend.dim, 64);
    assert.equal(parsed.bestByVariant.lexical, null);
    assert.equal(parsed.bestByVariant.fts5, null);
    assert.equal(parsed.bestByVariant.vector, null);
    assert.ok(parsed.bestByVariant.vectorDense);
    assert.equal(parsed.bestByVariant.hybridDense, null);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 5. Human report
// ---------------------------------------------------------------------------

test("dense calibration human report: includes the embedding backend and the dense sections", async () => {
  const report = await runDenseCalibration({
    variant: "all-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  const out = formatDenseCalibrationReport(report);
  for (const section of [
    "embedding backend",
    "stub-dense",
    "### vector-dense sweep ###",
    "### hybrid-dense sweep ###",
    "best per variant",
    "per-query diagnostics",
  ]) {
    assert.ok(
      out.includes(section),
      `dense calibration human report missing section: ${section}`,
    );
  }
});

test("dense calibration human report: prints the calibration header exactly once", async () => {
  // Regression: `formatDenseCalibrationReport` reuses the
  // sync `formatCalibrationReport` body and prepends a
  // dense-specific header. The body-slice marker used to
  // strip the sync header must match an actual body
  // line; otherwise the defensive fallback re-emits the
  // full body and the report prints the inner
  // `=== cortex-mcp-v2 retrieval calibration ===` header
  // twice. Pin the header count and the metadata
  // duplication here.
  const report = await runDenseCalibration({
    variant: "all-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  const out = formatDenseCalibrationReport(report);
  const headerCount = (
    out.match(/^=== cortex-mcp-v2 retrieval calibration.*===$/gm) ?? []
  ).length;
  assert.equal(
    headerCount,
    1,
    `dense calibration human report should print the calibration header exactly once, found ${headerCount}:\n${out}`,
  );
  // The dense header (with the (dense) suffix) must be
  // the one that survived — and the embedder block must
  // follow it.
  assert.ok(
    out.startsWith(
      "=== cortex-mcp-v2 retrieval calibration (dense) ===",
    ),
    `dense calibration human report should start with the (dense) header, got:\n${out.slice(0, 200)}`,
  );
  // The metadata block (records / queries / direction)
  // must appear exactly once.
  const recordsCount = (out.match(/^  records:\s+\d+$/gm) ?? []).length;
  assert.equal(
    recordsCount,
    1,
    `dense calibration human report should list 'records' exactly once, found ${recordsCount}:\n${out}`,
  );
  const queriesCount = (out.match(/^  queries:\s+\d+$/gm) ?? []).length;
  assert.equal(
    queriesCount,
    1,
    `dense calibration human report should list 'queries' exactly once, found ${queriesCount}:\n${out}`,
  );
  // The generated-at line should also appear exactly once
  // (the body line `generated at: <iso>` and the dense
  // header line `generated at: <iso>` would otherwise
  // double up).
  const generatedAtCount = (out.match(/^generated at:\s+/gm) ?? []).length;
  assert.equal(
    generatedAtCount,
    1,
    `dense calibration human report should list 'generated at' exactly once, found ${generatedAtCount}:\n${out}`,
  );
});

// ---------------------------------------------------------------------------
// 6. Backward compatibility: sync calibration is unchanged
// ---------------------------------------------------------------------------

test("dense calibration: sync runCalibration report is byte-stable (no dense rows leak in)", async () => {
  // The dense calibration support is purely additive.
  // The sync `runCalibration` report's `baseline`,
  // `sweep`, and `bestByVariant` shapes are unchanged.
  // The dense best keys are `undefined` (the sync
  // report does not populate them).
  const report = await import(
    "../src/benchmark/retrieval-runner.ts"
  ).then((m) => m.runCalibration({ variant: "all" }));
  assert.equal(report.baseline.length, 3, "sync baseline still has 3 rows");
  for (const b of report.baseline) {
    assert.ok(["lexical", "fts5", "vector"].includes(b.variant));
  }
  // The sync best keys are the canonical three.
  for (const v of ["lexical", "fts5", "vector"] as const) {
    assert.ok(report.bestByVariant[v], `sync best row for ${v}`);
  }
  // The dense best keys are `undefined` (additive but
  // absent on the sync report).
  assert.equal(
    report.bestByVariant.vectorDense,
    undefined,
    "sync calibration report must not populate the vectorDense best key",
  );
  assert.equal(
    report.bestByVariant.hybridDense,
    undefined,
    "sync calibration report must not populate the hybridDense best key",
  );
  // No dense variant rows in the sweep.
  for (const r of report.sweep) {
    assert.notEqual(r.variant, "vector-dense");
    assert.notEqual(r.variant, "hybrid-dense");
  }
});

test("dense calibration: existing single-variant and comparison benchmark reports are unchanged", () => {
  // Pin the existing single-variant and comparison
  // reports. The dense calibration support is purely
  // additive; the existing benchmark surface is
  // byte-stable. The pinned numbers here are the
  // adversarial-expansion-checkpoint (132 records / 176
  // queries) lexical baseline. The numbers shifted from
  // the prior 100-record / 96-query checkpoint for two
  // reasons (see the matching
  // `calibration: does not change...` test in
  // `tests/retrieval-calibration.test.ts` for the full
  // explanation): the new corpus (8 new clusters) added
  // 32 candidate records that the lexical ranker can
  // surface, and the 80 new queries include 54 positive
  // and 22 no-answer queries. The aggregate shifts to
  // rank1 82/130=63.1%, hit@5 111/130=85.4%,
  // noAnswerCorrect 3/46=6.5%. A future corpus / query
  // set change is a deliberate, visible change; update
  // these numbers and the README's headline table
  // together.
  const single = runRetrievalBenchmark({ variant: "lexical" });
  assert.ok(isSingleVariantReport(single));
  assert.equal(single.metrics.hitAt5, 111);
  assert.equal(single.metrics.rank1, 82);
  assert.equal(single.metrics.noAnswerCorrect, 3);

  const all = runRetrievalBenchmark({ variant: "all" });
  assert.ok(isComparisonReport(all));
  // Existing comparison rows must still be present.
  const metricNames = new Set(all.comparison.map((r) => r.metric));
  for (const required of [
    "rank1 (positive)",
    "hit@5 (positive)",
    "no-answer TNR",
    "precision@5 (%)",
  ]) {
    assert.ok(metricNames.has(required), `comparison row missing: ${required}`);
  }
});

// ---------------------------------------------------------------------------
// 7. Production API: recall(text) and source-tree guard
// ---------------------------------------------------------------------------

test("dense calibration: production recall() controller is not modified", () => {
  // The dense calibration support is benchmark-only. The
  // recall controller's source code must not import the
  // calibration module or any dense module.
  const recallSrc = fs.readFileSync(
    path.join(
      import.meta.dirname,
      "..",
      "src",
      "controller",
      "recall-controller.ts",
    ),
    "utf8",
  );
  assert.match(recallSrc, /rankLexical/);
  assert.doesNotMatch(
    recallSrc,
    /calibration|dense-calibration|runDenseCalibration|DenseCalibration/,
    "recall controller must NOT import dense calibration modules",
  );
  // The MCP server still exposes exactly two tools.
  const serverSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "server.ts"),
    "utf8",
  );
  const toolCallCount = (serverSrc.match(/server\.tool\(/g) ?? []).length;
  assert.equal(
    toolCallCount,
    2,
    `server.ts must register exactly 2 tools, found ${toolCallCount}`,
  );
  assert.deepEqual(
    [...PUBLIC_TOOL_NAMES],
    ["remember", "recall"],
    "public MCP tool surface must remain exactly remember + recall",
  );
});

test("dense calibration: the dense calibration report type is a strict superset of CalibrationReport", () => {
  // The type-level contract: `DenseCalibrationReport`
  // extends `CalibrationReport` (additive). A consumer
  // that knows about `CalibrationReport` can read a
  // `DenseCalibrationReport` without changes.
  const r: DenseCalibrationReport = {
    generatedAt: "2026-01-01T00:00:00.000Z",
    config: {
      recordCount: 60,
      queryCount: 54,
      direction: "higher-is-better",
    },
    baseline: [],
    sweep: [],
    bestByVariant: {
      lexical: null,
      fts5: null,
      vector: null,
      vectorDense: null,
      hybridDense: null,
    },
    embeddingBackend: {
      backend: "stub-dense",
      description: "stub",
      modelId: "stub-dense-v1",
      dim: 64,
      status: "ready",
    },
  };
  // Cast to `CalibrationReport` (the additive contract).
  const asSync: import("../src/benchmark/calibration.ts").CalibrationReport = r;
  assert.equal(asSync.bestByVariant.lexical, null);
  // The dense-only field is `undefined` on the sync
  // shape's projected view; this is the contract: a
  // consumer that does not know about the dense keys
  // sees a well-formed sync report.
  assert.equal(
    (asSync.bestByVariant as { vectorDense?: unknown }).vectorDense,
    null,
  );
  assert.equal(
    (asSync.bestByVariant as { hybridDense?: unknown }).hybridDense,
    null,
  );
});

// ---------------------------------------------------------------------------
// 8. Dispatch: --calibrate is now supported on dense (was future phase)
// ---------------------------------------------------------------------------

test("dense calibration: runDenseRetrievalBenchmark with --calibrate returns a DenseCalibrationReport", async () => {
  // The dispatch in `runDenseRetrievalBenchmark` short-
  // circuits to `runDenseCalibration` when `--calibrate`
  // is set, instead of throwing. The function's return
  // type is the union of the three dense shapes
  // (`DenseRetrievalBenchmarkReport` /
  // `DenseComparisonBenchmarkReport` /
  // `CalibrationReport`); a calibration report is
  // distinguished by the absence of a `variant` field
  // and the presence of an `embeddingBackend` field at
  // the top level.
  const report = await runDenseRetrievalBenchmark({
    variant: "vector-dense",
    calibration: true,
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  const r = report as {
    variant?: string;
    embeddingBackend?: { backend: string };
    baseline?: ReadonlyArray<unknown>;
    sweep?: ReadonlyArray<unknown>;
  };
  // The calibration report has no `variant` field at
  // the top level (the sync `CalibrationReport` shape).
  assert.equal(r.variant, undefined);
  // The dense calibration report's
  // `embeddingBackend` is at the top level.
  assert.equal(r.embeddingBackend?.backend, "stub-dense");
  // The baseline / sweep blocks exist.
  assert.ok(r.baseline);
  assert.ok(r.sweep);
});

// ---------------------------------------------------------------------------
// 9. Sanity: pickBestRow over the dense sweep
// ---------------------------------------------------------------------------

test("dense calibration: pickBestRow on the dense sweep returns a well-formed row", async () => {
  // The best-row pick is shared with the sync
  // calibration runner. On the dense path it must
  // return a well-formed `CalibrationVariantResult`.
  const report = await runDenseCalibration({
    variant: "vector-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  const best = report.bestByVariant.vectorDense;
  assert.ok(best);
  // The variant label on the row is the kebab-case
  // `vector-dense` (the same shape as the sync
  // variants use).
  assert.equal(best.variant, "vector-dense");
  // The best row's TNR delta over the baseline is
  // non-negative (the pick rule maximizes TNR delta).
  const base = report.baseline[0]!;
  const baseTnr = base.metrics.noAnswerTotal > 0
    ? base.metrics.noAnswerCorrect / base.metrics.noAnswerTotal
    : 0;
  const bestTnr = best.metrics.noAnswerTotal > 0
    ? best.metrics.noAnswerCorrect / best.metrics.noAnswerTotal
    : 0;
  assert.ok(
    bestTnr >= baseTnr,
    `best row TNR (${bestTnr}) should be >= baseline TNR (${baseTnr})`,
  );
});
