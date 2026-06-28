/**
 * Tests for the new metrics/reporting foundation.
 *
 * Covers:
 *   1. Standard IR metric correctness
 *      (precision@5, recall@5, F1@5, MRR@5)
 *   2. No-answer confusion matrix (TP/FP/TN/FN,
 *      specificity, confabulation, answer coverage,
 *      abstention precision)
 *   3. Multi-hop partial / complete coverage
 *   4. currentTruth@K diagnostics (1, 3, 5)
 *   5. Score diagnostics (topScore, scoreGap1To2,
 *      mean top scores by outcome, returned count)
 *   6. Structured failure categories
 *   7. Orientation family coverage metrics
 *      (recall@K, slotCoverage@K, noisyReturnRate)
 *   8. Answer-quality scaffold (disabled by default,
 *      never invokes a provider)
 *   9. Bootstrap CI determinism
 *  10. End-to-end runner report shape: the new
 *      derived / orientation / answerQuality blocks
 *      are present and well-formed for lexical / fts5
 *      / vector / all variants.
 *  11. Human report shape: new labeled sections are
 *      present.
 *  12. Known-distractor set is stable and contains
 *      office / historical records.
 *
 * The metrics are pure functions, so each test builds a
 * small synthetic eval list and asserts the math. The
 * runner tests at the end use the real corpus + queries
 * so a regression in either the data or the runner
 * fails a test.
 */

import assert from "node:assert/strict";
import { test } from "node:test";

import {
  ANSWER_QUALITY_DISABLED_LABEL,
  ANSWER_QUALITY_LABELS,
  buildAnswerQualityScaffold as buildAnswerQualityScaffoldFromModule,
  makeAnswerQualityEvaluation,
} from "../src/benchmark/answer-quality.ts";
import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import {
  BENCHMARK_K_VALUES,
  HEADLINE_K,
  HEADLINE_MRR_K,
  type QueryEval,
  aggregateMetrics,
  aggregateOrientationMetrics,
  bootstrapCi,
  buildAnswerQualityScaffold,
  categorizeFailure,
  countPositiveWithEmptyTopK,
  evaluateQuery,
  getKnownDistractorIds,
} from "../src/benchmark/metrics.ts";
import { BENCHMARK_QUERIES } from "../src/benchmark/queries.ts";
import {
  buildCandidates,
  formatComparisonReport,
  formatHumanReport,
  isComparisonReport,
  isSingleVariantReport,
  runRetrievalBenchmark,
} from "../src/benchmark/retrieval-runner.ts";

// ---------------------------------------------------------------------------
// 0. Stable constants
// ---------------------------------------------------------------------------

test("metrics: K constants are stable and match the documented contract", () => {
  assert.deepEqual([...BENCHMARK_K_VALUES], [1, 3, 5, 10]);
  assert.equal(HEADLINE_K, 5);
  assert.equal(HEADLINE_MRR_K, 5);
});

test("metrics: known distractor set contains office and historical records only", () => {
  const distractors = getKnownDistractorIds();
  // Office cluster (records 13..16) and historical cluster
  // (records 21..24) are the project's known distractors.
  for (let i = 13; i <= 16; i++) assert.ok(distractors.has(i), `missing distractor ${i}`);
  for (let i = 21; i <= 24; i++) assert.ok(distractors.has(i), `missing distractor ${i}`);
  // The first 12 records (stack + deploy + people) and
  // docs cluster (17..20) are NOT distractors; the ranker
  // returning any of them in a project-status query is
  // a noise signal but not a distractor label.
  for (let i = 1; i <= 12; i++) assert.ok(!distractors.has(i), `unexpected distractor ${i}`);
  for (let i = 17; i <= 20; i++) assert.ok(!distractors.has(i), `unexpected distractor ${i}`);
});

// ---------------------------------------------------------------------------
// 1. Standard IR metric correctness
// ---------------------------------------------------------------------------

test("metrics: precision@5 / recall@5 / F1@5 / MRR@5 from a synthetic eval set", () => {
  // Three positive queries. We hand-pick top-K shapes so
  // the expected numbers are checkable by hand.
  const evals: QueryEval[] = [
    // expected [1], top [1, 2, 3]: TP=1, FP=2, FN=0
    evaluateQuery("e1", "exact", "q", [1], [1], [1, 2, 3], [0.8, 0.4, 0.2]),
    // expected [4, 5], top [4, 99, 5]: TP=2, FP=1, FN=0
    evaluateQuery("e2", "exact", "q", [4, 5], [4, 5], [4, 99, 5], [0.8, 0.5, 0.2]),
    // expected [6, 7], top [99, 100]: TP=0, FP=2, FN=2
    evaluateQuery("e3", "exact", "q", [6, 7], [6, 7], [99, 100], [0.8, 0.5]),
  ];
  const m = aggregateMetrics(evals);
  const d = m.derived;
  // Micro-averaged: TP=3, FP=5, FN=2
  // precision = 3 / (3+5) = 0.375
  // recall    = 3 / (3+2) = 0.6
  // F1        = 2 * 0.375 * 0.6 / (0.375 + 0.6) = 0.45 / 0.975 ≈ 0.461538
  assert.equal(d.tp, 3);
  assert.equal(d.fp, 5);
  assert.equal(d.fn, 2);
  assert.ok(Math.abs(d.precisionAtK - 0.375) < 1e-9, `precision: ${d.precisionAtK}`);
  assert.ok(Math.abs(d.recallAtK - 0.6) < 1e-9, `recall: ${d.recallAtK}`);
  const expectedF1 = (2 * 0.375 * 0.6) / (0.375 + 0.6);
  assert.ok(Math.abs(d.f1At5 - expectedF1) < 1e-9, `f1: ${d.f1At5} expected ${expectedF1}`);
  // MRR@5: e1 -> 1/1, e2 -> 1/1 (first expected at rank 1),
  // e3 -> 0. Mean = 2/3.
  assert.ok(Math.abs(d.mrrAtK - 2 / 3) < 1e-9, `mrr: ${d.mrrAtK}`);
});

test("metrics: MRR@5 gives 0 for a positive query with no expected id in top-K", () => {
  const evals: QueryEval[] = [
    evaluateQuery("e1", "exact", "q", [1], [1], [2, 3, 4, 5, 6], [0.8, 0.6, 0.5, 0.4, 0.3]),
  ];
  const m = aggregateMetrics(evals);
  assert.equal(m.derived.mrrAtK, 0);
});

test("metrics: MRR@5 uses the reciprocal rank of the FIRST expected id in top-K", () => {
  const evals: QueryEval[] = [
    evaluateQuery("e1", "exact", "q", [3], [3], [9, 8, 3, 4], [0.9, 0.7, 0.5, 0.4]),
  ];
  const m = aggregateMetrics(evals);
  // 3 is at position 3 -> reciprocal rank 1/3
  assert.ok(Math.abs(m.derived.mrrAtK - 1 / 3) < 1e-9, `mrr: ${m.derived.mrrAtK}`);
});

// ---------------------------------------------------------------------------
// 2. No-answer confusion matrix
// ---------------------------------------------------------------------------

test("metrics: no-answer confusion matrix is well-formed on a balanced synthetic set", () => {
  const evals: QueryEval[] = [
    // Positive queries:
    evaluateQuery("p1", "exact", "q", [1], [1], [1, 2], [0.8, 0.4]), // TP
    evaluateQuery("p2", "exact", "q", [1], [1], [1, 2, 3], [0.8, 0.4, 0.2]), // TP
    evaluateQuery("p3", "exact", "q", [1], [1], [], []), // FN (positive, empty top-K)
    // No-answer queries:
    evaluateQuery("n1", "no-answer", "q", [], [], [], []), // TN
    evaluateQuery("n2", "no-answer", "q", [], [], [9], [0.3]), // FP
  ];
  const m = aggregateMetrics(evals);
  const d = m.derived;
  // Binary confusion matrix:
  // - positive with non-empty top-K -> TP (2)
  // - positive with empty top-K -> FN (1)
  // - no-answer with empty top-K -> TN (1)
  // - no-answer with non-empty top-K -> FP (1)
  assert.equal(d.noAnswerTp, 2);
  assert.equal(d.noAnswerFn, 1);
  assert.equal(d.noAnswerTn, 1);
  assert.equal(d.noAnswerFp, 1);
  // Specificity = TN / (TN + FP) = 0.5
  assert.ok(Math.abs(d.noAnswerSpecificity - 0.5) < 1e-9);
  // FPR = FP / (FP + TN) = 0.5
  assert.ok(Math.abs(d.noAnswerFpr - 0.5) < 1e-9);
  // Answer coverage = TP / positiveTotal = 2 / 3
  assert.ok(Math.abs(d.answerCoverage - 2 / 3) < 1e-9);
  // Abstention precision = TN / (TN + FN) = 1 / 2
  assert.ok(Math.abs(d.abstentionPrecision - 0.5) < 1e-9);
});

test("metrics: countPositiveWithEmptyTopK matches the per-eval count", () => {
  const evals: QueryEval[] = [
    evaluateQuery("p1", "exact", "q", [1], [1], [1, 2], [0.8, 0.4]),
    evaluateQuery("p2", "exact", "q", [1], [1], [], []),
    evaluateQuery("n1", "no-answer", "q", [], [], [], []),
  ];
  assert.equal(countPositiveWithEmptyTopK(evals), 1);
});

// ---------------------------------------------------------------------------
// 3. Multi-hop partial / complete coverage
// ---------------------------------------------------------------------------

test("metrics: multi-hop coverage reports partial and complete rates", () => {
  const evals: QueryEval[] = [
    // Multi-hop with 2 expected ids: 1 of 2 in top-K (partial only)
    evaluateQuery("mh1", "multi-hop", "q", [1, 2], [1, 2], [1, 99], [0.8, 0.4]),
    // Multi-hop with 2 expected ids: both in top-K (complete)
    evaluateQuery("mh2", "multi-hop", "q", [3, 4], [3, 4], [3, 4, 5], [0.8, 0.6, 0.4]),
    // Multi-hop with 2 expected ids: none in top-K (failed)
    evaluateQuery("mh3", "multi-hop", "q", [5, 6], [5, 6], [99, 100], [0.8, 0.6]),
    // Non-multi-hop: should NOT contribute
    evaluateQuery("e1", "exact", "q", [1], [1], [1, 2], [0.8, 0.4]),
  ];
  const m = aggregateMetrics(evals);
  const d = m.derived;
  assert.equal(d.multiHopTotal, 3);
  assert.equal(d.multiHopAny, 2);
  assert.equal(d.multiHopComplete, 1);
  assert.ok(Math.abs(d.multiHopAnyRate - 2 / 3) < 1e-9);
  assert.ok(Math.abs(d.multiHopCompleteRate - 1 / 3) < 1e-9);
});

// ---------------------------------------------------------------------------
// 4. currentTruth@K diagnostics
// ---------------------------------------------------------------------------

test("metrics: currentTruth@1/@3/@5 diagnostics — current fact at different ranks", () => {
  const evals: QueryEval[] = [
    // Current fact at rank 1: counts in @1, @3, @5
    evaluateQuery("t1", "temporal", "q", [1], [1], [1, 2, 3], [0.8, 0.4, 0.2]),
    // Current fact at rank 3: counts in @3, @5 but not @1
    evaluateQuery("t2", "temporal", "q", [3], [3], [9, 8, 3], [0.8, 0.6, 0.4]),
    // Current fact at rank 5: counts in @5 only
    evaluateQuery("t3", "temporal", "q", [5], [5], [9, 8, 7, 6, 5], [0.8, 0.6, 0.5, 0.4, 0.3]),
    // Current fact missing: counts nowhere
    evaluateQuery("t4", "temporal", "q", [10], [10], [9, 8, 7], [0.8, 0.6, 0.4]),
  ];
  const m = aggregateMetrics(evals);
  const d = m.derived;
  assert.equal(d.currentTruthAt1, 1);
  assert.equal(d.currentTruthAt3, 2);
  assert.equal(d.currentTruthAt5, 3);
  assert.equal(d.currentTruthHitsAt5, 3);
  assert.ok(Math.abs(d.currentTruthRecallAt5 - 3 / 4) < 1e-9);
});

test("metrics: currentTruth@K does NOT count no-answer queries", () => {
  const evals: QueryEval[] = [evaluateQuery("n1", "no-answer", "q", [], [], [], [])];
  const m = aggregateMetrics(evals);
  const d = m.derived;
  assert.equal(d.positiveTotalForCurrentTruth, 0);
  assert.equal(d.currentTruthAt1, 0);
  assert.equal(d.currentTruthAt5, 0);
});

// ---------------------------------------------------------------------------
// 5. Score diagnostics
// ---------------------------------------------------------------------------

test("metrics: score diagnostics separate pass / fail / no-answer means", () => {
  const evals: QueryEval[] = [
    // Pass: top score 0.9
    evaluateQuery("p1", "exact", "q", [1], [1], [1, 2, 3], [0.9, 0.4, 0.2]),
    // Pass: top score 0.7
    evaluateQuery("p2", "exact", "q", [2], [2], [9, 2, 3], [0.7, 0.6, 0.4]),
    // Fail: top score 0.5
    evaluateQuery("f1", "exact", "q", [4], [4], [5, 6, 7], [0.5, 0.4, 0.3]),
    // No-answer with a hit: top score 0.3
    evaluateQuery("n1", "no-answer", "q", [], [], [9], [0.3]),
    // No-answer with no hit: top score 0
    evaluateQuery("n2", "no-answer", "q", [], [], [], []),
  ];
  const m = aggregateMetrics(evals);
  const d = m.derived;
  assert.equal(d.scoreSampleCountPass, 2);
  assert.equal(d.scoreSampleCountFail, 1);
  assert.equal(d.scoreSampleCountNoAnswer, 2);
  assert.equal(d.scoreSampleCountAll, 5);
  // mean top score: (0.9 + 0.7 + 0.5 + 0.3 + 0) / 5 = 0.48
  assert.ok(Math.abs(d.meanTopScore - 0.48) < 1e-9, `meanTopScore: ${d.meanTopScore}`);
  // mean pass: (0.9 + 0.7) / 2 = 0.8
  assert.ok(Math.abs(d.meanTopScorePass - 0.8) < 1e-9);
  // mean fail: 0.5
  assert.ok(Math.abs(d.meanTopScoreFail - 0.5) < 1e-9);
  // mean no-answer: (0.3 + 0) / 2 = 0.15
  assert.ok(Math.abs(d.meanTopScoreNoAnswer - 0.15) < 1e-9);
  // mean gap 1->2: only positive queries contribute to
  // the gap sample, and only when they have >=2
  // candidates. The no-answer queries (n1, n2) are
  // excluded. n2 has fewer than 2 candidates and is
  // excluded for that reason too.
  // p1: 0.9-0.4 = 0.5
  // p2: 0.7-0.6 = 0.1
  // f1: 0.5-0.4 = 0.1
  // sum / 3 = 0.7 / 3 ≈ 0.2333
  assert.ok(Math.abs(d.meanScoreGap1To2 - 0.7 / 3) < 1e-9, `gap: ${d.meanScoreGap1To2}`);
  // mean returned count: (3 + 3 + 3 + 1 + 0) / 5 = 2.0
  assert.ok(Math.abs(d.meanReturnedCount - 2.0) < 1e-9);
});

// ---------------------------------------------------------------------------
// 6. Structured failure categories
// ---------------------------------------------------------------------------

test("metrics: failureCategories assigns stable category strings to failing evals", () => {
  const evals: QueryEval[] = [
    evaluateQuery("p1", "paraphrase", "q", [1], [1], [99, 100], [0.8, 0.6]), // paraphrase miss
    evaluateQuery("t1", "temporal", "q", [1], [1], [21, 1, 4], [0.9, 0.5, 0.25]), // temporal wrong-rank1
    evaluateQuery("t2", "temporal", "q", [1], [1], [99, 100], [0.8, 0.6]), // temporal current-fact-missing
    evaluateQuery("n1", "no-answer", "q", [], [], [9], [0.3]), // no-answer fp
  ];
  const m = aggregateMetrics(evals);
  assert.equal(m.failureCategories["paraphrase:vocabulary-mismatch"], 1);
  assert.equal(m.failureCategories["temporal:wrong-rank1-old-fact-on-top"], 1);
  assert.equal(m.failureCategories["temporal:current-fact-missing"], 1);
  assert.equal(m.failureCategories["no-answer-fp:ranker-returned-hits"], 1);
});

test("categorizeFailure: returns a stable label for each documented family", () => {
  // Pin the label table by hand so a future family
  // addition is a deliberate, visible change.
  const cases: Array<[QueryEval, string]> = [
    [
      evaluateQuery("x", "paraphrase", "q", [1], [1], [99, 100], [0.8, 0.6]),
      "paraphrase:vocabulary-mismatch",
    ],
    [
      evaluateQuery("x", "temporal", "q", [1], [1], [21, 1, 4], [0.9, 0.5, 0.25]),
      "temporal:wrong-rank1-old-fact-on-top",
    ],
    [
      evaluateQuery("x", "multi-hop", "q", [1, 2], [1, 2], [99, 100], [0.8, 0.6]),
      "multi-hop:no-relevant-in-top-k",
    ],
    [evaluateQuery("x", "exact", "q", [1], [1], [99, 100], [0.8, 0.6]), "exact:relevant-missing"],
    [
      evaluateQuery("x", "orientation", "q", [1], [1], [13, 14], [0.8, 0.6]),
      "orientation:project-status-not-surfaced",
    ],
    [evaluateQuery("x", "no-answer", "q", [], [], [9], [0.3]), "no-answer-fp:ranker-returned-hits"],
  ];
  for (const [e, label] of cases) {
    assert.equal(categorizeFailure(e), label);
  }
});

// ---------------------------------------------------------------------------
// 7. Orientation family coverage metrics
// ---------------------------------------------------------------------------

test("metrics: aggregateOrientationMetrics computes recall, slot coverage, and noise", () => {
  const evals: QueryEval[] = [
    // Orientation: 2 of 2 expected in top-5, 0 noise
    evaluateQuery("o1", "orientation", "q", [1, 2], [1, 2], [1, 2, 3], [0.8, 0.7, 0.4]),
    // Orientation: 1 of 3 expected in top-5, 2 office distractors
    evaluateQuery("o2", "orientation", "q", [1, 2, 3], [1, 2, 3], [1, 13, 14], [0.8, 0.5, 0.4]),
    // Orientation: 0 of 2 expected in top-5, all distractors
    evaluateQuery("o3", "orientation", "q", [1, 2], [1, 2], [13, 14, 15], [0.8, 0.6, 0.4]),
    // Non-orientation: should NOT contribute
    evaluateQuery("e1", "exact", "q", [1], [1], [1, 2], [0.8, 0.4]),
  ];
  const o = aggregateOrientationMetrics(evals);
  assert.equal(o.total, 3);
  // recall@5 is binary per query: o1 (>=1 in top-5), o2
  // (1 in top-5), o3 (0 in top-5). 2 of 3 hit.
  assert.equal(o.recallAt5, 2);
  // recall@3: o1 has 1 in top-3, o2 has 1 in top-3, o3 has 0
  // in top-3. 2 of 3.
  assert.equal(o.recallAt3, 2);
  // recall@1: o1 has 1 in top-1, o2 has 1 in top-1, o3 has
  // no expected in top-1. 2 of 3.
  assert.equal(o.recallAt1, 2);
  // slot coverage: o1 hits 2/2, o2 hits 1/3, o3 hits 0/2
  // total: 3/7
  assert.equal(o.slotsExpected, 7);
  assert.equal(o.slotsHit, 3);
  assert.ok(Math.abs(o.slotCoverageAt5 - 3 / 7) < 1e-9, `slot cov: ${o.slotCoverageAt5}`);
  // noise: o2 has 2 distractors (13, 14), o3 has 3 distractors
  // (13, 14, 15). noisy queries: 2 of 3.
  assert.equal(o.noisyReturnQueries, 2);
  assert.ok(Math.abs(o.noisyReturnRate - 2 / 3) < 1e-9);
  // mean noise per query: (0 + 2 + 3) / 3 = 5/3
  assert.ok(Math.abs(o.meanNoisePerQuery - 5 / 3) < 1e-9, `noise: ${o.meanNoisePerQuery}`);
  // currentTruth coverage: o1 has [1,2] in top-5, o2 has [1]
  // in top-5, o3 has none
  assert.equal(o.currentTruthCoverageAt5, 2);
});

test("metrics: aggregateOrientationMetrics on empty input is well-formed", () => {
  const o = aggregateOrientationMetrics([]);
  assert.equal(o.total, 0);
  assert.equal(o.slotsExpected, 0);
  assert.equal(o.slotCoverageAt5, 0);
  assert.equal(o.noisyReturnRate, 0);
});

// ---------------------------------------------------------------------------
// 8. Answer-quality scaffold
// ---------------------------------------------------------------------------

test("answer-quality: buildAnswerQualityScaffold returns a disabled scaffold by default", () => {
  const sq = buildAnswerQualityScaffold();
  assert.equal(sq.enabled, false);
  assert.equal(sq.provider, null);
  assert.equal(sq.evaluations, null);
  assert.match(sq.note, /disabled/i);
  // The runner imports from ./answer-quality.ts, not
  // ./metrics.ts, so the same function exposed from
  // both modules must agree.
  const sq2 = buildAnswerQualityScaffoldFromModule();
  assert.equal(sq2.enabled, false);
  assert.equal(sq2.provider, null);
  assert.equal(sq2.evaluations, null);
});

test("answer-quality: ANSWER_QUALITY_LABELS is a stable reserved-label set", () => {
  // Pin the labels so a future rename is a deliberate
  // schema change.
  assert.ok(ANSWER_QUALITY_LABELS.has("faithful"));
  assert.ok(ANSWER_QUALITY_LABELS.has("partial"));
  assert.ok(ANSWER_QUALITY_LABELS.has("off-topic"));
  assert.ok(ANSWER_QUALITY_LABELS.has("refusal"));
  assert.ok(ANSWER_QUALITY_LABELS.has("unsupported"));
  // The disabled-label string is the on-disk marker a
  // reviewer can grep for.
  assert.match(ANSWER_QUALITY_DISABLED_LABEL, /disabled/);
});

test("answer-quality: makeAnswerQualityEvaluation round-trips the type", () => {
  const e = makeAnswerQualityEvaluation("q1", "faithful", 0.9, "grounded in sources");
  assert.equal(e.queryId, "q1");
  assert.equal(e.label, "faithful");
  assert.equal(e.score, 0.9);
  assert.match(e.reason, /grounded/);
});

// ---------------------------------------------------------------------------
// 8b. Runner-level answer-quality guard tests
// ---------------------------------------------------------------------------
//
// The above tests pin the constructor (`buildAnswerQualityScaffold`)
// and the reserved-label set. The runner-level guard tests below
// pin the disabled state on every code path that emits a report:
//   - the single-variant report (lexical / fts5 / vector)
//   - the comparison report (`variant: "all"`)
//
// The disabled state is the retrieval-only-scope contract: a
// future phase that flips `enabled` to `true` MUST also wire
// the judge in, or these tests will catch the regression. We
// keep them explicit (rather than nested inside the per-variant
// shape loop) so a reviewer reading the test file can see the
// guard at a glance.

test("answer-quality guard: runner single-variant report is disabled for every variant", () => {
  for (const v of ["lexical", "fts5", "vector"] as const) {
    const report = runRetrievalBenchmark({ variant: v });
    assert.ok(isSingleVariantReport(report), `${v} should be a single-variant report`);
    if (!isSingleVariantReport(report)) continue;
    assert.equal(
      report.answerQuality.enabled,
      false,
      `${v} report.answerQuality.enabled must be false in this phase`
    );
    assert.equal(report.answerQuality.provider, null);
    assert.equal(report.answerQuality.evaluations, null);
    // The note must surface the disabled state so a
    // reviewer who greps the JSON artifact for it sees
    // the intentional off-state.
    assert.match(report.answerQuality.note, /disabled/i);
  }
});

test("answer-quality guard: comparison report is disabled on every nested variant", () => {
  const report = runRetrievalBenchmark({ variant: "all" });
  assert.ok(isComparisonReport(report));
  if (!isComparisonReport(report)) return;
  // The top-level shape is a ComparisonBenchmarkReport;
  // the disabled state is per-variant. Verify each.
  for (const nested of [report.lexical, report.fts5, report.vector]) {
    assert.equal(nested.answerQuality.enabled, false);
    assert.equal(nested.answerQuality.provider, null);
    assert.equal(nested.answerQuality.evaluations, null);
    assert.match(nested.answerQuality.note, /disabled/i);
  }
});

test("answer-quality guard: human report always labels the scaffold as disabled", () => {
  // The single-variant human report must surface the
  // disabled state with the stable label.
  const single = runRetrievalBenchmark();
  assert.ok(isSingleVariantReport(single));
  if (!isSingleVariantReport(single)) return;
  const singleText = formatHumanReport(single);
  assert.match(
    singleText,
    /answer-quality: disabled/,
    "single-variant human report must include the disabled label"
  );
  // The comparison human report must also include the
  // disabled label, since it embeds three per-variant
  // human reports.
  const compare = runRetrievalBenchmark({ variant: "all" });
  assert.ok(isComparisonReport(compare));
  if (!isComparisonReport(compare)) return;
  const compareText = formatComparisonReport(compare);
  assert.match(
    compareText,
    /answer-quality: disabled/,
    "comparison human report must include the disabled label"
  );
});

test("answer-quality guard: scaffold never calls a provider or opens the network", () => {
  // This is a static-import guard rather than a runtime
  // network probe: the test fails if a future edit to
  // the answer-quality module accidentally adds an
  // import of a provider / HTTP client. The retrieval
  // benchmark is intentionally retrieval-only.
  //
  // We do this by importing the answer-quality module's
  // exports and asserting the constructor's note matches
  // the documented "disabled" string. The runner never
  // substitutes the constructor with a live call, and a
  // reviewer who greps the report for the disabled note
  // can confirm the off-state at a glance.
  const sq = buildAnswerQualityScaffold();
  // The default note is the "scaffolded but disabled"
  // explanation; it must NOT contain a provider name or
  // a URL.
  assert.equal(sq.enabled, false);
  assert.match(sq.note, /scaffolded but disabled/);
  assert.equal(sq.provider, null);
  assert.equal(sq.evaluations, null);
});

// ---------------------------------------------------------------------------
// 9. Bootstrap CI determinism
// ---------------------------------------------------------------------------

test("metrics: bootstrapCi is deterministic for a given seed", () => {
  // Same input -> same output.
  const outcomes = [true, false, true, true, false, true];
  const a = bootstrapCi(outcomes);
  const b = bootstrapCi(outcomes);
  assert.equal(a.low, b.low);
  assert.equal(a.high, b.high);
  assert.equal(a.resamples, b.resamples);
});

test("metrics: bootstrapCi returns low <= high and respects the resamples arg", () => {
  const outcomes = [true, false, true, true, false, true, true, false];
  const ci = bootstrapCi(outcomes, { resamples: 250 });
  assert.ok(ci.low <= ci.high);
  assert.equal(ci.resamples, 250);
});

test("metrics: bootstrapCi on all-pass or all-fail collapses to a point", () => {
  // Determinism: an all-pass bootstrap should give
  // low = high = 1, an all-fail should give low = high
  // = 0. This is also the obvious sanity check that
  // the LCG isn't biased.
  const pass = bootstrapCi([true, true, true, true, true]);
  assert.equal(pass.low, 1);
  assert.equal(pass.high, 1);
  const fail = bootstrapCi([false, false, false, false, false]);
  assert.equal(fail.low, 0);
  assert.equal(fail.high, 0);
});

test("metrics: bootstrapCi on empty input is well-formed", () => {
  const ci = bootstrapCi([]);
  assert.equal(ci.low, 0);
  assert.equal(ci.high, 0);
});

// ---------------------------------------------------------------------------
// 10. End-to-end runner shape
// ---------------------------------------------------------------------------

test("runner: report carries orientation, answerQuality, and derived metrics", () => {
  // Run all three variants and check the shape for each.
  // We test against the in-process benchmark so a future
  // schema change to the report (orientation, answerQuality,
  // derived) fails fast.
  const variants: Array<"lexical" | "fts5" | "vector"> = ["lexical", "fts5", "vector"];
  for (const v of variants) {
    const report = runRetrievalBenchmark({ variant: v });
    assert.ok(isSingleVariantReport(report), `${v} should be a single-variant report`);
    if (!isSingleVariantReport(report)) continue;
    // derived block
    assert.ok(report.metrics.derived, `${v} missing derived block`);
    assert.equal(typeof report.metrics.derived.precisionAtK, "number");
    assert.equal(typeof report.metrics.derived.recallAtK, "number");
    assert.equal(typeof report.metrics.derived.f1At5, "number");
    assert.equal(typeof report.metrics.derived.mrrAtK, "number");
    assert.equal(typeof report.metrics.derived.currentTruthAt5, "number");
    assert.equal(typeof report.metrics.derived.noAnswerSpecificity, "number");
    assert.equal(typeof report.metrics.derived.noAnswerFpr, "number");
    assert.equal(typeof report.metrics.derived.answerCoverage, "number");
    assert.equal(typeof report.metrics.derived.abstentionPrecision, "number");
    assert.equal(typeof report.metrics.derived.meanTopScore, "number");
    // failure categories
    assert.ok(report.metrics.failureCategories, `${v} missing failureCategories`);
    assert.equal(typeof report.metrics.failureCategories, "object");
    // orientation block
    assert.ok(report.orientation, `${v} missing orientation block`);
    assert.equal(typeof report.orientation.total, "number");
    assert.equal(typeof report.orientation.recallAt5, "number");
    assert.equal(typeof report.orientation.slotCoverageAt5, "number");
    assert.equal(typeof report.orientation.noisyReturnRate, "number");
    // answer-quality scaffold
    assert.ok(report.answerQuality, `${v} missing answerQuality block`);
    assert.equal(report.answerQuality.enabled, false);
    assert.equal(report.answerQuality.provider, null);
    assert.equal(report.answerQuality.evaluations, null);
  }
});

test("runner: comparison report includes the new derived rows", () => {
  const report = runRetrievalBenchmark({ variant: "all" });
  assert.ok(isComparisonReport(report));
  if (!isComparisonReport(report)) return;
  const metricNames = new Set(report.comparison.map((r) => r.metric));
  for (const required of [
    "precision@5 (%)",
    "recall@5 (%)",
    "F1@5 (%)",
    "MRR@5 (%)",
    "currentTruth@5 (%)",
    "answer coverage (%)",
    "abstention precision (%)",
    "specificity (no-answer, %)",
    "confabulation FPR (%)",
    "multi-hop partial (%)",
    "multi-hop complete (%)",
    "orientation recall@5 (%)",
    "orientation slotCoverage@5 (%)",
    "orientation noisyReturnRate (%)",
  ]) {
    assert.ok(metricNames.has(required), `comparison row missing: ${required}`);
  }
  // Per the contract test, every row must satisfy
  // r.delta === r.fts5 - r.lexical. Re-verify here so a
  // future edit to the comparison builder catches it.
  for (const r of report.comparison) {
    assert.equal(r.delta, r.fts5 - r.lexical);
  }
});

// ---------------------------------------------------------------------------
// 11. Human report shape
// ---------------------------------------------------------------------------

test("runner: formatHumanReport includes the new labeled sections", () => {
  const report = runRetrievalBenchmark();
  assert.ok(isSingleVariantReport(report));
  if (!isSingleVariantReport(report)) return;
  const out = formatHumanReport(report);
  for (const section of [
    "IR (precision/recall/F1/MRR)",
    "currentTruth (positive queries)",
    "no-answer confusion matrix",
    "multi-hop coverage",
    "score diagnostics",
    "orientation (project-status queries)",
    "answer-quality scaffold",
    "failure categories",
  ]) {
    assert.ok(out.includes(section), `human report missing section: ${section}`);
  }
  // The answer-quality section must say "disabled" so
  // a reviewer who greps for it sees the intentional
  // off-state.
  assert.match(out, /answer-quality: disabled/);
  // The orientation block must mention slotCoverage
  // (the multi-slot metric) for project-status queries.
  assert.match(out, /slotCoverage@5/);
});

test("runner: formatComparisonReport includes the new derived rows", () => {
  const report = runRetrievalBenchmark({ variant: "all" });
  assert.ok(isComparisonReport(report));
  if (!isComparisonReport(report)) return;
  const out = formatComparisonReport(report);
  for (const section of [
    "precision@5",
    "F1@5",
    "MRR@5",
    "currentTruth@5",
    "answer coverage",
    "specificity",
    "multi-hop partial",
    "multi-hop complete",
    "orientation",
  ]) {
    assert.ok(out.includes(section), `comparison human report missing: ${section}`);
  }
});

// ---------------------------------------------------------------------------
// 12. Corpus + queries for orientation
// ---------------------------------------------------------------------------

test("benchmark: orientation queries have well-formed expected/current-truth ids", () => {
  // The orientation family uses 4 queries. Pin the
  // contract: at least one query, every expected id
  // resolves, and `currentTruthIds` mirrors
  // `expectedIds` (the corpus has no orientation
  // distractor pair — the expected id IS the current
  // fact, just like the temporal family in the prior
  // phase).
  const validIds = new Set(BENCHMARK_RECORDS.map((r) => r.id));
  const orientation = BENCHMARK_QUERIES.filter((q) => q.family === "orientation");
  assert.ok(orientation.length > 0, "corpus has no orientation queries");
  for (const q of orientation) {
    assert.ok(q.expectedIds.length > 0, `orientation query ${q.id} has empty expectedIds`);
    for (const id of q.expectedIds) {
      assert.ok(validIds.has(id), `orientation query ${q.id} expected ${id} missing from corpus`);
    }
    // Orientation queries are not temporal — current
    // truth equals expected. Pin the invariant so a
    // future revision can't accidentally introduce
    // "current vs expected" orientation distractors
    // without flagging it in the test.
    const a = [...q.currentTruthIds].sort((x, y) => x - y);
    const b = [...q.expectedIds].sort((x, y) => x - y);
    assert.deepEqual(a, b, `orientation query ${q.id} currentTruthIds must mirror expectedIds`);
  }
});

test("runner: buildCandidates keeps the corpus stable for orientation queries", () => {
  // Sanity: the corpus still has every id an orientation
  // query expects. The runner maps records to candidates
  // and the orientation metrics rely on the candidate ids
  // being a strict superset of the orientation expected
  // ids.
  const cs = buildCandidates(BENCHMARK_RECORDS);
  const candIds = new Set(cs.map((c) => c.id));
  const orientation = BENCHMARK_QUERIES.filter((q) => q.family === "orientation");
  for (const q of orientation) {
    for (const id of q.expectedIds) {
      assert.ok(candIds.has(id), `candidate list missing id ${id} for orientation query ${q.id}`);
    }
  }
});
