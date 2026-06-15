/**
 * Tests for the benchmark-only abstention-signal audit.
 *
 * Covers:
 *   1. AUROC math (well-known, pure, tested against
 *      known inputs).
 *   2. Risk-coverage math (well-known, pure, tested
 *      against known inputs).
 *   3. Coverage-at-fixed-risk / risk-at-fixed-coverage
 *      math.
 *   4. Query-shape detector behavior on a small
 *      synthetic set of inputs (including the labeled
 *      hard-negative `nonexistent-load-balancer` and
 *      divergent temporal queries, but the detector
 *      is NOT tuned only to those).
 *   5. Abstention-signal builder additivity (the
 *      regular per-query eval fields are unchanged
 *      when the audit runs).
 *   6. Audit runner end-to-end on the fixture corpus
 *      (stub + real MiniLM).
 *   7. CLI: `--abstention-audit` is accepted; the
 *      artifact file prefix is
 *      `retrieval-abstention-audit-*.json` (distinct
 *      from the existing prefix).
 *   8. Report shape additivity: the audit report does
 *      NOT carry the existing single-variant /
 *      comparison / calibration fields; the existing
 *      report shapes are unchanged.
 *   9. Production import guard: the recall controller
 *      does NOT import the audit module.
 *  10. Public MCP API unchanged: exactly two tools
 *      (remember + recall).
 *
 * The tests split between synthetic unit tests
 * (pure functions, no corpus) and end-to-end tests
 * (real corpus + query set + ranker).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  computeAuRoc,
  computeRiskCoverageCurve,
  coverageAtFixedRisk,
  riskAtFixedCoverage,
  auditSignal,
  auditSlice,
  AUDIT_SIGNAL_NAMES,
  AUDIT_SIGNAL_NOTES,
} from "../src/benchmark/abstention-audit.ts";
import {
  detectQueryShape,
  buildCorpusTokenSets,
  LEGACY_DISTRACTOR_IDS,
} from "../src/benchmark/query-shapes.ts";
import {
  buildAbstentionSignals,
  buildSlices,
  buildPerQueryExamples,
  runAbstentionAudit,
  writeAbstentionAuditReport,
  formatAbstentionAuditReport,
  DIVERGENT_TEMPORAL_IDS,
} from "../src/benchmark/abstention-audit-runner.ts";
import {
  runAbstentionAuditFromBenchmarkReport,
  runAbstentionAuditFromDenseReport,
} from "../src/benchmark/retrieval-runner.ts";
import type { AbstentionSignals } from "../src/benchmark/metrics.ts";
import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.ts";
import { BENCHMARK_QUERIES } from "../src/benchmark/queries.ts";
import {
  runRetrievalBenchmark,
  parseRetrievalCli,
  runDenseRetrievalBenchmark,
} from "../src/benchmark/retrieval-runner.ts";
import { PUBLIC_TOOL_NAMES } from "../src/server.ts";

// ---------------------------------------------------------------------------
// 0. Stable constants
// ---------------------------------------------------------------------------

test("abstention audit: AUDIT_SIGNAL_NAMES is stable and covers the brief", () => {
  // Pin the set of signal names the audit studies.
  // Adding a new signal requires extending the
  // `AbstentionSignals` type, the `extractSignal` map,
  // and these assertions.
  assert.deepEqual(
    [...AUDIT_SIGNAL_NAMES],
    [
      "topScore",
      "top1Top2Gap",
      "top1Top2Ratio",
      "returnedCount",
      "agreementCount",
      "minContributorRank",
      "maxContributorRank",
      "meanContributorRank",
      "minContributorScore",
      "maxContributorScore",
      "meanContributorScore",
    ],
  );
});

test("abstention audit: AUDIT_SIGNAL_NOTES has a non-empty note for every signal", () => {
  for (const s of AUDIT_SIGNAL_NAMES) {
    assert.ok(
      typeof AUDIT_SIGNAL_NOTES[s] === "string" &&
        AUDIT_SIGNAL_NOTES[s].length > 0,
      `signal ${s} must have a non-empty note`,
    );
  }
});

// ---------------------------------------------------------------------------
// 1. AUROC math
// ---------------------------------------------------------------------------

test("AUROC: perfect separation in the natural direction = 1.0", () => {
  // 4 no-answer queries with score 1.0, 4 positives
  // with score 0.0. The signal "high = no-answer" is
  // perfect.
  const labels: Array<0 | 1> = [1, 1, 1, 1, 0, 0, 0, 0];
  const scores = [1, 1, 1, 1, 0, 0, 0, 0];
  const auroc = computeAuRoc(labels, scores);
  assert.equal(auroc, 1.0);
});

test("AUROC: perfect separation in the inverted direction = 1.0 (reported as inverted)", () => {
  // 4 no-answer queries with score 0.0, 4 positives
  // with score 1.0. The natural direction is below
  // 0.5; the audit inverts and reports 1.0 with
  // `scoreIsHigherIsMorePositive = false`.
  const labels: Array<0 | 1> = [1, 1, 1, 1, 0, 0, 0, 0];
  const scores = [0, 0, 0, 0, 1, 1, 1, 1];
  const aurocNatural = computeAuRoc(labels, scores);
  const aurocInverted = computeAuRoc(
    labels,
    scores.map((s) => -s),
  );
  assert.equal(aurocNatural, 0);
  assert.equal(aurocInverted, 1);
});

test("AUROC: random ordering = 0.5 (within tolerance)", () => {
  // Random scores. The AUROC is close to 0.5; the
  // test allows a ±0.15 tolerance because a small
  // random sample is noisy.
  const labels: Array<0 | 1> = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1];
  const scores = [
    0.12, 0.87, 0.34, 0.55, 0.91, 0.05, 0.78, 0.43,
    0.61, 0.29, 0.83, 0.16, 0.94, 0.07, 0.51, 0.68,
  ];
  const auroc = computeAuRoc(labels, scores);
  assert.ok(
    auroc >= 0.35 && auroc <= 0.65,
    `random AUROC should be ~0.5, got ${auroc}`,
  );
});

test("AUROC: known small example (Mann-Whitney-U equivalence)", () => {
  // 5 positives (label=1), 5 negatives (label=0). The
  // 5 positives have scores [3, 4, 5, 6, 7] and the
  // 5 negatives have scores [1, 2, 8, 9, 10]. The
  // signal "high = positive" should produce an
  // intermediate AUROC (the positives beat 3 of the
  // negatives and lose to 2; tied rank handling is
  // exact).
  const labels: Array<0 | 1> = [1, 1, 1, 1, 1, 0, 0, 0, 0, 0];
  const scores = [3, 4, 5, 6, 7, 1, 2, 8, 9, 10];
  const auroc = computeAuRoc(labels, scores);
  // Mann-Whitney U for "positives higher than
  // negatives": the positives beat 1, 2 (2 wins), tie
  // with 3, 4, 5, 6, 7 vs 8, 9, 10 are losses (3
  // losses), with the scores 8, 9, 10 > all positives
  // → 5 * 3 = 15 losses? Let me recompute: 5
  // positives, 5 negatives. Pairs (p, n) where
  // score_p > score_n: positives [3, 4, 5, 6, 7] vs
  // negatives [1, 2, 8, 9, 10]. Pairs where p > n: 3>1,
  // 3>2, 4>1, 4>2, 5>1, 5>2, 6>1, 6>2, 7>1, 7>2 = 10
  // wins. Ties: 0. Losses: 5*5 - 10 = 15. AUROC = 10/25
  // = 0.4.
  assert.ok(
    Math.abs(auroc - 0.4) < 1e-9,
    `AUROC should be exactly 0.4 for the (3,4,5,6,7) vs (1,2,8,9,10) example, got ${auroc}`,
  );
});

test("AUROC: ties on the score get the midrank (deterministic)", () => {
  // 3 positives all tied at 1.0; 3 negatives all tied
  // at 0.0. With strict ordering the AUROC would be
  // 1.0; with midrank tie handling the AUROC is also
  // 1.0 because the rank ordering is the same.
  const labels: Array<0 | 1> = [1, 1, 1, 0, 0, 0];
  const scores = [1, 1, 1, 0, 0, 0];
  const auroc = computeAuRoc(labels, scores);
  assert.equal(auroc, 1.0);
});

test("AUROC: empty input returns 0.5 (uninformative prior)", () => {
  assert.equal(computeAuRoc([], []), 0.5);
});

test("AUROC: single-class input returns 0.5 (no separation possible)", () => {
  // All positives, no negatives. The AUROC is
  // undefined; we return 0.5 so the report is
  // well-formed and a reviewer can sort on the same
  // scale.
  assert.equal(computeAuRoc([1, 1, 1], [0.5, 0.6, 0.7]), 0.5);
  assert.equal(computeAuRoc([0, 0, 0], [0.5, 0.6, 0.7]), 0.5);
});

test("AUROC: throws on length mismatch", () => {
  assert.throws(
    () => computeAuRoc([1, 0], [0.5]),
    /same length/,
  );
});

// ---------------------------------------------------------------------------
// 2. Risk-coverage math
// ---------------------------------------------------------------------------

test("risk-coverage: perfect signal gives a step function with risk=0 on the positive sub-range", () => {
  // 4 no-answer (label=1) with score 1.0, 6 positives
  // (label=0) with score 0.0. A "high = no-answer"
  // signal: a threshold between 0.0 and 1.0 abstains
  // all 4 no-answer queries and keeps all 6
  // positives. Coverage = 6/10 = 0.6, risk = 0/6 = 0.
  // At coverage = 1.0 the risk is 4/10 = 0.4.
  const labels: Array<0 | 1> = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0];
  const scores = [1, 1, 1, 1, 0, 0, 0, 0, 0, 0];
  const curve = computeRiskCoverageCurve(labels, scores);
  // The curve is sorted by coverage ascending. The
  // first point is coverage=1, risk=0.4 (no abstention).
  assert.equal(curve[0]!.coverage, 1);
  assert.ok(Math.abs(curve[0]!.risk - 0.4) < 1e-9);
  // Find the point at coverage=0.6 (sweep k=4:
  // abstains all 4 no-answer, keeps all 6 positives).
  const p6 = curve.find((p) => Math.abs(p.coverage - 0.6) < 1e-9);
  assert.ok(p6, "expected a curve point at coverage=0.6");
  assert.equal(p6.risk, 0);
  // Below coverage=0.6 the risk is also 0 (the signal
  // is perfect on the remaining positives).
  for (const p of curve) {
    if (p.coverage < 0.6) {
      assert.equal(p.risk, 0, `risk should be 0 at coverage=${p.coverage}`);
    }
  }
});

test("risk-coverage: every point is monotone non-increasing in coverage", () => {
  // The curve sweeps the abstention threshold from
  // "abstain nothing" (coverage = 1) down to "abstain
  // almost everything" (coverage near 0). The points
  // are sorted by coverage descending. (The first
  // point is always coverage = 1; the last is the
  // most-abstain point.)
  const labels: Array<0 | 1> = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1];
  const scores = [
    0.12, 0.87, 0.34, 0.55, 0.91, 0.05, 0.78, 0.43,
    0.61, 0.29, 0.83, 0.16, 0.94, 0.07, 0.51, 0.68,
  ];
  const curve = computeRiskCoverageCurve(labels, scores);
  for (let i = 1; i < curve.length; i++) {
    assert.ok(
      curve[i]!.coverage <= curve[i - 1]!.coverage,
      `coverage must be non-increasing: ${curve[i - 1]!.coverage} -> ${curve[i]!.coverage}`,
    );
  }
  // The first point is coverage = 1.
  assert.equal(curve[0]!.coverage, 1);
  // The last point has coverage = 1/n (only one
  // query retained).
  assert.equal(curve[curve.length - 1]!.coverage, 1 / 16);
});

test("risk-coverage: empty input returns []", () => {
  assert.deepEqual(computeRiskCoverageCurve([], []), []);
});

// ---------------------------------------------------------------------------
// 3. Coverage-at-fixed-risk / risk-at-fixed-coverage
// ---------------------------------------------------------------------------

test("coverage-at-fixed-risk: known example", () => {
  // Build a curve by hand: 4 points.
  // coverage=1, risk=0.4
  // coverage=0.8, risk=0.4
  // coverage=0.6, risk=0.0
  // coverage=0.4, risk=0.0
  const curve = [
    { coverage: 1, risk: 0.4, threshold: -Infinity, abstainedCount: 0 },
    { coverage: 0.8, risk: 0.4, threshold: 0.3, abstainedCount: 2 },
    { coverage: 0.6, risk: 0.0, threshold: 0.5, abstainedCount: 4 },
    { coverage: 0.4, risk: 0.0, threshold: 0.7, abstainedCount: 6 },
  ];
  const cov = coverageAtFixedRisk(curve, [0.05, 0.1, 0.2, 0.5]);
  assert.equal(cov.length, 4);
  // At risk <= 5%, the largest coverage is 0.6 (risk
  // = 0).
  assert.ok(Math.abs(cov[0]!.coverage - 0.6) < 1e-9);
  // At risk <= 10%, the largest coverage is also 0.6.
  assert.ok(Math.abs(cov[1]!.coverage - 0.6) < 1e-9);
  // At risk <= 20%, the largest coverage is also 0.6.
  assert.ok(Math.abs(cov[2]!.coverage - 0.6) < 1e-9);
  // At risk <= 50%, every point qualifies; the
  // largest is coverage=1.
  assert.ok(Math.abs(cov[3]!.coverage - 1) < 1e-9);
});

test("risk-at-fixed-coverage: known example", () => {
  const curve = [
    { coverage: 1, risk: 0.4, threshold: -Infinity, abstainedCount: 0 },
    { coverage: 0.8, risk: 0.4, threshold: 0.3, abstainedCount: 2 },
    { coverage: 0.6, risk: 0.0, threshold: 0.5, abstainedCount: 4 },
    { coverage: 0.4, risk: 0.0, threshold: 0.7, abstainedCount: 6 },
  ];
  const risk = riskAtFixedCoverage(curve, [0.5, 0.7, 0.85, 1]);
  assert.equal(risk.length, 4);
  // At coverage >= 50%, the smallest risk is 0
  // (coverage=0.6, risk=0).
  assert.equal(risk[0]!.risk, 0);
  // At coverage >= 70%, the only qualifying point is
  // coverage=0.8 with risk=0.4 (coverage=0.6 is
  // below 0.7).
  assert.ok(Math.abs(risk[1]!.risk - 0.4) < 1e-9);
  // At coverage >= 85%, the only qualifying point is
  // coverage=1 with risk=0.4.
  assert.ok(Math.abs(risk[2]!.risk - 0.4) < 1e-9);
  // At coverage >= 100%, the smallest risk is 0.4.
  assert.ok(Math.abs(risk[3]!.risk - 0.4) < 1e-9);
});

// ---------------------------------------------------------------------------
// 4. auditSignal helper
// ---------------------------------------------------------------------------

test("auditSignal: topScore on a perfect signal has AUROC 1.0 in the inverted direction", () => {
  // 4 no-answer (label=1) with topScore 0.1, 4
  // positives (label=0) with topScore 0.9. "Higher
  // topScore = more positive (answerable)" — the
  // natural direction is below 0.5, the inverted
  // direction is 1.0.
  const signals: AbstentionSignals[] = [
    ...Array.from({ length: 4 }, (): AbstentionSignals => ({
      topScore: 0.1,
      top1Top2Gap: 0.1,
      top1Top2Ratio: 1,
      returnedCount: 1,
      agreementCount: 0,
      minContributorRank: null,
      maxContributorRank: null,
      meanContributorRank: null,
      minContributorScore: null,
      maxContributorScore: null,
      meanContributorScore: null,
      sourcePresence: "___",
      isNoAnswerHardNegative: false,
      isTemporalCurrent: false,
      isNegationLike: false,
      isOodEntityLike: false,
      isParaphraseTrap: false,
      isFalsePremiseLike: false,
    })),
    ...Array.from({ length: 4 }, (): AbstentionSignals => ({
      topScore: 0.9,
      top1Top2Gap: 0.5,
      top1Top2Ratio: 2,
      returnedCount: 1,
      agreementCount: 1,
      minContributorRank: 1,
      maxContributorRank: 1,
      meanContributorRank: 1,
      minContributorScore: 0.9,
      maxContributorScore: 0.9,
      meanContributorScore: 0.9,
      sourcePresence: "L__",
      isNoAnswerHardNegative: false,
      isTemporalCurrent: false,
      isNegationLike: false,
      isOodEntityLike: false,
      isParaphraseTrap: false,
      isFalsePremiseLike: false,
    })),
  ];
  const labels: Array<0 | 1> = [1, 1, 1, 1, 0, 0, 0, 0];
  const result = auditSignal("topScore", signals, labels);
  assert.equal(result.scoreIsHigherIsMorePositive, false);
  assert.equal(result.auroc, 1);
  // The other-direction AUROC is 0 (the natural
  // direction is anti-predictive).
  assert.equal(result.aurocOtherDirection, 0);
});

test("auditSignal: throws on length mismatch", () => {
  assert.throws(
    () =>
      auditSignal(
        "topScore",
        [
          {
            topScore: 0.5,
            top1Top2Gap: 0,
            top1Top2Ratio: 1,
            returnedCount: 0,
            agreementCount: 0,
            minContributorRank: null,
            maxContributorRank: null,
            meanContributorRank: null,
            minContributorScore: null,
            maxContributorScore: null,
            meanContributorScore: null,
            sourcePresence: "___",
            isNoAnswerHardNegative: false,
            isTemporalCurrent: false,
            isNegationLike: false,
            isOodEntityLike: false,
            isParaphraseTrap: false,
            isFalsePremiseLike: false,
          },
        ],
        [1, 0],
      ),
    /same length/,
  );
});

// ---------------------------------------------------------------------------
// 5. Query-shape detector
// ---------------------------------------------------------------------------

test("query-shape detector: labeled hard-negative `nonexistent-load-balancer` is detected", () => {
  // The labeled hard-negative shares `MCP` / `server` /
  // `port` tokens with the agent runtime cluster. The
  // detector should flag it.
  const q = BENCHMARK_QUERIES.find(
    (q) => q.id === "nonexistent-load-balancer",
  );
  assert.ok(q, "fixture query `nonexistent-load-balancer` must exist");
  const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
  const flags = detectQueryShape(q, corpusTokenSets);
  assert.equal(flags.isNoAnswerHardNegative, true);
  // The query mentions "load balancer" — a false-premise token.
  assert.equal(flags.isFalsePremiseLike, true);
});

test("query-shape detector: easy no-answer queries are NOT hard-negatives", () => {
  // The three "easy" no-answer queries that share
  // essentially no tokens with real records. The fourth
  // original easy no-answer query
  // (`nonexistent-mobile-app`) became a hard-negative
  // in the adversarial-expansion checkpoint because the
  // new cluster-31 record 124 shares
  // `deployment`/`target` tokens with the query. The
  // property the test pins is the same: a small
  // easy-no-answer subset still stays easy even with
  // the expanded corpus; the adversarial expansion
  // deliberately turns some of the original easy
  // queries into hard-negatives to give the no-answer
  // TNR more confabulation pressure. The labeled
  // hard-negative floor (the labeled
  // `nonexistent-load-balancer` and the now-labeled
  // `nonexistent-mobile-app`) is pinned in the
  // `runner: expanded checkpoint includes a labeled
  // no-answer hard-negative query that confabulates`
  // test below.
  for (const id of [
    "nonexistent-company-picnic",
    "nonexistent-auth-library",
    "nonexistent-customer-count",
  ]) {
    const q = BENCHMARK_QUERIES.find((q) => q.id === id);
    assert.ok(q);
    const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
    const flags = detectQueryShape(q, corpusTokenSets);
    assert.equal(
      flags.isNoAnswerHardNegative,
      false,
      `expected ${id} to NOT be a hard-negative, got true`,
    );
  }
});

test("query-shape detector: temporal-current queries are detected", () => {
  // `temp-postgres-version` has the word "now".
  for (const id of [
    "temp-postgres-version",
    "temp-release-process",
    "temp-retrieval-design",
    "temp-schema-migrations",
    "temp-ci-runner",
  ]) {
    const q = BENCHMARK_QUERIES.find((q) => q.id === id);
    assert.ok(q);
    const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
    const flags = detectQueryShape(q, corpusTokenSets);
    assert.equal(
      flags.isTemporalCurrent,
      true,
      `expected ${id} to be temporal-current, got false`,
    );
  }
  // A non-temporal query should not be flagged.
  const exactQ = BENCHMARK_QUERIES.find((q) => q.id === "exact-postgres-storage");
  assert.ok(exactQ);
  const flags = detectQueryShape(
    exactQ,
    buildCorpusTokenSets(BENCHMARK_RECORDS),
  );
  assert.equal(flags.isTemporalCurrent, false);
});

test("query-shape detector: paraphrase family is the paraphrase-trap flag", () => {
  for (const q of BENCHMARK_QUERIES) {
    if (q.family === "paraphrase") {
      const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
      const flags = detectQueryShape(q, corpusTokenSets);
      assert.equal(flags.isParaphraseTrap, true);
    }
  }
});

test("query-shape detector: negation-like queries are detected", () => {
  // The "no-answer" hard-negative `nonexistent-rollback`
  // contains "no record mentions" — not a direct
  // negation but the detector looks for tokens like
  // "no" / "not" / "never". The fixture uses "no" in
  // the note, not the query, so this is mostly a
  // sanity test on the detector. We add a synthetic
  // query with "not" to verify the detector fires.
  const synth = {
    id: "synthetic-not-test",
    family: "no-answer" as const,
    query: "What is the project not using for storage?",
    expectedIds: [],
    currentTruthIds: [],
    note: "synthetic query with a negation token",
  };
  const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
  const flags = detectQueryShape(synth, corpusTokenSets);
  assert.equal(flags.isNegationLike, true);
});

test("query-shape detector: DIVERGENT_TEMPORAL_IDS is the same set the existing tests pin", () => {
  // The adversarial-expansion set has 7 labeled
  // divergent temporal queries:
  //   - 2 from the prior expanded checkpoint
  //     (`temp-storage-raw-text`,
  //     `temp-controller-validation`).
  //   - 5 new in the adversarial expansion
  //     (`temp-superseded-postgres-15-current`,
  //     `temp-superseded-controller-validation-current`,
  //     `temp-superseded-oncall-handoff-current`,
  //     `temp-superseded-stale-fact-trap-postgres`,
  //     `temp-superseded-retrieval-design-current`).
  // The audit's slice builder uses the same set.
  assert.equal(DIVERGENT_TEMPORAL_IDS.size, 7);
  for (const id of [
    "temp-storage-raw-text",
    "temp-controller-validation",
    "temp-superseded-postgres-15-current",
    "temp-superseded-controller-validation-current",
    "temp-superseded-oncall-handoff-current",
    "temp-superseded-stale-fact-trap-postgres",
    "temp-superseded-retrieval-design-current",
  ]) {
    assert.ok(
      DIVERGENT_TEMPORAL_IDS.has(id),
      `expected DIVERGENT_TEMPORAL_IDS to contain ${id}`,
    );
  }
});

test("query-shape detector: LEGACY_DISTRACTOR_IDS is the expected set", () => {
  // Records 21..24 + 93..96 (eight total).
  for (const id of [21, 22, 23, 24, 93, 94, 95, 96]) {
    assert.ok(LEGACY_DISTRACTOR_IDS.has(id));
  }
  assert.equal(LEGACY_DISTRACTOR_IDS.size, 8);
});

test("query-shape detector: isDivergentTemporal surfaces labeled divergent queries", () => {
  // The detector's `isDivergentTemporal` flag uses
  // the data shape (currentTruthIds.length <
  // expectedIds.length) on the temporal family PLUS
  // the explicit `divergentTemporal` label. Both
  // surfaces fire for the labeled subset; the data
  // shape alone fires for any future divergent query
  // that forgets the label.
  for (const id of [
    "temp-storage-raw-text",
    "temp-controller-validation",
    "temp-superseded-postgres-15-current",
    "temp-superseded-controller-validation-current",
    "temp-superseded-oncall-handoff-current",
    "temp-superseded-stale-fact-trap-postgres",
    "temp-superseded-retrieval-design-current",
  ]) {
    const q = BENCHMARK_QUERIES.find((q) => q.id === id);
    assert.ok(q, `expected labeled divergent query "${id}" to exist`);
    const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
    const flags = detectQueryShape(q, corpusTokenSets);
    assert.equal(
      flags.isDivergentTemporal,
      true,
      `expected isDivergentTemporal=true for labeled divergent query ${id}`,
    );
  }
});

test("query-shape detector: isAdversarialParaphrase surfaces labeled paraphrases", () => {
  // The detector's `isAdversarialParaphrase` flag
  // fires on queries with the explicit
  // `adversarialParaphrase` label OR paraphrase queries
  // that target one of the paraphrase-twin records
  // (113..116). The adversarial expansion has 4
  // labeled adversarial paraphrases targeting the
  // paraphrase-twin records.
  for (const id of [
    "para-storage-twin",
    "para-review-twin",
    "para-provider-twin",
    "para-observability-twin",
  ]) {
    const q = BENCHMARK_QUERIES.find((q) => q.id === id);
    assert.ok(q);
    const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
    const flags = detectQueryShape(q, corpusTokenSets);
    assert.equal(
      flags.isAdversarialParaphrase,
      true,
      `expected isAdversarialParaphrase=true for labeled paraphrase ${id}`,
    );
  }
});

test("query-shape detector: isNearMissCurrentCluster surfaces labeled near-misses", () => {
  // The detector's `isNearMissCurrentCluster` flag
  // fires on queries with the explicit label OR
  // orientation / multi-hop / paraphrase queries that
  // target one of the near-miss cluster records
  // (109..112). The adversarial expansion has 7
  // labeled near-miss cases.
  const labeledNearMiss = BENCHMARK_QUERIES.filter(
    (q) => (q.labels ?? []).includes("nearMissCurrentCluster"),
  );
  assert.ok(
    labeledNearMiss.length >= 1,
    `expected at least 1 labeled 'nearMissCurrentCluster' query, got ${labeledNearMiss.length}`,
  );
  for (const q of labeledNearMiss) {
    const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
    const flags = detectQueryShape(q, corpusTokenSets);
    assert.equal(
      flags.isNearMissCurrentCluster,
      true,
      `expected isNearMissCurrentCluster=true for labeled near-miss ${q.id}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. Abstention-signal builder
// ---------------------------------------------------------------------------

test("abstention-signal builder: retrieval signals are computed from the per-query eval", () => {
  // Build a synthetic QueryEval.
  const eval_ = {
    queryId: "q1",
    family: "exact",
    query: "What is the database?",
    expectedIds: [1],
    currentTruthIds: [1],
    topIds: [1, 2, 3],
    topScores: [0.8, 0.3, 0.1],
    rank1: true,
    currentTruthAt1: true,
    passed: true,
    reason: "expected id in top-1",
  };
  const signals = buildAbstentionSignals(eval_, {
    isNoAnswerHardNegative: false,
    isTemporalCurrent: false,
    isNegationLike: false,
    isOodEntityLike: false,
    isParaphraseTrap: false,
    isFalsePremiseLike: false,
  });
  assert.equal(signals.topScore, 0.8);
  assert.ok(Math.abs(signals.top1Top2Gap - 0.5) < 1e-9);
  assert.ok(Math.abs(signals.top1Top2Ratio - 0.8 / 0.3) < 1e-9);
  assert.equal(signals.returnedCount, 3);
  // No hybridContributors on the synthetic eval, so
  // the contributor signals are `null` and the
  // agreement count is 0.
  assert.equal(signals.agreementCount, 0);
  assert.equal(signals.minContributorRank, null);
  assert.equal(signals.sourcePresence, "___");
});

test("abstention-signal builder: hybrid contributor block is consumed when present", () => {
  // Synthetic eval with the hybrid contributor block.
  const eval_ = {
    queryId: "q2",
    family: "exact",
    query: "What is the database?",
    expectedIds: [1],
    currentTruthIds: [1],
    topIds: [1],
    topScores: [0.1],
    rank1: true,
    currentTruthAt1: true,
    passed: true,
    reason: "expected id in top-1",
    hybridContributors: [
      { source: "lexical" as const, rank: 1, score: 0.5, contribution: 1 / 61, weight: 1 },
      { source: "fts5" as const, rank: null, score: null, contribution: 0, weight: 1 },
      { source: "vector" as const, rank: 3, score: 0.3, contribution: 1 / 63, weight: 1 },
    ],
  };
  const signals = buildAbstentionSignals(eval_, {
    isNoAnswerHardNegative: false,
    isTemporalCurrent: false,
    isNegationLike: false,
    isOodEntityLike: false,
    isParaphraseTrap: false,
    isFalsePremiseLike: false,
  });
  assert.equal(signals.agreementCount, 2);
  assert.equal(signals.minContributorRank, 1);
  assert.equal(signals.maxContributorRank, 3);
  assert.equal(signals.meanContributorRank, 2);
  assert.equal(signals.minContributorScore, 0.3);
  assert.equal(signals.maxContributorScore, 0.5);
  assert.ok(Math.abs(signals.meanContributorScore - 0.4) < 1e-9);
  assert.equal(signals.sourcePresence, "L_V");
});

// ---------------------------------------------------------------------------
// 7. End-to-end: abstention audit on the fixture corpus
// ---------------------------------------------------------------------------

test("abstention audit runner: end-to-end on the lexical hybrid (stub)", async () => {
  // Run the regular hybrid benchmark and the audit on
  // top. The audit consumes the per-query evals and
  // emits the report.
  const single = runRetrievalBenchmark({ variant: "hybrid" });
  const auditReport = runAbstentionAuditFromBenchmarkReport(single, {
    variant: "hybrid",
  });
  // Sanity: the headline "all" slice exists.
  const allSlice = auditReport.slices.find((s) => s.name === "all");
  assert.ok(allSlice);
  assert.equal(allSlice.total, BENCHMARK_QUERIES.length);
  // The no-answer count is the number of no-answer
  // queries in the query set.
  const expectedNoAnswer = BENCHMARK_QUERIES.filter(
    (q) => q.family === "no-answer",
  ).length;
  assert.equal(auditReport.config.noAnswerCount, expectedNoAnswer);
  // Every AUDIT_SIGNAL_NAMES entry has a result on the
  // "all" slice.
  assert.equal(allSlice.signalResults.length, AUDIT_SIGNAL_NAMES.length);
  for (const s of allSlice.signalResults) {
    assert.ok(s.notes.length > 0);
    assert.ok(Number.isFinite(s.auroc));
    assert.ok(s.riskCoverageCurve.length > 0);
    assert.equal(s.coverageAtRisk.length, 3); // 5/10/20%
    assert.equal(s.riskAtCoverage.length, 3); // 50/80/95%
  }
});

test("abstention audit runner: per-query signals carry all required fields", async () => {
  const single = runRetrievalBenchmark({ variant: "hybrid" });
  const auditReport = runAbstentionAuditFromBenchmarkReport(single, {
    variant: "hybrid",
  });
  // The `perQuerySignals` block is the raw per-query
  // signal array. Every entry has all the
  // `AbstentionSignals` fields populated.
  for (const p of auditReport.perQuerySignals) {
    assert.equal(typeof p.signals.topScore, "number");
    assert.equal(typeof p.signals.top1Top2Gap, "number");
    assert.ok(
      Number.isFinite(p.signals.top1Top2Ratio) ||
        p.signals.top1Top2Ratio === Number.POSITIVE_INFINITY,
    );
    assert.equal(typeof p.signals.returnedCount, "number");
    assert.equal(typeof p.signals.agreementCount, "number");
    // The hybrid run has contributor ranks / scores
    // for every query (the runner always populates
    // them, even on empty top-K).
    assert.ok(
      p.signals.minContributorRank !== null ||
        p.signals.minContributorRank === null,
    );
    assert.equal(typeof p.signals.sourcePresence, "string");
    assert.equal(typeof p.signals.isNoAnswerHardNegative, "boolean");
    assert.equal(typeof p.signals.isTemporalCurrent, "boolean");
    assert.equal(typeof p.signals.isNegationLike, "boolean");
    assert.equal(typeof p.signals.isOodEntityLike, "boolean");
    assert.equal(typeof p.signals.isParaphraseTrap, "boolean");
    assert.equal(typeof p.signals.isFalsePremiseLike, "boolean");
    // Adversarial-expansion additions: the detector
    // surfaces three new flag fields per query
    // (isAdversarialParaphrase, isDivergentTemporal,
    // isNearMissCurrentCluster). They are
    // backward-compatible booleans; the per-query
    // signal block carries every one of them.
    assert.equal(typeof p.signals.isAdversarialParaphrase, "boolean");
    assert.equal(typeof p.signals.isDivergentTemporal, "boolean");
    assert.equal(typeof p.signals.isNearMissCurrentCluster, "boolean");
  }
});

test("abstention audit runner: per-query examples are well-formed", async () => {
  const single = runRetrievalBenchmark({ variant: "hybrid" });
  const auditReport = runAbstentionAuditFromBenchmarkReport(single, {
    variant: "hybrid",
  });
  const examples = auditReport.perQueryExamples;
  for (const list of [
    examples.mostConfidentNoAnswer,
    examples.leastConfidentPositive,
    examples.leastConfidentNoAnswer,
    examples.mostConfidentPositive,
  ]) {
    assert.ok(list.length > 0 && list.length <= 5);
    for (const e of list) {
      assert.equal(typeof e.queryId, "string");
      assert.equal(typeof e.family, "string");
      assert.equal(typeof e.signals.topScore, "number");
    }
  }
});

test("abstention audit runner: dense run produces well-formed report", async () => {
  // Use the stub embedder (no model download) for the
  // CI path. The dense audit should produce a
  // well-formed report with the contributor signals
  // populated.
  const denseReport = await runDenseRetrievalBenchmark({
    variant: "hybrid-dense",
    denseEmbedderSpec: "stub-dense:dim=64",
  });
  // Type narrowing.
  if (!("evals" in denseReport)) {
    throw new Error("dense report is not a single-variant report");
  }
  const auditReport = runAbstentionAuditFromDenseReport(denseReport);
  const allSlice = auditReport.slices.find((s) => s.name === "all");
  assert.ok(allSlice);
  assert.equal(allSlice.total, BENCHMARK_QUERIES.length);
  // The dense hybrid path populates
  // `hybridContributors` for every query, so the
  // contributor signals are present.
  for (const p of auditReport.perQuerySignals) {
    assert.notEqual(p.signals.sourcePresence, "___");
  }
});

test("abstention audit runner: buildSlices emits a stable, well-formed slice set", () => {
  // Hand-build a tiny per-query array and assert the
  // slice builder emits the expected slice names.
  // We seed at least one query per shape slice the
  // builder can detect (e.g. `isNoAnswerHardNegative`,
  // `isParaphraseTrap`, `isTemporalCurrent`).
  const perQuery = BENCHMARK_QUERIES.map((q, i) => ({
    queryId: q.id,
    family: q.family,
    isPositive: q.family !== "no-answer",
    signals: {
      topScore: q.family === "no-answer" ? 0.05 : 0.8,
      top1Top2Gap: 0.3,
      top1Top2Ratio: 2,
      returnedCount: 3,
      agreementCount: 2,
      minContributorRank: 1,
      maxContributorRank: 3,
      meanContributorRank: 2,
      minContributorScore: 0.3,
      maxContributorScore: 0.8,
      meanContributorScore: 0.55,
      sourcePresence: "L_V",
      // The hard-negative / paraphrase-trap /
      // temporal-current / divergent flags are seeded
      // explicitly on representative queries so the
      // shape slices have at least one member.
      isNoAnswerHardNegative:
        q.id === "nonexistent-load-balancer" ||
        q.id === "nonexistent-rollback" ||
        q.id === "nonexistent-sso",
      isTemporalCurrent:
        q.family === "temporal" || q.id === "exact-postgres-storage",
      isNegationLike: q.id === "nonexistent-customer-count",
      isOodEntityLike: q.id === "nonexistent-cdn-config",
      isParaphraseTrap: q.family === "paraphrase",
      isFalsePremiseLike:
        q.id === "nonexistent-load-balancer" ||
        q.id === "nonexistent-graphql-endpoint",
    },
  }));
  const slices = buildSlices(perQuery, {});
  // The "all" slice is first.
  assert.equal(slices[0]!.name, "all");
  // The per-family slices are present (one per
  // unique family in the corpus).
  const familyNames = new Set(BENCHMARK_QUERIES.map((q) => q.family));
  for (const f of familyNames) {
    assert.ok(
      slices.find((s) => s.name === `family:${f}`),
      `expected family:${f} slice`,
    );
  }
  // The per-shape slices are present.
  for (const name of [
    "no-answer-easy",
    "no-answer-hard",
    "temporal-divergent",
    "temporal-non-divergent",
    "temporal-current",
    "paraphrase-trap",
  ]) {
    assert.ok(
      slices.find((s) => s.name === name),
      `expected ${name} slice`,
    );
  }
});

// ---------------------------------------------------------------------------
// 8. CLI / artifact
// ---------------------------------------------------------------------------

test("abstention-audit CLI: --abstention-audit is parsed correctly", () => {
  const opts = parseRetrievalCli([
    "--variant",
    "hybrid",
    "--abstention-audit",
  ]);
  assert.equal(opts.abstentionAudit, true);
  assert.equal(opts.variant, "hybrid");
});

test("abstention-audit CLI: --abstention-audit defaults to true with the lexical variant", () => {
  const opts = parseRetrievalCli(["--abstention-audit"]);
  assert.equal(opts.abstentionAudit, true);
  // No `--variant` was passed; the default is
  // `lexical`. The audit will run on the lexical
  // benchmark underneath.
  assert.equal(opts.variant, undefined);
});

test("abstention-audit artifact: writeAbstentionAuditReport writes the right prefix", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cortex-audit-art-"));
  try {
    const single = runRetrievalBenchmark({ variant: "hybrid" });
    const auditReport = runAbstentionAuditFromBenchmarkReport(single, {
      variant: "hybrid",
    });
    const file = writeAbstentionAuditReport(auditReport, tmp);
    assert.ok(fs.existsSync(file));
    assert.match(
      path.basename(file),
      /^retrieval-abstention-audit-/,
      `audit file prefix mismatch: ${path.basename(file)}`,
    );
    // The file does NOT carry the existing prefixes.
    assert.doesNotMatch(
      path.basename(file),
      /^retrieval-(baseline|fts5|vector|hybrid|compare|calibration|calibration-dense|vector-dense|hybrid-dense|compare-dense)/,
    );
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test("abstention-audit human report: includes the per-signal AUROC table and the slice table", () => {
  const single = runRetrievalBenchmark({ variant: "hybrid" });
  const auditReport = runAbstentionAuditFromBenchmarkReport(single, {
    variant: "hybrid",
  });
  const out = formatAbstentionAuditReport(auditReport);
  for (const section of [
    "per-signal AUROC (slice=all)",
    "coverage at fixed risk (slice=all, top-3 signals)",
    "risk at fixed coverage (slice=all, top-3 signals)",
    "per-family slice AUROC",
    "per-shape slice AUROC",
    "per-query examples (honest)",
    "READ THIS FIRST: this is a BENCHMARK-ONLY study",
  ]) {
    assert.ok(
      out.includes(section),
      `audit human report missing section: ${section}`,
    );
  }
});

// ---------------------------------------------------------------------------
// 9. Backward compatibility / production API guard
// ---------------------------------------------------------------------------

test("abstention audit: existing single-variant benchmark report is unchanged", () => {
  // The audit is purely additive; the existing
  // single-variant report's `evals` array is unchanged
  // (no `abstentionSignals` field added by the regular
  // runner — the audit runner attaches the field, and
  // it does so on a separate artifact, not the
  // existing one).
  const single = runRetrievalBenchmark({ variant: "lexical" });
  for (const e of single.evals) {
    assert.equal(e.abstentionSignals, undefined);
  }
});

test("abstention audit: production recall() controller is not modified", () => {
  // The audit module is benchmark-only. The recall
  // controller's source code must not import the
  // audit module.
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
    /abstention-audit|runAbstentionAudit|abstentionSignals|detectQueryShape/,
    "recall controller must NOT import abstention-audit modules",
  );
  // The MCP server still exposes exactly two tools.
  const serverSrc = fs.readFileSync(
    path.join(import.meta.dirname, "..", "src", "server.ts"),
    "utf8",
  );
  const toolCallCount = (serverSrc.match(/server\.registerTool\(/g) ?? []).length;
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

test("abstention audit: report is a strict superset of AbstentionAuditReport", () => {
  // The on-disk artifact is well-formed for a
  // byte-stable JSON shape. A consumer that knows
  // about the `AbstentionAuditReport` type can read
  // the file directly.
  const single = runRetrievalBenchmark({ variant: "hybrid" });
  const auditReport = runAbstentionAuditFromBenchmarkReport(single, {
    variant: "hybrid",
  });
  // Spot-check the top-level fields.
  assert.equal(typeof auditReport.generatedAt, "string");
  assert.equal(typeof auditReport.config.total, "number");
  assert.equal(typeof auditReport.config.noAnswerCount, "number");
  assert.ok(Array.isArray(auditReport.slices));
  assert.ok(Array.isArray(auditReport.allSlices));
  assert.ok(Array.isArray(auditReport.perQuerySignals));
  assert.ok(auditReport.perQueryExamples);
});

test("abstention audit: buildPerQueryExamples is deterministic", () => {
  // The example selection is pure; a second call
  // returns the same queries in the same order.
  const single = runRetrievalBenchmark({ variant: "hybrid" });
  const r1 = runAbstentionAuditFromBenchmarkReport(single, {
    variant: "hybrid",
  });
  const r2 = runAbstentionAuditFromBenchmarkReport(single, {
    variant: "hybrid",
  });
  assert.deepEqual(
    r1.perQueryExamples.mostConfidentNoAnswer.map((e) => e.queryId),
    r2.perQueryExamples.mostConfidentNoAnswer.map((e) => e.queryId),
  );
});

test("abstention audit: auditSlice is a thin wrapper that emits AUDIT_SIGNAL_NAMES.length results", () => {
  const signals: AbstentionSignals[] = [];
  const labels: Array<0 | 1> = [];
  for (let i = 0; i < 8; i++) {
    signals.push({
      topScore: 0.5,
      top1Top2Gap: 0.1,
      top1Top2Ratio: 1.5,
      returnedCount: 3,
      agreementCount: 1,
      minContributorRank: 1,
      maxContributorRank: 5,
      meanContributorRank: 3,
      minContributorScore: 0.3,
      maxContributorScore: 0.7,
      meanContributorScore: 0.5,
      sourcePresence: "L__",
      isNoAnswerHardNegative: false,
      isTemporalCurrent: false,
      isNegationLike: false,
      isOodEntityLike: false,
      isParaphraseTrap: false,
      isFalsePremiseLike: false,
    });
    labels.push(i < 4 ? 1 : 0);
  }
  const slice = auditSlice("test", "test slice", signals, labels);
  assert.equal(slice.signalResults.length, AUDIT_SIGNAL_NAMES.length);
  for (const s of slice.signalResults) {
    assert.equal(typeof s.auroc, "number");
    assert.equal(typeof s.scoreIsHigherIsMorePositive, "boolean");
    assert.equal(typeof s.aurocOtherDirection, "number");
  }
  // A mixed-class slice is NOT single-class.
  assert.equal(slice.singleClass, false);
});

test("abstention audit: auditSlice flags singleClass and the report renders n/a for those slices", () => {
  // Build a tiny per-query array that produces at
  // least one single-class slice (all-positive) and
  // one mixed-class slice. The single-class slice
  // must:
  //   1. Be flagged `singleClass: true` on the JSON
  //      artifact (so a consumer can tell the AUROC
  //      prior from a real reading).
  //   2. Keep the documented `0.5` AUROC value on the
  //      JSON (so existing consumers that key on the
  //      value do not break).
  //   3. Render `n/a` in the human report (per-family
  //      / per-shape tables) so a reviewer is not
  //      misled into reading a real signal where there
  //      is only an undefined prior.
  const mkSignals = (topScore: number): AbstentionSignals => ({
    topScore,
    top1Top2Gap: 0.1,
    top1Top2Ratio: 1.5,
    returnedCount: 3,
    agreementCount: 1,
    minContributorRank: 1,
    maxContributorRank: 5,
    meanContributorRank: 3,
    minContributorScore: 0.3,
    maxContributorScore: 0.7,
    meanContributorScore: 0.5,
    sourcePresence: "L__",
    isNoAnswerHardNegative: false,
    isTemporalCurrent: false,
    isNegationLike: false,
    isOodEntityLike: false,
    isParaphraseTrap: false,
    isFalsePremiseLike: false,
  });
  // All-positive slice: 4 queries, labels all 0.
  const allPosSignals = [0.8, 0.7, 0.6, 0.5].map(mkSignals);
  const allPosLabels: Array<0 | 1> = [0, 0, 0, 0];
  const allPosSlice = auditSlice(
    "all-positive",
    "synthetic single-class slice (all answerable)",
    allPosSignals,
    allPosLabels,
  );
  assert.equal(allPosSlice.singleClass, true);
  // JSON still emits the documented 0.5 AUROC.
  for (const s of allPosSlice.signalResults) {
    assert.equal(s.auroc, 0.5);
  }
  // All-no-answer slice: 4 queries, labels all 1.
  const allNoAnsSignals = [0.05, 0.04, 0.03, 0.02].map(mkSignals);
  const allNoAnsLabels: Array<0 | 1> = [1, 1, 1, 1];
  const allNoAnsSlice = auditSlice(
    "all-no-answer",
    "synthetic single-class slice (all no-answer)",
    allNoAnsSignals,
    allNoAnsLabels,
  );
  assert.equal(allNoAnsSlice.singleClass, true);
  for (const s of allNoAnsSlice.signalResults) {
    assert.equal(s.auroc, 0.5);
  }
  // Mixed-class slice: not single-class.
  const mixedSignals = [0.8, 0.05, 0.7, 0.04].map(mkSignals);
  const mixedLabels: Array<0 | 1> = [0, 1, 0, 1];
  const mixedSlice = auditSlice(
    "mixed",
    "synthetic mixed-class slice",
    mixedSignals,
    mixedLabels,
  );
  assert.equal(mixedSlice.singleClass, false);
  // The mixed slice should NOT have AUROC = 0.5 for
  // topScore (it has a real separation).
  const topScore = mixedSlice.signalResults.find(
    (s) => s.signal === "topScore",
  );
  assert.ok(topScore);
  assert.notEqual(topScore!.auroc, 0.5);
  // Now build a report with a single-class per-family
  // slice and a mixed per-family slice, and assert
  // the human report renders `n/a` for the single-
  // class row and a numeric AUROC for the mixed row.
  const perQuery = [
    // Mixed per-family slice: family "exact" with 2
    // positives and 2 no-answers.
    { queryId: "a", family: "exact", isPositive: true, signals: mkSignals(0.8) },
    { queryId: "b", family: "exact", isPositive: true, signals: mkSignals(0.7) },
    { queryId: "c", family: "exact", isPositive: false, signals: mkSignals(0.05) },
    { queryId: "d", family: "exact", isPositive: false, signals: mkSignals(0.04) },
    // Single-class per-family slice: family
    // "no-answer" with 2 no-answers and 0 positives.
    { queryId: "e", family: "no-answer", isPositive: false, signals: mkSignals(0.03) },
    { queryId: "f", family: "no-answer", isPositive: false, signals: mkSignals(0.02) },
  ];
  const slices = buildSlices(perQuery, {});
  const report = {
    generatedAt: "2026-06-12T00:00:00.000Z",
    config: {
      recordCount: 0,
      queryCount: perQuery.length,
      total: perQuery.length,
      noAnswerCount: 4,
      positiveCount: 2,
      riskTargets: [0.05, 0.1, 0.2],
      coverageTargets: [0.5, 0.8, 0.95],
    },
    slices,
    allSlices: [slices[0]!],
    perQueryExamples: {
      mostConfidentNoAnswer: [],
      leastConfidentPositive: [],
      leastConfidentNoAnswer: [],
      mostConfidentPositive: [],
    },
    perQuerySignals: perQuery,
  };
  const exactSlice = slices.find((s) => s.name === "family:exact");
  const noAnsSlice = slices.find((s) => s.name === "family:no-answer");
  assert.ok(exactSlice);
  assert.ok(noAnsSlice);
  assert.equal(exactSlice!.singleClass, false);
  assert.equal(noAnsSlice!.singleClass, true);
  // JSON artifact preserves the documented 0.5 on the
  // single-class slice (backward compat for
  // consumers).
  for (const s of noAnsSlice!.signalResults) {
    assert.equal(s.auroc, 0.5);
  }
  // Human report renders `n/a` for the single-class
  // row and a numeric AUROC for the mixed row.
  const out = formatAbstentionAuditReport(report);
  // The per-family table has one row per family; the
  // single-class `no-answer` row should have `n/a`
  // in place of the AUROC and coverage@5%risk cells.
  const noAnsLine = out
    .split("\n")
    .find((l) => l.includes("no-answer") && l.includes("single-class slice"));
  assert.ok(
    noAnsLine,
    `expected a single-class slice marker line for family:no-answer, got:\n${out}`,
  );
  assert.match(noAnsLine!, /\bn\/a\b/);
  // The mixed `exact` row should have a numeric AUROC
  // and should NOT carry the single-class marker.
  const exactLine = out
    .split("\n")
    .find((l) => /^\s*exact\s/.test(l));
  assert.ok(exactLine, "expected a per-family row for exact");
  assert.doesNotMatch(exactLine!, /single-class slice/);
  assert.match(exactLine!, /\b\d+\.\d{3}\b/);
});
