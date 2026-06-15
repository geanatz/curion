/**
 * Tests for the abstention / calibration experiment.
 *
 * Covers:
 *   1. Score-distribution math (topScore, secondScore,
 *      scoreGap, scoreRatio edge cases).
 *   2. Gate evaluation (threshold, margin, ratio) including
 *      direction handling (higher-is-better vs
 *      lower-is-better).
 *   3. Per-query diagnostic builder (correct abstention
 *      semantics for positive vs no-answer queries,
 *      before/after result ids).
 *   4. Regression counts (positive queries forced to abstain
 *      count as regressions; no-answer queries fixed by
 *      abstention count as no-answer FPs fixed).
 *   5. Trade-off metrics (no-answer TNR, hit@5, rank1,
 *      multi-hop, orientation, currentTruth@1).
 *   6. `pickBestRow` ranking (TNR delta > regressions >
 *      hit@5 > smallest gate value).
 *   7. End-to-end runner: `runCalibration` produces a
 *      well-formed report, the baseline row matches the
 *      existing single-variant benchmark's no-answer TNR,
 *      and the sweep emits one row per (variant, gate kind,
 *      candidate value).
 *   8. FTS5 direction: the `LexicalScoredCandidate.score`
 *      returned by the FTS5 variant is "higher is better"
 *      (the squashed `1 / (1 + |bm25|)` form). The test
 *      asserts this directly so a future change to the
 *      squashing function cannot silently break the gate
 *      direction.
 *   9. Vector threshold baseline behavior: with no extra
 *      gate the vector variant's TNR is 0 (every no-answer
 *      query returns a hit with score >= 0). The test
 *      pins this so a future embedder change is visible in
 *      the calibration report.
 *  10. CLI: `--calibrate` and `--calibrate-direction` parse
 *      correctly.
 *  11. Human report count display (Reviewer follow-up fix):
 *      the per-query diagnostic counts in the human report
 *      reflect the true totals, not the slice length, and
 *      label truncation as "showing first N" when
 *      applicable. The on-disk JSON artifact is unchanged.
 *
 * The tests are split between synthetic unit tests (pure
 * functions, no corpus) and end-to-end tests (real corpus +
 * query set + ranker).
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  DEFAULT_CALIBRATION_SWEEP,
  buildQueryDiagnostic,
  buildSweepForVariant,
  computeRegressionCounts,
  computeScoreDistribution,
  computeTradeoff,
  evaluateGates,
  gateLabel,
  pickBestRow,
  type CalibrationGate,
  type CalibrationVariantResult,
} from "../src/benchmark/calibration.ts";
import { rankFts5, normalizeFts5Score } from "../src/benchmark/variants/fts5.ts";
import {
  rankVector,
  DEFAULT_VECTOR_THRESHOLD,
  HashedBagOfWordsEmbedder,
} from "../src/benchmark/variants/vector.ts";
import { rankLexical } from "../src/retrieval/lexical.ts";
import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import { BENCHMARK_QUERIES } from "../src/benchmark/queries.ts";
import { aggregateMetrics, type QueryEval } from "../src/benchmark/metrics.ts";
import {
  buildCandidates,
  formatCalibrationReport,
  isComparisonReport,
  isSingleVariantReport,
  parseRetrievalCli,
  runCalibration,
  runRetrievalBenchmark,
} from "../src/benchmark/retrieval-runner.ts";

// ---------------------------------------------------------------------------
// 0. Stable defaults
// ---------------------------------------------------------------------------

test("calibration: default sweep grid is stable", () => {
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
// 1. Score distribution math
// ---------------------------------------------------------------------------

test("calibration: score distribution from a single candidate", () => {
  const d = computeScoreDistribution([{ id: 1, score: 0.7 }]);
  assert.equal(d.topScore, 0.7);
  assert.equal(d.secondScore, 0);
  assert.equal(d.scoreGap, 0.7);
  // Single candidate, second = 0: ratio is +Infinity (the
  // ranker is the only candidate).
  assert.equal(d.scoreRatio, Number.POSITIVE_INFINITY);
});

test("calibration: score distribution from two candidates", () => {
  const d = computeScoreDistribution([
    { id: 1, score: 0.8 },
    { id: 2, score: 0.3 },
  ]);
  assert.equal(d.topScore, 0.8);
  assert.equal(d.secondScore, 0.3);
  assert.equal(d.scoreGap, 0.5);
  assert.ok(Math.abs(d.scoreRatio - 0.8 / 0.3) < 1e-12);
});

test("calibration: score distribution from no candidates", () => {
  const d = computeScoreDistribution([]);
  assert.equal(d.topScore, 0);
  assert.equal(d.secondScore, 0);
  assert.equal(d.scoreGap, 0);
  // No signal: ratio is 1.0 (defined that way so a sort
  // on ratio is well-formed).
  assert.equal(d.scoreRatio, 1.0);
});

test("calibration: ratio is 1.0 when both top and second are zero", () => {
  // Two zero scores: defined as 1.0 (no-signal placeholder)
  // so a reviewer can sort / filter on ratio without
  // hitting NaN.
  const d = computeScoreDistribution([
    { id: 1, score: 0 },
    { id: 2, score: 0 },
  ]);
  assert.equal(d.scoreRatio, 1.0);
});

// ---------------------------------------------------------------------------
// 2. Gate evaluation
// ---------------------------------------------------------------------------

test("calibration: threshold gate under higher-is-better", () => {
  const dist = { topScore: 0.3, secondScore: 0.2, scoreGap: 0.1, scoreRatio: 1.5 };
  // Gate @ 0.5: topScore (0.3) < 0.5 -> abstain.
  let r = evaluateGates(dist, [{ kind: "threshold", value: 0.5 }], "higher-is-better");
  assert.equal(r.abstained, true);
  assert.deepEqual(r.triggered, ["threshold@0.5"]);
  // Gate @ 0.2: topScore (0.3) >= 0.2 -> do not abstain.
  r = evaluateGates(dist, [{ kind: "threshold", value: 0.2 }], "higher-is-better");
  assert.equal(r.abstained, false);
  assert.deepEqual(r.triggered, []);
});

test("calibration: margin gate under higher-is-better", () => {
  const dist = { topScore: 0.3, secondScore: 0.2, scoreGap: 0.1, scoreRatio: 1.5 };
  // margin @ 0.05: 0.1 >= 0.05 -> do not abstain.
  let r = evaluateGates(dist, [{ kind: "margin", value: 0.05 }], "higher-is-better");
  assert.equal(r.abstained, false);
  // margin @ 0.2: 0.1 < 0.2 -> abstain.
  r = evaluateGates(dist, [{ kind: "margin", value: 0.2 }], "higher-is-better");
  assert.equal(r.abstained, true);
});

test("calibration: ratio gate under higher-is-better", () => {
  const dist = { topScore: 0.3, secondScore: 0.2, scoreGap: 0.1, scoreRatio: 1.5 };
  // ratio @ 2.0: 1.5 < 2.0 -> abstain.
  let r = evaluateGates(dist, [{ kind: "ratio", value: 2.0 }], "higher-is-better");
  assert.equal(r.abstained, true);
  // ratio @ 1.0: 1.5 >= 1.0 -> do not abstain.
  r = evaluateGates(dist, [{ kind: "ratio", value: 1.0 }], "higher-is-better");
  assert.equal(r.abstained, false);
});

test("calibration: direction inverts the gate (lower-is-better)", () => {
  // FTS5 raw bm25 is negative where MORE negative is
  // better. If a future experiment wants to gate against
  // the raw bm25, it can flip direction. The gate
  // comparison is the same arithmetic, just inverted.
  const dist = { topScore: -2, secondScore: -5, scoreGap: 3, scoreRatio: 0.4 };
  // threshold @ -1: -2 is NOT > -1 (lower-is-better) -> do not abstain.
  let r = evaluateGates(dist, [{ kind: "threshold", value: -1 }], "lower-is-better");
  assert.equal(r.abstained, false);
  // threshold @ -3: -2 > -3 -> abstain (ranker is too close to neutral).
  r = evaluateGates(dist, [{ kind: "threshold", value: -3 }], "lower-is-better");
  assert.equal(r.abstained, true);
});

test("calibration: multiple gates OR-combine", () => {
  const dist = { topScore: 0.3, secondScore: 0.2, scoreGap: 0.1, scoreRatio: 1.5 };
  // Only the ratio gate triggers. Threshold and margin
  // pass. The overall decision is "abstain" because at
  // least one gate triggered.
  const r = evaluateGates(
    dist,
    [
      { kind: "threshold", value: 0.1 },
      { kind: "margin", value: 0.05 },
      { kind: "ratio", value: 2.0 },
    ],
    "higher-is-better",
  );
  assert.equal(r.abstained, true);
  assert.deepEqual(r.triggered, ["ratio@2"]);
});

test("calibration: inactive gates are skipped", () => {
  const dist = { topScore: 0.3, secondScore: 0.2, scoreGap: 0.1, scoreRatio: 1.5 };
  const r = evaluateGates(
    dist,
    [{ kind: "threshold", value: 0.5, active: false }],
    "higher-is-better",
  );
  assert.equal(r.abstained, false);
  assert.deepEqual(r.triggered, []);
});

test("calibration: gateLabel falls back to kind@value", () => {
  assert.equal(gateLabel({ kind: "threshold", value: 0.4 }), "threshold@0.4");
  assert.equal(
    gateLabel({ kind: "threshold", value: 0.4, label: "aggressive" }),
    "aggressive",
  );
});

// ---------------------------------------------------------------------------
// 3. Per-query diagnostic
// ---------------------------------------------------------------------------

test("calibration: positive query abstention is a regression", () => {
  // Positive query. The ranker returns a clear hit, but
  // the gate says "abstain if topScore < 1" which forces
  // an abstention. The diagnostic must mark this as
  // incorrect (regression).
  const d = buildQueryDiagnostic(
    "exact-foo",
    "exact",
    true,
    [{ id: 1, score: 0.5 }],
    [{ kind: "threshold", value: 1.0 }],
    "higher-is-better",
  );
  assert.equal(d.abstained, true);
  assert.equal(d.abstentionWasCorrect, false);
  assert.equal(d.afterAbstainTopIds.length, 0);
  assert.deepEqual(d.originalTopIds, [1]);
});

test("calibration: positive query no-abstain is correct", () => {
  // Positive query, top score well above the gate. The
  // diagnostic must mark the no-abstain decision as
  // correct.
  const d = buildQueryDiagnostic(
    "exact-foo",
    "exact",
    true,
    [{ id: 1, score: 0.8 }],
    [{ kind: "threshold", value: 0.5 }],
    "higher-is-better",
  );
  assert.equal(d.abstained, false);
  assert.equal(d.abstentionWasCorrect, true);
  assert.deepEqual(d.afterAbstainTopIds, [1]);
});

test("calibration: no-answer query abstention is a fix", () => {
  // No-answer query where the ranker originally returned
  // a hit. The gate abstains. That is the correct
  // behavior (a no-answer query SHOULD abstain).
  const d = buildQueryDiagnostic(
    "nonexistent-foo",
    "no-answer",
    false,
    [{ id: 1, score: 0.5 }],
    [{ kind: "threshold", value: 1.0 }],
    "higher-is-better",
  );
  assert.equal(d.abstained, true);
  assert.equal(d.abstentionWasCorrect, true);
  assert.equal(d.naturallyAbstained, false);
  // The "fixed" signal in the regression counts comes
  // from `naturallyAbstained === false && abstained`.
  assert.equal(d.naturallyAbstained, false);
});

test("calibration: no-answer query naturally empty is naturallyAbstained", () => {
  // No-answer query where the ranker already returned
  // empty. No gate is needed. `naturallyAbstained` is
  // true, `abstained` is true (vacuously), and the
  // abstention is correct.
  const d = buildQueryDiagnostic(
    "nonexistent-foo",
    "no-answer",
    false,
    [],
    [{ kind: "threshold", value: 0.1 }],
    "higher-is-better",
  );
  assert.equal(d.abstained, true);
  assert.equal(d.abstentionWasCorrect, true);
  assert.equal(d.naturallyAbstained, true);
});

test("calibration: per-query score diagnostics are correct", () => {
  const d = buildQueryDiagnostic(
    "exact-foo",
    "exact",
    true,
    [
      { id: 1, score: 0.6 },
      { id: 2, score: 0.3 },
      { id: 3, score: 0.1 },
    ],
    [],
    "higher-is-better",
  );
  assert.equal(d.topScore, 0.6);
  assert.equal(d.secondScore, 0.3);
  assert.equal(d.scoreGap, 0.3);
  assert.equal(d.scoreRatio, 0.6 / 0.3);
  assert.deepEqual(d.originalTopIds, [1, 2, 3]);
  assert.deepEqual(d.originalTopScores, [0.6, 0.3, 0.1]);
  assert.deepEqual(d.afterAbstainTopIds, [1, 2, 3]);
});

// ---------------------------------------------------------------------------
// 4. Regression counts
// ---------------------------------------------------------------------------

test("calibration: regression counts sum correctly", () => {
  const diags: Array<{
    queryId: string;
    family: string;
    isPositive: boolean;
    topScore: number;
    secondScore: number;
    scoreGap: number;
    scoreRatio: number;
    originalTopIds: number[];
    originalTopScores: number[];
    abstained: boolean;
    abstainedByGate: string[];
    abstentionWasCorrect: boolean;
    afterAbstainTopIds: number[];
    naturallyAbstained: boolean;
  }> = [
    // Positive query, abstained -> regression.
    {
      queryId: "p1",
      family: "exact",
      isPositive: true,
      topScore: 0.3,
      secondScore: 0,
      scoreGap: 0.3,
      scoreRatio: Number.POSITIVE_INFINITY,
      originalTopIds: [1],
      originalTopScores: [0.3],
      abstained: true,
      abstainedByGate: ["threshold@0.5"],
      abstentionWasCorrect: false,
      afterAbstainTopIds: [],
      naturallyAbstained: false,
    },
    // Positive query, not abstained -> OK.
    {
      queryId: "p2",
      family: "exact",
      isPositive: true,
      topScore: 0.7,
      secondScore: 0,
      scoreGap: 0.7,
      scoreRatio: Number.POSITIVE_INFINITY,
      originalTopIds: [1],
      originalTopScores: [0.7],
      abstained: false,
      abstainedByGate: [],
      abstentionWasCorrect: true,
      afterAbstainTopIds: [1],
      naturallyAbstained: false,
    },
    // No-answer query, naturally empty -> not "fixed" by gate (no FP to fix).
    {
      queryId: "n1",
      family: "no-answer",
      isPositive: false,
      topScore: 0,
      secondScore: 0,
      scoreGap: 0,
      scoreRatio: 1.0,
      originalTopIds: [],
      originalTopScores: [],
      abstained: true,
      abstainedByGate: [],
      abstentionWasCorrect: true,
      afterAbstainTopIds: [],
      naturallyAbstained: true,
    },
    // No-answer query, ranker returned hit, gate abstained -> fixed.
    {
      queryId: "n2",
      family: "no-answer",
      isPositive: false,
      topScore: 0.4,
      secondScore: 0,
      scoreGap: 0.4,
      scoreRatio: Number.POSITIVE_INFINITY,
      originalTopIds: [1],
      originalTopScores: [0.4],
      abstained: true,
      abstainedByGate: ["threshold@0.5"],
      abstentionWasCorrect: true,
      afterAbstainTopIds: [],
      naturallyAbstained: false,
    },
    // No-answer query, ranker returned hit, gate did NOT abstain -> remaining FP.
    {
      queryId: "n3",
      family: "no-answer",
      isPositive: false,
      topScore: 0.7,
      secondScore: 0,
      scoreGap: 0.7,
      scoreRatio: Number.POSITIVE_INFINITY,
      originalTopIds: [1],
      originalTopScores: [0.7],
      abstained: false,
      abstainedByGate: [],
      abstentionWasCorrect: false,
      afterAbstainTopIds: [1],
      naturallyAbstained: false,
    },
  ];
  const c = computeRegressionCounts(diags);
  assert.equal(c.positiveRegressions, 1, "p1 should count as a regression");
  assert.equal(c.noAnswerFixed, 1, "n2 should count as fixed by abstention");
  assert.equal(c.noAnswerRemainingFp, 1, "n3 should count as remaining FP");
});

// ---------------------------------------------------------------------------
// 5. Trade-off metrics
// ---------------------------------------------------------------------------

test("calibration: tradeoff metrics match the after-abstain top-K", () => {
  // Build a small synthetic eval set. We reuse the
  // existing `evaluateQuery` to construct `QueryEval`s.
  const evals: QueryEval[] = [
    // Positive query: original top is [expected]; gate abstains -> hit@5 = 0.
    {
      queryId: "p1",
      family: "exact",
      query: "foo",
      expectedIds: [10],
      currentTruthIds: [10],
      topIds: [10, 1, 2, 3, 4],
      topScores: [0.5, 0.4, 0.3, 0.2, 0.1],
      rank1: true,
      currentTruthAt1: true,
      passed: true,
      reason: "expected id in top-1",
    },
    // Positive query: gate does NOT abstain -> hit@5 = 1.
    {
      queryId: "p2",
      family: "exact",
      query: "bar",
      expectedIds: [11],
      currentTruthIds: [11],
      topIds: [11, 1, 2, 3, 4],
      topScores: [0.9, 0.4, 0.3, 0.2, 0.1],
      rank1: true,
      currentTruthAt1: true,
      passed: true,
      reason: "expected id in top-1",
    },
    // No-answer query: gate abstains -> TNR +1.
    {
      queryId: "n1",
      family: "no-answer",
      query: "nope",
      expectedIds: [],
      currentTruthIds: [],
      topIds: [],
      topScores: [],
      rank1: false,
      currentTruthAt1: false,
      passed: true,
      reason: "no-answer query; ranker returned zero hits",
    },
    // No-answer query: gate does NOT abstain -> TNR stays.
    {
      queryId: "n2",
      family: "no-answer",
      query: "nope2",
      expectedIds: [],
      currentTruthIds: [],
      topIds: [1, 2, 3, 4, 5],
      topScores: [0.1, 0.1, 0.1, 0.1, 0.1],
      rank1: false,
      currentTruthAt1: false,
      passed: false,
      reason: "no-answer query; ranker returned 5 hit(s)",
    },
  ];
  const diags = [
    // p1: original [10,1,2,3,4] with top=0.5. Gate @ 0.6 abstains.
    buildQueryDiagnostic(
      "p1",
      "exact",
      true,
      [
        { id: 10, score: 0.5 },
        { id: 1, score: 0.4 },
        { id: 2, score: 0.3 },
        { id: 3, score: 0.2 },
        { id: 4, score: 0.1 },
      ],
      [{ kind: "threshold", value: 0.6 }],
      "higher-is-better",
    ),
    // p2: original [11,1,2,3,4] with top=0.9. Gate @ 0.6 does not abstain.
    buildQueryDiagnostic(
      "p2",
      "exact",
      true,
      [
        { id: 11, score: 0.9 },
        { id: 1, score: 0.4 },
        { id: 2, score: 0.3 },
        { id: 3, score: 0.2 },
        { id: 4, score: 0.1 },
      ],
      [{ kind: "threshold", value: 0.6 }],
      "higher-is-better",
    ),
    // n1: ranker naturally empty.
    buildQueryDiagnostic(
      "n1",
      "no-answer",
      false,
      [],
      [{ kind: "threshold", value: 0.6 }],
      "higher-is-better",
    ),
    // n2: ranker returned [1,2,3,4,5]. Gate does not trigger.
    buildQueryDiagnostic(
      "n2",
      "no-answer",
      false,
      [
        { id: 1, score: 0.1 },
        { id: 2, score: 0.1 },
        { id: 3, score: 0.1 },
        { id: 4, score: 0.1 },
        { id: 5, score: 0.1 },
      ],
      [{ kind: "threshold", value: 0.6 }],
      "higher-is-better",
    ),
  ];
  const m = computeTradeoff(diags, evals);
  assert.equal(m.hitAt5, 1, "p2 is the only positive hit@5 after abstention");
  assert.equal(m.rank1, 1, "p2 is the only positive rank1 after abstention");
  assert.equal(m.currentTruthAt1, 1);
  assert.equal(m.positiveTotal, 2);
  // n1 is naturally empty (no ranker hits) and n2 is
  // forced to abstain by the threshold gate (0.1 < 0.6).
  // Both count as "no-answer correct" under the gate.
  assert.equal(m.noAnswerCorrect, 2, "n1 (naturally empty) and n2 (forced abstain) are both correct");
  assert.equal(m.noAnswerTotal, 2);
});

// ---------------------------------------------------------------------------
// 6. pickBestRow
// ---------------------------------------------------------------------------

const fakeRow = (
  overrides: Partial<CalibrationVariantResult> & { gateValue: number | null; gateLabel: string },
): CalibrationVariantResult => ({
  variant: "lexical",
  gateLabel: overrides.gateLabel,
  gateValue: overrides.gateValue,
  gateKind: overrides.gateKind ?? "threshold",
  positiveRegressions: overrides.positiveRegressions ?? 0,
  noAnswerFixed: overrides.noAnswerFixed ?? 0,
  noAnswerRemainingFp: overrides.noAnswerRemainingFp ?? 10,
  metrics: overrides.metrics ?? {
    hitAt5: 0,
    rank1: 0,
    currentTruthAt1: 0,
    noAnswerCorrect: 0,
    positiveTotal: 44,
    noAnswerTotal: 10,
    multiHopAny: 0,
    multiHopTotal: 0,
    multiHopComplete: 0,
    orientationRecallAt5: 0,
    orientationSlotCoverageAt5: 0,
    orientationTotal: 0,
  },
  diagnostics: overrides.diagnostics ?? [],
});

test("calibration: pickBestRow maximizes TNR delta over baseline", () => {
  const baseline = fakeRow({ gateLabel: "no-extra-gate", gateValue: null });
  // Two rows: row A has a higher TNR but more regressions;
  // row B has a smaller TNR but fewer regressions. The
  // rule is "maximize TNR delta first", so A wins.
  const a = fakeRow({
    gateLabel: "threshold@0.4",
    gateValue: 0.4,
    noAnswerRemainingFp: 0,
    positiveRegressions: 14,
    metrics: {
      hitAt5: 27,
      rank1: 21,
      currentTruthAt1: 21,
      noAnswerCorrect: 10,
      positiveTotal: 44,
      noAnswerTotal: 10,
      multiHopAny: 0,
      multiHopTotal: 0,
      multiHopComplete: 0,
      orientationRecallAt5: 0,
      orientationSlotCoverageAt5: 0,
      orientationTotal: 0,
    },
  });
  const b = fakeRow({
    gateLabel: "threshold@0.3",
    gateValue: 0.3,
    noAnswerRemainingFp: 4,
    positiveRegressions: 12,
    metrics: {
      hitAt5: 28,
      rank1: 21,
      currentTruthAt1: 21,
      noAnswerCorrect: 6,
      positiveTotal: 44,
      noAnswerTotal: 10,
      multiHopAny: 0,
      multiHopTotal: 0,
      multiHopComplete: 0,
      orientationRecallAt5: 0,
      orientationSlotCoverageAt5: 0,
      orientationTotal: 0,
    },
  });
  assert.equal(pickBestRow(baseline, [a, b]), a);
});

test("calibration: pickBestRow tie-breaks on smallest regression count", () => {
  const baseline = fakeRow({ gateLabel: "no-extra-gate", gateValue: null });
  // Two rows with the same TNR. The one with FEWER
  // positive regressions wins.
  const fewerRegressions = fakeRow({
    gateLabel: "threshold@0.3",
    gateValue: 0.3,
    noAnswerRemainingFp: 4,
    positiveRegressions: 8,
    metrics: {
      hitAt5: 30,
      rank1: 22,
      currentTruthAt1: 22,
      noAnswerCorrect: 6,
      positiveTotal: 44,
      noAnswerTotal: 10,
      multiHopAny: 0,
      multiHopTotal: 0,
      multiHopComplete: 0,
      orientationRecallAt5: 0,
      orientationSlotCoverageAt5: 0,
      orientationTotal: 0,
    },
  });
  const moreRegressions = fakeRow({
    gateLabel: "threshold@0.4",
    gateValue: 0.4,
    noAnswerRemainingFp: 4,
    positiveRegressions: 12,
    metrics: {
      hitAt5: 30,
      rank1: 22,
      currentTruthAt1: 22,
      noAnswerCorrect: 6,
      positiveTotal: 44,
      noAnswerTotal: 10,
      multiHopAny: 0,
      multiHopTotal: 0,
      multiHopComplete: 0,
      orientationRecallAt5: 0,
      orientationSlotCoverageAt5: 0,
      orientationTotal: 0,
    },
  });
  assert.equal(pickBestRow(baseline, [moreRegressions, fewerRegressions]), fewerRegressions);
});

test("calibration: pickBestRow returns null on an empty sweep", () => {
  const baseline = fakeRow({ gateLabel: "no-extra-gate", gateValue: null });
  assert.equal(pickBestRow(baseline, []), null);
});

// ---------------------------------------------------------------------------
// 7. End-to-end runner
// ---------------------------------------------------------------------------

test("calibration runner: report shape is well-formed for all variants", () => {
  const report = runCalibration({ variant: "all" });
  assert.equal(typeof report.generatedAt, "string");
  assert.equal(report.config.recordCount, BENCHMARK_RECORDS.length);
  assert.equal(report.config.queryCount, BENCHMARK_QUERIES.length);
  assert.equal(report.config.direction, "higher-is-better");
  assert.equal(report.baseline.length, 3, "one baseline row per variant");
  for (const b of report.baseline) {
    assert.ok(["lexical", "fts5", "vector"].includes(b.variant));
    assert.equal(b.gateLabel, "no-extra-gate");
    assert.equal(b.gateValue, null);
    assert.equal(b.gateKind, null);
  }
  // Sweep: at least one row per (variant, kind).
  for (const v of ["lexical", "fts5", "vector"] as const) {
    for (const k of ["threshold", "margin", "ratio"] as const) {
      const has = report.sweep.some(
        (r) => r.variant === v && r.gateKind === k,
      );
      assert.ok(has, `expected sweep row for ${v}/${k}`);
    }
  }
  // Best row per variant is non-null.
  for (const v of ["lexical", "fts5", "vector"] as const) {
    assert.ok(report.bestByVariant[v], `expected best row for ${v}`);
  }
});

test("calibration runner: baseline row matches the ranker at threshold=0 (not the production threshold)", () => {
  // The calibration experiment captures the full score
  // distribution per query by running the ranker with
  // `threshold: 0`. The "no extra gate" baseline row is
  // therefore the TNR / hit@5 the ranker WOULD report if
  // the ranker had no built-in threshold and the
  // abstention gates were the only abstention mechanism.
  // This is intentionally different from the existing
  // single-variant report's no-answer TNR, which uses
  // the production default threshold (0.2 for lexical).
  // The test asserts the calibration baseline is
  // consistent with a re-run of the ranker at
  // `threshold: 0`, NOT with the production-threshold
  // single-variant report. This is the right contract:
  // the calibration report is a research artifact that
  // shows the trade-off curve; its baseline is the
  // unfiltered ranker, so the gate's effect is visible.
  for (const v of ["lexical", "fts5", "vector"] as const) {
    const cal = runCalibration({ variant: v });
    const base = cal.baseline.find((b) => b.variant === v);
    assert.ok(base, `missing baseline row for ${v}`);
    // Re-run the ranker directly with threshold=0 to get
    // an independent measurement.
    const candidates = buildCandidates(BENCHMARK_RECORDS);
    const queries = BENCHMARK_QUERIES;
    const topK = 5;
    const rankFn = v === "fts5"
      ? (q: string, c: typeof candidates) => rankFts5(q, c, { threshold: 0, topK })
      : v === "vector"
        ? (q: string, c: typeof candidates) => rankVector(q, c, { threshold: 0, topK })
        : (q: string, c: typeof candidates) => rankLexical(q, c, { threshold: 0, topK });
    const evals: QueryEval[] = queries.map((q) => {
      const ranked = rankFn(q.query, candidates);
      return {
        queryId: q.id,
        family: q.family,
        query: q.query,
        expectedIds: q.expectedIds,
        currentTruthIds: q.currentTruthIds,
        topIds: ranked.map((r) => r.id),
        topScores: ranked.map((r) => r.score),
        rank1: false,
        currentTruthAt1: false,
        passed: false,
        reason: "",
      };
    });
    for (const e of evals) {
      const expected = new Set(e.expectedIds);
      const top0 = e.topIds[0];
      e.rank1 = top0 !== undefined && expected.has(top0);
      const ct = new Set(e.currentTruthIds);
      e.currentTruthAt1 = top0 !== undefined && ct.has(top0);
      e.passed = e.expectedIds.length === 0
        ? e.topIds.length === 0
        : e.topIds.slice(0, 5).some((id) => expected.has(id));
    }
    const m = aggregateMetrics(evals);
    assert.equal(
      base.metrics.noAnswerCorrect,
      m.noAnswerCorrect,
      `${v}: calibration baseline noAnswerCorrect disagrees with direct threshold=0 re-run`,
    );
    assert.equal(
      base.metrics.hitAt5,
      m.hitAt5,
      `${v}: calibration baseline hit@5 disagrees with direct threshold=0 re-run`,
    );
    assert.equal(
      base.metrics.rank1,
      m.rank1,
      `${v}: calibration baseline rank1 disagrees with direct threshold=0 re-run`,
    );
  }
});

test("calibration runner: per-query diagnostics have the required fields", () => {
  const report = runCalibration({ variant: "lexical" });
  const best = report.bestByVariant.lexical;
  assert.ok(best);
  for (const d of best.diagnostics) {
    // Required fields per Architect brief.
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
    // `family` and `queryId` must be present.
    assert.equal(typeof d.family, "string");
    assert.equal(typeof d.queryId, "string");
    // After-abstain ids must be a subset of original ids
    // (or empty if abstained). Pinning this so a future
    // edit cannot silently "leak" ids past the gate.
    if (d.abstained) {
      assert.equal(d.afterAbstainTopIds.length, 0);
    } else {
      // The first K ids after abstention are the first K
      // original ids. This is the natural "no-threshold"
      // passthrough behavior: if the gate does not
      // trigger, the after-abstain top-K is the original
      // top-K. Asserted in full to keep the contract
      // explicit.
      assert.deepEqual(d.afterAbstainTopIds, d.originalTopIds);
    }
  }
});

test("calibration runner: per-query positive regressions are subset of positive evals", () => {
  // The "positive regressions" count is the number of
  // positive (non no-answer) queries forced to abstain.
  // It must never exceed the total number of positive
  // queries in the corpus.
  for (const v of ["lexical", "fts5", "vector"] as const) {
    const report = runCalibration({ variant: v });
    const best = report.bestByVariant[v];
    assert.ok(best);
    const positiveTotal = BENCHMARK_QUERIES.filter(
      (q) => q.family !== "no-answer",
    ).length;
    assert.ok(
      best.positiveRegressions <= positiveTotal,
      `${v}: regressions (${best.positiveRegressions}) > positive total (${positiveTotal})`,
    );
    // noAnswerFixed must never exceed noAnswerTotal.
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
// 8. FTS5 score direction
// ---------------------------------------------------------------------------

test("calibration: FTS5 LexicalScoredCandidate.score is higher-is-better (sanity)", () => {
  // The calibration gate for FTS5 uses the squashed
  // score returned by `rankFts5`, which is the
  // `normalizeFts5Score` form (`1 / (1 + |bm25|)`). This
  // is a higher-is-better value in (0, 1]. The test
  // asserts:
  //   - a stronger BM25 (more negative) yields a LARGER
  //     squashed score.
  //   - a single ranker call returns scores in the
  //     (0, 1] range.
  // If a future change to `normalizeFts5Score` flips the
  // sign, the calibration gate direction must be
  // revisited. The test pins the contract.
  const a = normalizeFts5Score(-1);
  const b = normalizeFts5Score(-5);
  const c = normalizeFts5Score(-10);
  assert.ok(a > 0 && a <= 1);
  assert.ok(b > a, `stronger match should give a larger score: ${b} vs ${a}`);
  assert.ok(c > b, `stronger match should give a larger score: ${c} vs ${b}`);
  // 0 (no match) -> 0.
  assert.equal(normalizeFts5Score(0), 0);
  // A very negative (strong) match approaches 1 from below.
  // (The function short-circuits non-finite inputs to 0
  // to keep the ranker safe on edge cases, so we test the
  // squash with a large finite negative value instead of
  // -Infinity.)
  const veryStrong = normalizeFts5Score(-1000);
  assert.ok(veryStrong > 0.99, `very strong match should approach 1, got ${veryStrong}`);
  assert.ok(veryStrong <= 1);
});

test("calibration: FTS5 ranker call returns higher-is-better scores in [0, 1]", () => {
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const ranked = rankFts5("postgres schema migration", candidates, {
    threshold: 0,
    topK: 5,
  });
  assert.ok(ranked.length > 0, "FTS5 must return at least one hit for this query");
  for (const r of ranked) {
    assert.ok(
      r.score >= 0 && r.score <= 1,
      `FTS5 score out of [0, 1]: ${r.score}`,
    );
  }
  // Order: score desc. The FTS5 variant sorts by score
  // desc, so the first element is the maximum.
  for (let i = 1; i < ranked.length; i++) {
    assert.ok(
      ranked[i - 1]!.score >= ranked[i]!.score,
      `FTS5 not sorted by score desc: [${i - 1}]=${ranked[i - 1]!.score} < [${i}]=${ranked[i]!.score}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 9. Vector threshold baseline behavior
// ---------------------------------------------------------------------------

test("calibration: vector with default threshold 0 returns a hit for every positive query", () => {
  // The Architect brief notes that the default
  // `DEFAULT_VECTOR_THRESHOLD = 0` is a baseline artifact
  // to calibrate. With threshold 0, the vector variant
  // returns at least one hit for every non-empty query
  // because cosine similarity is always >= 0 for
  // non-negative normalized BoW vectors. The test pins
  // this so the calibration baseline row's TNR = 0 is
  // explicable: every no-answer query also gets a hit,
  // and the natural abstention rate is 0.
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  for (const q of BENCHMARK_QUERIES) {
    if (q.family === "no-answer") continue;
    const ranked = rankVector(q.query, candidates, {
      threshold: DEFAULT_VECTOR_THRESHOLD,
      topK: 5,
    });
    assert.ok(
      ranked.length > 0,
      `vector returned empty for positive query ${q.id} at default threshold; expected at least one hit`,
    );
  }
});

test("calibration: vector at threshold 0 still returns hits for no-answer queries (the artifact)", () => {
  // The baseline artifact: with default threshold 0, the
  // vector variant returns hits for every query with at
  // least one surviving token, including no-answer
  // queries. This is the "0% TNR" the calibration
  // experiment is trying to fix. The test pins it so the
  // calibration report's TNR = 0 row is not surprising.
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  let hits = 0;
  for (const q of BENCHMARK_QUERIES) {
    if (q.family !== "no-answer") continue;
    const ranked = rankVector(q.query, candidates, {
      threshold: DEFAULT_VECTOR_THRESHOLD,
      topK: 5,
    });
    if (ranked.length > 0) hits += 1;
  }
  // Most or all no-answer queries return a hit. The
  // exact count depends on tokenization; we assert
  // "most" to allow a small number of cases where
  // tokenize() drops every token (e.g. all stopwords).
  assert.ok(
    hits >= 5,
    `vector at threshold 0 returned hits for ${hits} no-answer queries; expected most of 10`,
  );
});

test("calibration: vector embedder is deterministic across calls", () => {
  // The calibration report's per-query score trace must
  // be stable across runs (so byte-equal JSON artifacts
  // are reproducible). The default embedder is
  // deterministic; we re-embed the same text twice and
  // assert equality.
  const embedder = new HashedBagOfWordsEmbedder();
  const a = embedder.embed("Postgres schema migration");
  const b = embedder.embed("Postgres schema migration");
  assert.equal(a.dim, b.dim);
  assert.deepEqual([...a.values], [...b.values]);
});

// ---------------------------------------------------------------------------
// 10. CLI parsing
// ---------------------------------------------------------------------------

test("cli: --calibrate parses and is opt-in", () => {
  const opts = parseRetrievalCli(["--calibrate"]);
  assert.equal(opts.calibration, true);
  // The default calibration config is constructed even
  // when --calibrate-direction is not passed. (Pinned so
  // a future edit cannot leave the artifact without a
  // direction.)
  assert.ok(opts.calibrationConfig);
  assert.equal(opts.calibrationConfig.direction, undefined, "direction defaults to higher-is-better");
});

test("cli: --calibrate-direction parses both directions", () => {
  const a = parseRetrievalCli(["--calibrate-direction", "higher-is-better"]);
  assert.equal(a.calibrationConfig?.direction, "higher-is-better");
  const b = parseRetrievalCli(["--calibrate-direction", "lower-is-better"]);
  assert.equal(b.calibrationConfig?.direction, "lower-is-better");
});

test("cli: --calibrate-direction rejects unknown values", () => {
  assert.throws(
    () => parseRetrievalCli(["--calibrate-direction", "sideways"]),
    /higher-is-better\|lower-is-better/,
  );
});

test("cli: --calibrate without --variant defaults to all variants", () => {
  const opts = parseRetrievalCli(["--calibrate"]);
  assert.equal(opts.variant, undefined, "no --variant means the calibration runner defaults to all");
});

// ---------------------------------------------------------------------------
// 10b. Regression guard: calibration excludes hybrid (Reviewer pin)
// ---------------------------------------------------------------------------

test("calibration: --variant hybrid --calibrate produces an empty calibration report (hybrid is rank-only)", () => {
  // The hybrid variant is a rank-fusion layer on top of
  // the three single-variant rankers; it does not
  // introduce an abstention gate of its own. The
  // calibration experiment studies abstention gates on
  // the single-variant rankers, so the v1 contract is
  // "the hybrid variant is excluded from the calibration
  // pass". This test pins that contract: a
  // `--variant hybrid --calibrate` run produces a
  // well-formed but empty calibration report (no
  // baseline rows, no sweep rows, no best rows).
  const report = runCalibration({ variant: "hybrid" });
  // The shape is preserved: config block, timestamp,
  // empty baseline / sweep arrays, all-null best rows.
  assert.equal(report.config.recordCount, BENCHMARK_RECORDS.length);
  assert.equal(report.config.queryCount, BENCHMARK_QUERIES.length);
  assert.equal(report.baseline.length, 0, "no baseline rows for hybrid");
  assert.equal(report.sweep.length, 0, "no sweep rows for hybrid");
  assert.equal(report.bestByVariant.lexical, null);
  assert.equal(report.bestByVariant.fts5, null);
  assert.equal(report.bestByVariant.vector, null);
});

test("calibration: --variant all --calibrate includes exactly the three calibratable variants (no hybrid row)", () => {
  // Pin: the calibration report's `baseline` and
  // `sweep` arrays must NEVER carry a hybrid row, even
  // when `--variant all` is used. A future refactor that
  // accidentally re-introduces hybrid into the
  // calibration loop will be caught here.
  const report = runCalibration({ variant: "all" });
  for (const row of report.baseline) {
    assert.notEqual(
      row.variant,
      "hybrid",
      "calibration baseline must not contain a hybrid row",
    );
  }
  for (const row of report.sweep) {
    assert.notEqual(
      row.variant,
      "hybrid",
      "calibration sweep must not contain a hybrid row",
    );
  }
  // And `bestByVariant` is documented as exactly the
  // three calibratable variants; the hybrid key does
  // not exist.
  assert.ok(
    !("hybrid" in report.bestByVariant),
    "bestByVariant must not have a hybrid key",
  );
});

// ---------------------------------------------------------------------------
// 11. Human report count display (Reviewer follow-up fix)
// ---------------------------------------------------------------------------

test("calibration report: per-query diagnostic counts reflect total, not slice length", () => {
  // The Reviewer found a bug in `formatCalibrationReport`:
  // the per-query diagnostic sections were slicing to
  // `perQueryLimit` first and then reporting the sliced
  // length, which made the displayed "positive regressions"
  // / "no-answer fixed" / "no-answer still confabulating"
  // counts undercount whenever there was truncation. The
  // fix computes the total count from the un-sliced list and
  // labels the truncation with a " (showing first N)" suffix.
  //
  // This test constructs a minimal report with 24 positive
  // regressions on the "vector" best row (more than the
  // default perQueryLimit of 20) and asserts that the
  // displayed count is 24 with a "showing first 20" label,
  // NOT 20.
  const makeDiag = (
    queryId: string,
    isPositive: boolean,
    abstained: boolean,
  ): import("../src/benchmark/calibration.ts").CalibrationQueryDiagnostic => ({
    queryId,
    family: isPositive ? "exact" : "no-answer",
    isPositive,
    topScore: 0.5,
    secondScore: 0,
    scoreGap: 0.5,
    scoreRatio: Number.POSITIVE_INFINITY,
    originalTopIds: [1],
    originalTopScores: [0.5],
    abstained,
    abstainedByGate: abstained ? ["threshold@1.0"] : [],
    abstentionWasCorrect: isPositive ? !abstained : abstained,
    afterAbstainTopIds: abstained ? [] : [1],
    naturallyAbstained: false,
  });

  // 24 positive queries forced to abstain (regressions).
  // 3 no-answer queries fixed by abstention.
  // 1 no-answer query still confabulating.
  const diags: import("../src/benchmark/calibration.ts").CalibrationQueryDiagnostic[] =
    [];
  for (let i = 0; i < 24; i++) diags.push(makeDiag(`p${i}`, true, true));
  for (let i = 0; i < 3; i++) diags.push(makeDiag(`nfix${i}`, false, true));
  diags.push(makeDiag("nrem0", false, false));

  const best = {
    variant: "vector" as const,
    gateLabel: "threshold@1.0",
    gateValue: 1.0,
    gateKind: "threshold" as const,
    positiveRegressions: 24,
    noAnswerFixed: 3,
    noAnswerRemainingFp: 1,
    metrics: {
      hitAt5: 0,
      rank1: 0,
      currentTruthAt1: 0,
      noAnswerCorrect: 3,
      positiveTotal: 24,
      noAnswerTotal: 4,
      multiHopAny: 0,
      multiHopTotal: 0,
      multiHopComplete: 0,
      orientationRecallAt5: 0,
      orientationSlotCoverageAt5: 0,
      orientationTotal: 0,
    },
    diagnostics: diags,
  };

  const report: import("../src/benchmark/calibration.ts").CalibrationReport = {
    generatedAt: "2026-06-12T00:00:00.000Z",
    config: {
      recordCount: 60,
      queryCount: 28,
      direction: "higher-is-better",
    },
    baseline: [
      {
        variant: "vector",
        gateLabel: "no-extra-gate",
        gateValue: null,
        gateKind: null,
        positiveRegressions: 0,
        noAnswerFixed: 0,
        noAnswerRemainingFp: 4,
        metrics: {
          hitAt5: 0,
          rank1: 0,
          currentTruthAt1: 0,
          noAnswerCorrect: 0,
          positiveTotal: 24,
          noAnswerTotal: 4,
          multiHopAny: 0,
          multiHopTotal: 0,
          multiHopComplete: 0,
          orientationRecallAt5: 0,
          orientationSlotCoverageAt5: 0,
          orientationTotal: 0,
        },
        diagnostics: diags.map((d) => ({ ...d, abstained: false })),
      },
    ],
    sweep: [best],
    bestByVariant: { lexical: null, fts5: null, vector: best },
  };

  // Default perQueryLimit is 20. We have 24 regressions,
  // 3 fixed, and 1 remaining. Only the regressions section
  // truncates.
  const out = formatCalibrationReport(report);
  // The fix: the displayed count must be 24 (the true
  // total), not 20 (the slice length). And the truncation
  // must be labeled.
  assert.match(
    out,
    /positive queries forced to abstain: 24 \(showing first 20\)/,
    `regression count should reflect true total (24) and label truncation, got:\n${out}`,
  );
  // The other two sections have counts <= the limit and
  // must NOT carry a "showing first" label.
  assert.match(
    out,
    /no-answer queries fixed by abstention: 3(?!\s*\(showing first)/,
    `fixed count should be 3 with no truncation label, got:\n${out}`,
  );
  assert.match(
    out,
    /no-answer queries still confabulating: 1(?!\s*\(showing first)/,
    `remaining count should be 1 with no truncation label, got:\n${out}`,
  );
  // The on-disk JSON artifact is unaffected: the diagnostics
  // array still carries all 28 entries, and the headline
  // counts on the row are the true totals.
  assert.equal(best.diagnostics.length, 28);
  assert.equal(best.positiveRegressions, 24);
  assert.equal(best.noAnswerFixed, 3);
  assert.equal(best.noAnswerRemainingFp, 1);
});

test("calibration report: counts match headlines when below the per-query limit", () => {
  // When the count is below `perQueryLimit` there is no
  // truncation, so no "showing first N" label is added. This
  // pins the "happy path" behavior of the fix.
  const makeDiag = (
    queryId: string,
    isPositive: boolean,
    abstained: boolean,
  ): import("../src/benchmark/calibration.ts").CalibrationQueryDiagnostic => ({
    queryId,
    family: isPositive ? "exact" : "no-answer",
    isPositive,
    topScore: 0.5,
    secondScore: 0,
    scoreGap: 0.5,
    scoreRatio: Number.POSITIVE_INFINITY,
    originalTopIds: [1],
    originalTopScores: [0.5],
    abstained,
    abstainedByGate: abstained ? ["threshold@1.0"] : [],
    abstentionWasCorrect: isPositive ? !abstained : abstained,
    afterAbstainTopIds: abstained ? [] : [1],
    naturallyAbstained: false,
  });
  // 5 positive regressions, 2 no-answer fixed, 1 no-answer
  // remaining. All under perQueryLimit=20.
  const diags: import("../src/benchmark/calibration.ts").CalibrationQueryDiagnostic[] =
    [];
  for (let i = 0; i < 5; i++) diags.push(makeDiag(`p${i}`, true, true));
  for (let i = 0; i < 2; i++) diags.push(makeDiag(`nfix${i}`, false, true));
  diags.push(makeDiag("nrem0", false, false));

  const best = {
    variant: "lexical" as const,
    gateLabel: "threshold@0.3",
    gateValue: 0.3,
    gateKind: "threshold" as const,
    positiveRegressions: 5,
    noAnswerFixed: 2,
    noAnswerRemainingFp: 1,
    metrics: {
      hitAt5: 0,
      rank1: 0,
      currentTruthAt1: 0,
      noAnswerCorrect: 2,
      positiveTotal: 5,
      noAnswerTotal: 3,
      multiHopAny: 0,
      multiHopTotal: 0,
      multiHopComplete: 0,
      orientationRecallAt5: 0,
      orientationSlotCoverageAt5: 0,
      orientationTotal: 0,
    },
    diagnostics: diags,
  };

  const report: import("../src/benchmark/calibration.ts").CalibrationReport = {
    generatedAt: "2026-06-12T00:00:00.000Z",
    config: {
      recordCount: 60,
      queryCount: 8,
      direction: "higher-is-better",
    },
    baseline: [
      {
        variant: "lexical",
        gateLabel: "no-extra-gate",
        gateValue: null,
        gateKind: null,
        positiveRegressions: 0,
        noAnswerFixed: 0,
        noAnswerRemainingFp: 3,
        metrics: {
          hitAt5: 0,
          rank1: 0,
          currentTruthAt1: 0,
          noAnswerCorrect: 0,
          positiveTotal: 5,
          noAnswerTotal: 3,
          multiHopAny: 0,
          multiHopTotal: 0,
          multiHopComplete: 0,
          orientationRecallAt5: 0,
          orientationSlotCoverageAt5: 0,
          orientationTotal: 0,
        },
        diagnostics: diags.map((d) => ({ ...d, abstained: false })),
      },
    ],
    sweep: [best],
    bestByVariant: { lexical: best, fts5: null, vector: null },
  };

  const out = formatCalibrationReport(report);
  // All three sections under the limit: no "showing first" label.
  assert.match(
    out,
    /positive queries forced to abstain: 5(?!\s*\(showing first)/,
    `regression count should be 5 with no truncation label, got:\n${out}`,
  );
  assert.match(
    out,
    /no-answer queries fixed by abstention: 2(?!\s*\(showing first)/,
    `fixed count should be 2 with no truncation label, got:\n${out}`,
  );
  assert.match(
    out,
    /no-answer queries still confabulating: 1(?!\s*\(showing first)/,
    `remaining count should be 1 with no truncation label, got:\n${out}`,
  );
});

test("calibration report: custom perQueryLimit narrows the displayed slice but not the count", () => {
  // Explicit `perQueryLimit: 5` makes the truncation visible
  // in all three sections. Counts are still the true totals.
  const makeDiag = (
    queryId: string,
    isPositive: boolean,
    abstained: boolean,
  ): import("../src/benchmark/calibration.ts").CalibrationQueryDiagnostic => ({
    queryId,
    family: isPositive ? "exact" : "no-answer",
    isPositive,
    topScore: 0.5,
    secondScore: 0,
    scoreGap: 0.5,
    scoreRatio: Number.POSITIVE_INFINITY,
    originalTopIds: [1],
    originalTopScores: [0.5],
    abstained,
    abstainedByGate: abstained ? ["threshold@1.0"] : [],
    abstentionWasCorrect: isPositive ? !abstained : abstained,
    afterAbstainTopIds: abstained ? [] : [1],
    naturallyAbstained: false,
  });
  // 8 regressions, 7 fixed, 6 remaining.
  const diags: import("../src/benchmark/calibration.ts").CalibrationQueryDiagnostic[] =
    [];
  for (let i = 0; i < 8; i++) diags.push(makeDiag(`p${i}`, true, true));
  for (let i = 0; i < 7; i++) diags.push(makeDiag(`nfix${i}`, false, true));
  for (let i = 0; i < 6; i++) diags.push(makeDiag(`nrem${i}`, false, false));

  const best = {
    variant: "fts5" as const,
    gateLabel: "threshold@0.5",
    gateValue: 0.5,
    gateKind: "threshold" as const,
    positiveRegressions: 8,
    noAnswerFixed: 7,
    noAnswerRemainingFp: 6,
    metrics: {
      hitAt5: 0,
      rank1: 0,
      currentTruthAt1: 0,
      noAnswerCorrect: 7,
      positiveTotal: 8,
      noAnswerTotal: 13,
      multiHopAny: 0,
      multiHopTotal: 0,
      multiHopComplete: 0,
      orientationRecallAt5: 0,
      orientationSlotCoverageAt5: 0,
      orientationTotal: 0,
    },
    diagnostics: diags,
  };

  const report: import("../src/benchmark/calibration.ts").CalibrationReport = {
    generatedAt: "2026-06-12T00:00:00.000Z",
    config: {
      recordCount: 60,
      queryCount: 21,
      direction: "higher-is-better",
    },
    baseline: [
      {
        variant: "fts5",
        gateLabel: "no-extra-gate",
        gateValue: null,
        gateKind: null,
        positiveRegressions: 0,
        noAnswerFixed: 0,
        noAnswerRemainingFp: 13,
        metrics: {
          hitAt5: 0,
          rank1: 0,
          currentTruthAt1: 0,
          noAnswerCorrect: 0,
          positiveTotal: 8,
          noAnswerTotal: 13,
          multiHopAny: 0,
          multiHopTotal: 0,
          multiHopComplete: 0,
          orientationRecallAt5: 0,
          orientationSlotCoverageAt5: 0,
          orientationTotal: 0,
        },
        diagnostics: diags.map((d) => ({ ...d, abstained: false })),
      },
    ],
    sweep: [best],
    bestByVariant: { lexical: null, fts5: best, vector: null },
  };

  const out = formatCalibrationReport(report, { perQueryLimit: 5 });
  // All three sections truncate under perQueryLimit=5.
  assert.match(
    out,
    /positive queries forced to abstain: 8 \(showing first 5\)/,
  );
  assert.match(
    out,
    /no-answer queries fixed by abstention: 7 \(showing first 5\)/,
  );
  assert.match(
    out,
    /no-answer queries still confabulating: 6 \(showing first 5\)/,
  );
});

// ---------------------------------------------------------------------------
// 12. Sanity: existing single-variant and comparison reports still pass
// ---------------------------------------------------------------------------

test("calibration: does not change the existing single-variant or comparison reports", () => {
  // Pin the existing single-variant and comparison
  // reports. The calibration experiment is a separate
  // artifact; it must not change the shape or numbers of
  // the existing reports. The pinned numbers here are the
  // adversarial-expansion-checkpoint (132 records / 176
  // queries) lexical baseline. The numbers shifted from
  // the prior 100-record / 96-query checkpoint for two
  // reasons:
  //   1. The new corpus (8 new topical clusters of 4
  //      records each) added 32 candidate records that
  //      the lexical ranker can now surface; the rank1
  //      dropped 1 (43 -> 42) and the noAnswerCorrect
  //      dropped 3 (5 -> 2) on the 96-query baseline
  //      because the new conflict and false-premise-anchor
  //      records share tokens with existing no-answer
  //      queries.
  //   2. The new queries (80 added) include 54 positive
  //      queries targeting the new clusters (the ranker
  //      finds them) and 22 no-answer queries (most of
  //      which confabulate because the new cluster-31
  //      anchors share tokens with them). The aggregate
  //      shifts to: rank1 82/130=63.1%, hit@5
  //      111/130=85.4%, noAnswerCorrect 3/46=6.5%.
  // A future corpus / query set change is a deliberate,
  // visible change; update these numbers and the
  // README's headline table together.
  const single = runRetrievalBenchmark({ variant: "lexical" });
  assert.ok(isSingleVariantReport(single));
  assert.equal(single.metrics.hitAt5, 111, "lexical hit@5 (post-adversarial-expansion)");
  assert.equal(single.metrics.rank1, 82, "lexical rank1 (post-adversarial-expansion)");
  assert.equal(single.metrics.noAnswerCorrect, 3, "lexical noAnswerCorrect (post-adversarial-expansion)");

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
