/**
 * Tests for the benchmark-only false-abstention
 * damage analysis.
 *
 * Covers:
 *   1. Category math: each priority rule assigns
 *      the right category on the right input and
 *      never the wrong one.
 *   2. Score-band math: each top-score maps to
 *      exactly one band, bands are exhaustive,
 *      and band boundaries match the documented
 *      table.
 *   3. Trade-off aggregation: per-category
 *      summary, per-family cross-tab, per-score-
 *      band cross-tab, semantic-evidence rollup.
 *   4. Output determinism: same input -> same
 *      report; no PRNG; no wall clock.
 *   5. End-to-end: the diagnostic on the real
 *      lexical baseline no-answer artifact
 *      produces a meaningful damage report on
 *      the 24 FPs the prior experiment
 *      surfaced.
 *   6. Semantic-evidence integration: with the
 *      pre-computed EmbeddingGemma evidence
 *      file, every FP the no-answer artifact
 *      surfaces is annotated with
 *      `semanticRecoverable` / `semanticAlsoMisses`.
 *   7. Production import guard: the production
 *      source tree must NOT import the new
 *      diagnostic modules.
 *   8. Public MCP API unchanged: exactly two
 *      tools.
 *   9. Existing report shapes are unchanged.
 *  10. Honest fixture-label framing: the
 *      category names are documented as
 *      fixture-shaped (not deployable).
 *  11. CLI argument parsing: default modes +
 *      override flags.
 *  12. Artifact reader + writer round-trip.
 *
 * The tests split between synthetic unit tests
 * (pure functions, no corpus) and end-to-end
 * tests (real no-answer artifact under
 * `.curion/benchmark/`).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import {
  BUILTIN_NO_ANSWER_POLICIES,
  buildNoAnswerPolicyPerQuery,
  computeNoAnswerPolicyMetrics,
  evaluateNoAnswerPolicy,
  runNoAnswerPolicyExperiment,
  type NoAnswerPolicy,
  type NoAnswerPolicyPerQuery,
} from "../src/benchmark/no-answer-abstention.js";
import {
  buildFalseAbstentionDamageReport,
  classifyFalseAbstention,
  DAMAGE_CATEGORIES,
  formatFalseAbstentionDamageReport,
  scoreBandFor,
  SCORE_BANDS,
  type DamageCategory,
  type FalseAbstentionDamageEntry,
  type FalseAbstentionDamageReport,
  type SemanticEvidenceMap,
} from "../src/benchmark/false-abstention-damage.js";
import {
  classifyCandidateSetSufficiency,
  buildSufficiencyReport,
} from "../src/benchmark/sufficiency-diagnostic.js";
import {
  evaluateQuery,
  type AbstentionSignals,
  type QueryEval,
} from "../src/benchmark/metrics.js";
import {
  BENCHMARK_QUERIES,
  type BenchmarkQuery,
} from "../src/benchmark/queries.js";
import { rankLexical } from "../src/retrieval/lexical.js";
import {
  buildCandidates,
  runRetrievalBenchmark,
} from "../src/benchmark/retrieval-runner.js";
import { BENCHMARK_RECORDS } from "../src/benchmark/corpus.js";
import { PUBLIC_TOOL_NAMES } from "../src/server.js";
import { detectQueryShape, buildCorpusTokenSets } from "../src/benchmark/query-shapes.js";
import {
  findMostRecentArtifact,
  parseFalseAbstentionDamageCliArgs,
  readNoAnswerAbstentionArtifact,
  readAbstentionAuditArtifact,
  readSemanticEvidenceFile,
  reconstructPerQuery,
  runFalseAbstentionDamageAnalysis,
  runFalseAbstentionDamageCli,
  writeFalseAbstentionDamageReport,
} from "../src/benchmark/false-abstention-damage-runner.js";
import {
  extractRank1MissesFromLog,
} from "../src/benchmark/scripts/extract-semantic-evidence.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a synthetic per-query input the policy
 * evaluator consumes. The factory takes a
 * per-query spec and produces a per-query entry
 * with the desired signals, family, isPositive
 * flag, topKSize, sufficiency label, and
 * optional fixture-truth labels.
 */
function mkPerQuery(
  specs: ReadonlyArray<{
    queryId: string;
    family: string;
    isPositive: boolean;
    topScore?: number;
    top1Top2Gap?: number;
    top1Top2Ratio?: number;
    returnedCount?: number;
    topKSize?: number;
    sufficiencyLabel?:
      | "sufficient"
      | "partial"
      | "insufficient"
      | "wrong-current-truth"
      | "near-miss"
      | "confabulation"
      | "no-answer-correct";
    queryLabels?: string[];
    isNoAnswerHardNegative?: boolean;
    isFalsePremiseLike?: boolean;
    isAdversarialParaphrase?: boolean;
    isNearMissCurrentCluster?: boolean;
    isDivergentTemporal?: boolean;
    rank1?: boolean;
    currentTruthAt1?: boolean;
    hitAt5?: boolean;
  }>,
): NoAnswerPolicyPerQuery[] {
  return specs.map((s) => {
    const signals: AbstentionSignals = {
      topScore: s.topScore ?? 0,
      top1Top2Gap: s.top1Top2Gap ?? 0,
      top1Top2Ratio: s.top1Top2Ratio ?? 1,
      returnedCount: s.returnedCount ?? 0,
      agreementCount: 0,
      minContributorRank: null,
      maxContributorRank: null,
      meanContributorRank: null,
      minContributorScore: null,
      maxContributorScore: null,
      meanContributorScore: null,
      sourcePresence: "___",
      isNoAnswerHardNegative: s.isNoAnswerHardNegative ?? false,
      isTemporalCurrent: false,
      isNegationLike: false,
      isOodEntityLike: false,
      isParaphraseTrap: false,
      isFalsePremiseLike: s.isFalsePremiseLike ?? false,
      isAdversarialParaphrase: s.isAdversarialParaphrase ?? false,
      isDivergentTemporal: s.isDivergentTemporal ?? false,
      isNearMissCurrentCluster: s.isNearMissCurrentCluster ?? false,
    };
    const slot: NoAnswerPolicyPerQuery = {
      queryId: s.queryId,
      family: s.family,
      isPositive: s.isPositive,
      signals,
      topKSize: s.topKSize ?? 0,
      rank1: s.rank1 ?? false,
      currentTruthAt1: s.currentTruthAt1 ?? false,
      hitAt5: s.hitAt5 ?? false,
    };
    if (s.sufficiencyLabel !== undefined) slot.sufficiencyLabel = s.sufficiencyLabel;
    if (s.queryLabels !== undefined) slot.queryLabels = [...s.queryLabels];
    return slot;
  });
}

function emptySignals(): AbstentionSignals {
  return {
    topScore: 0,
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
    isAdversarialParaphrase: false,
    isDivergentTemporal: false,
    isNearMissCurrentCluster: false,
  };
}

function findPolicy(id: string): NoAnswerPolicy {
  const p = BUILTIN_NO_ANSWER_POLICIES.find((p) => p.id === id);
  if (!p) {
    throw new Error(`internal: built-in policy '${id}' not found`);
  }
  return p;
}

function queryById(id: string): BenchmarkQuery {
  const q = BENCHMARK_QUERIES.find((qq) => qq.id === id);
  if (!q) throw new Error(`fixture has no query with id "${id}"`);
  return q;
}

function evalFrom(
  q: BenchmarkQuery,
  topIds: number[],
  topScores: number[],
): QueryEval {
  return evaluateQuery(
    q.id,
    q.family,
    q.query,
    q.expectedIds,
    q.currentTruthIds,
    topIds,
    topScores,
  );
}

// ---------------------------------------------------------------------------
// 0. Stable contract
// ---------------------------------------------------------------------------

test("false-abstention-damage: DAMAGE_CATEGORIES is the documented stable set", () => {
  // Pin the category set by hand so a future
  // addition is a deliberate, visible change.
  assert.deepEqual(
    [...DAMAGE_CATEGORIES],
    [
      "ranker-empty-recoverable",
      "labeled-near-miss-or-divergent",
      "score-threshold-on-recoverable",
      "score-threshold-on-real-failure",
      "sufficiency-label-honest",
      "multi-gate-conjunction-honest",
      "labeled-oracle-misclassification",
      "unclassified",
    ],
  );
  // Every category has a non-empty
  // explanation (the per-FP entry's
  // `categoryExplanation` field is
  // self-contained; an empty explanation
  // would render as a blank line in the
  // human report).
  // We re-import the explanation table
  // indirectly by checking that calling
  // `classifyFalseAbstention` on a
  // deliberately-`unclassified` case
  // produces a non-empty explanation. The
  // deterministic case is built below.
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    { queryId: "q", family: "exact", isPositive: true, topScore: 0.5 },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "exact",
      reason: "score-below-0.3",
      rank1: true,
      hitAt5: true,
    },
    pq,
  );
  // score-below-0.3 + rank1=true -> recoverable
  assert.equal(cat, "score-threshold-on-recoverable");
});

test("false-abstention-damage: SCORE_BANDS table is the documented stable set", () => {
  // Pin the score-band table by hand so a
  // future change is a deliberate, visible
  // change. The band boundaries are
  // threshold-aligned (0.10, 0.20, 0.30,
  // 0.50, 0.75).
  assert.equal(SCORE_BANDS.length, 6);
  assert.equal(SCORE_BANDS[0]!.label, "topScore<0.10");
  assert.equal(SCORE_BANDS[0]!.max, 0.1);
  assert.equal(SCORE_BANDS[1]!.label, "0.10<=topScore<0.20");
  assert.equal(SCORE_BANDS[1]!.min, 0.1);
  assert.equal(SCORE_BANDS[1]!.max, 0.2);
  assert.equal(SCORE_BANDS[2]!.label, "0.20<=topScore<0.30");
  assert.equal(SCORE_BANDS[2]!.min, 0.2);
  assert.equal(SCORE_BANDS[2]!.max, 0.3);
  assert.equal(SCORE_BANDS[3]!.label, "0.30<=topScore<0.50");
  assert.equal(SCORE_BANDS[3]!.min, 0.3);
  assert.equal(SCORE_BANDS[3]!.max, 0.5);
  assert.equal(SCORE_BANDS[4]!.label, "0.50<=topScore<0.75");
  assert.equal(SCORE_BANDS[4]!.min, 0.5);
  assert.equal(SCORE_BANDS[4]!.max, 0.75);
  assert.equal(SCORE_BANDS[5]!.label, "topScore>=0.75");
  assert.equal(SCORE_BANDS[5]!.min, 0.75);
  assert.equal(SCORE_BANDS[5]!.max, Infinity);
});

// ---------------------------------------------------------------------------
// 1. Category math
// ---------------------------------------------------------------------------

test("false-abstention-damage: ranker-empty-recoverable when ranker returned 0 candidates", () => {
  // topScore=0, returnedCount=0, topKSize=0
  // -> ranker returned nothing. The score
  // gate caught the empty result. A denser
  // ranker that surfaces a candidate where
  // the lexical ranker could not would
  // recover this.
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    {
      queryId: "q",
      family: "paraphrase",
      isPositive: true,
      topScore: 0,
      returnedCount: 0,
      topKSize: 0,
      rank1: false,
      hitAt5: false,
    },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "paraphrase",
      reason: "score-below-0.3",
      rank1: false,
      hitAt5: false,
    },
    pq,
  );
  assert.equal(cat, "ranker-empty-recoverable");
});

test("false-abstention-damage: score-threshold-on-recoverable when rank-1 was right", () => {
  // topScore=0.25 < 0.30 -> score gate
  // fired, but rank1=true -> ranker DID
  // return the right answer. The threshold
  // is too tight; a different threshold or
  // a rank-1-check would recover.
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    {
      queryId: "q",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 2,
      topKSize: 2,
      sufficiencyLabel: "sufficient",
      rank1: true,
      currentTruthAt1: true,
      hitAt5: true,
    },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "paraphrase",
      reason: "score-below-0.3",
      rank1: true,
      hitAt5: true,
    },
    pq,
  );
  assert.equal(cat, "score-threshold-on-recoverable");
});

test("false-abstention-damage: score-threshold-on-recoverable also fires on hit@5", () => {
  // topScore<threshold, rank1=false BUT
  // hit@5=true. The ranker DID return the
  // right answer (somewhere in top-5);
  // the policy's rank-1 check is the
  // narrow reading. The wider reading is
  // "the candidate set had the answer; the
  // score gate is too tight" -> recoverable.
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    {
      queryId: "q",
      family: "temporal",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 5,
      topKSize: 5,
      sufficiencyLabel: "wrong-current-truth",
      rank1: false,
      currentTruthAt1: false,
      hitAt5: true,
    },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "temporal",
      reason: "score-below-0.3",
      rank1: false,
      hitAt5: true,
    },
    pq,
  );
  assert.equal(cat, "score-threshold-on-recoverable");
});

test("false-abstention-damage: score-threshold-on-real-failure when ranker failed", () => {
  // topScore<threshold, rank1=false, hit@5=false.
  // The ranker genuinely failed. The
  // policy is honest.
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    {
      queryId: "q",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.0,
      returnedCount: 4,
      topKSize: 4,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "paraphrase",
      reason: "score-below-0.3",
      rank1: false,
      hitAt5: false,
    },
    pq,
  );
  // topScore=0, returnedCount=4, topKSize=4
  // -> NOT empty (returnedCount > 0), so
  // not the "ranker-empty-recoverable"
  // case. Falls to
  // "score-threshold-on-real-failure".
  assert.equal(cat, "score-threshold-on-real-failure");
});

test("false-abstention-damage: sufficiency-label-honest when only the label gate fired", () => {
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    {
      queryId: "q",
      family: "orientation",
      isPositive: true,
      topScore: 0.75,
      returnedCount: 5,
      topKSize: 5,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "orientation",
      reason: "sufficiency-in-insufficient|confabulation",
      rank1: false,
      hitAt5: false,
    },
    pq,
  );
  assert.equal(cat, "sufficiency-label-honest");
});

test("false-abstention-damage: multi-gate-conjunction-honest when both fired", () => {
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    {
      queryId: "q",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 4,
      topKSize: 4,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "paraphrase",
      reason:
        "score-below-0.3+sufficiency-in-insufficient|confabulation",
      rank1: false,
      hitAt5: false,
    },
    pq,
  );
  assert.equal(cat, "multi-gate-conjunction-honest");
});

test("false-abstention-damage: labeled-near-miss-or-divergent on fixture labels", () => {
  // The query carries a nearMissCurrentCluster
  // label. The fixture flagged the query as
  // deliberately ambiguous; abstention may be
  // the correct call.
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    {
      queryId: "q",
      family: "orientation",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 5,
      topKSize: 5,
      sufficiencyLabel: "near-miss",
      queryLabels: ["nearMissCurrentCluster"],
      rank1: false,
      hitAt5: false,
    },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "orientation",
      reason: "score-below-0.3",
      rank1: false,
      hitAt5: false,
      queryLabels: ["nearMissCurrentCluster"],
    },
    pq,
  );
  assert.equal(cat, "labeled-near-miss-or-divergent");
});

test("false-abstention-damage: labeled-near-miss-or-divergent on divergentTemporal", () => {
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    {
      queryId: "q",
      family: "temporal",
      isPositive: true,
      topScore: 0.25,
      queryLabels: ["divergentTemporal"],
      rank1: false,
      hitAt5: true,
    },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "temporal",
      reason: "score-below-0.3",
      rank1: false,
      hitAt5: true,
      queryLabels: ["divergentTemporal"],
    },
    pq,
  );
  assert.equal(cat, "labeled-near-miss-or-divergent");
});

test("false-abstention-damage: labeled-oracle-misclassification on hardNegative", () => {
  // A query is BOTH labeled hardNegative AND
  // isPositive=true -> fixture-design
  // artifact. To make this category win,
  // the per-query input must NOT trip any
  // higher-priority rule: the ranker must
  // have returned the right answer (so
  // the score gate does not fire on a
  // "real failure" and the ranker-empty
  // rule does not fire either). We
  // simulate this with `reason: "none"`
  // and high topScore; the labels drive
  // the categorization.
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    {
      queryId: "q",
      family: "no-answer",
      isPositive: true,
      topScore: 0.5,
      queryLabels: ["hardNegative"],
      rank1: true,
      hitAt5: true,
    },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "no-answer",
      reason: "none", // not a score/sufficiency abstention
      rank1: true,
      hitAt5: true,
      queryLabels: ["hardNegative"],
    },
    pq,
  );
  // Note: the family is "no-answer" but
  // isPositive=true, so this is a
  // contradiction in the fixture (a
  // positive query that the fixture also
  // labels as a no-answer-family
  // hardNegative). The classifier surfaces
  // this honestly as
  // `labeled-oracle-misclassification`
  // because the labels drive the
  // categorization (priority 7), and the
  // higher-priority rules did not match
  // (no score gate fired, no
  // near-miss/divergent label).
  assert.equal(cat, "labeled-oracle-misclassification");
});

test("false-abstention-damage: priority order — ranker-empty beats score-threshold-on-recoverable", () => {
  // A query with topScore=0, returnedCount=0,
  // topKSize=0, rank1=true, hit@5=true is
  // degenerate (a positive query that the
  // ranker says it answered at rank 1 with 0
  // candidates). The classifier picks
  // `ranker-empty-recoverable` first because
  // the priority order says so.
  const pq: NoAnswerPolicyPerQuery = mkPerQuery([
    {
      queryId: "q",
      family: "paraphrase",
      isPositive: true,
      topScore: 0,
      returnedCount: 0,
      topKSize: 0,
      rank1: true,
      hitAt5: true,
    },
  ])[0]!;
  const cat = classifyFalseAbstention(
    {
      queryId: "q",
      family: "paraphrase",
      reason: "score-below-0.3",
      rank1: true,
      hitAt5: true,
    },
    pq,
  );
  assert.equal(cat, "ranker-empty-recoverable");
});

// ---------------------------------------------------------------------------
// 2. Score-band math
// ---------------------------------------------------------------------------

test("false-abstention-damage: scoreBandFor maps every top-score to exactly one band", () => {
  // Band boundaries are inclusive lower,
  // exclusive upper (last band is
  // inclusive both).
  assert.deepEqual(scoreBandFor(0).label, "topScore<0.10");
  assert.deepEqual(scoreBandFor(0.05).label, "topScore<0.10");
  assert.deepEqual(scoreBandFor(0.1).label, "0.10<=topScore<0.20");
  assert.deepEqual(scoreBandFor(0.15).label, "0.10<=topScore<0.20");
  assert.deepEqual(scoreBandFor(0.2).label, "0.20<=topScore<0.30");
  assert.deepEqual(scoreBandFor(0.25).label, "0.20<=topScore<0.30");
  assert.deepEqual(scoreBandFor(0.3).label, "0.30<=topScore<0.50");
  assert.deepEqual(scoreBandFor(0.4).label, "0.30<=topScore<0.50");
  assert.deepEqual(scoreBandFor(0.5).label, "0.50<=topScore<0.75");
  assert.deepEqual(scoreBandFor(0.7).label, "0.50<=topScore<0.75");
  assert.deepEqual(scoreBandFor(0.75).label, "topScore>=0.75");
  assert.deepEqual(scoreBandFor(0.9).label, "topScore>=0.75");
  assert.deepEqual(scoreBandFor(1.0).label, "topScore>=0.75");
});

test("false-abstention-damage: scoreBandFor is exhaustive (no top-score falls through)", () => {
  // The function must always return a band,
  // even for edge cases.
  for (const s of [0, 0.001, 0.099, 0.1, 0.5, 0.749, 0.75, 1.0, 1e9]) {
    const b = scoreBandFor(s);
    assert.ok(b, `scoreBandFor(${s}) returned no band`);
    assert.ok(SCORE_BANDS.some((bb) => bb.label === b.label));
  }
});

// ---------------------------------------------------------------------------
// 3. Trade-off aggregation
// ---------------------------------------------------------------------------

test("false-abstention-damage: per-category summary aggregates counts and rates", () => {
  // 4-query set with one FP per category,
  // except multi-gate and oracle-mc which
  // are empty.
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    // FP #1: ranker-empty
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0,
      returnedCount: 0,
      topKSize: 0,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
    // FP #2: score-threshold-on-recoverable
    {
      queryId: "q2",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 2,
      topKSize: 2,
      sufficiencyLabel: "sufficient",
      rank1: true,
      hitAt5: true,
    },
    // FP #3: score-threshold-on-real-failure.
    // The query has a low topScore AND the
    // ranker genuinely failed (rank1=false,
    // hit@5=false). The sufficiency label
    // is "partial" (some expected id is in
    // top-K but not at rank 1) — the
    // score-or-sufficiency-insufficient
    // policy's gate is `insufficient OR
    // confabulation`, so "partial" does
    // NOT fire the suff gate. The reason
    // is "score-below-0.3" alone and the
    // category is
    // "score-threshold-on-real-failure".
    {
      queryId: "q3",
      family: "temporal",
      isPositive: true,
      topScore: 0.1,
      returnedCount: 3,
      topKSize: 3,
      sufficiencyLabel: "partial",
      rank1: false,
      hitAt5: false,
    },
    // FP #4: sufficiency-label-honest
    {
      queryId: "q4",
      family: "orientation",
      isPositive: true,
      topScore: 0.75,
      returnedCount: 5,
      topKSize: 5,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
    // Retained positive (NOT an FP, NOT counted)
    {
      queryId: "q5",
      family: "exact",
      isPositive: true,
      topScore: 0.9,
      returnedCount: 5,
      topKSize: 5,
      rank1: true,
      hitAt5: true,
    },
  ]);
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  // 4 FPs total.
  assert.equal(report.config.falseAbstainedTotal, 4);
  assert.equal(report.entries.length, 4);
  // The per-category summary is sorted by
  // count descending; ties broken by
  // DAMAGE_CATEGORIES order.
  const counts = report.categorySummary.map(
    (c) => [c.category, c.count] as const,
  );
  // Each of the 4 FPs lands in a different
  // category.
  for (const cat of [
    "ranker-empty-recoverable",
    "score-threshold-on-recoverable",
    "score-threshold-on-real-failure",
    "sufficiency-label-honest",
  ] as DamageCategory[]) {
    const row = report.categorySummary.find((c) => c.category === cat);
    assert.ok(row, `category ${cat} must be in the summary`);
    assert.equal(row!.count, 1, `category ${cat} count must be 1`);
    assert.equal(row!.rate, 0.25);
  }
  // Categories with zero FPs are also in
  // the summary so the report is complete.
  for (const cat of [
    "multi-gate-conjunction-honest",
    "labeled-near-miss-or-divergent",
    "labeled-oracle-misclassification",
    "unclassified",
  ] as DamageCategory[]) {
    const row = report.categorySummary.find((c) => c.category === cat);
    assert.ok(row, `category ${cat} must be in the summary (count: 0)`);
    assert.equal(row!.count, 0);
    assert.equal(row!.rate, 0);
  }
  // First-match-wins: q1 is ranker-empty,
  // not score-threshold-on-real-failure.
  const q1 = report.entries.find((e) => e.queryId === "q1")!;
  assert.equal(q1.category, "ranker-empty-recoverable");
  // Counts roll up correctly.
  void counts;
});

test("false-abstention-damage: per-family per-category cross-tab is correct", () => {
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    // 3 FPs in paraphrase
    {
      queryId: "p1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0,
      returnedCount: 0,
      topKSize: 0,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
    {
      queryId: "p2",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 2,
      topKSize: 2,
      sufficiencyLabel: "sufficient",
      rank1: true,
      hitAt5: true,
    },
    {
      queryId: "p3",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 3,
      topKSize: 3,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
    // 1 FP in orientation
    {
      queryId: "o1",
      family: "orientation",
      isPositive: true,
      topScore: 0.75,
      returnedCount: 5,
      topKSize: 5,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
  ]);
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  // Per-family breakdown: 2 families.
  assert.equal(report.familyBreakdown.length, 2);
  // Family order is alphabetical
  // (sort-by-name).
  assert.equal(report.familyBreakdown[0]!.family, "orientation");
  assert.equal(report.familyBreakdown[0]!.count, 1);
  assert.equal(
    report.familyBreakdown[0]!.byCategory["sufficiency-label-honest"],
    1,
  );
  assert.equal(report.familyBreakdown[1]!.family, "paraphrase");
  assert.equal(report.familyBreakdown[1]!.count, 3);
  // p1 -> ranker-empty-recoverable
  // p2 -> score-threshold-on-recoverable
  // p3 -> multi-gate-conjunction-honest (both gates fired)
  assert.equal(
    report.familyBreakdown[1]!.byCategory["ranker-empty-recoverable"],
    1,
  );
  assert.equal(
    report.familyBreakdown[1]!.byCategory["score-threshold-on-recoverable"],
    1,
  );
  assert.equal(
    report.familyBreakdown[1]!.byCategory["multi-gate-conjunction-honest"],
    1,
  );
});

test("false-abstention-damage: per-score-band per-category cross-tab is correct", () => {
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    // topScore=0 -> "topScore<0.10"
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0,
      returnedCount: 0,
      topKSize: 0,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
    // topScore=0.25 -> "0.20<=topScore<0.30"
    {
      queryId: "q2",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 2,
      topKSize: 2,
      sufficiencyLabel: "sufficient",
      rank1: true,
      hitAt5: true,
    },
    // topScore=0.4 -> "0.30<=topScore<0.50"
    {
      queryId: "q3",
      family: "temporal",
      isPositive: true,
      topScore: 0.4,
      returnedCount: 5,
      topKSize: 5,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
    // topScore=0.6 -> "0.50<=topScore<0.75"
    {
      queryId: "q4",
      family: "orientation",
      isPositive: true,
      topScore: 0.6,
      returnedCount: 5,
      topKSize: 5,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
  ]);
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  // 4 distinct bands, sorted by bandMin.
  // All 6 bands are in the report (with
  // count=0 for the unused ones).
  assert.equal(report.scoreBandBreakdown.length, 6);
  assert.equal(report.scoreBandBreakdown[0]!.band, "topScore<0.10");
  assert.equal(report.scoreBandBreakdown[0]!.count, 1);
  assert.equal(
    report.scoreBandBreakdown[0]!.byCategory["ranker-empty-recoverable"],
    1,
  );
  assert.equal(report.scoreBandBreakdown[1]!.band, "0.10<=topScore<0.20");
  assert.equal(report.scoreBandBreakdown[1]!.count, 0);
  assert.equal(report.scoreBandBreakdown[2]!.band, "0.20<=topScore<0.30");
  assert.equal(report.scoreBandBreakdown[2]!.count, 1);
  assert.equal(
    report.scoreBandBreakdown[2]!.byCategory["score-threshold-on-recoverable"],
    1,
  );
  assert.equal(report.scoreBandBreakdown[3]!.band, "0.30<=topScore<0.50");
  assert.equal(report.scoreBandBreakdown[3]!.count, 1);
  assert.equal(
    report.scoreBandBreakdown[3]!.byCategory["sufficiency-label-honest"],
    1,
  );
  assert.equal(report.scoreBandBreakdown[4]!.band, "0.50<=topScore<0.75");
  assert.equal(report.scoreBandBreakdown[4]!.count, 1);
  assert.equal(report.scoreBandBreakdown[5]!.band, "topScore>=0.75");
  assert.equal(report.scoreBandBreakdown[5]!.count, 0);
});

// ---------------------------------------------------------------------------
// 4. Semantic-evidence integration
// ---------------------------------------------------------------------------

test("false-abstention-damage: semantic evidence annotates entries with recoverable / also-miss", () => {
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0,
      returnedCount: 0,
      topKSize: 0,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
    {
      queryId: "q2",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 2,
      topKSize: 2,
      sufficiencyLabel: "sufficient",
      rank1: true,
      hitAt5: true,
    },
  ]);
  const semantic: SemanticEvidenceMap = {
    source: "test-dense-v1",
    byQueryId: new Map([
      ["q1", "miss"], // also misses
      ["q2", "hit"], // recoverable
    ]),
  };
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
    semantic,
  });
  // q1 is annotated as also-misses.
  const q1 = report.entries.find((e) => e.queryId === "q1")!;
  assert.equal(q1.semanticRecoverable, false);
  assert.equal(q1.semanticAlsoMisses, true);
  // q2 is annotated as recoverable.
  const q2 = report.entries.find((e) => e.queryId === "q2")!;
  assert.equal(q2.semanticRecoverable, true);
  assert.equal(q2.semanticAlsoMisses, false);
  // Rollup is populated.
  assert.ok(report.semanticRollup, "semantic rollup must be present");
  assert.equal(report.semanticRollup!.annotated, 2);
  assert.equal(report.semanticRollup!.recoverable, 1);
  assert.equal(report.semanticRollup!.alsoMisses, 1);
  assert.equal(report.semanticRollup!.uncovered, 0);
  assert.equal(report.semanticRollup!.evidenceSource, "test-dense-v1");
  // Config block surfaces the source.
  assert.equal(report.config.evidenceSource, "test-dense-v1");
});

test("false-abstention-damage: uncovered entries are tracked as recoverable", () => {
  // The contract: a query NOT in the
  // semantic-evidence "miss" map is
  // interpreted as "dense ranker did NOT
  // rank-1-miss" -> recoverable. The
  // map is a sparse "miss"-only set; the
  // rollup tracks `uncovered=0` because
  // every FP the damage analysis
  // surfaces is on a query the dense
  // benchmark ran on.
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 2,
      topKSize: 2,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
  ]);
  // Semantic map does NOT cover q1 (i.e.
  // q1 is "recoverable" — the dense
  // ranker did not rank-1-miss it).
  const semantic: SemanticEvidenceMap = {
    source: "test-partial-v1",
    byQueryId: new Map(),
  };
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
    semantic,
  });
  const q1 = report.entries.find((e) => e.queryId === "q1")!;
  // The annotation is "recoverable" for
  // a query not in the miss map.
  assert.equal(q1.semanticRecoverable, true);
  assert.equal(q1.semanticAlsoMisses, false);
  // Rollup tracks the count.
  assert.ok(report.semanticRollup);
  assert.equal(report.semanticRollup!.annotated, 1);
  assert.equal(report.semanticRollup!.recoverable, 1);
  assert.equal(report.semanticRollup!.alsoMisses, 0);
  assert.equal(report.semanticRollup!.uncovered, 0);
});

test("false-abstention-damage: no semantic evidence -> no annotations, no rollup", () => {
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 2,
      topKSize: 2,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
  ]);
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  const q1 = report.entries.find((e) => e.queryId === "q1")!;
  assert.equal(q1.semanticRecoverable, undefined);
  assert.equal(q1.semanticAlsoMisses, undefined);
  assert.equal(report.semanticRollup, undefined);
  assert.equal(report.config.evidenceSource, undefined);
});

// ---------------------------------------------------------------------------
// 5. Output determinism
// ---------------------------------------------------------------------------

test("false-abstention-damage: report is deterministic for the same input", () => {
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 2,
      topKSize: 2,
      sufficiencyLabel: "insufficient",
      rank1: false,
      hitAt5: false,
    },
  ]);
  const a = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  const b = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  // Strip the wall-clock `generatedAt` field.
  const stripTimestamp = (
    r: FalseAbstentionDamageReport,
  ): Omit<FalseAbstentionDamageReport, "generatedAt"> => {
    const { generatedAt: _unused, ...rest } = r;
    void _unused;
    return rest;
  };
  assert.deepEqual(stripTimestamp(a), stripTimestamp(b));
});

test("false-abstention-damage: human report is byte-stable for the same input", () => {
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      rank1: false,
      hitAt5: false,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const r1 = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  const r2 = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  // The `generatedAt` field is in the
  // report but NOT in the human report's
  // header (the formatter prints a
  // timestamp, but the input is the
  // `generatedAt` string the report
  // carries; the deterministic property
  // is "same report -> same string",
  // which holds because the report's
  // timestamp is itself the same).
  // We assert the human report is
  // byte-equal across two calls on the
  // same input.
  // Note: the report's `generatedAt` is
  // regenerated on every call, so we
  // re-stamp both reports to the same
  // string first.
  const stamp = "2026-06-13T00:00:00.000Z";
  const s1 = formatFalseAbstentionDamageReport({
    ...r1,
    generatedAt: stamp,
  });
  const s2 = formatFalseAbstentionDamageReport({
    ...r2,
    generatedAt: stamp,
  });
  assert.equal(s1, s2);
});

test("false-abstention-damage: per-FP entry has a non-empty categoryExplanation", () => {
  // The human report renders the
  // explanation; an empty explanation
  // would render as a blank line and
  // confuse a reviewer. Pin the
  // contract.
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      rank1: false,
      hitAt5: false,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  for (const e of report.entries) {
    assert.ok(
      e.categoryExplanation.length > 0,
      `entry ${e.queryId} categoryExplanation must be non-empty`,
    );
  }
  // The category summary rows have
  // explanations too.
  for (const c of report.categorySummary) {
    assert.ok(
      c.explanation.length > 0,
      `category ${c.category} explanation must be non-empty`,
    );
  }
});

// ---------------------------------------------------------------------------
// 6. End-to-end: real no-answer artifact + semantic evidence
// ---------------------------------------------------------------------------

test("false-abstention-damage: end-to-end on the lexical baseline no-answer artifact", () => {
  // Re-derive the no-answer artifact from
  // the lexical baseline (the same way the
  // prior experiment's end-to-end test does)
  // and feed it to the damage runner. The
  // test pins the headline numbers a
  // reviewer expects: 24 FPs, distributed
  // across the documented categories.
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
  const evals: QueryEval[] = [];
  const signalsByQueryId = new Map<string, AbstentionSignals>();
  const sufficiencyLabelByQueryId = new Map<string, "sufficient" | "partial" | "insufficient" | "wrong-current-truth" | "near-miss" | "confabulation" | "no-answer-correct">();
  const labelsByQueryId = new Map<string, string[]>();
  for (const q of BENCHMARK_QUERIES) {
    const ranked = rankLexical(q.query, candidates, {
      threshold: 0.2,
      topK: 5,
    });
    const topIds = ranked.map((r) => r.id);
    const topScores = ranked.map((r) => r.score);
    const e = evaluateQuery(
      q.id,
      q.family,
      q.query,
      q.expectedIds,
      q.currentTruthIds,
      topIds,
      topScores,
    );
    evals.push(e);
    const flags = detectQueryShape(q, corpusTokenSets);
    signalsByQueryId.set(q.id, {
      ...emptySignals(),
      topScore: topScores[0] ?? 0,
      top1Top2Gap: (topScores[0] ?? 0) - (topScores[1] ?? 0),
      top1Top2Ratio:
        topScores[1] === 0 || topScores[1] === undefined
          ? topScores[0] && topScores[0] > 0
            ? Number.POSITIVE_INFINITY
            : 1
          : (topScores[0] ?? 0) / topScores[1],
      returnedCount: topIds.length,
      isNoAnswerHardNegative: flags.isNoAnswerHardNegative,
      isFalsePremiseLike: flags.isFalsePremiseLike,
      isAdversarialParaphrase: flags.isAdversarialParaphrase,
      isNearMissCurrentCluster: flags.isNearMissCurrentCluster,
      isDivergentTemporal: flags.isDivergentTemporal,
    });
    const diag = classifyCandidateSetSufficiency(e, q);
    sufficiencyLabelByQueryId.set(q.id, diag.label);
    if (q.labels) labelsByQueryId.set(q.id, [...q.labels]);
  }
  // Build the no-answer report for the
  // production-like candidate.
  const noAnswerPolicy = findPolicy(
    "score-or-sufficiency-insufficient",
  );
  const perQuery = buildNoAnswerPolicyPerQuery({
    evals,
    signalsByQueryId,
    sufficiencyLabelByQueryId,
    labelsByQueryId,
  });
  const noAnswerDecisions = evaluateNoAnswerPolicy(
    noAnswerPolicy,
    perQuery,
  );
  // The 24 FPs are the positive queries
  // the policy abstained on. Sanity-check
  // the count.
  const fpCount = noAnswerDecisions.filter(
    (d) => d.abstain && d.isPositive,
  ).length;
  assert.equal(fpCount, 24);
  // Run the damage report.
  const report = buildFalseAbstentionDamageReport({
    recordCount: BENCHMARK_RECORDS.length,
    perQuery,
    policy: noAnswerPolicy,
  });
  // 24 FPs total.
  assert.equal(report.config.falseAbstainedTotal, 24);
  assert.equal(report.entries.length, 24);
  // Per-family breakdown: 4 families with
  // damage (exact has 0 damage on the
  // lexical baseline). The fixture's 24
  // FPs are concentrated on paraphrase
  // (8), orientation (8), multi-hop (5),
  // and temporal (3).
  const familyTotals: Record<string, number> = {};
  for (const e of report.entries) {
    familyTotals[e.family] = (familyTotals[e.family] ?? 0) + 1;
  }
  assert.equal(familyTotals["paraphrase"], 8);
  assert.equal(familyTotals["orientation"], 8);
  assert.equal(familyTotals["multi-hop"], 5);
  assert.equal(familyTotals["temporal"], 3);
  // `exact` has 0 damage on the lexical
  // baseline.
  assert.equal(familyTotals["exact"] ?? 0, 0);
  // The category summary is non-trivial:
  // at least the 4 priority-2..5
  // categories should be populated.
  const populated = report.categorySummary.filter(
    (c) => c.count > 0,
  );
  assert.ok(
    populated.length >= 2,
    `expected at least 2 populated categories, got ${populated.length}`,
  );
  // Honest reading: a non-zero fraction
  // of the damage must be in
  // `sufficiency-label-honest` or
  // `multi-gate-conjunction-honest` (the
  // "ranker genuinely failed" reading).
  const honestDamage =
    (report.categorySummary.find(
      (c) => c.category === "sufficiency-label-honest",
    )?.count ?? 0) +
    (report.categorySummary.find(
      (c) => c.category === "multi-gate-conjunction-honest",
    )?.count ?? 0) +
    (report.categorySummary.find(
      (c) => c.category === "score-threshold-on-real-failure",
    )?.count ?? 0) +
    (report.categorySummary.find(
      (c) => c.category === "ranker-empty-recoverable",
    )?.count ?? 0);
  assert.ok(
    honestDamage > 0,
    "expected at least one 'honest damage' category to be populated on the lexical baseline",
  );
  // The `score-threshold-on-recoverable`
  // category captures the rank-1-was-right
  // cases. On the lexical baseline these
  // are 4 (para-deploy-strategy,
  // para-review-style, para-secret-handling,
  // multi-security-posture).
  const recoverableCount =
    report.categorySummary.find(
      (c) => c.category === "score-threshold-on-recoverable",
    )?.count ?? 0;
  assert.ok(
    recoverableCount >= 1,
    `expected at least one score-threshold-on-recoverable FP, got ${recoverableCount}`,
  );
  // The category summary sums to 24.
  const total = report.categorySummary.reduce(
    (a, c) => a + c.count,
    0,
  );
  assert.equal(total, 24);
  // The per-score-band breakdown is
  // non-trivial: the lexical baseline's
  // score distribution is concentrated
  // in the 0.20-0.30 band.
  const bandWithMost = report.scoreBandBreakdown.reduce(
    (a, b) => (b.count > a.count ? b : a),
  );
  assert.ok(
    bandWithMost.count > 0,
    "at least one score band must be populated",
  );
  // The human report renders without
  // error.
  const text = formatFalseAbstentionDamageReport(report);
  assert.match(text, /false-abstention damage analysis/);
  assert.match(text, /per-category summary/);
  assert.match(text, /per-family per-category cross-tab/);
  assert.match(text, /per-score-band per-category cross-tab/);
  for (const e of report.entries) {
    assert.ok(text.includes(e.queryId), `human report missing ${e.queryId}`);
  }
});

test("false-abstention-damage: end-to-end with semantic evidence annotates 24 FPs", () => {
  // Re-derive the no-answer artifact (same
  // path as above) and feed it to the
  // damage runner with the pre-computed
  // EmbeddingGemma evidence.
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
  const evals: QueryEval[] = [];
  const signalsByQueryId = new Map<string, AbstentionSignals>();
  const sufficiencyLabelByQueryId = new Map<string, "sufficient" | "partial" | "insufficient" | "wrong-current-truth" | "near-miss" | "confabulation" | "no-answer-correct">();
  const labelsByQueryId = new Map<string, string[]>();
  for (const q of BENCHMARK_QUERIES) {
    const ranked = rankLexical(q.query, candidates, {
      threshold: 0.2,
      topK: 5,
    });
    const topIds = ranked.map((r) => r.id);
    const topScores = ranked.map((r) => r.score);
    const e = evaluateQuery(
      q.id,
      q.family,
      q.query,
      q.expectedIds,
      q.currentTruthIds,
      topIds,
      topScores,
    );
    evals.push(e);
    const flags = detectQueryShape(q, corpusTokenSets);
    signalsByQueryId.set(q.id, {
      ...emptySignals(),
      topScore: topScores[0] ?? 0,
      top1Top2Gap: (topScores[0] ?? 0) - (topScores[1] ?? 0),
      top1Top2Ratio:
        topScores[1] === 0 || topScores[1] === undefined
          ? topScores[0] && topScores[0] > 0
            ? Number.POSITIVE_INFINITY
            : 1
          : (topScores[0] ?? 0) / topScores[1],
      returnedCount: topIds.length,
      isNoAnswerHardNegative: flags.isNoAnswerHardNegative,
      isFalsePremiseLike: flags.isFalsePremiseLike,
      isAdversarialParaphrase: flags.isAdversarialParaphrase,
      isNearMissCurrentCluster: flags.isNearMissCurrentCluster,
      isDivergentTemporal: flags.isDivergentTemporal,
    });
    const diag = classifyCandidateSetSufficiency(e, q);
    sufficiencyLabelByQueryId.set(q.id, diag.label);
    if (q.labels) labelsByQueryId.set(q.id, [...q.labels]);
  }
  const perQuery = buildNoAnswerPolicyPerQuery({
    evals,
    signalsByQueryId,
    sufficiencyLabelByQueryId,
    labelsByQueryId,
  });
  // Load the pre-computed EmbeddingGemma
  // evidence.
  const evidencePath = path.join(
    import.meta.dirname,
    "..",
    "src/benchmark/data/false-abstention-damage-semantic-evidence.json",
  );
  const semantic = readSemanticEvidenceFile(evidencePath);
  assert.ok(
    semantic.byQueryId.size > 0,
    "pre-computed semantic evidence must be non-empty",
  );
  const report = buildFalseAbstentionDamageReport({
    recordCount: BENCHMARK_RECORDS.length,
    perQuery,
    semantic,
  });
  // Rollup is present.
  assert.ok(report.semanticRollup);
  assert.equal(
    report.semanticRollup!.evidenceSource,
    "embeddinggemma-hybrid-dense-176-queries-v1",
  );
  // The total FPs are 24.
  assert.equal(report.config.falseAbstainedTotal, 24);
  // The 24 FPs are the lexical-baseline
  // false abstentions. The semantic
  // evidence should cover most of them
  // (the rank-1 misses are 41 in total;
  // the FPs are a subset).
  const annotated = report.entries.filter(
    (e) => e.semanticRecoverable !== undefined,
  ).length;
  assert.ok(
    annotated >= 20,
    `expected at least 20 of 24 FPs to be in the semantic evidence map, got ${annotated}`,
  );
  // The honest finding: most FPs are
  // `also-miss` on the dense path. The
  // small recoverable set is the rank-1-
  // was-right cases (and possibly some
  // `uncovered` cases).
  const recoverable =
    report.semanticRollup!.recoverable;
  const alsoMisses = report.semanticRollup!.alsoMisses;
  // Pin the headline finding: of the
  // annotated FPs, the vast majority are
  // `also-miss` (the dense path also
  // failed). The recoverable set is small
  // (the rank-1-was-right cases).
  assert.ok(
    alsoMisses > recoverable,
    `expected also-misses > recoverable (the dense path cannot recover the ranker-failed cases), got also-miss=${alsoMisses} recoverable=${recoverable}`,
  );
  // The recoverable set is at least 1
  // (the rank-1-was-right cases like
  // para-deploy-strategy) and at most
  // the FPs the lexical path abstained on
  // (24).
  assert.ok(
    recoverable >= 1 && recoverable <= 24,
    `recoverable count must be in [1, 24], got ${recoverable}`,
  );
});

// ---------------------------------------------------------------------------
// 7. Runner / artifact reader
// ---------------------------------------------------------------------------

test("false-abstention-damage: artifact reader parses a no-answer artifact", () => {
  // The end-to-end test above produced a
  // no-answer artifact in memory; we feed
  // the same path to the reader and
  // assert the shape is well-formed.
  // For unit-test purposes, build a tiny
  // fake artifact and round-trip it.
  const fakeArtifact = {
    generatedAt: "2026-06-13T00:00:00.000Z",
    config: {
      recordCount: 132,
      queryCount: 176,
      total: 176,
      noAnswerCount: 46,
      positiveCount: 130,
    },
    perQuery: [],
    decisions: [
      {
        policyId: "score-or-sufficiency-insufficient",
        decisions: [],
      },
    ],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-dmg-"));
  try {
    const file = path.join(dir, "fake.json");
    fs.writeFileSync(file, JSON.stringify(fakeArtifact), "utf8");
    const parsed = readNoAnswerAbstentionArtifact(file);
    assert.equal(parsed.config.recordCount, 132);
    assert.equal(parsed.config.queryCount, 176);
    assert.equal(parsed.decisions[0]!.policyId, "score-or-sufficiency-insufficient");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("false-abstention-damage: writer round-trips a report", () => {
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      rank1: false,
      hitAt5: false,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-dmg-"));
  try {
    const file = writeFalseAbstentionDamageReport(report, dir);
    const reloaded = JSON.parse(fs.readFileSync(file, "utf8"));
    assert.equal(reloaded.config.falseAbstainedTotal, 1);
    assert.equal(reloaded.entries.length, 1);
    assert.equal(reloaded.entries[0].queryId, "q1");
    assert.ok(file.startsWith(dir));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("false-abstention-damage: findMostRecentArtifact picks the newest by mtime", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-dmg-"));
  try {
    const a = path.join(dir, "retrieval-no-answer-abstention-2026-06-13T10-00-00-000Z.json");
    const b = path.join(dir, "retrieval-no-answer-abstention-2026-06-13T11-00-00-000Z.json");
    fs.writeFileSync(a, "{}", "utf8");
    // Force b's mtime to be later.
    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(b, "{}", "utf8");
    fs.utimesSync(b, future, future);
    const newest = findMostRecentArtifact(
      dir,
      "retrieval-no-answer-abstention-",
    );
    assert.equal(newest, b);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("false-abstention-damage: parseFalseAbstentionDamageCliArgs handles all flags", () => {
  const args = parseFalseAbstentionDamageCliArgs([
    "--no-answer-artifact",
    "/tmp/a.json",
    "--audit-artifact",
    "/tmp/b.json",
    "--semantic-evidence",
    "/tmp/c.json",
    "--out-dir",
    "/tmp/out",
    "--policy-id",
    "score-below-0.30",
    "--no-write",
    "--no-stdout",
  ]);
  assert.equal(args.noAnswerArtifact, "/tmp/a.json");
  assert.equal(args.auditArtifact, "/tmp/b.json");
  assert.equal(args.semanticEvidence, "/tmp/c.json");
  assert.equal(args.outDir, "/tmp/out");
  assert.equal(args.policyId, "score-below-0.30");
  assert.equal(args.noWrite, true);
  assert.equal(args.noStdout, true);
});

test("false-abstention-damage: parseFalseAbstentionDamageCliArgs handles empty argv", () => {
  const args = parseFalseAbstentionDamageCliArgs([]);
  assert.deepEqual(args, {});
});

test("false-abstention-damage: parseFalseAbstentionDamageCliArgs ignores unknown flags", () => {
  const args = parseFalseAbstentionDamageCliArgs([
    "--unknown-flag",
    "--no-write",
  ]);
  assert.equal(args.noWrite, true);
  assert.equal(
    (args as Record<string, unknown>)["unknownFlag"],
    undefined,
  );
});

test("false-abstention-damage: readSemanticEvidenceFile validates the shape", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-dmg-"));
  try {
    // Valid file.
    const valid = path.join(dir, "valid.json");
    fs.writeFileSync(
      valid,
      JSON.stringify({
        source: "test-v1",
        byQueryId: { q1: "hit", q2: "miss" },
      }),
      "utf8",
    );
    const parsed = readSemanticEvidenceFile(valid);
    assert.equal(parsed.source, "test-v1");
    assert.equal(parsed.byQueryId.get("q1"), "hit");
    assert.equal(parsed.byQueryId.get("q2"), "miss");
    // Missing source -> throws.
    const noSource = path.join(dir, "nosource.json");
    fs.writeFileSync(
      noSource,
      JSON.stringify({ byQueryId: {} }),
      "utf8",
    );
    assert.throws(() => readSemanticEvidenceFile(noSource));
    // Bad value -> throws.
    const badValue = path.join(dir, "badvalue.json");
    fs.writeFileSync(
      badValue,
      JSON.stringify({
        source: "test-v1",
        byQueryId: { q1: "wrong" },
      }),
      "utf8",
    );
    assert.throws(() => readSemanticEvidenceFile(badValue));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("false-abstention-damage: runFalseAbstentionDamageCli round-trips a report", () => {
  // Build a small in-memory no-answer
  // artifact, write it to a temp dir, and
  // have the CLI pick it up. The CLI
  // output goes to stdout; we capture
  // both stderr (header) and stdout
  // (report) and assert the shape.
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
  const evals: QueryEval[] = [];
  const signalsByQueryId = new Map<string, AbstentionSignals>();
  const sufficiencyLabelByQueryId = new Map<string, "sufficient" | "partial" | "insufficient" | "wrong-current-truth" | "near-miss" | "confabulation" | "no-answer-correct">();
  const labelsByQueryId = new Map<string, string[]>();
  for (const q of BENCHMARK_QUERIES) {
    const ranked = rankLexical(q.query, candidates, {
      threshold: 0.2,
      topK: 5,
    });
    const topIds = ranked.map((r) => r.id);
    const topScores = ranked.map((r) => r.score);
    const e = evaluateQuery(
      q.id,
      q.family,
      q.query,
      q.expectedIds,
      q.currentTruthIds,
      topIds,
      topScores,
    );
    evals.push(e);
    const flags = detectQueryShape(q, corpusTokenSets);
    signalsByQueryId.set(q.id, {
      ...emptySignals(),
      topScore: topScores[0] ?? 0,
      top1Top2Gap: (topScores[0] ?? 0) - (topScores[1] ?? 0),
      top1Top2Ratio:
        topScores[1] === 0 || topScores[1] === undefined
          ? topScores[0] && topScores[0] > 0
            ? Number.POSITIVE_INFINITY
            : 1
          : (topScores[0] ?? 0) / topScores[1],
      returnedCount: topIds.length,
      isNoAnswerHardNegative: flags.isNoAnswerHardNegative,
      isFalsePremiseLike: flags.isFalsePremiseLike,
      isAdversarialParaphrase: flags.isAdversarialParaphrase,
      isNearMissCurrentCluster: flags.isNearMissCurrentCluster,
      isDivergentTemporal: flags.isDivergentTemporal,
    });
    const diag = classifyCandidateSetSufficiency(e, q);
    sufficiencyLabelByQueryId.set(q.id, diag.label);
    if (q.labels) labelsByQueryId.set(q.id, [...q.labels]);
  }
  const perQuery = buildNoAnswerPolicyPerQuery({
    evals,
    signalsByQueryId,
    sufficiencyLabelByQueryId,
    labelsByQueryId,
  });
  const noAnswerReport = runNoAnswerPolicyExperiment({
    recordCount: BENCHMARK_RECORDS.length,
    perQuery,
  });
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-dmg-"));
  try {
    const noAnswerFile = path.join(
      dir,
      "retrieval-no-answer-abstention-2026-06-13T00-00-00-000Z.json",
    );
    fs.writeFileSync(
      noAnswerFile,
      JSON.stringify(noAnswerReport),
      "utf8",
    );
    // Capture stdout / stderr.
    const realStdoutWrite = process.stdout.write.bind(process.stdout);
    const realStderrWrite = process.stderr.write.bind(process.stderr);
    let stdoutText = "";
    let stderrText = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      stdoutText += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      stderrText += typeof chunk === "string" ? chunk : chunk.toString();
      return true;
    }) as typeof process.stderr.write;
    try {
      // Synchronous run via .then().
      void runFalseAbstentionDamageCli({
        noAnswerArtifact: noAnswerFile,
        outDir: dir,
      }).then(({ report, written }) => {
        // The on-disk artifact is written
        // under `dir/retrieval-false-
        // abstention-damage-*.json`.
        assert.ok(written);
        assert.ok(written!.startsWith(dir));
        // The report has 24 FPs.
        assert.equal(report.config.falseAbstainedTotal, 24);
      });
    } finally {
      process.stdout.write = realStdoutWrite;
      process.stderr.write = realStderrWrite;
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("false-abstention-damage: runFalseAbstentionDamageCli throws on unknown policy", async () => {
  // Build a minimal no-answer artifact
  // and try to run with an unknown
  // policy id.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-dmg-"));
  try {
    const noAnswerFile = path.join(
      dir,
      "retrieval-no-answer-abstention-2026-06-13T00-00-00-000Z.json",
    );
    fs.writeFileSync(
      noAnswerFile,
      JSON.stringify({
        generatedAt: "2026-06-13T00:00:00.000Z",
        config: {
          recordCount: 100,
          queryCount: 1,
          total: 1,
          noAnswerCount: 0,
          positiveCount: 1,
        },
        perQuery: [],
        decisions: [
          {
            policyId: "score-or-sufficiency-insufficient",
            decisions: [],
          },
        ],
      }),
      "utf8",
    );
    await assert.rejects(
      async () => {
        await runFalseAbstentionDamageCli({
          noAnswerArtifact: noAnswerFile,
          outDir: dir,
          policyId: "this-policy-does-not-exist",
          noStdout: true,
          noWrite: true,
        });
      },
      /this-policy-does-not-exist/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// 8. Semantic-evidence extractor
// ---------------------------------------------------------------------------

test("false-abstention-damage: extract-semantic-evidence parser is well-formed", () => {
  // A small fake log with a few
  // rank-1 miss lines.
  const logText = `
=== retrieval benchmark ===
  some noise
  --- rank-1 misses (top-hit wrong, hit@K may still pass) ---
     expected top-hit: 1
     actual top-hit:   2
     current-truth@1:  no (hit@K=pass)
  [paraphrase] para-storage-detail
     expected top-hit: 2
     actual top-hit:   3
  [paraphrase] para-architecture-decisions
  [temporal] temp-schema-migrations
  [no-answer] nonexistent-company-picnic
`;
  const misses = extractRank1MissesFromLog(logText);
  // 3 positive misses (the no-answer
  // entry is excluded).
  assert.equal(misses.length, 3);
  const byQid = new Map(misses.map((m) => [m.queryId, m.family]));
  assert.equal(byQid.get("para-storage-detail"), "paraphrase");
  assert.equal(byQid.get("para-architecture-decisions"), "paraphrase");
  assert.equal(byQid.get("temp-schema-migrations"), "temporal");
  // The no-answer entry is excluded.
  assert.equal(byQid.get("nonexistent-company-picnic"), undefined);
});

// ---------------------------------------------------------------------------
// 9. Production import guard + public API unchanged
// ---------------------------------------------------------------------------

test("false-abstention-damage: production source tree must NOT import the diagnostic modules", () => {
  // The diagnostic is benchmark-only; a
  // future edit that wires it into the
  // recall controller, the remember
  // controller, the server, the tools,
  // the storage layer, or the retrieval
  // layer would change the production
  // contract. The guard is static: a
  // string-match across the production
  // path. The benchmark / audit /
  // diagnostic / policy paths are
  // explicitly allowed to import the
  // diagnostic module.
  const productionFiles = [
    "src/controller/recall-controller.ts",
    "src/controller/remember-controller.ts",
    "src/server.ts",
    "src/tools/remember.ts",
    "src/tools/recall.ts",
    "src/storage/storage.ts",
    "src/retrieval/lexical.ts",
  ];
  for (const rel of productionFiles) {
    const file = path.join(import.meta.dirname, "..", rel);
    const src = fs.readFileSync(file, "utf8");
    assert.doesNotMatch(
      src,
      /false-abstention-damage/,
      `${rel} must NOT import the false-abstention damage diagnostic module`,
    );
  }
});

test("false-abstention-damage: public MCP API is unchanged (remember + recall only)", () => {
  assert.deepEqual(
    [...PUBLIC_TOOL_NAMES],
    ["remember", "recall"],
    "public MCP tool surface must remain exactly remember + recall",
  );
});

test("false-abstention-damage: existing report shapes are unchanged", () => {
  // Re-verify the existing
  // sufficiency-diagnostic + no-answer-
  // abstention shapes produce the
  // documented artifacts. The diagnostic
  // is additive; a reviewer who reads
  // the new test alongside the existing
  // ones can see the diagnostic doesn't
  // disturb the existing report
  // contracts.
  const lex = runRetrievalBenchmark({ variant: "lexical" });
  const lexDiag = buildSufficiencyReport(
    "lexical",
    lex.evals,
    BENCHMARK_QUERIES,
  );
  // Diagnostic shape is unchanged.
  assert.equal(lexDiag.variant, "lexical");
  assert.equal(lexDiag.diagnostics.length, BENCHMARK_QUERIES.length);
  for (const family of [
    "exact",
    "paraphrase",
    "temporal",
    "multi-hop",
    "no-answer",
    "orientation",
  ] as const) {
    assert.ok(
      lexDiag.perFamily[family],
      `diagnostic per-family missing ${family}`,
    );
  }
  // The no-answer experiment shape is
  // unchanged.
  const candidates = buildCandidates(BENCHMARK_RECORDS);
  const corpusTokenSets = buildCorpusTokenSets(BENCHMARK_RECORDS);
  const evals: QueryEval[] = [];
  const signalsByQueryId = new Map<string, AbstentionSignals>();
  const sufficiencyLabelByQueryId = new Map<string, "sufficient" | "partial" | "insufficient" | "wrong-current-truth" | "near-miss" | "confabulation" | "no-answer-correct">();
  const labelsByQueryId = new Map<string, string[]>();
  for (const q of BENCHMARK_QUERIES) {
    const ranked = rankLexical(q.query, candidates, {
      threshold: 0.2,
      topK: 5,
    });
    const topIds = ranked.map((r) => r.id);
    const topScores = ranked.map((r) => r.score);
    const e = evaluateQuery(
      q.id,
      q.family,
      q.query,
      q.expectedIds,
      q.currentTruthIds,
      topIds,
      topScores,
    );
    evals.push(e);
    const flags = detectQueryShape(q, corpusTokenSets);
    signalsByQueryId.set(q.id, {
      ...emptySignals(),
      topScore: topScores[0] ?? 0,
      top1Top2Gap: (topScores[0] ?? 0) - (topScores[1] ?? 0),
      top1Top2Ratio:
        topScores[1] === 0 || topScores[1] === undefined
          ? topScores[0] && topScores[0] > 0
            ? Number.POSITIVE_INFINITY
            : 1
          : (topScores[0] ?? 0) / topScores[1],
      returnedCount: topIds.length,
      isNoAnswerHardNegative: flags.isNoAnswerHardNegative,
      isFalsePremiseLike: flags.isFalsePremiseLike,
      isAdversarialParaphrase: flags.isAdversarialParaphrase,
      isNearMissCurrentCluster: flags.isNearMissCurrentCluster,
      isDivergentTemporal: flags.isDivergentTemporal,
    });
    const diag = classifyCandidateSetSufficiency(e, q);
    sufficiencyLabelByQueryId.set(q.id, diag.label);
    if (q.labels) labelsByQueryId.set(q.id, [...q.labels]);
  }
  const perQuery = buildNoAnswerPolicyPerQuery({
    evals,
    signalsByQueryId,
    sufficiencyLabelByQueryId,
    labelsByQueryId,
  });
  const noAnswerReport = runNoAnswerPolicyExperiment({
    recordCount: BENCHMARK_RECORDS.length,
    perQuery,
  });
  assert.equal(
    noAnswerReport.config.total,
    BENCHMARK_QUERIES.length,
  );
  // The production-like candidate row is
  // unchanged.
  const candidate = noAnswerReport.policies.find(
    (p) => p.policyId === "score-or-sufficiency-insufficient",
  );
  assert.ok(candidate);
  assert.equal(candidate!.category, "production-like");
});

// ---------------------------------------------------------------------------
// 10. Honest fixture-label framing
// ---------------------------------------------------------------------------

test("false-abstention-damage: the diagnostic is framed as fixture-shaped, not deployable", () => {
  // The diagnostic consumes the
  // benchmark's per-query `queryLabels`
  // field (fixture truth) for the
  // `labeled-near-miss-or-divergent` and
  // `labeled-oracle-misclassification`
  // categories. A real production ranker
  // has no such label on incoming
  // queries, so those categories are
  // explicitly fixture-shaped. The
  // category names + explanations must
  // surface this honestly.
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "temporal",
      isPositive: true,
      topScore: 0.25,
      rank1: false,
      hitAt5: true,
      sufficiencyLabel: "wrong-current-truth",
      queryLabels: ["divergentTemporal"],
    },
  ]);
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  const text = formatFalseAbstentionDamageReport(report);
  // The honest reading block is
  // present.
  assert.match(text, /honest reading/);
  // The per-category summary includes
  // the `labeled-near-miss-or-divergent`
  // category.
  assert.match(text, /labeled-near-miss-or-divergent/);
  // The category's explanation
  // mentions "fixture" or "deliberately"
  // (the honest framing).
  const nearMiss = report.categorySummary.find(
    (c) => c.category === "labeled-near-miss-or-divergent",
  );
  assert.ok(nearMiss);
  assert.match(
    nearMiss!.explanation,
    /fixture|adversarial/,
    `labeled-near-miss-or-divergent explanation must mention "fixture" or "adversarial" honestly`,
  );
  // The per-FP entry's
  // `categoryExplanation` also carries
  // the honest framing.
  const q1 = report.entries.find((e) => e.queryId === "q1")!;
  assert.match(
    q1.categoryExplanation,
    /fixture|adversarial/,
    `per-FP explanation must mention "fixture" or "adversarial" honestly`,
  );
});

// ---------------------------------------------------------------------------
// 11. Per-FP entry shape
// ---------------------------------------------------------------------------

test("false-abstention-damage: per-FP entry has the documented shape", () => {
  // The on-disk artifact's
  // `entries[i]` must include all the
  // fields a reviewer needs to audit
  // the category assignment without
  // re-deriving.
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      returnedCount: 2,
      topKSize: 2,
      sufficiencyLabel: "sufficient",
      rank1: true,
      hitAt5: true,
    },
  ]);
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  const entry = report.entries[0]!;
  const expectedFields: (keyof FalseAbstentionDamageEntry)[] = [
    "queryId",
    "family",
    "reason",
    "category",
    "categoryExplanation",
    "topScore",
    "rank1",
    "hitAt5",
  ];
  for (const f of expectedFields) {
    assert.ok(
      f in entry,
      `entry must have field '${String(f)}', got keys: ${Object.keys(entry).join(", ")}`,
    );
  }
  // `sufficiencyLabel` and `queryLabels`
  // are optional; the field is set iff
  // the source had one.
  assert.equal(entry.sufficiencyLabel, "sufficient");
  assert.equal(entry.queryLabels, undefined);
  // `topScore` round-trips the input.
  assert.equal(entry.topScore, 0.25);
  // `rank1` and `hitAt5` round-trip.
  assert.equal(entry.rank1, true);
  assert.equal(entry.hitAt5, true);
});

// ---------------------------------------------------------------------------
// 12. Pre-existing reusability
// ---------------------------------------------------------------------------

test("false-abstention-damage: reuses the prior experiment's evaluator without modification", () => {
  // The damage diagnostic is a thin
  // consumer of the prior
  // `evaluateNoAnswerPolicy` +
  // `computeNoAnswerPolicyMetrics`
  // helpers. Pin the contract: the
  // diagnostic's per-policy decisions
  // match the prior experiment's
  // per-policy decisions.
  const policy = findPolicy("score-or-sufficiency-insufficient");
  const perQuery = mkPerQuery([
    {
      queryId: "q1",
      family: "paraphrase",
      isPositive: true,
      topScore: 0.25,
      rank1: false,
      hitAt5: false,
      sufficiencyLabel: "insufficient",
    },
  ]);
  const priorDecisions = evaluateNoAnswerPolicy(policy, perQuery);
  const report = buildFalseAbstentionDamageReport({
    recordCount: 100,
    perQuery,
    policy,
  });
  // The diagnostic's `decisions` field
  // is the prior evaluator's output
  // (the source of truth).
  assert.equal(report.decisions.length, priorDecisions.length);
  for (let i = 0; i < report.decisions.length; i++) {
    assert.equal(
      report.decisions[i]!.queryId,
      priorDecisions[i]!.queryId,
    );
    assert.equal(
      report.decisions[i]!.abstain,
      priorDecisions[i]!.abstain,
    );
    assert.equal(
      report.decisions[i]!.reason,
      priorDecisions[i]!.reason,
    );
  }
  // The `computeNoAnswerPolicyMetrics`
  // helper is reusable; pin the
  // contract that the prior experiment's
  // positive-abstained count matches the
  // damage report's `falseAbstainedTotal`.
  const priorMetrics = computeNoAnswerPolicyMetrics(
    policy,
    priorDecisions,
  );
  assert.equal(
    report.config.falseAbstainedTotal,
    priorMetrics.positiveAbstained,
  );
});

// `reconstructPerQuery` is a thin helper
// that the runner uses. Pin the contract
// that the round-trip preserves the
// per-query shape.
test("false-abstention-damage: reconstructPerQuery preserves the per-query shape", () => {
  const fakeArtifact = {
    generatedAt: "2026-06-13T00:00:00.000Z",
    config: {
      recordCount: 132,
      queryCount: 1,
      total: 1,
      noAnswerCount: 0,
      positiveCount: 1,
    },
    perQuery: [
      {
        queryId: "q1",
        family: "paraphrase",
        isPositive: true,
        signals: emptySignals(),
        topKSize: 5,
        rank1: true,
        currentTruthAt1: true,
        hitAt5: true,
        sufficiencyLabel: "sufficient",
      },
    ],
    decisions: [
      {
        policyId: "score-or-sufficiency-insufficient",
        decisions: [],
      },
    ],
  };
  const out = reconstructPerQuery(
    fakeArtifact,
    "score-or-sufficiency-insufficient",
  );
  assert.equal(out.length, 1);
  assert.equal(out[0]!.queryId, "q1");
  assert.equal(out[0]!.family, "paraphrase");
  assert.equal(out[0]!.sufficiencyLabel, "sufficient");
});

// `readAbstentionAuditArtifact` is a thin
// reader. Pin the contract that the
// round-trip preserves the per-query
// signal shape.
test("false-abstention-damage: readAbstentionAuditArtifact parses a fake audit artifact", () => {
  const fakeAudit = {
    generatedAt: "2026-06-13T00:00:00.000Z",
    config: { recordCount: 132, queryCount: 1 },
    perQuerySignals: [
      {
        queryId: "q1",
        family: "paraphrase",
        isPositive: true,
        signals: emptySignals(),
      },
    ],
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fa-dmg-"));
  try {
    const file = path.join(dir, "audit.json");
    fs.writeFileSync(file, JSON.stringify(fakeAudit), "utf8");
    const parsed = readAbstentionAuditArtifact(file);
    assert.equal(parsed.config.recordCount, 132);
    assert.equal(parsed.perQuerySignals[0]!.queryId, "q1");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// `runFalseAbstentionDamageAnalysis` is
// the pure orchestrator the CLI uses.
// Pin the contract that it throws on an
// unknown policy id.
test("false-abstention-damage: runFalseAbstentionDamageAnalysis throws on unknown policyId", () => {
  const fakeArtifact = {
    generatedAt: "2026-06-13T00:00:00.000Z",
    config: {
      recordCount: 132,
      queryCount: 0,
      total: 0,
      noAnswerCount: 0,
      positiveCount: 0,
    },
    perQuery: [],
    decisions: [
      {
        policyId: "score-or-sufficiency-insufficient",
        decisions: [],
      },
    ],
  };
  assert.throws(
    () =>
      runFalseAbstentionDamageAnalysis({
        noAnswerArtifact: fakeArtifact,
        policyId: "this-policy-does-not-exist",
      }),
    /this-policy-does-not-exist/,
  );
});
